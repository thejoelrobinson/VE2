/**
 * VLCBridge.js — Per-file VLC frame server bridge.
 *
 * NOT a singleton. Each media file gets its own VLCBridge instance with
 * its own L1/L2 cache. All instances share one VLCWorker (which manages
 * multiple VLC frame server handles internally via a Map, LRU-evicted at 8).
 *
 * Frame cache architecture:
 *   L1 — LRU ImageBitmaps in GPU memory (90 frames per instance, binary search)
 *   L2 — JPEG-compressed frames in OPFS (persistent, per-file hash namespace)
 *   L3 — VLC decode in worker (seek + decode, ~600ms cold)
 */
import logger from '../../utils/logger.js';
import { opfsCache } from '../core/OPFSCache.js';

const OPFS_NS = 'vlc-frames';
const OPFS_JPEG_QUALITY = 0.85;
const FRAME_CACHE_MAX = 90;
const CAPTURE_TIMEOUT_MS = 8000;
const OPFS_WRITE_INTERVAL = 3;
const OPFS_READ_MAX_CANDIDATES = 5;
const VLC_WORKER_URL = '/VE2/vlcjs/VLCWorker.js';

// ── Shared worker (all VLCBridge instances share one worker) ──────────────

let _sharedWorker = null;
let _sharedWorkerReady = false;
let _sharedWorkerInitPromise = null;
const _messageHandlers = new Map(); // mediaId → VLCBridge._onWorkerMessage
let _requestId = 0;
// Pending requests keyed by requestId (cross-instance for routing responses)
const _allPendingRequests = new Map();

function _ensureWorker() {
  if (_sharedWorker) return _sharedWorkerInitPromise;
  _sharedWorker = new Worker(VLC_WORKER_URL);
  _sharedWorker.onmessage = _dispatchMessage;
  _sharedWorker.onerror = (err) => {
    logger.error('[VLCBridge] Worker crashed:', err.message || err);
    _sharedWorker = null;
    _sharedWorkerReady = false;
    _sharedWorkerInitPromise = null;
    // Resolve all pending requests with null
    for (const [, req] of _allPendingRequests) {
      clearTimeout(req.timer);
      req.resolve(null);
    }
    _allPendingRequests.clear();
  };
  _sharedWorkerInitPromise = new Promise(resolve => {
    const handler = (e) => {
      if (e.data.type === 'init_done') {
        _sharedWorkerReady = true;
        _sharedWorker.removeEventListener('message', handler);
        resolve();
      }
    };
    _sharedWorker.addEventListener('message', handler);
    _sharedWorker.postMessage({ type: 'init' });
  });
  return _sharedWorkerInitPromise;
}

function _dispatchMessage(e) {
  const msg = e.data;

  // Route get_frame_result / get_frame_null by requestId
  if (msg.requestId != null) {
    const req = _allPendingRequests.get(msg.requestId);
    if (req) {
      clearTimeout(req.timer);
      _allPendingRequests.delete(msg.requestId);
      if (msg.type === 'get_frame_result' && msg.bitmap) {
        req.resolve({ bitmap: msg.bitmap, frameMs: msg.frameMs });
      } else {
        req.resolve(null);
      }
      // Also let the per-instance handler process for caching
    }
  }

  // Route to per-mediaId handler for frame/frame_cached/probe_done/eos/media_evicted
  if (msg.mediaId != null) {
    const handler = _messageHandlers.get(msg.mediaId);
    if (handler) handler(msg);
  }
}

// ── Per-instance VLCBridge ────────────────────────────────────────────────

export function createVLCBridge(mediaId) {
  let _mediaId = mediaId;
  let _file = null;
  let _fileHash = '';
  let _estimatedFps = 24;
  let _durationMs = 0;
  let _onFrameCached = null;
  let _onClipEnd = null;
  let _onBroadcastFrame = null;
  let _opfsWriteCounter = 0;
  let _probeResolve = null;
  let _probeReject = null;

  // Reusable canvas for OPFS JPEG encoding
  let _opfsWriteCanvas = null;
  let _opfsWriteCtx = null;

  // L1 LRU cache + sorted index
  const _frameCache = new Map();
  let _sortedKeys = [];

  // ── Sorted cache helpers ───────────────────────────────────────────────

  function _sortedInsert(arr, val) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < val) lo = mid + 1; else hi = mid; }
    arr.splice(lo, 0, val);
  }

  function _sortedRemove(arr, val) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < val) lo = mid + 1; else hi = mid; }
    if (lo < arr.length && arr[lo] === val) arr.splice(lo, 1);
  }

  function _cacheFrame(frameMs, bmp) {
    if (_frameCache.has(frameMs)) {
      try { _frameCache.get(frameMs)?.close?.(); } catch(_) {}
      _frameCache.delete(frameMs);
    } else {
      if (_frameCache.size >= FRAME_CACHE_MAX) {
        const oldest = _frameCache.keys().next().value;
        try { _frameCache.get(oldest)?.close?.(); } catch(_) {}
        _frameCache.delete(oldest);
        _sortedRemove(_sortedKeys, oldest);
      }
      _sortedInsert(_sortedKeys, frameMs);
    }
    _frameCache.set(frameMs, bmp);
    if (_onFrameCached) try { _onFrameCached(frameMs); } catch(_) {}
  }

  function _findInCache(targetMs, toleranceMs) {
    const arr = _sortedKeys, len = arr.length;
    if (len === 0) return null;
    let lo = 0, hi = len;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (arr[mid] < targetMs) lo = mid + 1; else hi = mid; }
    let bestMs = -1, bestDist = Infinity;
    if (lo > 0) { const d = targetMs - arr[lo - 1]; if (d < bestDist) { bestDist = d; bestMs = arr[lo - 1]; } }
    if (lo < len) { const d = arr[lo] - targetMs; if (d < bestDist) { bestDist = d; bestMs = arr[lo]; } }
    if (bestMs < 0 || bestDist > toleranceMs) return null;
    const bmp = _frameCache.get(bestMs);
    _frameCache.delete(bestMs);
    _frameCache.set(bestMs, bmp);
    return bmp;
  }

  function _frameTolerance() {
    return _estimatedFps > 0 ? Math.round(2000 / _estimatedFps) + 250 : 900;
  }

  // ── OPFS helpers ───────────────────────────────────────────────────────

  function _opfsKey(frameMs) {
    return `${_fileHash}_${frameMs}.jpg`;
  }

  function _writeFrameToOPFS(frameMs, bmp) {
    if (!opfsCache.isAvailable() || !_fileHash) return;
    try {
      if (!_opfsWriteCanvas || _opfsWriteCanvas.width !== bmp.width || _opfsWriteCanvas.height !== bmp.height) {
        _opfsWriteCanvas = new OffscreenCanvas(bmp.width, bmp.height);
        _opfsWriteCtx = _opfsWriteCanvas.getContext('2d');
      }
      _opfsWriteCtx.drawImage(bmp, 0, 0);
      _opfsWriteCanvas.convertToBlob({ type: 'image/jpeg', quality: OPFS_JPEG_QUALITY })
        .then(blob => blob.arrayBuffer())
        .then(buf => opfsCache.write(OPFS_NS, _opfsKey(frameMs), new Uint8Array(buf)))
        .catch(() => {});
    } catch(_) {}
  }

  async function _readFrameFromOPFS(targetMs, toleranceMs) {
    if (!opfsCache.isAvailable() || !_fileHash) return null;
    const step = _estimatedFps > 0 ? Math.round(1000 / _estimatedFps) : 42;
    const candidates = [targetMs];
    for (let d = step; d < toleranceMs && candidates.length < OPFS_READ_MAX_CANDIDATES * 2 + 1; d += step) {
      candidates.push(targetMs - d, targetMs + d);
    }
    for (const ms of candidates) {
      if (ms < 0) continue;
      try {
        const buf = await opfsCache.read(OPFS_NS, _opfsKey(ms));
        if (buf) {
          const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' });
          return { bmp, timeMs: ms };
        }
      } catch(_) {}
    }
    return null;
  }

  // ── Per-instance message handler ───────────────────────────────────────

  function _onMessage(msg) {
    switch (msg.type) {
      case 'probe_done':
        _estimatedFps = msg.fps || 24;
        _durationMs = msg.durationMs || 0;
        if (_probeResolve) {
          _probeResolve({ durationMs: msg.durationMs, width: msg.width, height: msg.height, fps: msg.fps });
          _probeResolve = null; _probeReject = null;
        }
        break;

      case 'probe_error':
        if (_probeReject) {
          _probeReject(new Error(msg.error));
          _probeResolve = null; _probeReject = null;
        }
        break;

      case 'frame':
        if (msg.bitmap) {
          _cacheFrame(msg.frameMs, msg.bitmap);
          if (_onBroadcastFrame) try { _onBroadcastFrame(msg.frameMs, msg.bitmap); } catch(_) {}
          _opfsWriteCounter++;
          if (_opfsWriteCounter >= OPFS_WRITE_INTERVAL) {
            _opfsWriteCounter = 0;
            const bmp = _frameCache.get(msg.frameMs);
            if (bmp) _writeFrameToOPFS(msg.frameMs, bmp);
          }
        }
        break;

      case 'frame_cached':
        if (_onFrameCached) try { _onFrameCached(msg.frameMs); } catch(_) {}
        break;

      case 'media_evicted':
        // Worker evicted this media's player (LRU) — L1 cache is stale
        for (const [, bmp] of _frameCache) {
          try { bmp?.close?.(); } catch(_) {}
        }
        _frameCache.clear();
        _sortedKeys = [];
        logger.info(`[VLCBridge:${_mediaId}] Media evicted by worker LRU — L1 cache cleared`);
        break;

      case 'eos':
        logger.info(`[VLCBridge:${_mediaId}] Worker reported EOS`);
        break;

      case 'clip_end_reached':
        logger.info(`[VLCBridge:${_mediaId}] Clip end reached at ${msg.frameMs}ms (clipEnd: ${msg.clipEndMs}ms)`);
        if (_onClipEnd) try { _onClipEnd(msg.frameMs, msg.clipEndMs); } catch(_) {}
        break;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  async function initialize() {
    await _ensureWorker();
  }

  async function loadFile(file) {
    if (!file) throw new Error('[VLCBridge] loadFile requires a File');
    await initialize();

    // Clear L1 cache
    for (const [, bmp] of _frameCache) { try { bmp?.close?.(); } catch(_) {} }
    _frameCache.clear();
    _sortedKeys = [];
    _opfsWriteCounter = 0;

    _file = file;
    _fileHash = file.name.replace(/[^a-z0-9]/gi, '_') + '_' + file.size;

    // Register per-instance message handler
    _messageHandlers.set(_mediaId, _onMessage);

    const result = await new Promise((resolve, reject) => {
      _probeResolve = resolve;
      _probeReject = reject;
      const timeout = setTimeout(() => {
        if (_probeResolve) {
          _probeResolve = null;
          _probeReject = null;
          reject(new Error('VLC probe timeout (15s) — worker may not have received load_file'));
        }
      }, 15000);
      const origResolve = resolve;
      _probeResolve = (val) => { clearTimeout(timeout); origResolve(val); };
      _sharedWorker.postMessage({ type: 'load_file', file, mediaId: _mediaId });
    });

    // OPFS scan for render bar
    if (result.durationMs > 0) {
      const scanStep = Math.max(25, Math.round((1000 / (result.fps || 24)) * OPFS_WRITE_INTERVAL));
      (async () => {
        if (!opfsCache.isAvailable()) return;
        let foundAny = false, gaps = 0;
        for (let ms = 0; ms <= result.durationMs; ms += scanStep) {
          const exists = await opfsCache.has(OPFS_NS, _opfsKey(ms));
          if (exists) { foundAny = true; gaps = 0; if (_onFrameCached) try { _onFrameCached(ms); } catch(_) {} }
          else if (foundAny) { gaps++; if (gaps >= 3) break; }
        }
        if (foundAny) logger.info(`[VLCBridge:${_mediaId}] OPFS: pre-populated render bar`);
      })();
    }

    logger.info(`[VLCBridge:${_mediaId}] Probed ${file.name}: ${result.durationMs}ms, ${result.width}x${result.height}, ${result.fps.toFixed(1)}fps`);
    return result;
  }

  async function getFrameAt(timeSeconds) {
    const targetMs = Math.round(timeSeconds * 1000);
    const tolerance = _frameTolerance();

    // L1: GPU ImageBitmap cache
    const cached = _findInCache(targetMs, tolerance);
    if (cached) return cached;

    // L2: OPFS JPEG cache
    const opfsResult = await _readFrameFromOPFS(targetMs, tolerance);
    if (opfsResult) {
      _cacheFrame(opfsResult.timeMs, opfsResult.bmp);
      return opfsResult.bmp;
    }

    // L3: Worker frame server
    if (!_sharedWorker) return null;
    return new Promise(resolve => {
      const reqId = ++_requestId;
      const timer = setTimeout(() => {
        _allPendingRequests.delete(reqId);
        logger.warn(`[VLCBridge:${_mediaId}] frame timeout at ${timeSeconds.toFixed(3)}s`);
        resolve(null);
      }, CAPTURE_TIMEOUT_MS);

      _allPendingRequests.set(reqId, {
        resolve: (result) => {
          if (result && result.bitmap) {
            _cacheFrame(result.frameMs, result.bitmap);
            resolve(result.bitmap);
          } else {
            resolve(null);
          }
        },
        timer
      });

      _sharedWorker.postMessage({
        type: 'get_frame', requestId: reqId, mediaId: _mediaId,
        timeMs: targetMs, toleranceMs: tolerance
      });
    });
  }

  function setPlaybackActive(playing, timeSeconds) {
    if (!_sharedWorker) return;
    _sharedWorker.postMessage({
      type: 'set_playback', mediaId: _mediaId,
      playing, seekMs: Math.round((timeSeconds || 0) * 1000)
    });
  }

  function syncSeek(timeSeconds) {
    if (!_sharedWorker) return;
    _sharedWorker.postMessage({
      type: 'seek', mediaId: _mediaId,
      seekMs: Math.round(timeSeconds * 1000)
    });
  }

  function startSequentialMode(startSeconds) {
    if (!_sharedWorker) return;
    _sharedWorker.postMessage({
      type: 'start_sequential', mediaId: _mediaId,
      startMs: Math.round(startSeconds * 1000), rate: 1.5
    });
  }

  function endSequentialMode() {
    if (!_sharedWorker) return;
    _sharedWorker.postMessage({ type: 'end_sequential', mediaId: _mediaId });
  }

  async function getSequentialFrame(timeSeconds) {
    if (!_sharedWorker) return null;
    return new Promise(resolve => {
      const reqId = ++_requestId;
      const timer = setTimeout(() => {
        _allPendingRequests.delete(reqId);
        resolve(null);
      }, 3000);
      _allPendingRequests.set(reqId, {
        resolve: (result) => resolve(result?.bitmap || null),
        timer
      });
      _sharedWorker.postMessage({
        type: 'get_seq_frame', requestId: reqId, mediaId: _mediaId,
        timeMs: Math.round(timeSeconds * 1000)
      });
    });
  }

  async function startProactiveFill(startSeconds) {
    await initialize();
    setPlaybackActive(true, startSeconds);
    // Auto-pause handled by worker throttle
  }

  async function getFramesBatch(timesArray) {
    const results = new Map();
    if (!timesArray || timesArray.length === 0) return results;

    const promises = timesArray.map(async (timeSeconds) => {
      const bmp = await getFrameAt(timeSeconds);
      if (bmp) {
        results.set(Math.round(timeSeconds * 1000), bmp);
      }
    });
    await Promise.all(promises);
    return results;
  }

  function release() {
    // Close L1 cache
    for (const [, bmp] of _frameCache) { try { bmp?.close?.(); } catch(_) {} }
    _frameCache.clear();
    _sortedKeys = [];
    // Unregister message handler
    _messageHandlers.delete(_mediaId);
    // Release media in worker
    if (_sharedWorker) {
      _sharedWorker.postMessage({ type: 'release_media', mediaId: _mediaId });
    }
    _file = null;
  }

  return {
    initialize,
    loadFile,
    getFrameAt,
    getFramesBatch,
    setFrameCachedCallback: (fn) => { _onFrameCached = fn; },
    startProactiveFill,
    setPlaybackActive,
    syncSeek,
    startSequentialMode,
    endSequentialMode,
    getSequentialFrame,
    release,
    // NOTE: boundedMode infrastructure — callers ship in a follow-on issue.
    setClipBounds(startMs, endMs) {
      if (!_sharedWorker) return;
      _sharedWorker.postMessage({ type: 'set_clip_bounds', mediaId: _mediaId, startMs: Math.round(startMs), endMs: Math.round(endMs) });
    },
    clearClipBounds() {
      if (!_sharedWorker) return;
      _sharedWorker.postMessage({ type: 'clear_clip_bounds', mediaId: _mediaId });
    },
    setClipEndCallback: (fn) => { _onClipEnd = fn; },
    setBroadcastFrameCallback: (fn) => { _onBroadcastFrame = fn; },
    getEstimatedFps: () => _estimatedFps,
    getMediaId: () => _mediaId,
    isInitialized: () => _sharedWorkerReady
  };
}

// Legacy compat — deprecated, use createVLCBridge(mediaId) instead.
// Kept only for callers that haven't migrated yet.
let _legacyInstance = null;
export function getVLCBridge() {
  if (!_legacyInstance) _legacyInstance = createVLCBridge('_legacy_');
  return _legacyInstance;
}

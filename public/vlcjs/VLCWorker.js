/**
 * VLCWorker.js — Frame server worker for VLC.js WASM.
 *
 * Uses the frame server C API (fs_init_shared/fs_create/fs_open/fs_seek/
 * fs_play/fs_pause/fs_shutdown) with --vout=dummy — no GL, no canvas,
 * no DOM dependency.
 *
 * A single shared libvlc_instance_t is created once during init via
 * fs_init_shared(). All subsequent fs_create() calls produce media_player_t
 * handles that reuse the shared instance — avoiding pthread exhaustion when
 * importing multiple files under WASM's 8-pthread limit.
 *
 * Frame pixel data flows through the existing JS pipeline:
 *   webcodec.cpp boundOutputCb → _vlcOnDecoderFrame → createImageBitmap
 * The C frame server manages VLC lifecycle; JS handles pixel delivery.
 */

// ── DOM polyfill stubs ───────────────────────────────────────────────────────
// VLC.js has Emscripten Browser module references (pointer lock, fullscreen).
// These are never called with --vout=dummy but must exist to prevent
// ReferenceErrors during Emscripten runtime init.
const _stubEl = {
  getContext: () => null, addEventListener: () => {}, removeEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  setAttribute: () => {}, appendChild: () => {}, style: {},
  width: 0, height: 0, requestPointerLock: () => {}, exitPointerLock: () => {}
};
const _vlcScriptUrl = new URL('./experimental.js', self.location.href).href;
if (typeof document === 'undefined') {
  self.document = {
    getElementById: () => null, querySelector: () => null,
    createElement: () => Object.assign({}, _stubEl),
    addEventListener: () => {}, removeEventListener: () => {},
    createEvent: () => ({ initEvent: () => {} }),
    pointerLockElement: null, exitPointerLock: () => {},
    body: { appendChild: () => {} }, documentElement: { style: {} },
    currentScript: { src: _vlcScriptUrl }, head: { appendChild: () => {} }
  };
}
if (typeof window === 'undefined') self.window = self;
self.window.scrollX = 0; self.window.scrollY = 0;
self.window.pageXOffset = 0; self.window.pageYOffset = 0;
self.window.prompt = () => null;
if (typeof alert === 'undefined') self.alert = () => {};
self.update_overlay = () => {};
self.on_overlay_click = () => {};
self.display_overlay = false;
self._vlcIsPlaying = false;
self._vlcStateCache = { position: 0, timeMs: 0, lengthMs: 0, volume: 0, muted: false };

// ── Constants ────────────────────────────────────────────────────────────────
// VLC options passed to _fs_init_shared (shared libvlc instance, created once)
const FS_CREATE_ARGS = ['vlc', '--codec=webcodec', '--aout=emworklet', '--avcodec-threads=1', '--no-audio'];
const CAPTURE_TIMEOUT_MS = 8000;
const SEEK_LEAD_MS = 600;
const FPS_STABILIZE_FRAMES = 8;
const PROBE_TIMEOUT_MS = 12000;
const LRU_SOFT_LIMIT = 8;

// ── Worker state ─────────────────────────────────────────────────────────────
let _module = null;

// Per-media state: one entry per loaded file
const _media = new Map(); // mediaId → { fsHandle, file, slot, fps, durationMs, ... }

// vlc_access_file slot allocator: each loaded file gets a unique slot number
// so multiple media players can coexist without overwriting each other's File.
let _nextFileSlot = 1;

// Pending frame requests across all media
const _pendingFrames = new Map(); // requestId → { mediaId, targetMs, toleranceMs, timer }

// FPS estimation (global — applies to most recent frame delivery)
let _frameIntervals = [];
let _lastFrameTimestampUs = null;
let _globalFps = 24;

// Reusable canvas for frame capture
let _captureCanvas = null;
let _captureCtx = null;

// Track which media was last actively played — used to detect clip switches
// and re-open the file to reset VLC's decode pipeline.
let _lastActiveMediaId = null;

// Frame gate
let _frameGateBusy = false;

// Global frame counter (incremented by _vlcOnDecoderFrame, read by probe)
let _totalFrameCount = 0;

// ── Frame interceptor ────────────────────────────────────────────────────────
self._vlcOnDecoderFrame = function(pictureId, frame) {
  if (!(frame instanceof VideoFrame)) { try { frame?.close?.(); } catch(_) {} return; }

  const frameMs = Math.round(frame.timestamp / 1000);
  _totalFrameCount++;
  _lastFrameDeliveryMs = performance.now();

  // FPS estimation from inter-frame interval
  if (_lastFrameTimestampUs !== null) {
    const interval = frame.timestamp - _lastFrameTimestampUs;
    if (interval > 0 && interval < 5_000_000) {
      _frameIntervals.push(interval);
      if (_frameIntervals.length > 10) _frameIntervals.shift();
      const avg = _frameIntervals.reduce((a, b) => a + b, 0) / _frameIntervals.length;
      _globalFps = Math.max(5, Math.min(120, 1_000_000 / avg));
    }
  }
  _lastFrameTimestampUs = frame.timestamp;

  // Duration throttle: pause VLC before it reaches clip end (or media end).
  // With _fs_guard_eos active at the C level, EOS deadlock is prevented.
  // No JS safety margin needed — the C-level guard handles EOS gracefully.
  // NOTE: frameMs is not per-media attributed — with multiple playing media, the first
  // matching entry in Map iteration order gets paused. This is a pre-existing limitation;
  // in practice only one media plays at a time (timeline playhead drives a single clip).
  for (const [id, m] of _media) {
    if (!m.isPlaying || m.durationMs <= 0) continue;
    const effectiveEnd = m.boundedMode
      ? Math.min(m.clipEndMs, m.durationMs)
      : m.durationMs;
    const margin = 0; // _fs_guard_eos handles EOS at C level; no JS safety margin needed
    if (frameMs >= effectiveEnd - margin) {
      try { _module._fs_pause(m.fsHandle); } catch(_) {}
      m.isPlaying = false;
      if (m.boundedMode && effectiveEnd < m.durationMs) {
        self.postMessage({ type: 'clip_end_reached', mediaId: id, frameMs, clipEndMs: m.clipEndMs });
      }
      break;
    }
  }

  // Frame gate: drop if previous createImageBitmap hasn't resolved
  if (_frameGateBusy) { frame.close(); return; }

  // Capture to ImageBitmap
  const fw = frame.displayWidth, fh = frame.displayHeight;
  if (!_captureCanvas || _captureCanvas.width !== fw || _captureCanvas.height !== fh) {
    _captureCanvas = new OffscreenCanvas(fw, fh);
    _captureCtx = _captureCanvas.getContext('2d');
  }
  try { _captureCtx.drawImage(frame, 0, 0); } finally { frame.close(); }

  _frameGateBusy = true;
  createImageBitmap(_captureCanvas, { colorSpaceConversion: 'none' }).then(bmp => {
    _frameGateBusy = false;

    // Track VLC's current decode position for position-aware seek dedup
    for (const [id, m] of _media) {
      if (m.isPlaying) { m.lastProducedFrameMs = frameMs; break; }
    }

    // Check pending frame requests — resolve the first match
    let consumed = false;
    let consumedMediaId = null;
    for (const [reqId, req] of _pendingFrames) {
      if (Math.abs(frameMs - req.targetMs) <= req.toleranceMs) {
        clearTimeout(req.timer);
        _pendingFrames.delete(reqId);
        consumedMediaId = req.mediaId;
        self.postMessage(
          { type: 'get_frame_result', requestId: reqId, mediaId: req.mediaId, frameMs, bitmap: bmp },
          [bmp]
        );
        consumed = true;
        break;
      }
    }

    if (!consumed) {
      // No matching request — broadcast as cache-fill frame
      // Find which mediaId this frame belongs to (use the most recent load)
      let mediaId = null;
      for (const [id, m] of _media) {
        if (m.isPlaying || m.isSeeking) { mediaId = id; break; }
      }
      if (mediaId) {
        self.postMessage({ type: 'frame', mediaId, frameMs, bitmap: bmp }, [bmp]);
      } else {
        try { bmp.close(); } catch(_) {}
      }
    }

    // Notify render bar
    for (const [id, m] of _media) {
      if (m.isPlaying || m.isSeeking) {
        self.postMessage({ type: 'frame_cached', mediaId: id, frameMs });
        break;
      }
    }
  }).catch(() => { _frameGateBusy = false; });
};

self._vlcAwaitFrame = async (_pid) => new Promise(() => {});

// ── EOS detection + recovery ─────────────────────────────────────────────────
// If VLC stops delivering frames for >5000ms while playing, it hit end-of-stream.
// With _fs_guard_eos active at the C level, EOS is handled by seeking to 0 + pausing.
// This timeout is a last-resort fallback safety net.
let _eosCheckTimer = null;
let _lastFrameDeliveryMs = performance.now();

function _startEosCheck() {
  clearTimeout(_eosCheckTimer);
  _eosCheckTimer = setTimeout(_checkEos, 5000);
}

function _checkEos() {
  _eosCheckTimer = null;
  const since = performance.now() - _lastFrameDeliveryMs;
  let anyPlaying = false;
  for (const [id, m] of _media) {
    if (!m.isPlaying) continue;
    anyPlaying = true;
    if (since > 5000) {
      // This media hit EOS
      m.isPlaying = false;
      m.atEos = true;
      // Resolve pending requests for this media
      for (const [reqId, req] of _pendingFrames) {
        if (req.mediaId === id) {
          clearTimeout(req.timer);
          _pendingFrames.delete(reqId);
          self.postMessage({ type: 'get_frame_null', requestId: reqId, mediaId: id });
        }
      }
    }
  }
  if (anyPlaying) _eosCheckTimer = setTimeout(_checkEos, 5000);
}

// Lightweight EOS recovery: with _fs_guard_eos active, the C-level handler
// already sought to 0 and paused when EOS was hit. Just clear JS-side flags
// so get_frame can retry with a fresh seek.
function _recoverFromEos(m) {
  if (!m.atEos || !m.fsHandle || !_module) return;
  m.atEos = false;
  m.isPlaying = false;
  m.lastProducedFrameMs = -1;
  if (m._seekThrottleTimer) {
    clearTimeout(m._seekThrottleTimer);
    m._seekThrottleTimer = null;
  }
  m._pendingSeekTarget = undefined;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _doSeek(m, seekTarget) {
  m.lastSeekMs = seekTarget;
  m.lastSeekTime = Date.now();
  m.lastProducedFrameMs = -1;
  _module._fs_seek(m.fsHandle, BigInt(seekTarget), 1);
  if (m.isPlaying) _module._fs_play(m.fsHandle);
}

function _frameTolerance() {
  return _globalFps > 0 ? Math.round(2000 / _globalFps) + 250 : 900;
}

function _getMedia(mediaId) {
  return _media.get(mediaId) || null;
}

function _evictIfNeeded() {
  if (_media.size < LRU_SOFT_LIMIT) return;

  // Find least-recently-used INACTIVE media
  let oldest = null;
  let oldestTime = Infinity;
  for (const [id, m] of _media) {
    if (m.isPlaying) continue; // never evict active media
    if (m.lastAccessTime < oldestTime) {
      oldestTime = m.lastAccessTime;
      oldest = id;
    }
  }

  if (oldest) {
    const m = _media.get(oldest);
    if (m._seekThrottleTimer) { clearTimeout(m._seekThrottleTimer); m._seekThrottleTimer = null; }
    try { _module._fs_destroy(m.fsHandle); } catch(_) {}
    // Flush pending requests for evicted media
    for (const [reqId, req] of _pendingFrames) {
      if (req.mediaId === oldest) {
        clearTimeout(req.timer);
        _pendingFrames.delete(reqId);
        self.postMessage({ type: 'get_frame_null', requestId: reqId, mediaId: oldest });
      }
    }
    _media.delete(oldest);
    self.postMessage({ type: 'media_evicted', mediaId: oldest });
  }
}

/**
 * Re-open the media file to reset VLC's decode pipeline after a clip switch.
 * VLC's webcodec decoder becomes stale when a different media player was active.
 * _fs_open does stop + re-open internally, resetting demux + decoder state.
 */
function _reactivateMedia(m) {
  const pathPtr = _module.allocateUTF8(`emjsfile://${m.slot}`);
  _module._fs_open(m.fsHandle, pathPtr);
  _module._free(pathPtr);
  _module._fs_set_volume(m.fsHandle, 0);
}

/**
 * Ensure only one media instance is actively decoding at a time.
 * VLC's webcodec module delivers frames through a global callback — if multiple
 * _fs_create instances decode simultaneously, frames interleave and requests
 * for the target media time out.
 */
function _exclusivePlay(activeMediaId) {
  for (const [id, m] of _media) {
    if (id === activeMediaId) continue;
    if (m.isPlaying) {
      try { _module._fs_pause(m.fsHandle); } catch(_) {}
      m.isPlaying = false;
    }
  }
}

// ── Helpers: allocate argv for _fs_create ────────────────────────────────────

function _allocArgv(args) {
  const argvPtr = _module._malloc(args.length * 4);
  const ptrs = args.map(a => _module.allocateUTF8(a));
  new Uint32Array(_module.wasmMemory.buffer, argvPtr, args.length)
    .forEach((_, i, arr) => { arr[i] = ptrs[i]; });
  return { argvPtr, ptrs };
}

function _freeArgv({ argvPtr, ptrs }) {
  ptrs.forEach(p => _module._free(p));
  _module._free(argvPtr);
}

// ── Message handler ──────────────────────────────────────────────────────────

// Use addEventListener instead of self.onmessage to coexist with Emscripten's
// pthread message handler (which overwrites self.onmessage during module init).
// NOT async — each case that needs await wraps its own async IIFE to prevent
// unhandled promise rejections and ensure proper error propagation.
self.addEventListener('message', function(e) {
  const msg = e.data;

  // Debug: log every message received by the worker
  if (msg.type) self.postMessage({ type: 'debug_echo', received: msg.type, mediaId: msg.mediaId || null });

  // Skip Emscripten internal messages (pthread routing, etc.)
  if (msg.cmd || msg.targetThread != null) return;
  if (!msg.type) return;

  switch (msg.type) {

    case 'init': {
      (async () => { try {
        importScripts('./experimental.js');
        const factory = self.initModule;
        if (typeof factory !== 'function') throw new Error('initModule not found');

        const hiddenCanvas = new OffscreenCanvas(1920, 1080);
        _module = await factory({
          mainScriptUrlOrBlob: _vlcScriptUrl,
          preRun: [() => {}],
          vlc_access_file: {},
          vlcOnDecoderFrame: self._vlcOnDecoderFrame,
          canvas: hiddenCanvas,
          onRuntimeInitialized: () => {},
          print: () => {}, printErr: () => {},
          setStatus: () => {}, totalDependencies: 0,
          monitorRunDependencies: () => {},
          vlc_opfs_name: {}
        });

        // Register custom handlers for pthread callHandler routing
        _module.vlcOnDecoderFrame = self._vlcOnDecoderFrame;
        _module.vlcAwaitFrame = self._vlcAwaitFrame;

        // Initialize the shared libvlc instance once — all subsequent fs_create()
        // calls reuse it, avoiding pthread exhaustion with multiple media files.
        const vlcArgs = FS_CREATE_ARGS;
        const sharedArgv = _allocArgv(vlcArgs);
        const initResult = _module._fs_init_shared(vlcArgs.length, sharedArgv.argvPtr);
        _freeArgv(sharedArgv);
        if (initResult !== 0) throw new Error('fs_init_shared failed');

        self.postMessage({ type: 'init_done' });
      } catch (err) {
        self.postMessage({ type: 'error', error: err.message });
      } })().catch(err => {
        self.postMessage({ type: 'error', error: 'Uncaught in init: ' + (err.message || err) });
      });
      break;
    }

    case 'load_file': {
      const { file, mediaId } = msg;
      _evictIfNeeded();
      (async () => { try {
        if (!_module) throw new Error('VLC module not initialized — init must complete first');

        // Create frame server handle (reuses the shared libvlc instance from init)
        const fsHandle = _module._fs_create();
        if (!fsHandle) throw new Error('fs_create failed');

        // Guard EOS at C level — prevents ASYNCIFY deadlock at end-of-stream.
        // The C handler seeks to 0 + pauses instead of stopping (which would deadlock).
        _module._fs_guard_eos(fsHandle);

        // Assign a unique vlc_access_file slot for this media
        // (each media player reads from its own slot — no cross-contamination)
        const slot = _nextFileSlot++;
        _module.vlc_access_file[slot] = file;

        // Open media file via frame server API
        const pathPtr = _module.allocateUTF8(`emjsfile://${slot}`);
        const openResult = _module._fs_open(fsHandle, pathPtr);
        _module._free(pathPtr);
        if (openResult !== 0) { _module._fs_destroy(fsHandle); throw new Error('fs_open failed'); }

        // Mute and play to trigger demux + decode probe
        _module._fs_set_volume(fsHandle, 0);
        const startCount = _totalFrameCount;
        _exclusivePlay(mediaId);  // Pause other media before probe playback
        _module._fs_play(fsHandle);

        // Wait for first frame (use global frame counter — no handler wrapping)
        _frameIntervals = [];
        _lastFrameTimestampUs = null;

        const probeStart = Date.now();
        await new Promise((resolve, reject) => {
          const check = () => {
            if (Date.now() - probeStart > PROBE_TIMEOUT_MS) {
              reject(new Error('probe timeout')); return;
            }
            (_totalFrameCount > startCount) ? resolve() : setTimeout(check, 50);
          };
          check();
        });

        // Wait for FPS stabilization
        const probeFrameCount = () => _totalFrameCount - startCount;
        if (probeFrameCount() < FPS_STABILIZE_FRAMES) {
          const stabStart = Date.now();
          await new Promise(resolve => {
            const check = () => {
              (probeFrameCount() >= FPS_STABILIZE_FRAMES || Date.now() - stabStart > 2500)
                ? resolve() : setTimeout(check, 50);
            };
            check();
          });
        }

        // Pause after probe
        _module._fs_pause(fsHandle);

        // Get dimensions via pointer output params
        let width = 0, height = 0;
        try {
          const wPtr = _module._malloc(4);
          const hPtr = _module._malloc(4);
          const sizeResult = _module._fs_get_size(fsHandle, wPtr, hPtr);
          if (sizeResult === 0) {
            width = new Uint32Array(_module.wasmMemory.buffer, wPtr, 1)[0];
            height = new Uint32Array(_module.wasmMemory.buffer, hPtr, 1)[0];
          }
          _module._free(wPtr);
          _module._free(hPtr);
        } catch(_) {}

        // Get duration
        let durationMs = 0;
        const lenStart = Date.now();
        while (durationMs <= 0 && Date.now() - lenStart < 3500) {
          await new Promise(r => setTimeout(r, 200));
          try { durationMs = Number(_module._fs_get_duration(fsHandle)); } catch(_) {}
        }

        // Store per-media state
        _media.set(mediaId, {
          fsHandle, file, slot, durationMs, width, height,
          fps: _globalFps,
          isPlaying: false,
          isSeeking: false,
          atEos: false,
          lastAccessTime: Date.now(),
          lastSeekMs: undefined,
          lastSeekTime: 0,
          lastProducedFrameMs: -1,
          _seekThrottleTimer: null,
          _pendingSeekTarget: undefined,
          clipStartMs: 0,
          clipEndMs: 0,
          boundedMode: false
        });
        _lastActiveMediaId = mediaId;

        self.postMessage({
          type: 'probe_done', mediaId, durationMs, width, height, fps: _globalFps
        });
      } catch (err) {
        self.postMessage({ type: 'probe_error', mediaId, error: err.message });
      } })().catch(err => {
        self.postMessage({ type: 'probe_error', mediaId, error: 'Uncaught in load_file: ' + (err.message || err) });
      });
      break;
    }

    case 'get_frame': {
      const { requestId, mediaId, timeMs, toleranceMs } = msg;
      const m = _getMedia(mediaId);
      if (!m) {
        self.postMessage({ type: 'get_frame_null', requestId, mediaId });
        break;
      }
      m.lastAccessTime = Date.now();

      // Clamp to clip bounds (if active) or media duration.
      let clampedMs = timeMs;
      if (m.boundedMode) {
        clampedMs = Math.max(m.clipStartMs, Math.min(timeMs, m.clipEndMs));
      } else if (m.durationMs > 0 && timeMs >= m.durationMs) {
        clampedMs = Math.max(0, m.durationMs - 50);
      }

      // Recover from EOS if needed
      if (m.atEos) _recoverFromEos(m);

      // Queue request with timeout
      const timer = setTimeout(() => {
        _pendingFrames.delete(requestId);
        self.postMessage({ type: 'get_frame_null', requestId, mediaId });
      }, CAPTURE_TIMEOUT_MS);

      _pendingFrames.set(requestId, {
        mediaId, targetMs: clampedMs, toleranceMs: toleranceMs || _frameTolerance(), timer
      });

      // Only one media may decode at a time (global frame callback)
      _exclusivePlay(mediaId);

      // Re-open media if switching from a different clip — resets the stale decoder
      if (_lastActiveMediaId !== null && _lastActiveMediaId !== mediaId) {
        _reactivateMedia(m);
      }
      _lastActiveMediaId = mediaId;

      // Seek and play to get the frame
      const seekMs = Math.max(0, clampedMs - SEEK_LEAD_MS);

      // Position-aware seek dedup: compare against VLC's ACTUAL position
      // (from _vlcOnDecoderFrame), not the initial seek position.
      // This prevents the flood while allowing seeks when VLC has moved past the target.
      if (m.isPlaying && m.lastProducedFrameMs >= 0) {
        const vlcPos = m.lastProducedFrameMs;
        // Target is ahead of VLC but within 500ms — VLC will reach it via continuous playback
        if (clampedMs >= vlcPos && clampedMs <= vlcPos + 500) {
          break;
        }
        // Target is just behind VLC (within 100ms) — likely more nearby frames coming
        if (clampedMs < vlcPos && vlcPos - clampedMs < 100) {
          break;
        }
        // Otherwise: target is far behind (need backward seek) or far ahead (need forward seek)
      }

      // Cold-start seek protection: after a seek starts VLC, suppress re-seeks until
      // at least one frame is produced. Prevents seek-flood that starves VLC's decoder.
      // Once lastProducedFrameMs >= 0, position-aware dedup (above) handles all decisions.
      // Safety valve: allow re-seek after 200ms if VLC hasn't produced any frame yet.
      if (m.isPlaying && m.lastProducedFrameMs < 0 && m.lastSeekTime && Date.now() - m.lastSeekTime < 200) {
        break;
      }

      // New seek needed — either first request, or target moved significantly
      m.lastSeekMs = seekMs;
      m.lastSeekTime = Date.now();
      m.isSeeking = true;
      _module._fs_seek(m.fsHandle, BigInt(seekMs), 1);
      if (!m.isPlaying) {
        _module._fs_play(m.fsHandle);
        m.isPlaying = true;
        _startEosCheck();
      }
      break;
    }

    case 'cancel_frame': {
      const { requestId } = msg;
      const req = _pendingFrames.get(requestId);
      if (req) {
        clearTimeout(req.timer);
        _pendingFrames.delete(requestId);
      }
      break;
    }

    case 'set_playback': {
      const { mediaId, playing, seekMs: rawSeekMs } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      m.lastAccessTime = Date.now();
      // Clamp to clip bounds (if active) or media duration.
      let seekMs = rawSeekMs;
      if (m.boundedMode) {
        seekMs = Math.max(m.clipStartMs, Math.min(rawSeekMs, m.clipEndMs));
      } else if (m.durationMs > 0 && rawSeekMs >= m.durationMs) {
        seekMs = Math.max(0, m.durationMs - 50);
      }

      if (playing) {
        _exclusivePlay(mediaId);
        if (_lastActiveMediaId !== null && _lastActiveMediaId !== mediaId) {
          _reactivateMedia(m);
        }
        _lastActiveMediaId = mediaId;
        if (m.atEos) _recoverFromEos(m);
        const playSeekMs = Math.max(0, seekMs - SEEK_LEAD_MS);
        _module._fs_seek(m.fsHandle, BigInt(playSeekMs), 1);
        m.lastSeekMs = playSeekMs;
        m.lastSeekTime = Date.now();
        m.lastProducedFrameMs = -1;  // Reset — VLC will produce frames from the new position
        _module._fs_set_rate(m.fsHandle, 1.0);
        if (!m.isPlaying) {
          _module._fs_play(m.fsHandle);
          m.isPlaying = true;
          _startEosCheck();
        }
      } else {
        _module._fs_pause(m.fsHandle);
        m.isPlaying = false;
      }
      break;
    }

    case 'seek': {
      const { mediaId, seekMs: rawSeekMs } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      m.lastAccessTime = Date.now();
      // Clamp to clip bounds (if active) or media duration.
      let seekMs = rawSeekMs;
      if (m.boundedMode) {
        seekMs = Math.max(m.clipStartMs, Math.min(rawSeekMs, m.clipEndMs));
      } else if (m.durationMs > 0 && rawSeekMs >= m.durationMs) {
        seekMs = Math.max(0, m.durationMs - 50);
      }

      if (m.atEos) _recoverFromEos(m);

      // Flush pending requests for this media (stale after seek)
      for (const [reqId, req] of _pendingFrames) {
        if (req.mediaId === mediaId) {
          clearTimeout(req.timer);
          _pendingFrames.delete(reqId);
          self.postMessage({ type: 'get_frame_null', requestId: reqId, mediaId });
        }
      }

      // Trailing-edge throttle: during rapid scrubbing, defer to the latest position.
      // This prevents VLC from restarting decode 60 times per second.
      const seekTarget = Math.max(0, seekMs - SEEK_LEAD_MS);
      m._pendingSeekTarget = seekTarget;

      if (!m._seekThrottleTimer) {
        // First seek or throttle expired — seek immediately
        _doSeek(m, seekTarget);
        m._seekThrottleTimer = setTimeout(() => {
          m._seekThrottleTimer = null;
          // If a newer seek arrived during the throttle window, execute it now
          if (m._pendingSeekTarget !== undefined && m._pendingSeekTarget !== seekTarget) {
            _doSeek(m, m._pendingSeekTarget);
          }
          m._pendingSeekTarget = undefined;
        }, 150);
      }
      // If throttle is active, _pendingSeekTarget stores the latest position
      // and will be applied when the timer fires
      break;
    }

    // NOTE: boundedMode infrastructure — callers ship in a follow-on issue.
    case 'set_clip_bounds': {
      const { mediaId, startMs, endMs } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      const clampedStart = Math.max(0, startMs);
      const clampedEnd = (m.durationMs > 0) ? Math.min(endMs, m.durationMs) : endMs;
      // Reject clips shorter than 50ms — too short for meaningful playback
      if (clampedEnd - clampedStart < 50) break;
      m.clipStartMs = clampedStart;
      m.clipEndMs = clampedEnd;
      m.boundedMode = true;
      break;
    }

    // NOTE: boundedMode infrastructure — callers ship in a follow-on issue.
    case 'clear_clip_bounds': {
      const { mediaId } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      m.clipStartMs = 0;
      m.clipEndMs = 0;
      m.boundedMode = false;
      break;
    }

    case 'advance_playhead': {
      // Throttle: pause media that are too far ahead
      const { mediaId, timeMs } = msg;
      const m = _getMedia(mediaId);
      if (!m || !m.isPlaying) break;
      // If no pending requests for this media, pause it
      let hasPending = false;
      for (const [, req] of _pendingFrames) {
        if (req.mediaId === mediaId) { hasPending = true; break; }
      }
      if (!hasPending) {
        _module._fs_pause(m.fsHandle);
        m.isPlaying = false;
      }
      break;
    }

    case 'start_sequential': {
      const { mediaId, startMs, rate } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      _exclusivePlay(mediaId);
      if (_lastActiveMediaId !== null && _lastActiveMediaId !== mediaId) {
        _reactivateMedia(m);
      }
      _lastActiveMediaId = mediaId;
      _module._fs_seek(m.fsHandle, BigInt(startMs), 0);
      _module._fs_set_rate(m.fsHandle, rate || 1.5);
      _module._fs_play(m.fsHandle);
      m.isPlaying = true;
      break;
    }

    case 'get_seq_frame': {
      const { requestId, mediaId, timeMs } = msg;
      const m = _getMedia(mediaId);
      if (!m) {
        self.postMessage({ type: 'get_frame_null', requestId, mediaId });
        break;
      }
      const dur = _globalFps > 0 ? Math.ceil(1000 / _globalFps) + 50 : 100;
      const timer = setTimeout(() => {
        _pendingFrames.delete(requestId);
        self.postMessage({ type: 'get_frame_null', requestId, mediaId });
      }, 3000);
      _pendingFrames.set(requestId, { mediaId, targetMs: timeMs, toleranceMs: dur, timer });
      break;
    }

    case 'end_sequential': {
      const { mediaId } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      _module._fs_pause(m.fsHandle);
      _module._fs_set_rate(m.fsHandle, 1.0);
      m.isPlaying = false;
      // Flush pending sequential requests
      for (const [reqId, req] of _pendingFrames) {
        if (req.mediaId === mediaId) {
          clearTimeout(req.timer);
          _pendingFrames.delete(reqId);
          self.postMessage({ type: 'get_frame_null', requestId: reqId, mediaId });
        }
      }
      break;
    }

    case 'release_media': {
      const { mediaId } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      // Cancel any pending seek throttle to prevent _doSeek on a freed handle
      if (m._seekThrottleTimer) { clearTimeout(m._seekThrottleTimer); m._seekThrottleTimer = null; }
      try { _module._fs_destroy(m.fsHandle); } catch(_) {}
      _media.delete(mediaId);
      if (_lastActiveMediaId === mediaId) _lastActiveMediaId = null;
      // Flush pending requests for this media
      for (const [reqId, req] of _pendingFrames) {
        if (req.mediaId === mediaId) {
          clearTimeout(req.timer);
          _pendingFrames.delete(reqId);
        }
      }
      break;
    }

    case 'release': {
      // Destroy all media
      for (const [id, m] of _media) {
        if (m._seekThrottleTimer) { clearTimeout(m._seekThrottleTimer); m._seekThrottleTimer = null; }
        try { _module._fs_destroy(m.fsHandle); } catch(_) {}
      }
      _media.clear();
      _lastActiveMediaId = null;
      for (const [, req] of _pendingFrames) clearTimeout(req.timer);
      _pendingFrames.clear();
      // Release shared VLC instance
      try { _module._fs_shutdown(); } catch(_) {}
      break;
    }
  }
});

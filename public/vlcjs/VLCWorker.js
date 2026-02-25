/**
 * VLCWorker.js — Frame server worker for VLC.js WASM.
 *
 * Uses the frame server C API (fs_create/fs_open/fs_seek/fs_play/fs_pause)
 * with --vout=dummy — no GL, no canvas, no DOM dependency.
 *
 * Supports multiple media files simultaneously via a Map of handles.
 * Each handle has its own VLC instance + media player + decode pipeline.
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
const VLC_INIT_OPTIONS = '--codec=webcodec --aout=emworklet --avcodec-threads=1 --no-audio';
const CAPTURE_TIMEOUT_MS = 8000;
const SEEK_LEAD_MS = 600;
const FPS_STABILIZE_FRAMES = 8;
const PROBE_TIMEOUT_MS = 12000;
const LRU_SOFT_LIMIT = 8;

// ── Worker state ─────────────────────────────────────────────────────────────
let _module = null;

// Per-media state: one entry per loaded file
const _media = new Map(); // mediaId → { mp, file, slot, fps, durationMs, ... }

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
  // Clip-bounded mode uses 200ms margin (overshoot just wastes decode, no fatal EOS risk).
  // Default mode uses 500ms margin (prevents VLC Stopping event).
  // NOTE: frameMs is not per-media attributed — with multiple playing media, the first
  // matching entry in Map iteration order gets paused. This is a pre-existing limitation;
  // in practice only one media plays at a time (timeline playhead drives a single clip).
  for (const [id, m] of _media) {
    if (!m.isPlaying || m.durationMs <= 0) continue;
    const effectiveEnd = m.boundedMode
      ? Math.min(m.clipEndMs, m.durationMs)
      : m.durationMs;
    const margin = m.boundedMode ? 200 : 500;
    if (frameMs >= effectiveEnd - margin) {
      try { _module._wasm_media_player_set_pause(m.mp, 1); } catch(_) {}
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
// If VLC stops delivering frames for >2000ms while playing, it hit end-of-stream.
// The duration throttle (500ms before media end) is the primary EOS defense.
// This timeout is a secondary safety net (relaxed from 400ms to 2000ms).
let _eosCheckTimer = null;
let _lastFrameDeliveryMs = performance.now();

function _startEosCheck() {
  clearTimeout(_eosCheckTimer);
  _eosCheckTimer = setTimeout(_checkEos, 2000);
}

function _checkEos() {
  _eosCheckTimer = null;
  const since = performance.now() - _lastFrameDeliveryMs;
  let anyPlaying = false;
  for (const [id, m] of _media) {
    if (!m.isPlaying) continue;
    anyPlaying = true;
    if (since > 2000) {
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
  if (anyPlaying) _eosCheckTimer = setTimeout(_checkEos, 2000);
}

// Heavy EOS recovery: stop and re-open media on the same player to reset VLC's
// internal state. The lightweight recovery (just clearing atEos) assumed _fs_guard_eos
// would keep VLC alive, but that C API is NOT active (wrong pointer type).
// When VLC genuinely hits an internal error or EOS, the player becomes unusable
// and needs stop+reopen.
function _recoverFromEos(m) {
  if (!m.atEos || !m.mp || !m.file || !_module) return;
  try {
    // Stop and re-open media on the same player to reset VLC's internal state
    _module._wasm_media_player_stop_async(m.mp);
    const pathPtr = _module.allocateUTF8(`emjsfile://${m.slot}`);
    const media = _module._wasm_media_new_location(pathPtr);
    _module._free(pathPtr);
    if (media) {
      _module._wasm_media_player_set_media(m.mp, media);
      _module._wasm_media_release(media);
      _module._wasm_audio_set_volume(m.mp, 0);
    }
    m.atEos = false;
    m.isPlaying = false;
    m.lastProducedFrameMs = -1;
    // Clear seek throttle so the next get_frame can seek freely
    if (m._seekThrottleTimer) {
      clearTimeout(m._seekThrottleTimer);
      m._seekThrottleTimer = null;
    }
    m._pendingSeekTarget = undefined;
  } catch(_) {
    // If recovery fails, at least clear the flag so get_frame can retry
    m.atEos = false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _doSeek(m, seekTarget) {
  m.lastSeekMs = seekTarget;
  m.lastSeekTime = Date.now();
  m.lastProducedFrameMs = -1;
  _module._wasm_media_player_set_time(m.mp, BigInt(seekTarget), 1);
  if (m.isPlaying) _module._wasm_media_player_play(m.mp);
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
    try { _module._wasm_media_player_set_pause(m.mp, 1); } catch(_) {}
    try { _module._wasm_media_player_release(m.mp); } catch(_) {}
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

        // Initialize VLC with --vout=dummy (no GL/canvas/DOM needed)
        const opts = VLC_INIT_OPTIONS.split(' ').filter(Boolean);
        const args = ['vlc', ...opts];
        const argvPtr = _module._malloc(args.length * 4);
        const ptrs = args.map(a => _module.allocateUTF8(a));
        new Uint32Array(_module.wasmMemory.buffer, argvPtr, args.length)
          .forEach((_, i, arr) => { arr[i] = ptrs[i]; });
        _module._wasm_libvlc_init(args.length, argvPtr);
        ptrs.forEach(p => _module._free(p));
        _module._free(argvPtr);

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
        // Assign a unique vlc_access_file slot for this media
        // (each media player reads from its own slot — no cross-contamination)
        const slot = _nextFileSlot++;
        _module.vlc_access_file[slot] = file;

        // Create media player using the global VLC instance (has plugins loaded)
        const mp = _module._wasm_media_player_new();
        if (!mp) throw new Error('wasm_media_player_new failed');
        _module._attach_update_events(mp);

        // Create media pointing to this file's unique slot
        const pathPtr = _module.allocateUTF8(`emjsfile://${slot}`);
        const media = _module._wasm_media_new_location(pathPtr);
        _module._free(pathPtr);
        if (!media) { _module._wasm_media_player_release(mp); throw new Error('media_new failed'); }

        _module._wasm_media_player_set_media(mp, media);
        _module._wasm_media_release(media);
        // NOTE: _set_global_media_player is intentionally NOT called here.
        // It sets a single global pointer used by main.c's iter() loop which
        // we don't use. With multi-file support, each media has its own mp.

        // NOTE: _fs_guard_eos is NOT called here because VLCWorker uses the
        // _wasm_* legacy API (libvlc_media_player_t*), not the frame server API
        // (frame_server_t*). Calling _fs_guard_eos(mp) would pass the wrong
        // pointer type. The _fs_* migration is planned for a future issue.
        // EOS prevention is handled by JS-level duration throttle (500ms) and
        // timeout detection (2000ms).

        // Mute and play to trigger demux + decode probe
        _module._wasm_audio_set_volume(mp, 0);
        const startCount = _totalFrameCount;
        _module._wasm_media_player_play(mp);

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
        _module._wasm_media_player_set_pause(mp, 1);

        // Get dimensions
        let width = 0, height = 0;
        try {
          width = _module._wasm_video_get_size_x(mp);
          height = _module._wasm_video_get_size_y(mp);
          if (width === -1 || height === -1) { width = 0; height = 0; }
        } catch(_) {}

        // Get duration
        let durationMs = 0;
        const lenStart = Date.now();
        while (durationMs <= 0 && Date.now() - lenStart < 3500) {
          await new Promise(r => setTimeout(r, 200));
          try { durationMs = Number(_module._wasm_media_player_get_length(mp)); } catch(_) {}
        }

        // Store per-media state
        _media.set(mediaId, {
          mp, file, slot, durationMs, width, height,
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
        clampedMs = Math.max(m.clipStartMs, Math.min(timeMs, m.clipEndMs - 200));
      } else if (m.durationMs > 0 && timeMs >= m.durationMs) {
        clampedMs = Math.max(0, m.durationMs - 500);
      }

      // Recover from EOS if needed
      if (m.atEos) _recoverFromEos(m);

      // Force recovery if VLC was paused near the media end.
      // The duration throttle pauses VLC at durationMs-500, but VLC's internal
      // decode pipeline can overshoot and hit the Stopping event, making the
      // player unusable. The EOS check skips paused media (isPlaying=false),
      // so atEos is never set. Detect this by checking lastProducedFrameMs.
      if (!m.isPlaying && !m.atEos && m.durationMs > 0) {
        const effectiveEnd = m.boundedMode ? Math.min(m.clipEndMs, m.durationMs) : m.durationMs;
        if (m.lastProducedFrameMs > effectiveEnd - 1000) {
          m.atEos = true;
          _recoverFromEos(m);
        }
      }

      // Queue request with timeout
      const timer = setTimeout(() => {
        _pendingFrames.delete(requestId);
        self.postMessage({ type: 'get_frame_null', requestId, mediaId });
      }, CAPTURE_TIMEOUT_MS);

      _pendingFrames.set(requestId, {
        mediaId, targetMs: clampedMs, toleranceMs: toleranceMs || _frameTolerance(), timer
      });

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
      // Rapid-fire dedup: suppress seeks within 100ms of each other (prevents flood)
      if (m.isPlaying && m.lastSeekTime && Date.now() - m.lastSeekTime < 100) {
        break;
      }

      // New seek needed — either first request, or target moved significantly
      m.lastSeekMs = seekMs;
      m.lastSeekTime = Date.now();
      m.isSeeking = true;
      _module._wasm_media_player_set_time(m.mp, BigInt(seekMs), 1);
      if (!m.isPlaying) {
        _module._wasm_media_player_play(m.mp);
        m.isPlaying = true;
        _startEosCheck();
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
        seekMs = Math.max(m.clipStartMs, Math.min(rawSeekMs, m.clipEndMs - 200));
      } else if (m.durationMs > 0 && rawSeekMs >= m.durationMs) {
        seekMs = Math.max(0, m.durationMs - 500);
      }

      if (playing) {
        if (m.atEos) _recoverFromEos(m);
        const playSeekMs = Math.max(0, seekMs - SEEK_LEAD_MS);
        _module._wasm_media_player_set_time(m.mp, BigInt(playSeekMs), 1);
        m.lastSeekMs = playSeekMs;
        m.lastSeekTime = Date.now();
        m.lastProducedFrameMs = -1;  // Reset — VLC will produce frames from the new position
        _module._wasm_media_player_set_rate(m.mp, 1.0);
        if (!m.isPlaying) {
          _module._wasm_media_player_play(m.mp);
          m.isPlaying = true;
          _startEosCheck();
        }
      } else {
        _module._wasm_media_player_set_pause(m.mp, 1);
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
        seekMs = Math.max(m.clipStartMs, Math.min(rawSeekMs, m.clipEndMs - 200));
      } else if (m.durationMs > 0 && rawSeekMs >= m.durationMs) {
        seekMs = Math.max(0, m.durationMs - 500);
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
      // Reject clips shorter than the bounded margin (200ms) — they'd cause immediate throttle
      if (clampedEnd - clampedStart < 200) break;
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
        _module._wasm_media_player_set_pause(m.mp, 1);
        m.isPlaying = false;
      }
      break;
    }

    case 'start_sequential': {
      const { mediaId, startMs, rate } = msg;
      const m = _getMedia(mediaId);
      if (!m) break;
      _module.vlc_access_file[1] = m.file;
      _module._wasm_media_player_set_time(m.mp, BigInt(startMs), 0);
      _module._wasm_media_player_set_rate(m.mp, rate || 1.5);
      _module._wasm_media_player_play(m.mp);
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
      _module._wasm_media_player_set_pause(m.mp, 1);
      _module._wasm_media_player_set_rate(m.mp, 1.0);
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
      try { _module._wasm_media_player_set_pause(m.mp, 1); } catch(_) {}
      try { _module._wasm_media_player_release(m.mp); } catch(_) {}
      _media.delete(mediaId);
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
        try { _module._wasm_media_player_set_pause(m.mp, 1); } catch(_) {}
        try { _module._wasm_media_player_release(m.mp); } catch(_) {}
      }
      _media.clear();
      for (const [, req] of _pendingFrames) clearTimeout(req.timer);
      _pendingFrames.clear();
      break;
    }
  }
});

// Frame-by-frame decode: all media routes through VLC.js WASM backend.
import { createVLCDecoder } from './VLCDecoder.js';
// renderAheadManager is NOT imported at the top to avoid a circular dependency:
// MediaDecoder → RenderAheadManager → MediaDecoder.
// Instead we resolve it lazily on first use via _getRenderAheadManager().
let _renderAheadManagerRef = null;
function _getRenderAheadManager() {
  if (!_renderAheadManagerRef) {
    // Dynamic require-style: module is already loaded by the time any frame
    // is decoded, so this import() resolves synchronously from the module cache.
    import('./RenderAheadManager.js').then(m => { _renderAheadManagerRef = m.renderAheadManager; });
  }
  return _renderAheadManagerRef;
}
import logger from '../../utils/logger.js';

export const mediaDecoder = {
  _mediaFiles: new Map(),          // mediaId -> File (streaming handle)
  _sequentialMode: false,         // True during export for GOP-batch decode
  _vlcDecoders: new Map(),           // mediaId -> VLCDecoder
  _vlcInitPromises: new Map(),        // dedup concurrent inits
  _vlcFailCount: new Map(),           // mediaId -> { count, lastAttempt }
  _vlcSeqStarted: false,              // sequential mode lazy-start flag

  // Register a File handle for VLC decoding
  registerMediaFile(mediaId, file) {
    this._mediaFiles.set(mediaId, file);
  },

  // Public accessor for registered media files
  getMediaFile(mediaId) {
    return this._mediaFiles.get(mediaId) || null;
  },

  // Release the File reference for a media item.
  releaseMediaFile(mediaId) {
    this._mediaFiles.delete(mediaId);
  },

  getStreamSession(mediaId) {
    const dec = this._vlcDecoders.get(mediaId);
    return dec?.getSession?.() || null;
  },

  _shouldTryVLC(mediaId) {
    if (!this._mediaFiles.has(mediaId)) return false;
    const fail = this._vlcFailCount.get(mediaId);
    if (!fail) return true;
    if (fail.count >= 3) return false;
    if (Date.now() - fail.lastAttempt < 2000) return false;
    return true;
  },

  _recordVLCFailure(mediaId) {
    const fail = this._vlcFailCount.get(mediaId) || { count: 0, lastAttempt: 0 };
    fail.count++;
    fail.lastAttempt = Date.now();
    this._vlcFailCount.set(mediaId, fail);
    const dec = this._vlcDecoders.get(mediaId);
    if (dec) { dec.dispose(); this._vlcDecoders.delete(mediaId); }
  },

  // Clear failure backoff on a successful decode so subsequent frames
  // aren't penalized by earlier transient errors.
  _recordVLCSuccess(mediaId) {
    this._vlcFailCount.delete(mediaId);
  },

  async _getFrameVLC(mediaId, timeSeconds, width, height) {
    // Lazy-init VLCDecoder for this media
    if (!this._vlcDecoders.has(mediaId)) {
      if (!this._vlcInitPromises.has(mediaId)) {
        const p = (async () => {
          try {
            const dec = createVLCDecoder();
            const file = this._mediaFiles.get(mediaId);
            await dec.init(mediaId, file);
            // Register per-bridge _onFrameCached callback for render bar
            const bridge = dec.getBridge();
            if (bridge) {
              const capturedId = mediaId;
              bridge.setFrameCachedCallback((timeMs) => {
                const ram = _getRenderAheadManager();
                if (ram) ram.markFrameDecoded(capturedId, timeMs);
              });
              bridge.setBroadcastFrameCallback((timeMs, bitmap) => {
                const ram = _getRenderAheadManager();
                if (ram) ram.pushFrame(capturedId, timeMs, bitmap);
              });
            }
            if (this._sequentialMode) dec.startSequentialMode();
            this._vlcDecoders.set(mediaId, dec);
          } finally {
            this._vlcInitPromises.delete(mediaId);
          }
        })();
        this._vlcInitPromises.set(mediaId, p);
      }
      await this._vlcInitPromises.get(mediaId);
    }

    const dec = this._vlcDecoders.get(mediaId);
    if (!dec || !dec.isHealthy()) {
      this._recordVLCFailure(mediaId);
      throw new Error('VLC decoder unhealthy');
    }

    if (this._sequentialMode) {
      // Lazy-start sequential VLC playback from first requested time.
      if (!this._vlcSeqStarted) {
        this._vlcSeqStarted = true;
        const bridge = dec.getBridge?.();
        if (bridge) await bridge.startSequentialMode(timeSeconds);
      }
      return await dec.getSequentialImageBitmap(timeSeconds);
    }
    const bmp = await dec.getImageBitmapAt(timeSeconds);
    if (!bmp) return null;
    // Note: markFrameDecoded is called via the _onFrameCached callback
    // registered during VLC decoder init — no need to call it again here.
    // No resize needed — drawFit() in VideoCompositor now scales to fit.
    return bmp;
  },

  // Get a frame as ImageBitmap (uncached — callers like VideoCompositor check RenderAheadManager first)
  async getFrame(mediaId, url, timeSeconds, width, height) {
    if (this._shouldTryVLC(mediaId)) {
      try {
        const bitmap = await this._getFrameVLC(mediaId, timeSeconds, width, height);
        if (bitmap) {
          this._recordVLCSuccess(mediaId);
          return bitmap;
        }
        return _makeBlackFrame(width || 1920, height || 1080);
      } catch (e) {
        logger.warn(`[MediaDecoder] VLC decode failed for ${mediaId}:`, e.message);
        this._recordVLCFailure(mediaId);
        return _makeBlackFrame(width || 1920, height || 1080);
      }
    }
    return _makeBlackFrame(width || 1920, height || 1080);
  },

  // Enable sequential decode mode on all VLC decoders (for export).
  // Also sets a flag so decoders created mid-export get sequential mode.
  startSequentialMode() {
    this._sequentialMode = true;
    this._vlcSeqStarted = false;
    for (const [, dec] of this._vlcDecoders) {
      dec.startSequentialMode();
    }
  },

  endSequentialMode() {
    this._sequentialMode = false;
    this._vlcSeqStarted = false;
    for (const [, dec] of this._vlcDecoders) {
      dec.endSequentialMode();
    }
  },

  cleanup() {
    for (const [, dec] of this._vlcDecoders) {
      try { dec.dispose(); } catch(_) {}
    }
    this._vlcDecoders.clear();
    this._vlcInitPromises.clear();
    this._vlcFailCount.clear();
    this._mediaFiles.clear();
    this._vlcSeqStarted = false;
  }
};

function _makeBlackFrame(w, h) {
  try {
    const canvas = new OffscreenCanvas(w || 1920, h || 1080);
    return createImageBitmap(canvas, { colorSpaceConversion: 'none' }).catch(() => null);
  } catch(_) {
    return Promise.resolve(null);
  }
}

export default mediaDecoder;

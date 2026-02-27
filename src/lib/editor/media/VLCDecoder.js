// VLC-based decoder — one VLCBridge instance per mediaId.
// Unified decode interface consumed by MediaDecoder.
import { createVLCBridge } from './VLCBridge.js';
import { createVLCStreamSession } from './VLCStreamSession.js';
import { mediaManager } from './MediaManager.js';
import logger from '../../utils/logger.js';

export function createVLCDecoder() {
  let _mediaId = null;
  let _file = null;
  let _healthy = true;
  let _initialized = false;
  let _bridge = null;
  let _session = null;

  return {
    async init(mediaId, file) {
      _mediaId = mediaId;
      _file = file;

      // Reuse the probe bridge if available — avoids _fs_create/_fs_destroy
      // cycles which hang the shared libvlc instance in WASM.
      const probedBridges = mediaManager._vlcProbedBridges;
      if (probedBridges && probedBridges.has(mediaId)) {
        _bridge = probedBridges.get(mediaId);
        probedBridges.delete(mediaId);
        _session = createVLCStreamSession(_bridge);
        _initialized = true;
        logger.info(`[VLCDecoder] Reusing probed bridge for ${file.name}`);
        return;
      }

      // No pre-probed bridge — create a new one (e.g., for project restore)
      _bridge = createVLCBridge(mediaId);
      try {
        await _bridge.loadFile(file);
        _session = createVLCStreamSession(_bridge);
        _initialized = true;
        logger.info(`[VLCDecoder] Ready for ${file.name}`);
      } catch (err) {
        _healthy = false;
        logger.error(`[VLCDecoder] Init failed for ${file.name}:`, err.message);
        throw err;
      }
    },

    async getImageBitmapAt(timeSeconds) {
      if (!_healthy || !_bridge) return null;
      try {
        return await _bridge.getFrameAt(timeSeconds);
      } catch (err) {
        logger.warn(`[VLCDecoder] getImageBitmapAt(${timeSeconds}) failed:`, err.message);
        _healthy = false;
        return null;
      }
    },

    async getSequentialImageBitmap(timeSeconds) {
      if (!_healthy || !_bridge) return null;
      try {
        return await _bridge.getSequentialFrame(timeSeconds);
      } catch (err) {
        logger.warn(`[VLCDecoder] getSequentialImageBitmap failed:`, err.message);
        return null;
      }
    },

    async startSequentialMode(startSeconds) {
      if (_bridge) await _bridge.startSequentialMode(startSeconds);
    },

    endSequentialMode() {
      if (_bridge) _bridge.endSequentialMode();
    },

    // Get the per-instance bridge for playback sync, callbacks, etc.
    getBridge() {
      return _bridge;
    },

    getSession() { return _session; },

    isHealthy() {
      return _healthy && _initialized;
    },

    close() { this.dispose(); },

    dispose() {
      _healthy = false;
      _initialized = false;
      if (_bridge) { _bridge.release(); _bridge = null; }
      _session = null;
      _file = null;
    }
  };
}

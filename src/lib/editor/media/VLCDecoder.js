// VLC-based decoder — one VLCBridge instance per mediaId.
// Unified decode interface consumed by MediaDecoder.
import { createVLCBridge } from './VLCBridge.js';
import { mediaManager } from './MediaManager.js';
import logger from '../../utils/logger.js';

export function createVLCDecoder() {
  let _mediaId = null;
  let _file = null;
  let _healthy = true;
  let _initialized = false;
  let _bridge = null;

  return {
    async init(mediaId, file) {
      _mediaId = mediaId;
      _file = file;

      // Check if MediaManager already probed this file and has a bridge ready.
      // Reuse it instead of creating a second VLC media player (VLC's webcodec
      // module uses global state — only one active player per worker is safe).
      const probedBridges = mediaManager._vlcProbedBridges;
      if (probedBridges && probedBridges.has(mediaId)) {
        _bridge = probedBridges.get(mediaId);
        probedBridges.delete(mediaId);
        _initialized = true;
        logger.info(`[VLCDecoder] Reusing probed bridge for ${file.name}`);
        return;
      }

      // No pre-probed bridge — create a new one (e.g., for project restore)
      _bridge = createVLCBridge(mediaId);
      try {
        await _bridge.loadFile(file);
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

    startSequentialMode() {
      // Actual start happens in MediaDecoder._startVLCSequential
    },

    endSequentialMode() {
      if (_bridge) _bridge.endSequentialMode();
    },

    // Get the per-instance bridge for playback sync, callbacks, etc.
    getBridge() {
      return _bridge;
    },

    isHealthy() {
      return _healthy && _initialized;
    },

    close() { this.dispose(); },

    dispose() {
      _healthy = false;
      _initialized = false;
      if (_bridge) { _bridge.release(); _bridge = null; }
      _file = null;
    }
  };
}

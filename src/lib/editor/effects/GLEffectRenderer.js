// WebGL 2.0 GPU-accelerated effect renderer (main-thread singleton)
// Thin wrapper around GLRendererCore with main-thread-specific isSupported() check.
import { createGLRenderer } from './GLRendererCore.js';
import { colorManagement } from '../core/ColorManagement.js';
import logger from '../../utils/logger.js';

const core = createGLRenderer({ log: logger });

export const glEffectRenderer = {
  _supportChecked: false,
  _supported: false,

  isSupported() {
    if (this._supportChecked) return this._supported;
    this._supportChecked = true;

    if (typeof OffscreenCanvas !== 'undefined') {
      try {
        const c = new OffscreenCanvas(1, 1);
        const gl = c.getContext('webgl2', { powerPreference: 'high-performance' });
        if (gl) { this._supported = true; return true; }
      } catch (e) { /* fall through */ }
    }
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2', { powerPreference: 'high-performance' });
      this._supported = !!gl;
    } catch (e) {
      this._supported = false;
    }
    return this._supported;
  },

  init(canvas) {
    const result = core.init(canvas);
    if (result) {
      logger.info('GLEffectRenderer initialized (WebGL 2.0)');
    }
    return result;
  },

  uploadSource(source, width, height) {
    const linear = colorManagement.isLinearCompositing();
    return core.uploadSource(source, width, height, linear);
  },

  applyEffect(effectId, params) {
    return core.applyEffect(effectId, params);
  },

  readResult(targetCtx) {
    const linear = colorManagement.isLinearCompositing();
    return core.readResult(targetCtx, linear);
  },

  hasShader(effectId) {
    return core.hasShader(effectId);
  },

  uploadLUT(key, data, width, height = 1) {
    return core.uploadLUT(key, data, width, height);
  },

  cleanup() {
    core.cleanup();
    this._supportChecked = false;
    this._supported = false;
  }
};

export default glEffectRenderer;

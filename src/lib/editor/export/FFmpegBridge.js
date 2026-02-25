// Thin wrapper around @ffmpeg/ffmpeg for VFS + exec operations.
// Handles lazy loading, Cache API pre-warming, and progress callbacks.
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import logger from '../../utils/logger.js';

const CORE_VERSION = '0.12.6';
const CDN_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CDN_BASE_MT = `https://unpkg.com/@ffmpeg/core-mt@${CORE_VERSION}/dist/esm`;

// Feature detection for multi-threaded WASM core
function _wasmSimdSupported() {
  try {
    // Minimal WASM SIMD module: (module (func (result v128) (i32x4.splat (i32.const 0))))
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3,
      2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 12, 11
    ]));
  } catch (e) {
    return false;
  }
}

function _sharedArrayBufferAvailable() {
  try {
    return typeof SharedArrayBuffer !== 'undefined' &&
      new SharedArrayBuffer(1).byteLength === 1;
  } catch (e) {
    return false;
  }
}

export const ffmpegBridge = {
  _ffmpeg: null,
  _loaded: false,
  _loading: null,
  _progressCb: null,
  _multiThreaded: false,

  isLoaded() {
    return this._loaded;
  },

  isMultiThreaded() {
    return this._multiThreaded;
  },

  async load(onProgress) {
    if (this._loaded) return;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        logger.debug(`[FFmpeg] ${message}`);
        // Forward to worker message bus if inside a Worker
        if (typeof self !== 'undefined' && self.postMessage) {
          try { self.postMessage({ type: 'log', message: `[FFmpeg] ${message}` }); } catch (_) {}
        }
      });

      ffmpeg.on('progress', ({ progress }) => {
        if (this._progressCb) this._progressCb(progress);
      });

      onProgress?.(0.1);

      // Use multi-threaded core when WASM SIMD + SharedArrayBuffer are available
      const useMT = _wasmSimdSupported() && _sharedArrayBufferAvailable();
      const base = useMT ? CDN_BASE_MT : CDN_BASE;

      const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
      onProgress?.(0.4);
      const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm');
      onProgress?.(0.7);

      const loadOpts = { coreURL, wasmURL };
      if (useMT) {
        loadOpts.workerURL = await toBlobURL(`${base}/ffmpeg-core.worker.js`, 'text/javascript');
      }
      onProgress?.(0.8);

      await ffmpeg.load(loadOpts);

      this._ffmpeg = ffmpeg;
      this._loaded = true;
      this._multiThreaded = useMT;
      onProgress?.(1);
      logger.info(`FFmpeg loaded (${useMT ? 'multi-threaded + SIMD' : 'single-threaded'})`);
    })();

    return this._loading;
  },

  async writeFile(name, data) {
    if (!this._ffmpeg) throw new Error('FFmpeg not loaded');
    await this._ffmpeg.writeFile(name, data);
  },

  async readFile(name) {
    if (!this._ffmpeg) throw new Error('FFmpeg not loaded');
    return await this._ffmpeg.readFile(name);
  },

  async deleteFile(name) {
    if (!this._ffmpeg) throw new Error('FFmpeg not loaded');
    try {
      await this._ffmpeg.deleteFile(name);
    } catch (_) {
      // Ignore — file may already be deleted
    }
  },

  async exec(args) {
    if (!this._ffmpeg) throw new Error('FFmpeg not loaded');
    const ret = await this._ffmpeg.exec(args);
    if (ret !== 0) {
      throw new Error(`FFmpeg exited with code ${ret}`);
    }
  },

  setProgressCallback(fn) {
    this._progressCb = fn;
  },

  // Pre-warm: fetch core files into browser Cache API so Worker loads instantly
  async ensureCacheWarm() {
    if (typeof caches === 'undefined') return;
    try {
      const useMT = _wasmSimdSupported() && _sharedArrayBufferAvailable();
      const base = useMT ? CDN_BASE_MT : CDN_BASE;
      const urls = [
        `${base}/ffmpeg-core.js`,
        `${base}/ffmpeg-core.wasm`
      ];
      if (useMT) urls.push(`${base}/ffmpeg-core.worker.js`);
      for (const url of urls) {
        const resp = await fetch(url, { cache: 'force-cache' });
        if (!resp.ok) logger.warn(`Cache warm failed for ${url}: ${resp.status}`);
      }
    } catch (err) {
      logger.warn('FFmpeg cache warm failed:', err.message);
    }
  }
};

export default ffmpegBridge;

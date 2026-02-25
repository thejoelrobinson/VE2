// AI segmentation manager — uses MediaPipe Interactive Segmenter on the main thread.
// MediaPipe requires DOM access (HTMLCanvasElement + WebGL), cannot run in a Web Worker.
// At ~67ms per segment call (GPU), fast enough for interactive use on main thread.
//
// API reference: @mediapipe/tasks-vision v0.10.32
//   InteractiveSegmenter.segment(image: ImageSource, roi: RegionOfInterest): InteractiveSegmenterResult
//   RegionOfInterest: { keypoint?: NormalizedKeypoint, scribble?: NormalizedKeypoint[] }
//   NormalizedKeypoint: { x: number, y: number } — normalized 0-1 coordinates
//   InteractiveSegmenterResult: { confidenceMasks?: MPMask[], categoryMask?: MPMask }
//   MPMask: { width, height, getAsFloat32Array(), getAsWebGLTexture() }

import logger from '../../utils/logger.js';

let InteractiveSegmenter = null;
let FilesetResolver = null;

export const segmentationManager = {
  _segmenter: null,
  _ready: false,
  _loading: false,
  _loadError: null,
  _encodedFrameKey: null,
  _cachedCanvas: null,   // HTMLCanvasElement with current frame drawn
  _cachedCtx: null,
  _cachedWidth: 0,
  _cachedHeight: 0,
  _onProgress: null,

  async init() {
    if (this._segmenter || this._loading) return;
    this._loading = true;
    this._loadError = null;

    try {
      // Lazy-load MediaPipe (avoids bundling WASM into main chunk)
      const mod = await import('@mediapipe/tasks-vision');
      InteractiveSegmenter = mod.InteractiveSegmenter;
      FilesetResolver = mod.FilesetResolver;

      if (this._onProgress) this._onProgress(0.1, 'Loading WASM runtime...');

      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm'
      );

      if (this._onProgress) this._onProgress(0.5, 'Loading segmentation model...');

      this._segmenter = await InteractiveSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite',
          delegate: 'GPU'
        },
        outputCategoryMask: false,
        outputConfidenceMasks: true
      });

      // MediaPipe needs HTMLCanvasElement (not OffscreenCanvas) as input
      this._cachedCanvas = document.createElement('canvas');
      this._cachedCtx = this._cachedCanvas.getContext('2d', { willReadFrequently: true });

      this._ready = true;
      this._loading = false;
      if (this._onProgress) this._onProgress(1.0, 'Ready');
      logger.info('[Segmentation] MediaPipe Interactive Segmenter ready');
    } catch (err) {
      this._loading = false;
      this._loadError = err.message;
      logger.error('[Segmentation] Load failed:', err.message);
    }
  },

  isReady() { return this._ready; },
  isLoading() { return this._loading; },
  getLoadError() { return this._loadError; },
  setProgressCallback(fn) { this._onProgress = fn; },

  // Cache a video frame for subsequent decodeMask() calls.
  // bitmap is drawn onto an HTMLCanvasElement at project canvas dimensions.
  async encodeFrame(bitmap, width, height, frameKey) {
    if (!this._ready) throw new Error('Segmentation model not ready');

    if (frameKey && this._encodedFrameKey === frameKey) {
      bitmap.close();
      return;
    }

    if (this._cachedWidth !== width || this._cachedHeight !== height) {
      this._cachedCanvas.width = width;
      this._cachedCanvas.height = height;
      this._cachedWidth = width;
      this._cachedHeight = height;
    }
    this._cachedCtx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    this._encodedFrameKey = frameKey || null;
  },

  // Run interactive segmentation using foreground/background point prompts.
  // Points are in pixel coordinates — converted to normalized 0-1 internally.
  // Uses MediaPipe's "scribble" ROI for multi-point FG strokes (better than single keypoints).
  // Returns { mask: Float32Array(w*h), width: w, height: h }
  async decodeMask(positivePoints, negativePoints, width, height) {
    if (!this._ready || !this._segmenter) throw new Error('Segmentation model not ready');
    if (!this._encodedFrameKey) throw new Error('No frame cached — call encodeFrame first');

    const w = this._cachedWidth;
    const h = this._cachedHeight;
    const size = w * h;
    const mergedMask = new Float32Array(size);

    // Use scribble ROI for foreground points (all FG points as one scribble)
    if (positivePoints.length > 0) {
      const scribble = positivePoints.map(pt => ({
        x: pt.x / w,
        y: pt.y / h
      }));

      // segment() with no callback returns a copied result (safe to use after call)
      const result = this._segmenter.segment(this._cachedCanvas, { scribble });

      if (result.confidenceMasks && result.confidenceMasks.length > 0) {
        const mpMask = result.confidenceMasks[0];
        const maskW = mpMask.width;
        const maskH = mpMask.height;
        const maskData = mpMask.getAsFloat32Array();

        // MediaPipe returns masks at input image resolution (not model resolution).
        // Apply sigmoid hardening to crisp up the soft confidence edges from
        // MediaPipe's internal bilinear upscale (512→input size).
        logger.info(`[Segmentation] Mask: ${maskW}x${maskH}, canvas: ${w}x${h}`);

        if (maskW === w && maskH === h) {
          for (let i = 0; i < size; i++) {
            mergedMask[i] = 1 / (1 + Math.exp(-10 * (maskData[i] - 0.5)));
          }
        } else {
          // Fallback: nearest-neighbor resize + sigmoid (shouldn't normally be needed)
          const resized = this._resizeMask(maskData, maskW, maskH, w, h);
          for (let i = 0; i < size; i++) {
            mergedMask[i] = resized[i];
          }
        }
      }
      if (result.close) result.close();
    }

    // Subtract background points (one keypoint at a time)
    for (const pt of negativePoints) {
      const result = this._segmenter.segment(this._cachedCanvas, {
        keypoint: { x: pt.x / w, y: pt.y / h }
      });

      if (result.confidenceMasks && result.confidenceMasks.length > 0) {
        const mpMask = result.confidenceMasks[0];
        const maskW = mpMask.width;
        const maskH = mpMask.height;
        const maskData = mpMask.getAsFloat32Array();

        if (maskW === w && maskH === h) {
          for (let i = 0; i < size; i++) {
            // Soft BG subtraction: smoothly reduce merged mask where BG confidence is high
            const bgConf = 1 / (1 + Math.exp(-10 * (maskData[i] - 0.5)));
            mergedMask[i] = mergedMask[i] * (1 - bgConf);
          }
        } else {
          const resized = this._resizeMask(maskData, maskW, maskH, w, h);
          for (let i = 0; i < size; i++) {
            const bgConf = 1 / (1 + Math.exp(-10 * (resized[i] - 0.5)));
            mergedMask[i] = mergedMask[i] * (1 - bgConf);
          }
        }
      }
      if (result.close) result.close();
    }

    return { mask: mergedMask, width: w, height: h };
  },

  // Resize a confidence mask from model output to target dimensions.
  // Uses nearest-neighbor sampling (no blurry bilinear interpolation) + sigmoid
  // hardening to produce crisp edges from soft confidence values.
  _resizeMask(maskData, srcW, srcH, dstW, dstH) {
    const result = new Float32Array(dstW * dstH);
    const xRatio = srcW / dstW;
    const yRatio = srcH / dstH;

    for (let y = 0; y < dstH; y++) {
      const sy = Math.min(Math.floor(y * yRatio), srcH - 1);
      for (let x = 0; x < dstW; x++) {
        const sx = Math.min(Math.floor(x * xRatio), srcW - 1);
        const val = maskData[sy * srcW + sx];
        // Sigmoid hardening: steepens the soft confidence edge into a ~4px transition.
        // Without this, the model's native 3-4px soft edge at 256px becomes 20-30px at 1080p.
        result[y * dstW + x] = 1 / (1 + Math.exp(-10 * (val - 0.5)));
      }
    }
    return result;
  },

  cleanup() {
    if (this._segmenter) {
      try { this._segmenter.close(); } catch (_) {}
      this._segmenter = null;
    }
    this._ready = false;
    this._loading = false;
    this._loadError = null;
    this._encodedFrameKey = null;
    this._cachedCanvas = null;
    this._cachedCtx = null;
    this._cachedWidth = 0;
    this._cachedHeight = 0;
    this._onProgress = null;
  }
};

export default segmentationManager;

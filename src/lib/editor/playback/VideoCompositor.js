// Multi-track video compositing on a canvas
// @ts-check
// Supports two modes:
//   1. OffscreenCanvas worker (default) — compositing off the main thread
//   2. Main-thread fallback — direct Canvas2D rendering (used if worker unavailable or for export)

/** @typedef {import('./CompositorWorker.js').CW_InitRequest} CW_InitRequest */
/** @typedef {import('./CompositorWorker.js').CW_RenderRequest} CW_RenderRequest */
/** @typedef {import('./CompositorWorker.js').CW_ResizeRequest} CW_ResizeRequest */
/** @typedef {import('./CompositorWorker.js').CW_Response} CW_Response */

import { editorState } from '../core/EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { clipContainsFrame, getSourceFrameAtPlayhead, getClipEndFrame } from '../timeline/Clip.js';
import { frameToSeconds } from '../timeline/TimelineMath.js';
import { MEDIA_TYPES, STATE_PATHS } from '../core/Constants.js';
import { mediaManager } from '../media/MediaManager.js';
import { mediaDecoder } from '../media/MediaDecoder.js';
import { renderAheadManager } from '../media/RenderAheadManager.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { keyframeEngine } from '../effects/KeyframeEngine.js';
import { transitions, getTransitionZone } from '../effects/Transitions.js';
import { glEffectRenderer } from '../effects/GLEffectRenderer.js';
import { colorManagement } from '../core/ColorManagement.js';
import {
  drawFit,
  separateEffects,
  applyCompositing,
  applyMotionCrop,
  applyClipMasks
} from './compositorHelpers.js';
import { resolveClipMasks } from '../effects/MaskUtils.js';
import { applyRotoEffects, getMatteCacheForEffect } from '../effects/RotoEffect.js';
import logger from '../../utils/logger.js';

// Reusable containers for _buildRenderCommand hot path — avoids per-frame allocation
const _reusableTransClipIds = new Set();
const _reusableClipMap = new Map();

export const videoCompositor = {
  _canvas: null,
  _ctx: null,
  _offscreenCanvas: null,
  _offscreenCtx: null,
  _transCanvases: [null, null],
  _transCtxs: [null, null],
  _glAvailable: false,
  _exportCanvases: null,

  // Worker compositing state
  _worker: null,
  _workerReady: false,
  _workerBusy: false,
  _useWorker: false,
  _pendingResolve: null,
  _pendingWorkerFrame: null, // queued frame when worker is busy (renders on finish)
  _displayCanvas: null, // the visible <canvas> element (for worker mode)
  _displayCtx: null,
  _workerWatchdog: null, // timeout ID for crash detection
  _resizing: false, // skip rendering during canvas resize
  _onWorkerFallback: null, // callback when worker crashes and falls back to main-thread

  init(canvas) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d', { alpha: false });
    this._resizeCanvas();
    this._glAvailable = glEffectRenderer.isSupported() && glEffectRenderer.init();

    // Resize compositor canvas when sequence resolution changes
    editorState.subscribe(STATE_PATHS.PROJECT_CANVAS, () => this._resizeCanvas());
  },

  // Initialize compositor worker with OffscreenCanvas transfer.
  // displayCanvas is the visible <canvas> element shown to the user.
  // Returns true if worker was successfully set up.
  initWorker(displayCanvas, opts = {}) {
    if (this._worker) return true;

    // Feature-detect OffscreenCanvas transfer
    if (typeof displayCanvas.transferControlToOffscreen !== 'function') {
      logger.warn('[VideoCompositor] OffscreenCanvas not supported, using main-thread rendering');
      return false;
    }

    try {
      this._worker = new Worker(new URL('./CompositorWorker.js', import.meta.url), {
        type: 'module'
      });
    } catch (err) {
      logger.warn('[VideoCompositor] Failed to create compositor worker:', err.message);
      return false;
    }

    this._displayCanvas = displayCanvas;

    let offscreen;
    try {
      offscreen = displayCanvas.transferControlToOffscreen();
    } catch (err) {
      logger.warn('[VideoCompositor] Failed to transfer canvas to offscreen:', err.message);
      this._worker.terminate();
      this._worker = null;
      return false;
    }

    const { width, height } = editorState.get(STATE_PATHS.PROJECT_CANVAS);

    this._worker.onmessage = e => this._onWorkerMessage(e);
    this._worker.onerror = err => {
      logger.error('[VideoCompositor] Worker crashed:', err.message || err);
      this._workerBusy = false;
      this._clearWorkerWatchdog();
      if (this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        resolve();
      }
      // Fall back to main-thread rendering
      this._useWorker = false;
      this._workerReady = false;
      logger.warn('[VideoCompositor] Falling back to main-thread rendering after worker crash');
      if (this._onWorkerFallback) this._onWorkerFallback();
    };
    this._worker.onmessageerror = err => {
      logger.error('[VideoCompositor] Worker message deserialization error:', err);
      this._workerBusy = false;
      this._clearWorkerWatchdog();
      if (this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        resolve();
      }
      // Fall back to main-thread rendering
      this._useWorker = false;
      this._workerReady = false;
      if (this._onWorkerFallback) this._onWorkerFallback();
    };

    try {
      this._worker.postMessage(
        { type: 'init', canvas: offscreen, width, height, useP3: !!opts.useP3 },
        [offscreen]
      );
    } catch (initErr) {
      logger.warn('[VideoCompositor] Failed to send init to worker:', initErr.message);
      this._worker.terminate();
      this._worker = null;
      this._useWorker = false;
      logger.warn('[VideoCompositor] Worker rendering unavailable, using main-thread fallback');
      return false;
    }

    this._useWorker = true;
    logger.info('[VideoCompositor] Compositor worker initialized');
    return true;
  },

  _onWorkerMessage(e) {
    const { type } = e.data;

    if (type === 'init_done') {
      this._workerReady = true;
      logger.info(`[VideoCompositor] Worker ready (GL: ${e.data.glAvailable})`);
      return;
    }

    if (type === 'rendered') {
      this._workerBusy = false;
      this._clearWorkerWatchdog();
      if (this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        resolve();
      }
      // If a frame was queued during backpressure, render it now
      if (this._pendingWorkerFrame !== null) {
        const queuedFrame = this._pendingWorkerFrame;
        this._pendingWorkerFrame = null;
        this._compositeFrameWorker(queuedFrame);
      }
      return;
    }
  },

  isWorkerBusy() {
    return this._workerBusy;
  },

  // Build a serializable render command for the worker.
  // Resolves keyframes, fetches frames, collects effect params — all on main thread.
  // Returns { command, transferables } where transferables is an array of ImageBitmaps.
  async _buildRenderCommand(frame) {
    const { width: canvasWidth, height: canvasHeight } = editorState.get(
      STATE_PATHS.PROJECT_CANVAS
    );
    const videoTracks = timelineEngine.getVideoTracks();
    const trackCommands = [];
    const transferables = [];

    // Iterate forward so the worker's reverse loop draws bottom tracks first,
    // top tracks last (matching main-thread compositing order).
    for (let i = 0; i < videoTracks.length; i++) {
      const track = videoTracks[i];
      if (track.muted) continue;

      const activeTrans = this._getActiveTransitions(track, frame);
      _reusableTransClipIds.clear();
      for (const t of activeTrans) {
        _reusableTransClipIds.add(t.clipAId);
        _reusableTransClipIds.add(t.clipBId);
      }

      const clipCommands = [];
      const transCommands = [];

      // Build clip commands (non-transition clips)
      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (!clipContainsFrame(clip, frame)) continue;
        if (_reusableTransClipIds.has(clip.id)) continue;

        const mediaItem = mediaManager.getItem(clip.mediaId);
        if (!mediaItem) continue;

        const clipCmd = await this._buildClipCommand(
          clip,
          mediaItem,
          frame,
          canvasWidth,
          canvasHeight
        );
        if (clipCmd) {
          clipCommands.push(clipCmd.command);
          transferables.push(...clipCmd.transferables);
        }
      }

      // Build transition commands
      _reusableClipMap.clear();
      for (const c of track.clips) _reusableClipMap.set(c.id, c);
      for (const trans of activeTrans) {
        const clipA = _reusableClipMap.get(trans.clipAId);
        const clipB = _reusableClipMap.get(trans.clipBId);
        if (!clipA || !clipB) continue;

        const editPoint = getClipEndFrame(clipA);
        const { start } = getTransitionZone(trans, editPoint);
        const progress = Math.max(0, Math.min(1, (frame - start) / trans.duration));
        let clipACmd = null;
        let clipBCmd = null;

        const mediaA = mediaManager.getItem(clipA.mediaId);
        if (mediaA) {
          // Use handle-aware source time (frame may be past clip A's visible end)
          const result = await this._buildClipCommandForTransition(
            clipA,
            mediaA,
            frame,
            canvasWidth,
            canvasHeight
          );
          if (result) {
            clipACmd = result.command;
            transferables.push(...result.transferables);
          }
        }

        const mediaB = mediaManager.getItem(clipB.mediaId);
        if (mediaB) {
          // Use handle-aware source time (frame may be before clip B's visible start)
          const result = await this._buildClipCommandForTransition(
            clipB,
            mediaB,
            frame,
            canvasWidth,
            canvasHeight
          );
          if (result) {
            clipBCmd = result.command;
            transferables.push(...result.transferables);
          }
        }

        transCommands.push({
          type: trans.type,
          progress,
          clipA: clipACmd,
          clipB: clipBCmd
        });
      }

      trackCommands.push({ clips: clipCommands, transitions: transCommands });
    }

    return {
      command: {
        canvasWidth,
        canvasHeight,
        tracks: trackCommands,
        linearCompositing: colorManagement.isLinearCompositing()
      },
      transferables
    };
  },

  // Build a single clip's render command.
  // Returns { command, transferables } or null if no frame available.
  async _buildClipCommand(clip, mediaItem, frame, canvasWidth, canvasHeight, sourceTimeOverride) {
    const sourceTime = sourceTimeOverride ?? frameToSeconds(getSourceFrameAtPlayhead(clip, frame));

    // Fetch the frame as ImageBitmap
    let bitmap = null;
    if (mediaItem.type === MEDIA_TYPES.VIDEO) {
      bitmap = renderAheadManager.getFrame(mediaItem.id, sourceTime);
      if (!bitmap) {
        bitmap = await mediaDecoder.getFrame(mediaItem.id, mediaItem.url, sourceTime);
      }
    } else if (mediaItem.type === MEDIA_TYPES.IMAGE) {
      bitmap = await this._getImageBitmap(mediaItem);
    }

    if (!bitmap) return null;

    // Pass cached ImageBitmaps directly — structured clone in postMessage
    // copies them efficiently (browser-optimized, often GPU-accelerated).
    // Do NOT transfer (detaches from cache) or clone via createImageBitmap
    // (slow ~2-5ms per 1080p frame). If a bitmap was .close()'d by cache
    // eviction between here and postMessage, the DataCloneError is caught
    // in _compositeFrameWorker and falls back to main-thread rendering.
    const transferBitmap = bitmap;

    // Resolve effects
    const effects = (clip.effects || []).filter(fx => fx.enabled);
    const resolvedMasks = resolveClipMasks(clip, frame);
    const needsProcessing = this._checkNeedsProcessing(
      effects,
      canvasWidth,
      canvasHeight,
      clip.masks
    );

    const resolvedEffects = [];
    for (const fx of effects) {
      const def = effectRegistry.get(fx.effectId);
      if (!def || def.type !== 'video') continue;
      const resolvedParams = keyframeEngine.resolveParams(fx, frame);
      // Replace non-cloneable GL texture handles with raw Uint8Array data for worker
      // (WebGLTexture objects cause DataCloneError during structured clone)
      let workerParams = resolvedParams;
      const fxMatteCache = getMatteCacheForEffect(fx.id);
      if (
        resolvedParams._curveLUT ||
        resolvedParams._hslCurveLUT ||
        resolvedParams._segMasks ||
        fxMatteCache
      ) {
        workerParams = { ...resolvedParams };
        delete workerParams._curveLUT;
        delete workerParams._hslCurveLUT;
        // Replace Map objects with frame-specific data the worker can use.
        // Send only the current frame's segmentation mask as a plain Float32Array (cheap to clone).
        if (workerParams._segMasks instanceof Map) {
          workerParams._segMaskForFrame = workerParams._segMasks.get(frame) || null;
          delete workerParams._segMasks;
        }
        if (fxMatteCache instanceof Map) {
          workerParams._matteCacheForFrame = fxMatteCache.get(frame) || null;
        }
        // Pass raw LUT data so the worker can upload its own textures
        // _curveLUTData / _hslCurveLUTData are Uint8Arrays (cloneable)
      }
      resolvedEffects.push({
        effectId: fx.effectId,
        intrinsic: !!fx.intrinsic,
        type: def.type,
        resolvedParams: workerParams
      });
    }

    // Separate roto effects from standard pixel effects for the worker command.
    const rotoEffectsCmd = [];
    const nonRotoEffects = [];
    for (const rfx of resolvedEffects) {
      const def = effectRegistry.get(rfx.effectId);
      if (def && def.isRoto) {
        rotoEffectsCmd.push(rfx);
      } else {
        nonRotoEffects.push(rfx);
      }
    }

    return {
      command: {
        clipId: clip.id,
        frame: transferBitmap,
        timelineFrame: frame,
        needsProcessing,
        effects: nonRotoEffects,
        rotoEffects: rotoEffectsCmd,
        masks: resolvedMasks
      },
      // Intentionally empty — bitmaps use structured clone (not transfer) to preserve render-ahead cache references
      transferables: []
    };
  },

  // Like _buildClipCommand but uses handle-aware source time for transitions
  // (frame may be outside clip's visible timeline range)
  async _buildClipCommandForTransition(clip, mediaItem, frame, canvasWidth, canvasHeight) {
    const sourceTime = this._getTransitionSourceTime(clip, frame);
    return this._buildClipCommand(clip, mediaItem, frame, canvasWidth, canvasHeight, sourceTime);
  },

  // Get an ImageBitmap from an image media item (cached)
  async _getImageBitmap(mediaItem) {
    let img = this._getImageCache(mediaItem.id);
    if (!img) {
      img = new Image();
      img.src = mediaItem.url;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      this._setImageCache(mediaItem.id, img);
    }
    return img;
  },

  _clearWorkerWatchdog() {
    if (this._workerWatchdog) {
      clearTimeout(this._workerWatchdog);
      this._workerWatchdog = null;
    }
  },

  // Primary compositing entry point.
  // If worker is available: builds render command, sends to worker.
  // Otherwise: renders on main thread (original path).
  async compositeFrame(frame) {
    // Debug logging removed — enable if needed:
    // logger.info(`[VideoCompositor] compositeFrame(${frame}) tracks=${timelineEngine.getVideoTracks().length} clips=${timelineEngine.getVideoTracks().reduce((n, t) => n + t.clips.length, 0)}`);
    if (this._resizing) return; // skip rendering during canvas resize
    if (this._useWorker && this._workerReady) {
      return this._compositeFrameWorker(frame);
    }
    return this._compositeFrameMainThread(frame);
  },

  async _compositeFrameWorker(frame) {
    if (this._workerBusy) {
      // Queue latest frame — rendered immediately when worker finishes
      // (overwrites any previously queued frame; only the newest matters)
      this._pendingWorkerFrame = frame;
      return;
    }
    this._workerBusy = true;
    this._pendingWorkerFrame = null; // clear stale queued frame — we're rendering the latest

    try {
      // Pin bitmaps during build to prevent LRU eviction from closing them
      renderAheadManager.pinFrames();
      let buildResult;
      try {
        buildResult = await this._buildRenderCommand(frame);
      } finally {
        renderAheadManager.unpinFrames();
      }
      const { command, transferables } = buildResult;

      return new Promise(resolve => {
        this._pendingResolve = resolve;
        try {
          this._worker.postMessage({ type: 'render', frame, command }, transferables);
          // Watchdog: if worker doesn't respond within 5s, assume crash and recover
          this._clearWorkerWatchdog();
          this._workerWatchdog = setTimeout(() => {
            if (this._workerBusy) {
              logger.warn('[VideoCompositor] Worker watchdog timeout (5s), recovering');
              this._workerBusy = false;
              if (this._pendingResolve) {
                const pendingResolve = this._pendingResolve;
                this._pendingResolve = null;
                pendingResolve();
              }
            }
          }, 5000);
        } catch (postErr) {
          // DataCloneError: a cached ImageBitmap was .close()'d between
          // buildRenderCommand and postMessage (rare race with cache eviction).
          // Queue for retry via worker on next cycle instead of falling back
          // to main-thread canvas (which is invisible in worker mode).
          this._workerBusy = false;
          this._pendingResolve = null;
          this._pendingWorkerFrame = frame;
          resolve();
        }
      });
    } catch (e) {
      this._workerBusy = false;
      if (this._pendingResolve) {
        const resolve = this._pendingResolve;
        this._pendingResolve = null;
        resolve();
      }
      return this._compositeFrameMainThread(frame);
    }
  },

  // Original main-thread compositing (kept as fallback + used by export)
  async _compositeFrameMainThread(frame) {
    if (!this._canvas || !this._ctx) return;

    const ctx = this._ctx;
    const { width, height } = editorState.get(STATE_PATHS.PROJECT_CANVAS);

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    const videoTracks = timelineEngine.getVideoTracks();

    for (let i = videoTracks.length - 1; i >= 0; i--) {
      const track = videoTracks[i];
      if (track.muted) continue;

      const activeTrans = this._getActiveTransitions(track, frame);
      _reusableTransClipIds.clear();
      for (const t of activeTrans) {
        _reusableTransClipIds.add(t.clipAId);
        _reusableTransClipIds.add(t.clipBId);
      }

      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (!clipContainsFrame(clip, frame)) continue;
        if (_reusableTransClipIds.has(clip.id)) continue;

        const mediaItem = mediaManager.getItem(clip.mediaId);
        if (!mediaItem) continue;

        const sourceFrame = getSourceFrameAtPlayhead(clip, frame);
        const sourceTime = frameToSeconds(sourceFrame);

        await this._renderClip(ctx, mediaItem, sourceTime, width, height, clip, frame);
      }

      _reusableClipMap.clear();
      for (const c of track.clips) _reusableClipMap.set(c.id, c);
      for (const trans of activeTrans) {
        await this._renderTransition(ctx, track, trans, frame, width, height, _reusableClipMap);
      }
    }
  },

  _resizeCanvas() {
    this._resizing = true;
    const { width, height } = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    if (this._canvas) {
      this._canvas.width = width;
      this._canvas.height = height;
    }
    // Resize worker canvas too
    if (this._worker && this._workerReady) {
      this._worker.postMessage({ type: 'resize', width, height });
    }
    this._resizing = false;
  },

  _getOffscreenCtx(width, height) {
    if (!this._offscreenCanvas) {
      this._offscreenCanvas = document.createElement('canvas');
      this._offscreenCtx = this._offscreenCanvas.getContext('2d');
    }
    if (this._offscreenCanvas.width !== width) this._offscreenCanvas.width = width;
    if (this._offscreenCanvas.height !== height) this._offscreenCanvas.height = height;
    return this._offscreenCtx;
  },

  async _renderClip(ctx, mediaItem, sourceTime, canvasWidth, canvasHeight, clip, frame) {
    // Delegate to _renderClipTo using the shared instance offscreen canvas
    const offCtx = this._getOffscreenCtx(canvasWidth, canvasHeight);
    return this._renderClipTo(ctx, offCtx, this._offscreenCanvas, mediaItem, sourceTime, canvasWidth, canvasHeight, clip, frame);
  },

  async _renderImage(ctx, mediaItem, canvasWidth, canvasHeight, clip) {
    let img = this._getImageCache(mediaItem.id);
    if (!img) {
      img = new Image();
      img.src = mediaItem.url;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      this._setImageCache(mediaItem.id, img);
    }

    drawFit(ctx, img, canvasWidth, canvasHeight);
  },

  async _renderVideo(ctx, mediaItem, sourceTime, canvasWidth, canvasHeight, clip) {
    let frame = renderAheadManager.getFrame(mediaItem.id, sourceTime);
    if (!frame) {
      frame = await mediaDecoder.getFrame(mediaItem.id, mediaItem.url, sourceTime);
    }
    if (frame) {
      drawFit(ctx, frame, canvasWidth, canvasHeight);
    }
  },

  _getTransCtx(index, width, height) {
    if (!this._transCanvases[index]) {
      this._transCanvases[index] = document.createElement('canvas');
      this._transCtxs[index] = this._transCanvases[index].getContext('2d');
    }
    const c = this._transCanvases[index];
    if (c.width !== width) c.width = width;
    if (c.height !== height) c.height = height;
    return { canvas: c, ctx: this._transCtxs[index] };
  },

  _getActiveTransitions(track, frame) {
    if (!track.transitions || track.transitions.length === 0) return [];
    return track.transitions.filter(t => {
      const clipA = track.clips.find(c => c.id === t.clipAId);
      if (!clipA) return false;
      const editPoint = getClipEndFrame(clipA);
      const { start, end } = getTransitionZone(t, editPoint);
      return frame >= start && frame < end;
    });
  },

  _getExportCanvases(width, height) {
    if (
      this._exportCanvases &&
      this._exportCanvases.width === width &&
      this._exportCanvases.height === height
    ) {
      return this._exportCanvases;
    }
    const makeCanvas = (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return { canvas: c, ctx: c.getContext('2d') };
    };
    this._exportCanvases = {
      width,
      height,
      off: makeCanvas(width, height),
      transA: makeCanvas(width, height),
      transB: makeCanvas(width, height)
    };
    return this._exportCanvases;
  },

  // Export path — always main-thread (ExportWorker has its own WorkerCompositor)
  async compositeFrameTo(frame, targetCtx, width, height) {
    targetCtx.fillStyle = '#000000';
    targetCtx.fillRect(0, 0, width, height);

    const ec = this._getExportCanvases(width, height);
    const { canvas: offCanvas, ctx: offCtx } = ec.off;
    const { canvas: transCanvasA, ctx: transCtxA } = ec.transA;
    const { canvas: transCanvasB, ctx: transCtxB } = ec.transB;

    const videoTracks = timelineEngine.getVideoTracks();

    for (let i = videoTracks.length - 1; i >= 0; i--) {
      const track = videoTracks[i];
      if (track.muted) continue;

      const activeTrans = this._getActiveTransitions(track, frame);
      _reusableTransClipIds.clear();
      for (const t of activeTrans) {
        _reusableTransClipIds.add(t.clipAId);
        _reusableTransClipIds.add(t.clipBId);
      }

      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (!clipContainsFrame(clip, frame)) continue;
        if (_reusableTransClipIds.has(clip.id)) continue;

        const mediaItem = mediaManager.getItem(clip.mediaId);
        if (!mediaItem) continue;

        const sourceFrame = getSourceFrameAtPlayhead(clip, frame);
        const sourceTime = frameToSeconds(sourceFrame);

        await this._renderClipTo(
          targetCtx,
          offCtx,
          offCanvas,
          mediaItem,
          sourceTime,
          width,
          height,
          clip,
          frame
        );
      }

      _reusableClipMap.clear();
      for (const c of track.clips) _reusableClipMap.set(c.id, c);
      for (const trans of activeTrans) {
        await this._renderTransitionTo(
          targetCtx,
          track,
          trans,
          frame,
          width,
          height,
          transCanvasA,
          transCtxA,
          transCanvasB,
          transCtxB,
          offCtx,
          offCanvas,
          _reusableClipMap
        );
      }
    }
  },

  async _renderClipTo(
    ctx,
    offCtx,
    offCanvas,
    mediaItem,
    sourceTime,
    canvasWidth,
    canvasHeight,
    clip,
    frame
  ) {
    const effects = (clip.effects || []).filter(fx => fx.enabled);
    const resolvedMasks = resolveClipMasks(clip, frame);

    const needsProcessing = this._checkNeedsProcessing(
      effects,
      canvasWidth,
      canvasHeight,
      clip.masks
    );

    if (!needsProcessing) {
      if (mediaItem.type === MEDIA_TYPES.IMAGE) {
        await this._renderImage(ctx, mediaItem, canvasWidth, canvasHeight, clip);
      } else if (mediaItem.type === MEDIA_TYPES.VIDEO) {
        await this._renderVideo(ctx, mediaItem, sourceTime, canvasWidth, canvasHeight, clip);
      }
      return;
    }

    offCtx.clearRect(0, 0, canvasWidth, canvasHeight);

    if (mediaItem.type === MEDIA_TYPES.IMAGE) {
      await this._renderImage(offCtx, mediaItem, canvasWidth, canvasHeight, clip);
    } else if (mediaItem.type === MEDIA_TYPES.VIDEO) {
      await this._renderVideo(offCtx, mediaItem, sourceTime, canvasWidth, canvasHeight, clip);
    }

    const {
      motionParams,
      transformParams,
      opacity,
      pixelEffects,
      cropEffects,
      rotoEffects
    } = separateEffects(
      effects,
      id => effectRegistry.get(id),
      (fx, f) => keyframeEngine.resolveParams(fx, f),
      frame
    );
    for (const { def, params } of cropEffects) def.apply(offCtx, params);

    this._applyPixelEffects(offCtx, offCanvas, pixelEffects, canvasWidth, canvasHeight);

    // Apply roto effects after pixel effects (needs source pixels for color analysis)
    if (rotoEffects.length > 0) {
      applyRotoEffects(offCtx, offCanvas, rotoEffects, frame, canvasWidth, canvasHeight, false);
    }

    // Apply masks after roto, before motion/compositing
    if (resolvedMasks) {
      applyClipMasks(offCtx, offCanvas, resolvedMasks, canvasWidth, canvasHeight, false);
    }

    if (motionParams) applyMotionCrop(offCtx, motionParams, canvasWidth, canvasHeight);
    applyCompositing(
      ctx,
      transformParams,
      opacity,
      offCanvas,
      canvasWidth,
      canvasHeight,
      motionParams
    );
  },

  async _renderTransitionTo(
    ctx,
    track,
    trans,
    frame,
    width,
    height,
    transCanvasA,
    transCtxA,
    transCanvasB,
    transCtxB,
    offCtx,
    offCanvas,
    clipMap
  ) {
    const clipA = clipMap ? clipMap.get(trans.clipAId) : track.clips.find(c => c.id === trans.clipAId);
    const clipB = clipMap ? clipMap.get(trans.clipBId) : track.clips.find(c => c.id === trans.clipBId);
    if (!clipA || !clipB) return;

    const editPoint = getClipEndFrame(clipA);
    const { start } = getTransitionZone(trans, editPoint);
    const progress = Math.max(0, Math.min(1, (frame - start) / trans.duration));

    transCtxA.clearRect(0, 0, width, height);
    const mediaA = mediaManager.getItem(clipA.mediaId);
    if (mediaA) {
      const sourceTimeA = this._getTransitionSourceTime(clipA, frame);
      await this._renderClipTo(
        transCtxA,
        offCtx,
        offCanvas,
        mediaA,
        sourceTimeA,
        width,
        height,
        clipA,
        frame
      );
    }

    transCtxB.clearRect(0, 0, width, height);
    const mediaB = mediaManager.getItem(clipB.mediaId);
    if (mediaB) {
      const sourceTimeB = this._getTransitionSourceTime(clipB, frame);
      await this._renderClipTo(
        transCtxB,
        offCtx,
        offCanvas,
        mediaB,
        sourceTimeB,
        width,
        height,
        clipB,
        frame
      );
    }

    transitions.render(ctx, transCanvasA, transCanvasB, trans.type, progress, width, height);
  },

  // Compute source frame for a clip during a transition (may be outside clip's visible range)
  _getTransitionSourceTime(clip, frame) {
    // Works for both handle frames (past out-point or before in-point) and normal frames
    const offsetInClip = frame - clip.startFrame;
    const sourceFrame = clip.sourceInFrame + Math.round(offsetInClip * (clip.speed || 1));
    return frameToSeconds(Math.max(0, sourceFrame));
  },

  async _renderTransition(ctx, track, trans, frame, width, height, clipMap) {
    // Delegate to _renderTransitionTo using the shared instance canvases
    const { canvas: canvasA, ctx: ctxA } = this._getTransCtx(0, width, height);
    const { canvas: canvasB, ctx: ctxB } = this._getTransCtx(1, width, height);
    const offCtx = this._getOffscreenCtx(width, height);
    return this._renderTransitionTo(ctx, track, trans, frame, width, height, canvasA, ctxA, canvasB, ctxB, offCtx, this._offscreenCanvas, clipMap);
  },

  _applyPixelEffects(offCtx, offCanvas, pixelEffects, canvasWidth, canvasHeight) {
    if (pixelEffects.length === 0) return;
    const useGL =
      this._glAvailable && pixelEffects.every(e => glEffectRenderer.hasShader(e.fx.effectId));
    if (useGL) {
      glEffectRenderer.uploadSource(offCanvas, canvasWidth, canvasHeight);
      for (const { fx, params } of pixelEffects) {
        glEffectRenderer.applyEffect(fx.effectId, params);
      }
      offCtx.clearRect(0, 0, canvasWidth, canvasHeight);
      glEffectRenderer.readResult(offCtx);
    } else {
      for (const { def, params } of pixelEffects) {
        def.apply(offCtx, params);
      }
    }
  },

  _checkNeedsProcessing(effects, canvasWidth, canvasHeight, masks) {
    // Masks always require offscreen processing
    if (masks && masks.length > 0 && masks.some(m => m.enabled)) return true;
    // Roto effects require offscreen processing when strokes or segmentation masks exist
    if (
      effects.some(fx => {
        const def = effectRegistry.get(fx.effectId);
        if (!def || !def.isRoto) return false;
        if (fx.params.strokes && fx.params.strokes.length > 0) return true;
        if (fx.params._segMasks && fx.params._segMasks.size > 0) return true;
        const mc = getMatteCacheForEffect(fx.id);
        if (mc && mc.size > 0) return true;
        return false;
      })
    )
      return true;
    return effects.some(fx => {
      if (fx.intrinsic && fx.effectId === 'opacity') {
        return fx.keyframes?.opacity?.length > 0 || fx.params.opacity !== 100;
      }
      if (fx.intrinsic && fx.effectId === 'audio-volume') return false;
      if (fx.intrinsic && fx.effectId === 'motion') {
        return this._motionNeedsProcessing(fx, canvasWidth, canvasHeight);
      }
      if (fx.intrinsic && fx.effectId === 'time-remap') return false;
      if (fx.intrinsic && (fx.effectId === 'panner' || fx.effectId === 'channel-volume'))
        return false;
      return true;
    });
  },

  _motionNeedsProcessing(fx, canvasWidth, canvasHeight) {
    const p = fx.params;
    const cx = canvasWidth / 2;
    const cy = canvasHeight / 2;
    if (p.posX !== cx || p.posY !== cy) return true;
    if (p.scale !== 100 || p.scaleWidth !== 100) return true;
    if (p.rotation !== 0) return true;
    // Compare anchor against source center (not canvas center)
    const srcCx = (p.sourceWidth || canvasWidth) / 2;
    const srcCy = (p.sourceHeight || canvasHeight) / 2;
    if (p.anchorX !== srcCx || p.anchorY !== srcCy) return true;
    if (p.antiFlicker !== 0) return true;
    if (p.cropLeft !== 0 || p.cropTop !== 0 || p.cropRight !== 0 || p.cropBottom !== 0) return true;
    const kf = fx.keyframes;
    if (kf) {
      for (const key of Object.keys(kf)) {
        if (kf[key] && kf[key].length > 0) return true;
      }
    }
    return false;
  },

  _imageCache: new Map(),

  _getImageCache(mediaId) {
    return this._imageCache.get(mediaId);
  },

  _setImageCache(mediaId, img) {
    this._imageCache.set(mediaId, img);
  },

  cleanup() {
    // Terminate compositor worker
    this._clearWorkerWatchdog();
    if (this._worker) {
      this._worker.postMessage({ type: 'destroy' });
      this._worker.terminate();
      this._worker = null;
      this._workerReady = false;
      this._workerBusy = false;
      this._useWorker = false;
      this._pendingResolve = null;
      this._pendingWorkerFrame = null;
      this._displayCanvas = null;
      this._displayCtx = null;
    }
    mediaDecoder.cleanup();
    this._imageCache.clear();
    this._offscreenCanvas = null;
    this._offscreenCtx = null;
    this._transCanvases = [null, null];
    this._transCtxs = [null, null];
    this._exportCanvases = null;
  }
};

export default videoCompositor;

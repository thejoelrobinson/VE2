// Worker-safe video compositor -- uses OffscreenCanvas and GLEffectRenderer
import { drawFit, separateEffects, applyCompositing, applyMotionCrop, applyCanvas2DEffect } from '../playback/compositorHelpers.js';
import { glEffectRenderer } from '../effects/GLEffectRenderer.js';
import { GL_SUPPORTED_EFFECTS } from '../effects/effectShaders.js';
import logger from '../../utils/logger.js';

export function createWorkerCompositor(width, height, mediaDecoder, effectRegistryGet, keyframeResolve, initialFps = 30) {
  let fps = initialFps;
  // willReadFrequently: true forces CPU-backed canvas — avoids GPU readback
  // failures when WebGL contexts coexist in the same worker
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const offCanvas = new OffscreenCanvas(width, height);
  const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

  // Lazy GL init — only when pixel effects are actually needed (avoid
  // eagerly creating WebGL contexts that can invalidate 2D canvas GPU backing)
  let glAvailable = null; // null = unchecked, true/false = checked

  return {
    canvas,

    setFps(newFps) { fps = newFps; },

    async compositeFrame(frame, tracks, getMediaItem) {
      // Clear to black
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      let clipsRendered = 0;

      // Render video tracks bottom-to-top
      for (let i = tracks.length - 1; i >= 0; i--) {
        const track = tracks[i];
        if (track.muted || track.type !== 'video') continue;

        for (const clip of track.clips) {
          if (clip.disabled) continue;

          // Mirror Clip.js: duration = (sourceOutFrame - sourceInFrame) / speed
          const clipDuration = Math.round((clip.sourceOutFrame - clip.sourceInFrame) / (clip.speed || 1));
          if (frame < clip.startFrame || frame >= clip.startFrame + clipDuration) continue;

          const mediaItem = getMediaItem(clip.mediaId);
          if (!mediaItem) continue;

          // Mirror Clip.js: getSourceFrameAtPlayhead
          const offsetInClip = frame - clip.startFrame;
          const sourceFrame = clip.sourceInFrame + Math.round(offsetInClip * (clip.speed || 1));
          const sourceTime = sourceFrame / fps;

          await this._renderClip(ctx, mediaItem, sourceTime, clip, frame);
          clipsRendered++;
        }
      }

      if (frame === 0) {
        logger.info(`[WorkerCompositor] frame 0: ${clipsRendered} clips rendered, canvas=${width}x${height}`);
      }

      return canvas;
    },

    async _renderClip(targetCtx, mediaItem, sourceTime, clip, frame) {
      const effects = (clip.effects || []).filter(fx => fx.enabled);

      if (effects.length === 0) {
        const source = await this._getSource(mediaItem, sourceTime);
        if (source) drawFit(targetCtx, source, width, height);
        return;
      }

      // Render to offscreen
      offCtx.clearRect(0, 0, width, height);
      const source = await this._getSource(mediaItem, sourceTime);
      if (source) drawFit(offCtx, source, width, height);

      // Separate effects (now includes motion params)
      const { transformParams, motionParams, opacity, pixelEffects, cropEffects } =
        separateEffects(effects, effectRegistryGet, keyframeResolve, frame);

      // Apply crop effects (inline — def.apply() not available in Worker)
      for (const { params } of cropEffects) {
        const w = width, h = height;
        const top = (params.top / 100) * h;
        const bottom = (params.bottom / 100) * h;
        const left = (params.left / 100) * w;
        const right = (params.right / 100) * w;
        offCtx.fillStyle = '#000';
        if (top > 0) offCtx.fillRect(0, 0, w, top);
        if (bottom > 0) offCtx.fillRect(0, h - bottom, w, bottom);
        if (left > 0) offCtx.fillRect(0, 0, left, h);
        if (right > 0) offCtx.fillRect(w - right, 0, right, h);
      }

      // Apply pixel effects via GL or Canvas2D filter fallback
      if (pixelEffects.length > 0) {
        // Lazy GL init on first actual pixel effect
        if (glAvailable === null) {
          glAvailable = glEffectRenderer.isSupported() && glEffectRenderer.init();
        }
        const allGLSupported = glAvailable &&
          pixelEffects.every(e => GL_SUPPORTED_EFFECTS.has(e.fx.effectId));

        if (allGLSupported) {
          glEffectRenderer.uploadSource(offCanvas, width, height);
          for (const { fx, params } of pixelEffects) {
            glEffectRenderer.applyEffect(fx.effectId, params);
          }
          offCtx.clearRect(0, 0, width, height);
          glEffectRenderer.readResult(offCtx);
        } else {
          // Canvas2D filter fallback (def.apply() not available in Worker)
          for (const { fx, params } of pixelEffects) {
            applyCanvas2DEffect(offCtx, fx.effectId, params);
          }
        }
      }

      // Apply motion crop after pixel effects
      if (motionParams) {
        applyMotionCrop(offCtx, motionParams, width, height);
      }

      // Composite with transform/motion/opacity
      applyCompositing(targetCtx, transformParams, opacity, offCanvas, width, height, motionParams);
    },

    async _getSource(mediaItem, sourceTime) {
      let result = null;
      if (mediaItem.type === 'image') {
        result = await mediaDecoder.getImageBitmap(mediaItem.id);
      } else if (mediaItem.type === 'video') {
        result = await mediaDecoder.getVideoFrame(mediaItem.id, sourceTime);
      }
      if (!result) {
        logger.warn(`[WorkerCompositor] _getSource returned null: id=${mediaItem.id}, type=${mediaItem.type}, time=${sourceTime}`);
      }
      return result;
    },

    cleanup() {
      glEffectRenderer.cleanup();
    }
  };
}

export default createWorkerCompositor;

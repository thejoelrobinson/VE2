// OffscreenCanvas compositor worker — renders video frames off the main thread.
// @ts-check
// Receives an OffscreenCanvas, render commands with ImageBitmaps, draws composited result.
// Supports Canvas2D rendering with motion transforms, transitions, crop, opacity.
// WebGL pixel effects via shared GLRendererCore.

import logger from '../../utils/logger.js';
import { createGLRenderer } from '../effects/GLRendererCore.js';
import { COMPOSITE_VERT, COMPOSITE_FRAG } from '../effects/effectShaders.js';
import {
  drawFit,
  applyMotionCrop,
  applyCompositing,
  applyCanvas2DEffect,
  applyClipMasks
} from './compositorHelpers.js';
import { applyRotoEffects } from '../effects/RotoEffect.js';

// ---- Worker Message Protocol (JSDoc) ----

/**
 * @typedef {object} CW_InitRequest
 * @property {'init'} type
 * @property {OffscreenCanvas} canvas - Transferred OffscreenCanvas for rendering
 * @property {number} width
 * @property {number} height
 * @property {boolean} [useP3] - Use display-p3 color space on canvas context
 * Transfer list: [canvas]
 */

/**
 * @typedef {object} CW_ResizeRequest
 * @property {'resize'} type
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {object} CW_ClipCommand
 * @property {ImageBitmap} frame - Source frame bitmap
 * @property {Array<object>} effects - Effect descriptors with effectId, resolvedParams, type, etc.
 * @property {boolean} needsProcessing - Whether effects/motion need processing
 * @property {Array<object>} [rotoEffects] - Roto effect descriptors
 * @property {Array<object>} [masks] - Clip mask descriptors
 * @property {number} [timelineFrame] - Current timeline frame for roto time interpolation
 */

/**
 * @typedef {object} CW_TransitionCommand
 * @property {string} type - Transition type (cross-dissolve, dip-to-black, wipe-left, etc.)
 * @property {number} progress - Transition progress [0, 1]
 * @property {CW_ClipCommand|null} clipA - Outgoing clip
 * @property {CW_ClipCommand|null} clipB - Incoming clip
 */

/**
 * @typedef {object} CW_TrackCommand
 * @property {CW_ClipCommand[]} clips - Non-transition clips on this track
 * @property {CW_TransitionCommand[]} transitions - Active transitions on this track
 */

/**
 * @typedef {object} CW_RenderCommand
 * @property {number} canvasWidth
 * @property {number} canvasHeight
 * @property {CW_TrackCommand[]} tracks - Tracks ordered top-to-bottom (last = highest visual priority)
 * @property {boolean} [linearCompositing] - Whether to use linear light compositing
 */

/**
 * @typedef {object} CW_RenderRequest
 * @property {'render'} type
 * @property {number} frame - Timeline frame number
 * @property {CW_RenderCommand} command
 * Transfer list: all ImageBitmaps in clips and transitions
 */

/**
 * @typedef {object} CW_DestroyRequest
 * @property {'destroy'} type
 */

/** @typedef {CW_InitRequest | CW_ResizeRequest | CW_RenderRequest | CW_DestroyRequest} CW_Request */

/**
 * @typedef {object} CW_InitDoneResponse
 * @property {'init_done'} type
 * @property {boolean} glAvailable - Whether WebGL rendering is available
 */

/**
 * @typedef {object} CW_RenderedResponse
 * @property {'rendered'} type
 * @property {number} frame - Timeline frame number that was rendered
 */

/** @typedef {CW_InitDoneResponse | CW_RenderedResponse} CW_Response */

// ---- GL renderer instance with lumetri LUT pre-processing wrapper ----
const glRenderer = createGLRenderer();
const _baseApplyEffect = glRenderer.applyEffect.bind(glRenderer);
glRenderer.applyEffect = function (effectId, params) {
  if (effectId === 'lumetri-color' && params.curves_enabled) {
    if (params._curveLUTData && !params._curveLUT) {
      params._curveLUT = glRenderer.uploadLUT('lumetri-curve', params._curveLUTData, 256, 1);
    }
    if (params._hslCurveLUTData && !params._hslCurveLUT) {
      params._hslCurveLUT = glRenderer.uploadLUT(
        'lumetri-hsl-curve',
        params._hslCurveLUTData,
        256,
        5
      );
    }
  }
  return _baseApplyEffect(effectId, params);
};

// ---- GL composite output (deferred Phase B) ----
// compositeToOutput and _buildMVPMatrix remain worker-only for now.
glRenderer.compositeToOutput = function (
  targetCtx,
  canvasWidth,
  canvasHeight,
  motionParams,
  opacity,
  transformParams
) {
  if (!this._initialized || !this._gl) return false;
  const gl = this._gl;
  if (!this._compositeProgram) {
    const program = this._compileProgram(COMPOSITE_VERT, COMPOSITE_FRAG);
    if (!program) return false;
    const uniforms = {};
    const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < numUniforms; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    this._compositeProgram = { program, uniforms };
  }
  const prog = this._compositeProgram;
  const mvp = _buildMVPMatrix(motionParams, transformParams, canvasWidth, canvasHeight);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, this._width, this._height);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(prog.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, this._fboTextures[this._currentFBO]);
  if (prog.uniforms['u_source'] !== undefined) gl.uniform1i(prog.uniforms['u_source'], 0);
  if (prog.uniforms['u_opacity'] !== undefined) gl.uniform1f(prog.uniforms['u_opacity'], opacity);
  if (prog.uniforms['u_crop'] !== undefined) {
    const cropL = motionParams ? (motionParams.cropLeft || 0) / 100 : 0;
    const cropT = motionParams ? (motionParams.cropTop || 0) / 100 : 0;
    const cropR = motionParams ? (motionParams.cropRight || 0) / 100 : 0;
    const cropB = motionParams ? (motionParams.cropBottom || 0) / 100 : 0;
    gl.uniform4f(prog.uniforms['u_crop'], cropL, cropT, cropR, cropB);
  }
  if (prog.uniforms['u_mvp'] !== undefined) gl.uniformMatrix3fv(prog.uniforms['u_mvp'], false, mvp);
  gl.bindVertexArray(this._quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disable(gl.BLEND);
  targetCtx.drawImage(this._canvas, 0, 0);
  return true;
};

function _buildMVPMatrix(motionParams, transformParams, canvasW, canvasH) {
  const m = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (motionParams) {
    const sx = motionParams.uniformScale ? motionParams.scale / 100 : motionParams.scaleWidth / 100;
    const sy = motionParams.scale / 100;
    const rot = (motionParams.rotation * Math.PI) / 180;
    const posX = motionParams.posX;
    const posY = motionParams.posY;
    // Convert source-space anchor → canvas-space using drawFit offset
    const srcW = motionParams.sourceWidth || canvasW;
    const srcH = motionParams.sourceHeight || canvasH;
    const canvasAncX = motionParams.anchorX + (canvasW - srcW) / 2;
    const canvasAncY = motionParams.anchorY + (canvasH - srcH) / 2;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const cx = canvasW / 2;
    const cy = canvasH / 2;
    const isDefault =
      posX === cx &&
      posY === cy &&
      canvasAncX === cx &&
      canvasAncY === cy &&
      sx === 1 &&
      sy === 1 &&
      rot === 0;
    if (!isDefault) {
      const tx = (posX * 2) / canvasW - 1;
      const ty = 1 - (posY * 2) / canvasH;
      const atx = (canvasAncX * 2) / canvasW;
      const aty = (canvasAncY * 2) / canvasH;
      const scaleToClipX = sx;
      const scaleToClipY = sy;
      m[0] = cosR * scaleToClipX;
      m[1] = -sinR * scaleToClipX;
      m[3] = sinR * scaleToClipY;
      m[4] = cosR * scaleToClipY;
      m[6] = tx - cosR * scaleToClipX * (atx - 1) + sinR * scaleToClipY * (aty - 1);
      m[7] = ty + sinR * scaleToClipX * (atx - 1) + cosR * scaleToClipY * (aty - 1);
    }
  }
  return new Float32Array(m);
}

// ---- Worker state ----
let canvas = null;
let ctx = null;
let offscreenCanvas = null;
let offscreenCtx = null;
let transCanvases = [null, null];
let transCtxs = [null, null];
let glAvailable = false;
let rendering = false;
let currentLinearCompositing = false;

function ensureOffscreen(width, height) {
  if (!offscreenCanvas) {
    offscreenCanvas = new OffscreenCanvas(width, height);
    offscreenCtx = offscreenCanvas.getContext('2d');
  }
  if (offscreenCanvas.width !== width) offscreenCanvas.width = width;
  if (offscreenCanvas.height !== height) offscreenCanvas.height = height;
  return offscreenCtx;
}

function ensureTransCtx(index, width, height) {
  if (!transCanvases[index]) {
    transCanvases[index] = new OffscreenCanvas(width, height);
    transCtxs[index] = transCanvases[index].getContext('2d');
  }
  const c = transCanvases[index];
  if (c.width !== width) c.width = width;
  if (c.height !== height) c.height = height;
  return { canvas: c, ctx: transCtxs[index] };
}

// ---- Drawing helpers ----

function applyCrop(ctx, params, canvasWidth, canvasHeight) {
  const w = canvasWidth;
  const h = canvasHeight;
  const top = (params.top / 100) * h;
  const bottom = (params.bottom / 100) * h;
  const left = (params.left / 100) * w;
  const right = (params.right / 100) * w;
  if (top > 0 || bottom > 0 || left > 0 || right > 0) {
    ctx.fillStyle = '#000';
    if (top > 0) ctx.fillRect(0, 0, w, top);
    if (bottom > 0) ctx.fillRect(0, h - bottom, w, bottom);
    if (left > 0) ctx.fillRect(0, 0, left, h);
    if (right > 0) ctx.fillRect(w - right, 0, right, h);
  }
}

function renderClipToCtx(targetCtx, clipCmd, canvasWidth, canvasHeight) {
  if (!targetCtx || !clipCmd) return;
  const { frame: bitmap, effects, needsProcessing } = clipCmd;
  if (!bitmap) return;

  if (!needsProcessing) {
    drawFit(targetCtx, bitmap, canvasWidth, canvasHeight);
    return;
  }

  const offCtx = ensureOffscreen(canvasWidth, canvasHeight);
  offCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  drawFit(offCtx, bitmap, canvasWidth, canvasHeight);

  let motionParams = null;
  let transformParams = null;
  let opacity = 1;
  const pixelEffects = [];

  for (const fx of effects) {
    if (fx.effectId === 'motion' && fx.intrinsic) {
      motionParams = fx.resolvedParams;
    } else if (fx.effectId === 'transform') {
      transformParams = fx.resolvedParams;
    } else if (fx.effectId === 'opacity') {
      opacity = fx.resolvedParams.opacity / 100;
    } else if (fx.effectId === 'crop') {
      applyCrop(offCtx, fx.resolvedParams, canvasWidth, canvasHeight);
    } else if (
      fx.effectId === 'time-remap' ||
      fx.effectId === 'audio-volume' ||
      fx.effectId === 'panner' ||
      fx.effectId === 'channel-volume'
    ) {
      // Audio/time effects: skip in video compositor
    } else if (fx.type === 'video') {
      pixelEffects.push(fx);
    }
  }

  // Apply pixel effects via GL or Canvas2D fallback
  if (pixelEffects.length > 0 && offscreenCanvas) {
    const hasLumetri = pixelEffects.some(e => e.effectId === 'lumetri-color');
    if (hasLumetri) {
      logger.info('[CompositorWorker.renderClipToCtx] Processing effects:', {
        pixelEffectsCount: pixelEffects.length,
        effectIds: pixelEffects.map(e => e.effectId),
        glAvailable,
        hasGLRenderer: !!glRenderer
      });
    }
    const useGL =
      glAvailable && glRenderer && pixelEffects.every(e => glRenderer.hasShader(e.effectId));
    if (hasLumetri) {
      logger.info('[CompositorWorker.renderClipToCtx] Using GL path:', useGL);
    }

    if (useGL) {
      glRenderer.uploadSource(offscreenCanvas, canvasWidth, canvasHeight, currentLinearCompositing);
      for (const fx of pixelEffects) {
        if (fx.effectId === 'lumetri-color') {
          logger.info('[CompositorWorker.renderClipToCtx] Applying lumetri-color with params:', {
            basic_enabled: fx.resolvedParams.basic_enabled,
            curves_enabled: fx.resolvedParams.curves_enabled,
            hsl_enabled: fx.resolvedParams.hsl_enabled,
            has_curveLUT: !!fx.resolvedParams._curveLUT,
            has_curveLUTData: !!fx.resolvedParams._curveLUTData
          });
        }
        glRenderer.applyEffect(fx.effectId, fx.resolvedParams);
      }
      offCtx.clearRect(0, 0, canvasWidth, canvasHeight);
      glRenderer.readResult(offCtx, currentLinearCompositing);
    } else {
      // Canvas2D fallback for pixel effects
      for (const fx of pixelEffects) {
        if (fx.canvas2dFn) {
          applyCanvas2DEffect(offCtx, fx.effectId, fx.resolvedParams);
        }
      }
    }
  }

  // Apply roto effects after pixel effects (needs source pixels for color analysis)
  if (clipCmd.rotoEffects && clipCmd.rotoEffects.length > 0) {
    applyRotoEffects(
      offCtx,
      offscreenCanvas,
      clipCmd.rotoEffects,
      clipCmd.timelineFrame || 0,
      canvasWidth,
      canvasHeight,
      true
    );
  }

  // Apply clip masks after roto, before motion/compositing
  if (clipCmd.masks && clipCmd.masks.length > 0) {
    applyClipMasks(offCtx, offscreenCanvas, clipCmd.masks, canvasWidth, canvasHeight, true);
  }

  // Motion + opacity compositing via Canvas2D (proven path)
  if (motionParams) {
    applyMotionCrop(offCtx, motionParams, canvasWidth, canvasHeight);
  }

  applyCompositing(
    targetCtx,
    transformParams,
    opacity,
    offscreenCanvas,
    canvasWidth,
    canvasHeight,
    motionParams
  );
}

// ---- Transition rendering (mirrors Transitions.js) ----

function renderTransition(ctx, cmd, canvasWidth, canvasHeight) {
  const { type, progress, clipA, clipB } = cmd;

  const { canvas: canvasA, ctx: ctxA } = ensureTransCtx(0, canvasWidth, canvasHeight);
  ctxA.clearRect(0, 0, canvasWidth, canvasHeight);
  if (clipA) renderClipToCtx(ctxA, clipA, canvasWidth, canvasHeight);

  const { canvas: canvasB, ctx: ctxB } = ensureTransCtx(1, canvasWidth, canvasHeight);
  ctxB.clearRect(0, 0, canvasWidth, canvasHeight);
  if (clipB) renderClipToCtx(ctxB, clipB, canvasWidth, canvasHeight);

  switch (type) {
    case 'cross-dissolve':
      ctx.globalAlpha = 1 - progress;
      ctx.drawImage(canvasA, 0, 0, canvasWidth, canvasHeight);
      ctx.globalAlpha = progress;
      ctx.drawImage(canvasB, 0, 0, canvasWidth, canvasHeight);
      ctx.globalAlpha = 1;
      break;
    case 'dip-to-black':
    case 'dip-to-white': {
      const color = type === 'dip-to-white' ? '#fff' : '#000';
      if (progress < 0.5) {
        const p = progress * 2;
        ctx.drawImage(canvasA, 0, 0, canvasWidth, canvasHeight);
        ctx.globalAlpha = p;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.globalAlpha = 1;
      } else {
        const p = (progress - 0.5) * 2;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.globalAlpha = p;
        ctx.drawImage(canvasB, 0, 0, canvasWidth, canvasHeight);
        ctx.globalAlpha = 1;
      }
      break;
    }
    case 'wipe-left':
    case 'wipe-right':
    case 'wipe-up':
    case 'wipe-down': {
      const dir = type.split('-')[1]; // left, right, up, down
      ctx.drawImage(canvasA, 0, 0, canvasWidth, canvasHeight);
      ctx.save();
      ctx.beginPath();
      if (dir === 'left') ctx.rect(0, 0, canvasWidth * progress, canvasHeight);
      else if (dir === 'right')
        ctx.rect(canvasWidth * (1 - progress), 0, canvasWidth * progress, canvasHeight);
      else if (dir === 'up') ctx.rect(0, 0, canvasWidth, canvasHeight * progress);
      else ctx.rect(0, canvasHeight * (1 - progress), canvasWidth, canvasHeight * progress);
      ctx.clip();
      ctx.drawImage(canvasB, 0, 0, canvasWidth, canvasHeight);
      ctx.restore();
      break;
    }
    case 'slide-left':
      ctx.drawImage(canvasA, 0, 0, canvasWidth, canvasHeight);
      ctx.drawImage(canvasB, canvasWidth * (1 - progress), 0, canvasWidth, canvasHeight);
      break;
    case 'push-left': {
      const offset = canvasWidth * progress;
      ctx.drawImage(canvasA, -offset, 0, canvasWidth, canvasHeight);
      ctx.drawImage(canvasB, canvasWidth - offset, 0, canvasWidth, canvasHeight);
      break;
    }
    default:
      // Fallback to cross-dissolve
      ctx.globalAlpha = 1 - progress;
      ctx.drawImage(canvasA, 0, 0, canvasWidth, canvasHeight);
      ctx.globalAlpha = progress;
      ctx.drawImage(canvasB, 0, 0, canvasWidth, canvasHeight);
      ctx.globalAlpha = 1;
  }
}

// ---- Main message handler ----

self.onmessage = e => {
  const { type } = e.data;

  if (type === 'init') {
    canvas = e.data.canvas;
    const ctxOpts = { alpha: false };
    if (e.data.useP3) ctxOpts.colorSpace = 'display-p3';
    ctx = canvas.getContext('2d', ctxOpts);
    canvas.width = e.data.width;
    canvas.height = e.data.height;
    glAvailable = glRenderer.init();
    logger.info(
      '[CompositorWorker] Worker initialized - glAvailable:',
      glAvailable,
      'glRenderer exists:',
      !!glRenderer
    );
    self.postMessage({ type: 'init_done', glAvailable });
    return;
  }

  if (type === 'resize') {
    if (canvas) {
      canvas.width = e.data.width;
      canvas.height = e.data.height;
    }
    return;
  }

  if (type === 'render') {
    const { frame, command } = e.data;
    if (!canvas || !ctx || !command) {
      self.postMessage({ type: 'rendered', frame });
      return;
    }

    try {
      rendering = true;
      const { canvasWidth, canvasHeight, tracks, linearCompositing } = command;
      currentLinearCompositing = linearCompositing || false;

      // Clear to black
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // Render tracks bottom-to-top: last in array = top of UI = highest priority = render last
      for (let i = tracks.length - 1; i >= 0; i--) {
        const trackCmd = tracks[i];

        // Render non-transition clips
        for (const clipCmd of trackCmd.clips) {
          renderClipToCtx(ctx, clipCmd, canvasWidth, canvasHeight);
        }

        // Render transitions
        for (const transCmd of trackCmd.transitions) {
          renderTransition(ctx, transCmd, canvasWidth, canvasHeight);
        }
      }

      // Close all transferred ImageBitmaps to free memory
      for (const trackCmd of tracks) {
        for (const clipCmd of trackCmd.clips) {
          if (clipCmd.frame) clipCmd.frame.close();
        }
        for (const transCmd of trackCmd.transitions) {
          if (transCmd.clipA && transCmd.clipA.frame) transCmd.clipA.frame.close();
          if (transCmd.clipB && transCmd.clipB.frame) transCmd.clipB.frame.close();
        }
      }
    } catch (err) {
      // Log but don't let errors prevent 'rendered' response — otherwise
      // _workerBusy stays true forever and playback permanently freezes
      logger.error('Render error:', err);
    } finally {
      rendering = false;
      self.postMessage({ type: 'rendered', frame });
    }
    return;
  }

  if (type === 'destroy') {
    glRenderer.cleanup();
    canvas = null;
    ctx = null;
    offscreenCanvas = null;
    offscreenCtx = null;
    transCanvases = [null, null];
    transCtxs = [null, null];
    return;
  }
};

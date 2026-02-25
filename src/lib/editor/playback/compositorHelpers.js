// Shared pure functions for video compositing (main thread + Worker)

export { applyClipMasks } from '../effects/MaskUtils.js';

// Draw source scaled to fit canvas (letterboxed), centered.
// When source matches canvas dimensions, this is a simple 1:1 blit.
// When dimensions differ (e.g. 4K MXF on 1080p canvas), scales to fit
// without cropping — this eliminates the per-frame createImageBitmap
// resize that was happening in MediaDecoder._getFrameVLC.
export function drawFit(ctx, source, canvasWidth, canvasHeight) {
  const srcW = source.videoWidth || source.naturalWidth || source.width;
  const srcH = source.videoHeight || source.naturalHeight || source.height;
  if (!srcW || !srcH) return;

  // Fast path: source matches canvas — no scaling needed
  if (srcW === canvasWidth && srcH === canvasHeight) {
    ctx.drawImage(source, 0, 0);
    return;
  }

  // Scale to fit within canvas (letterbox — preserves aspect ratio)
  const scale = Math.min(canvasWidth / srcW, canvasHeight / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  const x = (canvasWidth - dw) / 2;
  const y = (canvasHeight - dh) / 2;

  ctx.drawImage(source, x, y, dw, dh);
}

// Separate effects into compositing (transform/motion/opacity/crop) and pixel effects
export function separateEffects(effects, effectRegistryGet, keyframeResolve, frame) {
  let transformParams = null;
  let motionParams = null;
  let opacity = 1;
  const pixelEffects = [];
  const cropEffects = [];
  const rotoEffects = [];

  for (const fx of effects) {
    const def = effectRegistryGet(fx.effectId);
    if (!def || def.type !== 'video') continue;

    const params = keyframeResolve(fx, frame);

    if (fx.effectId === 'motion' && fx.intrinsic) {
      motionParams = params;
    } else if (fx.effectId === 'transform') {
      transformParams = params;
    } else if (fx.effectId === 'opacity') {
      opacity = params.opacity / 100;
    } else if (fx.effectId === 'crop') {
      cropEffects.push({ fx, def, params });
    } else if (def.isRoto) {
      rotoEffects.push({ fx, def, params });
    } else if (fx.effectId === 'time-remap' || fx.effectId === 'audio-volume' ||
               fx.effectId === 'panner' || fx.effectId === 'channel-volume') {
      // Audio/time effects — skip in video compositor
    } else {
      pixelEffects.push({ fx, def, params });
    }
  }

  return { transformParams, motionParams, opacity, pixelEffects, cropEffects, rotoEffects };
}

// Apply motion crop to offscreen canvas (black bars over cropped regions)
export function applyMotionCrop(ctx, motionParams, canvasWidth, canvasHeight) {
  const { cropLeft, cropTop, cropRight, cropBottom } = motionParams;
  if (cropLeft <= 0 && cropTop <= 0 && cropRight <= 0 && cropBottom <= 0) return;
  const w = canvasWidth;
  const h = canvasHeight;
  const left = (cropLeft / 100) * w;
  const top = (cropTop / 100) * h;
  const right = (cropRight / 100) * w;
  const bottom = (cropBottom / 100) * h;
  ctx.fillStyle = '#000';
  if (top > 0) ctx.fillRect(0, 0, w, top);
  if (bottom > 0) ctx.fillRect(0, h - bottom, w, bottom);
  if (left > 0) ctx.fillRect(0, 0, left, h);
  if (right > 0) ctx.fillRect(w - right, 0, right, h);
}

// Apply compositing transform + motion + opacity and blit offscreen canvas to main context
export function applyCompositing(ctx, transformParams, opacity, offscreenCanvas, canvasWidth, canvasHeight, motionParams) {
  ctx.save();

  if (motionParams) {
    const sy = motionParams.scale / 100;
    const sx = motionParams.uniformScale ? sy : motionParams.scaleWidth / 100;
    // Convert source-space anchor → canvas-space using drawFit offset
    const srcW = motionParams.sourceWidth || canvasWidth;
    const srcH = motionParams.sourceHeight || canvasHeight;
    const offsetX = (canvasWidth - srcW) / 2;
    const offsetY = (canvasHeight - srcH) / 2;
    ctx.translate(motionParams.posX, motionParams.posY);
    ctx.rotate((motionParams.rotation * Math.PI) / 180);
    ctx.scale(sx, sy);
    ctx.translate(-(motionParams.anchorX + offsetX), -(motionParams.anchorY + offsetY));
  }

  if (transformParams) {
    const cx = canvasWidth / 2;
    const cy = canvasHeight / 2;
    ctx.translate(cx + transformParams.posX, cy + transformParams.posY);
    ctx.rotate((transformParams.rotation * Math.PI) / 180);
    ctx.scale(transformParams.scaleX / 100, transformParams.scaleY / 100);
    ctx.translate(-cx, -cy);
  }

  ctx.globalAlpha = opacity;
  ctx.drawImage(offscreenCanvas, 0, 0);
  ctx.restore();
}

// Canvas2D filter fallback for pixel effects (used in Workers where def.apply() is unavailable)
export function applyCanvas2DEffect(ctx, effectId, params) {
  switch (effectId) {
    case 'gaussian-blur':
      if (params.radius > 0) { ctx.filter = `blur(${params.radius}px)`; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none'; }
      break;
    case 'hue-rotate':
      ctx.filter = `hue-rotate(${params.angle}deg)`; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none';
      break;
    case 'invert':
      if (params.amount > 0) { ctx.filter = `invert(${params.amount}%)`; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none'; }
      break;
    case 'grayscale':
      if (params.amount > 0) { ctx.filter = `grayscale(${params.amount}%)`; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none'; }
      break;
    case 'sepia':
      if (params.amount > 0) { ctx.filter = `sepia(${params.amount}%)`; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none'; }
      break;
    case 'brightness-contrast': {
      const b = params.brightness / 100;
      const c = (params.contrast + 100) / 100;
      ctx.filter = `brightness(${1 + b}) contrast(${c})`; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none';
      break;
    }
    case 'saturation':
      ctx.filter = `saturate(${(params.amount + 100) / 100})`; ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none';
      break;
    case 'drop-shadow':
      ctx.filter = `drop-shadow(${params.offsetX}px ${params.offsetY}px ${params.blur}px ${params.color || '#000'})`;
      ctx.drawImage(ctx.canvas, 0, 0); ctx.filter = 'none';
      break;
    default:
      break;
  }
}

// Mask data model, path helpers, and compositing for clip masks.
// Masks live as a masks[] array on each clip (separate from effects[]).

import { keyframeEngine } from './KeyframeEngine.js';

let maskIdCounter = 0;

export function createMask(type = 'rectangle') {
  maskIdCounter++;
  const mask = {
    id: `mask-${maskIdCounter}`,
    name: `Mask ${maskIdCounter}`,
    type, // 'bezier' | 'ellipse' | 'rectangle'
    enabled: true,
    locked: false,
    inverted: false,
    mode: 'add', // 'add' | 'subtract' | 'intersect' | 'difference'
    params: { feather: 0, opacity: 100, expansion: 0 },
    keyframes: { feather: [], opacity: [], expansion: [] },
    path: buildDefaultPath(type),
    pathKeyframes: []
  };
  return mask;
}

// Default centered paths (normalized 0-1 coords)
function buildDefaultPath(type) {
  if (type === 'ellipse') {
    // Approximate ellipse with 4 bezier points (circle approximation)
    const k = 0.5522847498; // magic number for cubic bezier circle
    const cx = 0.5, cy = 0.5, rx = 0.25, ry = 0.25;
    return {
      closed: true,
      points: [
        { x: cx, y: cy - ry, inX: cx - rx * k, inY: cy - ry, outX: cx + rx * k, outY: cy - ry },
        { x: cx + rx, y: cy, inX: cx + rx, inY: cy - ry * k, outX: cx + rx, outY: cy + ry * k },
        { x: cx, y: cy + ry, inX: cx + rx * k, inY: cy + ry, outX: cx - rx * k, outY: cy + ry },
        { x: cx - rx, y: cy, inX: cx - rx, inY: cy + ry * k, outX: cx - rx, outY: cy - ry * k }
      ]
    };
  }

  if (type === 'rectangle') {
    // Centered rectangle with no bezier handles (sharp corners)
    const l = 0.25, t = 0.25, r = 0.75, b = 0.75;
    return {
      closed: true,
      points: [
        { x: l, y: t, inX: l, inY: t, outX: l, outY: t },
        { x: r, y: t, inX: r, inY: t, outX: r, outY: t },
        { x: r, y: b, inX: r, inY: b, outX: r, outY: b },
        { x: l, y: b, inX: l, inY: b, outX: l, outY: b }
      ]
    };
  }

  // Bezier: start with empty open path (user draws)
  return { closed: false, points: [] };
}

// Trace a bezier path onto a Canvas2D context (scaled to canvas dimensions)
export function traceBezierPath(ctx, path, w, h) {
  const pts = path.points;
  if (pts.length < 2) return;

  ctx.beginPath();
  ctx.moveTo(pts[0].x * w, pts[0].y * h);

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const curr = pts[i];
    ctx.bezierCurveTo(
      prev.outX * w, prev.outY * h,
      curr.inX * w, curr.inY * h,
      curr.x * w, curr.y * h
    );
  }

  if (path.closed && pts.length >= 3) {
    const last = pts[pts.length - 1];
    const first = pts[0];
    ctx.bezierCurveTo(
      last.outX * w, last.outY * h,
      first.inX * w, first.inY * h,
      first.x * w, first.y * h
    );
    ctx.closePath();
  }
}

// Expand/contract a path by pixel amount (offset each point radially from centroid).
// Points are in normalized [0-1] coords, so convert pixel expansion to normalized units.
export function applyExpansion(path, expansion, w, h) {
  if (expansion === 0) return path;
  const pts = path.points;
  if (pts.length < 2) return path;

  // Compute centroid in normalized coords
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length;
  cy /= pts.length;

  // Convert pixel expansion to normalized shift (separate X/Y for non-square canvases)
  const shiftX = expansion / w;
  const shiftY = expansion / h;

  const expanded = pts.filter(p => isFinite(p.x) && isFinite(p.y)).map(p => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
    const dirX = dx / dist;
    const dirY = dy / dist;
    const ofsX = dirX * shiftX;
    const ofsY = dirY * shiftY;
    return {
      x: p.x + ofsX,
      y: p.y + ofsY,
      inX: p.inX + ofsX,
      inY: p.inY + ofsY,
      outX: p.outX + ofsX,
      outY: p.outY + ofsY
    };
  });
  return { closed: path.closed, points: expanded };
}

// Resolve mask path at a given frame (interpolate path keyframes)
export function resolveMaskPath(mask, frame) {
  if (!mask.pathKeyframes || mask.pathKeyframes.length === 0) {
    return mask.path;
  }
  const kfs = mask.pathKeyframes;
  if (frame <= kfs[0].frame) return kfs[0].value;
  if (frame >= kfs[kfs.length - 1].frame) return kfs[kfs.length - 1].value;

  for (let i = 0; i < kfs.length - 1; i++) {
    if (frame >= kfs[i].frame && frame <= kfs[i + 1].frame) {
      const t = (frame - kfs[i].frame) / (kfs[i + 1].frame - kfs[i].frame);
      return interpolatePaths(kfs[i].value, kfs[i + 1].value, t);
    }
  }
  return kfs[kfs.length - 1].value;
}

// Resolve scalar mask params (feather, opacity, expansion) at a given frame
export function resolveMaskParams(mask, frame) {
  const base = { ...mask.params };
  if (!mask.keyframes) return base;

  for (const paramId of ['feather', 'opacity', 'expansion']) {
    const kfs = mask.keyframes[paramId];
    if (kfs && kfs.length > 0) {
      const val = keyframeEngine.getValueAtFrame(kfs, frame);
      if (val !== undefined) base[paramId] = val;
    }
  }
  return base;
}

// Interpolate two paths point-by-point (must have same point count)
function interpolatePaths(pathA, pathB, t) {
  const ptsA = pathA.points;
  const ptsB = pathB.points;

  // If point counts differ, snap at midpoint
  if (ptsA.length !== ptsB.length) {
    return t < 0.5 ? pathA : pathB;
  }

  const points = ptsA.map((a, i) => {
    const b = ptsB[i];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      inX: a.inX + (b.inX - a.inX) * t,
      inY: a.inY + (b.inY - a.inY) * t,
      outX: a.outX + (b.outX - a.outX) * t,
      outY: a.outY + (b.outY - a.outY) * t
    };
  });

  return { closed: pathA.closed, points };
}

// ---- Mask canvas pool (reuse OffscreenCanvas or regular canvas) ----
let _maskCanvas = null;
let _maskCtx = null;

function getMaskCanvas(w, h, isOffscreen) {
  if (!_maskCanvas || _maskCanvas._isOffscreen !== isOffscreen) {
    _maskCanvas = isOffscreen ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    _maskCanvas._isOffscreen = isOffscreen;
    _maskCtx = _maskCanvas.getContext('2d');
  }
  if (_maskCanvas.width !== w) _maskCanvas.width = w;
  if (_maskCanvas.height !== h) _maskCanvas.height = h;
  // Reset state on reuse to prevent stale mask data or canvas state bleeding through
  _maskCtx.clearRect(0, 0, w, h);
  _maskCtx.filter = 'none';
  _maskCtx.globalAlpha = 1;
  _maskCtx.globalCompositeOperation = 'source-over';
  return { canvas: _maskCanvas, ctx: _maskCtx };
}

// Composite mode mapping
const MODE_OPS = {
  add: 'source-over',
  subtract: 'destination-out',
  intersect: 'destination-in',
  difference: 'xor'
};

// Apply all clip masks to an offscreen canvas context.
// offCtx/offCanvas: the clip's composited pixel content.
// masks: resolved array of { path, params, enabled, inverted, mode }.
// canvasWidth, canvasHeight: sequence dimensions.
// isOffscreen: true when running in a Worker (use OffscreenCanvas).
export function applyClipMasks(offCtx, offCanvas, masks, canvasWidth, canvasHeight, isOffscreen = false) {
  if (!masks || masks.length === 0) return;

  const enabledMasks = masks.filter(m => m.enabled);
  if (enabledMasks.length === 0) return;

  const { canvas: maskCanvas, ctx: maskCtx } = getMaskCanvas(canvasWidth, canvasHeight, isOffscreen);
  maskCtx.clearRect(0, 0, canvasWidth, canvasHeight);

  for (let i = 0; i < enabledMasks.length; i++) {
    const mask = enabledMasks[i];
    const params = mask.resolvedParams || mask.params;
    const path = mask.resolvedPath || mask.path;

    if (!path || !path.points || path.points.length < 2) continue;

    const opacity = (params.opacity ?? 100) / 100;
    const feather = params.feather ?? 0;
    const expansion = params.expansion ?? 0;

    // Expand/contract path
    const expandedPath = applyExpansion(path, expansion, canvasWidth, canvasHeight);

    // Set composite mode for combining masks
    if (i === 0) {
      maskCtx.globalCompositeOperation = 'source-over';
    } else {
      maskCtx.globalCompositeOperation = MODE_OPS[mask.mode] || 'source-over';
    }

    // Apply feather via CSS filter blur
    if (feather > 0) {
      maskCtx.filter = `blur(${feather}px)`;
    } else {
      maskCtx.filter = 'none';
    }

    maskCtx.globalAlpha = opacity;

    // For inverted masks: draw filled rect first, then cut out the shape
    if (mask.inverted) {
      maskCtx.fillStyle = '#fff';
      maskCtx.fillRect(0, 0, canvasWidth, canvasHeight);
      maskCtx.globalCompositeOperation = 'destination-out';
      traceBezierPath(maskCtx, expandedPath, canvasWidth, canvasHeight);
      maskCtx.fillStyle = '#fff';
      maskCtx.fill();
    } else {
      traceBezierPath(maskCtx, expandedPath, canvasWidth, canvasHeight);
      maskCtx.fillStyle = '#fff';
      maskCtx.fill();
    }

    maskCtx.filter = 'none';
    maskCtx.globalAlpha = 1;
  }

  // Apply combined mask to clip content via destination-in
  offCtx.save();
  offCtx.globalCompositeOperation = 'destination-in';
  offCtx.drawImage(maskCanvas, 0, 0);
  offCtx.restore();
}

// Build resolved mask data for a clip at a given frame.
// Returns an array of resolved masks ready for applyClipMasks().
export function resolveClipMasks(clip, frame) {
  if (!clip.masks || clip.masks.length === 0) return null;

  return clip.masks.map(mask => ({
    ...mask,
    resolvedPath: resolveMaskPath(mask, frame),
    resolvedParams: resolveMaskParams(mask, frame)
  }));
}

export function resetMaskIds() {
  maskIdCounter = 0;
}

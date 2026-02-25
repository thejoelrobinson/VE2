// Roto Brush effect — stroke-based color-aware matting for rotoscoping.
// Users paint foreground (green) and background (red) brush strokes.
// The effect builds a trimap from strokes, estimates alpha via color models,
// then refines with a guided filter. Mattes propagate across frames.

import { effectRegistry } from './EffectRegistry.js';
import { keyframeEngine } from './KeyframeEngine.js';
import logger from '../../utils/logger.js';

// ---- Effect registration ----

effectRegistry.register({
  id: 'roto-brush',
  name: 'Roto Brush',
  category: 'Keying',
  type: 'video',
  isRoto: true,
  params: [
    { id: 'outputMode', name: 'Output', type: 'select', options: ['composite', 'alpha'], default: 'composite' },
    { id: 'viewMode', name: 'View', type: 'select', options: ['composite', 'matte', 'boundary', 'overlay'], default: 'composite' },
    { id: 'feather', name: 'Feather', type: 'range', min: 0, max: 200, default: 0, step: 0.5, unit: 'px' },
    { id: 'contrast', name: 'Contrast', type: 'range', min: 0, max: 100, default: 0, step: 1, unit: '%' },
    { id: 'shiftEdge', name: 'Shift Edge', type: 'range', min: -100, max: 100, default: 0, step: 0.5, unit: 'px' },
    { id: 'choke', name: 'Choke', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'refineRadius', name: 'Refine Radius', type: 'range', min: 1, max: 50, default: 8, step: 1, unit: 'px' },
    { id: 'strokes', name: 'Strokes', type: 'hidden', default: [] },
    { id: 'frozen', name: 'Frozen', type: 'hidden', default: false }
  ],
  apply(ctx, params) { /* no-op: roto is applied via applyRotoEffects */ }
});

// ---- Matte cache registry (maps effect instance ID → _matteCache Map) ----
// Populated by applyRotoEffects, queried by VideoCompositor for worker serialization.
const _matteCacheRegistry = new Map();

export function getMatteCacheForEffect(effectId) {
  return _matteCacheRegistry.get(effectId) || null;
}

// ---- Stroke factory ----

let strokeIdCounter = 0;

export function createStroke(frame, type, radius) {
  strokeIdCounter++;
  return {
    id: `roto-stroke-${strokeIdCounter}`,
    frame,
    type, // 'foreground' | 'background'
    points: [],
    radius: radius || 20
  };
}

// ---- Canvas pool (reuse temp canvases) ----

function _createPooledCanvas() {
  let _canvas = null;
  let _ctx = null;
  return function (w, h, isOffscreen) {
    if (!_canvas || _canvas._isOffscreen !== isOffscreen) {
      _canvas = isOffscreen ? new OffscreenCanvas(w, h) : document.createElement('canvas');
      _canvas._isOffscreen = isOffscreen;
      _ctx = _canvas.getContext('2d', { willReadFrequently: true });
    }
    if (_canvas.width !== w) _canvas.width = w;
    if (_canvas.height !== h) _canvas.height = h;
    return { canvas: _canvas, ctx: _ctx };
  };
}

const getRotoCanvas = _createPooledCanvas();
const getRotoCanvas2 = _createPooledCanvas();

// ---- Stroke rasterization ----

function _rasterizeStrokeType(strokes, w, h, ctx) {
  if (strokes.length === 0) return null;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const s of strokes) {
    ctx.lineWidth = s.radius * 2;
    ctx.beginPath();
    const p0 = s.points[0];
    ctx.moveTo(p0.x * w, p0.y * h);
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x * w, s.points[i].y * h);
    }
    if (s.points.length === 1) {
      ctx.arc(p0.x * w, p0.y * h, s.radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }

  const imgData = ctx.getImageData(0, 0, w, h);
  const pixels = imgData.data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    mask[i] = pixels[i * 4 + 3] > 128 ? 1 : 0;
  }
  return mask;
}

function rasterizeStrokes(strokes, frame, w, h, isOffscreen) {
  const fgStrokes = [];
  const bgStrokes = [];

  for (const s of strokes) {
    if (s.frame !== frame) continue;
    if (s.points.length === 0) continue;
    if (s.type === 'foreground') fgStrokes.push(s);
    else if (s.type === 'background') bgStrokes.push(s);
  }

  const { canvas, ctx } = getRotoCanvas2(w, h, isOffscreen);
  const fgMask = _rasterizeStrokeType(fgStrokes, w, h, ctx) || new Uint8Array(w * h);
  const bgMask = _rasterizeStrokeType(bgStrokes, w, h, ctx) || new Uint8Array(w * h);

  return { fgMask, bgMask };
}

// ---- Trimap builders ----

function buildTrimapFromStrokes(fgMask, bgMask, w, h, band) {
  const size = w * h;
  const trimap = new Uint8Array(size);
  const bandSq = band * band;

  // Dilate fgMask by band pixels
  const dilatedFg = new Uint8Array(size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (fgMask[idx]) {
        dilatedFg[idx] = 1;
        continue;
      }
      // Check if any fg pixel is within band distance
      const yMin = Math.max(0, y - band);
      const yMax = Math.min(h - 1, y + band);
      const xMin = Math.max(0, x - band);
      const xMax = Math.min(w - 1, x + band);
      let found = false;
      for (let sy = yMin; sy <= yMax && !found; sy++) {
        for (let sx = xMin; sx <= xMax && !found; sx++) {
          if (fgMask[sy * w + sx]) {
            const dx = sx - x;
            const dy = sy - y;
            if (dx * dx + dy * dy <= bandSq) {
              found = true;
            }
          }
        }
      }
      if (found) dilatedFg[idx] = 1;
    }
  }

  // Build trimap
  for (let i = 0; i < size; i++) {
    if (fgMask[i]) {
      trimap[i] = 255; // definite FG
    } else if (bgMask[i]) {
      trimap[i] = 0;   // definite BG
    } else if (dilatedFg[i]) {
      trimap[i] = 128;  // unknown (in dilated FG but not actual FG)
    } else {
      trimap[i] = 0;    // background
    }
  }

  return trimap;
}

function buildTrimapFromPrevMatte(prevMatte, w, h, band) {
  const size = w * h;
  const trimap = new Uint8Array(size);
  const bandSq = band * band;

  // First pass: classify based on matte values
  const isEdge = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const v = prevMatte[i];
    if (v > 0.9) {
      trimap[i] = 255;
    } else if (v < 0.1) {
      trimap[i] = 0;
    } else {
      trimap[i] = 128;
      isEdge[i] = 1;
    }
  }

  // Expand unknown band around the 0.1-0.9 edge region
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (trimap[idx] === 128) continue; // already unknown
      // Check if near an edge pixel
      const yMin = Math.max(0, y - band);
      const yMax = Math.min(h - 1, y + band);
      const xMin = Math.max(0, x - band);
      const xMax = Math.min(w - 1, x + band);
      let nearEdge = false;
      for (let sy = yMin; sy <= yMax && !nearEdge; sy++) {
        for (let sx = xMin; sx <= xMax && !nearEdge; sx++) {
          if (isEdge[sy * w + sx]) {
            const dx = sx - x;
            const dy = sy - y;
            if (dx * dx + dy * dy <= bandSq) {
              nearEdge = true;
            }
          }
        }
      }
      if (nearEdge) trimap[idx] = 128;
    }
  }

  return trimap;
}

// ---- Color-based alpha estimation (Mahalanobis distance) ----

function colorBasedAlpha(sourceImageData, trimap, w, h) {
  const src = sourceImageData.data;
  const size = w * h;
  const alpha = new Float32Array(size);

  // Collect foreground and background color samples from boundary pixels
  const fgColors = [];
  const bgColors = [];

  for (let i = 0; i < size; i++) {
    const tv = trimap[i];
    if (tv === 255) {
      alpha[i] = 1.0;
      // Check if near unknown zone (within 2px) for sampling
      const x = i % w;
      const y = (i - x) / w;
      let nearUnknown = false;
      for (let dy = -2; dy <= 2 && !nearUnknown; dy++) {
        for (let dx = -2; dx <= 2 && !nearUnknown; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            if (trimap[ny * w + nx] === 128) nearUnknown = true;
          }
        }
      }
      if (nearUnknown) {
        const off = i * 4;
        fgColors.push([src[off], src[off + 1], src[off + 2]]);
      }
    } else if (tv === 0) {
      alpha[i] = 0.0;
      // Check if near unknown zone for sampling
      const x = i % w;
      const y = (i - x) / w;
      let nearUnknown = false;
      for (let dy = -2; dy <= 2 && !nearUnknown; dy++) {
        for (let dx = -2; dx <= 2 && !nearUnknown; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            if (trimap[ny * w + nx] === 128) nearUnknown = true;
          }
        }
      }
      if (nearUnknown) {
        const off = i * 4;
        bgColors.push([src[off], src[off + 1], src[off + 2]]);
      }
    }
  }

  // Build color models (mean + inverse covariance for Mahalanobis)
  const fgModel = _buildColorModel(fgColors);
  const bgModel = _buildColorModel(bgColors);

  // If either model is degenerate, fall back to binary alpha
  if (!fgModel || !bgModel) {
    for (let i = 0; i < size; i++) {
      if (trimap[i] === 128) alpha[i] = 0.5;
    }
    return alpha;
  }

  // Classify unknown pixels
  for (let i = 0; i < size; i++) {
    if (trimap[i] !== 128) continue;

    const off = i * 4;
    const color = [src[off], src[off + 1], src[off + 2]];
    const dFg = _mahalanobisDistance(color, fgModel);
    const dBg = _mahalanobisDistance(color, bgModel);
    const denom = dFg + dBg;

    if (denom < 1e-6) {
      alpha[i] = 0.5;
    } else {
      alpha[i] = Math.min(1, Math.max(0, dBg / denom));
    }
  }

  return alpha;
}

// Build a color model: { mean: [r,g,b], invCov: 3x3 matrix }
function _buildColorModel(colors) {
  if (colors.length < 4) return null;

  // Compute mean
  const mean = [0, 0, 0];
  for (const c of colors) {
    mean[0] += c[0];
    mean[1] += c[1];
    mean[2] += c[2];
  }
  const n = colors.length;
  mean[0] /= n;
  mean[1] /= n;
  mean[2] /= n;

  // Compute covariance matrix (3x3 symmetric)
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]; // row-major 3x3
  for (const c of colors) {
    const d0 = c[0] - mean[0];
    const d1 = c[1] - mean[1];
    const d2 = c[2] - mean[2];
    cov[0] += d0 * d0;
    cov[1] += d0 * d1;
    cov[2] += d0 * d2;
    cov[3] += d1 * d0;
    cov[4] += d1 * d1;
    cov[5] += d1 * d2;
    cov[6] += d2 * d0;
    cov[7] += d2 * d1;
    cov[8] += d2 * d2;
  }
  for (let i = 0; i < 9; i++) cov[i] /= n;

  // Add small regularization to prevent singular matrix
  const reg = 1.0;
  cov[0] += reg;
  cov[4] += reg;
  cov[8] += reg;

  // Invert 3x3 matrix
  const invCov = _invert3x3(cov);
  if (!invCov) return null;

  return { mean, invCov };
}

// Invert a 3x3 matrix (row-major)
function _invert3x3(m) {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);

  if (Math.abs(det) < 1e-12) return null;

  const invDet = 1.0 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * invDet,
    (m[2] * m[7] - m[1] * m[8]) * invDet,
    (m[1] * m[5] - m[2] * m[4]) * invDet,
    (m[5] * m[6] - m[3] * m[8]) * invDet,
    (m[0] * m[8] - m[2] * m[6]) * invDet,
    (m[2] * m[3] - m[0] * m[5]) * invDet,
    (m[3] * m[7] - m[4] * m[6]) * invDet,
    (m[1] * m[6] - m[0] * m[7]) * invDet,
    (m[0] * m[4] - m[1] * m[3]) * invDet
  ];
}

// Mahalanobis distance: sqrt((c - mean)^T * invCov * (c - mean))
function _mahalanobisDistance(color, model) {
  const d0 = color[0] - model.mean[0];
  const d1 = color[1] - model.mean[1];
  const d2 = color[2] - model.mean[2];
  const inv = model.invCov;

  // (invCov * d)
  const r0 = inv[0] * d0 + inv[1] * d1 + inv[2] * d2;
  const r1 = inv[3] * d0 + inv[4] * d1 + inv[5] * d2;
  const r2 = inv[6] * d0 + inv[7] * d1 + inv[8] * d2;

  // d^T * (invCov * d)
  const val = d0 * r0 + d1 * r1 + d2 * r2;
  return Math.sqrt(Math.max(0, val));
}

// ---- Guided filter (O(N) via integral images) ----

function guidedFilter(alpha, guidance, w, h, radius, eps) {
  const size = w * h;
  const output = new Float32Array(size);

  // Build integral images for box filtering
  const intI = new Float64Array(size);   // integral of guidance (I)
  const intP = new Float64Array(size);   // integral of alpha (p)
  const intIP = new Float64Array(size);  // integral of I*p
  const intII = new Float64Array(size);  // integral of I*I

  // Fill integral images
  for (let y = 0; y < h; y++) {
    let rowI = 0, rowP = 0, rowIP = 0, rowII = 0;
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const iv = guidance[idx];
      const pv = alpha[idx];
      rowI += iv;
      rowP += pv;
      rowIP += iv * pv;
      rowII += iv * iv;

      const above = y > 0 ? (y - 1) * w + x : -1;
      intI[idx] = rowI + (above >= 0 ? intI[above] : 0);
      intP[idx] = rowP + (above >= 0 ? intP[above] : 0);
      intIP[idx] = rowIP + (above >= 0 ? intIP[above] : 0);
      intII[idx] = rowII + (above >= 0 ? intII[above] : 0);
    }
  }

  // Box sum helper using integral image
  const boxSum = (integral, x1, y1, x2, y2) => {
    x1 = Math.max(0, x1);
    y1 = Math.max(0, y1);
    x2 = Math.min(w - 1, x2);
    y2 = Math.min(h - 1, y2);
    let val = integral[y2 * w + x2];
    if (x1 > 0) val -= integral[y2 * w + (x1 - 1)];
    if (y1 > 0) val -= integral[(y1 - 1) * w + x2];
    if (x1 > 0 && y1 > 0) val += integral[(y1 - 1) * w + (x1 - 1)];
    return val;
  };

  // Compute a, b coefficients per pixel
  const aArr = new Float32Array(size);
  const bArr = new Float32Array(size);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = x - radius;
      const y1 = y - radius;
      const x2 = x + radius;
      const y2 = y + radius;

      // Count of pixels in the clamped box
      const cx1 = Math.max(0, x1);
      const cy1 = Math.max(0, y1);
      const cx2 = Math.min(w - 1, x2);
      const cy2 = Math.min(h - 1, y2);
      const count = (cx2 - cx1 + 1) * (cy2 - cy1 + 1);

      const meanI = boxSum(intI, x1, y1, x2, y2) / count;
      const meanP = boxSum(intP, x1, y1, x2, y2) / count;
      const meanIP = boxSum(intIP, x1, y1, x2, y2) / count;
      const meanII = boxSum(intII, x1, y1, x2, y2) / count;

      const varI = meanII - meanI * meanI;
      const covIP = meanIP - meanI * meanP;

      const idx = y * w + x;
      aArr[idx] = Math.max(-100, Math.min(100, covIP / (varI + eps)));
      bArr[idx] = meanP - aArr[idx] * meanI;
    }
  }

  // Build integral images for a and b, then compute mean_a, mean_b
  const intA = new Float64Array(size);
  const intB = new Float64Array(size);

  for (let y = 0; y < h; y++) {
    let rowA = 0, rowB = 0;
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      rowA += aArr[idx];
      rowB += bArr[idx];
      const above = y > 0 ? (y - 1) * w + x : -1;
      intA[idx] = rowA + (above >= 0 ? intA[above] : 0);
      intB[idx] = rowB + (above >= 0 ? intB[above] : 0);
    }
  }

  // Final output: mean_a * I + mean_b
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x1 = x - radius;
      const y1 = y - radius;
      const x2 = x + radius;
      const y2 = y + radius;

      const cx1 = Math.max(0, x1);
      const cy1 = Math.max(0, y1);
      const cx2 = Math.min(w - 1, x2);
      const cy2 = Math.min(h - 1, y2);
      const count = (cx2 - cx1 + 1) * (cy2 - cy1 + 1);

      const meanA = boxSum(intA, x1, y1, x2, y2) / count;
      const meanB = boxSum(intB, x1, y1, x2, y2) / count;

      const idx = y * w + x;
      output[idx] = Math.min(1, Math.max(0, meanA * guidance[idx] + meanB));
    }
  }

  return output;
}

// ---- Post-processing: choke ----

function applyChoke(alphaData, choke, w, h) {
  if (choke === 0) return;
  // Shift alpha: choke range -100..100 maps to -1..1 alpha shift
  const shift = choke / 100;
  const size = w * h;
  for (let i = 0; i < size; i++) {
    alphaData[i] = Math.min(1, Math.max(0, alphaData[i] + shift));
  }
}

// ---- Post-processing: shift edge (dilate/erode) ----

function applyShiftEdge(alphaData, shiftEdge, w, h) {
  if (shiftEdge === 0) return;
  const radius = Math.abs(Math.round(shiftEdge));
  if (radius === 0) return;

  const size = w * h;
  const result = new Float32Array(size);
  const isExpand = shiftEdge > 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const yMin = Math.max(0, y - radius);
      const yMax = Math.min(h - 1, y + radius);
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(w - 1, x + radius);

      let val = isExpand ? 0 : 1;
      for (let sy = yMin; sy <= yMax; sy++) {
        for (let sx = xMin; sx <= xMax; sx++) {
          const sv = alphaData[sy * w + sx];
          if (isExpand) {
            if (sv > val) val = sv; // max filter = dilate
          } else {
            if (sv < val) val = sv; // min filter = erode
          }
        }
      }
      result[y * w + x] = val;
    }
  }

  // Copy result back
  for (let i = 0; i < size; i++) {
    alphaData[i] = result[i];
  }
}

// ---- Post-processing: contrast (sigmoid) ----

function applyContrast(alphaData, contrast, w, h) {
  if (contrast === 0) return;
  // contrast 0-100 maps to sigmoid steepness k = 1..20
  const k = 1 + contrast * 0.19;
  const size = w * h;
  for (let i = 0; i < size; i++) {
    alphaData[i] = 1 / (1 + Math.exp(-k * (alphaData[i] - 0.5)));
  }
}

// ---- Post-processing: remove small disconnected islands ----

function removeSmallIslands(alphaData, w, h, minAreaFraction) {
  const size = w * h;
  const minArea = Math.max(1, Math.round(size * (minAreaFraction || 0.005)));

  // Threshold to binary
  const binary = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    binary[i] = alphaData[i] > 0.3 ? 1 : 0;
  }

  // Flood-fill connected components
  const labels = new Int32Array(size); // 0 = unlabeled
  const componentSizes = [0]; // index 0 unused (labels start at 1)
  let nextLabel = 1;
  const stack = [];

  for (let i = 0; i < size; i++) {
    if (binary[i] === 0 || labels[i] !== 0) continue;

    const label = nextLabel++;
    let area = 0;
    stack.push(i);

    while (stack.length > 0) {
      const idx = stack.pop();
      if (labels[idx] !== 0) continue;
      if (binary[idx] === 0) continue;

      labels[idx] = label;
      area++;

      const x = idx % w;
      const y = (idx - x) / w;

      // Guard before pushing: skip already-labeled or background pixels
      // to prevent stack bloat (4x pixel count at 4K without guards)
      if (x > 0 && labels[idx - 1] === 0 && binary[idx - 1]) stack.push(idx - 1);
      if (x < w - 1 && labels[idx + 1] === 0 && binary[idx + 1]) stack.push(idx + 1);
      if (y > 0 && labels[idx - w] === 0 && binary[idx - w]) stack.push(idx - w);
      if (y < h - 1 && labels[idx + w] === 0 && binary[idx + w]) stack.push(idx + w);
    }

    componentSizes.push(area);
  }

  if (componentSizes.length <= 1) return; // no components at all

  // Find the largest component
  let maxLabel = 1;
  let maxArea = componentSizes[1] || 0;
  for (let l = 2; l < componentSizes.length; l++) {
    if (componentSizes[l] > maxArea) {
      maxArea = componentSizes[l];
      maxLabel = l;
    }
  }

  // Zero out pixels in small components
  for (let i = 0; i < size; i++) {
    if (labels[i] !== 0 && labels[i] !== maxLabel && componentSizes[labels[i]] < minArea) {
      alphaData[i] = 0;
    }
  }
}

// ---- Post-processing: morphological open (erode + dilate) ----

function morphologicalOpen(alphaData, w, h, radius) {
  if (!radius || radius < 1) radius = 1;
  const size = w * h;

  // Erode (min filter)
  const eroded = new Float32Array(size);
  for (let y = 0; y < h; y++) {
    const yMin = Math.max(0, y - radius);
    const yMax = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(w - 1, x + radius);
      let minVal = 1;
      for (let sy = yMin; sy <= yMax; sy++) {
        for (let sx = xMin; sx <= xMax; sx++) {
          const v = alphaData[sy * w + sx];
          if (v < minVal) minVal = v;
        }
      }
      eroded[y * w + x] = minVal;
    }
  }

  // Dilate (max filter) on eroded result
  for (let y = 0; y < h; y++) {
    const yMin = Math.max(0, y - radius);
    const yMax = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(w - 1, x + radius);
      let maxVal = 0;
      for (let sy = yMin; sy <= yMax; sy++) {
        for (let sx = xMin; sx <= xMax; sx++) {
          const v = eroded[sy * w + sx];
          if (v > maxVal) maxVal = v;
        }
      }
      alphaData[y * w + x] = maxVal;
    }
  }
}

// ---- Main entry point: apply roto effects to clip ----

export function applyRotoEffects(offCtx, offCanvas, rotoEffects, frame, w, h, isOffscreen) {
  if (!rotoEffects || rotoEffects.length === 0) return;

  // Normalize format: main thread passes { fx, def, params }, worker passes { effectId, resolvedParams }
  const normalizedEffects = [];
  for (const entry of rotoEffects) {
    const params = entry.params || entry.resolvedParams || {};
    const strokes = params.strokes;
    // Need strokes, MediaPipe masks, or a matte cache to proceed
    const hasSegMasks = params._segMasks && params._segMasks.size > 0;
    const hasMatteCache = params._matteCache && params._matteCache.size > 0;
    if ((!strokes || strokes.length === 0) && !hasMatteCache && !hasSegMasks) continue;
    normalizedEffects.push(params);
    // Register matte cache for lookup by VideoCompositor (main thread path only)
    const fxId = entry.fx?.id || entry.id;
    if (fxId && params._matteCache) {
      _matteCacheRegistry.set(fxId, params._matteCache);
    }
  }
  if (normalizedEffects.length === 0) return;

  // Lazy-compute source image data and guidance — only when the trimap fallback
  // actually needs them. MediaPipe masks and cached mattes don't need getImageData.
  // This prevents expensive pixel reads during ConformEncoder background encoding.
  let _sourceImageData = null;
  let _guidance = null;
  const getSourceData = () => {
    if (!_sourceImageData) {
      _sourceImageData = offCtx.getImageData(0, 0, w, h);
      _guidance = new Float32Array(w * h);
      const srcData = _sourceImageData.data;
      for (let i = 0; i < w * h; i++) {
        const off = i * 4;
        _guidance[i] = (0.2989 * srcData[off] + 0.587 * srcData[off + 1] + 0.114 * srcData[off + 2]) / 255;
      }
    }
    return { sourceImageData: _sourceImageData, guidance: _guidance };
  };

  // Accumulate combined matte across all effects
  const { canvas: matteCanvas, ctx: matteCtx } = getRotoCanvas(w, h, isOffscreen);
  matteCtx.clearRect(0, 0, w, h);

  let hasMatte = false;
  let outputMode = 'composite';
  let viewMode = 'composite';

  for (const params of normalizedEffects) {
    outputMode = params.outputMode || 'composite';
    viewMode = params.viewMode || 'composite';

    const strokes = params.strokes || [];
    const frozen = params.frozen || false;
    const refineRadius = params.refineRadius ?? 8;
    const feather = params.feather ?? 0;
    const contrast = params.contrast ?? 0;
    const shiftEdge = params.shiftEdge ?? 0;
    const choke = params.choke ?? 0;

    // Initialize matte cache if needed (runtime-only, not serialized)
    if (!params._matteCache) {
      params._matteCache = new Map();
    }
    const cache = params._matteCache;

    let matte = null;
    let matteFromSegmenter = false;

    // Priority 1: MediaPipe AI mask (best quality, from SegmentationManager)
    // Check both Map format (main thread) and plain Float32Array (worker path)
    const frameHasStrokes = strokes.some(s => s.frame === frame);
    // Check if MediaPipe segmenter has been used on this effect (any frame has a mask).
    // If so, skip the trimap fallback for frames where segmenter hasn't processed yet.
    const segActive = (params._segMasks && params._segMasks.size > 0) ||
                      params._segMaskForFrame != null;

    if (params._segMaskForFrame) {
      // Worker path: single mask for this frame (plain Float32Array, not a Map)
      matte = params._segMaskForFrame;
      matteFromSegmenter = true;
    } else if (params._segMasks && params._segMasks.has && params._segMasks.has(frame)) {
      // Main thread path: Map of frame → mask (includes propagated/tracked frames)
      matte = params._segMasks.get(frame);
      matteFromSegmenter = true;
    }
    // Priority 2: Worker path cached matte for this frame
    else if (params._matteCacheForFrame) {
      matte = params._matteCacheForFrame;
    }
    // Priority 3: Cached matte (frozen mode, main thread)
    else if (cache.has(frame) && frozen) {
      matte = cache.get(frame);
    }
    // Priority 4: If segmenter is ready but hasn't processed this frame yet, skip
    // (MediaPipe is async — the mask will arrive shortly via _requestSegmentation).
    // Don't fall through to the trimap fallback which produces poor results.
    else if (segActive && frameHasStrokes) {
      // Segmenter is processing this frame — render clip without matte until mask arrives
      continue;
    }
    // Priority 5: Compute from strokes (trimap + color model fallback — only when segmenter unavailable)
    else {
      const frameStrokes = strokes.filter(s => s.frame === frame);

      if (frameStrokes.length > 0) {
        // Base frame: compute matte from strokes (trimap fallback — only when segmenter unavailable)
        const { sourceImageData, guidance } = getSourceData();
        const { fgMask, bgMask } = rasterizeStrokes(strokes, frame, w, h, isOffscreen);
        const trimap = buildTrimapFromStrokes(fgMask, bgMask, w, h, refineRadius);
        matte = colorBasedAlpha(sourceImageData, trimap, w, h);

        const gfRadius = Math.max(1, Math.round(refineRadius / 2));
        const gfEps = 0.01;
        matte = guidedFilter(matte, guidance, w, h, gfRadius, gfEps);

        cache.set(frame, matte);
      } else if (cache.has(frame - 1) || cache.has(frame + 1) ||
                 (params._segMasks && params._segMasks.has && (params._segMasks.has(frame - 1) || params._segMasks.has(frame + 1)))) {
        // Propagation: use nearest adjacent frame's matte as trimap seed
        const { sourceImageData, guidance } = getSourceData();
        const prevMatte = cache.get(frame - 1) || cache.get(frame + 1) ||
          (params._segMasks && params._segMasks.has && (params._segMasks.get(frame - 1) || params._segMasks.get(frame + 1)));
        const trimap = buildTrimapFromPrevMatte(prevMatte, w, h, refineRadius);
        matte = colorBasedAlpha(sourceImageData, trimap, w, h);

        const gfRadius = Math.max(1, Math.round(refineRadius / 2));
        const gfEps = 0.01;
        matte = guidedFilter(matte, guidance, w, h, gfRadius, gfEps);

        cache.set(frame, matte);
      } else if (cache.has(frame)) {
        // Use existing cached matte (non-frozen re-read)
        matte = cache.get(frame);
      }
    }

    if (!matte) continue;

    // Clone matte for post-processing (don't modify cached version)
    let processedMatte = new Float32Array(matte);

    // Apply guided filter to MediaPipe masks (trimap path already has it)
    if (matteFromSegmenter) {
      const { sourceImageData, guidance } = getSourceData();
      const gfRadius = Math.max(2, Math.round(refineRadius / 2));
      processedMatte = guidedFilter(processedMatte, guidance, w, h, gfRadius, 0.01);
    }

    // Remove small disconnected islands (0.5% of total pixels)
    removeSmallIslands(processedMatte, w, h, 0.005);

    // Morphological open: erode + dilate to remove thin noise/tendrils
    morphologicalOpen(processedMatte, w, h, 1);

    // Apply post-processing
    applyChoke(processedMatte, choke, w, h);
    applyShiftEdge(processedMatte, shiftEdge, w, h);
    applyContrast(processedMatte, contrast, w, h);

    // Convert to ImageData
    const alphaImageData = matteCtx.createImageData(w, h);
    const alphaPixels = alphaImageData.data;
    for (let i = 0; i < w * h; i++) {
      const a = Math.round(processedMatte[i] * 255);
      alphaPixels[i * 4] = 255;     // R
      alphaPixels[i * 4 + 1] = 255; // G
      alphaPixels[i * 4 + 2] = 255; // B
      alphaPixels[i * 4 + 3] = a;   // A
    }

    // Draw matte onto temp canvas, then composite with feather
    const { canvas: tempCanvas, ctx: tempCtx } = getRotoCanvas2(w, h, isOffscreen);
    tempCtx.clearRect(0, 0, w, h);
    tempCtx.putImageData(alphaImageData, 0, 0);

    // Minimum 0.5px feather for subtle anti-aliasing even when user feather is 0
    const effectiveFeather = Math.max(0.5, feather);
    matteCtx.filter = `blur(${effectiveFeather}px)`;

    matteCtx.globalCompositeOperation = 'source-over';
    matteCtx.drawImage(tempCanvas, 0, 0);
    matteCtx.filter = 'none';
    hasMatte = true;
  }

  if (!hasMatte) return;

  // Handle view modes
  if (viewMode === 'matte') {
    // Draw black-and-white matte visualization
    offCtx.clearRect(0, 0, w, h);
    offCtx.fillStyle = '#000';
    offCtx.fillRect(0, 0, w, h);
    offCtx.globalCompositeOperation = 'source-over';
    offCtx.drawImage(matteCanvas, 0, 0);
    return;
  }

  if (viewMode === 'boundary') {
    // Draw original with green contour at alpha=0.5
    const { sourceImageData: srcData } = getSourceData();
    offCtx.putImageData(srcData, 0, 0);
    const matteData = matteCtx.getImageData(0, 0, w, h);
    const mPixels = matteData.data;
    offCtx.save();
    offCtx.fillStyle = '#00ff00';
    // Find contour: pixels where alpha is near 0.5 and gradient is steep
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x;
        const a = mPixels[idx * 4 + 3] / 255;
        if (a < 0.3 || a > 0.7) continue;
        // Check if at boundary via neighbor gradient
        const aL = mPixels[(idx - 1) * 4 + 3] / 255;
        const aR = mPixels[(idx + 1) * 4 + 3] / 255;
        const aU = mPixels[(idx - w) * 4 + 3] / 255;
        const aD = mPixels[(idx + w) * 4 + 3] / 255;
        const diff = Math.abs(aL - aR) + Math.abs(aU - aD);
        if (diff > 0.2) {
          offCtx.fillRect(x, y, 1, 1);
        }
      }
    }
    offCtx.restore();
    return;
  }

  if (viewMode === 'overlay') {
    // Show original with red/magenta overlay on BG areas
    const { sourceImageData: srcData2 } = getSourceData();
    offCtx.putImageData(srcData2, 0, 0);
    const matteData = matteCtx.getImageData(0, 0, w, h);
    const mPixels = matteData.data;
    const overlayData = offCtx.getImageData(0, 0, w, h);
    const oPixels = overlayData.data;
    for (let i = 0; i < w * h; i++) {
      const a = mPixels[i * 4 + 3] / 255;
      if (a < 0.5) {
        // Blend with red overlay
        const blend = 0.4 * (1 - a * 2);
        const off = i * 4;
        oPixels[off] = Math.min(255, oPixels[off] + 120 * blend);     // R
        oPixels[off + 1] = Math.round(oPixels[off + 1] * (1 - blend * 0.5)); // G
        oPixels[off + 2] = Math.round(oPixels[off + 2] * (1 - blend * 0.5)); // B
      }
    }
    offCtx.putImageData(overlayData, 0, 0);
    return;
  }

  // Composite / alpha output modes
  if (outputMode === 'alpha') {
    offCtx.save();
    offCtx.globalCompositeOperation = 'multiply';
    offCtx.drawImage(matteCanvas, 0, 0);
    offCtx.restore();
  } else {
    // Standard destination-in: clip content to matte shape
    offCtx.save();
    offCtx.globalCompositeOperation = 'destination-in';
    offCtx.drawImage(matteCanvas, 0, 0);
    offCtx.restore();
  }
}

// Pure utility functions for Lumetri curve LUT generation
// No DOM or GL dependencies — usable in workers
import { clamp } from '../core/MathUtils.js';

/**
 * Monotone cubic Hermite interpolation of control points into a LUT.
 * @param {Array<[number,number]>} points - sorted by x, values in [0,1]
 * @param {number} size - LUT resolution (default 256)
 * @returns {Float32Array} LUT of `size` entries, values in [0,1]
 */
export function controlPointsToLUT(points, size = 256) {
  const lut = new Float32Array(size);

  // Identity if fewer than 2 points
  if (!points || points.length < 2) {
    for (let i = 0; i < size; i++) lut[i] = i / (size - 1);
    return lut;
  }

  // Sort by x
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const n = sorted.length;
  const xs = sorted.map(p => p[0]);
  const ys = sorted.map(p => p[1]);

  // Compute tangents (Fritsch-Carlson monotone cubic)
  const deltas = new Float32Array(n - 1);
  const m = new Float32Array(n);

  for (let i = 0; i < n - 1; i++) {
    deltas[i] = (ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-6);
  }

  m[0] = deltas[0];
  m[n - 1] = deltas[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (deltas[i - 1] * deltas[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (deltas[i - 1] + deltas[i]) / 2;
    }
  }

  // Enforce monotonicity
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(deltas[i]) < 1e-6) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const alpha = m[i] / deltas[i];
      const beta = m[i + 1] / deltas[i];
      const mag = alpha * alpha + beta * beta;
      if (mag > 9) {
        const tau = 3 / Math.sqrt(mag);
        m[i] = tau * alpha * deltas[i];
        m[i + 1] = tau * beta * deltas[i];
      }
    }
  }

  // Sample the spline
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);

    // Clamp to endpoints
    if (x <= xs[0]) { lut[i] = ys[0]; continue; }
    if (x >= xs[n - 1]) { lut[i] = ys[n - 1]; continue; }

    // Find segment
    let seg = 0;
    for (let j = 0; j < n - 1; j++) {
      if (x >= xs[j] && x < xs[j + 1]) { seg = j; break; }
    }

    const h = xs[seg + 1] - xs[seg];
    const t = (x - xs[seg]) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    // Hermite basis
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    lut[i] = clamp(
      h00 * ys[seg] + h10 * h * m[seg] +
      h01 * ys[seg + 1] + h11 * h * m[seg + 1],
      0, 1
    );
  }

  return lut;
}

/**
 * Pack 4 curve LUTs (master, R, G, B) into a single RGBA Uint8Array.
 * Suitable for uploading as a 256x1 RGBA texture.
 * @param {Array<[number,number]>} master
 * @param {Array<[number,number]>} red
 * @param {Array<[number,number]>} green
 * @param {Array<[number,number]>} blue
 * @returns {Uint8Array} 256*4 bytes (RGBA)
 */
export function buildCurveLUTTexture(master, red, green, blue) {
  const size = 256;
  const mLut = controlPointsToLUT(master, size);
  const rLut = controlPointsToLUT(red, size);
  const gLut = controlPointsToLUT(green, size);
  const bLut = controlPointsToLUT(blue, size);

  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const base = i * 4;
    // Apply master to each channel, then per-channel curve
    const mVal = mLut[i];
    const mIdx = Math.min(255, Math.round(mVal * 255));
    data[base] = Math.round(rLut[mIdx] * 255);      // R
    data[base + 1] = Math.round(gLut[mIdx] * 255);  // G
    data[base + 2] = Math.round(bLut[mIdx] * 255);  // B
    data[base + 3] = 255;                             // A (unused)
  }
  return data;
}

/**
 * Build HSL-domain curve LUTs packed into Uint8Array.
 * 256x5 rows: hueVsSat, hueVsHue, hueVsLuma, lumaVsSat, satVsSat
 * Each row is 256 entries, stored as single channel (R) in consecutive bytes.
 * Values represent offset from identity: 0=no change (stored as 128), range [-1,1] mapped to [0,255]
 * @returns {Uint8Array} 256*5 bytes
 */
export function buildHSLCurveLUT(hueVsSat, hueVsHue, hueVsLuma, lumaVsSat, satVsSat) {
  const size = 256;
  const curves = [hueVsSat, hueVsHue, hueVsLuma, lumaVsSat, satVsSat];
  const data = new Uint8Array(size * 5);

  for (let c = 0; c < 5; c++) {
    const points = curves[c];
    if (!points || points.length < 2) {
      // Identity: no adjustment (128 = 0 offset)
      for (let i = 0; i < size; i++) {
        data[c * size + i] = 128;
      }
    } else {
      const lut = controlPointsToLUT(points, size);
      for (let i = 0; i < size; i++) {
        // Convert from [0,1] curve output to offset [-0.5,0.5] mapped to [0,255]
        // Identity line is y=x/(size-1), offset = lut[i] - i/(size-1)
        const identity = i / (size - 1);
        const offset = lut[i] - identity;
        data[c * size + i] = Math.round(clamp((offset + 0.5) * 255, 0, 255));
      }
    }
  }

  return data;
}

export default { controlPointsToLUT, buildCurveLUTTexture, buildHSLCurveLUT };

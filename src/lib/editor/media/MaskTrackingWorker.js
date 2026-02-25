// Mask Tracking Worker — Pyramidal Lucas-Kanade sparse optical flow.
// @ts-check
// Receives mask point positions and sequential frame pairs as ImageBitmaps.
// Returns tracked point positions with confidence scores per frame.

// ---- Worker Message Protocol (JSDoc) ----

/**
 * @typedef {object} MTW_Point
 * @property {number} x - X position in pixel coordinates
 * @property {number} y - Y position in pixel coordinates
 */

/**
 * @typedef {object} MTW_TrackRequest
 * @property {'track'} type
 * @property {MTW_Point[]} points - Initial mask point positions
 * @property {number} frameWidth - Source frame width in pixels
 * @property {number} frameHeight - Source frame height in pixels
 */

/**
 * @typedef {object} MTW_FrameRequest
 * @property {'frame'} type
 * @property {ImageBitmap} bitmap - Current frame to track against previous
 * @property {number} frameIndex - Timeline frame index
 * Transfer list: [bitmap] (zero-copy transfer)
 */

/**
 * @typedef {object} MTW_CancelRequest
 * @property {'cancel'} type
 */

/**
 * @typedef {object} MTW_StopRequest
 * @property {'stop'} type
 */

/** @typedef {MTW_TrackRequest | MTW_FrameRequest | MTW_CancelRequest | MTW_StopRequest} MTW_Request */

/**
 * @typedef {object} MTW_TrackStartedResponse
 * @property {'track_started'} type
 */

/**
 * @typedef {object} MTW_FrameProcessedResponse
 * @property {'frame_processed'} type
 * @property {number} frameIndex
 */

/**
 * @typedef {object} MTW_TrackedPoint
 * @property {number} x - Tracked X position in original resolution
 * @property {number} y - Tracked Y position in original resolution
 * @property {number} confidence - Tracking confidence [0, 1]
 */

/**
 * @typedef {object} MTW_TrackedResponse
 * @property {'tracked'} type
 * @property {number} frameIndex
 * @property {MTW_TrackedPoint[]} points - Tracked point results
 */

/**
 * @typedef {object} MTW_CancelledResponse
 * @property {'cancelled'} type
 */

/**
 * @typedef {object} MTW_StoppedResponse
 * @property {'stopped'} type
 */

/**
 * @typedef {object} MTW_ErrorResponse
 * @property {'error'} type
 * @property {string} message
 * @property {number} [frameIndex]
 */

/** @typedef {MTW_TrackStartedResponse | MTW_FrameProcessedResponse | MTW_TrackedResponse | MTW_CancelledResponse | MTW_StoppedResponse | MTW_ErrorResponse} MTW_Response */

const PYRAMID_LEVELS = 3;
const WINDOW_SIZE = 21; // 21x21 pixel window
const HALF_WIN = Math.floor(WINDOW_SIZE / 2);
const MAX_ITERATIONS = 20;
const CONVERGENCE_THRESHOLD = 0.01;
const MIN_EIGENVALUE = 1e-4;

let tracking = false;
let cancelled = false;

// ---- Image processing helpers ----

function toGrayscale(bitmap, targetWidth) {
  const canvas = new OffscreenCanvas(
    targetWidth,
    Math.round(bitmap.height * (targetWidth / bitmap.width))
  );
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Float32Array(canvas.width * canvas.height);
  const d = imageData.data;
  for (let i = 0; i < gray.length; i++) {
    const j = i * 4;
    gray[i] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
  }
  return { data: gray, width: canvas.width, height: canvas.height };
}

// Build Gaussian pyramid (3 levels)
function buildPyramid(image) {
  const levels = [image];
  for (let l = 1; l < PYRAMID_LEVELS; l++) {
    const prev = levels[l - 1];
    const w = Math.max(1, Math.floor(prev.width / 2));
    const h = Math.max(1, Math.floor(prev.height / 2));
    const data = new Float32Array(w * h);

    // Simple 2x2 box filter downscale
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = x * 2;
        const sy = y * 2;
        let sum = 0;
        let count = 0;
        for (let dy = 0; dy < 2 && sy + dy < prev.height; dy++) {
          for (let dx = 0; dx < 2 && sx + dx < prev.width; dx++) {
            sum += prev.data[(sy + dy) * prev.width + (sx + dx)];
            count++;
          }
        }
        data[y * w + x] = sum / count;
      }
    }
    levels.push({ data, width: w, height: h });
  }
  return levels;
}

// Bilinear sample from grayscale image with clamped borders
function sample(img, x, y) {
  // Clamp to image bounds (avoids false edges at borders)
  const cx = Math.max(0, Math.min(img.width - 1.001, x));
  const cy = Math.max(0, Math.min(img.height - 1.001, y));

  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);

  const fx = cx - x0;
  const fy = cy - y0;

  const v00 = img.data[y0 * img.width + x0];
  const v10 = img.data[y0 * img.width + x1];
  const v01 = img.data[y1 * img.width + x0];
  const v11 = img.data[y1 * img.width + x1];

  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

// ---- Lucas-Kanade tracker ----

// Track a single point from imgA to imgB using pyramidal LK.
// Returns { x, y, confidence }
function trackPoint(pyramidA, pyramidB, px, py) {
  // Start from coarsest level
  let dx = 0,
    dy = 0;

  for (let level = PYRAMID_LEVELS - 1; level >= 0; level--) {
    const imgA = pyramidA[level];
    const imgB = pyramidB[level];
    const scale = Math.pow(2, level);

    // Point position at this pyramid level
    const lx = px / scale;
    const ly = py / scale;

    // Compute spatial gradients in window around (lx, ly) in imgA
    let sumIxIx = 0,
      sumIxIy = 0,
      sumIyIy = 0;
    let sumIxIt = 0,
      sumIyIt = 0;

    for (let wy = -HALF_WIN; wy <= HALF_WIN; wy++) {
      for (let wx = -HALF_WIN; wx <= HALF_WIN; wx++) {
        const sx = lx + wx;
        const sy = ly + wy;

        // Spatial gradients (Sobel-like central difference)
        const Ix = (sample(imgA, sx + 1, sy) - sample(imgA, sx - 1, sy)) / 2;
        const Iy = (sample(imgA, sx, sy + 1) - sample(imgA, sx, sy - 1)) / 2;

        sumIxIx += Ix * Ix;
        sumIxIy += Ix * Iy;
        sumIyIy += Iy * Iy;
      }
    }

    // Check if the structure tensor is invertible
    const det = sumIxIx * sumIyIy - sumIxIy * sumIxIy;
    const trace = sumIxIx + sumIyIy;
    const minEig = (trace - Math.sqrt(Math.max(0, trace * trace - 4 * det))) / 2;

    if (minEig < MIN_EIGENVALUE || Math.abs(det) < 1e-10) {
      // Point is in a flat region — can't track reliably
      continue;
    }

    const invDet = 1 / det;

    // Iterative refinement
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      sumIxIt = 0;
      sumIyIt = 0;

      for (let wy = -HALF_WIN; wy <= HALF_WIN; wy++) {
        for (let wx = -HALF_WIN; wx <= HALF_WIN; wx++) {
          const sx = lx + wx;
          const sy = ly + wy;

          const Ix = (sample(imgA, sx + 1, sy) - sample(imgA, sx - 1, sy)) / 2;
          const Iy = (sample(imgA, sx, sy + 1) - sample(imgA, sx, sy - 1)) / 2;

          // Temporal gradient: difference between imgB at displaced position and imgA
          const It = sample(imgB, sx + dx, sy + dy) - sample(imgA, sx, sy);

          sumIxIt += Ix * It;
          sumIyIt += Iy * It;
        }
      }

      // Solve 2x2 system: [IxIx IxIy; IxIy IyIy] * [ddx; ddy] = -[IxIt; IyIt]
      const ddx = -(sumIyIy * sumIxIt - sumIxIy * sumIyIt) * invDet;
      const ddy = -(sumIxIx * sumIyIt - sumIxIy * sumIxIt) * invDet;

      dx += ddx;
      dy += ddy;

      if (Math.abs(ddx) < CONVERGENCE_THRESHOLD && Math.abs(ddy) < CONVERGENCE_THRESHOLD) {
        break;
      }
    }

    // Scale displacement for next (finer) level
    if (level > 0) {
      dx *= 2;
      dy *= 2;
    }
  }

  // Confidence: based on minimum eigenvalue of structure tensor at finest level
  const imgA = pyramidA[0];
  let sumII = 0,
    sumIJ = 0,
    sumJJ = 0;
  for (let wy = -HALF_WIN; wy <= HALF_WIN; wy++) {
    for (let wx = -HALF_WIN; wx <= HALF_WIN; wx++) {
      const sx = px + wx;
      const sy = py + wy;
      const Ix = (sample(imgA, sx + 1, sy) - sample(imgA, sx - 1, sy)) / 2;
      const Iy = (sample(imgA, sx, sy + 1) - sample(imgA, sx, sy - 1)) / 2;
      sumII += Ix * Ix;
      sumIJ += Ix * Iy;
      sumJJ += Iy * Iy;
    }
  }
  const d = sumII * sumJJ - sumIJ * sumIJ;
  const t = sumII + sumJJ;
  const minEigFinal = (t - Math.sqrt(Math.max(0, t * t - 4 * d))) / 2;
  const confidence = Math.min(1, minEigFinal / 100); // Normalize to 0-1

  return { x: px + dx, y: py + dy, confidence };
}

// ---- Message handler ----

self.onmessage = e => {
  const { type } = e.data;

  if (type === 'track') {
    const { points, frameWidth, frameHeight } = e.data;
    // points: array of { x, y } in pixel coords
    tracking = true;
    cancelled = false;

    // Store current points
    self._currentPoints = points.map(p => ({ ...p }));
    self._trackWidth = Math.min(480, frameWidth);
    self._scaleRatio = self._trackWidth / frameWidth;
    self._prevPyramid = null;

    self.postMessage({ type: 'track_started' });
    return;
  }

  if (type === 'frame') {
    if (!tracking || cancelled) {
      // Still close the bitmap to prevent memory leak
      if (e.data.bitmap) e.data.bitmap.close();
      return;
    }

    const { bitmap, frameIndex } = e.data;

    try {
      // Convert to grayscale at tracking resolution
      const gray = toGrayscale(bitmap, self._trackWidth);
      const pyramid = buildPyramid(gray);

      // Close the bitmap to free memory
      bitmap.close();

      if (!self._prevPyramid) {
        // First frame — just store
        self._prevPyramid = pyramid;
        self.postMessage({ type: 'frame_processed', frameIndex });
        return;
      }

      // Track each point
      const results = [];
      for (const pt of self._currentPoints) {
        // Scale point to tracking resolution
        const sx = pt.x * self._scaleRatio;
        const sy = pt.y * self._scaleRatio;

        const tracked = trackPoint(self._prevPyramid, pyramid, sx, sy);

        // Scale back to original resolution
        const newX = tracked.x / self._scaleRatio;
        const newY = tracked.y / self._scaleRatio;

        results.push({
          x: newX,
          y: newY,
          confidence: tracked.confidence
        });
      }

      // Update current points for next frame
      self._currentPoints = results.map(r => ({ x: r.x, y: r.y }));
      self._prevPyramid = pyramid;

      self.postMessage({
        type: 'tracked',
        frameIndex,
        points: results
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message, frameIndex });
    }
    return;
  }

  if (type === 'cancel') {
    cancelled = true;
    tracking = false;
    self._prevPyramid = null;
    self._currentPoints = null;
    self.postMessage({ type: 'cancelled' });
    return;
  }

  if (type === 'stop') {
    tracking = false;
    self._prevPyramid = null;
    self._currentPoints = null;
    self.postMessage({ type: 'stopped' });
    return;
  }
};

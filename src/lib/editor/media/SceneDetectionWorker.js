// Web Worker for scene edit detection via histogram comparison
// @ts-check
// Single-pass: decode all frames, analyze every Nth, batched GOP reads + flushes

// ---- Worker Message Protocol (JSDoc) ----

/**
 * @typedef {object} SDW_SampleMeta
 * @property {'key'|'delta'} type - Whether this sample is a keyframe
 * @property {number} offset - Byte offset in file
 * @property {number} size - Sample size in bytes
 * @property {number} timestamp - Presentation timestamp (microseconds)
 * @property {number} duration - Sample duration (microseconds)
 */

/**
 * @typedef {object} SDW_AnalyzeRequest
 * @property {'analyze'} type
 * @property {File} file - Source video file handle
 * @property {object} codecConfig - VideoDecoder configuration (codec, description, etc.)
 * @property {SDW_SampleMeta[]} samples - All sample metadata from demuxer
 * @property {number} fps - Video frame rate
 * @property {number} [sensitivity] - Detection sensitivity multiplier (default 2.0)
 * @property {number} totalFrames - Total frame count for progress reporting
 */

/**
 * @typedef {object} SDW_CancelRequest
 * @property {'cancel'} type
 */

/** @typedef {SDW_AnalyzeRequest | SDW_CancelRequest} SDW_Request */

/**
 * @typedef {object} SDW_ProgressResponse
 * @property {'progress'} type
 * @property {number} percent - Progress percentage [0, 99]
 * @property {number} framesAnalyzed - Number of frames actually histogram-analyzed
 * @property {number} totalFrames
 * @property {number} cutsFound - Running count of detected cuts
 */

/**
 * @typedef {object} SDW_CutResult
 * @property {number} frame - Frame number of detected cut
 * @property {number} time - Time in seconds of detected cut
 * @property {number} confidence - Detection confidence [0, 1]
 */

/**
 * @typedef {object} SDW_CompleteResponse
 * @property {'complete'} type
 * @property {SDW_CutResult[]} cuts - Detected scene cut points (merged, sorted by frame)
 */

/**
 * @typedef {object} SDW_ErrorResponse
 * @property {'error'} type
 * @property {string} message
 */

/** @typedef {SDW_ProgressResponse | SDW_CompleteResponse | SDW_ErrorResponse} SDW_Response */

let cancelled = false;

self.onmessage = async e => {
  if (e.data.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (e.data.type === 'analyze') {
    cancelled = false;
    try {
      await runAnalysis(e.data);
    } catch (err) {
      if (!cancelled) self.postMessage({ type: 'error', message: err.message || String(err) });
    }
  }
};

// ---------------------------------------------------------------------------
// Histogram + distance
// ---------------------------------------------------------------------------

const BINS = 32;
const HIST_SIZE = BINS * 3;

function computeHistogram(imageData) {
  const hist = new Float32Array(HIST_SIZE);
  const data = imageData.data;
  const pixelCount = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    hist[Math.floor(data[i] / 8)] += 1;
    hist[BINS + Math.floor(data[i + 1] / 8)] += 1;
    hist[BINS * 2 + Math.floor(data[i + 2] / 8)] += 1;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= pixelCount;
  return hist;
}

function chiSquaredDistance(h1, h2) {
  let sum = 0;
  for (let i = 0; i < h1.length; i++) {
    const diff = h1[i] - h2[i];
    const denom = h1[i] + h2[i];
    if (denom > 0) sum += (diff * diff) / denom;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Sliding-window running statistics
// ---------------------------------------------------------------------------

function createRunningStats(windowSize) {
  const values = [];
  let sum = 0;
  let sumSq = 0;
  return {
    push(val) {
      values.push(val);
      sum += val;
      sumSq += val * val;
      if (values.length > windowSize) {
        const removed = values.shift();
        sum -= removed;
        sumSq -= removed * removed;
      }
    },
    get mean() {
      return values.length > 0 ? sum / values.length : 0;
    },
    get stddev() {
      if (values.length < 2) return 0;
      const m = sum / values.length;
      return Math.sqrt(Math.max(0, sumSq / values.length - m * m));
    },
    get count() {
      return values.length;
    }
  };
}

// ---------------------------------------------------------------------------
// GOP boundaries
// ---------------------------------------------------------------------------

function findGopBoundaries(samples) {
  const gops = [];
  let gopStart = -1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].type === 'key') {
      if (gopStart >= 0) gops.push({ startIdx: gopStart, endIdx: i - 1 });
      gopStart = i;
    }
  }
  if (gopStart >= 0) gops.push({ startIdx: gopStart, endIdx: samples.length - 1 });
  return gops;
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

async function runAnalysis({ file, codecConfig, samples, fps, sensitivity = 2.0, totalFrames }) {
  if (!samples || samples.length === 0) {
    self.postMessage({ type: 'error', message: 'No samples provided' });
    return;
  }

  const config = { ...codecConfig };
  if (config.description && !(config.description instanceof Uint8Array)) {
    config.description = new Uint8Array(config.description);
  }

  try {
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      self.postMessage({ type: 'error', message: `Codec not supported: ${config.codec}` });
      return;
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: `Codec check failed: ${e.message}` });
    return;
  }

  // Analyze ~12 frames/sec — enough for hard cut detection
  const analyzeInterval = Math.max(1, Math.round(fps / 12));

  const THUMB_W = 160;
  const THUMB_H = 90;
  const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
  const ctx = canvas.getContext('2d');

  let prevHist = null;
  let globalFrameIdx = 0;
  let framesAnalyzed = 0;
  let lastProgressPercent = -1;
  const rawCuts = [];
  const stats = createRunningStats(30);
  const MIN_DISTANCE = 0.1;

  const decodedFrames = [];
  const decoder = new VideoDecoder({
    output: frame => {
      decodedFrames.push(frame);
    },
    error: () => {}
  });
  decoder.configure({
    ...config,
    hardwareAcceleration: 'prefer-hardware',
    optimizeForLatency: false
  });

  const gops = findGopBoundaries(samples);
  const GOPS_PER_BATCH = 5;

  self.postMessage({ type: 'progress', percent: 0, framesAnalyzed: 0, totalFrames, cutsFound: 0 });

  try {
    for (let g = 0; g < gops.length; g += GOPS_PER_BATCH) {
      if (cancelled) break;

      const batchEnd = Math.min(g + GOPS_PER_BATCH, gops.length);

      // Single file read for entire batch of GOPs
      const rangeStart = samples[gops[g].startIdx].offset;
      const lastSample = samples[gops[batchEnd - 1].endIdx];
      const rangeEnd = lastSample.offset + lastSample.size;

      let batchBuffer;
      try {
        batchBuffer = await file.slice(rangeStart, rangeEnd).arrayBuffer();
      } catch (err) {
        console.warn('[SceneDetection] File read failed:', err.message || err);
        for (let gi = g; gi < batchEnd; gi++) {
          framesAnalyzed += gops[gi].endIdx - gops[gi].startIdx + 1;
        }
        continue;
      }

      if (cancelled) break;

      // Feed all chunks in this batch
      for (let gi = g; gi < batchEnd; gi++) {
        const gop = gops[gi];
        for (let i = gop.startIdx; i <= gop.endIdx; i++) {
          if (decoder.state !== 'configured') break;
          const sample = samples[i];
          const localOffset = sample.offset - rangeStart;
          try {
            decoder.decode(
              new EncodedVideoChunk({
                type: sample.type,
                timestamp: sample.timestamp,
                duration: sample.duration,
                data: new Uint8Array(batchBuffer, localOffset, sample.size)
              })
            );
          } catch (err) {
            console.warn('[SceneDetection] Frame decode failed:', err.message || err);
          }
        }
      }

      // Single flush for entire batch
      if (decoder.state === 'configured') {
        try {
          await decoder.flush();
        } catch (err) {
          console.warn('[SceneDetection] Decoder flush failed:', err.message || err);
          break; // Can't continue with corrupted decoder state
        }
      }

      if (cancelled) break;

      // Sort by presentation timestamp
      decodedFrames.sort((a, b) => a.timestamp - b.timestamp);

      // Process: analyze sampled frames, close all immediately
      for (const frame of decodedFrames) {
        if (cancelled) {
          frame.close();
          continue;
        }

        const shouldAnalyze = globalFrameIdx % analyzeInterval === 0;
        if (shouldAnalyze) {
          try {
            ctx.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
            const imageData = ctx.getImageData(0, 0, THUMB_W, THUMB_H);
            const hist = computeHistogram(imageData);

            if (prevHist) {
              const distance = chiSquaredDistance(prevHist, hist);
              stats.push(distance);

              if (stats.count >= 5 && distance > MIN_DISTANCE) {
                const mean = stats.mean;
                const stddev = stats.stddev;
                if (stddev > 0 && distance > mean + sensitivity * stddev) {
                  const timeSec = frame.timestamp / 1_000_000;
                  rawCuts.push({
                    frame: Math.round(timeSec * fps),
                    time: timeSec,
                    confidence: Math.min(1, Math.max(0, (distance - mean) / (stddev * sensitivity)))
                  });
                }
              }
            }

            prevHist = hist;
            framesAnalyzed++;
          } catch (err) {
            console.warn('[SceneDetection] Frame analysis failed:', err.message || err);
          }
        }

        frame.close();
        globalFrameIdx++;
      }

      decodedFrames.length = 0;

      // Progress — use globalFrameIdx (total frames iterated) for progress bar,
      // framesAnalyzed is the count of frames actually histogram-analyzed
      const percent = Math.min(99, Math.floor((globalFrameIdx / totalFrames) * 100));
      if (percent > lastProgressPercent) {
        lastProgressPercent = percent;
        self.postMessage({
          type: 'progress',
          percent,
          framesAnalyzed,
          totalFrames,
          cutsFound: rawCuts.length
        });
      }
    }
  } finally {
    for (const f of decodedFrames) {
      try {
        f.close();
      } catch (err) {
        console.warn('[SceneDetection] Frame close failed:', err.message || err);
      }
    }
    decodedFrames.length = 0;
    try {
      decoder.close();
    } catch (err) {
      console.warn('[SceneDetection] Decoder close failed:', err.message || err);
    }
  }

  if (cancelled) return;

  const merged = mergeCuts(rawCuts, 2);
  merged.sort((a, b) => a.frame - b.frame);
  self.postMessage({ type: 'complete', cuts: merged });
}

// ---------------------------------------------------------------------------
// Merge nearby cuts
// ---------------------------------------------------------------------------

function mergeCuts(cuts, threshold) {
  if (cuts.length === 0) return [];
  const sorted = [...cuts].sort((a, b) => a.frame - b.frame);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.frame - prev.frame <= threshold) {
      if (curr.confidence > prev.confidence) merged[merged.length - 1] = curr;
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

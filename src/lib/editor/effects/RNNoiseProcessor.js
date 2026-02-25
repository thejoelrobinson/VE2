/**
 * RNNoise-based audio denoising processor.
 * Uses @timephy/rnnoise-wasm for AI vocal enhancement.
 *
 * Loaded lazily — if WASM fails to load, denoiseBuffer() is a passthrough.
 */

let rnnoise = null;
let loadPromise = null;

async function loadRNNoise() {
  if (rnnoise) return rnnoise;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ '@timephy/rnnoise-wasm');
      rnnoise = await (mod.default || mod).RNNoise.new();
      return rnnoise;
    } catch (e) {
      console.warn('[RNNoiseProcessor] Failed to load WASM:', e.message);
      rnnoise = null;
      return null;
    }
  })();
  return loadPromise;
}

/**
 * Denoise an AudioBuffer offline using RNNoise.
 * Processes in 480-sample frames (required by RNNoise).
 * Returns the original buffer unmodified if WASM is unavailable.
 *
 * @param {OfflineAudioContext} offlineCtx - Offline audio context for rendering
 * @param {AudioBuffer} buffer - Input audio buffer to denoise
 * @returns {Promise<AudioBuffer>} Denoised audio buffer
 */
export async function denoiseBuffer(offlineCtx, buffer) {
  const instance = await loadRNNoise();
  if (!instance) return buffer;

  const FRAME_SIZE = 480;
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length;

  // Create output buffer
  const output = offlineCtx.createBuffer(numChannels, length, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const input = buffer.getChannelData(ch);
    const out = output.getChannelData(ch);
    const frame = new Float32Array(FRAME_SIZE);

    for (let i = 0; i < length; i += FRAME_SIZE) {
      const remaining = Math.min(FRAME_SIZE, length - i);
      frame.fill(0);
      frame.set(input.subarray(i, i + remaining));

      // RNNoise expects float32 samples in [-1, 1] scaled to [-32768, 32767]
      for (let j = 0; j < FRAME_SIZE; j++) {
        frame[j] *= 32768;
      }

      instance.pipe(frame);

      // Scale back to [-1, 1]
      for (let j = 0; j < remaining; j++) {
        out[i + j] = frame[j] / 32768;
      }
    }
  }

  return output;
}

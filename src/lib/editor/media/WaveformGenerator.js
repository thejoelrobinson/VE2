// Audio peak analysis via OfflineAudioContext for waveform display
import { MEDIA_TYPES } from '../core/Constants.js';
import { metadataCache } from '../core/MetadataCache.js';
import { opfsCache } from '../core/OPFSCache.js';
import { generateMediaHash } from '../../utils/mediaUtils.js';
import logger from '../../utils/logger.js';

const PEAKS_PER_SECOND = 50; // Resolution of waveform data

export const waveformGenerator = {
  async generateWaveform(mediaItem) {
    if (mediaItem.type !== MEDIA_TYPES.AUDIO && mediaItem.type !== MEDIA_TYPES.VIDEO) {
      return null;
    }

    // MXF: skip if audio not yet extracted (retry via MEDIA_AUDIO_READY event)
    if (mediaItem.type === MEDIA_TYPES.VIDEO
        && mediaItem.name?.toLowerCase().endsWith('.mxf')
        && !mediaItem.audioUrl) {
      logger.info(`[WaveformGenerator] MXF audio not yet extracted for ${mediaItem.name}, deferring`);
      return null;
    }

    const hash = generateMediaHash(mediaItem);

    // Check OPFS cache first (binary Float32Array -- fastest path)
    if (opfsCache.isAvailable()) {
      try {
        const buf = await opfsCache.read('waveforms', `${hash}.f32`);
        if (buf) {
          const peaks = new Float32Array(buf);
          mediaItem.waveform = peaks;
          logger.info(`[OPFSCache] Waveform cache hit for ${mediaItem.name}: ${peaks.length} peaks`);
          return peaks;
        }
      } catch (_) {
        // Cache miss -- fall through
      }
    }

    // Fallback: check MetadataCache (IndexedDB JSON path)
    if (mediaItem.file) {
      try {
        const cached = await metadataCache.get(mediaItem.file);
        if (cached && cached.waveformPeaks) {
          const peaks = new Float32Array(cached.waveformPeaks);
          mediaItem.waveform = peaks;
          logger.info(`[MetadataCache] Waveform cache hit for ${mediaItem.name}: ${peaks.length} peaks`);
          return peaks;
        }
      } catch (e) {
        // Cache miss or error -- fall through to generation
      }
    }

    try {
      // For MXF: use extracted WAV audio URL; for other formats: media URL
      const audioSrc = mediaItem.audioUrl || mediaItem.url;
      const response = await fetch(audioSrc);
      const arrayBuffer = await response.arrayBuffer();

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      let audioBuffer;
      try {
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      } finally {
        audioCtx.close();
      }

      const peaks = this._extractPeaks(audioBuffer);
      mediaItem.waveform = peaks;
      logger.info(`Waveform generated for ${mediaItem.name}: ${peaks.length} peaks`);

      // Cache waveform peaks to OPFS (binary -- fast reads on reload)
      if (opfsCache.isAvailable()) {
        try {
          await opfsCache.write('waveforms', `${hash}.f32`, new Uint8Array(peaks.buffer));
        } catch (_) {
          // Non-critical
        }
      }

      // Also cache in MetadataCache (IndexedDB fallback)
      if (mediaItem.file) {
        await metadataCache.set(mediaItem.file, {
          waveformPeaks: peaks.buffer.slice(0)
        });
      }

      return peaks;
    } catch (err) {
      logger.warn(`Failed to generate waveform for ${mediaItem.name}:`, err);
      return null;
    }
  },

  _extractPeaks(audioBuffer) {
    const channelData = audioBuffer.getChannelData(0); // Use first channel
    const sampleRate = audioBuffer.sampleRate;
    const duration = audioBuffer.duration;
    const totalPeaks = Math.ceil(duration * PEAKS_PER_SECOND);
    const peaks = new Float32Array(totalPeaks);
    const len = channelData.length;

    for (let i = 0; i < totalPeaks; i++) {
      const start = Math.floor((i / totalPeaks) * len);
      const end = Math.floor(((i + 1) / totalPeaks) * len);
      let max = 0;
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channelData[j]);
        if (abs > max) max = abs;
      }
      peaks[i] = max;
    }

    return peaks;
  },

  // Render waveform to a canvas for a clip
  renderWaveform(canvas, peaks, startRatio, endRatio, color = '#56b6c2') {
    if (!peaks || peaks.length === 0) return;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const midY = h / 2;

    const startIdx = Math.floor(startRatio * peaks.length);
    const endIdx = Math.ceil(endRatio * peaks.length);
    const visiblePeaks = endIdx - startIdx;
    if (visiblePeaks <= 0) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;

    const barWidth = Math.max(1, w / visiblePeaks);

    for (let i = 0; i < visiblePeaks; i++) {
      const peak = peaks[startIdx + i] || 0;
      const barHeight = peak * midY * 0.9;
      const x = (i / visiblePeaks) * w;

      // Draw mirrored bar (up and down from center)
      ctx.fillRect(x, midY - barHeight, barWidth, barHeight * 2);
    }
  }
};

export default waveformGenerator;

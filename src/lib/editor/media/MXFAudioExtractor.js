// Extract PCM audio from MXF files using @ffmpeg/ffmpeg.
// Caches extracted WAV in OPFS keyed by file hash for instant reload.
import { ffmpegBridge } from '../export/FFmpegBridge.js';
import { opfsCache } from '../core/OPFSCache.js';
import { generateMediaHash } from '../../utils/mediaUtils.js';
import logger from '../../utils/logger.js';

// In-flight dedup: hash -> Promise<string|null>
const _inFlight = new Map();

/**
 * Extract audio from an MXF file and return a blob: URL pointing to a WAV.
 * Returns null if extraction fails (video-only clip remains playable, just silent).
 * @param {File} file
 * @returns {Promise<string|null>}
 */
export async function extractMXFAudio(file) {
  // Create a stable hash key from filename + size
  const hashKey = `mxf_${generateMediaHash({ name: file.name, size: file.size })}`;
  const cacheFileName = `${hashKey}.wav`;

  // OPFS cache hit — return instantly without running FFmpeg
  if (opfsCache.isAvailable()) {
    try {
      const buf = await opfsCache.read('mxf-audio', cacheFileName);
      if (buf) {
        logger.info(`[MXFAudio] OPFS cache hit for ${file.name}`);
        const blob = new Blob([buf], { type: 'audio/wav' });
        return URL.createObjectURL(blob);
      }
    } catch (_) {}
  }

  // Dedup concurrent extraction requests for the same file
  if (_inFlight.has(hashKey)) return _inFlight.get(hashKey);

  const promise = _doExtract(file, hashKey, cacheFileName);
  _inFlight.set(hashKey, promise);
  promise.finally(() => _inFlight.delete(hashKey));
  return promise;
}

async function _doExtract(file, hashKey, cacheFileName) {
  try {
    logger.info(`[MXFAudio] Extracting audio from ${file.name} (${(file.size / 1e6).toFixed(1)} MB)...`);

    // Load FFmpeg (shared singleton — reuses existing instance if already loaded for export)
    await ffmpegBridge.load();

    const inputName = `in_${hashKey}.mxf`;
    const outputName = `out_${hashKey}.wav`;

    // Write MXF data to FFmpeg VFS
    const data = new Uint8Array(await file.arrayBuffer());
    await ffmpegBridge.writeFile(inputName, data);

    // Extract audio as 48kHz stereo PCM float32 WAV
    await ffmpegBridge.exec([
      '-i', inputName,
      '-vn',                // no video
      '-c:a', 'pcm_f32le',  // float32 PCM — highest quality for AudioContext
      '-ar', '48000',       // 48 kHz (standard for professional video)
      '-ac', '2',           // stereo
      '-f', 'wav',
      outputName
    ]);

    const wavData = await ffmpegBridge.readFile(outputName);

    // Cleanup VFS
    await ffmpegBridge.deleteFile(inputName);
    await ffmpegBridge.deleteFile(outputName);

    // Cache to OPFS for fast reload next session
    if (opfsCache.isAvailable()) {
      try {
        const buf = wavData instanceof Uint8Array ? wavData.buffer : wavData;
        await opfsCache.write('mxf-audio', cacheFileName, new Uint8Array(buf));
      } catch (_) {}
    }

    const blob = new Blob([wavData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    logger.info(`[MXFAudio] Extracted ${file.name}: ${(wavData.length / 1e6).toFixed(1)} MB WAV`);
    return url;
  } catch (err) {
    logger.warn(`[MXFAudio] Extraction failed for ${file.name}:`, err.message);
    return null;
  }
}

// Mux encoded video bitstream + audio into container using FFmpeg (copy mode, no re-encode)
import logger from '../../utils/logger.js';
import { parseBitrate } from './exportUtils.js';
import {
  Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat,
  EncodedVideoPacketSource, AudioBufferSource, EncodedPacket
} from 'mediabunny';

export async function muxToContainer(ffmpegBridge, videoData, audioData, config) {
  const isH264 = config.codec.startsWith('avc1');
  const isVP9 = config.codec.startsWith('vp09');
  const videoExt = isH264 ? 'h264' : isVP9 ? 'ivf' : 'raw';
  const videoFile = `video.${videoExt}`;
  const outputFile = `output.${config.format || 'mp4'}`;

  // Write video + audio to VFS in parallel
  const writes = [ffmpegBridge.writeFile(videoFile, videoData)];
  let hasAudio = false;
  if (audioData && audioData.byteLength > 0) {
    writes.push(ffmpegBridge.writeFile('audio.wav', new Uint8Array(audioData)));
    hasAudio = true;
  }
  await Promise.all(writes);

  // Build FFmpeg args — copy mode (no re-encoding)
  // Framerate MUST be specified for raw bitstreams (H.264 Annex B has no fps metadata)
  const fps = config.fps || 30;
  const args = ['-r', String(fps), '-i', videoFile];

  if (hasAudio) {
    args.push('-i', 'audio.wav');
  }

  // Video: copy (already encoded)
  args.push('-c:v', 'copy');

  // Audio: encode to AAC (from WAV)
  if (hasAudio) {
    args.push('-c:a', 'aac');
    if (config.audioBitrate) args.push('-b:a', config.audioBitrate);
    if (config.audioSampleRate) args.push('-ar', String(config.audioSampleRate));
  }

  // Set exact output duration (like Premiere: sequence length or in/out range)
  // This ensures audio is padded/trimmed to match the video duration exactly
  if (config.duration) {
    args.push('-t', String(config.duration.toFixed(6)));
  }
  args.push('-y', outputFile);

  const cmd = `ffmpeg ${args.join(' ')}`;
  logger.info(`Muxing: ${cmd}`);
  if (typeof self !== 'undefined' && self.postMessage) {
    try { self.postMessage({ type: 'log', message: `[Worker Mux] ${cmd}` }); } catch (_) {}
  }

  let outputData;
  try {
    await ffmpegBridge.exec(args);

    // Read output
    outputData = await ffmpegBridge.readFile(outputFile);
  } finally {
    // Cleanup VFS files even if exec fails
    try { await ffmpegBridge.deleteFile(videoFile); } catch (_) {}
    try { await ffmpegBridge.deleteFile(outputFile); } catch (_) {}
    if (hasAudio) {
      try { await ffmpegBridge.deleteFile('audio.wav'); } catch (_) {}
    }
  }

  return outputData;
}

export async function muxWithMediaBunny(chunks, audioBuffer, config) {
  logger.info(`Muxing via MediaBunny: ${chunks.length} video chunks, audio: ${!!audioBuffer}, format: ${config.format}`);

  // Map codec string to MediaBunny codec name
  let videoCodec;
  if (config.codec.startsWith('avc1')) {
    videoCodec = 'avc';
  } else if (config.codec.startsWith('vp09')) {
    videoCodec = 'vp9';
  } else {
    videoCodec = 'av1';
  }

  // Choose output format
  const format = config.format === 'webm'
    ? new WebMOutputFormat()
    : new Mp4OutputFormat({ fastStart: 'in-memory' });

  // Create target and output
  const target = new BufferTarget();
  const output = new Output({ format, target });

  // Add video track
  const videoSource = new EncodedVideoPacketSource(videoCodec);
  output.addVideoTrack(videoSource, { frameRate: config.fps });

  // Add audio track if present
  let audioSource = null;
  if (audioBuffer) {
    const audioCodec = config.format === 'webm' ? 'opus' : 'aac';
    audioSource = new AudioBufferSource({
      codec: audioCodec,
      bitrate: parseBitrate(config.audioBitrate, 192_000)
    });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  try {
    // Feed video packets
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const packet = new EncodedPacket(
        chunk.data,
        chunk.type,
        chunk.timestamp / 1_000_000,
        chunk.duration / 1_000_000,
        i
      );
      const meta = chunk.decoderConfig ? { decoderConfig: chunk.decoderConfig } : undefined;
      await videoSource.add(packet, meta);
    }
    videoSource.close();

    // Feed audio if present
    if (audioBuffer && audioSource) {
      await audioSource.add(audioBuffer);
      audioSource.close();
    }

    await output.finalize();
  } catch (e) {
    logger.error('[Muxer] MediaBunny mux failed:', e);
    throw e;
  } finally {
    try { videoSource.close?.(); } catch (_) {}
    try { audioSource?.close?.(); } catch (_) {}
  }

  return new Uint8Array(target.buffer);
}

export default muxToContainer;

// Export Worker — renders frames + encodes video off the main thread
// @ts-check
// Message protocol: init → start → progress/complete/error

import { createWorkerMediaDecoder } from './WorkerMediaDecoder.js';
import { createWorkerCompositor } from './WorkerCompositor.js';
import { getMimeType, getFFmpegColorFlags, QUALITY_CRF } from './exportUtils.js';
import logger from '../../utils/logger.js';

// ---- Worker Message Protocol (JSDoc) ----

/**
 * @typedef {object} EW_MediaItem
 * @property {string} id
 * @property {'image'|'video'|'audio'} type
 * @property {Blob} [blob] - Image blob data (for type 'image')
 * @property {File} [file] - Streaming file handle (for type 'video' or 'audio')
 * @property {ArrayBuffer} [buffer] - Legacy fallback buffer (for type 'video' or 'audio')
 * @property {ImageBitmap[]} [frames] - Pre-decoded frames (for type 'video')
 */

/**
 * @typedef {object} EW_EffectDef
 * @property {string} id - Effect identifier
 * @property {object} [params] - Default parameters
 * @property {string} [type] - Effect type (video/audio)
 */

/**
 * @typedef {object} EW_InitData
 * @property {number} width - Output width
 * @property {number} height - Output height
 * @property {EW_MediaItem[]} media - All media items needed for export
 * @property {EW_EffectDef[]} [effectRegistry] - Serialized effect definitions
 */

/**
 * @typedef {object} EW_InitRequest
 * @property {'init'} type
 * @property {EW_InitData} data
 */

/**
 * @typedef {object} EW_ExportPreset
 * @property {string} format - Output format (mp4, webm)
 * @property {string} [videoCodec] - FFmpeg video codec
 * @property {string} [webCodecsCodec] - WebCodecs codec string (e.g., 'avc1.640028')
 * @property {string} [pixelFormat] - FFmpeg pixel format
 * @property {string|number} [videoBitrate] - Video bitrate (e.g., '8M')
 * @property {string} [bitrateMode] - 'variable'|'constant'|'quantizer'
 * @property {string} [quality] - Quality preset (low/medium/high/lossless)
 * @property {string} [preset] - Encoder speed preset
 * @property {string} [audioCodec] - Audio codec
 * @property {string|number} [audioBitrate] - Audio bitrate
 * @property {number} [audioSampleRate] - Audio sample rate in Hz
 * @property {string} [outputSpace] - Output color space (rec709/display-p3/rec2020)
 */

/**
 * @typedef {object} EW_StartData
 * @property {EW_ExportPreset} preset
 * @property {object[]} tracks - Serialized timeline tracks with clips
 * @property {number} inPoint - First frame to export
 * @property {number} outPoint - Frame after last frame to export
 * @property {number} fps - Frames per second
 * @property {object[]} mediaItems - Media items with metadata for compositor lookup
 * @property {ArrayBuffer} [audioWavData] - Pre-rendered audio as WAV
 */

/**
 * @typedef {object} EW_StartRequest
 * @property {'start'} type
 * @property {EW_StartData} data
 */

/**
 * @typedef {object} EW_CancelRequest
 * @property {'cancel'} type
 */

/** @typedef {EW_InitRequest | EW_StartRequest | EW_CancelRequest} EW_Request */

/**
 * @typedef {object} EW_InitCompleteResponse
 * @property {'init_complete'} type
 */

/**
 * @typedef {object} EW_ProgressResponse
 * @property {'progress'} type
 * @property {'loading'|'rendering'|'encoding'|'muxing'} stage
 * @property {number} progress - Progress ratio [0, 1]
 * @property {number} [current] - Current frame/step number
 * @property {number} [total] - Total frames/steps
 */

/**
 * @typedef {object} EW_LogResponse
 * @property {'log'} type
 * @property {string} message - Diagnostic log message
 */

/**
 * @typedef {object} EW_CompleteResponse
 * @property {'complete'} type
 * @property {ArrayBuffer} buffer - Encoded output file data
 * @property {string} mimeType - MIME type of output (e.g., 'video/mp4')
 * Transfer list: [buffer] (zero-copy transfer)
 */

/**
 * @typedef {object} EW_CancelledResponse
 * @property {'cancelled'} type
 */

/**
 * @typedef {object} EW_ErrorResponse
 * @property {'error'} type
 * @property {string} error - Error message
 */

/** @typedef {EW_InitCompleteResponse | EW_ProgressResponse | EW_LogResponse | EW_CompleteResponse | EW_CancelledResponse | EW_ErrorResponse} EW_Response */

let mediaDecoder = null;
let compositor = null;
let cancelled = false;

self.onmessage = async e => {
  const { type, data } = e.data;

  try {
    switch (type) {
      case 'init':
        await handleInit(data);
        break;
      case 'start':
        await handleStart(data);
        break;
      case 'cancel':
        cancelled = true;
        break;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: err.message || 'Export worker error'
    });
  }
};

async function handleInit(data) {
  const { width, height, media, effectRegistry } = data;

  mediaDecoder = createWorkerMediaDecoder();

  for (const item of media) {
    if (item.type === 'image') {
      mediaDecoder.registerImage(item.id, item.blob);
    } else if (item.type === 'video') {
      if (item.file) {
        mediaDecoder.registerVideo(item.id, item.file);
      } else if (item.buffer) {
        mediaDecoder.registerVideo(item.id, item.buffer); // legacy fallback
      } else if (item.frames) {
        mediaDecoder.registerFrames(item.id, item.frames);
      } else {
        logger.warn(`video item ${item.id} has no buffer, file, or frames!`);
      }
    } else if (item.type === 'audio') {
      if (item.file) {
        mediaDecoder.registerAudio(item.id, item.file);
      } else if (item.buffer) {
        mediaDecoder.registerAudio(item.id, item.buffer);
      }
    }
  }

  const effectMap = new Map();
  if (effectRegistry) {
    for (const def of effectRegistry) {
      effectMap.set(def.id, def);
    }
  }

  const effectRegistryGet = id => effectMap.get(id);
  // Resolve effect params for export with linear keyframe interpolation.
  // Easing modes (ease-in/out, bezier, hold) are approximated as linear here.
  const keyframeResolve = (fx, frame) => {
    const resolved = { ...fx.params };
    if (fx.keyframes) {
      for (const [paramId, kfs] of Object.entries(fx.keyframes)) {
        if (!kfs || kfs.length === 0) continue;
        // Simple interpolation: find surrounding keyframes
        if (frame <= kfs[0].frame) {
          resolved[paramId] = kfs[0].value;
          continue;
        }
        if (frame >= kfs[kfs.length - 1].frame) {
          resolved[paramId] = kfs[kfs.length - 1].value;
          continue;
        }
        for (let i = 0; i < kfs.length - 1; i++) {
          if (frame >= kfs[i].frame && frame <= kfs[i + 1].frame) {
            const t = (frame - kfs[i].frame) / (kfs[i + 1].frame - kfs[i].frame);
            resolved[paramId] = kfs[i].value + (kfs[i + 1].value - kfs[i].value) * t;
            break;
          }
        }
      }
    }
    return resolved;
  };

  compositor = createWorkerCompositor(
    width,
    height,
    mediaDecoder,
    effectRegistryGet,
    keyframeResolve
  );

  self.postMessage({ type: 'init_complete' });
}

async function handleStart(data) {
  const { preset, tracks, inPoint, outPoint, fps, mediaItems, audioWavData } = data;
  cancelled = false;

  // Guard: if compositor/decoder were cleaned up by a previous export, error early
  if (!compositor || !mediaDecoder) {
    throw new Error(
      'Worker must be re-initialized (compositor/decoder cleaned up). Send init before start.'
    );
  }

  // Lazy-load FFmpeg — only downloaded from CDN when an export actually starts
  const { ffmpegBridge } = await import('./FFmpegBridge.js');

  const totalFrames = outPoint - inPoint;

  // Step 1: Load FFmpeg
  self.postMessage({ type: 'progress', stage: 'loading', progress: 0 });
  await ffmpegBridge.load();
  self.postMessage({ type: 'progress', stage: 'loading', progress: 1 });

  if (cancelled) {
    self.postMessage({ type: 'cancelled' });
    return;
  }

  // Set the actual project fps (compositor was created with default 30)
  compositor.setFps(fps);

  const mediaMap = new Map();
  for (const item of mediaItems) {
    mediaMap.set(item.id, item);
  }

  // Step 2: Check audio availability (don't write to FFmpeg VFS yet —
  // ffmpeg.writeFile transfers the ArrayBuffer internally, detaching it.
  // The Muxer will write audio.wav itself for WebCodecs path.
  // JPEG fallback writes it just before FFmpeg exec.)
  let hasAudio = !!(audioWavData && audioWavData.byteLength > 0);
  if (hasAudio) {
    self.postMessage({
      type: 'log',
      message: `[Worker] Audio available: ${(audioWavData.byteLength / 1024).toFixed(0)}KB`
    });
  } else {
    self.postMessage({ type: 'log', message: `[Worker] No audio data received` });
  }

  // Quick sanity check: verify at least one video track has clips with valid data
  {
    let hasVideoClip = false;
    for (const t of tracks) {
      if (t.type !== 'video' || t.muted) continue;
      for (const c of t.clips) {
        if (!c.disabled && c.sourceOutFrame > c.sourceInFrame) {
          hasVideoClip = true;
          break;
        }
      }
      if (hasVideoClip) break;
    }
    if (!hasVideoClip) {
      throw new Error('Worker export: no valid video clips found in timeline');
    }
  }

  // Step 3: Try WebCodecs encode path first (composite + encode in one pass)
  const useWebCodecs = typeof VideoEncoder !== 'undefined' && preset.webCodecsCodec;

  if (useWebCodecs) {
    let wcEncoder = null;
    try {
      const { createWebCodecsEncoder } = await import('./WebCodecsEncoder.js');
      const { muxToContainer } = await import('./Muxer.js');

      // Resolve output color space (duplicated from ColorManagement — Workers can't import it)
      const outSpace = preset.outputSpace || 'rec709';
      let workerOutputColorSpace;
      if (outSpace === 'rec2020') {
        workerOutputColorSpace = {
          primaries: 'bt2020',
          transfer: 'bt709',
          matrix: 'bt2020-ncl',
          fullRange: false
        };
      } else if (outSpace === 'display-p3') {
        workerOutputColorSpace = {
          primaries: 'smpte432',
          transfer: 'iec61966-2-1',
          matrix: 'bt709',
          fullRange: false
        };
      } else {
        workerOutputColorSpace = {
          primaries: 'bt709',
          transfer: 'bt709',
          matrix: 'bt709',
          fullRange: false
        };
      }

      wcEncoder = createWebCodecsEncoder({
        codec: preset.webCodecsCodec,
        width: compositor.canvas.width,
        height: compositor.canvas.height,
        bitrate: preset.videoBitrate,
        fps,
        bitrateMode: preset.bitrateMode,
        quality: preset.quality,
        outputColorSpace: workerOutputColorSpace
      });

      await wcEncoder.init();
      self.postMessage({
        type: 'log',
        message: `[Worker] WebCodecs path: ${totalFrames} frames, ${fps}fps, hasAudio: ${hasAudio}`
      });

      // Composite and encode each frame directly (no JPEG intermediates)
      self.postMessage({ type: 'progress', stage: 'encoding', progress: 0 });

      let encoded = 0;
      for (let frame = inPoint; frame < outPoint; frame++) {
        if (cancelled) {
          self.postMessage({ type: 'cancelled' });
          return;
        }

        const canvas = await compositor.compositeFrame(frame, tracks, id => mediaMap.get(id));
        const timestampUs = Math.round((encoded / fps) * 1000000);
        wcEncoder.encodeFrame(canvas, timestampUs);

        encoded++;
        self.postMessage({
          type: 'progress',
          stage: 'encoding',
          progress: encoded / totalFrames,
          current: encoded,
          total: totalFrames
        });
      }

      await wcEncoder.flush();
      const videoData = wcEncoder.getEncodedData();

      // Mux with FFmpeg (copy mode — very fast)
      self.postMessage({ type: 'progress', stage: 'muxing', progress: 0 });

      const outputData = await muxToContainer(ffmpegBridge, videoData, audioWavData, {
        codec: preset.webCodecsCodec,
        format: preset.format,
        fps,
        duration: totalFrames / fps,
        audioBitrate: preset.audioBitrate,
        audioSampleRate: preset.audioSampleRate
      });

      // audio.wav is cleaned up by muxToContainer itself

      const mimeType = getMimeType(preset.format);
      const buffer = outputData.buffer;

      self.postMessage({ type: 'complete', buffer, mimeType }, [buffer]);
      await compositor?.cleanup();
      compositor = null;
      await mediaDecoder?.cleanup();
      mediaDecoder = null;
      return;
    } catch (wcErr) {
      self.postMessage({
        type: 'log',
        message: `[Worker] WebCodecs FAILED: ${wcErr.message}, falling to JPEG`
      });
    } finally {
      if (wcEncoder) {
        try {
          wcEncoder.close();
        } catch (_) {}
      }
    }
  }

  self.postMessage({
    type: 'log',
    message: `[Worker] JPEG+FFmpeg fallback path (${totalFrames} frames, hasAudio: ${hasAudio})`
  });
  // Step 4: Fallback — render frames as JPEG + FFmpeg full encode
  let rendered = 0;
  self.postMessage({ type: 'progress', stage: 'rendering', progress: 0 });

  for (let frame = inPoint; frame < outPoint; frame++) {
    if (cancelled) {
      self.postMessage({ type: 'cancelled' });
      return;
    }

    const canvas = await compositor.compositeFrame(frame, tracks, id => mediaMap.get(id));

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);

    const paddedNum = String(rendered).padStart(6, '0');
    await ffmpegBridge.writeFile(`frame_${paddedNum}.jpg`, uint8);

    rendered++;
    self.postMessage({
      type: 'progress',
      stage: 'rendering',
      progress: rendered / totalFrames,
      current: rendered,
      total: totalFrames
    });
  }

  if (cancelled) {
    self.postMessage({ type: 'cancelled' });
    return;
  }

  // Step 5: FFmpeg encode
  self.postMessage({ type: 'progress', stage: 'encoding', progress: 0 });

  // Write audio to FFmpeg VFS for JPEG path (WebCodecs path handles it in Muxer)
  if (hasAudio && audioWavData && audioWavData.byteLength > 0) {
    await ffmpegBridge.writeFile('audio.wav', new Uint8Array(audioWavData));
  } else if (hasAudio) {
    // audioWavData was detached (shouldn't happen now), skip audio
    hasAudio = false;
  }

  ffmpegBridge.setProgressCallback(progress => {
    self.postMessage({ type: 'progress', stage: 'encoding', progress });
  });

  const outputFilename = `output.${preset.format}`;
  const args = buildFFmpegArgs(preset, fps, rendered, hasAudio, outputFilename);

  try {
    await ffmpegBridge.exec(args);
  } catch (err) {
    throw new Error(`FFmpeg encoding failed: ${err.message}`);
  } finally {
    ffmpegBridge.setProgressCallback(null);
  }

  // Step 6: Read output
  const outputData = await ffmpegBridge.readFile(outputFilename);
  const mimeType = getMimeType(preset.format);
  const outputBlob = new Blob([outputData.buffer], { type: mimeType });

  // Cleanup
  for (let i = 0; i < rendered; i++) {
    const paddedNum = String(i).padStart(6, '0');
    await ffmpegBridge.deleteFile(`frame_${paddedNum}.jpg`);
  }
  await ffmpegBridge.deleteFile(outputFilename);
  if (hasAudio) await ffmpegBridge.deleteFile('audio.wav');

  const buffer = await outputBlob.arrayBuffer();
  self.postMessage({ type: 'complete', buffer, mimeType }, [buffer]);

  await compositor?.cleanup();
  compositor = null;
  await mediaDecoder?.cleanup();
  mediaDecoder = null;
}

function buildFFmpegArgs(preset, fps, frameCount, hasAudio, outputFilename) {
  const args = ['-framerate', String(fps), '-i', 'frame_%06d.jpg'];
  if (hasAudio) args.push('-i', 'audio.wav');
  if (preset.videoCodec) args.push('-c:v', preset.videoCodec);
  if (preset.pixelFormat) args.push('-pix_fmt', preset.pixelFormat);

  // Rate control: VBR uses CRF with maxrate cap, CBR uses fixed bitrate
  const isVBR = preset.bitrateMode !== 'constant';
  const isVP9 = preset.videoCodec === 'libvpx-vp9';

  if (isVBR && preset.videoCodec) {
    const codecKey = isVP9 ? 'vp9' : 'h264';
    const quality = preset.quality || 'medium';
    const crf = QUALITY_CRF[quality]?.[codecKey] ?? QUALITY_CRF.medium[codecKey];
    args.push('-crf', String(crf));

    if (isVP9) {
      args.push('-b:v', '0');
    }

    if (preset.videoBitrate) {
      args.push('-maxrate', preset.videoBitrate);
      const bitrateNum = parseInt(preset.videoBitrate);
      const unit = preset.videoBitrate.replace(/[\d.]/g, '');
      args.push('-bufsize', `${bitrateNum * 2}${unit}`);
    }
  } else if (preset.videoBitrate) {
    // CBR: 2x bufsize for rate smoothing at scene changes
    args.push('-b:v', preset.videoBitrate);
    args.push('-maxrate', preset.videoBitrate);
    const cbrNum = parseInt(preset.videoBitrate);
    const cbrUnit = preset.videoBitrate.replace(/[\d.]/g, '');
    args.push('-bufsize', `${cbrNum * 2}${cbrUnit}`);
  }

  // Encoder speed preset (VP9 doesn't use -preset)
  if (preset.preset && !isVP9) args.push('-preset', preset.preset);

  if (hasAudio && preset.audioCodec) {
    args.push('-c:a', preset.audioCodec);
    if (preset.audioBitrate) args.push('-b:a', preset.audioBitrate);
    if (preset.audioSampleRate) args.push('-ar', String(preset.audioSampleRate));
  }

  // Color space metadata tagging
  const colorFlags = getFFmpegColorFlags(preset.outputSpace || 'rec709');
  args.push(...colorFlags);

  if (hasAudio) args.push('-shortest');
  args.push('-y', outputFilename);
  return args;
}

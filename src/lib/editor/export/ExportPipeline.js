// Orchestrate: render frames -> audio mixdown -> FFmpeg encode -> download
// @ts-check

/** @typedef {import('./ExportWorker.js').EW_Request} EW_Request */
/** @typedef {import('./ExportWorker.js').EW_Response} EW_Response */

import { editorState } from '../core/EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { clipContainsFrame, getSourceFrameAtPlayhead, getClipEndFrame } from '../timeline/Clip.js';
import { getTransitionZone } from '../effects/Transitions.js';
import { frameToSeconds } from '../timeline/TimelineMath.js';
import { videoCompositor } from '../playback/VideoCompositor.js';
import { audioMixer } from '../playback/AudioMixer.js';
import { getPreset } from './ExportPresets.js';
import { clamp } from '../core/MathUtils.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { renderAheadManager } from '../media/RenderAheadManager.js';
import { mediaManager } from '../media/MediaManager.js';
import { MEDIA_TYPES, getAvcCodecForResolution, STATE_PATHS } from '../core/Constants.js';
import { conformEncoder } from '../media/ConformEncoder.js';
import { muxWithMediaBunny } from './Muxer.js';
import { getMimeType, getFFmpegColorFlags, QUALITY_CRF } from './exportUtils.js';
import { colorManagement } from '../core/ColorManagement.js';
import logger from '../../utils/logger.js';

// Module-level reference, assigned lazily by _loadFFmpeg so _buildFFmpegArgs can read it
let ffmpegBridge = null;

export const exportPipeline = {
  _exporting: false,
  _cancelled: false,

  isExporting() {
    return this._exporting;
  },

  cancel() {
    this._cancelled = true;
    // Notify active Worker so it can abort in-flight rendering
    if (this._activeWorker) {
      try {
        this._activeWorker.postMessage({ type: 'cancel' });
      } catch (_) {}
    }
  },

  _pauseForExport() {
    conformEncoder.pauseForExport();
    renderAheadManager.pauseForExport();
  },

  _resumeAfterExport() {
    conformEncoder.resumeAfterExport();
    renderAheadManager.resumeAfterExport();
  },

  async export(presetId, onProgress, overrides) {
    if (this._exporting) {
      logger.warn('[Export] Export already in progress, ignoring');
      return null;
    }
    this._exporting = true;
    this._cancelled = false;

    try {
      const preset = { ...getPreset(presetId), ...overrides };
      const fps = preset.fps || editorState.get(STATE_PATHS.PROJECT_FRAME_RATE);
      const duration = timelineEngine.getDuration();

      // Use in/out points if set
      const inPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT) ?? 0;
      const outPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT) ?? duration;
      const totalFrames = outPoint - inPoint;

      if (totalFrames <= 0) {
        throw new Error('No frames to export');
      }

      let audioMixPromise = null;
      try {
        // Pause idle fills to avoid GPU/decoder contention during export
        this._pauseForExport();

      // Fast path: if all frames are pre-rendered (green bar), use main-thread export
      // which reads directly from the render-ahead buffer (no re-decode).
      // The sequential access pattern during export is perfect for LRU eviction.
      const preRendered = renderAheadManager.isRangeDecoded(inPoint, outPoint);
      if (preRendered) {
        logger.info(
          `[Export] Pre-rendered fast path: all ${totalFrames} frames decoded, skipping Worker`
        );
      }

      // Skip Worker when conformed packets exist — Worker can't access ConformEncoder cache,
      // so the main-thread hybrid path is faster (reuses pre-encoded packets).
      const hasConformedPackets = conformEncoder.getProgress().conformed > 0;

      // Try Worker-based export (off main thread) only if not pre-rendered and no conform data
      if (!preRendered && !hasConformedPackets && this._canUseWorker()) {
        try {
          const blob = await this._exportViaWorker(preset, onProgress);
          this._exporting = false;
          this._resumeAfterExport();
          if (blob) {
            onProgress?.({ stage: 'complete', progress: 1, message: 'Export complete!' });
          }
          return blob;
        } catch (workerErr) {
          logger.warn('Worker export failed, falling back to main thread:', workerErr);
        }
      }

      // Start audio mixdown in parallel with rendering (returns raw AudioBuffer)
      audioMixPromise = (async () => {
        try {
          onProgress?.({ stage: 'audio', progress: 0, message: 'Mixing audio...' });
          const audioBuffer = await audioMixer.mixdownToBuffer(inPoint, outPoint);
          if (audioBuffer && audioBuffer.length > 0) {
            logger.info(
              `Audio mixed: ${audioBuffer.numberOfChannels}ch, ${audioBuffer.sampleRate}Hz, ${audioBuffer.length} samples`
            );
            onProgress?.({ stage: 'audio', progress: 1, message: 'Audio mixed' });
            return audioBuffer;
          }
          logger.warn('Audio mixdown returned empty buffer');
          onProgress?.({ stage: 'audio', progress: 1, message: 'No audio to mix' });
          return null;
        } catch (err) {
          logger.error('Audio mixdown failed, exporting without audio:', err);
          onProgress?.({
            stage: 'audio',
            progress: 1,
            message: 'Audio mixdown failed — exporting without audio'
          });
          return null;
        }
      })();

      // Create dedicated export canvas
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = preset.width;
      exportCanvas.height = preset.height;
      const exportCtx = exportCanvas.getContext('2d');

      if (this._cancelled) throw new Error('Export cancelled');

      // Try WebCodecs encode (GPU H.264, ~10-50x faster than WASM x264)
      const useWebCodecs = typeof VideoEncoder !== 'undefined' && preset.webCodecsCodec;
      let blob = null;

      if (useWebCodecs) {
        try {
          blob = await this._exportWithWebCodecs(
            preset,
            fps,
            inPoint,
            outPoint,
            totalFrames,
            exportCanvas,
            exportCtx,
            audioMixPromise,
            onProgress
          );
        } catch (wcErr) {
          logger.warn('WebCodecs encode failed, falling back to JPEG+FFmpeg:', wcErr);
          blob = null;
        }
      }

      // Fallback — JPEG frames + FFmpeg WASM encode
      if (!blob) {
        // Lazy-load FFmpeg (only needed for this fallback path)
        onProgress?.({ stage: 'loading', progress: 0, message: 'Loading FFmpeg...' });
        const ffmpegBridge = await this._loadFFmpeg(p => {
          onProgress?.({ stage: 'loading', progress: p, message: 'Loading FFmpeg...' });
        });
        const { frameFeeder } = await import('./FrameFeeder.js');

        onProgress?.({ stage: 'rendering', progress: 0, message: 'Rendering frames...' });

        // Batch size: 30 frames (~2-3 GOPs). Must be << bufferLimit (97) so
        // LRU doesn't evict frames we still need in the current batch.
        const jpegBatch = Math.min(30, totalFrames);
        await renderAheadManager.ensureBuffered(inPoint, jpegBatch);
        let jpegRendered = 0;

        const compositeFn = async frame => {
          await videoCompositor.compositeFrameTo(frame, exportCtx, preset.width, preset.height);
          // After compositing, pre-fill the NEXT batch so it's ready when we get there
          jpegRendered++;
          if (jpegRendered % jpegBatch === 0 && frame + 1 + jpegBatch <= outPoint) {
            try {
              await renderAheadManager.ensureBuffered(frame + 1, jpegBatch);
            } catch (err) {
              logger.warn('[Export] Pre-buffer failed, falling back to on-demand decode:', err);
            }
          }
        };
        const frameCount = await frameFeeder.feedFrames(
          inPoint,
          outPoint,
          exportCanvas,
          compositeFn,
          (p, current, total) => {
            if (this._cancelled) throw new Error('Export cancelled');
            onProgress?.({
              stage: 'rendering',
              progress: p,
              message: `Rendering frame ${current}/${total}`
            });
          }
        );

        if (this._cancelled) throw new Error('Export cancelled');

        // Await audio (should be done by now — ran in parallel with rendering)
        const audioBuffer = await audioMixPromise;
        const audioWavData = this._getAudioWavData(audioBuffer);

        // Write audio to FFmpeg FS
        let hasAudio = false;
        if (audioWavData) {
          await ffmpegBridge.writeFile('audio.wav', new Uint8Array(audioWavData));
          hasAudio = true;
        }

        // FFmpeg encode (use ultrafast preset for WASM speed)
        onProgress?.({ stage: 'encoding', progress: 0, message: 'Encoding video...' });
        ffmpegBridge.setProgressCallback(progress => {
          onProgress?.({ stage: 'encoding', progress, message: 'Encoding video...' });
        });

        const outputFilename = `output.${preset.format}`;
        const args = this._buildFFmpegArgs(preset, fps, frameCount, hasAudio, outputFilename);

        try {
          await ffmpegBridge.exec(args);
        } catch (err) {
          logger.error('FFmpeg encoding failed:', err);
          throw err;
        } finally {
          ffmpegBridge.setProgressCallback(null);
        }

        onProgress?.({ stage: 'encoding', progress: 1, message: 'Encoding complete' });

        const outputData = await ffmpegBridge.readFile(outputFilename);
        const mimeType = getMimeType(preset.format);
        blob = new Blob([outputData], { type: mimeType });

        // Cleanup JPEG frames
        await frameFeeder.cleanupFrames(frameCount);
        await ffmpegBridge.deleteFile(outputFilename);
        if (hasAudio) await ffmpegBridge.deleteFile('audio.wav');
      }

        logger.info(`Export blob: ${(blob.size / 1024 / 1024).toFixed(1)}MB`);

        this._resumeAfterExport();
        onProgress?.({ stage: 'complete', progress: 1, message: 'Export complete!' });

        return blob;
      } catch (err) {
        this._resumeAfterExport();

        // Suppress unhandled rejection from fire-and-forget promises
        audioMixPromise?.catch(() => {});

        // Clean up any temp files left in FFmpeg VFS from the JPEG+FFmpeg path
        try {
          if (ffmpegBridge?.isLoaded?.()) {
            const totalF = outPoint - inPoint;
            for (let i = 0; i < totalF; i++) {
              await ffmpegBridge
                .deleteFile(`frame_${String(i).padStart(6, '0')}.jpg`)
                .catch(() => {});
            }
            await ffmpegBridge.deleteFile('audio.wav').catch(() => {});
            await ffmpegBridge.deleteFile(`output.${preset.format}`).catch(() => {});
          }
        } catch (_) {
          /* best-effort cleanup */
        }

        if (err.message === 'Export cancelled') {
          onProgress?.({ stage: 'cancelled', progress: 0, message: 'Export cancelled' });
          return null;
        }
        logger.error('Export failed:', err);
        throw err;
      }
    } finally {
      this._exporting = false;
    }
  },

  // WebCodecs encode: composite → VideoFrame → GPU H.264 → FFmpeg mux (copy mode)
  // With Smart Rendering: stream-copyable segments skip decode+composite+encode entirely.
  // Pipelined: compositing and encoding overlap. Backpressure prevents OOM.
  async _exportWithWebCodecs(
    preset,
    fps,
    inPoint,
    outPoint,
    totalFrames,
    exportCanvas,
    exportCtx,
    audioMixPromise,
    onProgress
  ) {
    const { createWebCodecsEncoder } = await import('./WebCodecsEncoder.js');
    const { mediaDecoder } = await import('../media/MediaDecoder.js');
    const { streamCopyExtractor } = await import('./StreamCopyExtractor.js');

    // Resolve AVC level for actual export resolution (preset may say level 4.0 but 4K needs 5.1)
    const exportCodec =
      preset.webCodecsCodec && preset.webCodecsCodec.startsWith('avc1')
        ? getAvcCodecForResolution(preset.width, preset.height)
        : preset.webCodecsCodec;

    // Analyze timeline for stream-copy eligibility
    const segments = this._analyzeStreamCopy(inPoint, outPoint, preset);
    const copyFrames = segments
      .filter(s => s.type === 'copy')
      .reduce((sum, s) => sum + (s.end - s.start), 0);
    const conformFrames = segments
      .filter(s => s.type === 'conform-copy')
      .reduce((sum, s) => sum + (s.end - s.start), 0);
    const copyPct = Math.round((copyFrames / totalFrames) * 100);
    const conformPct = Math.round((conformFrames / totalFrames) * 100);
    const renderPct = 100 - copyPct - conformPct;
    logger.info(
      `[Export] Smart Render: ${copyPct}% stream-copy + ${conformPct}% conformed + ${renderPct}% encode (${segments.length} segments)`
    );

    // === Fast path: 100% conformed (all frames pre-encoded at sequence settings) ===
    if (conformFrames === totalFrames && conformFrames > 0) {
      onProgress?.({ stage: 'encoding', progress: 0, message: 'Conform copy (no re-encode)...' });

      try {
        const bitstream = conformEncoder.getPacketsForRange(inPoint, outPoint);
        if (bitstream.byteLength === 0) throw new Error('Empty conform bitstream');

        onProgress?.({
          stage: 'encoding',
          progress: 0.8,
          message: 'Conform copy complete, packaging...'
        });

        onProgress?.({ stage: 'muxing', progress: 0, message: 'Packaging video...' });
        const ffmpegBridge = await this._loadFFmpeg();
        const { muxToContainer } = await import('./Muxer.js');
        const audioBuffer = await audioMixPromise;
        const audioWavData = this._getAudioWavData(audioBuffer);
        const outputData = await muxToContainer(ffmpegBridge, bitstream, audioWavData, {
          codec: exportCodec,
          format: preset.format,
          fps,
          duration: totalFrames / fps,
          audioBitrate: preset.audioBitrate,
          audioSampleRate: preset.audioSampleRate
        });

        const mimeType = getMimeType(preset.format);
        logger.info(
          `[Export] Conform copy complete: ${(bitstream.byteLength / 1024 / 1024).toFixed(1)}MB`
        );
        return new Blob([outputData], { type: mimeType });
      } catch (ccErr) {
        logger.warn('[Export] Conform copy failed, falling back to full encode:', ccErr);
        // Fall through to normal encode
      }
    }

    // === Fast path: 100% stream copy (no encoding at all) ===
    if (copyPct === 100 && segments.length === 1) {
      onProgress?.({ stage: 'encoding', progress: 0, message: 'Stream copying (no re-encode)...' });

      try {
        const seg = segments[0];
        const clip = seg.clip;
        const sourceStartFrame = getSourceFrameAtPlayhead(clip, seg.start);
        const sourceEndFrame = getSourceFrameAtPlayhead(clip, seg.end - 1);
        if (sourceStartFrame == null || sourceEndFrame == null) {
          throw new Error('Could not resolve source frames for stream copy');
        }
        const sourceStartSec = frameToSeconds(sourceStartFrame);
        const sourceEndSec = frameToSeconds(sourceEndFrame + 1); // +1 for inclusive end

        const bitstream = await streamCopyExtractor.extractPackets(
          seg.mediaId,
          sourceStartSec,
          sourceEndSec,
          true
        );

        onProgress?.({
          stage: 'encoding',
          progress: 0.8,
          message: 'Stream copy complete, packaging...'
        });

        // Mux with FFmpeg (copy mode)
        onProgress?.({ stage: 'muxing', progress: 0, message: 'Packaging video...' });
        const ffmpegBridge = await this._loadFFmpeg();
        const { muxToContainer } = await import('./Muxer.js');
        const audioBuffer = await audioMixPromise;
        const audioWavData = this._getAudioWavData(audioBuffer);
        const outputData = await muxToContainer(ffmpegBridge, bitstream, audioWavData, {
          codec: exportCodec,
          format: preset.format,
          fps,
          duration: totalFrames / fps,
          audioBitrate: preset.audioBitrate,
          audioSampleRate: preset.audioSampleRate
        });

        const mimeType = getMimeType(preset.format);
        logger.info(
          `[Export] Smart Render complete: ${(bitstream.byteLength / 1024 / 1024).toFixed(1)}MB stream-copied`
        );
        return new Blob([outputData], { type: mimeType });
      } catch (scErr) {
        logger.warn('[Export] Stream copy failed, falling back to full encode:', scErr);
        // Fall through to normal encode path
      }
    }

    // === Hybrid path: mix conformed packets with freshly encoded render segments ===
    if (conformFrames > 0 && conformFrames < totalFrames) {
      try {
        const hybridEncoder = createWebCodecsEncoder({
          codec: exportCodec,
          width: preset.width,
          height: preset.height,
          bitrate: preset.videoBitrate,
          fps,
          bitrateMode: preset.bitrateMode,
          quality: preset.quality,
          outputColorSpace: colorManagement.getExportColorSpace(preset.outputSpace || 'rec709')
        });
        try {
          await hybridEncoder.init();
        } catch (initErr) {
          try {
            hybridEncoder.close();
          } catch (_) {}
          throw initErr;
        }

        mediaDecoder.startSequentialMode();

        const hybridCanvas = document.createElement('canvas');
        hybridCanvas.width = preset.width;
        hybridCanvas.height = preset.height;
        const hybridCtx = hybridCanvas.getContext('2d');

        const outputParts = []; // ordered array of Uint8Array segments
        let encoded = 0;
        const BATCH = 30;

        onProgress?.({
          stage: 'encoding',
          progress: 0,
          message: `Hybrid export: ${conformPct}% conformed + ${renderPct}% encode`
        });

        try {
          for (const seg of segments) {
            if (this._cancelled) throw new Error('Export cancelled');

            if (seg.type === 'conform-copy') {
              // Pull pre-encoded packets from cache.
              // The first packet MUST be a keyframe — without one, the decoder would
              // reference I-frames from a different encode session, causing macroblocking.
              // If not, demote this segment to render-encode (handled in the else branch).
              const firstPacket = conformEncoder.getPacket(seg.start);
              const segIsValid = firstPacket && firstPacket.isKeyframe;

              if (segIsValid) {
                // Pre-scan: verify all packets exist before committing any
                const segPackets = [];
                let segComplete = true;
                for (let f = seg.start; f < seg.end; f++) {
                  const packet = conformEncoder.getPacket(f);
                  if (packet) {
                    segPackets.push(packet.data);
                  } else {
                    segComplete = false;
                    break;
                  }
                }

                if (segComplete) {
                  for (const data of segPackets) outputParts.push(data);
                  encoded += segPackets.length;
                } else {
                  logger.warn(
                    `[Export] Hybrid: missing packets in conform segment ${seg.start}-${seg.end}, demoting to render`
                  );
                  seg.type = 'render';
                }
              } else {
                // Demote: re-encode via render path (falls through to else branch logic)
                logger.info(
                  `[Export] Hybrid: demoting conform segment ${seg.start}-${seg.end} (no keyframe at start)`
                );
                seg.type = 'render';
              }
            }

            if (seg.type !== 'conform-copy') {
              // Render segment — composite + encode with rolling prefetch
              const segLen = seg.end - seg.start;
              await renderAheadManager.ensureBuffered(seg.start, Math.min(BATCH, segLen));

              let prefetchPromise = null;
              const prefetchNext = from => {
                const remaining = seg.end - from;
                if (remaining > 0) {
                  prefetchPromise = renderAheadManager
                    .ensureBuffered(from, Math.min(BATCH, remaining))
                    .catch(err => logger.warn('[Export] Hybrid pre-buffer failed:', err));
                } else {
                  prefetchPromise = null;
                }
              };
              prefetchNext(seg.start + BATCH);

              let segEncoded = 0;
              for (let f = seg.start; f < seg.end; f++) {
                if (this._cancelled) throw new Error('Export cancelled');
                await hybridEncoder.waitForDrain(8);

                // Rolling prefetch at batch boundaries
                if (segEncoded > 0 && segEncoded % BATCH === 0) {
                  if (prefetchPromise) await prefetchPromise;
                  if (this._cancelled) throw new Error('Export cancelled');
                  prefetchNext(f + BATCH);
                }

                await videoCompositor.compositeFrameTo(f, hybridCtx, preset.width, preset.height);
                const timestampUs = Math.round((encoded / fps) * 1000000);

                // Force keyframe at render segment start (clean IDR boundary)
                if (f === seg.start) {
                  hybridEncoder.encodeFrameKeyframe(hybridCanvas, timestampUs);
                } else {
                  hybridEncoder.encodeFrame(hybridCanvas, timestampUs);
                }
                encoded++;
                segEncoded++;

                onProgress?.({
                  stage: 'encoding',
                  progress: encoded / totalFrames,
                  message: `Hybrid: ${encoded}/${totalFrames} frames`
                });
              }

              // Flush encoder — ensures no B-frame refs leak into next segment
              await hybridEncoder.flush();
              outputParts.push(hybridEncoder.getAndClearEncodedData());
            }

            if (seg.type === 'conform-copy') {
              onProgress?.({
                stage: 'encoding',
                progress: encoded / totalFrames,
                message: `Hybrid: ${encoded}/${totalFrames} frames`
              });
            }
          }

          // Concatenate all segment data
          const totalSize = outputParts.reduce((sum, d) => sum + d.byteLength, 0);
          const videoData = new Uint8Array(totalSize);
          let offset = 0;
          for (const part of outputParts) {
            videoData.set(part, offset);
            offset += part.byteLength;
          }

          // Mux
          onProgress?.({ stage: 'muxing', progress: 0, message: 'Packaging video...' });
          const ffmpegBridge = await this._loadFFmpeg();
          const { muxToContainer } = await import('./Muxer.js');
          const audioBuffer = await audioMixPromise;
          const audioWavData = this._getAudioWavData(audioBuffer);
          const outputData = await muxToContainer(ffmpegBridge, videoData, audioWavData, {
            codec: exportCodec,
            format: preset.format,
            fps,
            duration: totalFrames / fps,
            audioBitrate: preset.audioBitrate,
            audioSampleRate: preset.audioSampleRate
          });

          const mimeType = getMimeType(preset.format);
          logger.info(
            `[Export] Hybrid complete: ${conformPct}% conform-copy + ${renderPct}% encoded, ${(totalSize / 1024 / 1024).toFixed(1)}MB`
          );
          return new Blob([outputData], { type: mimeType });
        } finally {
          hybridEncoder.close();
          mediaDecoder.endSequentialMode();
        }
      } catch (hybridErr) {
        logger.warn('[Export] Hybrid export failed, falling back to full encode:', hybridErr);
        // Fall through to full encode
      }
    }

    // === Normal path: full encode ===
    const encoder = createWebCodecsEncoder({
      codec: exportCodec,
      width: preset.width,
      height: preset.height,
      bitrate: preset.videoBitrate,
      fps,
      bitrateMode: preset.bitrateMode,
      quality: preset.quality,
      avcFormat: 'avc', // AVCC format for MediaBunny muxer (not Annex B)
      outputColorSpace: colorManagement.getExportColorSpace(preset.outputSpace || 'rec709')
    });

    await encoder.init();
    logger.info('Using WebCodecs hardware encode (fast path)');

    // Enable sequential decode mode for all WebCodecs decoders
    mediaDecoder.startSequentialMode();

    // Double-buffer canvases to avoid GPU read-back stalls
    const canvasA = exportCanvas;
    const ctxA = exportCtx;
    const canvasB = document.createElement('canvas');
    canvasB.width = preset.width;
    canvasB.height = preset.height;
    const ctxB = canvasB.getContext('2d');

    onProgress?.({ stage: 'encoding', progress: 0, message: 'Encoding (GPU)...' });

    let encoded = 0;
    let useA = true;

    // Batch size: fill this many frames into the buffer at a time.
    // Must be less than bufferLimit so LRU doesn't evict frames we need.
    // VLC decode-ahead fills ~30 frames per tick; align batch to that cadence.
    const BATCH = Math.min(30, totalFrames);

    // Pre-fill the first batch — awaited so first frames are guaranteed in buffer
    await renderAheadManager.ensureBuffered(inPoint, BATCH);

    // Kick off non-blocking prefetch for the next batch so decode overlaps with encode
    let prefetchPromise = null;
    const prefetchNext = from => {
      const remaining = outPoint - from;
      if (remaining > 0) {
        prefetchPromise = renderAheadManager
          .ensureBuffered(from, Math.min(BATCH, remaining))
          .catch(err => logger.warn('[Export] Pre-buffer failed:', err));
      } else {
        prefetchPromise = null;
      }
    };
    prefetchNext(inPoint + BATCH);

    try {
      for (let frame = inPoint; frame < outPoint; frame++) {
        if (this._cancelled) throw new Error('Export cancelled');

        // Backpressure: event-driven wait — GPU stays fed with 8-12 frames in-flight
        await encoder.waitForDrain(8);

        // At each batch boundary, await the already-started prefetch, then start the next
        if (encoded > 0 && encoded % BATCH === 0) {
          if (prefetchPromise) await prefetchPromise;
          if (this._cancelled) throw new Error('Export cancelled');
          prefetchNext(frame + BATCH);
        }

        // Composite to the current buffer
        const canvas = useA ? canvasA : canvasB;
        const ctx = useA ? ctxA : ctxB;
        await videoCompositor.compositeFrameTo(frame, ctx, preset.width, preset.height);

        const timestampUs = Math.round((encoded / fps) * 1000000);
        encoder.encodeFrame(canvas, timestampUs);

        // Swap buffers
        useA = !useA;

        encoded++;
        onProgress?.({
          stage: 'encoding',
          progress: encoded / totalFrames,
          message: `Encoding frame ${encoded}/${totalFrames} (GPU)`
        });
      }

      await encoder.flush();
      const chunks = encoder.getChunks();
      logger.info(`WebCodecs encoded ${encoded} frames, ${chunks.length} chunks`);

      // Mux with MediaBunny (instant — no FFmpeg CDN download needed)
      onProgress?.({ stage: 'muxing', progress: 0, message: 'Packaging video...' });
      const audioBuffer = await audioMixPromise;
      const outputData = await muxWithMediaBunny(chunks, audioBuffer, {
        codec: exportCodec,
        format: preset.format,
        fps,
        duration: totalFrames / fps,
        audioBitrate: preset.audioBitrate,
        audioSampleRate: preset.audioSampleRate
      });

      const mimeType = getMimeType(preset.format);
      return new Blob([outputData], { type: mimeType });
    } finally {
      try {
        encoder.close();
      } catch (_) {
        /* already closed */
      }
      mediaDecoder.endSequentialMode();
    }
  },

  // Analyze timeline for stream-copy eligibility.
  // Returns array of segments: { type: 'copy'|'render', start, end, mediaId?, clip? }
  // where start/end are timeline frame numbers (inclusive start, exclusive end).
  _analyzeStreamCopy(inPoint, outPoint, preset) {
    const videoTracks = timelineEngine.getVideoTracks();
    const fps = preset.fps || editorState.get(STATE_PATHS.PROJECT_FRAME_RATE);
    const isH264Export = preset.webCodecsCodec && preset.webCodecsCodec.startsWith('avc1');

    // Frame-by-frame analysis: classify each frame
    // Values: null (gap), 'copy' (stream-copyable), 'render' (needs compositing)
    const frameTypes = new Array(outPoint - inPoint);
    const frameClips = new Array(outPoint - inPoint); // clip reference for copy frames

    // Track per-clip rejection reasons (first reason only, to avoid log spam)
    const clipRejectReasons = new Map(); // clipId -> reason string

    for (let frame = inPoint; frame < outPoint; frame++) {
      const idx = frame - inPoint;
      const visibleClips = [];

      for (const track of videoTracks) {
        if (track.muted) continue;
        for (const clip of track.clips) {
          if (clip.disabled) continue;
          if (!clipContainsFrame(clip, frame)) continue;
          const mediaItem = mediaManager.getItem(clip.mediaId);
          if (!mediaItem) continue;
          if (mediaItem.type === MEDIA_TYPES.VIDEO || mediaItem.type === MEDIA_TYPES.IMAGE) {
            visibleClips.push({ clip, track, mediaItem });
          }
        }
      }

      // No video = gap (black frame) → must render
      if (visibleClips.length === 0) {
        frameTypes[idx] = 'render';
        continue;
      }

      // Multiple clips visible = compositing needed → must render
      if (visibleClips.length > 1) {
        frameTypes[idx] = 'render';
        continue;
      }

      const { clip, track, mediaItem } = visibleClips[0];

      // Helper: record first rejection reason per clip
      const reject = reason => {
        if (!clipRejectReasons.has(clip.id)) {
          clipRejectReasons.set(clip.id, reason);
        }
        frameTypes[idx] = 'render';
      };

      // Only video clips can be stream-copied (not images)
      if (mediaItem.type !== MEDIA_TYPES.VIDEO) {
        reject('not a video clip');
        continue;
      }

      // Check transition overlap
      const hasTransition = (track.transitions || []).some(t => {
        const clipA = track.clips.find(c => c.id === t.clipAId);
        if (!clipA) return false;
        const editPoint = getClipEndFrame(clipA);
        const { start, end } = getTransitionZone(t, editPoint);
        return frame >= start && frame < end;
      });
      if (hasTransition) {
        reject('has transition');
        continue;
      }

      // Speed must be 1.0
      if (clip.speed !== 1) {
        reject(`speed=${clip.speed} (must be 1.0)`);
        continue;
      }

      // Source codec must be H.264 and export must be H.264.
      // Only allow stream copy when codec is positively confirmed — unknown codec
      // could be VP9/HEVC which would produce corrupt output if stream-copied as H.264.
      if (!isH264Export) {
        reject('export codec is not H.264');
        continue;
      }
      if (!mediaItem.codec) {
        reject('source codec unknown (decoder not initialized?)');
        continue;
      }
      if (!mediaItem.codec.startsWith('avc1')) {
        reject(`source codec=${mediaItem.codec} (must be avc1.*)`);
        continue;
      }

      // Source resolution must match export resolution
      const resolutionMismatch =
        mediaItem.width &&
        mediaItem.height &&
        (mediaItem.width !== preset.width || mediaItem.height !== preset.height);

      // Source fps must match export fps
      const fpsMismatch = mediaItem.fps && Math.abs(mediaItem.fps - fps) > 0.5;

      // Check effects: all must be at defaults
      if (this._clipNeedsProcessing(clip, preset.width, preset.height)) {
        reject('has non-default effects');
        continue;
      }

      // If rejected for resolution/fps mismatch, check for conformed packets
      // (codec is already confirmed H.264 match by the checks above)
      if (resolutionMismatch || fpsMismatch) {
        const conformPacket = conformEncoder.getPacket(frame);
        if (conformPacket) {
          frameTypes[idx] = 'conform-copy';
          frameClips[idx] = clip;
        } else {
          const reasons = [];
          if (resolutionMismatch)
            reasons.push(
              `resolution ${mediaItem.width}x${mediaItem.height} != ${preset.width}x${preset.height}`
            );
          if (fpsMismatch) reasons.push(`fps ${mediaItem.fps.toFixed(1)} != ${fps}`);
          reject(reasons.join(', '));
        }
        continue;
      }

      // All checks passed — this frame is stream-copyable from raw source
      frameTypes[idx] = 'copy';
      frameClips[idx] = clip;
    }

    // Promote 'render' frames to 'conform-copy' when a pre-encoded packet exists.
    // The stream-copy analysis above only checks conform for the narrow resolution/fps
    // mismatch case. The conform encoder pre-encodes ALL frames (effects, multi-track,
    // transitions, etc.), so check for packets on every render frame.
    for (let i = 0; i < frameTypes.length; i++) {
      if (frameTypes[i] === 'render') {
        const conformPacket = conformEncoder.getPacket(inPoint + i);
        if (conformPacket) {
          frameTypes[i] = 'conform-copy';
        }
      }
    }

    // Log rejection reasons for debugging
    if (clipRejectReasons.size > 0) {
      for (const [clipId, reason] of clipRejectReasons) {
        logger.info(`[Export] Stream copy rejected for ${clipId}: ${reason}`);
      }
    }

    // Merge consecutive frames of the same type into segments
    const segments = [];
    let segStart = 0;
    let segType = frameTypes[0];
    let segClip = frameClips[0];

    for (let i = 1; i <= frameTypes.length; i++) {
      const curType = i < frameTypes.length ? frameTypes[i] : null;
      const curClip = i < frameTypes.length ? frameClips[i] : null;

      // Same type AND same clip (for copy segments) → extend
      if (
        curType === segType &&
        (segType !== 'copy' || (curClip && segClip && curClip.id === segClip.id))
      ) {
        continue;
      }

      // Emit segment
      segments.push({
        type: segType,
        start: inPoint + segStart,
        end: inPoint + i,
        ...(segType === 'copy' && segClip
          ? {
              mediaId: segClip.mediaId,
              clip: segClip
            }
          : {})
      });

      segStart = i;
      segType = curType;
      segClip = curClip;
    }

    return segments;
  },

  // Check if a clip needs any visual processing (mirrors VideoCompositor logic)
  _clipNeedsProcessing(clip, canvasWidth, canvasHeight) {
    const effects = (clip.effects || []).filter(fx => fx.enabled);
    for (const fx of effects) {
      // Intrinsic opacity at default
      if (fx.intrinsic && fx.effectId === 'opacity') {
        if (fx.keyframes?.opacity?.length > 0 || fx.params.opacity !== 100) return true;
        continue;
      }
      // Audio effects don't affect video
      if (fx.intrinsic && fx.effectId === 'audio-volume') continue;
      if (fx.intrinsic && (fx.effectId === 'panner' || fx.effectId === 'channel-volume')) continue;
      // Time remap doesn't affect visuals (handled by speed)
      if (fx.intrinsic && fx.effectId === 'time-remap') continue;
      // Motion at defaults = no processing
      if (fx.intrinsic && fx.effectId === 'motion') {
        const p = fx.params;
        const cx = canvasWidth / 2;
        const cy = canvasHeight / 2;
        if (p.posX !== cx || p.posY !== cy) return true;
        if (p.scale !== 100 || p.scaleWidth !== 100) return true;
        if (p.rotation !== 0) return true;
        if (p.anchorX !== cx || p.anchorY !== cy) return true;
        if (p.antiFlicker !== 0) return true;
        if (p.cropLeft !== 0 || p.cropTop !== 0 || p.cropRight !== 0 || p.cropBottom !== 0)
          return true;
        const kf = fx.keyframes;
        if (kf) {
          for (const key of Object.keys(kf)) {
            if (kf[key] && kf[key].length > 0) return true;
          }
        }
        continue;
      }
      // Any other enabled effect = needs processing
      return true;
    }
    return false;
  },

  _getAudioWavData(audioBuffer) {
    if (!audioBuffer) return null;
    return this._audioBufferToWav(audioBuffer);
  },

  async _loadFFmpeg(onProgress) {
    const mod = await import('./FFmpegBridge.js');
    ffmpegBridge = mod.ffmpegBridge;
    await ffmpegBridge.load(onProgress);
    return ffmpegBridge;
  },

  _buildFFmpegArgs(preset, fps, frameCount, hasAudio, outputFilename) {
    const args = ['-framerate', String(fps), '-i', 'frame_%06d.jpg'];

    if (hasAudio) {
      args.push('-i', 'audio.wav');
    }

    if (preset.videoCodec) {
      args.push('-c:v', preset.videoCodec);
    }

    if (preset.pixelFormat) {
      args.push('-pix_fmt', preset.pixelFormat);
    }

    // Rate control: VBR uses CRF with maxrate cap, CBR uses fixed bitrate
    const isVBR = preset.bitrateMode !== 'constant';
    const isVP9 = preset.videoCodec === 'libvpx-vp9';

    if (isVBR && preset.videoCodec) {
      const codecKey = isVP9 ? 'vp9' : 'h264';
      const quality = preset.quality || 'medium';
      const crf = QUALITY_CRF[quality]?.[codecKey] ?? QUALITY_CRF.medium[codecKey];
      args.push('-crf', String(crf));

      if (isVP9) {
        // VP9 requires -b:v 0 with -crf for quality mode
        args.push('-b:v', '0');
      }

      if (preset.videoBitrate) {
        args.push('-maxrate', preset.videoBitrate);
        // Buffer size = 2x bitrate for VBR headroom
        const bitrateNum = parseInt(preset.videoBitrate);
        const unit = preset.videoBitrate.replace(/[\d.]/g, '');
        args.push('-bufsize', `${bitrateNum * 2}${unit}`);
      }
    } else if (preset.videoBitrate) {
      // CBR: fixed bitrate with maxrate matching and 2x bufsize for rate smoothing
      args.push('-b:v', preset.videoBitrate);
      args.push('-maxrate', preset.videoBitrate);
      const cbrBitrateNum = parseInt(preset.videoBitrate);
      const cbrUnit = preset.videoBitrate.replace(/[\d.]/g, '');
      args.push('-bufsize', `${cbrBitrateNum * 2}${cbrUnit}`);
    }

    // Encoder speed preset: respect preset setting, fall back based on threading
    if (preset.videoCodec && !isVP9) {
      if (ffmpegBridge.isMultiThreaded()) {
        args.push('-preset', preset.preset || 'fast');
        args.push('-threads', '0');
      } else {
        args.push('-preset', preset.preset || 'ultrafast');
      }
    }

    if (hasAudio && preset.audioCodec) {
      args.push('-c:a', preset.audioCodec);
      if (preset.audioBitrate) args.push('-b:a', preset.audioBitrate);
      if (preset.audioSampleRate) args.push('-ar', String(preset.audioSampleRate));
    }

    // Color space metadata tagging
    const colorFlags = getFFmpegColorFlags(preset.outputSpace || 'rec709');
    args.push(...colorFlags);

    // Set exact output duration = sequence length (like Premiere Pro)
    // Video frames define the duration; audio is padded/trimmed to match
    const duration = frameCount / fps;
    args.push('-t', duration.toFixed(6));

    args.push('-y', outputFilename);
    return args;
  },

  _audioBufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataLength = length * blockAlign;
    const headerLength = 44;
    const totalLength = headerLength + dataLength;

    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);

    // WAV header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, totalLength - 8, true);
    this._writeString(view, 8, 'WAVE');
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Interleave channels
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(audioBuffer.getChannelData(ch));
    }

    let offset = headerLength;
    for (let i = 0; i < length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = clamp(channels[ch][i], -1, 1);
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
      }
    }

    return buffer;
  },

  _writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  },

  // Trigger browser download of a blob
  download(blob, filename) {
    if (!blob || blob.size === 0) {
      logger.error('Download failed: blob is empty');
      return;
    }
    logger.info(`Downloading ${filename} (${(blob.size / 1024 / 1024).toFixed(1)}MB)`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    // Use setTimeout to ensure the click happens in a clean call stack
    setTimeout(() => {
      a.click();
      document.body.removeChild(a);
      // Delay revoking to ensure download completes
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    }, 100);
  },

  // Check if Worker-based export is available
  _canUseWorker() {
    // Requires: Web Workers, OffscreenCanvas, Cache API (for FFmpeg pre-warming)
    if (typeof Worker === 'undefined') return false;
    if (typeof OffscreenCanvas === 'undefined') return false;
    if (typeof caches === 'undefined') return false;
    return true;
  },

  // Serialize timeline state for transfer to Worker
  _serializeTimeline() {
    const tracks = [];
    for (const track of [
      ...(timelineEngine.getVideoTracks() || []),
      ...(timelineEngine.getAudioTracks() || [])
    ]) {
      tracks.push(
        JSON.parse(
          JSON.stringify({
            id: track.id,
            type: track.type,
            muted: track.muted,
            clips: track.clips.map(c => ({
              id: c.id,
              name: c.name || '',
              mediaId: c.mediaId,
              linkedClipId: c.linkedClipId || null,
              startFrame: c.startFrame,
              sourceInFrame: c.sourceInFrame ?? 0,
              sourceOutFrame: c.sourceOutFrame ?? 0,
              speed: c.speed ?? 1,
              disabled: c.disabled,
              effects: (c.effects || []).map(fx => ({
                id: fx.id,
                effectId: fx.effectId,
                enabled: fx.enabled,
                intrinsic: !!fx.intrinsic,
                params: { ...fx.params },
                keyframes: fx.keyframes || {}
              }))
            })),
            transitions: track.transitions || []
          })
        )
      );
    }
    return tracks;
  },

  // Collect media for Worker transfer.
  // Videos/audio pass File references (~0 cost, structured-cloneable).
  // Images are small so we keep them as blobs for compatibility.
  async _collectMediaForWorker() {
    const items = [];

    for (const item of mediaManager.getAllItems()) {
      const entry = { id: item.id, type: item.type, name: item.name };

      if (item.type === 'image') {
        // Images are small — fetch as blob for compatibility
        try {
          const response = await fetch(item.url);
          const buffer = await response.arrayBuffer();
          entry.blob = new Blob([buffer], { type: 'image/*' });
        } catch (e) {
          logger.warn(`Could not collect image ${item.name} for Worker:`, e);
        }
      } else if (item.file) {
        // Video/audio: pass File reference (structured-cloneable, ~0 cost)
        entry.file = item.file;
      }

      items.push(entry);
    }

    // No transferList needed — File objects are cloned, not transferred
    return { items, transferList: [] };
  },

  // Export via Web Worker (off main thread)
  async _exportViaWorker(preset, onProgress) {
    const fps = preset.fps || editorState.get(STATE_PATHS.PROJECT_FRAME_RATE);
    const duration = timelineEngine.getDuration();
    const inPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT) ?? 0;
    const outPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT) ?? duration;

    logger.info('Using Worker export path (UI stays responsive)');
    onProgress?.({ stage: 'loading', progress: 0, message: 'Preparing Worker export...' });

    // Pre-warm FFmpeg cache so the Worker loads from cache (instant) not CDN (15s)
    const { ffmpegBridge } = await import('./FFmpegBridge.js');
    await ffmpegBridge.ensureCacheWarm();

    // Collect media
    const { items: media, transferList } = await this._collectMediaForWorker();
    const tracks = this._serializeTimeline();
    const mediaItems = media.map(m => ({ id: m.id, type: m.type, name: m.name }));

    // Audio mixdown on main thread (needs AudioContext)
    let audioWavData = null;
    try {
      const audioBuffer = await audioMixer.mixdownToBuffer(inPoint, outPoint);
      if (audioBuffer && audioBuffer.length > 0) {
        audioWavData = this._audioBufferToWav(audioBuffer);
        logger.info(`Worker audio WAV: ${(audioWavData.byteLength / 1024).toFixed(0)}KB`);
      } else {
        logger.warn('Audio mixdown for Worker returned empty buffer');
      }
    } catch (e) {
      logger.error('Audio mixdown for Worker failed:', e);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimeout);
        fn(val);
      };

      const worker = new Worker(new URL('./ExportWorker.js', import.meta.url), { type: 'module' });
      this._activeWorker = worker;

      // Timeout if Worker never responds (module load failure, FFmpeg hang, etc.)
      // With warm cache, init takes <2s. Allow 30s for cold-cache fallback.
      const initTimeout = setTimeout(() => {
        logger.warn('Worker export timed out during init (30s)');
        worker.terminate();
        settle(reject, new Error('Worker init timeout'));
      }, 30000);

      // Serialize effect definitions for the worker (id + type only — apply() can't be transferred)
      const serializedEffects = effectRegistry.getAll().map(def => ({
        id: def.id,
        type: def.type
      }));

      // Init
      worker.postMessage(
        {
          type: 'init',
          data: {
            width: preset.width,
            height: preset.height,
            media,
            effectRegistry: serializedEffects
          }
        },
        transferList
      );

      worker.onmessage = e => {
        const msg = e.data;

        switch (msg.type) {
          case 'log':
            logger.info(msg.message);
            break;

          case 'init_complete':
            clearTimeout(initTimeout);
            worker.postMessage({
              type: 'start',
              data: { preset, tracks, inPoint, outPoint, fps, mediaItems, audioWavData }
            });
            break;

          case 'progress': {
            const stageMessages = {
              loading: 'Loading FFmpeg...',
              rendering: msg.current
                ? `Rendering frame ${msg.current}/${msg.total}`
                : 'Rendering frames...',
              encoding: msg.current
                ? `Encoding frame ${msg.current}/${msg.total} (GPU)`
                : 'Encoding video...',
              muxing: 'Packaging video...'
            };
            onProgress?.({
              stage: msg.stage,
              progress: msg.progress,
              message: stageMessages[msg.stage] || `${msg.stage}...`
            });
            break;
          }

          case 'complete': {
            const blob = new Blob([msg.buffer], { type: msg.mimeType });
            this._activeWorker = null;
            worker.terminate();
            settle(resolve, blob);
            break;
          }

          case 'cancelled':
            this._activeWorker = null;
            worker.terminate();
            settle(resolve, null);
            break;

          case 'error':
            this._activeWorker = null;
            worker.terminate();
            settle(reject, new Error(msg.error));
            break;
        }
      };

      worker.onerror = err => {
        this._activeWorker = null;
        worker.terminate();
        settle(reject, err);
      };
    });
  }
};

export default exportPipeline;

// MP4 demuxer using mp4box.js -- extracts encoded video/audio chunks
import logger from '../../utils/logger.js';

export function createDemuxer() {
  let mp4boxFile = null;
  let videoTrack = null;
  let audioTrack = null;

  return {
    _ready: false,
    _mp4boxFile: null,
    _initCalled: false,

    async init(fileOrBuffer, callbacks = {}) {
      if (this._initCalled) {
        throw new Error('Demuxer.init() already called — create a new demuxer instance instead of re-initializing');
      }
      this._initCalled = true;

      const mp4box = await import('mp4box');
      this._mp4box = mp4box;
      const createMP4File = mp4box.createFile || mp4box.default?.createFile;
      if (!createMP4File) throw new Error('mp4box module missing createFile');
      mp4boxFile = createMP4File();
      this._mp4boxFile = mp4boxFile;

      return new Promise((resolve, reject) => {
        mp4boxFile.onReady = (info) => {
          this._ready = true;

          // Find video track
          for (const track of info.tracks) {
            if (track.type === 'video' && !videoTrack) {
              videoTrack = track;
            } else if (track.type === 'audio' && !audioTrack) {
              audioTrack = track;
            }
          }

          if (videoTrack) {
            // Extract codec description for VideoDecoder config
            const trak = mp4boxFile.getTrackById(videoTrack.id);
            const codecDesc = this._getCodecDescription(trak);

            callbacks.onVideoConfig?.({
              codec: videoTrack.codec,
              codedWidth: videoTrack.video.width,
              codedHeight: videoTrack.video.height,
              description: codecDesc
            });

            mp4boxFile.setExtractionOptions(videoTrack.id, 'video', {
              nbSamples: 1000
            });
          }

          // Start extraction now, before flush() can release buffer data.
          // processSamples() fires onSamples synchronously.
          this._started = true;
          mp4boxFile.start();

          this._readyInfo = info;
          // For ArrayBuffer path, resolve immediately (all data available)
          if (fileOrBuffer instanceof ArrayBuffer) resolve(info);
          // For streaming path, resolve is deferred until sample table is extracted
        };

        mp4boxFile.onError = (err) => {
          logger.error('MP4Box error:', err);
          reject(err);
        };

        mp4boxFile.onSamples = (trackId, ref, samples) => {
          for (const sample of samples) {
            if (ref === 'video') {
              const chunk = new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp: (sample.cts * 1000000) / sample.timescale,
                duration: (sample.duration * 1000000) / sample.timescale,
                data: sample.data
              });
              callbacks.onVideoChunk?.(chunk, sample);
            }
          }
        };

        if (fileOrBuffer instanceof ArrayBuffer) {
          // Legacy path: one-shot (all data available for onSamples)
          fileOrBuffer.fileStart = 0;
          mp4boxFile.appendBuffer(fileOrBuffer);
        } else {
          // Streaming path: parse moov incrementally, then extract full sample
          // table from the parsed moov (onSamples only fires for fed mdat data).
          this._parseIncremental(fileOrBuffer).then(() => {
            if (!this._ready) {
              reject(new Error('No moov atom found — file may be corrupt or not an MP4'));
              return;
            }
            this._extractSampleTableFromMoov(callbacks);
            resolve(this._readyInfo);
          }).catch(reject);
        }
      });
    },

    async _parseIncremental(file) {
      const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
      let offset = 0;

      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const slice = file.slice(offset, end);
        const ab = await slice.arrayBuffer();
        ab.fileStart = offset;

        this._mp4boxFile.appendBuffer(ab);

        // mp4box returns the next byte offset it needs.
        // If it jumps (moov at end of file), follow it.
        const nextNeeded = this._mp4boxFile.nextParsePosition;
        if (nextNeeded && nextNeeded > 0 && nextNeeded <= file.size && nextNeeded > end) {
          offset = nextNeeded;
        } else {
          offset = end;
        }

        // Stop once moov is fully parsed — we have the complete sample table
        if (this._ready) break;
      }

      // Release mp4box's internal buffer copies — we have the sample
      // metadata (offsets/sizes) and will use File.slice() for data.
      this._mp4boxFile.flush();
    },

    // Extract ALL sample metadata from mp4box's parsed moov atom.
    // Called after moov parsing when using the streaming path — onSamples
    // only fires for samples whose mdat data was fed, but the moov contains
    // the complete sample table (offsets, sizes, timestamps) for the entire file.
    _extractSampleTableFromMoov(callbacks) {
      if (!this._mp4boxFile || !videoTrack) return;

      const trak = this._mp4boxFile.getTrackById(videoTrack.id);
      if (!trak || !trak.samples || trak.samples.length === 0) {
        logger.warn('[Demuxer] No samples in moov sample table');
        return;
      }

      const ts = videoTrack.timescale;
      for (const sample of trak.samples) {
        // Build a minimal sample-like object for the onVideoChunk callback
        // (matches the format that onSamples provides)
        const fakeSample = {
          is_sync: sample.is_sync,
          offset: sample.offset,
          size: sample.size,
          cts: sample.cts,
          dts: sample.dts,
          duration: sample.duration,
          timescale: ts
        };

        // Create a lightweight placeholder chunk (no actual data — just metadata)
        const fakeChunk = {
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: (sample.cts * 1000000) / ts,
          duration: (sample.duration * 1000000) / ts
        };

        callbacks.onVideoChunk?.(fakeChunk, fakeSample);
      }

      logger.info(`[Demuxer] Extracted ${trak.samples.length} samples from moov sample table`);
    },

    _mp4box: null, // cached module reference

    // Manual avcC serializer — writes ISO 14496-15 AVCDecoderConfigurationRecord
    // bytes via DataView. mp4box's DataStream.write() produces broken output for
    // H.264 High profile (100/110/122/144) — missing chroma_format, bit_depth_luma,
    // bit_depth_chroma, SPS_Ext extension bytes that VideoDecoder requires.
    _serializeAvcC(box) {
      // Convert NALU data to Uint8Array regardless of source type.
      // mp4box may produce typed arrays from a different realm (e.g. in Workers),
      // so instanceof checks fail. Use duck-typing on byteLength instead.
      const toU8 = (data) => {
        if (!data || typeof data.byteLength !== 'number') return null;
        // Always copy to a fresh buffer to avoid cross-realm instanceof failures
        // and shared-buffer offset issues with mp4box internal buffers
        if (data.buffer) {
          const start = data.byteOffset || 0;
          return new Uint8Array(data.buffer.slice(start, start + data.byteLength));
        }
        return new Uint8Array(data);
      };

      // Collect SPS/PPS NALUs
      // mp4box stores NALUs as {length, data} objects — check .data, .nalu, then the entry itself
      const spsNalus = [];
      for (const set of (box.SPS || [])) {
        const nalu = toU8(set.data) || toU8(set.nalu) || toU8(set);
        if (nalu && nalu.byteLength > 0) spsNalus.push(nalu);
      }
      const ppsNalus = [];
      for (const set of (box.PPS || [])) {
        const nalu = toU8(set.data) || toU8(set.nalu) || toU8(set);
        if (nalu && nalu.byteLength > 0) ppsNalus.push(nalu);
      }

      // Determine if High profile extension bytes are needed
      const profileIdc = box.AVCProfileIndication || 0;
      const needsExt = [100, 110, 122, 144].includes(profileIdc);
      const spsExtNalus = needsExt ? (box.SPS_Ext || []).map(s => {
        return toU8(s.data) || toU8(s.nalu) || toU8(s) || new Uint8Array(0);
      }).filter(n => n.byteLength > 0) : [];

      // Calculate total size
      let size = 6; // header: configVersion(1) + profile(1) + compat(1) + level(1) + lengthSize(1) + numSPS(1)
      for (const sps of spsNalus) size += 2 + sps.byteLength;
      size += 1; // numPPS
      for (const pps of ppsNalus) size += 2 + pps.byteLength;
      if (needsExt) {
        size += 4; // chroma(1) + bitDepthLuma(1) + bitDepthChroma(1) + numSPSExt(1)
        for (const ext of spsExtNalus) size += 2 + ext.byteLength;
      }

      const buf = new ArrayBuffer(size);
      const view = new DataView(buf);
      const arr = new Uint8Array(buf);
      let offset = 0;

      // AVCDecoderConfigurationRecord
      view.setUint8(offset++, box.configurationVersion || 1);
      view.setUint8(offset++, profileIdc);
      view.setUint8(offset++, box.profile_compatibility || 0);
      view.setUint8(offset++, box.AVCLevelIndication || 0);
      view.setUint8(offset++, 0xFC | ((box.lengthSizeMinusOne ?? 3) & 0x03));
      view.setUint8(offset++, 0xE0 | (spsNalus.length & 0x1F));

      for (const sps of spsNalus) {
        view.setUint16(offset, sps.byteLength);
        offset += 2;
        arr.set(sps, offset);
        offset += sps.byteLength;
      }

      view.setUint8(offset++, ppsNalus.length & 0xFF);
      for (const pps of ppsNalus) {
        view.setUint16(offset, pps.byteLength);
        offset += 2;
        arr.set(pps, offset);
        offset += pps.byteLength;
      }

      // High profile extension bytes (ISO 14496-15 section 5.2.4.1.1)
      if (needsExt) {
        view.setUint8(offset++, 0xFC | ((box.chroma_format ?? 1) & 0x03));
        view.setUint8(offset++, 0xF8 | ((box.bit_depth_luma_minus8 ?? 0) & 0x07));
        view.setUint8(offset++, 0xF8 | ((box.bit_depth_chroma_minus8 ?? 0) & 0x07));
        view.setUint8(offset++, spsExtNalus.length & 0xFF);
        for (const ext of spsExtNalus) {
          view.setUint16(offset, ext.byteLength);
          offset += 2;
          arr.set(ext, offset);
          offset += ext.byteLength;
        }
      }

      return new Uint8Array(buf);
    },

    _getCodecDescription(trak) {
      try {
        const entry = trak.mdia.minf.stbl.stsd.entries[0];
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (!box) return undefined;

        // Try mp4box DataStream serialization first (most reliable)
        const mp4box = this._mp4box;
        const DS = mp4box?.DataStream || mp4box?.default?.DataStream;
        if (DS) {
          try {
            const endian = mp4box?.Endianness?.BIG_ENDIAN ?? 1;
            const stream = new DS(undefined, 0, endian);
            box.write(stream);
            // box.write() includes an 8-byte box header (size + type); skip it
            const result = new Uint8Array(stream.buffer.slice(8, stream.position));
            if (result.byteLength > 0) {
              logger.info(`Codec description via DataStream: ${result.byteLength} bytes`);
              return result;
            }
          } catch (dsErr) {
            logger.warn('DataStream serialization failed, falling back to manual:', dsErr.message);
          }
        }

        // Fallback to manual avcC serializer
        if (entry.avcC) {
          return this._serializeAvcC(entry.avcC);
        }

        return undefined;
      } catch (e) {
        logger.warn('Could not extract codec description:', e);
        return undefined;
      }
    },

    _started: false,

    start() {
      if (mp4boxFile && !this._started) {
        this._started = true;
        mp4boxFile.start();
      }
    },

    getVideoTrackInfo() {
      if (!videoTrack) return null;
      return {
        codec: videoTrack.codec,
        width: videoTrack.video.width,
        height: videoTrack.video.height,
        duration: videoTrack.duration / videoTrack.timescale,
        frameCount: videoTrack.nb_samples,
        frameRate: videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale),
        timescale: videoTrack.timescale
      };
    },

    getAudioTrackInfo() {
      if (!audioTrack) return null;
      return {
        codec: audioTrack.codec,
        sampleRate: audioTrack.audio.sample_rate,
        channels: audioTrack.audio.channel_count,
        duration: audioTrack.duration / audioTrack.timescale
      };
    },

    seek(timeSeconds) {
      if (!mp4boxFile || !videoTrack) return;
      const timescaleTime = timeSeconds * videoTrack.timescale;
      mp4boxFile.seek(timescaleTime, true);
    },

    cleanup() {
      if (mp4boxFile) {
        mp4boxFile.flush();
        mp4boxFile = null;
      }
      this._mp4boxFile = null;
      videoTrack = null;
      audioTrack = null;
      this._started = false;
      this._ready = false;
      this._initCalled = false;
    }
  };
}

export default createDemuxer;

// WebCodecs VideoEncoder — hardware-accelerated H.264/VP9 encoding
// Supports three quality strategies (best → worst):
//   1. Quantizer mode (Chrome 134+): per-frame QP — CRF-like direct quality control
//   2. VBR with quality floor: bitrate-targeted with resolution-aware minimum
//   3. CBR: fixed bitrate passthrough
import logger from '../../utils/logger.js';
import { QUALITY_QP, HW_QUALITY_BITRATE_1080P, PIXELS_1080P, parseBitrate } from './exportUtils.js';

// Compute effective bitrate for VBR hardware encoding (fallback when quantizer unavailable)
function computeHWBitrate(config) {
  const userBitrate = parseBitrate(config.bitrate);
  if (config.bitrateMode === 'constant') return userBitrate;

  const quality = config.quality || 'medium';
  const baseBitrate = HW_QUALITY_BITRATE_1080P[quality] || HW_QUALITY_BITRATE_1080P.medium;
  const pixels = (config.width || 1920) * (config.height || 1080);
  const scaledFloor = Math.round(baseBitrate * (pixels / PIXELS_1080P));

  return Math.max(userBitrate, scaledFloor);
}

export function createWebCodecsEncoder(config) {
  let encoder = null;
  let encodedChunks = [];
  let frameCount = 0;
  let _drainResolve = null;
  let _drainThreshold = 0;
  let _useQuantizer = false;
  let _qp = 26;
  let _isVP9 = false;

  const effectiveBitrate = computeHWBitrate(config);

  // Shorter GOP at lower effective bitrate — prevents quality drift in P-frame chains
  const gopSeconds = effectiveBitrate < 10_000_000 ? 1 : 2;
  const gopFrames = Math.round((config.fps || 30) * gopSeconds);

  const _checkDrain = () => {
    if (_drainResolve && encoder && encoder.encodeQueueSize <= _drainThreshold) {
      const resolve = _drainResolve;
      _drainResolve = null;
      resolve();
    }
  };

  // Build encode options with QP hint when in quantizer mode
  function _encodeOpts(isKeyframe) {
    const opts = { keyFrame: isKeyframe };
    if (_useQuantizer) {
      if (_isVP9) {
        opts.vp9 = { quantizer: _qp };
      } else {
        opts.avc = { quantizer: _qp };
      }
    }
    return opts;
  }

  return {
    async init() {
      _isVP9 = config.codec && !config.codec.startsWith('avc1');
      const quality = config.quality || 'medium';
      const codecKey = _isVP9 ? 'vp9' : 'h264';
      _qp = QUALITY_QP[quality]?.[codecKey] ?? QUALITY_QP.medium[codecKey];

      // Try quantizer mode first for VBR (gives CRF-like direct quality control)
      let useQuantizer = false;
      if (config.bitrateMode !== 'constant') {
        const quantizerConfig = {
          codec: config.codec,
          width: config.width,
          height: config.height,
          bitrateMode: 'quantizer',
          framerate: config.fps,
          hardwareAcceleration: 'prefer-hardware',
          latencyMode: 'quality',
          avc: config.codec.startsWith('avc1') ? { format: config.avcFormat || 'annexb' } : undefined
        };
        try {
          const qSupport = await VideoEncoder.isConfigSupported(quantizerConfig);
          useQuantizer = !!qSupport.supported;
        } catch (_) {
          useQuantizer = false;
        }
      }

      let encoderConfig;
      if (useQuantizer) {
        _useQuantizer = true;
        encoderConfig = {
          codec: config.codec,
          width: config.width,
          height: config.height,
          bitrateMode: 'quantizer',
          framerate: config.fps,
          hardwareAcceleration: 'prefer-hardware',
          latencyMode: 'quality',
          avc: config.codec.startsWith('avc1') ? { format: config.avcFormat || 'annexb' } : undefined
        };
      } else {
        encoderConfig = {
          codec: config.codec,
          width: config.width,
          height: config.height,
          bitrate: effectiveBitrate,
          bitrateMode: config.bitrateMode || 'variable',
          framerate: config.fps,
          hardwareAcceleration: 'prefer-hardware',
          latencyMode: 'quality',
          avc: config.codec.startsWith('avc1') ? { format: config.avcFormat || 'annexb' } : undefined
        };
      }

      // Validate config
      const support = await VideoEncoder.isConfigSupported(encoderConfig);
      if (!support.supported) {
        throw new Error(`Codec ${config.codec} not supported by VideoEncoder`);
      }

      encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          encodedChunks.push({
            data,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            type: chunk.type,
            decoderConfig: metadata?.decoderConfig || null
          });
          _checkDrain();
        },
        error: (err) => {
          logger.error('VideoEncoder error:', err);
        }
      });

      encoder.configure(encoderConfig);

      try {
        encoder.addEventListener('dequeue', _checkDrain);
      } catch (_) { /* older browsers lack dequeue event */ }

      const modeLabel = _useQuantizer
        ? `quantizer QP=${_qp}`
        : `${config.bitrateMode || 'variable'} ${(effectiveBitrate / 1_000_000).toFixed(1)}Mbps`;
      logger.info(`WebCodecsEncoder: ${config.codec} ${config.width}x${config.height} @ ${config.fps}fps, ${modeLabel}, GOP=${gopFrames}f`);
    },

    encodeFrame(canvas, timestampUs) {
      if (!encoder || encoder.state !== 'configured') return;

      const frame = new VideoFrame(canvas, {
        timestamp: timestampUs,
        duration: Math.round(1000000 / config.fps),
        ...(config.outputColorSpace ? { colorSpace: config.outputColorSpace } : {})
      });

      const isKeyframe = frameCount % gopFrames === 0;
      encoder.encode(frame, _encodeOpts(isKeyframe));
      frame.close();
      frameCount++;
    },

    encodeFrameKeyframe(canvas, timestampUs) {
      if (!encoder || encoder.state !== 'configured') return;

      const frame = new VideoFrame(canvas, {
        timestamp: timestampUs,
        duration: Math.round(1000000 / config.fps),
        ...(config.outputColorSpace ? { colorSpace: config.outputColorSpace } : {})
      });

      encoder.encode(frame, _encodeOpts(true));
      frame.close();
      frameCount++;
    },

    async flush() {
      if (!encoder || encoder.state !== 'configured') return;
      await encoder.flush();
    },

    getEncodedData() {
      let totalSize = 0;
      for (const chunk of encodedChunks) {
        totalSize += chunk.data.byteLength;
      }

      const result = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of encodedChunks) {
        result.set(chunk.data, offset);
        offset += chunk.data.byteLength;
      }

      return result;
    },

    getAndClearEncodedData() {
      const data = this.getEncodedData();
      encodedChunks = [];
      return data;
    },

    getChunks() {
      return encodedChunks;
    },

    getFrameCount() {
      return frameCount;
    },

    getQueueSize() {
      return encoder ? encoder.encodeQueueSize : 0;
    },

    waitForDrain(threshold) {
      if (!encoder || encoder.encodeQueueSize <= threshold) {
        return Promise.resolve();
      }
      if (_drainResolve) {
        const old = _drainResolve;
        _drainResolve = null;
        old();
      }
      _drainThreshold = threshold;
      return new Promise(resolve => { _drainResolve = resolve; });
    },

    close() {
      if (_drainResolve) {
        const resolve = _drainResolve;
        _drainResolve = null;
        resolve();
      }
      if (encoder) {
        try { encoder.removeEventListener('dequeue', _checkDrain); } catch (_) {}
        try { encoder.close(); } catch (e) { /* already closed */ }
        encoder = null;
      }
      encodedChunks = [];
      frameCount = 0;
    }
  };
}

// Feature detection
export function isWebCodecsEncodeSupported() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export default createWebCodecsEncoder;

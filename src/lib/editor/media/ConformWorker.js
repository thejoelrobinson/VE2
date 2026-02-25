// Web Worker: pre-encode decoded frames to H.264 at sequence settings.
// @ts-check
// Receives ImageBitmaps (transferred), encodes via VideoEncoder, returns Annex B packets.
import {
  QUALITY_QP,
  HW_QUALITY_BITRATE_1080P,
  PIXELS_1080P,
  parseBitrate
} from '../export/exportUtils.js';

// ---- Worker Message Protocol (JSDoc) ----

/**
 * @typedef {object} CFW_ConfigureRequest
 * @property {'configure'} type
 * @property {string} codec - WebCodecs codec string (e.g., 'avc1.640028')
 * @property {number} width
 * @property {number} height
 * @property {string|number} [bitrate] - Target bitrate (e.g., '8M' or 8000000)
 * @property {number} fps
 * @property {string} [bitrateMode] - 'variable'|'constant'|'quantizer'
 * @property {string} [quality] - Quality preset (low/medium/high/lossless)
 */

/**
 * @typedef {object} CFW_EncodeRequest
 * @property {'encode'} type
 * @property {ImageBitmap} bitmap - Frame to encode
 * @property {number} timestampUs - Presentation timestamp in microseconds
 * @property {boolean} [forceKeyframe] - Force this frame as a keyframe
 * @property {number} [requestId] - Caller-provided request identifier
 * Transfer list: [bitmap] (zero-copy transfer)
 */

/**
 * @typedef {object} CFW_FlushRequest
 * @property {'flush'} type
 */

/**
 * @typedef {object} CFW_ReconfigureRequest
 * @property {'reconfigure'} type
 * @property {string} codec
 * @property {number} width
 * @property {number} height
 * @property {string|number} [bitrate]
 * @property {number} fps
 * @property {string} [bitrateMode]
 * @property {string} [quality]
 */

/**
 * @typedef {object} CFW_CloseRequest
 * @property {'close'} type
 */

/** @typedef {CFW_ConfigureRequest | CFW_EncodeRequest | CFW_FlushRequest | CFW_ReconfigureRequest | CFW_CloseRequest} CFW_Request */

/**
 * @typedef {object} CFW_ConfigureDoneResponse
 * @property {'configure_done'} type
 */

/**
 * @typedef {object} CFW_ConfigureErrorResponse
 * @property {'configure_error'} type
 * @property {string} error
 */

/**
 * @typedef {object} CFW_PacketData
 * @property {Uint8Array} data - Encoded Annex B packet data
 * @property {number} timestamp - Presentation timestamp (microseconds)
 * @property {number} duration - Frame duration (microseconds)
 * @property {boolean} isKeyframe
 * @property {object | null} decoderConfig - Decoder config from metadata (if present)
 */

/**
 * @typedef {object} CFW_PacketResponse
 * @property {'packet'} type
 * @property {CFW_PacketData} packet
 * Transfer list: [packet.data.buffer] (zero-copy transfer)
 */

/**
 * @typedef {object} CFW_EncodeAcceptedResponse
 * @property {'encode_accepted'} type
 * @property {number} [requestId]
 */

/**
 * @typedef {object} CFW_EncodeErrorResponse
 * @property {'encode_error'} type
 * @property {string} error
 * @property {number} [requestId]
 */

/**
 * @typedef {object} CFW_FlushDoneResponse
 * @property {'flush_done'} type
 */

/**
 * @typedef {object} CFW_FlushErrorResponse
 * @property {'flush_error'} type
 * @property {string} error
 */

/**
 * @typedef {object} CFW_ReconfigureDoneResponse
 * @property {'reconfigure_done'} type
 */

/**
 * @typedef {object} CFW_ReconfigureErrorResponse
 * @property {'reconfigure_error'} type
 * @property {string} error
 */

/**
 * @typedef {object} CFW_ClosedResponse
 * @property {'closed'} type
 */

/**
 * @typedef {object} CFW_ErrorResponse
 * @property {'error'} type
 * @property {string} error
 */

/** @typedef {CFW_ConfigureDoneResponse | CFW_ConfigureErrorResponse | CFW_PacketResponse | CFW_EncodeAcceptedResponse | CFW_EncodeErrorResponse | CFW_FlushDoneResponse | CFW_FlushErrorResponse | CFW_ReconfigureDoneResponse | CFW_ReconfigureErrorResponse | CFW_ClosedResponse | CFW_ErrorResponse} CFW_Response */

let encoder = null;
let encoderConfig = null;
let gopFrames = 60;
let useQuantizer = false;
let quantizerQP = 26;
let isVP9Codec = false;

async function createEncoder(config) {
  if (encoder) {
    try {
      encoder.close();
    } catch (_) {}
  }

  encoderConfig = config;
  isVP9Codec = config.codec && !config.codec.startsWith('avc1');
  const quality = config.quality || 'medium';
  const codecKey = isVP9Codec ? 'vp9' : 'h264';
  quantizerQP = QUALITY_QP[quality]?.[codecKey] ?? QUALITY_QP.medium[codecKey];

  encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      self.postMessage(
        {
          type: 'packet',
          packet: {
            data,
            timestamp: chunk.timestamp,
            duration: chunk.duration,
            isKeyframe: chunk.type === 'key',
            decoderConfig: metadata?.decoderConfig || null
          }
        },
        [data.buffer]
      );
    },
    error: err => {
      self.postMessage({ type: 'error', error: err.message });
    }
  });

  // Try quantizer mode first for VBR (CRF-like direct quality control)
  useQuantizer = false;
  if (config.bitrateMode !== 'constant') {
    try {
      const qCfg = {
        codec: config.codec,
        width: config.width,
        height: config.height,
        bitrateMode: 'quantizer',
        framerate: config.fps,
        hardwareAcceleration: 'prefer-hardware',
        latencyMode: 'quality',
        avc: config.codec.startsWith('avc1') ? { format: 'annexb' } : undefined
      };
      const qSupport = await VideoEncoder.isConfigSupported(qCfg);
      if (qSupport.supported) {
        useQuantizer = true;
        encoder.configure(qCfg);
        gopFrames = Math.round((config.fps || 30) * 2);
        return;
      }
    } catch (_) {
      /* quantizer not supported, fall through */
    }
  }

  // Fallback: VBR/CBR with quality-aware bitrate floor
  let effectiveBitrate = parseBitrate(config.bitrate, 8_000_000);
  if (config.bitrateMode !== 'constant') {
    const baseBr = HW_QUALITY_BITRATE_1080P[quality] || HW_QUALITY_BITRATE_1080P.medium;
    const pixels = (config.width || 1920) * (config.height || 1080);
    effectiveBitrate = Math.max(effectiveBitrate, Math.round(baseBr * (pixels / PIXELS_1080P)));
  }

  const gopSec = effectiveBitrate < 10_000_000 ? 1 : 2;
  gopFrames = Math.round((config.fps || 30) * gopSec);

  encoder.configure({
    codec: config.codec,
    width: config.width,
    height: config.height,
    bitrate: effectiveBitrate,
    bitrateMode: config.bitrateMode || 'variable',
    framerate: config.fps,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'quality',
    avc: config.codec.startsWith('avc1') ? { format: 'annexb' } : undefined
  });
}

self.onmessage = async e => {
  const { type } = e.data;

  switch (type) {
    case 'configure': {
      const { codec, width, height, bitrate, fps, bitrateMode, quality } = e.data;
      try {
        const cfg = { codec, width, height, bitrate, fps, bitrateMode, quality };
        // Basic codec support check (createEncoder handles quantizer/VBR selection)
        const support = await VideoEncoder.isConfigSupported({
          codec,
          width,
          height,
          bitrate: parseBitrate(bitrate, 8_000_000),
          bitrateMode: bitrateMode || 'variable',
          framerate: fps,
          hardwareAcceleration: 'prefer-hardware',
          latencyMode: 'quality',
          avc: codec.startsWith('avc1') ? { format: 'annexb' } : undefined
        });
        if (!support.supported) {
          self.postMessage({ type: 'configure_error', error: `Codec ${codec} not supported` });
          return;
        }
        await createEncoder(cfg);
        self.postMessage({ type: 'configure_done' });
      } catch (err) {
        self.postMessage({ type: 'configure_error', error: err.message });
      }
      break;
    }

    case 'encode': {
      if (!encoder || encoder.state !== 'configured') {
        self.postMessage({
          type: 'encode_error',
          error: 'Encoder not configured',
          requestId: e.data.requestId
        });
        return;
      }
      const { bitmap, timestampUs, forceKeyframe, requestId } = e.data;
      try {
        const frame = new VideoFrame(bitmap, {
          timestamp: timestampUs,
          duration: Math.round(1000000 / encoderConfig.fps)
        });
        bitmap.close();
        const encodeOpts = { keyFrame: !!forceKeyframe };
        if (useQuantizer) {
          if (isVP9Codec) {
            encodeOpts.vp9 = { quantizer: quantizerQP };
          } else {
            encodeOpts.avc = { quantizer: quantizerQP };
          }
        }
        encoder.encode(frame, encodeOpts);
        frame.close();
        // Packet will arrive via output callback
        self.postMessage({ type: 'encode_accepted', requestId });
      } catch (err) {
        self.postMessage({ type: 'encode_error', error: err.message, requestId });
      }
      break;
    }

    case 'flush': {
      if (!encoder || encoder.state !== 'configured') {
        self.postMessage({ type: 'flush_done' });
        return;
      }
      try {
        await encoder.flush();
        self.postMessage({ type: 'flush_done' });
      } catch (err) {
        self.postMessage({ type: 'flush_error', error: err.message });
      }
      break;
    }

    case 'reconfigure': {
      const { codec, width, height, bitrate, fps, bitrateMode, quality } = e.data;
      try {
        await createEncoder({ codec, width, height, bitrate, fps, bitrateMode, quality });
        self.postMessage({ type: 'reconfigure_done' });
      } catch (err) {
        self.postMessage({ type: 'reconfigure_error', error: err.message });
      }
      break;
    }

    case 'close': {
      if (encoder) {
        try {
          encoder.close();
        } catch (_) {}
        encoder = null;
      }
      self.postMessage({ type: 'closed' });
      break;
    }
  }
};

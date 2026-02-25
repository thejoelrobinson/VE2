// PacketExtractWorker.js -- H.264 packet extraction helpers for stream copy export.
//
// Provides AVCC-to-Annex-B conversion and avcC config parsing, plus a lightweight
// worker factory for registering media files and extracting raw bitstream packets.
//
// AVCC (ISO 14496-15): length-prefixed NALUs
//   [N-byte big-endian length][NALU data][N-byte length][NALU data]...
// Annex B (ITU-T H.264): start code delimited NALUs
//   [00 00 00 01][NALU data][00 00 00 01][NALU data]...

import logger from '../../utils/logger.js';

const ANNEX_B_START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

/**
 * Parse an avcC (AVC Decoder Configuration Record) box to extract SPS/PPS NALUs.
 *
 * avcC format:
 *  [0] configurationVersion = 1
 *  [1] AVCProfileIndication
 *  [2] profile_compatibility
 *  [3] AVCLevelIndication
 *  [4] lengthSizeMinusOne (lower 2 bits) + 0b111111xx
 *  [5] numOfSPS (lower 5 bits) + 0b111xxxxx
 *  SPS entries: [2-byte length][SPS NALU]...
 *  [N] numOfPPS
 *  PPS entries: [2-byte length][PPS NALU]...
 *
 * @param {Uint8Array} avcCData - Raw avcC box data
 * @returns {{ spsNalus: Uint8Array[], ppsNalus: Uint8Array[], naluLengthSize: number }}
 */
export function parseAvcC(avcCData) {
  if (!avcCData || avcCData.length < 7) {
    return { spsNalus: [], ppsNalus: [], naluLengthSize: 4 };
  }

  const naluLengthSize = (avcCData[4] & 0x03) + 1;
  const numSPS = avcCData[5] & 0x1F;

  const spsNalus = [];
  const ppsNalus = [];
  let offset = 6;

  // Read SPS NALUs
  for (let i = 0; i < numSPS && offset + 2 <= avcCData.length; i++) {
    const spsLen = (avcCData[offset] << 8) | avcCData[offset + 1];
    offset += 2;
    if (offset + spsLen > avcCData.length) break;
    spsNalus.push(avcCData.slice(offset, offset + spsLen));
    offset += spsLen;
  }

  // Read PPS NALUs
  if (offset < avcCData.length) {
    const numPPS = avcCData[offset];
    offset += 1;
    for (let i = 0; i < numPPS && offset + 2 <= avcCData.length; i++) {
      const ppsLen = (avcCData[offset] << 8) | avcCData[offset + 1];
      offset += 2;
      if (offset + ppsLen > avcCData.length) break;
      ppsNalus.push(avcCData.slice(offset, offset + ppsLen));
      offset += ppsLen;
    }
  }

  return { spsNalus, ppsNalus, naluLengthSize };
}

/**
 * Convert AVCC-formatted (length-prefixed) NALUs to Annex B (start code delimited).
 *
 * @param {Uint8Array} avccData - AVCC-formatted sample data
 * @param {number} naluLengthSize - Length prefix size in bytes (3 or 4, usually 4)
 * @param {Object} [options]
 * @param {boolean} [options.prependConfig=false] - Prepend SPS/PPS NALUs before sample NALUs
 * @param {Uint8Array[]} [options.spsNalus=[]] - SPS NALUs from avcC box
 * @param {Uint8Array[]} [options.ppsNalus=[]] - PPS NALUs from avcC box
 * @returns {Uint8Array} Annex B formatted bitstream
 */
export function avccToAnnexB(avccData, naluLengthSize = 4, options = {}) {
  const { prependConfig = false, spsNalus = [], ppsNalus = [] } = options;
  const chunks = [];
  let totalLength = 0;

  // Prepend SPS/PPS if requested (keyframe -- decoder needs config)
  if (prependConfig) {
    for (const sps of spsNalus) {
      chunks.push(ANNEX_B_START_CODE, sps);
      totalLength += 4 + sps.length;
    }
    for (const pps of ppsNalus) {
      chunks.push(ANNEX_B_START_CODE, pps);
      totalLength += 4 + pps.length;
    }
  }

  // Convert each AVCC NALU to Annex B
  let offset = 0;
  while (offset < avccData.length) {
    // Need at least naluLengthSize bytes for the length prefix
    if (offset + naluLengthSize > avccData.length) break;

    // Read NALU length (big-endian, naluLengthSize bytes)
    let naluLength = 0;
    for (let i = 0; i < naluLengthSize; i++) {
      naluLength = (naluLength << 8) | avccData[offset + i];
    }
    offset += naluLengthSize;

    if (naluLength <= 0 || offset + naluLength > avccData.length) break;

    // Extract NALU data
    const naluData = avccData.subarray(offset, offset + naluLength);
    chunks.push(ANNEX_B_START_CODE, naluData);
    totalLength += 4 + naluLength;
    offset += naluLength;
  }

  // Concatenate all chunks into a single Uint8Array
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

/**
 * Create a PacketExtractWorker instance for registering media and extracting packets.
 *
 * In production, registerMedia will use mp4box to parse the file's sample table and
 * extract codec configuration. For now the factory supports mock data for testing and
 * will be extended with real mp4box integration in a follow-up.
 *
 * @returns {PacketExtractWorkerInstance}
 */
export function createPacketExtractWorker() {
  /** @type {Map<string, { codecConfig: Object, chunkMetas: Array, file: Object }>} */
  const _media = new Map();

  return {
    _media,

    /**
     * Register a media file for packet extraction.
     * MXF files are rejected since mp4box cannot parse them.
     *
     * @param {string} mediaId
     * @param {File|Object} file
     * @returns {Promise<{ success: boolean, codecConfig?: Object, error?: string }>}
     */
    async registerMedia(mediaId, file) {
      // MXF files: mp4box cannot parse -> fail gracefully
      if (file.name?.toLowerCase().endsWith('.mxf')) {
        return { success: false, error: 'mp4box cannot parse MXF files' };
      }

      try {
        const codecConfig = file._mockCodecConfig || {
          codec: 'avc1.640028',
          avcC: file._mockAvcC || null,
          width: 1920,
          height: 1080,
          frameRate: 24
        };
        const chunkMetas = file._mockChunkMetas || [];

        _media.set(mediaId, { codecConfig, chunkMetas, file });
        logger.info(`[PacketExtract] Registered media ${mediaId}: ${codecConfig.codec}`);
        return { success: true, codecConfig };
      } catch (err) {
        logger.warn(`[PacketExtract] Failed to register media ${mediaId}:`, err.message);
        return { success: false, error: err.message };
      }
    },

    /**
     * Extract packets for a time range, converting AVCC to Annex B format.
     *
     * @param {string} mediaId
     * @param {number} startTimeUs - Start time in microseconds
     * @param {number} endTimeUs - End time in microseconds
     * @param {boolean} [prependConfig=true] - Prepend SPS/PPS NALUs
     * @returns {Promise<Uint8Array>} Annex B bitstream
     */
    async extractPackets(mediaId, startTimeUs, endTimeUs, prependConfig = true) {
      const entry = _media.get(mediaId);
      if (!entry) throw new Error(`Media ${mediaId} not registered`);

      const { codecConfig } = entry;
      let spsNalus = [];
      let ppsNalus = [];
      let naluLengthSize = 4;

      if (codecConfig.avcC) {
        const parsed = parseAvcC(codecConfig.avcC);
        spsNalus = parsed.spsNalus;
        ppsNalus = parsed.ppsNalus;
        naluLengthSize = parsed.naluLengthSize;
      }

      // Read sample data -- currently uses mock data for testing.
      // Real implementation will use mp4box sample table + File.slice() to read
      // samples within the [startTimeUs, endTimeUs] time range.
      const sampleData = entry.file._mockSampleData || new Uint8Array(0);

      return avccToAnnexB(sampleData, naluLengthSize, {
        prependConfig,
        spsNalus,
        ppsNalus
      });
    },

    /**
     * Release resources for a registered media file.
     * Idempotent -- safe to call for non-existent media IDs.
     *
     * @param {string} mediaId
     */
    close(mediaId) {
      _media.delete(mediaId);
    }
  };
}

// Singleton instance for use by StreamCopyExtractor and RenderAheadManager
export const packetExtractWorker = createPacketExtractWorker();

export default packetExtractWorker;

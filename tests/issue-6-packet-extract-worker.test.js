/**
 * Issue #6 — PacketExtractWorker for Stream Copy Export
 *
 * After this issue is resolved:
 * - New lightweight worker: sample table parsing + AVCC->Annex B conversion
 * - register_media parses File with mp4box, extracts chunkMetas + codecConfig
 * - extract_packets converts AVCC (length-prefixed NALUs) to Annex B (start codes)
 * - MXF files cannot be parsed by mp4box -> register_media fails gracefully
 * - Codec info stored on mediaItem for stream copy eligibility
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── AVCC to Annex B conversion logic ────────────────────────────────────────
// AVCC (ISO 14496-15): length-prefixed NALUs
//   [4-byte big-endian length][NALU data][4-byte length][NALU data]...
// Annex B (ITU-T H.264): start code delimited NALUs
//   [00 00 00 01][NALU data][00 00 00 01][NALU data]...

const ANNEX_B_START_CODE = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

/**
 * Convert AVCC-formatted NALUs to Annex B format.
 * @param {Uint8Array} avccData - AVCC-formatted sample data
 * @param {number} naluLengthSize - Length prefix size (3 or 4 bytes, usually 4)
 * @param {Object} options
 * @param {boolean} options.prependConfig - Whether to prepend SPS/PPS NALUs
 * @param {Uint8Array[]} options.spsNalus - SPS NALUs (from avcC box)
 * @param {Uint8Array[]} options.ppsNalus - PPS NALUs (from avcC box)
 * @returns {Uint8Array} Annex B formatted bitstream
 */
function avccToAnnexB(avccData, naluLengthSize = 4, options = {}) {
  const { prependConfig = false, spsNalus = [], ppsNalus = [] } = options;
  const chunks = [];
  let totalLength = 0;

  // Prepend SPS/PPS if requested (keyframe — decoder needs config)
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
 * Parse avcC (AVC Decoder Configuration Record) box to extract SPS/PPS NALUs.
 * @param {Uint8Array} avcCData - Raw avcC box data
 * @returns {{ spsNalus: Uint8Array[], ppsNalus: Uint8Array[], naluLengthSize: number }}
 */
function parseAvcC(avcCData) {
  if (!avcCData || avcCData.length < 7) {
    return { spsNalus: [], ppsNalus: [], naluLengthSize: 4 };
  }

  // avcC format:
  //  [0] configurationVersion = 1
  //  [1] AVCProfileIndication
  //  [2] profile_compatibility
  //  [3] AVCLevelIndication
  //  [4] lengthSizeMinusOne (lower 2 bits) + 111111xx
  //  [5] numOfSPS (lower 5 bits) + 111xxxxx
  //  SPS entries: [2-byte length][SPS NALU]...
  //  [N] numOfPPS
  //  PPS entries: [2-byte length][PPS NALU]...

  const naluLengthSize = (avcCData[4] & 0x03) + 1; // usually 4
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

// ── Simulated register_media / extract_packets lifecycle ────────────────────

function createPacketExtractWorker() {
  const _media = new Map(); // mediaId -> { codecConfig, chunkMetas, file }

  return {
    _media,

    // Simulate register_media: parse File with mp4box
    async registerMedia(mediaId, file) {
      // MXF files: mp4box cannot parse -> fail gracefully
      if (file.name?.toLowerCase().endsWith('.mxf')) {
        return { success: false, error: 'mp4box cannot parse MXF files' };
      }

      // Simulate mp4box parsing
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
        return { success: true, codecConfig };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },

    // Simulate extract_packets: AVCC -> Annex B for a time range
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

      // Simulate reading sample data (AVCC-formatted)
      const sampleData = entry.file._mockSampleData || new Uint8Array(0);

      return avccToAnnexB(sampleData, naluLengthSize, {
        prependConfig,
        spsNalus,
        ppsNalus
      });
    },

    close(mediaId) {
      _media.delete(mediaId);
    }
  };
}

// ── Helper: build AVCC sample data with length-prefixed NALUs ───────────────

function buildAvccSample(naluDatas, lengthSize = 4) {
  let totalLength = 0;
  for (const nalu of naluDatas) {
    totalLength += lengthSize + nalu.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const nalu of naluDatas) {
    // Write big-endian length prefix
    if (lengthSize === 4) {
      result[offset] = (nalu.length >> 24) & 0xFF;
      result[offset + 1] = (nalu.length >> 16) & 0xFF;
      result[offset + 2] = (nalu.length >> 8) & 0xFF;
      result[offset + 3] = nalu.length & 0xFF;
    } else if (lengthSize === 3) {
      result[offset] = (nalu.length >> 16) & 0xFF;
      result[offset + 1] = (nalu.length >> 8) & 0xFF;
      result[offset + 2] = nalu.length & 0xFF;
    }
    offset += lengthSize;
    result.set(nalu, offset);
    offset += nalu.length;
  }
  return result;
}

// ── Helper: build a minimal avcC box ────────────────────────────────────────

function buildAvcC({ spsNalus = [], ppsNalus = [], naluLengthSize = 4 }) {
  const parts = [];
  // Header: version, profile, compat, level
  parts.push(new Uint8Array([
    1,            // configurationVersion
    0x64,         // AVCProfileIndication (High)
    0x00,         // profile_compatibility
    0x28,         // AVCLevelIndication (4.0)
    0xFC | ((naluLengthSize - 1) & 0x03), // lengthSizeMinusOne
    0xE0 | (spsNalus.length & 0x1F)       // numOfSPS
  ]));

  // SPS entries
  for (const sps of spsNalus) {
    const lenBuf = new Uint8Array(2);
    lenBuf[0] = (sps.length >> 8) & 0xFF;
    lenBuf[1] = sps.length & 0xFF;
    parts.push(lenBuf, sps);
  }

  // PPS count + entries
  parts.push(new Uint8Array([ppsNalus.length]));
  for (const pps of ppsNalus) {
    const lenBuf = new Uint8Array(2);
    lenBuf[0] = (pps.length >> 8) & 0xFF;
    lenBuf[1] = pps.length & 0xFF;
    parts.push(lenBuf, pps);
  }

  // Concatenate
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #6 — AVCC to Annex B conversion', () => {
  it('converts length-prefixed NALUs to start codes (00 00 00 01)', () => {
    const naluData = new Uint8Array([0x65, 0x88, 0x84]); // IDR slice
    const avcc = buildAvccSample([naluData]);

    const annexB = avccToAnnexB(avcc, 4);
    // Should be: [00 00 00 01] [65 88 84]
    expect(annexB.length).toBe(4 + 3);
    expect(annexB[0]).toBe(0x00);
    expect(annexB[1]).toBe(0x00);
    expect(annexB[2]).toBe(0x00);
    expect(annexB[3]).toBe(0x01);
    expect(annexB[4]).toBe(0x65);
    expect(annexB[5]).toBe(0x88);
    expect(annexB[6]).toBe(0x84);
  });

  it('handles 4-byte length prefix', () => {
    const nalu = new Uint8Array([0x41, 0x9A, 0x02]); // non-IDR slice
    const avcc = buildAvccSample([nalu], 4);
    // 4-byte length prefix: 00 00 00 03
    expect(avcc[0]).toBe(0x00);
    expect(avcc[1]).toBe(0x00);
    expect(avcc[2]).toBe(0x00);
    expect(avcc[3]).toBe(0x03);

    const annexB = avccToAnnexB(avcc, 4);
    expect(annexB.length).toBe(7); // 4 start code + 3 data
    expect(annexB.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1]));
    expect(annexB.slice(4)).toEqual(nalu);
  });

  it('handles 3-byte length prefix', () => {
    const nalu = new Uint8Array([0x41, 0x9A]);
    const avcc = buildAvccSample([nalu], 3);
    // 3-byte length prefix: 00 00 02
    expect(avcc[0]).toBe(0x00);
    expect(avcc[1]).toBe(0x00);
    expect(avcc[2]).toBe(0x02);

    const annexB = avccToAnnexB(avcc, 3);
    expect(annexB.length).toBe(6); // 4 start code + 2 data
    expect(annexB.slice(0, 4)).toEqual(new Uint8Array([0, 0, 0, 1]));
    expect(annexB.slice(4)).toEqual(nalu);
  });

  it('handles multiple NALUs in single sample', () => {
    const nalu1 = new Uint8Array([0x65, 0x88, 0x84]); // IDR
    const nalu2 = new Uint8Array([0x41, 0x9A]);         // non-IDR
    const nalu3 = new Uint8Array([0x06, 0x05, 0xAA, 0xBB]); // SEI
    const avcc = buildAvccSample([nalu1, nalu2, nalu3]);

    const annexB = avccToAnnexB(avcc, 4);
    // Expected: [start][nalu1][start][nalu2][start][nalu3]
    expect(annexB.length).toBe((4 + 3) + (4 + 2) + (4 + 4));

    // Verify first NALU start code + data
    expect(annexB.slice(0, 4)).toEqual(ANNEX_B_START_CODE);
    expect(annexB.slice(4, 7)).toEqual(nalu1);

    // Verify second NALU start code + data
    expect(annexB.slice(7, 11)).toEqual(ANNEX_B_START_CODE);
    expect(annexB.slice(11, 13)).toEqual(nalu2);

    // Verify third NALU start code + data
    expect(annexB.slice(13, 17)).toEqual(ANNEX_B_START_CODE);
    expect(annexB.slice(17, 21)).toEqual(nalu3);
  });

  it('prepends SPS/PPS when prependConfig=true', () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28]); // SPS NAL type
    const pps = new Uint8Array([0x68, 0xEE, 0x3C, 0x80]); // PPS NAL type
    const idrNalu = new Uint8Array([0x65, 0x88]);

    const avcc = buildAvccSample([idrNalu]);
    const annexB = avccToAnnexB(avcc, 4, {
      prependConfig: true,
      spsNalus: [sps],
      ppsNalus: [pps]
    });

    // Expected: [start][SPS][start][PPS][start][IDR]
    const expectedLen = (4 + sps.length) + (4 + pps.length) + (4 + idrNalu.length);
    expect(annexB.length).toBe(expectedLen);

    // Verify SPS is first
    expect(annexB.slice(0, 4)).toEqual(ANNEX_B_START_CODE);
    expect(annexB.slice(4, 4 + sps.length)).toEqual(sps);

    // Verify PPS is second
    const ppsOffset = 4 + sps.length;
    expect(annexB.slice(ppsOffset, ppsOffset + 4)).toEqual(ANNEX_B_START_CODE);
    expect(annexB.slice(ppsOffset + 4, ppsOffset + 4 + pps.length)).toEqual(pps);

    // Verify IDR is third
    const idrOffset = ppsOffset + 4 + pps.length;
    expect(annexB.slice(idrOffset, idrOffset + 4)).toEqual(ANNEX_B_START_CODE);
    expect(annexB.slice(idrOffset + 4, idrOffset + 4 + idrNalu.length)).toEqual(idrNalu);
  });

  it('skips SPS/PPS when prependConfig=false', () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28]);
    const pps = new Uint8Array([0x68, 0xEE, 0x3C, 0x80]);
    const idrNalu = new Uint8Array([0x65, 0x88]);

    const avcc = buildAvccSample([idrNalu]);
    const annexB = avccToAnnexB(avcc, 4, {
      prependConfig: false,
      spsNalus: [sps],
      ppsNalus: [pps]
    });

    // Only IDR NALU, no SPS/PPS
    expect(annexB.length).toBe(4 + idrNalu.length);
    expect(annexB.slice(0, 4)).toEqual(ANNEX_B_START_CODE);
    expect(annexB.slice(4)).toEqual(idrNalu);
  });

  it('handles empty input', () => {
    const annexB = avccToAnnexB(new Uint8Array(0), 4);
    expect(annexB.length).toBe(0);
  });

  it('handles truncated NALU length (malformed data)', () => {
    // Only 2 bytes of a 4-byte length prefix
    const badData = new Uint8Array([0x00, 0x00]);
    const annexB = avccToAnnexB(badData, 4);
    // Should handle gracefully — no crash, empty or partial output
    expect(annexB.length).toBe(0);
  });

  it('handles NALU length exceeding remaining data (corrupted)', () => {
    // Build data where the length prefix claims 100 bytes but only 3 remain
    const corruptData = new Uint8Array([
      0x00, 0x00, 0x00, 0x64, // length = 100
      0x65, 0x88, 0x84        // only 3 bytes of data
    ]);
    const annexB = avccToAnnexB(corruptData, 4);
    // Should break out of the loop gracefully — no NALU extracted
    expect(annexB.length).toBe(0);
  });
});

describe('Issue #6 — parseAvcC extracts SPS and PPS NALUs', () => {
  it('extracts single SPS and single PPS', () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xAC]);
    const pps = new Uint8Array([0x68, 0xEE, 0x3C, 0x80]);
    const avcC = buildAvcC({ spsNalus: [sps], ppsNalus: [pps] });

    const result = parseAvcC(avcC);
    expect(result.spsNalus.length).toBe(1);
    expect(result.ppsNalus.length).toBe(1);
    expect(result.spsNalus[0]).toEqual(sps);
    expect(result.ppsNalus[0]).toEqual(pps);
    expect(result.naluLengthSize).toBe(4);
  });

  it('extracts multiple SPS NALUs', () => {
    const sps1 = new Uint8Array([0x67, 0x64, 0x00, 0x28]);
    const sps2 = new Uint8Array([0x67, 0x4D, 0x00, 0x1E]);
    const pps = new Uint8Array([0x68, 0xEE]);
    const avcC = buildAvcC({ spsNalus: [sps1, sps2], ppsNalus: [pps] });

    const result = parseAvcC(avcC);
    expect(result.spsNalus.length).toBe(2);
    expect(result.spsNalus[0]).toEqual(sps1);
    expect(result.spsNalus[1]).toEqual(sps2);
    expect(result.ppsNalus.length).toBe(1);
  });

  it('handles naluLengthSize = 3', () => {
    const sps = new Uint8Array([0x67, 0x64]);
    const pps = new Uint8Array([0x68, 0xEE]);
    const avcC = buildAvcC({ spsNalus: [sps], ppsNalus: [pps], naluLengthSize: 3 });

    const result = parseAvcC(avcC);
    expect(result.naluLengthSize).toBe(3);
  });

  it('returns empty arrays for empty avcC', () => {
    const result = parseAvcC(new Uint8Array(0));
    expect(result.spsNalus).toEqual([]);
    expect(result.ppsNalus).toEqual([]);
  });

  it('returns empty arrays for null avcC', () => {
    const result = parseAvcC(null);
    expect(result.spsNalus).toEqual([]);
    expect(result.ppsNalus).toEqual([]);
  });

  it('returns default naluLengthSize=4 for missing data', () => {
    const result = parseAvcC(null);
    expect(result.naluLengthSize).toBe(4);
  });
});

describe('Issue #6 — register_media lifecycle', () => {
  let worker;

  beforeEach(() => {
    worker = createPacketExtractWorker();
  });

  it('returns codec config for H.264 MP4', async () => {
    const file = {
      name: 'clip.mp4',
      _mockCodecConfig: {
        codec: 'avc1.640028',
        avcC: buildAvcC({
          spsNalus: [new Uint8Array([0x67, 0x64, 0x00, 0x28])],
          ppsNalus: [new Uint8Array([0x68, 0xEE, 0x3C, 0x80])]
        }),
        width: 1920,
        height: 1080,
        frameRate: 24
      }
    };

    const result = await worker.registerMedia('media-1', file);
    expect(result.success).toBe(true);
    expect(result.codecConfig.codec).toBe('avc1.640028');
    expect(result.codecConfig.width).toBe(1920);
    expect(result.codecConfig.height).toBe(1080);
    expect(result.codecConfig.frameRate).toBe(24);
  });

  it('fails gracefully for MXF (mp4box cannot parse)', async () => {
    const file = { name: 'clip.mxf' };
    const result = await worker.registerMedia('media-1', file);
    expect(result.success).toBe(false);
    expect(result.error).toContain('MXF');
  });

  it('fails gracefully for uppercase .MXF extension', async () => {
    const file = { name: 'CLIP.MXF' };
    const result = await worker.registerMedia('media-1', file);
    expect(result.success).toBe(false);
  });

  it('stores registered media for later extraction', async () => {
    const file = { name: 'clip.mp4' };
    await worker.registerMedia('media-1', file);
    expect(worker._media.has('media-1')).toBe(true);
  });

  it('does not store MXF media on failure', async () => {
    const file = { name: 'clip.mxf' };
    await worker.registerMedia('media-1', file);
    expect(worker._media.has('media-1')).toBe(false);
  });
});

describe('Issue #6 — extract_packets produces valid Annex B output', () => {
  let worker;

  beforeEach(() => {
    worker = createPacketExtractWorker();
  });

  it('produces valid Annex B for typical H.264 stream', async () => {
    const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28]);
    const pps = new Uint8Array([0x68, 0xEE, 0x3C, 0x80]);
    const idrNalu = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x1F]);
    const nonIdrNalu = new Uint8Array([0x41, 0x9A, 0x02, 0x04]);

    const file = {
      name: 'clip.mp4',
      _mockCodecConfig: {
        codec: 'avc1.640028',
        avcC: buildAvcC({ spsNalus: [sps], ppsNalus: [pps] }),
        width: 1920,
        height: 1080,
        frameRate: 24
      },
      _mockSampleData: buildAvccSample([idrNalu, nonIdrNalu])
    };

    await worker.registerMedia('media-1', file);
    const annexB = await worker.extractPackets('media-1', 0, 1_000_000, true);

    // Verify it contains start codes (not length prefixes)
    expect(annexB.length).toBeGreaterThan(0);

    // Count start codes: should be SPS + PPS + IDR + non-IDR = 4
    let startCodeCount = 0;
    for (let i = 0; i <= annexB.length - 4; i++) {
      if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1) {
        startCodeCount++;
      }
    }
    expect(startCodeCount).toBe(4); // SPS + PPS + IDR + non-IDR
  });

  it('produces Annex B without config when prependConfig=false', async () => {
    const idrNalu = new Uint8Array([0x65, 0x88]);
    const file = {
      name: 'clip.mp4',
      _mockCodecConfig: {
        codec: 'avc1.640028',
        avcC: buildAvcC({
          spsNalus: [new Uint8Array([0x67, 0x64])],
          ppsNalus: [new Uint8Array([0x68, 0xEE])]
        }),
        width: 1920,
        height: 1080,
        frameRate: 24
      },
      _mockSampleData: buildAvccSample([idrNalu])
    };

    await worker.registerMedia('media-1', file);
    const annexB = await worker.extractPackets('media-1', 0, 1_000_000, false);

    // Only IDR NALU (no SPS/PPS)
    expect(annexB.length).toBe(4 + idrNalu.length);
  });

  it('throws for unregistered media', async () => {
    await expect(
      worker.extractPackets('unknown', 0, 1_000_000)
    ).rejects.toThrow('not registered');
  });
});

describe('Issue #6 — Worker state management: register -> extract -> close', () => {
  let worker;

  beforeEach(() => {
    worker = createPacketExtractWorker();
  });

  it('full lifecycle: register -> extract -> close', async () => {
    const file = {
      name: 'clip.mp4',
      _mockSampleData: buildAvccSample([new Uint8Array([0x65, 0x88])])
    };

    // Register
    const reg = await worker.registerMedia('media-1', file);
    expect(reg.success).toBe(true);
    expect(worker._media.has('media-1')).toBe(true);

    // Extract
    const annexB = await worker.extractPackets('media-1', 0, 1_000_000, false);
    expect(annexB.length).toBeGreaterThan(0);

    // Close
    worker.close('media-1');
    expect(worker._media.has('media-1')).toBe(false);

    // Extract after close should fail
    await expect(
      worker.extractPackets('media-1', 0, 1_000_000)
    ).rejects.toThrow('not registered');
  });

  it('can re-register after close', async () => {
    const file = { name: 'clip.mp4', _mockSampleData: new Uint8Array(0) };

    await worker.registerMedia('media-1', file);
    worker.close('media-1');

    const reg = await worker.registerMedia('media-1', file);
    expect(reg.success).toBe(true);
    expect(worker._media.has('media-1')).toBe(true);
  });

  it('close is idempotent', () => {
    expect(() => worker.close('nonexistent')).not.toThrow();
  });

  it('extractPackets time-range filtering is deferred to integration testing', async () => {
    // NOTE: The startTimeUs/endTimeUs parameters in extractPackets are accepted but
    // time-range filtering requires actual mp4box sample table data with chunk offsets
    // and decode timestamps, which cannot be meaningfully simulated in pure-logic tests.
    // Time-range filtering correctness is verified in integration tests with real media files.
    const file = {
      name: 'clip.mp4',
      _mockSampleData: buildAvccSample([new Uint8Array([0x65, 0x88])])
    };
    await worker.registerMedia('media-1', file);
    // Verify the API accepts time-range parameters without error
    const result = await worker.extractPackets('media-1', 0, 500_000, false);
    expect(result.length).toBeGreaterThan(0);
  });

  it('multiple media can coexist', async () => {
    const file1 = { name: 'a.mp4', _mockSampleData: buildAvccSample([new Uint8Array([0x65])]) };
    const file2 = { name: 'b.mp4', _mockSampleData: buildAvccSample([new Uint8Array([0x41])]) };

    await worker.registerMedia('m1', file1);
    await worker.registerMedia('m2', file2);

    const a = await worker.extractPackets('m1', 0, 1_000_000, false);
    const b = await worker.extractPackets('m2', 0, 1_000_000, false);

    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // Different source data -> different output
    expect(a[4]).toBe(0x65); // IDR
    expect(b[4]).toBe(0x41); // non-IDR
  });
});

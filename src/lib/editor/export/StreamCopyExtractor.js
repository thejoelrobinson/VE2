// Stream copy: extract raw H.264 packets from source video without re-encoding.
// Used by ExportPipeline for clips that need no visual processing (smart render).
import { packetExtractWorker } from '../media/PacketExtractWorker.js';
import logger from '../../utils/logger.js';

export const streamCopyExtractor = {
  // Extract Annex B bitstream for a media clip's source range.
  // startTimeSec / endTimeSec are source media times (not timeline frames).
  // Returns Uint8Array of raw H.264 Annex B data ready for FFmpeg muxing.
  async extractPackets(mediaId, startTimeSec, endTimeSec, prependConfig = true) {
    const startTimeUs = Math.round(startTimeSec * 1000000);
    const endTimeUs = Math.round(endTimeSec * 1000000);

    logger.info(`[StreamCopy] Extracting packets: media=${mediaId}, ${startTimeSec.toFixed(3)}s-${endTimeSec.toFixed(3)}s`);

    const data = await packetExtractWorker.extractPackets(mediaId, startTimeUs, endTimeUs, prependConfig);

    logger.info(`[StreamCopy] Extracted ${(data.byteLength / 1024).toFixed(0)}KB bitstream`);
    return data;
  },

  // Register a media file for stream copy extraction.
  // Should be called when media is imported so codec info is available.
  async registerMedia(mediaId, file) {
    return packetExtractWorker.registerMedia(mediaId, file);
  },

  // Release resources for a media file.
  closeMedia(mediaId) {
    packetExtractWorker.close(mediaId);
  }
};

export default streamCopyExtractor;

// Feed composited JPEG frames to FFmpeg virtual filesystem
import { ffmpegBridge } from './FFmpegBridge.js';
import logger from '../../utils/logger.js';

const FRAME_FORMAT = 'image/jpeg';
const FRAME_QUALITY = 0.92;
const FRAME_EXT = 'jpg';

export const frameFeeder = {
  // Render all frames and write to FFmpeg filesystem
  async feedFrames(startFrame, endFrame, canvas, compositeFn, onProgress) {
    const total = endFrame - startFrame;
    let rendered = 0;

    for (let frame = startFrame; frame < endFrame; frame++) {
      await compositeFn(frame);

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, FRAME_FORMAT, FRAME_QUALITY);
      });

      const arrayBuffer = await blob.arrayBuffer();
      const uint8 = new Uint8Array(arrayBuffer);

      const paddedNum = String(rendered).padStart(6, '0');
      await ffmpegBridge.writeFile(`frame_${paddedNum}.${FRAME_EXT}`, uint8);

      rendered++;
      if (onProgress) {
        onProgress(rendered / total, rendered, total);
      }
    }

    logger.info(`Fed ${rendered} frames to FFmpeg`);
    return rendered;
  },

  // Clean up frame files
  async cleanupFrames(count) {
    for (let i = 0; i < count; i++) {
      const paddedNum = String(i).padStart(6, '0');
      await ffmpegBridge.deleteFile(`frame_${paddedNum}.${FRAME_EXT}`);
    }
  }
};

export default frameFeeder;

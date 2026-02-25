// Blue conform bars in the timeline ruler — shows pre-encoded frames
import { conformEncoder } from '../media/ConformEncoder.js';
import { frameToPixel, pixelToFrame } from '../timeline/TimelineMath.js';

export const conformBarOverlay = {
  // Draws blue conform bars below the render bars in the ruler canvas.
  // Called from TimelineRuler.render()
  draw(ctx, width, height, scrollX) {
    const startFrame = pixelToFrame(scrollX);
    const endFrame = pixelToFrame(scrollX + width);
    const barY = height - 2; // 2px strip at very bottom (render bars are at height-4)

    for (let f = Math.floor(startFrame); f <= Math.ceil(endFrame); f++) {
      if (!conformEncoder.isFrameConformed(f)) continue;

      const barX = frameToPixel(f) - scrollX;
      const barW = Math.max(1, frameToPixel(f + 1) - frameToPixel(f));

      ctx.fillStyle = '#42a5f5'; // blue
      ctx.fillRect(barX, barY, barW, 2);
    }
  }
};

export default conformBarOverlay;

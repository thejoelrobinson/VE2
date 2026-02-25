// Premiere-style colored render bars in the timeline ruler
// Green = pre-rendered, Yellow = simple, Red = complex
import { renderAheadManager } from '../media/RenderAheadManager.js';
import { frameToPixel, pixelToFrame } from '../timeline/TimelineMath.js';
import { editorState } from '../core/EditorState.js';

export const renderBarOverlay = {
  // Draws render bars into the ruler canvas context
  // Called from TimelineRuler.render() — not a standalone component
  draw(ctx, width, height, scrollX) {
    const startFrame = pixelToFrame(scrollX);
    const endFrame = pixelToFrame(scrollX + width);
    const barY = height - 6; // 4px strip above the conform bar (2px at very bottom)

    for (let f = Math.floor(startFrame); f <= Math.ceil(endFrame); f++) {
      const status = renderAheadManager.getSegmentStatus(f);
      if (!status) continue;

      const barX = frameToPixel(f) - scrollX;
      const barW = Math.max(1, frameToPixel(f + 1) - frameToPixel(f));

      if (status === 'green') {
        ctx.fillStyle = '#4caf50';
      } else if (status === 'yellow') {
        ctx.fillStyle = '#ffc107';
      } else {
        ctx.fillStyle = '#f44336';
      }

      ctx.fillRect(barX, barY, barW, 4);
    }
  }
};

export default renderBarOverlay;

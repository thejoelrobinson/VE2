// Title/text overlay rendering (fonts, positioning, backgrounds, animation)

export const textRenderer = {
  // Render text overlay onto a canvas context
  render(ctx, textClip, canvasWidth, canvasHeight) {
    const {
      text = 'Title',
      fontFamily = 'Arial',
      fontSize = 64,
      fontWeight = 'bold',
      color = '#ffffff',
      backgroundColor = '',
      backgroundPadding = 20,
      align = 'center',     // left, center, right
      verticalAlign = 'center', // top, center, bottom
      x = 0,                // pixel offset from aligned position
      y = 0,
      letterSpacing = 0,
      lineHeight = 1.3,
      stroke = false,
      strokeColor = '#000000',
      strokeWidth = 2,
      shadow = false,
      shadowColor = 'rgba(0,0,0,0.5)',
      shadowBlur = 8,
      shadowOffsetX = 2,
      shadowOffsetY = 2,
      opacity = 1
    } = textClip;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Setup font
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    ctx.textBaseline = 'top';

    // Split text into lines
    const lines = text.split('\n');
    const lineMetrics = lines.map(line => ctx.measureText(line));
    const lineHeightPx = fontSize * lineHeight;
    const totalHeight = lines.length * lineHeightPx;

    // Calculate max width
    const maxWidth = Math.max(...lineMetrics.map(m => m.width));

    // Determine base position from alignment
    let baseX, baseY;

    switch (align) {
      case 'left':
        baseX = 40;
        ctx.textAlign = 'left';
        break;
      case 'right':
        baseX = canvasWidth - 40;
        ctx.textAlign = 'right';
        break;
      default:
        baseX = canvasWidth / 2;
        ctx.textAlign = 'center';
    }

    switch (verticalAlign) {
      case 'top':
        baseY = 40;
        break;
      case 'bottom':
        baseY = canvasHeight - totalHeight - 40;
        break;
      default:
        baseY = (canvasHeight - totalHeight) / 2;
    }

    baseX += x;
    baseY += y;

    // Background rectangle
    if (backgroundColor) {
      const bgX = align === 'center' ? baseX - maxWidth / 2 - backgroundPadding :
                  align === 'right' ? baseX - maxWidth - backgroundPadding :
                  baseX - backgroundPadding;
      const bgY = baseY - backgroundPadding;
      const bgW = maxWidth + backgroundPadding * 2;
      const bgH = totalHeight + backgroundPadding * 2;

      ctx.fillStyle = backgroundColor;
      ctx.beginPath();
      ctx.roundRect(bgX, bgY, bgW, bgH, 8);
      ctx.fill();
    }

    // Shadow
    if (shadow) {
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = shadowBlur;
      ctx.shadowOffsetX = shadowOffsetX;
      ctx.shadowOffsetY = shadowOffsetY;
    }

    // Render each line
    for (let i = 0; i < lines.length; i++) {
      const lineY = baseY + i * lineHeightPx;

      // Stroke
      if (stroke) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = 'round';
        ctx.strokeText(lines[i], baseX, lineY);
      }

      // Fill
      ctx.fillStyle = color;
      ctx.fillText(lines[i], baseX, lineY);
    }

    ctx.restore();
  },

  // Create a default text clip config
  createTextConfig(text = 'Title') {
    return {
      text,
      fontFamily: 'Arial',
      fontSize: 64,
      fontWeight: 'bold',
      color: '#ffffff',
      backgroundColor: '',
      backgroundPadding: 20,
      align: 'center',
      verticalAlign: 'center',
      x: 0,
      y: 0,
      letterSpacing: 0,
      lineHeight: 1.3,
      stroke: true,
      strokeColor: '#000000',
      strokeWidth: 2,
      shadow: true,
      shadowColor: 'rgba(0,0,0,0.5)',
      shadowBlur: 8,
      shadowOffsetX: 2,
      shadowOffsetY: 2,
      opacity: 1
    };
  }
};

export default textRenderer;

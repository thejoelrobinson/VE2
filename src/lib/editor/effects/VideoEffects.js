// Video effects: color correction, blur, sharpen, transform, crop, curves, levels
import { effectRegistry } from './EffectRegistry.js';
import { clamp } from '../core/MathUtils.js';

// Brightness / Contrast
effectRegistry.register({
  id: 'brightness-contrast',
  name: 'Brightness / Contrast',
  category: 'Color Correction',
  type: 'video',
  params: [
    { id: 'brightness', name: 'Brightness', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'contrast', name: 'Contrast', type: 'range', min: -100, max: 100, default: 0, step: 1 }
  ],
  apply(ctx, params) {
    const b = params.brightness / 100;
    const c = (params.contrast + 100) / 100;
    const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      // Brightness
      d[i] = clamp255(d[i] + b * 255);
      d[i + 1] = clamp255(d[i + 1] + b * 255);
      d[i + 2] = clamp255(d[i + 2] + b * 255);
      // Contrast
      d[i] = clamp255((d[i] - 128) * c + 128);
      d[i + 1] = clamp255((d[i + 1] - 128) * c + 128);
      d[i + 2] = clamp255((d[i + 2] - 128) * c + 128);
    }
    ctx.putImageData(imageData, 0, 0);
  }
});

// Saturation
effectRegistry.register({
  id: 'saturation',
  name: 'Saturation',
  category: 'Color Correction',
  type: 'video',
  params: [
    { id: 'amount', name: 'Saturation', type: 'range', min: -100, max: 100, default: 0, step: 1 }
  ],
  apply(ctx, params) {
    const s = (params.amount + 100) / 100;
    const imageData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      d[i] = clamp255(gray + s * (d[i] - gray));
      d[i + 1] = clamp255(gray + s * (d[i + 1] - gray));
      d[i + 2] = clamp255(gray + s * (d[i + 2] - gray));
    }
    ctx.putImageData(imageData, 0, 0);
  }
});

// Hue Rotate
effectRegistry.register({
  id: 'hue-rotate',
  name: 'Hue Rotate',
  category: 'Color Correction',
  type: 'video',
  params: [
    { id: 'angle', name: 'Angle', type: 'range', min: 0, max: 360, default: 0, step: 1, unit: '°' }
  ],
  apply(ctx, params) {
    ctx.filter = `hue-rotate(${params.angle}deg)`;
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.filter = 'none';
  }
});

// Blur
effectRegistry.register({
  id: 'gaussian-blur',
  name: 'Gaussian Blur',
  category: 'Blur & Sharpen',
  type: 'video',
  params: [
    { id: 'radius', name: 'Radius', type: 'range', min: 0, max: 50, default: 0, step: 0.5, unit: 'px' }
  ],
  apply(ctx, params) {
    if (params.radius <= 0) return;
    ctx.filter = `blur(${params.radius}px)`;
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.filter = 'none';
  }
});

// Opacity
effectRegistry.register({
  id: 'opacity',
  name: 'Opacity',
  category: 'Compositing',
  type: 'video',
  params: [
    { id: 'opacity', name: 'Opacity', type: 'range', min: 0, max: 100, default: 100, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    ctx.globalAlpha = params.opacity / 100;
  }
});

// Transform (Scale + Position)
effectRegistry.register({
  id: 'transform',
  name: 'Transform',
  category: 'Transform',
  type: 'video',
  params: [
    { id: 'scaleX', name: 'Scale X', type: 'range', min: 0, max: 400, default: 100, step: 1, unit: '%' },
    { id: 'scaleY', name: 'Scale Y', type: 'range', min: 0, max: 400, default: 100, step: 1, unit: '%' },
    { id: 'posX', name: 'Position X', type: 'range', min: -1920, max: 1920, default: 0, step: 1, unit: 'px' },
    { id: 'posY', name: 'Position Y', type: 'range', min: -1080, max: 1080, default: 0, step: 1, unit: 'px' },
    { id: 'rotation', name: 'Rotation', type: 'range', min: -360, max: 360, default: 0, step: 0.1, unit: '°' }
  ],
  apply(ctx, params) {
    const cx = ctx.canvas.width / 2;
    const cy = ctx.canvas.height / 2;
    ctx.save();
    ctx.translate(cx + params.posX, cy + params.posY);
    ctx.rotate((params.rotation * Math.PI) / 180);
    ctx.scale(params.scaleX / 100, params.scaleY / 100);
    ctx.translate(-cx, -cy);
    // The actual frame must be drawn after this transform is set
    // This effect modifies the context transform for subsequent draws
  }
});

// Invert
effectRegistry.register({
  id: 'invert',
  name: 'Invert Colors',
  category: 'Stylize',
  type: 'video',
  params: [
    { id: 'amount', name: 'Amount', type: 'range', min: 0, max: 100, default: 100, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    if (params.amount <= 0) return;
    ctx.filter = `invert(${params.amount}%)`;
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.filter = 'none';
  }
});

// Grayscale
effectRegistry.register({
  id: 'grayscale',
  name: 'Grayscale',
  category: 'Stylize',
  type: 'video',
  params: [
    { id: 'amount', name: 'Amount', type: 'range', min: 0, max: 100, default: 100, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    if (params.amount <= 0) return;
    ctx.filter = `grayscale(${params.amount}%)`;
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.filter = 'none';
  }
});

// Sepia
effectRegistry.register({
  id: 'sepia',
  name: 'Sepia',
  category: 'Stylize',
  type: 'video',
  params: [
    { id: 'amount', name: 'Amount', type: 'range', min: 0, max: 100, default: 100, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    if (params.amount <= 0) return;
    ctx.filter = `sepia(${params.amount}%)`;
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.filter = 'none';
  }
});

// Drop Shadow
effectRegistry.register({
  id: 'drop-shadow',
  name: 'Drop Shadow',
  category: 'Compositing',
  type: 'video',
  params: [
    { id: 'offsetX', name: 'Offset X', type: 'range', min: -50, max: 50, default: 4, step: 1, unit: 'px' },
    { id: 'offsetY', name: 'Offset Y', type: 'range', min: -50, max: 50, default: 4, step: 1, unit: 'px' },
    { id: 'blur', name: 'Blur', type: 'range', min: 0, max: 50, default: 8, step: 1, unit: 'px' },
    { id: 'color', name: 'Color', type: 'color', default: '#000000' }
  ],
  apply(ctx, params) {
    ctx.filter = `drop-shadow(${params.offsetX}px ${params.offsetY}px ${params.blur}px ${params.color})`;
    ctx.drawImage(ctx.canvas, 0, 0);
    ctx.filter = 'none';
  }
});

// Sharpen (Unsharp Mask approximation)
effectRegistry.register({
  id: 'sharpen',
  name: 'Sharpen',
  category: 'Blur & Sharpen',
  type: 'video',
  params: [
    { id: 'amount', name: 'Amount', type: 'range', min: 0, max: 200, default: 50, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    if (params.amount <= 0) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;
    const copy = new Uint8ClampedArray(d);
    const factor = params.amount / 100;

    // Simple 3x3 sharpen kernel
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const center = copy[idx + c] * 5;
          const neighbors =
            copy[((y - 1) * w + x) * 4 + c] +
            copy[((y + 1) * w + x) * 4 + c] +
            copy[(y * w + (x - 1)) * 4 + c] +
            copy[(y * w + (x + 1)) * 4 + c];
          const sharpened = center - neighbors;
          d[idx + c] = clamp255(copy[idx + c] + (sharpened - copy[idx + c]) * factor);
        }
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }
});

// Motion (intrinsic — compositing handled by VideoCompositor, not apply())
effectRegistry.register({
  id: 'motion',
  name: 'Motion',
  category: 'Transform',
  type: 'video',
  params: [
    { id: 'posX', name: 'Position X', type: 'range', min: -3840, max: 3840, default: 960, step: 0.5, unit: 'px' },
    { id: 'posY', name: 'Position Y', type: 'range', min: -2160, max: 2160, default: 540, step: 0.5, unit: 'px' },
    { id: 'scale', name: 'Scale Height', type: 'range', min: 0, max: 600, default: 100, step: 0.1, unit: '%' },
    { id: 'scaleWidth', name: 'Scale Width', type: 'range', min: 0, max: 600, default: 100, step: 0.1, unit: '%' },
    { id: 'uniformScale', name: 'Uniform Scale', type: 'checkbox', default: true },
    { id: 'rotation', name: 'Rotation', type: 'range', min: -3600, max: 3600, default: 0, step: 0.1, unit: '°' },
    { id: 'anchorX', name: 'Anchor X', type: 'range', min: -3840, max: 3840, default: 960, step: 0.5, unit: 'px' },
    { id: 'anchorY', name: 'Anchor Y', type: 'range', min: -2160, max: 2160, default: 540, step: 0.5, unit: 'px' },
    { id: 'antiFlicker', name: 'Anti-flicker', type: 'range', min: 0, max: 1, default: 0, step: 0.01 },
    { id: 'cropLeft', name: 'Crop Left', type: 'range', min: 0, max: 100, default: 0, step: 0.1, unit: '%' },
    { id: 'cropTop', name: 'Crop Top', type: 'range', min: 0, max: 100, default: 0, step: 0.1, unit: '%' },
    { id: 'cropRight', name: 'Crop Right', type: 'range', min: 0, max: 100, default: 0, step: 0.1, unit: '%' },
    { id: 'cropBottom', name: 'Crop Bottom', type: 'range', min: 0, max: 100, default: 0, step: 0.1, unit: '%' }
  ],
  apply() { /* No-op: VideoCompositor handles motion compositing directly */ }
});

// Time Remapping (intrinsic, starts disabled)
effectRegistry.register({
  id: 'time-remap',
  name: 'Time Remapping',
  category: 'Time',
  type: 'video',
  params: [
    { id: 'speed', name: 'Speed', type: 'range', min: -1000, max: 1000, default: 100, step: 1, unit: '%' }
  ],
  apply() { /* Handled by Clip.getSourceFrameAtPlayhead */ }
});

// Crop
effectRegistry.register({
  id: 'crop',
  name: 'Crop',
  category: 'Transform',
  type: 'video',
  params: [
    { id: 'top', name: 'Top', type: 'range', min: 0, max: 50, default: 0, step: 1, unit: '%' },
    { id: 'bottom', name: 'Bottom', type: 'range', min: 0, max: 50, default: 0, step: 1, unit: '%' },
    { id: 'left', name: 'Left', type: 'range', min: 0, max: 50, default: 0, step: 1, unit: '%' },
    { id: 'right', name: 'Right', type: 'range', min: 0, max: 50, default: 0, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const top = (params.top / 100) * h;
    const bottom = (params.bottom / 100) * h;
    const left = (params.left / 100) * w;
    const right = (params.right / 100) * w;

    if (top > 0 || bottom > 0 || left > 0 || right > 0) {
      // Black out the cropped regions
      ctx.fillStyle = '#000';
      if (top > 0) ctx.fillRect(0, 0, w, top);
      if (bottom > 0) ctx.fillRect(0, h - bottom, w, bottom);
      if (left > 0) ctx.fillRect(0, 0, left, h);
      if (right > 0) ctx.fillRect(w - right, 0, right, h);
    }
  }
});

// Levels (shadows, midtones, highlights)
effectRegistry.register({
  id: 'levels',
  name: 'Levels',
  category: 'Color Correction',
  type: 'video',
  params: [
    { id: 'inputBlack', name: 'Input Black', type: 'range', min: 0, max: 255, default: 0, step: 1 },
    { id: 'inputWhite', name: 'Input White', type: 'range', min: 0, max: 255, default: 255, step: 1 },
    { id: 'gamma', name: 'Gamma', type: 'range', min: 0.1, max: 3, default: 1, step: 0.01 },
    { id: 'outputBlack', name: 'Output Black', type: 'range', min: 0, max: 255, default: 0, step: 1 },
    { id: 'outputWhite', name: 'Output White', type: 'range', min: 0, max: 255, default: 255, step: 1 }
  ],
  apply(ctx, params) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;

    const inRange = Math.max(1, params.inputWhite - params.inputBlack);
    const outRange = params.outputWhite - params.outputBlack;
    const gamma = 1 / params.gamma;

    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let val = d[i + c];
        // Input levels
        val = (val - params.inputBlack) / inRange;
        val = clamp(val, 0, 1);
        // Gamma
        val = Math.pow(val, gamma);
        // Output levels
        val = val * outRange + params.outputBlack;
        d[i + c] = clamp255(val);
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }
});

// HSL Adjust
effectRegistry.register({
  id: 'hsl-adjust',
  name: 'HSL Adjust',
  category: 'Color Correction',
  type: 'video',
  params: [
    { id: 'hue', name: 'Hue', type: 'range', min: -180, max: 180, default: 0, step: 1, unit: '°' },
    { id: 'saturation', name: 'Saturation', type: 'range', min: -100, max: 100, default: 0, step: 1, unit: '%' },
    { id: 'lightness', name: 'Lightness', type: 'range', min: -100, max: 100, default: 0, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    if (params.hue === 0 && params.saturation === 0 && params.lightness === 0) return;

    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;

    for (let i = 0; i < d.length; i += 4) {
      let [h2, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      h2 = ((h2 * 360 + params.hue) % 360 + 360) % 360 / 360;
      s = clamp(s + params.saturation / 100, 0, 1);
      l = clamp(l + params.lightness / 100, 0, 1);
      const [r, g, b] = hslToRgb(h2, s, l);
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    ctx.putImageData(imageData, 0, 0);
  }
});

// Vignette
effectRegistry.register({
  id: 'vignette',
  name: 'Vignette',
  category: 'Stylize',
  type: 'video',
  params: [
    { id: 'amount', name: 'Amount', type: 'range', min: 0, max: 100, default: 50, step: 1, unit: '%' },
    { id: 'size', name: 'Size', type: 'range', min: 10, max: 100, default: 50, step: 1, unit: '%' }
  ],
  apply(ctx, params) {
    if (params.amount <= 0) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.max(cx, cy) * (params.size / 100);

    const gradient = ctx.createRadialGradient(cx, cy, radius * 0.5, cx, cy, radius);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, `rgba(0,0,0,${params.amount / 100})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
  }
});

function clamp255(v) {
  return clamp(Math.round(v), 0, 255);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

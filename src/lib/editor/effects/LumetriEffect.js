// Lumetri Color compound effect — unified color grading with 6 sections
import { effectRegistry } from './EffectRegistry.js';
import { clamp } from '../core/MathUtils.js';

effectRegistry.register({
  id: 'lumetri-color',
  name: 'Lumetri Color',
  category: 'Color Correction',
  type: 'video',
  params: [
    // === Section 1: Basic Correction ===
    { id: 'basic_enabled', name: 'Basic Correction', type: 'checkbox', default: true },
    // White Balance
    { id: 'temperature', name: 'Temperature', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'tint', name: 'Tint', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    // Tone
    { id: 'exposure', name: 'Exposure', type: 'range', min: -4, max: 4, default: 0, step: 0.01 },
    { id: 'contrast', name: 'Contrast', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'highlights', name: 'Highlights', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'shadows', name: 'Shadows', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'whites', name: 'Whites', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'blacks', name: 'Blacks', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    // Saturation / Vibrance
    { id: 'saturation', name: 'Saturation', type: 'range', min: 0, max: 200, default: 100, step: 1 },
    { id: 'vibrance', name: 'Vibrance', type: 'range', min: -100, max: 100, default: 0, step: 1 },

    // === Section 2: Creative ===
    { id: 'creative_enabled', name: 'Creative', type: 'checkbox', default: false },
    { id: 'faded_film', name: 'Faded Film', type: 'range', min: 0, max: 100, default: 0, step: 1 },
    { id: 'creative_sharpen', name: 'Sharpen', type: 'range', min: 0, max: 100, default: 0, step: 1 },
    { id: 'creative_vibrance', name: 'Vibrance', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'creative_saturation', name: 'Saturation', type: 'range', min: 0, max: 200, default: 100, step: 1 },
    { id: 'shadow_tint', name: 'Shadow Tint', type: 'color', default: '#808080' },
    { id: 'highlight_tint', name: 'Highlight Tint', type: 'color', default: '#808080' },
    { id: 'tint_balance', name: 'Tint Balance', type: 'range', min: -100, max: 100, default: 0, step: 1 },

    // === Section 3: Curves ===
    { id: 'curves_enabled', name: 'Curves', type: 'checkbox', default: false },
    // Curve control points stored as JSON arrays: [[x,y], ...]
    { id: 'curve_master', name: 'Master Curve', type: 'curve', default: [[0, 0], [1, 1]] },
    { id: 'curve_red', name: 'Red Curve', type: 'curve', default: [[0, 0], [1, 1]] },
    { id: 'curve_green', name: 'Green Curve', type: 'curve', default: [[0, 0], [1, 1]] },
    { id: 'curve_blue', name: 'Blue Curve', type: 'curve', default: [[0, 0], [1, 1]] },
    // HSL curves
    { id: 'curve_hue_vs_sat', name: 'Hue vs Sat', type: 'curve', default: [] },
    { id: 'curve_hue_vs_hue', name: 'Hue vs Hue', type: 'curve', default: [] },
    { id: 'curve_hue_vs_luma', name: 'Hue vs Luma', type: 'curve', default: [] },
    { id: 'curve_luma_vs_sat', name: 'Luma vs Sat', type: 'curve', default: [] },
    { id: 'curve_sat_vs_sat', name: 'Sat vs Sat', type: 'curve', default: [] },

    // === Section 4: Color Wheels & Match ===
    { id: 'wheels_enabled', name: 'Color Wheels', type: 'checkbox', default: false },
    // Shadow wheel
    { id: 'shadow_hue', name: 'Shadow Hue', type: 'range', min: 0, max: 360, default: 0, step: 1 },
    { id: 'shadow_sat', name: 'Shadow Saturation', type: 'range', min: 0, max: 100, default: 0, step: 1 },
    { id: 'shadow_luma', name: 'Shadow Luminance', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    // Midtone wheel
    { id: 'midtone_hue', name: 'Midtone Hue', type: 'range', min: 0, max: 360, default: 0, step: 1 },
    { id: 'midtone_sat', name: 'Midtone Saturation', type: 'range', min: 0, max: 100, default: 0, step: 1 },
    { id: 'midtone_luma', name: 'Midtone Luminance', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    // Highlight wheel
    { id: 'highlight_hue', name: 'Highlight Hue', type: 'range', min: 0, max: 360, default: 0, step: 1 },
    { id: 'highlight_sat', name: 'Highlight Saturation', type: 'range', min: 0, max: 100, default: 0, step: 1 },
    { id: 'highlight_luma', name: 'Highlight Luminance', type: 'range', min: -100, max: 100, default: 0, step: 1 },

    // === Section 5: HSL Secondary ===
    { id: 'hsl_enabled', name: 'HSL Secondary', type: 'checkbox', default: false },
    // Key controls
    { id: 'hsl_hue_center', name: 'Hue Center', type: 'range', min: 0, max: 360, default: 0, step: 1 },
    { id: 'hsl_hue_range', name: 'Hue Range', type: 'range', min: 0, max: 180, default: 30, step: 1 },
    { id: 'hsl_sat_center', name: 'Sat Center', type: 'range', min: 0, max: 100, default: 50, step: 1 },
    { id: 'hsl_sat_range', name: 'Sat Range', type: 'range', min: 0, max: 100, default: 50, step: 1 },
    { id: 'hsl_luma_center', name: 'Luma Center', type: 'range', min: 0, max: 100, default: 50, step: 1 },
    { id: 'hsl_luma_range', name: 'Luma Range', type: 'range', min: 0, max: 100, default: 50, step: 1 },
    { id: 'hsl_denoise', name: 'Denoise', type: 'range', min: 0, max: 100, default: 10, step: 1 },
    // Correction
    { id: 'hsl_temperature', name: 'Temperature', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'hsl_tint', name: 'Tint', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'hsl_contrast', name: 'Contrast', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'hsl_sharpen', name: 'Sharpen', type: 'range', min: 0, max: 100, default: 0, step: 1 },
    { id: 'hsl_saturation', name: 'Saturation', type: 'range', min: 0, max: 200, default: 100, step: 1 },
    // Mask preview
    { id: 'hsl_show_mask', name: 'Show Mask', type: 'checkbox', default: false },

    // === Section 6: Vignette ===
    { id: 'vignette_enabled', name: 'Vignette', type: 'checkbox', default: false },
    { id: 'vignette_amount', name: 'Amount', type: 'range', min: -100, max: 100, default: 0, step: 1 },
    { id: 'vignette_midpoint', name: 'Midpoint', type: 'range', min: 0, max: 100, default: 50, step: 1 },
    { id: 'vignette_roundness', name: 'Roundness', type: 'range', min: 0, max: 100, default: 50, step: 1 },
    { id: 'vignette_feather', name: 'Feather', type: 'range', min: 0, max: 100, default: 50, step: 1 }
  ],
  apply(ctx, params) {
    // Canvas2D fallback for non-GL path
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const imageData = ctx.getImageData(0, 0, w, h);
    const d = imageData.data;

    // Basic Correction (simplified Canvas2D fallback)
    if (params.basic_enabled) {
      const expMul = Math.pow(2.0, params.exposure);
      const contrastFactor = (params.contrast + 100) / 100;
      const sat = params.saturation / 100;

      for (let i = 0; i < d.length; i += 4) {
        // Exposure — clamp before contrast to avoid corrupted intermediate values
        d[i] = clamp255(d[i] * expMul);
        d[i + 1] = clamp255(d[i + 1] * expMul);
        d[i + 2] = clamp255(d[i + 2] * expMul);

        // Contrast
        d[i] = clamp255((d[i] - 128) * contrastFactor + 128);
        d[i + 1] = clamp255((d[i + 1] - 128) * contrastFactor + 128);
        d[i + 2] = clamp255((d[i + 2] - 128) * contrastFactor + 128);

        // Saturation
        const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        d[i] = clamp255(lum + sat * (d[i] - lum));
        d[i + 1] = clamp255(lum + sat * (d[i + 1] - lum));
        d[i + 2] = clamp255(lum + sat * (d[i + 2] - lum));
      }
    }

    // Vignette (simplified)
    if (params.vignette_enabled && params.vignette_amount !== 0) {
      const cx = w / 2;
      const cy = h / 2;
      const maxDist = Math.sqrt(cx * cx + cy * cy);
      const midpoint = params.vignette_midpoint / 100;
      const feather = Math.max(0.01, params.vignette_feather / 100);
      const amount = params.vignette_amount / 100;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = (x - cx) / cx;
          const dy = (y - cy) / cy;
          const dist = Math.sqrt(dx * dx + dy * dy) / 1.414;
          const vig = smoothstep(midpoint, midpoint + feather, dist);
          const factor = 1.0 - vig * amount;
          const idx = (y * w + x) * 4;
          d[idx] = clamp255(d[idx] * factor);
          d[idx + 1] = clamp255(d[idx + 1] * factor);
          d[idx + 2] = clamp255(d[idx + 2] * factor);
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }
});

function clamp255(v) {
  return clamp(Math.round(v), 0, 255);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Shared export utilities — safe to import from both main thread and Worker context
export { QUALITY_CRF } from '../core/Constants.js';

export function getMimeType(format) {
  if (format === 'webm') return 'video/webm';
  if (format === 'gif') return 'image/gif';
  return 'video/mp4';
}

// Per-frame QP values for WebCodecs quantizer mode (Chrome 134+)
// H.264 QP 0-51 (like CRF), VP9 QP 0-63. Lower = higher quality.
export const QUALITY_QP = {
  high:   { h264: 20, vp9: 28 },
  medium: { h264: 26, vp9: 34 },
  low:    { h264: 32, vp9: 42 }
};

// Hardware encoder quality floors at 1080p (VBR fallback when quantizer unavailable)
export const HW_QUALITY_BITRATE_1080P = {
  high:   20_000_000,
  medium: 12_000_000,
  low:     8_000_000
};
export const PIXELS_1080P = 1920 * 1080;

// Parse bitrate string (e.g. '5M', '192k', '5000000') to a number.
// Returns defaultVal when the input is falsy or unparseable.
export function parseBitrate(value, defaultVal = 5_000_000) {
  if (typeof value === 'number') return value;
  if (!value) return defaultVal;
  const match = String(value).match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) return defaultVal;
  const num = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'm') return num * 1_000_000;
  if (unit === 'k') return num * 1_000;
  return num;
}

// Returns FFmpeg CLI flags for color space metadata tagging
export function getFFmpegColorFlags(outputSpace) {
  switch (outputSpace) {
    case 'rec2020':
      return ['-colorspace', 'bt2020nc', '-color_trc', 'bt709', '-color_primaries', 'bt2020'];
    case 'display-p3':
      return ['-colorspace', 'bt709', '-color_trc', 'iec61966-2-1', '-color_primaries', 'smpte432'];
    case 'rec709':
    default:
      return ['-colorspace', 'bt709', '-color_trc', 'bt709', '-color_primaries', 'bt709'];
  }
}

// Color management module — color space detection, mapping, and conversion
import { editorState } from './EditorState.js';
import {
  COLOR_SPACES,
  COLOR_MANAGEMENT_PRESETS,
  STATE_PATHS
} from './Constants.js';
import logger from '../../utils/logger.js';

export const colorManagement = {
  _displayCapabilities: null,

  init() {
    this.detectDisplayCapabilities();
    logger.info('ColorManagement initialized');
  },

  // Detect display color capabilities via CSS media queries
  detectDisplayCapabilities() {
    if (this._displayCapabilities) return this._displayCapabilities;

    const gamut = {
      srgb: true,
      p3: typeof matchMedia !== 'undefined' && matchMedia('(color-gamut: p3)').matches,
      rec2020: typeof matchMedia !== 'undefined' && matchMedia('(color-gamut: rec2020)').matches
    };

    const hdr = typeof matchMedia !== 'undefined' &&
      matchMedia('(dynamic-range: high)').matches;

    const colorDepth = typeof screen !== 'undefined' ? screen.colorDepth || 24 : 24;

    this._displayCapabilities = { gamut, hdr, colorDepth };
    logger.info('Display capabilities:', this._displayCapabilities);
    return this._displayCapabilities;
  },

  getWorkingSpace() {
    return editorState.get(STATE_PATHS.PROJECT_WORKING_SPACE) || 'rec709';
  },

  getOutputSpace() {
    return editorState.get(STATE_PATHS.PROJECT_OUTPUT_SPACE) || 'rec709';
  },

  isLinearCompositing() {
    return editorState.get(STATE_PATHS.PROJECT_LINEAR_COMPOSITING) ?? true;
  },

  isColorSpaceAwareEffects() {
    return editorState.get(STATE_PATHS.PROJECT_COLOR_AWARE_EFFECTS) ?? true;
  },

  applyPreset(presetId) {
    const preset = COLOR_MANAGEMENT_PRESETS[presetId];
    if (!preset) {
      logger.warn(`Unknown color management preset: ${presetId}`);
      return false;
    }
    editorState.set(STATE_PATHS.PROJECT_COLOR_PRESET, presetId);
    editorState.set(STATE_PATHS.PROJECT_WORKING_SPACE, preset.workingSpace);
    editorState.set(STATE_PATHS.PROJECT_OUTPUT_SPACE, preset.outputSpace);
    editorState.set(STATE_PATHS.PROJECT_LINEAR_COMPOSITING, preset.linearCompositing);
    editorState.set(STATE_PATHS.PROJECT_COLOR_AWARE_EFFECTS, preset.colorSpaceAwareEffects);
    logger.info(`Applied color preset: ${preset.name}`);
    return true;
  },

  // Map WebCodecs VideoColorSpace (primaries/transfer/matrix) to our COLOR_SPACES enum
  mapVideoFrameColorSpace(vfColorSpace) {
    if (!vfColorSpace) return COLOR_SPACES.REC709;

    const { primaries, transfer } = vfColorSpace;

    if (primaries === 'bt709' && transfer === 'iec61966-2-1') return COLOR_SPACES.SRGB;
    if (primaries === 'bt709') return COLOR_SPACES.REC709;
    if (primaries === 'smpte170m') return COLOR_SPACES.REC601_NTSC;
    if (primaries === 'bt470bg') return COLOR_SPACES.REC601_PAL;
    if (primaries === 'bt2020') return COLOR_SPACES.REC2020;
    if (primaries === 'smpte432') return COLOR_SPACES.DISPLAY_P3;

    // Default assumption for HD content with no metadata
    return COLOR_SPACES.REC709;
  },

  // Returns VideoFrame color space descriptor for export encoding
  getExportColorSpace(outputSpace) {
    switch (outputSpace) {
      case 'rec2020':
        return { primaries: 'bt2020', transfer: 'bt709', matrix: 'bt2020-ncl', fullRange: false };
      case 'display-p3':
        return { primaries: 'smpte432', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: false };
      case 'rec709':
      default:
        return { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
    }
  },

  // Returns FFmpeg flags for output color tagging
  getFFmpegColorFlags(outputSpace) {
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
};

export default colorManagement;

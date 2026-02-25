// Export presets: YouTube 1080p/4K, Social, WebM, etc.
// 'match-sequence' inherits from sequence settings so export matches what the user sees.

import { editorState } from '../core/EditorState.js';
import { getAvcCodecForResolution, SEQUENCE_CODECS, STATE_PATHS, DEFAULT_SEQUENCE_BITRATE_MODE, DEFAULT_SEQUENCE_QUALITY } from '../core/Constants.js';

export const EXPORT_PRESETS = {
  'match-sequence': {
    id: 'match-sequence',
    name: 'Match Sequence',
    dynamic: true // resolved at export time via getPreset()
  },
  'youtube-1080p': {
    id: 'youtube-1080p',
    name: 'YouTube 1080p',
    format: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrate: '8M',
    audioBitrate: '192k',
    audioSampleRate: 48000,
    preset: 'medium',
    pixelFormat: 'yuv420p',
    webCodecsCodec: 'avc1.640028',  // H.264 High Level 4.0
    bitrateMode: 'variable',
    quality: 'medium'
  },
  'youtube-720p': {
    id: 'youtube-720p',
    name: 'YouTube 720p',
    format: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    width: 1280,
    height: 720,
    fps: 30,
    videoBitrate: '5M',
    audioBitrate: '192k',
    audioSampleRate: 48000,
    preset: 'medium',
    pixelFormat: 'yuv420p',
    webCodecsCodec: 'avc1.64001f',  // H.264 High Level 3.1
    bitrateMode: 'variable',
    quality: 'medium'
  },
  'social-square': {
    id: 'social-square',
    name: 'Social Media Square',
    format: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    width: 1080,
    height: 1080,
    fps: 30,
    videoBitrate: '5M',
    audioBitrate: '128k',
    audioSampleRate: 44100,
    preset: 'medium',
    pixelFormat: 'yuv420p',
    webCodecsCodec: 'avc1.640028',
    bitrateMode: 'variable',
    quality: 'medium'
  },
  'social-vertical': {
    id: 'social-vertical',
    name: 'Social Media Vertical (9:16)',
    format: 'mp4',
    videoCodec: 'libx264',
    audioCodec: 'aac',
    width: 1080,
    height: 1920,
    fps: 30,
    videoBitrate: '6M',
    audioBitrate: '128k',
    audioSampleRate: 44100,
    preset: 'medium',
    pixelFormat: 'yuv420p',
    webCodecsCodec: 'avc1.640028',
    bitrateMode: 'variable',
    quality: 'medium'
  },
  'webm-vp9': {
    id: 'webm-vp9',
    name: 'WebM VP9',
    format: 'webm',
    videoCodec: 'libvpx-vp9',
    audioCodec: 'libopus',
    width: 1920,
    height: 1080,
    fps: 30,
    videoBitrate: '5M',
    audioBitrate: '128k',
    audioSampleRate: 48000,
    preset: null,
    pixelFormat: 'yuv420p',
    webCodecsCodec: 'vp09.00.10.08',
    bitrateMode: 'variable',
    quality: 'medium'
  },
  'gif': {
    id: 'gif',
    name: 'Animated GIF',
    format: 'gif',
    videoCodec: null,
    audioCodec: null,
    width: 640,
    height: 360,
    fps: 15,
    videoBitrate: null,
    audioBitrate: null,
    audioSampleRate: null,
    preset: null,
    pixelFormat: null,
    bitrateMode: 'variable',
    quality: 'medium'
  }
};

export function getPresetList() {
  return Object.values(EXPORT_PRESETS);
}

export function getPreset(id) {
  const preset = EXPORT_PRESETS[id] || EXPORT_PRESETS['match-sequence'];

  // Resolve dynamic 'match-sequence' preset from current sequence settings
  if (preset.dynamic) {
    const canvas = editorState.get(STATE_PATHS.PROJECT_CANVAS) || { width: 1920, height: 1080 };
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const codec = editorState.get(STATE_PATHS.PROJECT_CODEC) || SEQUENCE_CODECS.H264;
    const bitrate = editorState.get(STATE_PATHS.PROJECT_BITRATE) || '8M';
    const bitrateMode = editorState.get(STATE_PATHS.PROJECT_BITRATE_MODE) || DEFAULT_SEQUENCE_BITRATE_MODE;
    const quality = editorState.get(STATE_PATHS.PROJECT_QUALITY) || DEFAULT_SEQUENCE_QUALITY;
    const isH264 = codec.startsWith('avc1');
    const webCodecsCodec = isH264
      ? getAvcCodecForResolution(canvas.width, canvas.height)
      : codec;

    return {
      id: 'match-sequence',
      name: 'Match Sequence',
      format: isH264 ? 'mp4' : 'webm',
      videoCodec: isH264 ? 'libx264' : 'libvpx-vp9',
      audioCodec: isH264 ? 'aac' : 'libopus',
      width: canvas.width,
      height: canvas.height,
      fps,
      videoBitrate: bitrate,
      audioBitrate: '192k',
      audioSampleRate: 48000,
      preset: 'medium',
      pixelFormat: 'yuv420p',
      webCodecsCodec,
      bitrateMode,
      quality
    };
  }

  return preset;
}

export default EXPORT_PRESETS;

// Track data model
import { TRACK_TYPES } from '../core/Constants.js';

let trackIdCounter = 0;

export function createTrack(options = {}) {
  return {
    id: options.id || `track-${++trackIdCounter}`,
    name: options.name || `Track ${trackIdCounter}`,
    type: options.type || TRACK_TYPES.VIDEO,
    clips: [],
    transitions: [],
    muted: false,
    solo: false,
    locked: false,
    height: options.height || 48,
    visible: true
  };
}

export function isVideoTrack(track) {
  return track.type === TRACK_TYPES.VIDEO || track.type === TRACK_TYPES.TITLE;
}

export function isAudioTrack(track) {
  return track.type === TRACK_TYPES.AUDIO;
}

export function resetTrackIds() {
  trackIdCounter = 0;
}

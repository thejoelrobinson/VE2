// Marker and in/out point management
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';

let markerIdCounter = 0;

export const MARKER_COLORS = {
  GREEN: '#30d158',
  RED: '#ff3b30',
  BLUE: '#007aff',
  YELLOW: '#ffcc00',
  PURPLE: '#af52de',
  ORANGE: '#ff9500',
  CYAN: '#5ac8fa'
};

export function createMarker(options = {}) {
  return {
    id: options.id || `marker-${++markerIdCounter}`,
    frame: options.frame ?? 0,
    name: options.name || '',
    color: options.color || MARKER_COLORS.GREEN,
    duration: options.duration || 0 // 0 = point marker, >0 = range marker
  };
}

// Helpers — read/write the per-sequence markers array through EditorState.
// Using timeline.markers (shimmed to sequences[activeId].markers) ensures markers
// are per-sequence, saved with the project, and eligible for history undo.
function _getMarkers() {
  return editorState.get(STATE_PATHS.TIMELINE_MARKERS) || [];
}
function _setMarkers(arr) {
  editorState.set(STATE_PATHS.TIMELINE_MARKERS, arr);
}

export const markerManager = {
  addMarker(frame, name = '', color = MARKER_COLORS.GREEN) {
    const marker = createMarker({ frame, name, color });
    const markers = [..._getMarkers(), marker];
    markers.sort((a, b) => a.frame - b.frame);
    _setMarkers(markers);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    return marker;
  },

  addMarkerAtPlayhead(name = '', color = MARKER_COLORS.GREEN) {
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    return this.addMarker(frame, name, color);
  },

  removeMarker(markerId) {
    const markers = _getMarkers();
    const idx = markers.findIndex(m => m.id === markerId);
    if (idx >= 0) {
      const next = [...markers];
      next.splice(idx, 1);
      _setMarkers(next);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      return true;
    }
    return false;
  },

  getMarker(markerId) {
    return _getMarkers().find(m => m.id === markerId);
  },

  getAllMarkers() {
    return [..._getMarkers()];
  },

  getMarkersInRange(startFrame, endFrame) {
    return _getMarkers().filter(m => m.frame >= startFrame && m.frame <= endFrame);
  },

  getNextMarker(currentFrame) {
    return _getMarkers().find(m => m.frame > currentFrame) || null;
  },

  getPreviousMarker(currentFrame) {
    const markers = _getMarkers();
    for (let i = markers.length - 1; i >= 0; i--) {
      if (markers[i].frame < currentFrame) return markers[i];
    }
    return null;
  },

  updateMarker(markerId, updates) {
    const markers = _getMarkers();
    const idx = markers.findIndex(m => m.id === markerId);
    if (idx < 0) return false;
    const marker = { ...markers[idx] };
    if (updates.name !== undefined) marker.name = updates.name;
    if (updates.color !== undefined) marker.color = updates.color;
    if (updates.frame !== undefined) marker.frame = updates.frame;
    if (updates.duration !== undefined) marker.duration = updates.duration;
    const next = [...markers];
    next[idx] = marker;
    if (updates.frame !== undefined) next.sort((a, b) => a.frame - b.frame);
    _setMarkers(next);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    return true;
  },

  clearAllMarkers() {
    _setMarkers([]);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  },

  // In/Out points (shortcut interface)
  setInPoint(frame) {
    editorState.set(STATE_PATHS.PLAYBACK_IN_POINT, frame ?? editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME));
  },

  setOutPoint(frame) {
    editorState.set(STATE_PATHS.PLAYBACK_OUT_POINT, frame ?? editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME));
  },

  clearInOutPoints() {
    editorState.set(STATE_PATHS.PLAYBACK_IN_POINT, null);
    editorState.set(STATE_PATHS.PLAYBACK_OUT_POINT, null);
  },

  getInOutRange() {
    return {
      inPoint: editorState.get(STATE_PATHS.PLAYBACK_IN_POINT),
      outPoint: editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT)
    };
  }
};

export default markerManager;

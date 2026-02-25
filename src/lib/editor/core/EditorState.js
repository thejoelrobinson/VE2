// Observable state store for the editor
import { eventBus } from './EventBus.js';
import { DEFAULT_FRAME_RATE, DEFAULT_CANVAS, TOOL_TYPES, DEFAULT_ZOOM_INDEX, EDITOR_EVENTS, DEFAULT_SEQUENCE_CODEC, DEFAULT_SEQUENCE_BITRATE, DEFAULT_SEQUENCE_BITRATE_MODE, DEFAULT_SEQUENCE_QUALITY, DEFAULT_COLOR_PRESET } from './Constants.js';

// Default sequence factory
function createDefaultSequence(id, name) {
  return {
    id,
    name: name || 'Sequence 1',
    frameRate: DEFAULT_FRAME_RATE,
    canvas: { ...DEFAULT_CANVAS },
    codec: DEFAULT_SEQUENCE_CODEC,
    bitrate: DEFAULT_SEQUENCE_BITRATE,
    bitrateMode: DEFAULT_SEQUENCE_BITRATE_MODE,
    quality: DEFAULT_SEQUENCE_QUALITY,
    colorPreset: DEFAULT_COLOR_PRESET,
    workingSpace: 'rec709',
    outputSpace: 'rec709',
    linearCompositing: true,
    colorSpaceAwareEffects: true,
    tracks: [],
    duration: 0,
    markers: [],
    playback: { inPoint: null, outPoint: null }
  };
}

const DEFAULT_SEQ_ID = 'seq-1';

const state = {
  // Project (global)
  project: {
    name: 'Untitled Project',
    dirty: false,
    _autosaveId: null,
    nextSequenceId: 2
  },

  // Sequences map
  sequences: {
    [DEFAULT_SEQ_ID]: createDefaultSequence(DEFAULT_SEQ_ID, 'Sequence 1')
  },

  // Active sequence pointer
  activeSequenceId: DEFAULT_SEQ_ID,

  // Timeline (UI viewport state — global, not per-sequence)
  timeline: {
    scrollX: 0,
    scrollY: 0,
    zoomIndex: DEFAULT_ZOOM_INDEX
  },

  // Selection
  selection: {
    clipIds: [],
    trackId: null,
    transitionId: null,
    gap: null,  // { trackId, startFrame, endFrame } when a gap is selected
    maskId: null,
    rotoShapeId: null
  },

  // Playback
  playback: {
    playing: false,
    currentFrame: 0,
    speed: 1,
    loop: false
  },

  // UI
  ui: {
    activeTool: TOOL_TYPES.SELECTION,
    activePanel: null,
    snapEnabled: true,
    linkedSelection: true,
    nestSequences: false,
    showThumbnails: true,
    showWaveforms: true,
    showDuplicateFrames: false,
    showCaptions: false,
    maskEditMode: false,
    maskTool: null,
    rotoEditMode: false,
    rotoTool: null
  },

  // Media bin
  media: {
    items: new Map()
  }
};

// path -> { cbs: Set<callback>, withDot: string }
const subscribers = new Map();

// Paths that shim from project.* / timeline.* / playback.* into the active sequence
const SEQ_PROJECT_FIELDS = new Set(['frameRate', 'canvas', 'codec', 'bitrate', 'bitrateMode', 'quality', 'colorPreset', 'workingSpace', 'outputSpace', 'linearCompositing', 'colorSpaceAwareEffects']);
const SEQ_TIMELINE_FIELDS = new Set(['tracks', 'duration', 'markers']);
const SEQ_PLAYBACK_FIELDS = new Set(['inPoint', 'outPoint']);

// Cache for resolveShimPath static patterns — avoids path.split('.') on every hot call.
// Maps path -> { shimmed: false } | { shimmed: true, section, key, remaining }
const shimPatternCache = new Map();

// Resolve a path that may need shimming to the active sequence
// Returns: { target, key, remaining } for shimmed paths,
//          null if path is not shimmed (handled normally),
//          { error: true } if shimmed path but sequence is missing
function resolveShimPath(path) {
  // Fast path: look up pre-computed static pattern (avoids repeated path.split('.'))
  let pattern = shimPatternCache.get(path);
  if (pattern === undefined) {
    const parts = path.split('.');
    let shimmed = false, section = '', key = '', remaining = [];
    if (parts[0] === 'project' && parts.length >= 2 && SEQ_PROJECT_FIELDS.has(parts[1])) {
      shimmed = true; section = 'project'; key = parts[1]; remaining = parts.slice(2);
    } else if (parts[0] === 'timeline' && parts.length >= 2 && SEQ_TIMELINE_FIELDS.has(parts[1])) {
      shimmed = true; section = 'timeline'; key = parts[1]; remaining = parts.slice(2);
    } else if (parts[0] === 'playback' && parts.length >= 2 && SEQ_PLAYBACK_FIELDS.has(parts[1])) {
      shimmed = true; section = 'playback'; key = parts[1]; remaining = parts.slice(2);
    }
    pattern = shimmed ? { shimmed: true, section, key, remaining } : { shimmed: false };
    shimPatternCache.set(path, pattern);
  }

  if (!pattern.shimmed) return null;

  const seqId = state.activeSequenceId;
  const seq = state.sequences[seqId];
  if (!seq) return { error: true };

  // project.frameRate → sequences[activeId].frameRate
  if (pattern.section === 'project') {
    return { target: seq, key: pattern.key, remaining: pattern.remaining };
  }
  // timeline.tracks / timeline.duration → sequences[activeId].*
  if (pattern.section === 'timeline') {
    return { target: seq, key: pattern.key, remaining: pattern.remaining };
  }
  // playback.inPoint / playback.outPoint → sequences[activeId].playback.*
  return { target: seq.playback, key: pattern.key, remaining: pattern.remaining };
}

// Cache split results so repeated get/set on the same path never re-allocates.
const splitCache = new Map();
function splitPath(path) {
  let parts = splitCache.get(path);
  if (!parts) {
    parts = path.split('.');
    splitCache.set(path, parts);
  }
  return parts;
}

function getNestedValue(obj, path) {
  const keys = splitPath(path);
  let val = obj;
  for (let i = 0; i < keys.length; i++) val = val?.[keys[i]];
  return val;
}

function setNestedValue(obj, path, value) {
  const keys = splitPath(path);
  let target = obj;
  for (let i = 0; i < keys.length - 1; i++) target = target?.[keys[i]];
  if (target == null) return;
  target[keys[keys.length - 1]] = value;
}

export const editorState = {
  get(path) {
    if (!path) return state;

    // Shim: redirect sequence-specific paths
    const shim = resolveShimPath(path);
    if (shim?.error) {
      console.warn(`[EditorState] get("${path}") — no active sequence, returning undefined`);
      return undefined;
    }
    if (shim) {
      let val = shim.target[shim.key];
      for (const k of shim.remaining) {
        val = val?.[k];
      }
      return val;
    }

    return getNestedValue(state, path);
  },

  set(path, value) {
    // Shim: redirect sequence-specific paths
    const shim = resolveShimPath(path);
    if (shim?.error) {
      // Deleted/missing sequence — log and bail
      console.warn(`[EditorState] set("${path}") — no active sequence, ignoring`);
      return;
    }
    if (shim) {
      if (shim.remaining.length === 0) {
        shim.target[shim.key] = value;
      } else {
        let obj = shim.target[shim.key];
        for (let i = 0; i < shim.remaining.length - 1; i++) {
          if (obj == null || typeof obj !== 'object') {
            console.warn(`[EditorState] set("${path}") — intermediate "${shim.remaining[i]}" is null/undefined, ignoring`);
            return;
          }
          obj = obj[shim.remaining[i]];
        }
        if (obj == null || typeof obj !== 'object') {
          console.warn(`[EditorState] set("${path}") — target object is null/undefined, ignoring`);
          return;
        }
        obj[shim.remaining[shim.remaining.length - 1]] = value;
      }
      this._notify(path, value);
      return;
    }

    setNestedValue(state, path, value);
    this._notify(path, value);
  },

  update(path, updater) {
    const current = this.get(path);
    const next = updater(current);
    if (next === current) return; // Skip no-op updates
    this.set(path, next);
  },

  subscribe(path, callback) {
    if (!subscribers.has(path)) {
      // Pre-cache `path + '.'` so _notify never allocates it in the hot loop
      subscribers.set(path, { cbs: new Set(), withDot: path + '.' });
    }
    subscribers.get(path).cbs.add(callback);
    return () => {
      const entry = subscribers.get(path);
      if (entry) {
        entry.cbs.delete(callback);
        if (entry.cbs.size === 0) subscribers.delete(path);
      }
    };
  },

  _notify(changedPath, value) {
    // Compute once per notify call (not per subscriber)
    const changedWithDot = changedPath + '.';
    for (const [path, { cbs, withDot }] of subscribers) {
      // withDot = path + '.' pre-cached at subscribe time — no allocations here
      if (changedPath === path || changedPath.startsWith(withDot) || path.startsWith(changedWithDot)) {
        for (const cb of cbs) {
          try {
            cb(value, changedPath);
          } catch (err) {
            console.error(`[EditorState] Subscriber error for "${path}":`, err);
          }
        }
      }
    }
    eventBus.emit(EDITOR_EVENTS.STATE_CHANGED, { path: changedPath, value });
  },

  // High-frequency set() that skips the global STATE_CHANGED event bus notification.
  // Use for paths like playback.currentFrame that have a dedicated event (e.g. PLAYBACK_FRAME).
  // This avoids the event object allocation + eventBus dispatch overhead at 60fps.
  setSilent(path, value) {
    const shim = resolveShimPath(path);
    if (shim?.error) {
      console.warn(`[EditorState] setSilent("${path}") — no active sequence, ignoring`);
      return;
    }
    if (shim) {
      if (shim.remaining.length === 0) {
        shim.target[shim.key] = value;
      } else {
        let obj = shim.target[shim.key];
        for (let i = 0; i < shim.remaining.length - 1; i++) {
          if (obj == null || typeof obj !== 'object') return;
          obj = obj[shim.remaining[i]];
        }
        if (obj != null && typeof obj === 'object') {
          obj[shim.remaining[shim.remaining.length - 1]] = value;
        }
      }
      this._notifySubscribersOnly(path, value);
      return;
    }
    setNestedValue(state, path, value);
    this._notifySubscribersOnly(path, value);
  },

  // Notify subscribers only — no STATE_CHANGED event bus emit.
  _notifySubscribersOnly(changedPath, value) {
    const changedWithDot = changedPath + '.';
    for (const [path, { cbs, withDot }] of subscribers) {
      if (changedPath === path || changedPath.startsWith(withDot) || path.startsWith(changedWithDot)) {
        for (const cb of cbs) {
          try {
            cb(value, changedPath);
          } catch (err) {
            console.error(`[EditorState] Subscriber error for "${path}":`, err);
          }
        }
      }
    }
  },

  getState() {
    return state;
  },

  // --- Sequence helpers ---

  getActiveSequence() {
    return state.sequences[state.activeSequenceId] || null;
  },

  getActiveSequenceId() {
    return state.activeSequenceId;
  },

  getSequence(id) {
    return state.sequences[id] || null;
  },

  getAllSequences() {
    return Object.values(state.sequences);
  },

  createSequence(settings = {}) {
    const id = `seq-${state.project.nextSequenceId++}`;
    const seq = createDefaultSequence(id, settings.name || `Sequence ${state.project.nextSequenceId - 1}`);
    if (settings.frameRate) seq.frameRate = settings.frameRate;
    if (settings.canvas) seq.canvas = { ...settings.canvas };
    if (settings.codec) seq.codec = settings.codec;
    if (settings.bitrate) seq.bitrate = settings.bitrate;
    if (settings.bitrateMode) seq.bitrateMode = settings.bitrateMode;
    if (settings.quality) seq.quality = settings.quality;
    if (settings.colorPreset) seq.colorPreset = settings.colorPreset;
    if (settings.workingSpace) seq.workingSpace = settings.workingSpace;
    if (settings.outputSpace) seq.outputSpace = settings.outputSpace;
    if (settings.linearCompositing !== undefined) seq.linearCompositing = settings.linearCompositing;
    if (settings.colorSpaceAwareEffects !== undefined) seq.colorSpaceAwareEffects = settings.colorSpaceAwareEffects;
    state.sequences[id] = seq;
    eventBus.emit(EDITOR_EVENTS.SEQUENCE_CREATED, { id, sequence: seq });
    this.markDirty();
    return seq;
  },

  deleteSequence(id) {
    const seqIds = Object.keys(state.sequences);
    if (seqIds.length <= 1) return false;
    if (!state.sequences[id]) return false;

    const wasActive = state.activeSequenceId === id;
    delete state.sequences[id];

    // If deleted the active sequence, update all state before emitting events
    if (wasActive) {
      const remaining = Object.keys(state.sequences);
      state.activeSequenceId = remaining[0];
      state.playback.playing = false;
      state.playback.currentFrame = 0;
      state.selection.clipIds = [];
      state.selection.trackId = null;
      eventBus.emit(EDITOR_EVENTS.PLAYBACK_STOP);
      eventBus.emit(EDITOR_EVENTS.SEQUENCE_ACTIVATED, { id: state.activeSequenceId });
    }

    // Emit SEQUENCE_DELETED after all state is consistent
    eventBus.emit(EDITOR_EVENTS.SEQUENCE_DELETED, { id });
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    this.markDirty();
    return true;
  },

  setActiveSequenceId(id) {
    if (!state.sequences[id]) return false;
    if (state.activeSequenceId === id) return true;
    state.activeSequenceId = id;
    return true;
  },

  markDirty() {
    state.project.dirty = true;
  },

  markClean() {
    state.project.dirty = false;
  }
};

export default editorState;

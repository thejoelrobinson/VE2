// Core timeline model — tracks, clips, duration
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, TRACK_TYPES, STATE_PATHS } from '../core/Constants.js';
import { createTrack } from './Track.js';
import { createClip, getClipEndFrame, getClipDuration } from './Clip.js';
import { createTransition, getTransitionZone, TRANSITION_TYPES } from '../effects/Transitions.js';
import { secondsToFrame } from './TimelineMath.js';

export const timelineEngine = {
  _batchDepth: 0,
  _batchRanges: [],
  _batchEventQueue: [],

  beginBatch() {
    this._batchDepth++;
    if (this._batchDepth === 1) {
      this._batchRanges = [];
      this._batchEventQueue = [];
    }
  },

  commitBatch() {
    if (this._batchDepth <= 0) return;
    this._batchDepth--;
    if (this._batchDepth > 0) return; // still nested
    try {
      this._recalcDuration();
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED, {
        ranges: this._batchRanges.length > 0 ? this._batchRanges : null
      });
      // Replay queued events
      for (const { event, data } of this._batchEventQueue) {
        eventBus.emit(event, data);
      }
    } finally {
      this._batchRanges = [];
      this._batchEventQueue = [];
    }
  },

  _emitOrQueue(event, data) {
    if (this._batchDepth > 0) {
      if (event === EDITOR_EVENTS.TIMELINE_UPDATED) return; // suppressed
      this._batchEventQueue.push({ event, data });
    } else {
      eventBus.emit(event, data);
    }
  },

  _recordAffectedRange(start, end) {
    if (this._batchDepth > 0) {
      this._batchRanges.push({ start, end });
    }
  },

  init() {
    // Start with one video track and one audio track in the default sequence
    const v1 = createTrack({ name: 'V1', type: TRACK_TYPES.VIDEO });
    const a1 = createTrack({ name: 'A1', type: TRACK_TYPES.AUDIO });
    editorState.set(STATE_PATHS.TIMELINE_TRACKS, [v1, a1]);
    this._recalcDuration();

    // Rescale position params when sequence resolution changes (not on sequence switch)
    this._lastCanvas = editorState.get(STATE_PATHS.PROJECT_CANVAS) || { width: 1920, height: 1080 };
    eventBus.on(EDITOR_EVENTS.SEQUENCE_ACTIVATED, () => {
      // Update baseline to new sequence's canvas without rescaling
      this._lastCanvas = editorState.get(STATE_PATHS.PROJECT_CANVAS) || { width: 1920, height: 1080 };
    });
    editorState.subscribe(STATE_PATHS.PROJECT_CANVAS, (newCanvas) => {
      this._rescalePositionParams(this._lastCanvas, newCanvas);
      this._lastCanvas = { ...newCanvas };
    });
  },

  switchSequence(seqId) {
    if (!editorState.getSequence(seqId)) return false;

    // Stop playback before switching (set state directly to avoid circular import)
    editorState.set(STATE_PATHS.PLAYBACK_PLAYING, false);
    editorState.set(STATE_PATHS.PLAYBACK_CURRENT_FRAME, 0);
    eventBus.emit(EDITOR_EVENTS.PLAYBACK_STOP);

    // Clear selection
    editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
    editorState.set(STATE_PATHS.SELECTION_TRACK_ID, null);

    // Switch the active sequence pointer (no-ops if already active, but events
    // must still fire — ConformEncoder's cross-sequence idle fill temporarily
    // swaps the pointer, so the "already active" check would short-circuit
    // a real user switch and leave the UI stale)
    editorState.setActiveSequenceId(seqId);

    // Emit sequence activated event (triggers UI rebuilds)
    eventBus.emit(EDITOR_EVENTS.SEQUENCE_ACTIVATED, { id: seqId });
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);

    return true;
  },

  getTracks() {
    return editorState.get(STATE_PATHS.TIMELINE_TRACKS) || [];
  },

  getTrack(trackId) {
    return this.getTracks().find(t => t.id === trackId);
  },

  getVideoTracks() {
    return this.getTracks().filter(t =>
      t.type === TRACK_TYPES.VIDEO || t.type === TRACK_TYPES.TITLE
    );
  },

  getAudioTracks() {
    return this.getTracks().filter(t => t.type === TRACK_TYPES.AUDIO);
  },

  addTrack(type = TRACK_TYPES.VIDEO, name = null) {
    const tracks = this.getTracks();
    const count = tracks.filter(t => t.type === type).length;
    const prefix = type === TRACK_TYPES.AUDIO ? 'A' : 'V';
    const track = createTrack({
      name: name || `${prefix}${count + 1}`,
      type
    });

    // Insert video tracks at top, audio tracks at bottom
    if (type === TRACK_TYPES.AUDIO) {
      tracks.push(track);
    } else {
      // Find first audio track index, insert before it
      const firstAudioIdx = tracks.findIndex(t => t.type === TRACK_TYPES.AUDIO);
      if (firstAudioIdx === -1) {
        tracks.push(track);
      } else {
        tracks.splice(firstAudioIdx, 0, track);
      }
    }

    editorState.set(STATE_PATHS.TIMELINE_TRACKS, [...tracks]);
    this._emitOrQueue(EDITOR_EVENTS.TRACK_ADDED, { track });
    return track;
  },

  removeTrack(trackId) {
    const tracks = this.getTracks().filter(t => t.id !== trackId);
    if (tracks.length === 0) return false;
    editorState.set(STATE_PATHS.TIMELINE_TRACKS, tracks);
    if (!this._batchDepth) this._recalcDuration();
    this._emitOrQueue(EDITOR_EVENTS.TRACK_REMOVED, { trackId });
    return true;
  },

  addClip(trackId, mediaItem, startFrame = 0) {
    const track = this.getTrack(trackId);
    if (!track) return null;

    const canvas = editorState.get(STATE_PATHS.PROJECT_CANVAS) || { width: 1920, height: 1080 };
    const durationFrames = secondsToFrame(mediaItem.duration || 5);
    const clip = createClip({
      mediaId: mediaItem.id,
      trackId,
      name: mediaItem.name || 'Clip',
      startFrame,
      sourceInFrame: 0,
      sourceOutFrame: durationFrames,
      color: this._getTrackColor(track),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      mediaWidth: mediaItem.width,
      mediaHeight: mediaItem.height
    });

    track.clips.push(clip);
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
    if (!this._batchDepth) this._recalcDuration();
    const endFrame = clip.startFrame + Math.round((clip.sourceOutFrame - clip.sourceInFrame) / (clip.speed || 1));
    this._recordAffectedRange(clip.startFrame, endFrame);
    this._emitOrQueue(EDITOR_EVENTS.CLIP_ADDED, { clip, trackId });
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
    return clip;
  },

  // Add a video clip with a linked audio clip (Premiere-style A/V link)
  addClipWithLinkedAudio(mediaItem, startFrame = 0) {
    const videoTrack = this.getVideoTracks()[0] || this.addTrack(TRACK_TYPES.VIDEO);
    const audioTrack = this.getAudioTracks()[0] || this.addTrack(TRACK_TYPES.AUDIO);
    const canvas = editorState.get(STATE_PATHS.PROJECT_CANVAS) || { width: 1920, height: 1080 };
    const durationFrames = secondsToFrame(mediaItem.duration || 5);

    const videoClip = createClip({
      mediaId: mediaItem.id,
      trackId: videoTrack.id,
      name: `${mediaItem.name || 'Clip'} [V]`,
      startFrame,
      sourceInFrame: 0,
      sourceOutFrame: durationFrames,
      color: this._getTrackColor(videoTrack),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      mediaWidth: mediaItem.width,
      mediaHeight: mediaItem.height
    });

    const audioClip = createClip({
      mediaId: mediaItem.id,
      trackId: audioTrack.id,
      name: `${mediaItem.name || 'Clip'} [A]`,
      startFrame,
      sourceInFrame: 0,
      sourceOutFrame: durationFrames,
      color: this._getTrackColor(audioTrack),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height
    });

    // Link them together
    videoClip.linkedClipId = audioClip.id;
    audioClip.linkedClipId = videoClip.id;

    videoTrack.clips.push(videoClip);
    videoTrack.clips.sort((a, b) => a.startFrame - b.startFrame);
    audioTrack.clips.push(audioClip);
    audioTrack.clips.sort((a, b) => a.startFrame - b.startFrame);

    if (!this._batchDepth) this._recalcDuration();
    const endFrame = videoClip.startFrame + Math.round((videoClip.sourceOutFrame - videoClip.sourceInFrame) / (videoClip.speed || 1));
    this._recordAffectedRange(videoClip.startFrame, endFrame);
    this._emitOrQueue(EDITOR_EVENTS.CLIP_ADDED, { clip: videoClip, trackId: videoTrack.id });
    this._emitOrQueue(EDITOR_EVENTS.CLIP_ADDED, { clip: audioClip, trackId: audioTrack.id });
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
    return { videoClip, audioClip };
  },

  linkClips(clipIdA, clipIdB) {
    const a = this.getClip(clipIdA);
    const b = this.getClip(clipIdB);
    if (!a || !b) return;
    // Unlink existing partners first
    if (a.linkedClipId) {
      const old = this.getClip(a.linkedClipId);
      if (old) old.linkedClipId = null;
    }
    if (b.linkedClipId) {
      const old = this.getClip(b.linkedClipId);
      if (old) old.linkedClipId = null;
    }
    a.linkedClipId = clipIdB;
    b.linkedClipId = clipIdA;
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
  },

  unlinkClip(clipId) {
    const clip = this.getClip(clipId);
    if (!clip || !clip.linkedClipId) return;
    const partner = this.getClip(clip.linkedClipId);
    clip.linkedClipId = null;
    if (partner) partner.linkedClipId = null;
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
  },

  removeClip(clipId) {
    const tracks = this.getTracks();
    for (const track of tracks) {
      const idx = track.clips.findIndex(c => c.id === clipId);
      if (idx !== -1) {
        const clip = track.clips.splice(idx, 1)[0];
        // Also remove linked clip
        if (clip.linkedClipId) {
          const linkedId = clip.linkedClipId;
          clip.linkedClipId = null;
          const partner = this.getClip(linkedId);
          if (partner) {
            partner.linkedClipId = null; // prevent recursion
            this.removeClip(linkedId);
          }
        }
        if (!this._batchDepth) this._recalcDuration();
        const clipEnd = clip.startFrame + Math.round((clip.sourceOutFrame - clip.sourceInFrame) / (clip.speed || 1));
        this._recordAffectedRange(clip.startFrame, clipEnd);
        this._emitOrQueue(EDITOR_EVENTS.CLIP_REMOVED, { clip, trackId: track.id });
        this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
        return clip;
      }
    }
    return null;
  },

  getClip(clipId) {
    for (const track of this.getTracks()) {
      const clip = track.clips.find(c => c.id === clipId);
      if (clip) return clip;
    }
    return null;
  },

  getAllClips() {
    const clips = [];
    for (const track of this.getTracks()) {
      clips.push(...track.clips);
    }
    return clips;
  },

  moveClip(clipId, newTrackId, newStartFrame) {
    const clip = this.getClip(clipId);
    if (!clip) return false;

    // Remove from old track
    const oldTrack = this.getTrack(clip.trackId);
    if (oldTrack) {
      oldTrack.clips = oldTrack.clips.filter(c => c.id !== clipId);
    }

    // Add to new track
    const newTrack = this.getTrack(newTrackId);
    if (!newTrack) return false;

    clip.trackId = newTrackId;
    clip.startFrame = Math.max(0, newStartFrame);
    newTrack.clips.push(clip);
    newTrack.clips.sort((a, b) => a.startFrame - b.startFrame);

    if (!this._batchDepth) this._recalcDuration();
    const clipEnd = getClipEndFrame(clip);
    this._recordAffectedRange(clip.startFrame, clipEnd);
    this._emitOrQueue(EDITOR_EVENTS.CLIP_MOVED, { clip, oldTrackId: oldTrack?.id, newTrackId });
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
    return true;
  },

  // --- Transition management ---

  addTransition(trackId, clipAId, clipBId, type = TRANSITION_TYPES.CROSS_DISSOLVE, duration = 30, alignment = 'center') {
    const track = this.getTrack(trackId);
    if (!track) return null;

    const clipA = track.clips.find(c => c.id === clipAId);
    const clipB = track.clips.find(c => c.id === clipBId);
    if (!clipA || !clipB) return null;

    // Clips must be adjacent (A ends where B starts)
    const editPoint = getClipEndFrame(clipA);
    if (editPoint !== clipB.startFrame) return null;

    // No duplicate transition between these clips
    if (track.transitions.find(t => t.clipAId === clipAId && t.clipBId === clipBId)) return null;

    // Clamp duration to available handles
    // Clip B handle = source frames before its in-point
    const handleB = Math.floor(clipB.sourceInFrame / (clipB.speed || 1));
    // For center alignment, clip B side needs half the duration
    const neededFromB = alignment === 'center' ? Math.ceil(duration / 2)
                      : alignment === 'start' ? duration : 0;
    if (neededFromB > 0 && handleB < neededFromB) {
      duration = alignment === 'center' ? handleB * 2 : handleB;
    }
    if (duration <= 0) return null;

    const transition = createTransition({ type, duration, clipAId, clipBId, alignment });
    track.transitions.push(transition);

    const { start, end } = getTransitionZone(transition, editPoint);
    this._recordAffectedRange(start, end);
    this._emitOrQueue(EDITOR_EVENTS.TRANSITION_ADDED, { transition, trackId });
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
    return transition;
  },

  removeTransition(trackId, transitionId) {
    const track = this.getTrack(trackId);
    if (!track) return false;

    const idx = track.transitions.findIndex(t => t.id === transitionId);
    if (idx === -1) return false;

    track.transitions.splice(idx, 1);
    this._emitOrQueue(EDITOR_EVENTS.TRANSITION_REMOVED, { transitionId, trackId });
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
    return true;
  },

  addDefaultTransitionAtPlayhead() {
    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const videoTracks = this.getVideoTracks();

    for (const track of videoTracks) {
      if (track.locked) continue;

      // Find clip A ending at (or near ±1) the playhead, and clip B starting there
      let clipA = null;
      let clipB = null;

      for (const clip of track.clips) {
        const endFrame = getClipEndFrame(clip);
        if (Math.abs(endFrame - currentFrame) <= 1) clipA = clip;
        if (Math.abs(clip.startFrame - currentFrame) <= 1) clipB = clip;
      }

      if (clipA && clipB && clipA.id !== clipB.id) {
        const result = this.addTransition(
          track.id, clipA.id, clipB.id,
          TRANSITION_TYPES.CROSS_DISSOLVE, 30
        );
        if (result) return result;
      }
    }
    return null;
  },

  // Find the track containing a given transition
  getTransitionTrack(transitionId) {
    for (const track of this.getTracks()) {
      if (track.transitions.find(t => t.id === transitionId)) {
        return track;
      }
    }
    return null;
  },

  getEditPoint(trans) {
    const clipA = this.getClip(trans.clipAId);
    return clipA ? getClipEndFrame(clipA) : 0;
  },

  resizeTransition(trackId, transitionId, newDuration) {
    const track = this.getTrack(trackId);
    const trans = track?.transitions.find(t => t.id === transitionId);
    if (!trans) return false;
    trans.duration = Math.max(1, Math.round(newDuration));
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
    return true;
  },

  repositionTransition(trackId, transitionId, newOffset) {
    const track = this.getTrack(trackId);
    const trans = track?.transitions.find(t => t.id === transitionId);
    if (!trans) return false;
    trans.offset = Math.round(newOffset);
    this._emitOrQueue(EDITOR_EVENTS.TIMELINE_UPDATED);
    return true;
  },

  _rescalePositionParams(oldCanvas, newCanvas) {
    if (!oldCanvas || !newCanvas) return;
    const sx = newCanvas.width / oldCanvas.width;
    const sy = newCanvas.height / oldCanvas.height;
    if (sx === 1 && sy === 1) return;
    for (const clip of this.getAllClips()) {
      const motionFx = clip.effects?.find(fx => fx.id === 'intrinsic-motion');
      if (!motionFx) continue;
      motionFx.params.posX *= sx;
      motionFx.params.posY *= sy;
      // Rescale keyframed positions too
      const kf = motionFx.keyframes;
      if (kf) {
        for (const e of (kf.posX || [])) e.value *= sx;
        for (const e of (kf.posY || [])) e.value *= sy;
      }
    }
  },

  _recalcDuration() {
    let maxFrame = 0;
    for (const track of this.getTracks()) {
      for (const clip of track.clips) {
        const end = getClipEndFrame(clip);
        if (end > maxFrame) maxFrame = end;
      }
    }
    // Add 5 seconds of padding
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE);
    editorState.set(STATE_PATHS.TIMELINE_DURATION, maxFrame + fps * 5);
  },

  _getTrackColor(track) {
    const videoColors = ['#4a90d9', '#7b68ee', '#e06c75', '#e5c07b', '#98c379', '#c678dd'];
    const audioColors = ['#56b6c2', '#61afef', '#d19a66'];
    const tracks = this.getTracks().filter(t => t.type === track.type);
    const idx = tracks.indexOf(track);
    const palette = track.type === TRACK_TYPES.AUDIO ? audioColors : videoColors;
    return palette[idx % palette.length];
  },

  getDuration() {
    return editorState.get(STATE_PATHS.TIMELINE_DURATION) || 0;
  },

  clear() {
    editorState.set(STATE_PATHS.TIMELINE_TRACKS, []);
    editorState.set(STATE_PATHS.TIMELINE_DURATION, 0);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  }
};

export default timelineEngine;

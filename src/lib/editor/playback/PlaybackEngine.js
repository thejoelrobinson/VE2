// rAF-based playback loop with frame-accurate seeking and speed control
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { frameToSeconds, secondsToFrame } from '../timeline/TimelineMath.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { getClipEndFrame } from '../timeline/Clip.js';
import { renderAheadManager } from '../media/RenderAheadManager.js';
import { audioMixer } from './AudioMixer.js';
import { rafScheduler, PRIORITY } from '../core/RafScheduler.js';
import logger from '../../utils/logger.js';

// Lazy import of SequenceStreamController to avoid circular dependency chains.
// SSC → MediaDecoder → RenderAheadManager; we must not pull SSC in at module
// evaluation time because RenderAheadManager already imports PlaybackEngine.
let _sscRef = null;
function _getSSC() {
  if (!_sscRef) {
    import('./SequenceStreamController.js').then(m => {
      _sscRef = m.sequenceStreamController;
    }).catch(() => {});
  }
  return _sscRef;
}

export const playbackEngine = {
  _rafId: null,
  _schedulerId: null,
  _startTime: 0,
  _startFrame: 0,
  _lastRenderedFrame: -1,
  _droppedFrameCount: 0,
  _audioStartCtxTime: 0,
  _cachedEditPoints: null,

  // Cached hot-path values — avoids editorState.get() on every 60fps tick.
  // Kept in sync via subscriptions + SEQUENCE_ACTIVATED refresh.
  _cachedSpeed: 1,
  _cachedFps: 30,
  _cachedLoop: false,
  _cachedInPoint: null,
  _cachedOutPoint: null,
  _subs: null,

  getDroppedFrameCount() {
    return this._droppedFrameCount;
  },

  _refreshCachedValues() {
    this._cachedSpeed = editorState.get(STATE_PATHS.PLAYBACK_SPEED) ?? 1;
    this._cachedFps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) ?? 30;
    this._cachedLoop = !!editorState.get(STATE_PATHS.PLAYBACK_LOOP);
    this._cachedInPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT) ?? null;
    this._cachedOutPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT) ?? null;
  },

  init() {
    if (!this._schedulerId) {
      this._schedulerId = rafScheduler.register(ts => this._tick(ts), PRIORITY.PLAYBACK);
    }
    // Prime cache and subscribe to changes so _tick() reads local fields instead of state
    this._refreshCachedValues();
    if (!this._subs) {
      const onSeqActivated = () => this._refreshCachedValues();
      this._subs = [
        editorState.subscribe(STATE_PATHS.PLAYBACK_SPEED, v => { this._cachedSpeed = v ?? 1; }),
        editorState.subscribe(STATE_PATHS.PROJECT_FRAME_RATE, v => { this._cachedFps = v ?? 30; }),
        editorState.subscribe(STATE_PATHS.PLAYBACK_LOOP, v => { this._cachedLoop = !!v; }),
        editorState.subscribe(STATE_PATHS.PLAYBACK_IN_POINT, v => { this._cachedInPoint = v ?? null; }),
        editorState.subscribe(STATE_PATHS.PLAYBACK_OUT_POINT, v => { this._cachedOutPoint = v ?? null; }),
        // Shimmed paths (fps, inPoint, outPoint) don't fire subscriber on sequence switch,
        // so refresh all cached values whenever the active sequence changes.
        () => eventBus.off(EDITOR_EVENTS.SEQUENCE_ACTIVATED, onSeqActivated),
      ];
      eventBus.on(EDITOR_EVENTS.SEQUENCE_ACTIVATED, onSeqActivated);
      const onTimelineUpdated = () => { this._cachedEditPoints = null; };
      eventBus.on(EDITOR_EVENTS.TIMELINE_UPDATED, onTimelineUpdated);
      this._subs.push(() => eventBus.off(EDITOR_EVENTS.TIMELINE_UPDATED, onTimelineUpdated));
    }
  },

  play() {
    if (editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) return;
    editorState.set(STATE_PATHS.PLAYBACK_PLAYING, true);
    this._startTime = performance.now();
    this._startFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    this._lastRenderedFrame = this._startFrame;
    this._droppedFrameCount = 0;
    // Capture AudioContext time at play start for A/V sync
    const ctx = audioMixer.getContext();
    this._audioStartCtxTime = ctx ? ctx.currentTime : 0;
    if (this._schedulerId) {
      rafScheduler.activate(this._schedulerId);
    } else {
      this._tick();
    }
    eventBus.emit(EDITOR_EVENTS.PLAYBACK_START);
  },

  pause() {
    if (!editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) return;
    editorState.set(STATE_PATHS.PLAYBACK_PLAYING, false);
    if (this._schedulerId) {
      rafScheduler.deactivate(this._schedulerId);
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    eventBus.emit(EDITOR_EVENTS.PLAYBACK_STOP);
  },

  togglePlay() {
    if (editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) {
      this.pause();
    } else {
      this.play();
    }
  },

  stop() {
    this.pause();
    this.seek(0);
  },

  seek(frame) {
    frame = Math.max(0, Math.round(frame));
    const duration = timelineEngine.getDuration();
    if (frame > duration) frame = duration;

    // Update internal timing FIRST, before state notification
    if (editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) {
      this._startTime = performance.now();
      this._startFrame = frame;
      this._lastRenderedFrame = frame;
      const ctx = audioMixer.getContext();
      this._audioStartCtxTime = ctx ? ctx.currentTime : 0;
    }

    // THEN update state (which triggers subscribers/tick)
    editorState.set(STATE_PATHS.PLAYBACK_CURRENT_FRAME, frame);
    eventBus.emit(EDITOR_EVENTS.PLAYBACK_SEEK, { frame });
    eventBus.emit(EDITOR_EVENTS.PLAYBACK_FRAME, { frame });

    // Pre-fill buffer around seek position
    renderAheadManager.requestAhead(frame, 10);
  },

  seekRelative(deltaFrames) {
    const current = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    this.seek(current + deltaFrames);
  },

  setSpeed(speed) {
    const wasPlaying = editorState.get(STATE_PATHS.PLAYBACK_PLAYING);
    if (wasPlaying) {
      // Recalculate start to maintain position - update internal fields FIRST
      this._startFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      this._startTime = performance.now();
      this._lastRenderedFrame = this._startFrame;
      const ctx = audioMixer.getContext();
      this._audioStartCtxTime = ctx ? ctx.currentTime : 0;
    }
    // Set state AFTER internal fields are consistent
    editorState.set(STATE_PATHS.PLAYBACK_SPEED, speed);
    eventBus.emit(EDITOR_EVENTS.PLAYBACK_SPEED_CHANGED, { speed });
  },

  getCurrentFrame() {
    return editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
  },

  _getEditPoints() {
    if (this._cachedEditPoints) return this._cachedEditPoints;
    const points = new Set([0, timelineEngine.getDuration()]);
    for (const track of timelineEngine.getTracks()) {
      if (track.locked) continue;
      for (const clip of track.clips) {
        points.add(clip.startFrame);
        points.add(getClipEndFrame(clip));
      }
    }
    this._cachedEditPoints = Array.from(points).sort((a, b) => a - b);
    return this._cachedEditPoints;
  },

  seekToNextEditPoint() {
    const current = this.getCurrentFrame();
    const points = this._getEditPoints();
    const next = points.find(p => p > current);
    this.seek(next !== undefined ? next : timelineEngine.getDuration());
  },

  seekToPreviousEditPoint() {
    const current = this.getCurrentFrame();
    const points = this._getEditPoints();
    let prev = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i] < current) {
        prev = points[i];
        break;
      }
    }
    this.seek(prev);
  },

  _tick() {
    if (!editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) {
      if (this._schedulerId) rafScheduler.deactivate(this._schedulerId);
      return;
    }

    try {
      // Use cached values — avoids editorState.get() + resolveShimPath() on every frame
      const speed = this._cachedSpeed;
      const fps = this._cachedFps;

      // Derive target frame from AudioContext time (authoritative) or wall-clock fallback
      let elapsed;
      const ctx = audioMixer.getContext();
      if (ctx && ctx.state === 'running') {
        elapsed = (ctx.currentTime - this._audioStartCtxTime) * speed;
      } else {
        elapsed = ((performance.now() - this._startTime) / 1000) * speed;
      }
      const frameOffset = Math.floor(elapsed * fps);
      let targetFrame = this._startFrame + frameOffset;

      const duration = timelineEngine.getDuration();

      // Use in/out points for loop region if set (read from cache)
      const loopStart = this._cachedInPoint ?? 0;
      const loopEnd = this._cachedOutPoint ?? duration;

      if (targetFrame >= loopEnd) {
        if (this._cachedLoop) {
          targetFrame = loopStart;
          this._startFrame = loopStart;
          this._startTime = performance.now();
          this._lastRenderedFrame = loopStart;
          this._audioStartCtxTime = ctx ? ctx.currentTime : 0;
        } else {
          targetFrame = loopEnd;
          this.pause();
          return;
        }
      }

      // Count dropped frames (frames we skipped over without rendering)
      const skipped = targetFrame - this._lastRenderedFrame - 1;
      if (skipped > 0) {
        this._droppedFrameCount += skipped;
      }
      this._lastRenderedFrame = targetFrame;

      // Periodic dropped frame logging (every 30 rendered frames)
      if (this._droppedFrameCount > 0 && targetFrame % 30 === 0) {
        logger.debug(`[PlaybackEngine] Dropped ${this._droppedFrameCount} frames so far`);
      }

      // setSilent skips the global STATE_CHANGED event — PLAYBACK_FRAME handles subscribers
      editorState.setSilent(STATE_PATHS.PLAYBACK_CURRENT_FRAME, targetFrame);
      eventBus.emit(EDITOR_EVENTS.PLAYBACK_FRAME, { frame: targetFrame });

      // Keep render-ahead buffer filled and drive per-clip VLC stream
      // orchestration every 5 frames. SSC.advancePlayback() and
      // renderAheadManager.requestAhead() are both needed: SSC manages VLC
      // stream lifecycle; RenderAheadManager fills the ImageBitmap frame buffer
      // consumed by VideoCompositor.
      if (targetFrame % 5 === 0) {
        _getSSC()?.advancePlayback(targetFrame);
        renderAheadManager.requestAhead(targetFrame, 15);
      }
    } catch (err) {
      logger.error('[PlaybackEngine] Tick error:', err);
      this.pause();
      return;
    }

    // Self-schedule only if not using the centralized scheduler
    if (!this._schedulerId) {
      this._rafId = requestAnimationFrame(() => this._tick());
    }
  },

  cleanup() {
    // Stop any pending animations
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    // Deactivate the scheduler
    if (this._schedulerId) {
      rafScheduler.deactivate(this._schedulerId);
    }

    // Unsubscribe from state cache subscriptions
    if (this._subs) {
      for (const unsub of this._subs) unsub();
      this._subs = null;
    }

    // Reset state
    this.pause();
    this._startTime = 0;
    this._startFrame = 0;
    this._lastRenderedFrame = -1;
    this._droppedFrameCount = 0;
    this._audioStartCtxTime = 0;
    this._cachedEditPoints = null;
  }
};

export default playbackEngine;

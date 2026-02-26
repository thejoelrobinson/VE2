// SequenceStreamController — per-clip, per-track VLC stream orchestration.
//
// Replaces the old MediaDecoder.initPlaybackSync() global approach with a
// timeline-aware scheduler. Each clip gets its own VLC stream configured with
// correct source time bounds; clips that share a mediaId fall through to
// frame-by-frame decode via RenderAheadManager (no VLC control).
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import {
  clipContainsFrame,
  getSourceFrameAtPlayhead,
} from '../timeline/Clip.js';
import { VLC_CONFIG } from '../media/VLCBridge.js';
import logger from '../../utils/logger.js';

// Lazy import — breaks the MediaDecoder → RenderAheadManager → MediaDecoder
// circular dependency that would form if imported at the top level.
let _mediaDecoderRef = null;
async function _getMediaDecoder() {
  if (!_mediaDecoderRef) {
    const m = await import('../media/MediaDecoder.js');
    _mediaDecoderRef = m.mediaDecoder;
  }
  return _mediaDecoderRef;
}

// How many frames ahead of the current playhead the scheduler considers clips
// for pre-roll (bounds set but not yet playing).
const DEFAULT_LOOKAHEAD = 60;

// advancePlayback() is called every N frames from PlaybackEngine._tick().
// 5 is the same throttle interval PlaybackEngine already uses for requestAhead.
export const ADVANCE_INTERVAL = 5;

export const sequenceStreamController = {
  /** Map<`${trackId}_${clipId}`, StreamEntry> */
  _activeStreams: new Map(),

  /** Incremented in _teardownAll() to invalidate suspended async operations. */
  _generation: 0,

  /** Cached fps — refreshed on SEQUENCE_ACTIVATED and init */
  _fps: 30,

  /** Unsubscribe callbacks from eventBus.on() */
  _unsubs: null,

  /** Set<string> — clip keys currently undergoing burst-decode */
  _preCachingKeys: new Set(),

  // ── Lifecycle ──────────────────────────────────────────────────────────

  init() {
    this._fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) ?? 30;

    const onPlaybackStart = () => {
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) ?? 0;
      this.startPlayback(frame);
    };

    const onPlaybackStop = () => {
      this.stopPlayback();
    };

    const onPlaybackSeek = ({ frame } = {}) => {
      if (frame == null) return;
      this.seekPlayback(frame);
    };

    const onTimelineUpdated = () => {
      // Live edit while playing — rebuild streams from the new timeline state.
      if (!editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) return;
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) ?? 0;
      this.seekPlayback(frame);
    };

    const onSequenceActivated = () => {
      this._fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) ?? 30;
      this._teardownAll();
    };

    eventBus.on(EDITOR_EVENTS.PLAYBACK_START, onPlaybackStart);
    eventBus.on(EDITOR_EVENTS.PLAYBACK_STOP, onPlaybackStop);
    eventBus.on(EDITOR_EVENTS.PLAYBACK_SEEK, onPlaybackSeek);
    eventBus.on(EDITOR_EVENTS.TIMELINE_UPDATED, onTimelineUpdated);
    eventBus.on(EDITOR_EVENTS.SEQUENCE_ACTIVATED, onSequenceActivated);

    this._unsubs = [
      () => eventBus.off(EDITOR_EVENTS.PLAYBACK_START, onPlaybackStart),
      () => eventBus.off(EDITOR_EVENTS.PLAYBACK_STOP, onPlaybackStop),
      () => eventBus.off(EDITOR_EVENTS.PLAYBACK_SEEK, onPlaybackSeek),
      () => eventBus.off(EDITOR_EVENTS.TIMELINE_UPDATED, onTimelineUpdated),
      () => eventBus.off(EDITOR_EVENTS.SEQUENCE_ACTIVATED, onSequenceActivated),
    ];

    logger.info('[SSC] Initialized');
  },

  cleanup() {
    this._teardownAll();
    if (this._unsubs) {
      for (const fn of this._unsubs) fn();
      this._unsubs = null;
    }
    _mediaDecoderRef = null;
    logger.info('[SSC] Cleaned up');
  },

  // ── Schedule building ──────────────────────────────────────────────────

  /**
   * Pure function. Scans all non-muted video tracks and returns a schedule
   * array describing which clips are active at `currentFrame` and which are
   * within the `lookahead` window for pre-roll.
   *
   * @param {number} currentFrame
   * @param {number} [lookahead=60]  Frames ahead to consider for pre-roll.
   * @returns {ScheduleEntry[]}
   */
  buildClipSchedule(currentFrame, lookahead = DEFAULT_LOOKAHEAD) {
    const fps = this._fps || 30;
    const schedule = [];

    for (const track of timelineEngine.getVideoTracks()) {
      if (track.muted) continue;

      for (const clip of track.clips) {
        if (clip.disabled || !clip.mediaId) continue;

        const isActive = clipContainsFrame(clip, currentFrame);
        const lookaheadFrame = currentFrame + lookahead;

        // Pre-roll: clip starts within the lookahead window but hasn't started yet.
        const needsPreroll =
          !isActive &&
          clip.startFrame > currentFrame &&
          clip.startFrame <= lookaheadFrame;

        if (!isActive && !needsPreroll) continue;

        // Source time bounds in milliseconds
        const sourceStartMs = (clip.sourceInFrame / fps) * 1000;
        const sourceEndMs = (clip.sourceOutFrame / fps) * 1000;

        schedule.push({
          trackId: track.id,
          clipId: clip.id,
          mediaId: clip.mediaId,
          sourceStartMs,
          sourceEndMs,
          isActive,
          needsPreroll,
          clip,
        });
      }
    }

    return schedule;
  },

  // ── Playback control ───────────────────────────────────────────────────

  /**
   * Called when playback begins. Activates all clips at `startFrame` and
   * pre-rolls clips within the lookahead window.
   *
   * @param {number} startFrame
   */
  async startPlayback(startFrame) {
    this._teardownAll();
    const gen = this._generation;
    const schedule = this.buildClipSchedule(startFrame);
    const fps = this._fps || 30;

    // Track which mediaIds are already assigned to a stream — second-use
    // clips share a mediaId and must fall back to frame-by-frame decode.
    const assignedMediaIds = new Set();

    for (const entry of schedule) {
      const key = `${entry.trackId}_${entry.clipId}`;

      let session = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        session = await this._getSession(entry.mediaId);
      }
      // session === null means: same mediaId used by an earlier clip — let
      // RenderAheadManager handle frame-by-frame decode for this clip.

      // A seek or stop arrived while we were awaiting the session — abort.
      if (this._generation !== gen) return;

      const streamEntry = {
        mediaId: entry.mediaId,
        session,
        clipId: entry.clipId,
        trackId: entry.trackId,
      };
      this._activeStreams.set(key, streamEntry);

      if (!session) continue;

      session.configure(entry.sourceStartMs, entry.sourceEndMs, (frameMs, clipEndMs) => {
        this.onClipEndReached(entry.trackId, entry.clipId, frameMs, clipEndMs);
      });

      if (entry.isActive) {
        // Compute per-clip source time at the playhead
        const sourceFrame = getSourceFrameAtPlayhead(entry.clip, startFrame);
        const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
        session.start(sourceTimeSeconds);
      }
      // Pre-roll only — bounds set, but not started yet
    }
  },

  /**
   * Called every `ADVANCE_INTERVAL` frames from PlaybackEngine._tick().
   * Re-evaluates the schedule and transitions pre-rolled clips to active,
   * activates newly-entered clips, and deactivates clips that have left the
   * lookahead window.
   *
   * @param {number} currentFrame
   */
  async advancePlayback(currentFrame) {
    const gen = this._generation;
    const schedule = this.buildClipSchedule(currentFrame);
    const fps = this._fps || 30;

    // Build a set of keys still relevant this tick
    const relevantKeys = new Set(schedule.map(e => `${e.trackId}_${e.clipId}`));

    // Deactivate streams that fell out of scope.
    // Collect stale keys first to avoid mutating the Map mid-iteration.
    const staleKeys = [];
    for (const [key] of this._activeStreams) {
      if (!relevantKeys.has(key)) staleKeys.push(key);
    }
    for (const key of staleKeys) {
      const stream = this._activeStreams.get(key);
      stream.session?.stop();
      this._activeStreams.delete(key);
    }

    const assignedMediaIds = new Set(
      [...this._activeStreams.values()].map(s => s.mediaId)
    );

    for (const entry of schedule) {
      const key = `${entry.trackId}_${entry.clipId}`;

      if (this._activeStreams.has(key)) {
        const stream = this._activeStreams.get(key);
        // Promote a pre-rolled clip to active when the playhead enters it.
        // Skip if already active — session.start() is idempotent but we
        // avoid unnecessary calls to prevent seek-flood every 5 frames.
        if (entry.isActive && stream.session && !stream.session.isActive) {
          const sourceFrame = getSourceFrameAtPlayhead(entry.clip, currentFrame);
          const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
          stream.session.start(sourceTimeSeconds);
        }
        continue;
      }

      // New clip entering the window
      let session = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        session = await this._getSession(entry.mediaId);
      }

      // A seek or stop arrived while we were awaiting the session — abort.
      if (this._generation !== gen) return;

      const streamEntry = {
        mediaId: entry.mediaId,
        session,
        clipId: entry.clipId,
        trackId: entry.trackId,
      };
      this._activeStreams.set(key, streamEntry);

      if (!session) continue;

      session.configure(entry.sourceStartMs, entry.sourceEndMs, (frameMs, clipEndMs) => {
        this.onClipEndReached(entry.trackId, entry.clipId, frameMs, clipEndMs);
      });

      if (entry.isActive) {
        const sourceFrame = getSourceFrameAtPlayhead(entry.clip, currentFrame);
        const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
        session.start(sourceTimeSeconds);
      }
    }

    // Edit-point pre-cache: burst-decode first 500ms of pre-roll clips within 30 frames
    const PRE_CACHE_TRIGGER_FRAMES = VLC_CONFIG.PRE_CACHE_TRIGGER_FRAMES;
    const PRE_CACHE_SAMPLE_COUNT = VLC_CONFIG.PRE_CACHE_SAMPLE_COUNT;

    const ram = await this._getRenderAheadManager();
    if (ram && this._generation === gen) {
      for (const entry of schedule) {
        if (!entry.needsPreroll) continue;
        if (entry.clip.startFrame - currentFrame > PRE_CACHE_TRIGGER_FRAMES) continue;

        const key = `${entry.trackId}_${entry.clipId}`;
        if (this._activeStreams.has(key)) continue; // already a real stream
        if (this._preCachingKeys.has(key)) continue; // burst already in-flight

        // Check if first PRE_CACHE_SAMPLE_COUNT frames are already cached
        let cachedCount = 0;
        for (let i = 0; i < PRE_CACHE_SAMPLE_COUNT; i++) {
          const sf = getSourceFrameAtPlayhead(entry.clip, entry.clip.startFrame + i);
          if (sf == null) continue;
          const ms = Math.round((sf / fps) * 1000);
          if (ram._decodedSources.has(`${entry.mediaId}_${ms}`)) cachedCount++;
        }
        if (cachedCount >= PRE_CACHE_SAMPLE_COUNT) continue; // already warm

        // Fire-and-forget burst; guard with preCachingKeys to prevent duplicates
        this._preCachingKeys.add(key);
        this._burstDecode(entry, gen).finally(() => this._preCachingKeys.delete(key));
      }
    }
  },

  /**
   * Called by the clip-end callback from VLCBridge when a bounded clip
   * finishes streaming. Pauses the VLC stream and removes it from the active
   * map; `advancePlayback()` will naturally activate the next clip.
   *
   * @param {string} trackId
   * @param {string} clipId
   */
  onClipEndReached(trackId, clipId) {
    const key = `${trackId}_${clipId}`;
    const stream = this._activeStreams.get(key);
    if (!stream) return;

    try { stream.session?.stop(); } catch(_) {}
    this._activeStreams.delete(key);
    logger.info(`[SSC] Clip end reached: ${key}`);
  },

  /** Stop all streams and clear the active map. */
  stopPlayback() {
    for (const [, stream] of this._activeStreams) {
      try { stream.session?.stop(); } catch(_) {}
    }
    this._activeStreams.clear();
  },

  /**
   * Seek: tears down all streams, rebuilds for the new position.
   * - When playing: rebuilds the full stream set via startPlayback().
   * - When paused: sets bounds and calls syncSeek() for scrubbing accuracy.
   *
   * @param {number} frame
   */
  async seekPlayback(frame) {
    const isPlaying = editorState.get(STATE_PATHS.PLAYBACK_PLAYING);

    if (isPlaying) {
      await this.startPlayback(frame);
      return;
    }

    // Paused / scrubbing path: update bounds + seek without starting playback
    this._teardownAll();
    const gen = this._generation;
    const schedule = this.buildClipSchedule(frame, 0);
    const fps = this._fps || 30;
    const assignedMediaIds = new Set();

    for (const entry of schedule) {
      if (!entry.isActive) continue;

      let session = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        session = await this._getSession(entry.mediaId);
      }

      // A newer seek arrived while we were awaiting the session — abort.
      if (this._generation !== gen) return;

      if (!session) continue;

      const key = `${entry.trackId}_${entry.clipId}`;
      this._activeStreams.set(key, {
        mediaId: entry.mediaId,
        session,
        clipId: entry.clipId,
        trackId: entry.trackId,
      });

      session.configure(entry.sourceStartMs, entry.sourceEndMs, null);

      const sourceFrame = getSourceFrameAtPlayhead(entry.clip, frame);
      const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
      session.seek(sourceTimeSeconds);
    }
  },

  // ── Internals ──────────────────────────────────────────────────────────

  /** Stop and clear all active streams without emitting any events. */
  _teardownAll() {
    // Increment the generation counter so any suspended async methods
    // (startPlayback, advancePlayback, seekPlayback) that are awaiting a
    // session resolution will abort when they resume and compare generations.
    this._generation++;
    for (const [, stream] of this._activeStreams) {
      try { stream.session?.stop(); } catch(_) {}
    }
    this._activeStreams.clear();
    this._preCachingKeys.clear();
  },

  /**
   * Resolve a VLCBridge for `mediaId` via MediaDecoder, or null if not yet
   * initialized (the decode path will warm it up on first getFrame() call).
   *
   * @param {string} mediaId
   * @returns {Promise<object|null>}
   */
  async _getSession(mediaId) {
    try {
      const md = await _getMediaDecoder();
      return md.getStreamSession(mediaId);
    } catch(_) {
      return null;
    }
  },
  // Lazy import to avoid circular dependency — RenderAheadManager is only needed
  // for edit-point pre-cache sampling.
  async _getRenderAheadManager() {
    try {
      const { renderAheadManager } = await import('../media/RenderAheadManager.js');
      return renderAheadManager;
    } catch (_) {
      return null;
    }
  },

  // Burst-decode the first 500ms of a clip range for edit-point pre-cache.
  // Fire-and-forget from advancePlayback — isolated so it doesn't block the main loop.
  async _burstDecode(entry, gen) {
    const session = await this._getSession(entry.mediaId);
    if (this._generation !== gen || !session) return;

    const key = `${entry.trackId}_${entry.clipId}`;
    if (this._activeStreams.has(key)) return;

    const burstEnd = Math.min(
      entry.sourceStartMs + VLC_CONFIG.PRE_CACHE_BURST_MS,
      entry.sourceEndMs
    );
    await session.burstDecode(entry.sourceStartMs, burstEnd);

    if (this._generation !== gen) return;
    // burstDecode() already cleaned up
  },
};

export default sequenceStreamController;

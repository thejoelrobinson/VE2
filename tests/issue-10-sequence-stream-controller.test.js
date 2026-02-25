/**
 * Issue #10 — SequenceStreamController
 *
 * Pure-logic tests. We re-implement the core scheduling functions inline
 * so the test file has zero browser-API or WASM dependencies. This mirrors
 * the approach taken in issue-9-clip-bounded-vlc.test.js.
 *
 * Functions under test (re-implemented inline):
 *   - buildClipSchedule()
 *   - startPlayback() / advancePlayback() stream lifecycle
 *   - seekPlayback() (playing vs. paused paths)
 *   - stopPlayback()
 *   - Per-clip source-time math
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Helpers — mirrors of Clip.js pure functions ──────────────────────────────

function getClipDuration(clip) {
  return Math.round((clip.sourceOutFrame - clip.sourceInFrame) / clip.speed);
}

function getClipEndFrame(clip) {
  return clip.startFrame + getClipDuration(clip);
}

function clipContainsFrame(clip, frame) {
  return frame >= clip.startFrame && frame < getClipEndFrame(clip);
}

function getSourceFrameAtPlayhead(clip, playheadFrame) {
  if (!clipContainsFrame(clip, playheadFrame)) return null;
  const offsetInClip = playheadFrame - clip.startFrame;
  return clip.sourceInFrame + Math.round(offsetInClip * clip.speed);
}

// ── Clip / track factory helpers ─────────────────────────────────────────────

function makeClip({ id, mediaId, startFrame, sourceInFrame, sourceOutFrame, speed = 1, disabled = false } = {}) {
  return {
    id: id ?? 'clip-1',
    // Use undefined-check so callers can explicitly pass null to test the no-mediaId path
    mediaId: mediaId !== undefined ? mediaId : 'media-1',
    startFrame: startFrame ?? 0,
    sourceInFrame: sourceInFrame ?? 0,
    sourceOutFrame: sourceOutFrame ?? 300,
    speed,
    disabled,
  };
}

function makeTrack({ id, muted = false, clips = [] } = {}) {
  return {
    id: id || 'track-1',
    muted,
    clips,
  };
}

// ── Pure scheduling logic (mirrors SequenceStreamController.buildClipSchedule) ─

const DEFAULT_LOOKAHEAD = 60;

function buildClipSchedule(tracks, currentFrame, lookahead = DEFAULT_LOOKAHEAD, fps = 30) {
  const schedule = [];
  for (const track of tracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.disabled || !clip.mediaId) continue;

      const isActive = clipContainsFrame(clip, currentFrame);
      const clipEnd = getClipEndFrame(clip);
      const lookaheadFrame = currentFrame + lookahead;

      const needsPreroll =
        !isActive &&
        clip.startFrame > currentFrame &&
        clip.startFrame <= lookaheadFrame;

      if (!isActive && !needsPreroll) continue;

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
}

// ── Bridge mock factory ───────────────────────────────────────────────────────

function makeBridge(mediaId = 'media-1') {
  return {
    mediaId,
    calls: [],
    setClipBounds(s, e) { this.calls.push({ fn: 'setClipBounds', s, e }); },
    clearClipBounds() { this.calls.push({ fn: 'clearClipBounds' }); },
    setPlaybackActive(playing, t) { this.calls.push({ fn: 'setPlaybackActive', playing, t }); },
    syncSeek(t) { this.calls.push({ fn: 'syncSeek', t }); },
    setClipEndCallback(fn) { this._endCb = fn; },
    _endCb: null,
  };
}

// ── Simulated SSC helper functions ────────────────────────────────────────────
// Mirrors the startPlayback / stopPlayback / advancePlayback / seekPlayback
// logic from SequenceStreamController so we can unit-test the state machine
// without any browser APIs.

function makeSSC({ fps = 30, getBridge } = {}) {
  const activeStreams = new Map();

  function teardownAll() {
    for (const [, stream] of activeStreams) {
      if (stream.bridge) {
        stream.bridge.setPlaybackActive(false, 0);
        stream.bridge.clearClipBounds();
      }
    }
    activeStreams.clear();
  }

  function startPlayback(tracks, startFrame) {
    teardownAll();
    const schedule = buildClipSchedule(tracks, startFrame, DEFAULT_LOOKAHEAD, fps);
    const assignedMediaIds = new Set();

    for (const entry of schedule) {
      const key = `${entry.trackId}_${entry.clipId}`;
      let bridge = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        bridge = getBridge(entry.mediaId);
      }
      const streamEntry = {
        mediaId: entry.mediaId,
        bridge,
        clipId: entry.clipId,
        trackId: entry.trackId,
        activated: false,
      };
      activeStreams.set(key, streamEntry);
      if (!bridge) continue;
      bridge.setClipBounds(entry.sourceStartMs, entry.sourceEndMs);
      bridge.setClipEndCallback((_frameMs, _clipEndMs) => {
        onClipEndReached(entry.trackId, entry.clipId);
      });
      if (entry.isActive) {
        const sourceFrame = getSourceFrameAtPlayhead(entry.clip, startFrame);
        const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
        bridge.setPlaybackActive(true, sourceTimeSeconds);
        streamEntry.activated = true;
      }
    }
  }

  function advancePlayback(tracks, currentFrame) {
    const schedule = buildClipSchedule(tracks, currentFrame, DEFAULT_LOOKAHEAD, fps);
    const relevantKeys = new Set(schedule.map(e => `${e.trackId}_${e.clipId}`));

    for (const [key, stream] of activeStreams) {
      if (!relevantKeys.has(key)) {
        if (stream.bridge) {
          stream.bridge.setPlaybackActive(false, 0);
          stream.bridge.clearClipBounds();
        }
        activeStreams.delete(key);
      }
    }

    const assignedMediaIds = new Set([...activeStreams.values()].map(s => s.mediaId));

    for (const entry of schedule) {
      const key = `${entry.trackId}_${entry.clipId}`;
      if (activeStreams.has(key)) {
        const stream = activeStreams.get(key);
        // Only promote once — skip if already activated to avoid seek-flood.
        if (entry.isActive && stream.bridge && !stream.activated) {
          const sourceFrame = getSourceFrameAtPlayhead(entry.clip, currentFrame);
          const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
          stream.bridge.setPlaybackActive(true, sourceTimeSeconds);
          stream.activated = true;
        }
        continue;
      }
      let bridge = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        bridge = getBridge(entry.mediaId);
      }
      const streamEntry = {
        mediaId: entry.mediaId,
        bridge,
        clipId: entry.clipId,
        trackId: entry.trackId,
        activated: false,
      };
      activeStreams.set(key, streamEntry);
      if (!bridge) continue;
      bridge.setClipBounds(entry.sourceStartMs, entry.sourceEndMs);
      bridge.setClipEndCallback((_frameMs, _clipEndMs) => {
        onClipEndReached(entry.trackId, entry.clipId);
      });
      if (entry.isActive) {
        const sourceFrame = getSourceFrameAtPlayhead(entry.clip, currentFrame);
        const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
        bridge.setPlaybackActive(true, sourceTimeSeconds);
        streamEntry.activated = true;
      }
    }
  }

  function stopPlayback() {
    teardownAll();
  }

  function seekPlayback(tracks, frame, isPlaying) {
    if (isPlaying) {
      startPlayback(tracks, frame);
      return;
    }
    teardownAll();
    const schedule = buildClipSchedule(tracks, frame, 0, fps);
    const assignedMediaIds = new Set();
    for (const entry of schedule) {
      if (!entry.isActive) continue;
      let bridge = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        bridge = getBridge(entry.mediaId);
      }
      if (!bridge) continue;
      const key = `${entry.trackId}_${entry.clipId}`;
      activeStreams.set(key, { mediaId: entry.mediaId, bridge, clipId: entry.clipId, trackId: entry.trackId });
      bridge.setClipBounds(entry.sourceStartMs, entry.sourceEndMs);
      const sourceFrame = getSourceFrameAtPlayhead(entry.clip, frame);
      const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
      bridge.syncSeek(sourceTimeSeconds);
    }
  }

  function onClipEndReached(trackId, clipId) {
    const key = `${trackId}_${clipId}`;
    const stream = activeStreams.get(key);
    if (!stream) return;
    if (stream.bridge) {
      stream.bridge.setPlaybackActive(false, 0);
      stream.bridge.clearClipBounds();
    }
    activeStreams.delete(key);
  }

  return { activeStreams, startPlayback, advancePlayback, stopPlayback, seekPlayback, onClipEndReached };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Issue #10 — SequenceStreamController', () => {

  // ── buildClipSchedule ────────────────────────────────────────────────────

  describe('buildClipSchedule — single clip', () => {
    const fps = 30;
    // Clip: timeline 0–150, source 0–300 frames (10s at 30fps)
    const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
    const track = makeTrack({ clips: [clip] });

    it('marks clip as active at frame 75 (inside clip)', () => {
      const sched = buildClipSchedule([track], 75, 60, fps);
      expect(sched).toHaveLength(1);
      expect(sched[0].isActive).toBe(true);
      expect(sched[0].needsPreroll).toBe(false);
    });

    it('marks clip as preroll when playhead is before clip start within lookahead', () => {
      // Clip starts at frame 50; playhead at frame 0; lookahead 60 → 50 within 0+60
      const futureClip = makeClip({ id: 'clip-future', startFrame: 50, sourceInFrame: 0, sourceOutFrame: 300 });
      const t = makeTrack({ clips: [futureClip] });
      const sched = buildClipSchedule([t], 0, 60, fps);
      expect(sched).toHaveLength(1);
      expect(sched[0].needsPreroll).toBe(true);
      expect(sched[0].isActive).toBe(false);
    });

    it('excludes clips beyond the lookahead window', () => {
      // Clip starts at frame 90; playhead at 0; lookahead 60 → 90 > 60
      const farClip = makeClip({ id: 'far', startFrame: 90, sourceInFrame: 0, sourceOutFrame: 300 });
      const t = makeTrack({ clips: [farClip] });
      const sched = buildClipSchedule([t], 0, 60, fps);
      expect(sched).toHaveLength(0);
    });

    it('skips muted tracks', () => {
      const mutedTrack = makeTrack({ muted: true, clips: [clip] });
      const sched = buildClipSchedule([mutedTrack], 75, 60, fps);
      expect(sched).toHaveLength(0);
    });

    it('skips disabled clips', () => {
      const disabledClip = makeClip({ disabled: true });
      const t = makeTrack({ clips: [disabledClip] });
      const sched = buildClipSchedule([t], 75, 60, fps);
      expect(sched).toHaveLength(0);
    });

    it('skips clips with no mediaId', () => {
      const noMediaClip = makeClip({ mediaId: null });
      const t = makeTrack({ clips: [noMediaClip] });
      const sched = buildClipSchedule([t], 75, 60, fps);
      expect(sched).toHaveLength(0);
    });

    it('computes correct sourceStartMs and sourceEndMs', () => {
      // sourceInFrame=300, sourceOutFrame=600 at 30fps → 10s–20s
      const c = makeClip({ sourceInFrame: 300, sourceOutFrame: 600 });
      const t = makeTrack({ clips: [c] });
      const sched = buildClipSchedule([t], 75, 60, fps);
      expect(sched[0].sourceStartMs).toBeCloseTo(10000);
      expect(sched[0].sourceEndMs).toBeCloseTo(20000);
    });
  });

  // ── Multi-track ──────────────────────────────────────────────────────────

  describe('buildClipSchedule — multi-track', () => {
    it('V1 clip A [0-150] + V2 clip B [50-200] → both active at frame 75', () => {
      const clipA = makeClip({ id: 'clip-a', trackId: 'v1', mediaId: 'media-a', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 150 });
      const clipB = makeClip({ id: 'clip-b', trackId: 'v2', mediaId: 'media-b', startFrame: 50, sourceInFrame: 0, sourceOutFrame: 150 });
      const trackV1 = makeTrack({ id: 'v1', clips: [clipA] });
      const trackV2 = makeTrack({ id: 'v2', clips: [clipB] });

      const sched = buildClipSchedule([trackV1, trackV2], 75, 60, 30);
      expect(sched).toHaveLength(2);
      const active = sched.filter(e => e.isActive);
      expect(active).toHaveLength(2);
    });

    it('only V1 clip is active before V2 clip starts', () => {
      const clipA = makeClip({ id: 'clip-a', mediaId: 'media-a', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 150 });
      const clipB = makeClip({ id: 'clip-b', mediaId: 'media-b', startFrame: 100, sourceInFrame: 0, sourceOutFrame: 150 });
      const trackV1 = makeTrack({ id: 'v1', clips: [clipA] });
      const trackV2 = makeTrack({ id: 'v2', clips: [clipB] });

      // Frame 10: only A is active; B at 100 is outside lookahead 60 → frame 70
      const sched = buildClipSchedule([trackV1, trackV2], 10, 60, 30);
      expect(sched).toHaveLength(1);
      expect(sched[0].clipId).toBe('clip-a');
    });
  });

  // ── startPlayback ─────────────────────────────────────────────────────────

  describe('startPlayback', () => {
    it('calls setClipBounds with correct source bounds', () => {
      const bridge = makeBridge('media-1');
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);

      const boundsCall = bridge.calls.find(c => c.fn === 'setClipBounds');
      expect(boundsCall).toBeDefined();
      expect(boundsCall.s).toBeCloseTo(0);       // sourceInFrame=0 → 0ms
      expect(boundsCall.e).toBeCloseTo(10000);   // sourceOutFrame=300 at 30fps → 10s
    });

    it('calls setPlaybackActive(true) for the active clip', () => {
      const bridge = makeBridge('media-1');
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);

      const playCall = bridge.calls.find(c => c.fn === 'setPlaybackActive' && c.playing);
      expect(playCall).toBeDefined();
      expect(playCall.t).toBeCloseTo(0); // frame 0 → 0 / 30fps = 0s
    });

    it('does NOT call setPlaybackActive for pre-roll-only clips', () => {
      const bridge = makeBridge('media-1');
      // Clip starts at frame 50; playhead at 0 → pre-roll only
      const clip = makeClip({ startFrame: 50, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);

      const playCall = bridge.calls.find(c => c.fn === 'setPlaybackActive' && c.playing);
      expect(playCall).toBeUndefined();
    });

    it('assigns bridge: null for the second clip sharing a mediaId (conflict)', () => {
      const bridge = makeBridge('shared-media');
      const clipA = makeClip({ id: 'clip-a', mediaId: 'shared-media', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const clipB = makeClip({ id: 'clip-b', mediaId: 'shared-media', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const trackA = makeTrack({ id: 'v1', clips: [clipA] });
      const trackB = makeTrack({ id: 'v2', clips: [clipB] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([trackA, trackB], 45);

      // Only one setPlaybackActive should be fired
      const playCalls = bridge.calls.filter(c => c.fn === 'setPlaybackActive' && c.playing);
      expect(playCalls).toHaveLength(1);
    });
  });

  // ── Edit-point handoff / preroll ──────────────────────────────────────────

  describe('Edit-point handoff — preroll at 30 frames before edit', () => {
    it('schedules clip B for preroll at frame 60 when B starts at 90 (lookahead 60)', () => {
      const clipA = makeClip({ id: 'clip-a', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const clipB = makeClip({ id: 'clip-b', mediaId: 'media-2', startFrame: 90, sourceInFrame: 0, sourceOutFrame: 90 });
      const track = makeTrack({ clips: [clipA, clipB] });

      // At frame 60: clipA is active (0–89), clipB starts at 90 within lookahead 60 → 120
      const sched = buildClipSchedule([track], 60, 60, 30);
      const bEntry = sched.find(e => e.clipId === 'clip-b');
      expect(bEntry).toBeDefined();
      expect(bEntry.needsPreroll).toBe(true);
      expect(bEntry.isActive).toBe(false);
    });

    it('does NOT preroll clip B at frame 20 when B starts at 90 (lookahead 60 → 80)', () => {
      const clipB = makeClip({ id: 'clip-b', mediaId: 'media-2', startFrame: 90, sourceInFrame: 0, sourceOutFrame: 90 });
      const track = makeTrack({ clips: [clipB] });

      const sched = buildClipSchedule([track], 20, 60, 30);
      expect(sched).toHaveLength(0);
    });
  });

  // ── stopPlayback ──────────────────────────────────────────────────────────

  describe('stopPlayback', () => {
    it('calls setPlaybackActive(false) and clearClipBounds on all active streams', () => {
      const bridge = makeBridge();
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);
      bridge.calls.length = 0; // reset to inspect only stop calls

      ssc.stopPlayback();

      expect(bridge.calls.find(c => c.fn === 'setPlaybackActive' && !c.playing)).toBeDefined();
      expect(bridge.calls.find(c => c.fn === 'clearClipBounds')).toBeDefined();
      expect(ssc.activeStreams.size).toBe(0);
    });
  });

  // ── seekPlayback ──────────────────────────────────────────────────────────

  describe('seekPlayback', () => {
    it('when playing: calls startPlayback (setPlaybackActive) from new frame', () => {
      const bridge = makeBridge();
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.seekPlayback([track], 15, true /* isPlaying */);

      const playCall = bridge.calls.find(c => c.fn === 'setPlaybackActive' && c.playing);
      expect(playCall).toBeDefined();
      // frame 15 at sourceInFrame=0 → sourceFrame=15 → 15/30 = 0.5s
      expect(playCall.t).toBeCloseTo(0.5);
    });

    it('when paused: calls syncSeek with correct source time', () => {
      const bridge = makeBridge();
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.seekPlayback([track], 30, false /* paused */);

      const seekCall = bridge.calls.find(c => c.fn === 'syncSeek');
      expect(seekCall).toBeDefined();
      // frame 30 at sourceInFrame=0 → sourceFrame=30 → 30/30 = 1.0s
      expect(seekCall.t).toBeCloseTo(1.0);
    });

    it('when paused: does NOT call setPlaybackActive', () => {
      const bridge = makeBridge();
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.seekPlayback([track], 30, false);
      const playCall = bridge.calls.find(c => c.fn === 'setPlaybackActive');
      expect(playCall).toBeUndefined();
    });
  });

  // ── Per-clip source time math ─────────────────────────────────────────────

  describe('Per-clip source time math', () => {
    it('sourceInFrame=300, startFrame=0, fps=30 → at frame 15: 10.5s', () => {
      // sourceFrame = sourceInFrame + offsetInClip = 300 + 15 = 315
      // sourceTimeSeconds = 315 / 30 = 10.5s
      const clip = makeClip({ startFrame: 0, sourceInFrame: 300, sourceOutFrame: 600 });
      const fps = 30;
      const playheadFrame = 15;
      const sourceFrame = getSourceFrameAtPlayhead(clip, playheadFrame);
      expect(sourceFrame).toBe(315);
      expect(sourceFrame / fps).toBeCloseTo(10.5);
    });

    it('getSourceFrameAtPlayhead returns null when playhead is outside the clip', () => {
      const clip = makeClip({ startFrame: 50, sourceInFrame: 0, sourceOutFrame: 150 });
      expect(getSourceFrameAtPlayhead(clip, 10)).toBeNull();
      expect(getSourceFrameAtPlayhead(clip, 200)).toBeNull();
    });

    it('speed > 1 compresses source — 2x speed clip at frame 10 from clip start → sourceFrame += 20', () => {
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300, speed: 2 });
      // offsetInClip=10, sourceFrame = 0 + 10 * 2 = 20
      const sf = getSourceFrameAtPlayhead(clip, 10);
      expect(sf).toBe(20);
    });
  });

  // ── advancePlayback ───────────────────────────────────────────────────────

  describe('advancePlayback', () => {
    it('deactivates a stream when its clip leaves the lookahead window', () => {
      const bridge = makeBridge();
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);
      expect(ssc.activeStreams.size).toBe(1);

      // Advance past end of clip (clip ends at frame 90, no more clips in window)
      bridge.calls.length = 0;
      ssc.advancePlayback([track], 95);

      expect(ssc.activeStreams.size).toBe(0);
      expect(bridge.calls.find(c => c.fn === 'clearClipBounds')).toBeDefined();
    });

    it('activates a new clip entering the active region mid-playback', () => {
      const bridge1 = makeBridge('media-1');
      const bridge2 = makeBridge('media-2');
      const clipA = makeClip({ id: 'clip-a', mediaId: 'media-1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const clipB = makeClip({ id: 'clip-b', mediaId: 'media-2', startFrame: 90, sourceInFrame: 0, sourceOutFrame: 90 });
      const track = makeTrack({ clips: [clipA, clipB] });
      const bridges = { 'media-1': bridge1, 'media-2': bridge2 };
      const ssc = makeSSC({ fps: 30, getBridge: id => bridges[id] });

      // Start at frame 0 — only clipA is active; clipB not yet in window (90 > 60)
      ssc.startPlayback([track], 0);
      expect(ssc.activeStreams.size).toBe(1);

      // Advance to frame 35 — clipB at 90 is now within lookahead (35+60=95 ≥ 90)
      ssc.advancePlayback([track], 35);
      expect(ssc.activeStreams.size).toBe(2);

      const streamB = ssc.activeStreams.get('track-1_clip-b');
      expect(streamB).toBeDefined();
      expect(streamB.bridge).toBe(bridge2);
    });
  });

  // ── onClipEndReached ──────────────────────────────────────────────────────

  describe('onClipEndReached', () => {
    it('removes the stream and stops the bridge', () => {
      const bridge = makeBridge();
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);
      expect(ssc.activeStreams.size).toBe(1);

      bridge.calls.length = 0;
      ssc.onClipEndReached(track.id, clip.id);

      expect(ssc.activeStreams.size).toBe(0);
      expect(bridge.calls.find(c => c.fn === 'setPlaybackActive' && !c.playing)).toBeDefined();
      expect(bridge.calls.find(c => c.fn === 'clearClipBounds')).toBeDefined();
    });

    it('is a no-op when called with an unknown key', () => {
      const bridge = makeBridge();
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSC({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);
      bridge.calls.length = 0;

      // Key that was never registered — must not throw and must not mutate bridge
      expect(() => ssc.onClipEndReached('nonexistent-track', 'nonexistent-clip')).not.toThrow();
      expect(bridge.calls).toHaveLength(0);
      expect(ssc.activeStreams.size).toBe(1); // original stream untouched
    });
  });

  // ── Bug-fix: activated flag prevents seek-flood ───────────────────────────

  describe('advancePlayback — activated guard (Bug 1 regression)', () => {
    it('does not call setPlaybackActive again on already-active streams', () => {
      const bridge = makeBridge();
      // Clip spans frames 0–300; playhead starts at 0 — clip is immediately active
      const clip = makeClip({ startFrame: 0, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSCWithActivated({ fps: 30, getBridge: () => bridge });

      ssc.startPlayback([track], 0);

      // Count setPlaybackActive(true) calls after start
      const activeCalls = () => bridge.calls.filter(c => c.fn === 'setPlaybackActive' && c.playing).length;
      expect(activeCalls()).toBe(1); // one call from startPlayback

      // Advance twice — no additional setPlaybackActive should fire
      ssc.advancePlayback([track], 5);
      ssc.advancePlayback([track], 10);
      expect(activeCalls()).toBe(1);
    });

    it('promotes a preroll clip to active exactly once, then stays silent', () => {
      const bridge = makeBridge();
      // Clip starts at frame 50; at frame 0 it is within lookahead (0+60=60 ≥ 50)
      const clip = makeClip({ startFrame: 50, sourceInFrame: 0, sourceOutFrame: 300 });
      const track = makeTrack({ clips: [clip] });
      const ssc = makeSSCWithActivated({ fps: 30, getBridge: () => bridge });

      // startPlayback at frame 0 — clip is preroll only, no setPlaybackActive yet
      ssc.startPlayback([track], 0);
      const callsAfterStart = bridge.calls.filter(c => c.fn === 'setPlaybackActive' && c.playing).length;
      expect(callsAfterStart).toBe(0);

      // First advance into the active region — should fire setPlaybackActive once
      ssc.advancePlayback([track], 50);
      expect(bridge.calls.filter(c => c.fn === 'setPlaybackActive' && c.playing)).toHaveLength(1);

      // Second advance while still active — must NOT fire again
      ssc.advancePlayback([track], 55);
      expect(bridge.calls.filter(c => c.fn === 'setPlaybackActive' && c.playing)).toHaveLength(1);
    });
  });
});

// ── makeSSCWithActivated — SSC simulation with the activated guard ─────────
// Mirrors the fixed SequenceStreamController logic including the `activated`
// boolean field on stream entries and the preroll-to-active promotion guard.

function makeSSCWithActivated({ fps = 30, getBridge } = {}) {
  const activeStreams = new Map();

  function teardownAll() {
    for (const [, stream] of activeStreams) {
      if (stream.bridge) {
        stream.bridge.setPlaybackActive(false, 0);
        stream.bridge.clearClipBounds();
      }
    }
    activeStreams.clear();
  }

  function startPlayback(tracks, startFrame) {
    teardownAll();
    const schedule = buildClipSchedule(tracks, startFrame, DEFAULT_LOOKAHEAD, fps);
    const assignedMediaIds = new Set();

    for (const entry of schedule) {
      const key = `${entry.trackId}_${entry.clipId}`;
      let bridge = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        bridge = getBridge(entry.mediaId);
      }
      const streamEntry = {
        mediaId: entry.mediaId,
        bridge,
        clipId: entry.clipId,
        trackId: entry.trackId,
        activated: false,
      };
      activeStreams.set(key, streamEntry);
      if (!bridge) continue;
      bridge.setClipBounds(entry.sourceStartMs, entry.sourceEndMs);
      bridge.setClipEndCallback((_frameMs, _clipEndMs) => {
        onClipEndReached(entry.trackId, entry.clipId);
      });
      if (entry.isActive) {
        const sourceFrame = getSourceFrameAtPlayhead(entry.clip, startFrame);
        const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
        bridge.setPlaybackActive(true, sourceTimeSeconds);
        streamEntry.activated = true;
      }
    }
  }

  function advancePlayback(tracks, currentFrame) {
    const schedule = buildClipSchedule(tracks, currentFrame, DEFAULT_LOOKAHEAD, fps);
    const relevantKeys = new Set(schedule.map(e => `${e.trackId}_${e.clipId}`));

    for (const [key, stream] of activeStreams) {
      if (!relevantKeys.has(key)) {
        if (stream.bridge) {
          stream.bridge.setPlaybackActive(false, 0);
          stream.bridge.clearClipBounds();
        }
        activeStreams.delete(key);
      }
    }

    const assignedMediaIds = new Set([...activeStreams.values()].map(s => s.mediaId));

    for (const entry of schedule) {
      const key = `${entry.trackId}_${entry.clipId}`;
      if (activeStreams.has(key)) {
        const stream = activeStreams.get(key);
        // Only promote once — skip if already activated to avoid seek-flood.
        if (entry.isActive && stream.bridge && !stream.activated) {
          const sourceFrame = getSourceFrameAtPlayhead(entry.clip, currentFrame);
          const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
          stream.bridge.setPlaybackActive(true, sourceTimeSeconds);
          stream.activated = true;
        }
        continue;
      }
      let bridge = null;
      if (!assignedMediaIds.has(entry.mediaId)) {
        assignedMediaIds.add(entry.mediaId);
        bridge = getBridge(entry.mediaId);
      }
      const streamEntry = {
        mediaId: entry.mediaId,
        bridge,
        clipId: entry.clipId,
        trackId: entry.trackId,
        activated: false,
      };
      activeStreams.set(key, streamEntry);
      if (!bridge) continue;
      bridge.setClipBounds(entry.sourceStartMs, entry.sourceEndMs);
      bridge.setClipEndCallback((_frameMs, _clipEndMs) => {
        onClipEndReached(entry.trackId, entry.clipId);
      });
      if (entry.isActive) {
        const sourceFrame = getSourceFrameAtPlayhead(entry.clip, currentFrame);
        const sourceTimeSeconds = sourceFrame != null ? sourceFrame / fps : entry.sourceStartMs / 1000;
        bridge.setPlaybackActive(true, sourceTimeSeconds);
        streamEntry.activated = true;
      }
    }
  }

  function onClipEndReached(trackId, clipId) {
    const key = `${trackId}_${clipId}`;
    const stream = activeStreams.get(key);
    if (!stream) return;
    if (stream.bridge) {
      stream.bridge.setPlaybackActive(false, 0);
      stream.bridge.clearClipBounds();
    }
    activeStreams.delete(key);
  }

  return { activeStreams, startPlayback, advancePlayback, onClipEndReached };
}

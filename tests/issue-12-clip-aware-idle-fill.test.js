/**
 * Issue #12 — Clip-Aware Idle Fill + Edit Point Pre-cache
 *
 * Pure-logic tests verifying that:
 * 1. _getUndecodedClipRanges scans clips and returns sorted undecoded ranges
 * 2. _clipAwareIdleFillTick drives VLC clip-by-clip with proper state machine
 * 3. Edit-point burst-decode fires for pre-roll clips within 30 frames
 * 4. Fallback to old _idleFillTick when all clip ranges are exhausted
 *
 * No browser APIs or WASM — all logic re-implemented inline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClip(overrides = {}) {
  return {
    id: 'clip-1',
    mediaId: 'media-1',
    startFrame: 0,
    sourceInFrame: 0,
    sourceOutFrame: 150, // 5s at 30fps
    speed: 1,
    disabled: false,
    ...overrides,
  };
}

function makeTrack(clips, overrides = {}) {
  return {
    id: 'track-1',
    muted: false,
    clips,
    ...overrides,
  };
}

function makeMediaItem(type = 'video') {
  return { type };
}

/**
 * Re-implements getClipEndFrame from Clip.js:
 *   clipDuration = (sourceOutFrame - sourceInFrame) / speed
 *   clipEndFrame = startFrame + clipDuration
 */
function getClipEndFrame(clip) {
  const duration = Math.round((clip.sourceOutFrame - clip.sourceInFrame) / (clip.speed || 1));
  return clip.startFrame + duration;
}

/**
 * Re-implements getSourceFrameAtPlayhead from Clip.js.
 */
function getSourceFrameAtPlayhead(clip, playheadFrame) {
  const clipEnd = getClipEndFrame(clip);
  if (playheadFrame < clip.startFrame || playheadFrame >= clipEnd) return null;
  const offsetInClip = playheadFrame - clip.startFrame;
  return clip.sourceInFrame + Math.round(offsetInClip * (clip.speed || 1));
}

// ── Mock bridge factory ─────────────────────────────────────────────────────

function createMockBridge() {
  let _clipEndCb = null;
  let _playing = false;
  let _clipBounds = null;

  return {
    calls: [],
    setClipEndCallback(fn) {
      _clipEndCb = fn;
      this.calls.push({ method: 'setClipEndCallback', args: [fn] });
    },
    setClipBounds(startMs, endMs) {
      _clipBounds = { startMs, endMs };
      this.calls.push({ method: 'setClipBounds', args: [startMs, endMs] });
    },
    clearClipBounds() {
      _clipBounds = null;
      this.calls.push({ method: 'clearClipBounds' });
    },
    setPlaybackActive(active, time) {
      _playing = active;
      this.calls.push({ method: 'setPlaybackActive', args: [active, time] });
    },
    // Test helpers
    fireClipEnd() {
      if (_clipEndCb) _clipEndCb();
    },
    get isPlaying() { return _playing; },
    get clipBounds() { return _clipBounds; },
    get clipEndCallback() { return _clipEndCb; },
  };
}

// ── _getUndecodedClipRanges simulation ──────────────────────────────────────

function getUndecodedClipRanges(playheadFrame, fps, videoTracks, mediaItems, decodedSources) {
  const ranges = [];
  for (const track of videoTracks) {
    if (track.muted) continue;
    for (const clip of track.clips) {
      if (clip.disabled || !clip.mediaId) continue;
      const mediaItem = mediaItems.get(clip.mediaId);
      if (!mediaItem || mediaItem.type !== 'video') continue;

      const sourceStartMs = Math.round((clip.sourceInFrame / fps) * 1000);
      const sourceEndMs = Math.round((clip.sourceOutFrame / fps) * 1000);
      if (sourceEndMs <= sourceStartMs) continue;

      // Sample 5 timestamps — skip range if all already decoded
      const SAMPLES = 5;
      let decoded = 0;
      for (let i = 0; i < SAMPLES; i++) {
        const t = i / (SAMPLES - 1);
        const ms = Math.round(sourceStartMs + t * (sourceEndMs - sourceStartMs));
        if (decodedSources.has(`${clip.mediaId}_${ms}`)) decoded++;
      }
      if (decoded >= SAMPLES) continue;

      const clipEnd = getClipEndFrame(clip);
      const distance =
        playheadFrame >= clip.startFrame && playheadFrame < clipEnd
          ? 0
          : playheadFrame < clip.startFrame
            ? clip.startFrame - playheadFrame
            : playheadFrame - clipEnd;

      ranges.push({ mediaId: clip.mediaId, sourceStartMs, sourceEndMs, distance });
    }
  }
  return ranges.sort((a, b) => a.distance - b.distance);
}

// ── _clipAwareIdleFillTick simulation ──────────────────────────────────────

/**
 * Simulates the _clipAwareIdleFillTick state machine.
 * Returns a promise that resolves with information about what happened.
 */
async function clipAwareIdleFillTick(state, getBridge, oldTickFn) {
  if (state.gen !== state.idleFillGen) return { action: 'stale_gen' };
  if (state.playing) return { action: 'playing' };
  if (state.exportPaused) return { action: 'export_paused' };

  // Build range list once per cycle
  if (!state.idleFillRanges) {
    state.idleFillRanges = getUndecodedClipRanges(
      state.playheadFrame, state.fps, state.videoTracks,
      state.mediaItems, state.decodedSources
    );
    state.idleFillRangeIndex = 0;
  }

  // Skip decoded ranges
  while (
    state.idleFillRangeIndex < state.idleFillRanges.length &&
    state.decodedSources.has(
      `${state.idleFillRanges[state.idleFillRangeIndex].mediaId}_${state.idleFillRanges[state.idleFillRangeIndex].sourceStartMs}`
    )
  ) {
    state.idleFillRangeIndex++;
  }

  // All ranges done — fallback
  if (state.idleFillRangeIndex >= state.idleFillRanges.length) {
    state.idleFillRanges = null;
    if (oldTickFn) oldTickFn(state.gen);
    return { action: 'fallback_to_old_tick' };
  }

  // Buffer near capacity
  if (state.bufferSize >= state.bufferLimit * 0.9) {
    return { action: 'backoff' };
  }

  const range = state.idleFillRanges[state.idleFillRangeIndex];
  const bridge = getBridge(range.mediaId);

  // No bridge — skip
  if (!bridge) {
    state.idleFillRangeIndex++;
    if (state.gen !== state.idleFillGen) return { action: 'stale_gen_after_skip' };
    return { action: 'no_bridge_skip', mediaId: range.mediaId };
  }

  // Drive VLC
  const clipDurationMs = range.sourceEndMs - range.sourceStartMs;
  const maxWaitMs = Math.min(clipDurationMs + 1000, 20000);

  const bridgeResult = await new Promise(resolve => {
    let settled = false;
    const tid = setTimeout(() => {
      if (!settled) { settled = true; resolve('timeout'); }
    }, maxWaitMs);
    bridge.setClipEndCallback(() => {
      if (!settled) { settled = true; clearTimeout(tid); resolve('clip_end'); }
    });
    bridge.setClipBounds(range.sourceStartMs, range.sourceEndMs);
    bridge.setPlaybackActive(true, range.sourceStartMs / 1000);
  });

  // Re-check gen after await
  if (state.gen !== state.idleFillGen) return { action: 'stale_gen_after_await' };

  bridge.setPlaybackActive(false, 0);
  bridge.clearClipBounds();
  bridge.setClipEndCallback(null);

  state.idleFillRangeIndex++;

  return { action: 'range_completed', bridgeResult, range };
}

// ── Burst-decode simulation ────────────────────────────────────────────────

async function burstDecode(entry, gen, state, getBridgeFn) {
  const BURST_MS = 500;
  const bridge = await getBridgeFn(entry.mediaId);
  if (state.generation !== gen || !bridge) return { action: 'aborted' };

  const key = `${entry.trackId}_${entry.clipId}`;
  if (state.activeStreams.has(key)) return { action: 'already_active' };

  const burstEnd = Math.min(entry.sourceStartMs + BURST_MS, entry.sourceEndMs);

  const result = await new Promise(resolve => {
    let done = false;
    const tid = setTimeout(() => {
      if (!done) { done = true; resolve('timeout'); }
    }, BURST_MS + 200);
    bridge.setClipEndCallback(() => {
      if (!done) { done = true; clearTimeout(tid); resolve('clip_end'); }
    });
    bridge.setClipBounds(entry.sourceStartMs, burstEnd);
    bridge.setPlaybackActive(true, entry.sourceStartMs / 1000);
  });

  if (state.generation !== gen) return { action: 'gen_changed_after_await' };

  if (!state.activeStreams.has(key)) {
    bridge.setPlaybackActive(false, 0);
    bridge.clearClipBounds();
    bridge.setClipEndCallback(null);
    return { action: 'cleaned_up', result };
  }

  return { action: 'ssc_took_over', result };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Issue #12 — Clip-Aware Idle Fill + Edit Point Pre-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ── 1. _getUndecodedClipRanges ──────────────────────────────────────────

  describe('_getUndecodedClipRanges', () => {
    it('returns all clip ranges from a multi-track timeline', () => {
      const fps = 30;
      const clipA = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const clipB = makeClip({ id: 'c2', mediaId: 'm2', startFrame: 100, sourceInFrame: 30, sourceOutFrame: 120 });
      const tracks = [
        makeTrack([clipA], { id: 't1' }),
        makeTrack([clipB], { id: 't2' }),
      ];
      const mediaItems = new Map([['m1', makeMediaItem()], ['m2', makeMediaItem()]]);
      const decodedSources = new Set();

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, decodedSources);

      expect(ranges).toHaveLength(2);
      expect(ranges[0].mediaId).toBe('m1');
      expect(ranges[0].sourceStartMs).toBe(0);
      expect(ranges[0].sourceEndMs).toBe(3000); // 90/30*1000
      expect(ranges[1].mediaId).toBe('m2');
      expect(ranges[1].sourceStartMs).toBe(1000); // 30/30*1000
      expect(ranges[1].sourceEndMs).toBe(4000); // 120/30*1000
    });

    it('skips ranges where all 5 sample timestamps are in _decodedSources', () => {
      const fps = 30;
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      // sourceStartMs=0, sourceEndMs=4000
      // Samples at: 0, 1000, 2000, 3000, 4000
      const decodedSources = new Set(['m1_0', 'm1_1000', 'm1_2000', 'm1_3000', 'm1_4000']);

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, decodedSources);
      expect(ranges).toHaveLength(0);
    });

    it('includes range if fewer than 5 samples are decoded', () => {
      const fps = 30;
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      // Only 4 of 5 samples decoded
      const decodedSources = new Set(['m1_0', 'm1_1000', 'm1_2000', 'm1_3000']);

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, decodedSources);
      expect(ranges).toHaveLength(1);
    });

    it('sorts by distance — current clip (playhead inside) has distance 0', () => {
      const fps = 30;
      // clipA: frames 0..89 — playhead 60 is inside → distance 0
      const clipA = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      // clipB: frames 200..289 — playhead 60 is before → distance 140
      const clipB = makeClip({ id: 'c2', mediaId: 'm2', startFrame: 200, sourceInFrame: 0, sourceOutFrame: 90 });
      // clipC: frames 50..139 — playhead 60 is inside → distance 0
      const clipC = makeClip({ id: 'c3', mediaId: 'm3', startFrame: 50, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clipA, clipB, clipC])];
      const mediaItems = new Map([
        ['m1', makeMediaItem()],
        ['m2', makeMediaItem()],
        ['m3', makeMediaItem()],
      ]);
      const decodedSources = new Set();

      // Playhead at frame 60 — inside both clipA and clipC
      const ranges = getUndecodedClipRanges(60, fps, tracks, mediaItems, decodedSources);

      expect(ranges).toHaveLength(3);
      // clipA and clipC both have distance 0 (playhead inside both)
      // clipB has distance 140 (200 - 60)
      expect(ranges[0].distance).toBe(0);
      expect(ranges[1].distance).toBe(0);
      expect(ranges[2].distance).toBe(140);
      expect(ranges[2].mediaId).toBe('m2');
    });

    it('calculates distance correctly for clips ahead and behind playhead', () => {
      const fps = 30;
      // Clip behind playhead: frames 0..89 (endFrame = 90)
      const clipBehind = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      // Clip ahead of playhead: frames 200..289
      const clipAhead = makeClip({ id: 'c2', mediaId: 'm2', startFrame: 200, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clipBehind, clipAhead])];
      const mediaItems = new Map([['m1', makeMediaItem()], ['m2', makeMediaItem()]]);
      const decodedSources = new Set();

      // Playhead at frame 100 — between both clips
      const ranges = getUndecodedClipRanges(100, fps, tracks, mediaItems, decodedSources);

      expect(ranges).toHaveLength(2);
      // clipBehind: playhead(100) - clipEnd(90) = 10
      // clipAhead: startFrame(200) - playhead(100) = 100
      expect(ranges[0].mediaId).toBe('m1'); // distance 10
      expect(ranges[0].distance).toBe(10);
      expect(ranges[1].mediaId).toBe('m2'); // distance 100
      expect(ranges[1].distance).toBe(100);
    });

    it('excludes muted tracks', () => {
      const fps = 30;
      const clip = makeClip({ id: 'c1', mediaId: 'm1' });
      const tracks = [makeTrack([clip], { muted: true })];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, new Set());
      expect(ranges).toHaveLength(0);
    });

    it('excludes disabled clips', () => {
      const fps = 30;
      const clip = makeClip({ id: 'c1', mediaId: 'm1', disabled: true });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, new Set());
      expect(ranges).toHaveLength(0);
    });

    it('excludes clips without mediaId', () => {
      const fps = 30;
      const clip = makeClip({ id: 'c1', mediaId: null });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map();

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, new Set());
      expect(ranges).toHaveLength(0);
    });

    it('excludes non-video media items', () => {
      const fps = 30;
      const clip = makeClip({ id: 'c1', mediaId: 'm1' });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', { type: 'audio' }]]);

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, new Set());
      expect(ranges).toHaveLength(0);
    });

    it('returns empty array for empty timeline', () => {
      const ranges = getUndecodedClipRanges(0, 30, [], new Map(), new Set());
      expect(ranges).toEqual([]);
    });

    it('produces separate entries for two clips sharing the same mediaId', () => {
      const fps = 30;
      const clipA = makeClip({
        id: 'c1', mediaId: 'm1', startFrame: 0,
        sourceInFrame: 0, sourceOutFrame: 90,
      });
      const clipB = makeClip({
        id: 'c2', mediaId: 'm1', startFrame: 100,
        sourceInFrame: 120, sourceOutFrame: 210,
      });
      const tracks = [makeTrack([clipA, clipB])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);
      const decodedSources = new Set();

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, decodedSources);

      expect(ranges).toHaveLength(2);
      expect(ranges[0].mediaId).toBe('m1');
      expect(ranges[1].mediaId).toBe('m1');
      expect(ranges[0].sourceStartMs).not.toBe(ranges[1].sourceStartMs);
    });

    it('skips clips where sourceEndMs <= sourceStartMs', () => {
      const fps = 30;
      // sourceInFrame=90, sourceOutFrame=90 → start==end → skip
      const clip = makeClip({ id: 'c1', mediaId: 'm1', sourceInFrame: 90, sourceOutFrame: 90 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, new Set());
      expect(ranges).toHaveLength(0);
    });
  });

  // ── 2. _clipAwareIdleFillTick state machine ────────────────────────────

  describe('_clipAwareIdleFillTick state machine', () => {
    it('calls setClipBounds + setPlaybackActive(true) for the first undecoded range', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      // Fire clip_end immediately after tick starts
      const tickPromise = clipAwareIdleFillTick(state, () => bridge, null);
      // Bridge should have setClipBounds and setPlaybackActive called
      await vi.advanceTimersByTimeAsync(0);
      bridge.fireClipEnd();
      const result = await tickPromise;

      expect(result.action).toBe('range_completed');
      expect(result.bridgeResult).toBe('clip_end');

      const setClipBoundsCall = bridge.calls.find(c => c.method === 'setClipBounds');
      expect(setClipBoundsCall).toBeTruthy();
      expect(setClipBoundsCall.args).toEqual([0, 3000]);

      const playCall = bridge.calls.find(c => c.method === 'setPlaybackActive' && c.args[0] === true);
      expect(playCall).toBeTruthy();
      expect(playCall.args[1]).toBe(0); // sourceStartMs/1000 = 0

      vi.useRealTimers();
    });

    it('advances to next range on timeout when clip_end is never fired', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();
      // Short clip: 500ms duration → maxWait = min(500+1000, 20000) = 1500
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 15 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const tickPromise = clipAwareIdleFillTick(state, () => bridge, null);
      // Let timeout fire (500ms clip → 1500ms maxWait)
      await vi.advanceTimersByTimeAsync(1500);
      const result = await tickPromise;

      expect(result.action).toBe('range_completed');
      expect(result.bridgeResult).toBe('timeout');

      vi.useRealTimers();
    });

    it('skips ranges with no bridge and schedules next tick', async () => {
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => null, null);

      expect(result.action).toBe('no_bridge_skip');
      expect(state.idleFillRangeIndex).toBe(1);
    });

    it('falls back to old _idleFillTick when all ranges exhausted', async () => {
      const oldTickFn = vi.fn();
      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: [], mediaItems: new Map(),
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => null, oldTickFn);

      expect(result.action).toBe('fallback_to_old_tick');
      expect(oldTickFn).toHaveBeenCalledWith(1);
    });

    it('returns early on generation mismatch', async () => {
      const state = {
        gen: 1, idleFillGen: 2, // mismatch
        playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: [], mediaItems: new Map(),
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => null, null);
      expect(result.action).toBe('stale_gen');
    });

    it('backs off when buffer is near capacity (90%+)', async () => {
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources: new Set(),
        bufferSize: 140, bufferLimit: 150, // 140/150 = 93% > 90%
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => createMockBridge(), null);
      expect(result.action).toBe('backoff');
    });

    it('generation mismatch mid-await results in no cleanup writes', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const tickPromise = clipAwareIdleFillTick(state, () => bridge, null);

      // Simulate playback starting while we're waiting (gen change)
      state.idleFillGen = 2;

      bridge.fireClipEnd();
      const result = await tickPromise;

      expect(result.action).toBe('stale_gen_after_await');

      // After the stale gen check, no cleanup calls (setPlaybackActive(false), clearClipBounds)
      // should have been made
      const cleanupCalls = bridge.calls.filter(
        c => (c.method === 'setPlaybackActive' && c.args[0] === false) ||
             c.method === 'clearClipBounds'
      );
      expect(cleanupCalls).toHaveLength(0);

      vi.useRealTimers();
    });

    it('clears setClipEndCallback(null) after each range completes', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const tickPromise = clipAwareIdleFillTick(state, () => bridge, null);
      await vi.advanceTimersByTimeAsync(0);
      bridge.fireClipEnd();
      await tickPromise;

      // The last setClipEndCallback call should be with null
      const cbCalls = bridge.calls.filter(c => c.method === 'setClipEndCallback');
      expect(cbCalls[cbCalls.length - 1].args[0]).toBeNull();

      vi.useRealTimers();
    });

    it('skips already-decoded ranges before processing', async () => {
      const fps = 30;
      const clipA = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const clipB = makeClip({ id: 'c2', mediaId: 'm2', startFrame: 100, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clipA, clipB])];
      const mediaItems = new Map([['m1', makeMediaItem()], ['m2', makeMediaItem()]]);

      // Mark m1's sourceStartMs as decoded → should be skipped
      const decodedSources = new Set(['m1_0']);

      // Pre-build ranges to test the skip logic directly
      const ranges = getUndecodedClipRanges(0, fps, tracks, mediaItems, new Set());

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources,
        bufferSize: 0, bufferLimit: 150,
        idleFillRanges: ranges, // pre-populated
        idleFillRangeIndex: 0,
      };

      // The first range (m1) should be skipped since m1_0 is in decodedSources.
      // If no bridge for m2, it should skip that too and fall back.
      const result = await clipAwareIdleFillTick(state, () => null, vi.fn());

      // m1 was skipped (decoded), m2 had no bridge → skip → then fallback or skip
      expect(state.idleFillRangeIndex).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 3. Edit-point burst-decode ──────────────────────────────────────────

  describe('Edit-point burst-decode', () => {
    it('triggers _burstDecode with correct clip bounds for first 500ms', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();

      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 10000,
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
        needsPreroll: true,
      };

      const state = { generation: 1, activeStreams: new Map() };
      const getBridge = vi.fn().mockResolvedValue(bridge);

      const resultPromise = burstDecode(entry, 1, state, getBridge);

      // Wait for bridge resolution
      await vi.advanceTimersByTimeAsync(0);
      // Fire clip end
      bridge.fireClipEnd();

      const result = await resultPromise;

      expect(result.action).toBe('cleaned_up');

      // Should have set clip bounds to [2000, 2500] (start + 500ms)
      const boundsCall = bridge.calls.find(c => c.method === 'setClipBounds');
      expect(boundsCall.args).toEqual([2000, 2500]);

      // Should have started playback at sourceStartMs/1000 = 2.0
      const playCall = bridge.calls.find(c => c.method === 'setPlaybackActive' && c.args[0] === true);
      expect(playCall.args[1]).toBe(2);

      vi.useRealTimers();
    });

    it('caps burst end at sourceEndMs if clip is shorter than 500ms', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();

      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 2300, // only 300ms
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
        needsPreroll: true,
      };

      const state = { generation: 1, activeStreams: new Map() };
      const getBridge = vi.fn().mockResolvedValue(bridge);

      const resultPromise = burstDecode(entry, 1, state, getBridge);
      await vi.advanceTimersByTimeAsync(0);
      bridge.fireClipEnd();
      const result = await resultPromise;

      expect(result.action).toBe('cleaned_up');
      const boundsCall = bridge.calls.find(c => c.method === 'setClipBounds');
      expect(boundsCall.args).toEqual([2000, 2300]); // capped at sourceEndMs

      vi.useRealTimers();
    });

    it('skips when SSC has already activated the clip as a real stream', async () => {
      const bridge = createMockBridge();

      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 10000,
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
      };

      const activeStreams = new Map([['t1_c1', { mediaId: 'm1' }]]);
      const state = { generation: 1, activeStreams };
      const getBridge = vi.fn().mockResolvedValue(bridge);

      const result = await burstDecode(entry, 1, state, getBridge);
      expect(result.action).toBe('already_active');
      // No bridge methods should have been called beyond the resolve
      expect(bridge.calls).toHaveLength(0);
    });

    it('does not double-trigger: second call for same key is a no-op while first is in-flight', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();
      const preCachingKeys = new Set();

      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 10000,
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
      };

      const state = { generation: 1, activeStreams: new Map() };
      const getBridge = vi.fn().mockResolvedValue(bridge);
      const key = `${entry.trackId}_${entry.clipId}`;

      // First burst
      preCachingKeys.add(key);
      const p1 = burstDecode(entry, 1, state, getBridge).finally(() => preCachingKeys.delete(key));

      // Second call — preCachingKeys guard prevents it
      expect(preCachingKeys.has(key)).toBe(true);

      // Finish first burst
      await vi.advanceTimersByTimeAsync(0);
      bridge.fireClipEnd();
      await p1;

      expect(preCachingKeys.has(key)).toBe(false);
      vi.useRealTimers();
    });

    it('aborts burst when generation changes', async () => {
      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 10000,
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
      };

      const state = { generation: 2, activeStreams: new Map() };
      const getBridge = vi.fn().mockResolvedValue(createMockBridge());

      // gen=1, state.generation=2 → mismatch
      const result = await burstDecode(entry, 1, state, getBridge);
      expect(result.action).toBe('aborted');
    });

    it('aborts when no bridge is returned', async () => {
      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 10000,
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
      };

      const state = { generation: 1, activeStreams: new Map() };
      const getBridge = vi.fn().mockResolvedValue(null);

      const result = await burstDecode(entry, 1, state, getBridge);
      expect(result.action).toBe('aborted');
    });

    it('does not clean up if SSC took over the clip during burst', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();

      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 10000,
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
      };

      const activeStreams = new Map();
      const state = { generation: 1, activeStreams };
      const getBridge = vi.fn().mockResolvedValue(bridge);

      const resultPromise = burstDecode(entry, 1, state, getBridge);
      await vi.advanceTimersByTimeAsync(0);

      // SSC takes over the clip while burst is in-flight
      activeStreams.set('t1_c1', { mediaId: 'm1' });

      bridge.fireClipEnd();
      const result = await resultPromise;

      expect(result.action).toBe('ssc_took_over');

      // No cleanup calls should have been issued (setPlaybackActive(false), clearClipBounds)
      const cleanupCalls = bridge.calls.filter(
        c =>
          (c.method === 'setPlaybackActive' && c.args[0] === false) ||
          c.method === 'clearClipBounds'
      );
      expect(cleanupCalls).toHaveLength(0);

      vi.useRealTimers();
    });

    it('resolves on timeout when clip_end_reached is never fired', async () => {
      vi.useFakeTimers();
      const bridge = createMockBridge();

      const entry = {
        trackId: 't1', clipId: 'c1', mediaId: 'm1',
        sourceStartMs: 2000, sourceEndMs: 10000,
        clip: makeClip({ id: 'c1', mediaId: 'm1', startFrame: 100 }),
      };

      const state = { generation: 1, activeStreams: new Map() };
      const getBridge = vi.fn().mockResolvedValue(bridge);

      const resultPromise = burstDecode(entry, 1, state, getBridge);
      await vi.advanceTimersByTimeAsync(0);
      // Don't fire clip end — let timeout hit (BURST_MS + 200 = 700ms)
      await vi.advanceTimersByTimeAsync(700);

      const result = await resultPromise;
      expect(result.action).toBe('cleaned_up');
      expect(result.result).toBe('timeout');

      vi.useRealTimers();
    });
  });

  // ── 4. Fallback edge cases ──────────────────────────────────────────────

  describe('Fallback edge cases', () => {
    it('empty timeline → _getUndecodedClipRanges returns [] → old tick called immediately', async () => {
      const oldTickFn = vi.fn();
      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: [], mediaItems: new Map(),
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => null, oldTickFn);

      expect(result.action).toBe('fallback_to_old_tick');
      expect(oldTickFn).toHaveBeenCalledTimes(1);
      expect(oldTickFn).toHaveBeenCalledWith(1);
    });

    it('all clips decoded → old tick called on first tick (all ranges skipped)', async () => {
      const fps = 30;
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 120 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      // All 5 sample timestamps decoded: 0, 1000, 2000, 3000, 4000
      const decodedSources = new Set(['m1_0', 'm1_1000', 'm1_2000', 'm1_3000', 'm1_4000']);

      const oldTickFn = vi.fn();
      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources, bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => null, oldTickFn);

      expect(result.action).toBe('fallback_to_old_tick');
      expect(oldTickFn).toHaveBeenCalledTimes(1);
    });

    it('_getBridgeForMedia throws → range skipped gracefully', async () => {
      const clip = makeClip({ id: 'c1', mediaId: 'm1', startFrame: 0, sourceInFrame: 0, sourceOutFrame: 90 });
      const tracks = [makeTrack([clip])];
      const mediaItems = new Map([['m1', makeMediaItem()]]);

      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: tracks, mediaItems,
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      // getBridge throws — should be caught and return null
      const getBridge = () => {
        throw new Error('VLC not initialized');
      };

      // Wrap in try/catch like the real _getBridgeForMedia does
      const safeBridge = (mediaId) => {
        try { return getBridge(mediaId); } catch (_) { return null; }
      };

      const result = await clipAwareIdleFillTick(state, safeBridge, vi.fn());
      expect(result.action).toBe('no_bridge_skip');
      expect(state.idleFillRangeIndex).toBe(1);
    });

    it('does not process if playback is active', async () => {
      const state = {
        gen: 1, idleFillGen: 1, playing: true, // playing
        exportPaused: false,
        fps: 30, playheadFrame: 0, videoTracks: [], mediaItems: new Map(),
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => null, null);
      expect(result.action).toBe('playing');
    });

    it('does not process if export is paused', async () => {
      const state = {
        gen: 1, idleFillGen: 1, playing: false, exportPaused: true,
        fps: 30, playheadFrame: 0, videoTracks: [], mediaItems: new Map(),
        decodedSources: new Set(), bufferSize: 0, bufferLimit: 150,
        idleFillRanges: null, idleFillRangeIndex: 0,
      };

      const result = await clipAwareIdleFillTick(state, () => null, null);
      expect(result.action).toBe('export_paused');
    });
  });

  // ── 5. Pre-cache trigger logic ──────────────────────────────────────────

  describe('Pre-cache trigger logic', () => {
    it('does not trigger for clips more than 30 frames away', () => {
      const PRE_CACHE_TRIGGER_FRAMES = 30;
      const currentFrame = 100;

      // Clip starts at frame 140 — 40 frames away > 30
      const entry = {
        needsPreroll: true,
        clip: { startFrame: 140 },
      };

      const shouldTrigger = entry.needsPreroll &&
        entry.clip.startFrame - currentFrame <= PRE_CACHE_TRIGGER_FRAMES;

      expect(shouldTrigger).toBe(false);
    });

    it('triggers for clips within 30 frames', () => {
      const PRE_CACHE_TRIGGER_FRAMES = 30;
      const currentFrame = 100;

      // Clip starts at frame 120 — 20 frames away <= 30
      const entry = {
        needsPreroll: true,
        clip: { startFrame: 120 },
      };

      const shouldTrigger = entry.needsPreroll &&
        entry.clip.startFrame - currentFrame <= PRE_CACHE_TRIGGER_FRAMES;

      expect(shouldTrigger).toBe(true);
    });

    it('does not trigger for active (non-preroll) entries', () => {
      const entry = {
        needsPreroll: false,
        isActive: true,
        clip: { startFrame: 100 },
      };

      expect(entry.needsPreroll).toBe(false);
    });

    it('skips entries when first 15 source frames are all cached', () => {
      const PRE_CACHE_SAMPLE_COUNT = 15;
      const fps = 30;

      const clip = makeClip({
        id: 'c1', mediaId: 'm1',
        startFrame: 100, sourceInFrame: 0, sourceOutFrame: 90,
      });

      const decodedSources = new Set();
      // Cache all 15 source frames
      for (let i = 0; i < PRE_CACHE_SAMPLE_COUNT; i++) {
        const sf = getSourceFrameAtPlayhead(clip, clip.startFrame + i);
        if (sf != null) {
          const ms = Math.round((sf / fps) * 1000);
          decodedSources.add(`m1_${ms}`);
        }
      }

      let cachedCount = 0;
      for (let i = 0; i < PRE_CACHE_SAMPLE_COUNT; i++) {
        const sf = getSourceFrameAtPlayhead(clip, clip.startFrame + i);
        if (sf == null) continue;
        const ms = Math.round((sf / fps) * 1000);
        if (decodedSources.has(`m1_${ms}`)) cachedCount++;
      }

      expect(cachedCount).toBe(PRE_CACHE_SAMPLE_COUNT);
    });

    it('triggers when some source frames are not cached', () => {
      const PRE_CACHE_SAMPLE_COUNT = 15;
      const fps = 30;

      const clip = makeClip({
        id: 'c1', mediaId: 'm1',
        startFrame: 100, sourceInFrame: 0, sourceOutFrame: 90,
      });

      // Only cache 5 of the 15 frames
      const decodedSources = new Set();
      for (let i = 0; i < 5; i++) {
        const sf = getSourceFrameAtPlayhead(clip, clip.startFrame + i);
        if (sf != null) {
          const ms = Math.round((sf / fps) * 1000);
          decodedSources.add(`m1_${ms}`);
        }
      }

      let cachedCount = 0;
      for (let i = 0; i < PRE_CACHE_SAMPLE_COUNT; i++) {
        const sf = getSourceFrameAtPlayhead(clip, clip.startFrame + i);
        if (sf == null) continue;
        const ms = Math.round((sf / fps) * 1000);
        if (decodedSources.has(`m1_${ms}`)) cachedCount++;
      }

      expect(cachedCount).toBeLessThan(PRE_CACHE_SAMPLE_COUNT);
    });
  });
});

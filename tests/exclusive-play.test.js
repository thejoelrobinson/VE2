/**
 * Tests for _exclusivePlay mutual exclusion in VLCWorker.js
 *
 * Validates that only one media instance decodes at a time.
 * VLC's webcodec module delivers frames through a global callback — if multiple
 * _fs_create instances decode simultaneously, frames interleave and requests
 * for the target media time out.
 *
 * _exclusivePlay is called in get_frame, set_playback (playing=true), and
 * start_sequential handlers — but NOT in the seek handler.
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Constants matching VLCWorker ────────────────────────────────────────────
const SEEK_LEAD_MS = 600;

// ── Simulation helpers ─────────────────────────────────────────────────────

/**
 * Create a media entry matching VLCWorker's _media Map values.
 */
function createMediaEntry(id, overrides = {}) {
  return {
    fsHandle: { handle: id },
    slot: 1,
    durationMs: 60000,
    width: 1920,
    height: 1080,
    fps: 24,
    isPlaying: false,
    isSeeking: false,
    atEos: false,
    lastAccessTime: Date.now(),
    lastSeekMs: undefined,
    lastSeekTime: 0,
    lastProducedFrameMs: -1,
    _seekThrottleTimer: null,
    _pendingSeekTarget: undefined,
    clipStartMs: 0,
    clipEndMs: 0,
    boundedMode: false,
    ...overrides,
  };
}

/**
 * Simulate _exclusivePlay from VLCWorker (lines 297-305).
 * Pauses all playing media except the active one.
 * Returns the number of media entries that were paused.
 */
function exclusivePlay(media, activeMediaId, pauseLog = []) {
  for (const [id, m] of media) {
    if (id === activeMediaId) continue;
    if (m.isPlaying) {
      // Simulate _module._fs_pause(m.fsHandle)
      pauseLog.push(id);
      m.isPlaying = false;
    }
  }
  return pauseLog.length;
}

/**
 * Simulate the get_frame handler flow (VLCWorker lines 490-561).
 * Stripped to the relevant _exclusivePlay + seek/play sequence.
 */
function simulateGetFrame(media, mediaId, timeMs, pauseLog = []) {
  const m = media.get(mediaId);
  if (!m) return null;
  m.lastAccessTime = Date.now();

  // Clamp (simplified — no bounded mode in this test)
  const clampedMs = timeMs;

  // Recover from EOS if needed
  if (m.atEos) {
    m.atEos = false;
    m.isPlaying = false;
    m.lastProducedFrameMs = -1;
  }

  // Only one media may decode at a time (global frame callback)
  exclusivePlay(media, mediaId, pauseLog);

  // Seek and play to get the frame
  const seekMs = Math.max(0, clampedMs - SEEK_LEAD_MS);
  m.lastSeekMs = seekMs;
  m.lastSeekTime = Date.now();
  m.isSeeking = true;
  // _module._fs_seek(m.fsHandle, BigInt(seekMs), 1);
  if (!m.isPlaying) {
    // _module._fs_play(m.fsHandle);
    m.isPlaying = true;
  }

  return m;
}

/**
 * Simulate the set_playback handler (VLCWorker lines 573-605).
 */
function simulateSetPlayback(media, mediaId, playing, seekMs, pauseLog = []) {
  const m = media.get(mediaId);
  if (!m) return null;
  m.lastAccessTime = Date.now();

  if (playing) {
    exclusivePlay(media, mediaId, pauseLog);
    if (m.atEos) {
      m.atEos = false;
      m.isPlaying = false;
      m.lastProducedFrameMs = -1;
    }
    const playSeekMs = Math.max(0, seekMs - SEEK_LEAD_MS);
    m.lastSeekMs = playSeekMs;
    m.lastSeekTime = Date.now();
    m.lastProducedFrameMs = -1;
    if (!m.isPlaying) {
      m.isPlaying = true;
    }
  } else {
    // Pause — does NOT call _exclusivePlay
    m.isPlaying = false;
  }

  return m;
}

/**
 * Simulate the seek handler (VLCWorker lines 607-651).
 * NOTE: Does NOT call _exclusivePlay.
 */
function simulateSeek(media, mediaId, rawSeekMs) {
  const m = media.get(mediaId);
  if (!m) return null;
  m.lastAccessTime = Date.now();

  const seekMs = rawSeekMs;
  if (m.atEos) {
    m.atEos = false;
    m.isPlaying = false;
    m.lastProducedFrameMs = -1;
  }

  const seekTarget = Math.max(0, seekMs - SEEK_LEAD_MS);
  m._pendingSeekTarget = seekTarget;
  m.lastSeekMs = seekTarget;
  m.lastSeekTime = Date.now();
  m.lastProducedFrameMs = -1;
  // _module._fs_seek(m.fsHandle, BigInt(seekTarget), 1);
  if (m.isPlaying) {
    // _module._fs_play(m.fsHandle) — deferred _doSeek replays if isPlaying
  }

  return m;
}

/**
 * Simulate the start_sequential handler (VLCWorker lines 696-706).
 */
function simulateStartSequential(media, mediaId, startMs, rate, pauseLog = []) {
  const m = media.get(mediaId);
  if (!m) return null;

  exclusivePlay(media, mediaId, pauseLog);
  // _module._fs_seek(m.fsHandle, BigInt(startMs), 0);
  // _module._fs_set_rate(m.fsHandle, rate || 1.5);
  // _module._fs_play(m.fsHandle);
  m.isPlaying = true;

  return m;
}

/**
 * Simulate deferred _doSeek (VLCWorker lines 244-250).
 * Only calls _fs_play if m.isPlaying is true.
 */
function doSeek(m, seekTarget) {
  m.lastSeekMs = seekTarget;
  m.lastSeekTime = Date.now();
  m.lastProducedFrameMs = -1;
  // _module._fs_seek(m.fsHandle, BigInt(seekTarget), 1);
  const playedAfterSeek = m.isPlaying;
  // if (m.isPlaying) _module._fs_play(m.fsHandle);
  return { playedAfterSeek };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('_exclusivePlay — core mutual exclusion', () => {
  let media;

  beforeEach(() => {
    media = new Map();
  });

  it('pauses all other playing media', () => {
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: false }));
    media.set('C', createMediaEntry('C', { isPlaying: true }));

    const pauseLog = [];
    const pauseCount = exclusivePlay(media, 'B', pauseLog);

    expect(pauseCount).toBe(2);
    expect(pauseLog).toEqual(['A', 'C']);
    expect(media.get('A').isPlaying).toBe(false);
    expect(media.get('B').isPlaying).toBe(false); // B was already paused, unchanged
    expect(media.get('C').isPlaying).toBe(false);
  });

  it('does not modify target media state', () => {
    media.set('A', createMediaEntry('A', { isPlaying: true }));

    const pauseLog = [];
    exclusivePlay(media, 'A', pauseLog);

    // A should remain playing — _exclusivePlay skips the activeMediaId
    expect(media.get('A').isPlaying).toBe(true);
    expect(pauseLog).toEqual([]);
  });

  it('skips already-paused media (no _fs_pause call)', () => {
    media.set('A', createMediaEntry('A', { isPlaying: false }));
    media.set('B', createMediaEntry('B', { isPlaying: false }));
    media.set('C', createMediaEntry('C', { isPlaying: false }));

    const pauseLog = [];
    const pauseCount = exclusivePlay(media, 'C', pauseLog);

    expect(pauseCount).toBe(0);
    expect(pauseLog).toEqual([]);
    expect(media.get('A').isPlaying).toBe(false);
    expect(media.get('B').isPlaying).toBe(false);
  });
});

describe('_exclusivePlay — handler integration', () => {
  let media;

  beforeEach(() => {
    media = new Map();
  });

  it('get_frame handler calls _exclusivePlay before seek/play', () => {
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: false }));

    const pauseLog = [];
    simulateGetFrame(media, 'B', 5000, pauseLog);

    // A should have been paused before B started playing
    expect(pauseLog).toEqual(['A']);
    expect(media.get('A').isPlaying).toBe(false);
    expect(media.get('B').isPlaying).toBe(true);
  });

  it('set_playback handler calls _exclusivePlay when starting playback', () => {
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: false }));

    const pauseLog = [];
    simulateSetPlayback(media, 'B', true, 5000, pauseLog);

    expect(pauseLog).toEqual(['A']);
    expect(media.get('A').isPlaying).toBe(false);
    expect(media.get('B').isPlaying).toBe(true);
  });

  it('set_playback handler does NOT call _exclusivePlay when pausing', () => {
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: true }));

    // Pause media A — should NOT affect B
    const pauseLog = [];
    simulateSetPlayback(media, 'A', false, 0, pauseLog);

    // No _exclusivePlay call during pause
    expect(pauseLog).toEqual([]);
    // A is paused by the handler directly, B is untouched
    expect(media.get('A').isPlaying).toBe(false);
    expect(media.get('B').isPlaying).toBe(true);
  });

  it('seek handler does NOT call _exclusivePlay', () => {
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: true }));

    // Seek on media A — the seek handler does NOT call _exclusivePlay
    simulateSeek(media, 'A', 10000);

    // B should still be playing — seek does not pause other media
    expect(media.get('B').isPlaying).toBe(true);
  });

  it('start_sequential handler calls _exclusivePlay', () => {
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: false }));

    const pauseLog = [];
    simulateStartSequential(media, 'B', 0, 1.5, pauseLog);

    expect(pauseLog).toEqual(['A']);
    expect(media.get('A').isPlaying).toBe(false);
    expect(media.get('B').isPlaying).toBe(true);
  });
});

describe('_exclusivePlay — deferred _doSeek interaction', () => {
  it('deferred _doSeek after _exclusivePlay does not restart paused media', () => {
    const media = new Map();
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: false }));

    // A has a pending seek target (simulating the throttle timer scenario)
    const mA = media.get('A');
    mA._pendingSeekTarget = 5000;

    // _exclusivePlay for B pauses A
    const pauseLog = [];
    exclusivePlay(media, 'B', pauseLog);

    expect(pauseLog).toEqual(['A']);
    expect(mA.isPlaying).toBe(false);

    // Deferred _doSeek fires for A — since isPlaying is false, it should NOT
    // call _fs_play (the production code: if (m.isPlaying) _module._fs_play(...))
    const result = doSeek(mA, mA._pendingSeekTarget);

    expect(result.playedAfterSeek).toBe(false);
    expect(mA.isPlaying).toBe(false);
  });
});

describe('_exclusivePlay — edge cases', () => {
  it('handles empty media map gracefully', () => {
    const media = new Map();
    const pauseLog = [];
    const pauseCount = exclusivePlay(media, 'A', pauseLog);

    expect(pauseCount).toBe(0);
    expect(pauseLog).toEqual([]);
  });

  it('handles single media entry (only the active one)', () => {
    const media = new Map();
    media.set('A', createMediaEntry('A', { isPlaying: true }));

    const pauseLog = [];
    exclusivePlay(media, 'A', pauseLog);

    expect(pauseLog).toEqual([]);
    expect(media.get('A').isPlaying).toBe(true);
  });

  it('pauses many concurrent playing media', () => {
    const media = new Map();
    const ids = ['A', 'B', 'C', 'D', 'E'];
    for (const id of ids) {
      media.set(id, createMediaEntry(id, { isPlaying: true }));
    }

    const pauseLog = [];
    exclusivePlay(media, 'C', pauseLog);

    // All except C should be paused
    expect(pauseLog).toEqual(['A', 'B', 'D', 'E']);
    for (const id of ids) {
      expect(media.get(id).isPlaying).toBe(id === 'C');
    }
  });

  it('get_frame for non-existent media returns null without affecting others', () => {
    const media = new Map();
    media.set('A', createMediaEntry('A', { isPlaying: true }));

    const pauseLog = [];
    const result = simulateGetFrame(media, 'Z', 5000, pauseLog);

    expect(result).toBeNull();
    // A should be untouched
    expect(pauseLog).toEqual([]);
    expect(media.get('A').isPlaying).toBe(true);
  });

  it('consecutive _exclusivePlay calls are idempotent', () => {
    const media = new Map();
    media.set('A', createMediaEntry('A', { isPlaying: true }));
    media.set('B', createMediaEntry('B', { isPlaying: true }));
    media.set('C', createMediaEntry('C', { isPlaying: false }));

    // First call pauses A and B
    const log1 = [];
    exclusivePlay(media, 'C', log1);
    expect(log1).toEqual(['A', 'B']);

    // Second call for same target — nothing left to pause
    const log2 = [];
    exclusivePlay(media, 'C', log2);
    expect(log2).toEqual([]);
  });
});

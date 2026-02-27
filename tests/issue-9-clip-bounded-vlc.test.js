/**
 * Issue #9 — Clip-Bounded VLC Playback
 *
 * After this issue is resolved:
 * - VLCWorker supports per-media clipStartMs/clipEndMs/boundedMode fields
 * - Duration throttle uses clip bounds (0ms margin) when bounded, media end (0ms) otherwise
 * - Seek clamping respects clip bounds (0ms margin bounded, 0ms unbounded)
 * - clip_end_reached message emitted when clip end < media end
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect } from 'vitest';

// ── Constants matching VLCWorker ────────────────────────────────────────────
const CLIP_SEEK_MARGIN_MS = 0;    // bounded seek clamp (no margin needed with cancel-main-loop)
const DEFAULT_SEEK_MARGIN_MS = 0;  // unbounded seek clamp (0ms — _fs_guard_eos handles EOS at C level)
const MIN_CLIP_LENGTH_MS = 50;     // set_clip_bounds rejection threshold

// ── Simulation helpers ──────────────────────────────────────────────────────

function createMediaEntry(durationMs, overrides = {}) {
  return {
    fsHandle: { handle: 1 },
    slot: 1,
    durationMs,
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
 * Simulates the duration throttle logic from _vlcOnDecoderFrame.
 * Returns { paused, clipEndReached } to reflect what VLCWorker would do.
 */
function durationThrottle(frameMs, m) {
  if (!m.isPlaying || m.durationMs <= 0) return { paused: false, clipEndReached: false };
  const effectiveEnd = m.boundedMode
    ? Math.min(m.clipEndMs, m.durationMs)
    : m.durationMs;
  const margin = 0; // _fs_guard_eos handles EOS at C level; no JS margin needed
  if (frameMs >= effectiveEnd - margin) {
    m.isPlaying = false;
    const clipEndReached = m.boundedMode && effectiveEnd < m.durationMs;
    return { paused: true, clipEndReached };
  }
  return { paused: false, clipEndReached: false };
}

/**
 * Simulates seek clamping used in get_frame, set_playback, and seek cases.
 */
function clampSeek(timeMs, m) {
  if (m.boundedMode) {
    return Math.max(m.clipStartMs, Math.min(timeMs, m.clipEndMs - CLIP_SEEK_MARGIN_MS));
  } else if (m.durationMs > 0 && timeMs >= m.durationMs) {
    return Math.max(0, m.durationMs - DEFAULT_SEEK_MARGIN_MS);
  }
  return timeMs;
}

/**
 * Simulates set_clip_bounds message handler.
 * Returns false if the clip is rejected (too short).
 */
function setClipBounds(m, startMs, endMs) {
  const clampedStart = Math.max(0, startMs);
  const clampedEnd = (m.durationMs > 0) ? Math.min(endMs, m.durationMs) : endMs;
  if (clampedEnd - clampedStart < MIN_CLIP_LENGTH_MS) return false;
  m.clipStartMs = clampedStart;
  m.clipEndMs = clampedEnd;
  m.boundedMode = true;
  return true;
}

/**
 * Simulates clear_clip_bounds message handler.
 */
function clearClipBounds(m) {
  m.clipStartMs = 0;
  m.clipEndMs = 0;
  m.boundedMode = false;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #9 — Clip-Bounded VLC Playback', () => {

  describe('Clip-bounded duration throttle', () => {
    it('fires at clipEndMs when boundedMode is true (0ms margin)', () => {
      const m = createMediaEntry(60000, {
        isPlaying: true,
        boundedMode: true,
        clipStartMs: 10000,
        clipEndMs: 15000,
      });

      // Just before clipEnd — should NOT fire
      const r1 = durationThrottle(14999, m);
      expect(r1.paused).toBe(false);
      expect(m.isPlaying).toBe(true);

      // At exactly clipEnd — should fire
      const r2 = durationThrottle(15000, m);
      expect(r2.paused).toBe(true);
      expect(r2.clipEndReached).toBe(true);
      expect(m.isPlaying).toBe(false);
    });

    it('fires beyond clipEnd (decoder overshoot)', () => {
      const m = createMediaEntry(60000, {
        isPlaying: true,
        boundedMode: true,
        clipStartMs: 10000,
        clipEndMs: 15000,
      });

      const r = durationThrottle(15100, m);
      expect(r.paused).toBe(true);
      expect(r.clipEndReached).toBe(true);
    });
  });

  describe('Default (unbounded) duration throttle at 0ms', () => {
    it('fires at exactly durationMs when boundedMode is false (0ms margin)', () => {
      const m = createMediaEntry(10000, { isPlaying: true });

      // Just under durationMs — should NOT fire
      const r1 = durationThrottle(9999, m);
      expect(r1.paused).toBe(false);

      // At exactly durationMs — should fire
      const r2 = durationThrottle(10000, m);
      expect(r2.paused).toBe(true);
      expect(r2.clipEndReached).toBe(false);
    });

    it('does not emit clip_end_reached in default mode', () => {
      const m = createMediaEntry(10000, { isPlaying: true });
      const r = durationThrottle(10000, m);
      expect(r.paused).toBe(true);
      expect(r.clipEndReached).toBe(false);
    });
  });

  describe('Seek clamping respects clip bounds', () => {
    it('clamps high seek to clipEndMs (0ms margin)', () => {
      const m = createMediaEntry(60000, {
        boundedMode: true,
        clipStartMs: 10000,
        clipEndMs: 15000,
      });

      // Request way past clip end
      expect(clampSeek(20000, m)).toBe(15000); // 15000 - 0
      // Request at clip end
      expect(clampSeek(15000, m)).toBe(15000);
    });

    it('clamps low seek to clipStartMs', () => {
      const m = createMediaEntry(60000, {
        boundedMode: true,
        clipStartMs: 10000,
        clipEndMs: 15000,
      });

      // Request before clip start
      expect(clampSeek(-100, m)).toBe(10000);
      expect(clampSeek(0, m)).toBe(10000);
      expect(clampSeek(5000, m)).toBe(10000);
    });

    it('passes through seeks within clip bounds', () => {
      const m = createMediaEntry(60000, {
        boundedMode: true,
        clipStartMs: 10000,
        clipEndMs: 15000,
      });

      expect(clampSeek(12000, m)).toBe(12000);
      expect(clampSeek(10000, m)).toBe(10000);
      expect(clampSeek(14800, m)).toBe(14800);
      expect(clampSeek(15000, m)).toBe(15000); // at clipEnd with 0 margin
    });

    it('uses default 0ms clamp when unbounded', () => {
      const m = createMediaEntry(10000);
      expect(clampSeek(10000, m)).toBe(10000);
      expect(clampSeek(12000, m)).toBe(10000);
      expect(clampSeek(5000, m)).toBe(5000);
    });
  });

  describe('set_clip_bounds / clear_clip_bounds round-trip', () => {
    it('sets bounds and activates bounded mode', () => {
      const m = createMediaEntry(60000);

      expect(m.boundedMode).toBe(false);
      expect(m.clipStartMs).toBe(0);
      expect(m.clipEndMs).toBe(0);

      setClipBounds(m, 10000, 15000);

      expect(m.boundedMode).toBe(true);
      expect(m.clipStartMs).toBe(10000);
      expect(m.clipEndMs).toBe(15000);
    });

    it('clears bounds and deactivates bounded mode', () => {
      const m = createMediaEntry(60000);
      setClipBounds(m, 10000, 15000);

      clearClipBounds(m);

      expect(m.boundedMode).toBe(false);
      expect(m.clipStartMs).toBe(0);
      expect(m.clipEndMs).toBe(0);
    });

    it('clamps endMs to durationMs when duration is known', () => {
      const m = createMediaEntry(60000);
      setClipBounds(m, 10000, 90000); // endMs > durationMs
      expect(m.clipEndMs).toBe(60000);
    });

    it('clamps startMs to 0 for negative values', () => {
      const m = createMediaEntry(60000);
      setClipBounds(m, -500, 15000);
      expect(m.clipStartMs).toBe(0);
    });
  });

  describe('clip_end_reached not emitted when clipEnd == durationMs', () => {
    it('does NOT report clip_end_reached when clip spans to media end', () => {
      const m = createMediaEntry(60000, {
        isPlaying: true,
        boundedMode: true,
        clipStartMs: 50000,
        clipEndMs: 60000, // same as durationMs
      });

      const r = durationThrottle(60000, m);
      expect(r.paused).toBe(true);
      // effectiveEnd (60000) is NOT < durationMs (60000), so no clip_end_reached
      expect(r.clipEndReached).toBe(false);
    });

    it('DOES report clip_end_reached when clip ends before media end', () => {
      const m = createMediaEntry(60000, {
        isPlaying: true,
        boundedMode: true,
        clipStartMs: 10000,
        clipEndMs: 15000,
      });

      const r = durationThrottle(15000, m);
      expect(r.paused).toBe(true);
      expect(r.clipEndReached).toBe(true);
    });
  });

  describe('Bounds update correctly', () => {
    it('second set_clip_bounds overwrites the first', () => {
      const m = createMediaEntry(60000);

      // First bounds: [10000, 15000]
      setClipBounds(m, 10000, 15000);
      expect(m.clipStartMs).toBe(10000);
      expect(m.clipEndMs).toBe(15000);
      expect(m.boundedMode).toBe(true);

      // Verify throttle uses first bounds (0ms margin: fires at 15000)
      m.isPlaying = true;
      const r1 = durationThrottle(15000, m);
      expect(r1.paused).toBe(true);

      // Update to [30000, 35000]
      m.isPlaying = true;
      setClipBounds(m, 30000, 35000);
      expect(m.clipStartMs).toBe(30000);
      expect(m.clipEndMs).toBe(35000);

      // Old clip end no longer triggers throttle
      const r2 = durationThrottle(14800, m);
      expect(r2.paused).toBe(false);

      // New clip end triggers throttle (0ms margin: fires at 35000)
      const r3 = durationThrottle(35000, m);
      expect(r3.paused).toBe(true);
      expect(r3.clipEndReached).toBe(true);
    });

    it('seek clamping uses updated bounds', () => {
      const m = createMediaEntry(60000);

      setClipBounds(m, 10000, 15000);
      expect(clampSeek(20000, m)).toBe(15000); // clipEnd - 0

      setClipBounds(m, 30000, 35000);
      expect(clampSeek(20000, m)).toBe(30000); // below new clipStart
      expect(clampSeek(40000, m)).toBe(35000); // above new clipEnd - 0
      expect(clampSeek(32000, m)).toBe(32000); // within new bounds
    });
  });

  describe('Sub-50ms clip rejection', () => {
    it('rejects clips shorter than 50ms', () => {
      const m = createMediaEntry(60000);
      const accepted = setClipBounds(m, 10000, 10040); // 40ms < 50ms
      expect(accepted).toBe(false);
      expect(m.boundedMode).toBe(false);
    });

    it('accepts clips exactly 50ms', () => {
      const m = createMediaEntry(60000);
      const accepted = setClipBounds(m, 10000, 10050);
      expect(accepted).toBe(true);
      expect(m.boundedMode).toBe(true);
      expect(m.clipStartMs).toBe(10000);
      expect(m.clipEndMs).toBe(10050);
    });

    it('rejects when clamped range becomes sub-50ms', () => {
      // durationMs = 10040, startMs = 10000 -> clampedEnd = 10040, range = 40ms < 50ms
      const m = createMediaEntry(10040);
      const accepted = setClipBounds(m, 10000, 20000);
      expect(accepted).toBe(false);
      expect(m.boundedMode).toBe(false);
    });
  });

  describe('durationMs == 0 at set_clip_bounds time', () => {
    it('stores raw endMs when durationMs is unknown', () => {
      const m = createMediaEntry(0); // unknown duration
      const accepted = setClipBounds(m, 5000, 15000);
      expect(accepted).toBe(true);
      expect(m.clipEndMs).toBe(15000); // not clamped to 0
      expect(m.clipStartMs).toBe(5000);
    });

    it('seek clamping works with stored bounds even when durationMs is 0', () => {
      const m = createMediaEntry(0);
      setClipBounds(m, 5000, 15000);
      expect(clampSeek(20000, m)).toBe(15000); // clamped to clipEndMs - 0
      expect(clampSeek(3000, m)).toBe(5000);   // clamped to clipStartMs
      expect(clampSeek(10000, m)).toBe(10000); // within bounds
    });
  });

  describe('clear_clip_bounds while paused near clip end', () => {
    it('clearing bounds removes clip-based clamping', () => {
      const m = createMediaEntry(60000, {
        isPlaying: true,
        boundedMode: true,
        clipStartMs: 10000,
        clipEndMs: 15000,
      });

      // Throttle fires at clipEnd (0ms margin), pausing playback
      durationThrottle(15000, m);
      expect(m.isPlaying).toBe(false);

      // Clear bounds
      clearClipBounds(m);
      expect(m.boundedMode).toBe(false);

      // Seek past old clipEnd now uses default media-end clamping
      expect(clampSeek(20000, m)).toBe(20000); // within 60000, passes through
      expect(clampSeek(60000, m)).toBe(60000);  // clamped to durationMs - 0 (0ms margin)
    });
  });
});

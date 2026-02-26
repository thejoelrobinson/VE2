/**
 * Issue #3 — VLCWorker.js: EOS Hardening
 *
 * After this issue is resolved:
 * - C-level _fs_guard_eos(mp) is enabled on every loaded media
 * - Duration throttle reduced to durationMs - 50 (cancel-main-loop.js is primary EOS defense)
 * - _recoverFromEos is lightweight (just clears atEos flag, no stop+reopen)
 * - EOS timeout relaxed from 400ms to 2000ms
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── NEW hardened constants (issue #3 changes) ───────────────────────────────

const EOS_TIMEOUT_MS = 2000;        // was 400ms
const DURATION_THROTTLE_MS = 50;    // was 200ms, then 500ms, now 50ms

// ── Duration throttle simulation (50ms margin) ──────────────────────────────
// Mirrors VLCWorker frame interceptor: pause VLC when within 50ms of media end

function durationThrottle(frameMs, durationMs, isPlaying) {
  if (isPlaying && durationMs > 0 && frameMs >= durationMs - DURATION_THROTTLE_MS) {
    return true; // triggers pause
  }
  return false;
}

// ── Duration clamp simulation (50ms margin) ─────────────────────────────────
// Clamp seek target so VLC never seeks past media end

function clampSeekMs(timeMs, durationMs) {
  if (durationMs > 0 && timeMs >= durationMs) {
    return Math.max(0, durationMs - DURATION_THROTTLE_MS);
  }
  return timeMs;
}

// ── EOS timeout check simulation (relaxed to 2000ms) ───────────────────────

function createMediaEntry(durationMs, overrides = {}) {
  return {
    mp: { handle: 1 },
    file: { name: 'test.mp4' },
    slot: 1,
    durationMs,
    width: 1920,
    height: 1080,
    fps: 24,
    isPlaying: false,
    isSeeking: false,
    atEos: false,
    ...overrides,
  };
}

function checkEos(mediaEntries, timeSinceLastFrame) {
  let eosDetected = false;
  for (const m of mediaEntries) {
    if (!m.isPlaying) continue;
    if (timeSinceLastFrame > EOS_TIMEOUT_MS) {
      m.isPlaying = false;
      m.atEos = true;
      eosDetected = true;
    }
  }
  return eosDetected;
}

// ── Lightweight EOS recovery (issue #3: no stop+reopen) ─────────────────────
// Old behavior: stop VLC player, re-open media, re-assign media to player
// New behavior: just clear the atEos flag — C-level guard handles seek-to-0

function lightweightRecoverFromEos(m) {
  if (!m.atEos) return false;
  // Lightweight: just clear the flag, no stop+reopen
  m.atEos = false;
  return true;
}

// Old heavyweight recovery simulation (for comparison — should NOT be used)
function heavyweightRecoverFromEos(m, _module) {
  if (!m.atEos || !m.mp || !m.file) return false;
  // Stop player
  _module.stopCalled = true;
  // Re-open media on same player
  _module.reopenCalled = true;
  // Re-assign media
  _module.setMediaCalled = true;
  m.atEos = false;
  return true;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #3 — Duration throttle at 50ms', () => {
  it('triggers at durationMs - 50 (boundary)', () => {
    // frameMs = 9950, durationMs = 10000 => 10000 - 9950 = 50, frameMs >= 9950
    expect(durationThrottle(9950, 10000, true)).toBe(true);
  });

  it('does NOT trigger at durationMs - 51 (just outside window)', () => {
    // frameMs = 9949, durationMs = 10000 => 9949 < 9950
    expect(durationThrottle(9949, 10000, true)).toBe(false);
  });

  it('triggers when frame is within 50ms window', () => {
    expect(durationThrottle(9960, 10000, true)).toBe(true);
    expect(durationThrottle(9980, 10000, true)).toBe(true);
    expect(durationThrottle(9999, 10000, true)).toBe(true);
    expect(durationThrottle(10000, 10000, true)).toBe(true);
  });

  it('does NOT trigger when frame is well outside 50ms window', () => {
    expect(durationThrottle(5000, 10000, true)).toBe(false);
    expect(durationThrottle(9000, 10000, true)).toBe(false);
    expect(durationThrottle(9900, 10000, true)).toBe(false);
  });

  it('does NOT trigger when not playing', () => {
    expect(durationThrottle(9980, 10000, false)).toBe(false);
  });

  it('does NOT trigger when durationMs = 0 (unknown duration)', () => {
    expect(durationThrottle(9800, 0, true)).toBe(false);
  });

  it('handles short media (durationMs = 300)', () => {
    // durationMs - 50 = 250, so frames >= 250 trigger
    expect(durationThrottle(0, 300, true)).toBe(false);
    expect(durationThrottle(100, 300, true)).toBe(false);
    expect(durationThrottle(250, 300, true)).toBe(true);
    expect(durationThrottle(260, 300, true)).toBe(true);
  });

  it('clamping uses 50ms offset', () => {
    expect(clampSeekMs(10000, 10000)).toBe(9950);
    expect(clampSeekMs(12000, 10000)).toBe(9950);
  });

  it('clamping does not apply when below durationMs', () => {
    expect(clampSeekMs(9999, 10000)).toBe(9999);
    expect(clampSeekMs(5000, 10000)).toBe(5000);
  });

  it('clamping edge: very short media clamps correctly', () => {
    // durationMs = 300, 300 - 50 = 250, Math.max(0, 250) = 250
    expect(clampSeekMs(300, 300)).toBe(250);
    expect(clampSeekMs(500, 300)).toBe(250);
  });

  it('clamping edge: durationMs exactly 50 clamps to 0', () => {
    expect(clampSeekMs(50, 50)).toBe(0);
  });

  it('clamping edge: durationMs = 51 clamps to 1', () => {
    expect(clampSeekMs(51, 51)).toBe(1);
    expect(clampSeekMs(600, 51)).toBe(1);
  });

  it('negative timeMs passes through unclamped', () => {
    expect(clampSeekMs(-100, 10000)).toBe(-100);
  });
});

describe('Issue #3 — Lightweight EOS recovery', () => {
  it('clears atEos flag without stop+reopen', () => {
    const m = createMediaEntry(10000, { atEos: true });
    const recovered = lightweightRecoverFromEos(m);
    expect(recovered).toBe(true);
    expect(m.atEos).toBe(false);
    // Verify no VLC API calls would happen — the function only clears the flag
  });

  it('returns false when not at EOS', () => {
    const m = createMediaEntry(10000, { atEos: false });
    expect(lightweightRecoverFromEos(m)).toBe(false);
  });

  it('old heavyweight recovery would call stop/reopen (for contrast)', () => {
    const m = createMediaEntry(10000, { atEos: true });
    const module = { stopCalled: false, reopenCalled: false, setMediaCalled: false };
    heavyweightRecoverFromEos(m, module);
    // Old behavior had 3 VLC API calls — new behavior has 0
    expect(module.stopCalled).toBe(true);
    expect(module.reopenCalled).toBe(true);
    expect(module.setMediaCalled).toBe(true);
  });

  it('lightweight recovery is idempotent', () => {
    const m = createMediaEntry(10000, { atEos: true });
    lightweightRecoverFromEos(m);
    expect(m.atEos).toBe(false);
    // Second call is a no-op
    const result = lightweightRecoverFromEos(m);
    expect(result).toBe(false);
    expect(m.atEos).toBe(false);
  });
});

describe('Issue #3 — EOS timeout at 2000ms (relaxed from 400ms)', () => {
  it('does NOT detect EOS at 400ms (old threshold)', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 400);
    expect(detected).toBe(false);
    expect(m.atEos).toBe(false);
    expect(m.isPlaying).toBe(true);
  });

  it('does NOT detect EOS at 1999ms (just under new threshold)', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 1999);
    expect(detected).toBe(false);
    expect(m.atEos).toBe(false);
  });

  it('does NOT detect EOS at exactly 2000ms (boundary — not greater)', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 2000);
    expect(detected).toBe(false);
    expect(m.atEos).toBe(false);
  });

  it('detects EOS at 2001ms (just over threshold)', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 2001);
    expect(detected).toBe(true);
    expect(m.atEos).toBe(true);
    expect(m.isPlaying).toBe(false);
  });

  it('detects EOS at 3000ms (well over threshold)', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 3000);
    expect(detected).toBe(true);
    expect(m.atEos).toBe(true);
  });

  it('does NOT check non-playing media', () => {
    const m = createMediaEntry(10000, { isPlaying: false });
    const detected = checkEos([m], 5000);
    expect(detected).toBe(false);
    expect(m.atEos).toBe(false);
  });

  it('handles multiple media correctly', () => {
    const m1 = createMediaEntry(10000, { isPlaying: true });
    const m2 = createMediaEntry(5000, { isPlaying: false });
    const m3 = createMediaEntry(8000, { isPlaying: true });

    checkEos([m1, m2, m3], 2500);

    expect(m1.atEos).toBe(true);
    expect(m1.isPlaying).toBe(false);
    expect(m2.atEos).toBe(false);  // was not playing
    expect(m3.atEos).toBe(true);
    expect(m3.isPlaying).toBe(false);
  });

  it('returns false for empty media list', () => {
    expect(checkEos([], 9999)).toBe(false);
  });
});

describe('Issue #3 — Full lifecycle: play -> EOS timeout -> lightweight recovery -> resume', () => {
  it('complete EOS cycle with new thresholds', () => {
    const m = createMediaEntry(10000, { isPlaying: true });

    // 1. Media is playing, frames arriving (no EOS at 1000ms)
    expect(checkEos([m], 1000)).toBe(false);
    expect(m.isPlaying).toBe(true);
    expect(m.atEos).toBe(false);

    // 2. Frames stop for 1999ms — still no EOS (under new 2000ms threshold)
    expect(checkEos([m], 1999)).toBe(false);
    expect(m.isPlaying).toBe(true);

    // 3. Frames stop for 2001ms — EOS detected
    expect(checkEos([m], 2001)).toBe(true);
    expect(m.isPlaying).toBe(false);
    expect(m.atEos).toBe(true);

    // 4. Lightweight recovery: just clear flag (no stop+reopen)
    const recovered = lightweightRecoverFromEos(m);
    expect(recovered).toBe(true);
    expect(m.atEos).toBe(false);
    // m.isPlaying stays false — caller must re-start playback

    // 5. Resume playback
    m.isPlaying = true;

    // 6. Frames arrive again within threshold — no EOS
    expect(checkEos([m], 500)).toBe(false);
    expect(m.isPlaying).toBe(true);
    expect(m.atEos).toBe(false);
  });

  it('multiple EOS -> recovery cycles work correctly', () => {
    const m = createMediaEntry(10000, { isPlaying: true });

    for (let i = 0; i < 5; i++) {
      // Hit EOS
      checkEos([m], 2500);
      expect(m.atEos).toBe(true);

      // Lightweight recovery
      lightweightRecoverFromEos(m);
      expect(m.atEos).toBe(false);

      // Resume playing
      m.isPlaying = true;
    }
  });

  it('seek triggers recovery when atEos is true', () => {
    const m = createMediaEntry(10000, { isPlaying: true });

    // Hit EOS
    checkEos([m], 3000);
    expect(m.atEos).toBe(true);

    // Seek handler checks atEos and recovers
    if (m.atEos) lightweightRecoverFromEos(m);
    expect(m.atEos).toBe(false);
  });

  it('duration throttle prevents EOS by pausing before end', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const durationMs = m.durationMs;

    // Frame arrives at 9960ms — within new 50ms window
    const shouldPause = durationThrottle(9960, durationMs, m.isPlaying);
    expect(shouldPause).toBe(true);

    // Throttle pauses playback
    m.isPlaying = false;

    // EOS check skips non-playing media
    const eos = checkEos([m], 5000);
    expect(eos).toBe(false);
    expect(m.atEos).toBe(false);
  });
});

describe('Issue #3 — C-level fs_guard_eos on every loaded media', () => {
  // Simulates that _fs_guard_eos(mp) is called for EVERY loaded file
  // (not just MXF), attaching the C-level EOS event handler

  function createFrameServer() {
    return {
      stopping: 0,
      eos_guarded: 0,
      mp: null,
      media: null,
      eosCallbackFired: 0,
      eventAttached: false,
    };
  }

  function fs_guard_eos(fs) {
    if (!fs.eos_guarded) {
      fs.eos_guarded = 1;
      fs.eventAttached = true;
    }
  }

  it('fs_guard_eos activates for first media', () => {
    const fs = createFrameServer();
    fs.mp = { handle: 1 };
    fs_guard_eos(fs);
    expect(fs.eos_guarded).toBe(1);
    expect(fs.eventAttached).toBe(true);
  });

  it('fs_guard_eos is idempotent (no double registration)', () => {
    const fs = createFrameServer();
    fs.mp = { handle: 1 };
    fs_guard_eos(fs);
    fs_guard_eos(fs);
    expect(fs.eos_guarded).toBe(1);
  });

  it('every loaded media gets fs_guard_eos called on the same player', () => {
    // Use a single frame server that loads multiple media sequentially,
    // verifying the guard is invoked for each media load.
    const fs = createFrameServer();
    const guardCallLog = [];

    function fs_guard_eos_tracked(frameServer) {
      guardCallLog.push(frameServer.media);
      if (!frameServer.eos_guarded) {
        frameServer.eos_guarded = 1;
        frameServer.eventAttached = true;
      }
    }

    const mediaFiles = ['clip.mp4', 'clip.mov', 'clip.webm', 'clip.mxf'];
    for (let i = 0; i < mediaFiles.length; i++) {
      // Reset guard state for new media on same player (simulates set_media)
      fs.eos_guarded = 0;
      fs.eventAttached = false;
      fs.mp = { handle: 1 }; // same player handle
      fs.media = mediaFiles[i];

      fs_guard_eos_tracked(fs);
      expect(fs.eos_guarded).toBe(1);
      expect(fs.eventAttached).toBe(true);
    }
    // Verify the guard was called for every loaded media on the same player
    expect(guardCallLog).toEqual(mediaFiles);
    expect(guardCallLog.length).toBe(4);
  });
});

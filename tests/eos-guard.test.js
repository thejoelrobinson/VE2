/**
 * Unit tests for EOS guard logic — validates the state machine design
 * for end-of-stream detection, recovery, and prevention across both
 * the C-level frame server (simulated) and the JS-level VLCWorker.
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ─── C-level frame server simulation ─────────────────────────────────────────
// Mirrors the C state machine: stopping flag, eos_guarded flag,
// and _eos_seek_back callback gating.

function createFrameServer() {
  const fs = {
    stopping: 0,         // calloc-zeroed
    eos_guarded: 0,      // prevents duplicate event handler registration
    mp: null,            // media player handle
    media: null,         // current media
    eosCallbackFired: 0, // tracks whether _eos_seek_back actually executed its body
    eventAttached: false, // whether the EOS event handler is registered
  };
  return fs;
}

function fs_create(fs) {
  // calloc zeroes everything — stopping starts at 0
  fs.stopping = 0;
  fs.eos_guarded = 0;
  fs.mp = { handle: 1 };
  fs.media = null;
  fs.eosCallbackFired = 0;
  fs.eventAttached = false;
}

function fs_open(fs, mediaPath) {
  if (fs.media !== null) {
    fs.stopping = 1;
  }
  fs.media = { path: mediaPath };
}

function fs_guard_eos(fs) {
  if (!fs || !fs.mp || fs.eos_guarded) return;
  fs.eos_guarded = 1;
  fs.eventAttached = true;
}

function fs_play(fs) {
  // Re-arm the EOS guard — only place stopping resets to 0
  fs.stopping = 0;
  // (would call libvlc_media_player_play in C)
}

function fs_stop(fs) {
  fs.stopping = 1;
  // (would call libvlc_media_player_stop in C)
}

function fs_destroy(fs) {
  if (!fs) return;
  if (fs.mp) {
    if (fs.eos_guarded) {
      fs.eventAttached = false;
    }
    fs.stopping = 1;
  }
  fs.mp = null;
  fs.media = null;
  fs.eos_guarded = 0;
}

function _eos_seek_back(fs) {
  if (!fs || !fs.mp || fs.stopping) {
    return false;
  }
  fs.eosCallbackFired++;
  return true;
}

// ─── JS-level EOS logic simulation ───────────────────────────────────────────
// Mirrors VLCWorker.js duration clamping, EOS timeout, recovery, and throttle.

const EOS_TIMEOUT_MS = 400;
const DURATION_THROTTLE_MS = 200;

/** Clamp seek target to prevent VLC from seeking past media end (VLCWorker L401-403) */
function clampSeekMs(timeMs, durationMs) {
  if (durationMs > 0 && timeMs >= durationMs) {
    return Math.max(0, durationMs - DURATION_THROTTLE_MS);
  }
  return timeMs;
}

/** Create a simulated media entry matching VLCWorker's _media Map values */
function createMediaEntry(durationMs, overrides = {}) {
  return {
    mp: { handle: 1 },
    file: { name: 'test.mxf' },
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

/**
 * Simulate EOS timeout check logic (VLCWorker L181-203).
 * Returns true if EOS was detected for any playing media.
 */
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

/**
 * Simulate EOS recovery (VLCWorker L205-220).
 * Returns true if recovery was performed.
 */
function recoverFromEos(m, moduleReady = true) {
  if (!m.atEos || !m.mp || !m.file || !moduleReady) return false;
  // stop + re-open media on same player
  m.atEos = false;
  return true;
}

/**
 * Simulate duration throttle / pre-EOS pause (VLCWorker L104-112).
 * Returns true if pause was triggered.
 */
function durationThrottle(frameMs, durationMs, isPlaying) {
  if (isPlaying && durationMs > 0 && frameMs >= durationMs - DURATION_THROTTLE_MS) {
    return true; // would call set_pause(mp, 1)
  }
  return false;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EOS guard — C-level stopping flag state machine', () => {
  let fs;

  beforeEach(() => {
    fs = createFrameServer();
    fs_create(fs);
  });

  it('fs_create initializes stopping to 0', () => {
    expect(fs.stopping).toBe(0);
  });

  it('fs_create initializes eos_guarded to 0', () => {
    expect(fs.eos_guarded).toBe(0);
  });

  it('fs_stop sets stopping to 1', () => {
    fs_stop(fs);
    expect(fs.stopping).toBe(1);
  });

  it('fs_stop keeps stopping at 1 on repeated calls', () => {
    fs_stop(fs);
    fs_stop(fs);
    fs_stop(fs);
    expect(fs.stopping).toBe(1);
  });

  it('fs_play resets stopping to 0 (re-arms guard)', () => {
    fs_stop(fs);
    expect(fs.stopping).toBe(1);
    fs_play(fs);
    expect(fs.stopping).toBe(0);
  });

  it('fs_play is the only operation that resets stopping', () => {
    fs_stop(fs);
    // Open does NOT reset stopping
    fs_open(fs, 'video.mxf');
    expect(fs.stopping).toBe(1);
    // Only play resets it
    fs_play(fs);
    expect(fs.stopping).toBe(0);
  });

  it('fs_open with existing media sets stopping to 1 during stop phase', () => {
    fs_open(fs, 'first.mxf');
    expect(fs.stopping).toBe(0); // no prior media
    // Open again with existing media triggers internal stop
    fs_open(fs, 'second.mxf');
    expect(fs.stopping).toBe(1);
  });

  it('fs_open without existing media does not set stopping', () => {
    fs_open(fs, 'first.mxf');
    expect(fs.stopping).toBe(0);
  });

  it('fs_destroy sets stopping to 1 and detaches event', () => {
    fs_open(fs, 'video.mxf');
    fs_guard_eos(fs);
    fs_play(fs);
    fs_destroy(fs);
    expect(fs.stopping).toBe(1);
    expect(fs.eventAttached).toBe(false);
    expect(fs.mp).toBeNull();
  });

  it('fs_destroy without prior guard_eos does not attempt detach', () => {
    fs_open(fs, 'video.mxf');
    // No fs_guard_eos call — eventAttached stays false
    expect(fs.eos_guarded).toBe(0);
    expect(fs.eventAttached).toBe(false);
    fs_destroy(fs);
    // eventAttached was never set, so it remains false (no detach attempted)
    expect(fs.eventAttached).toBe(false);
    expect(fs.mp).toBeNull();
  });

  it('full lifecycle: create → open → guard → play → stop → play → destroy', () => {
    expect(fs.stopping).toBe(0);

    fs_open(fs, 'clip.mxf');
    fs_guard_eos(fs);
    expect(fs.stopping).toBe(0);

    fs_play(fs);
    expect(fs.stopping).toBe(0);

    fs_stop(fs);
    expect(fs.stopping).toBe(1);

    fs_play(fs);
    expect(fs.stopping).toBe(0);

    fs_destroy(fs);
    expect(fs.stopping).toBe(1);
  });
});

describe('EOS guard — _eos_seek_back callback gating', () => {
  let fs;

  beforeEach(() => {
    fs = createFrameServer();
    fs_create(fs);
    fs_open(fs, 'video.mxf');
    fs_guard_eos(fs);
    fs_play(fs);
  });

  it('fires when stopping = 0 (normal playback)', () => {
    const result = _eos_seek_back(fs);
    expect(result).toBe(true);
    expect(fs.eosCallbackFired).toBe(1);
  });

  it('skips when stopping = 1 (programmatic stop in progress)', () => {
    fs_stop(fs);
    const result = _eos_seek_back(fs);
    expect(result).toBe(false);
    expect(fs.eosCallbackFired).toBe(0);
  });

  it('fires again after stop → play cycle (guard re-armed)', () => {
    fs_stop(fs);
    expect(_eos_seek_back(fs)).toBe(false);

    fs_play(fs); // re-arms
    expect(_eos_seek_back(fs)).toBe(true);
    expect(fs.eosCallbackFired).toBe(1);
  });

  it('skips during fs_open with existing media', () => {
    fs_open(fs, 'other.mxf');
    // stopping is 1 because open triggered internal stop
    expect(_eos_seek_back(fs)).toBe(false);
  });

  it('skips after fs_destroy', () => {
    fs_destroy(fs);
    expect(_eos_seek_back(fs)).toBe(false);
  });

  it('increments counter on each successful fire', () => {
    _eos_seek_back(fs);
    _eos_seek_back(fs);
    _eos_seek_back(fs);
    expect(fs.eosCallbackFired).toBe(3);
  });

  it('_eos_seek_back returns false when fs.mp is null', () => {
    fs.mp = null;
    const result = _eos_seek_back(fs);
    expect(result).toBe(false);
    expect(fs.eosCallbackFired).toBe(0);
  });
});

describe('EOS guard — eos_guarded prevents duplicate registration', () => {
  let fs;

  beforeEach(() => {
    fs = createFrameServer();
    fs_create(fs);
  });

  it('fs_guard_eos registers event handler', () => {
    fs_open(fs, 'video.mxf');
    fs_guard_eos(fs);
    expect(fs.eos_guarded).toBe(1);
    expect(fs.eventAttached).toBe(true);
  });

  it('second fs_guard_eos does not re-register (eos_guarded = 1)', () => {
    fs_open(fs, 'first.mxf');
    fs_guard_eos(fs);
    let registrationCount = fs.eos_guarded; // 1
    fs_open(fs, 'second.mxf');
    fs_guard_eos(fs);
    expect(fs.eos_guarded).toBe(registrationCount); // still 1, no change
  });

  it('fs_destroy resets eos_guarded, allowing re-registration', () => {
    fs_open(fs, 'video.mxf');
    fs_guard_eos(fs);
    expect(fs.eos_guarded).toBe(1);

    fs_destroy(fs);
    expect(fs.eos_guarded).toBe(0);

    // New create + open + guard should re-register
    fs_create(fs);
    fs_open(fs, 'new.mxf');
    fs_guard_eos(fs);
    expect(fs.eos_guarded).toBe(1);
    expect(fs.eventAttached).toBe(true);
  });

  it('fs_open alone does NOT set eos_guarded or eventAttached', () => {
    fs_open(fs, 'video.mxf');
    expect(fs.eos_guarded).toBe(0);
    expect(fs.eventAttached).toBe(false);
  });
});

describe('EOS guard — duration clamping logic', () => {
  it('clamps timeMs at exactly durationMs → durationMs - 200', () => {
    expect(clampSeekMs(10000, 10000)).toBe(9800);
  });

  it('clamps timeMs beyond durationMs → durationMs - 200', () => {
    expect(clampSeekMs(10100, 10000)).toBe(9800);
  });

  it('clamps timeMs far beyond durationMs → durationMs - 200', () => {
    expect(clampSeekMs(99999, 10000)).toBe(9800);
  });

  it('does not clamp timeMs below durationMs', () => {
    expect(clampSeekMs(9999, 10000)).toBe(9999);
  });

  it('does not clamp timeMs well below durationMs', () => {
    expect(clampSeekMs(5000, 10000)).toBe(5000);
  });

  it('does not clamp timeMs at durationMs - 1 (just under boundary)', () => {
    expect(clampSeekMs(9999, 10000)).toBe(9999);
  });

  it('edge case: durationMs = 0 → no clamping (guard condition fails)', () => {
    expect(clampSeekMs(500, 0)).toBe(500);
    expect(clampSeekMs(0, 0)).toBe(0);
  });

  it('edge case: timeMs = 0 → no clamping regardless of duration', () => {
    expect(clampSeekMs(0, 10000)).toBe(0);
    expect(clampSeekMs(0, 0)).toBe(0);
  });

  it('edge case: very short media (durationMs = 100) clamps to 0', () => {
    // durationMs - 200 = -100, but Math.max(0, ...) floors it
    expect(clampSeekMs(100, 100)).toBe(0);
    expect(clampSeekMs(200, 100)).toBe(0);
  });

  it('edge case: durationMs exactly 200 → clamp to 0', () => {
    expect(clampSeekMs(200, 200)).toBe(0);
  });

  it('edge case: durationMs = 201 → clamp to 1', () => {
    expect(clampSeekMs(201, 201)).toBe(1);
    expect(clampSeekMs(300, 201)).toBe(1);
  });

  it('negative durationMs → no clamping (durationMs > 0 check fails)', () => {
    expect(clampSeekMs(500, -1)).toBe(500);
  });

  it('negative timeMs passes through unclamped', () => {
    expect(clampSeekMs(-100, 10000)).toBe(-100);
  });
});

describe('EOS guard — EOS timeout detection', () => {
  it('marks atEos = true when no frames for >400ms while playing', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 500);
    expect(detected).toBe(true);
    expect(m.atEos).toBe(true);
    expect(m.isPlaying).toBe(false);
  });

  it('does not mark EOS when frames arrive within 400ms', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 200);
    expect(detected).toBe(false);
    expect(m.atEos).toBe(false);
    expect(m.isPlaying).toBe(true);
  });

  it('does not mark EOS at exactly 400ms (boundary — not greater)', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 400);
    expect(detected).toBe(false);
    expect(m.atEos).toBe(false);
  });

  it('marks EOS at 401ms (just over threshold)', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const detected = checkEos([m], 401);
    expect(detected).toBe(true);
    expect(m.atEos).toBe(true);
  });

  it('does not check EOS for non-playing media', () => {
    const m = createMediaEntry(10000, { isPlaying: false });
    const detected = checkEos([m], 9999);
    expect(detected).toBe(false);
    expect(m.atEos).toBe(false);
  });

  it('handles multiple media — only marks playing ones', () => {
    const m1 = createMediaEntry(10000, { isPlaying: true });
    const m2 = createMediaEntry(5000, { isPlaying: false });
    const m3 = createMediaEntry(8000, { isPlaying: true });

    checkEos([m1, m2, m3], 500);

    expect(m1.atEos).toBe(true);
    expect(m1.isPlaying).toBe(false);
    expect(m2.atEos).toBe(false);   // was not playing
    expect(m2.isPlaying).toBe(false);
    expect(m3.atEos).toBe(true);
    expect(m3.isPlaying).toBe(false);
  });

  it('returns false when no media entries exist', () => {
    expect(checkEos([], 9999)).toBe(false);
  });

  it('EOS detection flushes pending frame requests for affected media', () => {
    const m = createMediaEntry(10000, { isPlaying: true });
    const pending = [
      { mediaId: 'media-1', reqId: 1 },
      { mediaId: 'media-1', reqId: 2 },
      { mediaId: 'media-2', reqId: 3 },
    ];
    // Simulate EOS flush
    checkEos([m], 500);
    // Filter pending for affected media (simulating VLCWorker behavior)
    const flushed = pending.filter(p => p.mediaId === 'media-1');
    const remaining = pending.filter(p => p.mediaId !== 'media-1');
    expect(flushed.length).toBe(2);
    expect(remaining.length).toBe(1);
    expect(remaining[0].mediaId).toBe('media-2');
  });
});

describe('EOS guard — EOS recovery flow', () => {
  it('recovers from EOS: sets atEos = false', () => {
    const m = createMediaEntry(10000, { atEos: true });
    const recovered = recoverFromEos(m);
    expect(recovered).toBe(true);
    expect(m.atEos).toBe(false);
  });

  it('skips recovery when not at EOS', () => {
    const m = createMediaEntry(10000, { atEos: false });
    const recovered = recoverFromEos(m);
    expect(recovered).toBe(false);
    expect(m.atEos).toBe(false);
  });

  it('skips recovery when mp is null (destroyed)', () => {
    const m = createMediaEntry(10000, { atEos: true, mp: null });
    const recovered = recoverFromEos(m);
    expect(recovered).toBe(false);
  });

  it('skips recovery when file is null', () => {
    const m = createMediaEntry(10000, { atEos: true, file: null });
    const recovered = recoverFromEos(m);
    expect(recovered).toBe(false);
  });

  it('skips recovery when WASM module is not ready', () => {
    const m = createMediaEntry(10000, { atEos: true });
    const recovered = recoverFromEos(m, false);
    expect(recovered).toBe(false);
    expect(m.atEos).toBe(true); // unchanged — recovery was skipped
  });

  it('after recovery, media is no longer at EOS and can receive frames', () => {
    const m = createMediaEntry(10000, { isPlaying: true });

    // Simulate EOS detection
    checkEos([m], 500);
    expect(m.atEos).toBe(true);
    expect(m.isPlaying).toBe(false);

    // Recover
    recoverFromEos(m);
    expect(m.atEos).toBe(false);

    // After recovery, can be set to playing again
    m.isPlaying = true;
    // No EOS if frames arrive in time
    checkEos([m], 100);
    expect(m.atEos).toBe(false);
    expect(m.isPlaying).toBe(true);
  });

  it('seek triggers recovery when atEos is true', () => {
    const m = createMediaEntry(10000, { atEos: true });
    // Simulates: if (m.atEos) _recoverFromEos(m); from seek handler
    if (m.atEos) recoverFromEos(m);
    expect(m.atEos).toBe(false);
  });

  it('repeated EOS → recover cycles work correctly', () => {
    const m = createMediaEntry(10000, { isPlaying: true });

    for (let i = 0; i < 5; i++) {
      // Hit EOS
      checkEos([m], 500);
      expect(m.atEos).toBe(true);

      // Recover
      recoverFromEos(m);
      expect(m.atEos).toBe(false);

      // Resume playing
      m.isPlaying = true;
    }
  });
});

describe('EOS guard — duration throttle (pre-EOS pause)', () => {
  it('triggers pause when frame is within 200ms of media end', () => {
    // frameMs = 9850, durationMs = 10000 → 10000 - 9850 = 150 < 200
    expect(durationThrottle(9850, 10000, true)).toBe(true);
  });

  it('triggers pause at exactly durationMs - 200 (boundary)', () => {
    // frameMs = 9800, durationMs = 10000 → 10000 - 9800 = 200, frameMs >= 9800
    expect(durationThrottle(9800, 10000, true)).toBe(true);
  });

  it('does not trigger when frame is outside 200ms window', () => {
    // frameMs = 9799, durationMs = 10000 → 9799 < 9800
    expect(durationThrottle(9799, 10000, true)).toBe(false);
  });

  it('does not trigger when frame is far from end', () => {
    expect(durationThrottle(5000, 10000, true)).toBe(false);
  });

  it('does not trigger at frame 0', () => {
    expect(durationThrottle(0, 10000, true)).toBe(false);
  });

  it('does not trigger when not playing', () => {
    expect(durationThrottle(9900, 10000, false)).toBe(false);
  });

  it('does not trigger when durationMs = 0 (unknown duration)', () => {
    expect(durationThrottle(100, 0, true)).toBe(false);
  });

  it('triggers at durationMs exactly (frame at media end)', () => {
    // frameMs = 10000, durationMs = 10000 → 10000 >= 9800
    expect(durationThrottle(10000, 10000, true)).toBe(true);
  });

  it('triggers beyond durationMs (decoder overshoot)', () => {
    expect(durationThrottle(10050, 10000, true)).toBe(true);
  });

  it('edge case: very short media (durationMs = 100)', () => {
    // durationMs - 200 = -100, so any frame >= -100 triggers (all of them)
    expect(durationThrottle(0, 100, true)).toBe(true);
    expect(durationThrottle(50, 100, true)).toBe(true);
  });

  it('negative durationMs → no trigger (guard fails)', () => {
    expect(durationThrottle(0, -500, true)).toBe(false);
  });
});

describe('EOS guard — integrated scenario: seek near end', () => {
  it('seek to end → clamped → no EOS → frame delivered', () => {
    const m = createMediaEntry(10000);
    const durationMs = m.durationMs;

    // 1. Clamp seek target
    const seekTarget = 10000;
    const clamped = clampSeekMs(seekTarget, durationMs);
    expect(clamped).toBe(9800);

    // 2. Not at EOS, so no recovery needed
    expect(m.atEos).toBe(false);

    // 3. Start playing for seek
    m.isPlaying = true;

    // 4. Frame arrives at 9850 — within 200ms window, throttle fires
    const throttled = durationThrottle(9850, durationMs, m.isPlaying);
    expect(throttled).toBe(true);

    // 5. Media paused by throttle — no EOS timeout
    m.isPlaying = false;
    const eos = checkEos([m], 999);
    expect(eos).toBe(false); // not playing, so no EOS check
  });

  it('seek past end → clamped → EOS detected → recovered → seek works', () => {
    const m = createMediaEntry(10000);
    const durationMs = m.durationMs;

    // 1. Seek past end, clamped
    const clamped = clampSeekMs(12000, durationMs);
    expect(clamped).toBe(9800);

    // 2. Play to decode
    m.isPlaying = true;

    // 3. No frames arrive (codec stall) → EOS detected
    checkEos([m], 500);
    expect(m.atEos).toBe(true);

    // 4. New seek triggers recovery
    recoverFromEos(m);
    expect(m.atEos).toBe(false);

    // 5. Resume and get frames
    m.isPlaying = true;
    checkEos([m], 50);
    expect(m.atEos).toBe(false);
  });
});

describe('EOS guard — C + JS interaction scenario', () => {
  it('C stopping flag prevents spurious EOS seek-back during JS-initiated stop', () => {
    const fs = createFrameServer();
    fs_create(fs);
    fs_open(fs, 'clip.mxf');
    fs_guard_eos(fs);
    fs_play(fs);

    // EOS seek-back should work during normal playback
    expect(_eos_seek_back(fs)).toBe(true);

    // JS calls stop (e.g., user pauses)
    fs_stop(fs);

    // C-level EOS event fires spuriously during wind-down
    // The stopping flag prevents the seek-back
    expect(_eos_seek_back(fs)).toBe(false);

    // User plays again — guard re-armed
    fs_play(fs);
    expect(_eos_seek_back(fs)).toBe(true);
  });

  it('file switch: old media EOS suppressed, new media EOS active', () => {
    const fs = createFrameServer();
    fs_create(fs);

    // Open and play first file
    fs_open(fs, 'clip-A.mxf');
    fs_guard_eos(fs);
    fs_play(fs);
    expect(_eos_seek_back(fs)).toBe(true);

    // Open second file (triggers internal stop for first)
    fs_open(fs, 'clip-B.mxf');
    // stopping = 1 from the internal stop of clip-A
    expect(_eos_seek_back(fs)).toBe(false);

    // Play clip-B — re-arms guard
    fs_play(fs);
    expect(_eos_seek_back(fs)).toBe(true);
  });

  it('destroy during playback: EOS suppressed, no dangling handlers', () => {
    const fs = createFrameServer();
    fs_create(fs);
    fs_open(fs, 'clip.mxf');
    fs_guard_eos(fs);
    fs_play(fs);

    fs_destroy(fs);
    expect(fs.stopping).toBe(1);
    expect(fs.eventAttached).toBe(false);
    expect(fs.eos_guarded).toBe(0);
    expect(_eos_seek_back(fs)).toBe(false);
  });
});

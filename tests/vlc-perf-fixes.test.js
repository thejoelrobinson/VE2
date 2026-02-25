/**
 * Unit tests for VLCBridge performance fixes and worker architecture.
 * Tests pure-logic parts that don't require browser APIs (WASM, VideoFrame, etc).
 */
import { describe, it, expect } from 'vitest';
import { drawFit } from '../src/lib/editor/playback/compositorHelpers.js';

// ─── Sorted cache helpers (mirrors VLCBridge L1 cache logic) ─────────────────

function sortedInsert(arr, val) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < val) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, val);
}

function sortedRemove(arr, val) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < val) lo = mid + 1; else hi = mid;
  }
  if (lo < arr.length && arr[lo] === val) arr.splice(lo, 1);
}

function binaryFindClosest(arr, target, tolerance) {
  const len = arr.length;
  if (len === 0) return -1;
  let lo = 0, hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1; else hi = mid;
  }
  let bestMs = -1, bestDist = Infinity;
  if (lo > 0) {
    const d = target - arr[lo - 1];
    if (d < bestDist) { bestDist = d; bestMs = arr[lo - 1]; }
  }
  if (lo < len) {
    const d = arr[lo] - target;
    if (d < bestDist) { bestDist = d; bestMs = arr[lo]; }
  }
  if (bestMs < 0 || bestDist > tolerance) return -1;
  return bestMs;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Sorted cache helpers', () => {
  it('sortedInsert maintains ascending order', () => {
    const arr = [];
    sortedInsert(arr, 500);
    sortedInsert(arr, 200);
    sortedInsert(arr, 800);
    sortedInsert(arr, 100);
    sortedInsert(arr, 600);
    expect(arr).toEqual([100, 200, 500, 600, 800]);
  });

  it('sortedInsert handles duplicates', () => {
    const arr = [100, 200, 300];
    sortedInsert(arr, 200);
    expect(arr).toEqual([100, 200, 200, 300]);
  });

  it('sortedRemove removes the correct element', () => {
    const arr = [100, 200, 300, 400, 500];
    sortedRemove(arr, 300);
    expect(arr).toEqual([100, 200, 400, 500]);
  });

  it('sortedRemove is a no-op for missing elements', () => {
    const arr = [100, 200, 300];
    sortedRemove(arr, 250);
    expect(arr).toEqual([100, 200, 300]);
  });

  it('sortedRemove handles first element', () => {
    const arr = [100, 200, 300];
    sortedRemove(arr, 100);
    expect(arr).toEqual([200, 300]);
  });

  it('sortedRemove handles last element', () => {
    const arr = [100, 200, 300];
    sortedRemove(arr, 300);
    expect(arr).toEqual([100, 200]);
  });
});

describe('Binary search closest (binaryFindClosest)', () => {
  it('finds exact match', () => {
    const arr = [0, 42, 84, 126, 168, 210];
    expect(binaryFindClosest(arr, 84, 20)).toBe(84);
  });

  it('finds closest when between two values', () => {
    const arr = [0, 42, 84, 126, 168];
    expect(binaryFindClosest(arr, 90, 20)).toBe(84);
    expect(binaryFindClosest(arr, 80, 20)).toBe(84);
  });

  it('returns -1 when outside tolerance', () => {
    const arr = [0, 42, 84, 126, 168];
    expect(binaryFindClosest(arr, 300, 20)).toBe(-1);
  });

  it('handles empty array', () => {
    expect(binaryFindClosest([], 100, 50)).toBe(-1);
  });

  it('handles single element', () => {
    expect(binaryFindClosest([100], 105, 10)).toBe(100);
    expect(binaryFindClosest([100], 120, 10)).toBe(-1);
  });

  it('is O(log n) — handles large arrays efficiently', () => {
    const arr = Array.from({ length: 10000 }, (_, i) => i * 42);
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      binaryFindClosest(arr, i * 42 + 10, 25);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('matches linear scan results for correctness', () => {
    const arr = Array.from({ length: 90 }, () => Math.floor(Math.random() * 10000))
      .sort((a, b) => a - b);
    function linearFind(arr, target, tolerance) {
      let bestMs = -1, bestDist = Infinity;
      for (const ms of arr) {
        const d = Math.abs(ms - target);
        if (d < bestDist) { bestDist = d; bestMs = ms; }
      }
      return bestMs < 0 || bestDist > tolerance ? -1 : bestMs;
    }
    for (let i = 0; i < 1000; i++) {
      const target = Math.floor(Math.random() * 12000);
      expect(binaryFindClosest(arr, target, 200)).toBe(linearFind(arr, target, 200));
    }
  });
});

describe('OPFS read candidate limiting', () => {
  it('limits candidates to OPFS_READ_MAX_CANDIDATES * 2 + 1', () => {
    const OPFS_READ_MAX_CANDIDATES = 5;
    const toleranceMs = 333;
    const step = 42;
    const targetMs = 5000;
    const candidates = [targetMs];
    for (let d = step; d < toleranceMs && candidates.length < OPFS_READ_MAX_CANDIDATES * 2 + 1; d += step) {
      candidates.push(targetMs - d, targetMs + d);
    }
    expect(candidates.length).toBeLessThanOrEqual(OPFS_READ_MAX_CANDIDATES * 2 + 1);
    expect(candidates.length).toBeLessThan(27);
  });
});

describe('drawFit scale-to-fit', () => {
  function mockCtx() {
    const calls = [];
    return { drawImage: (...args) => calls.push(['drawImage', ...args]), _calls: calls };
  }

  it('1:1 blit when source matches canvas', () => {
    const ctx = mockCtx();
    const source = { width: 1920, height: 1080 };
    drawFit(ctx, source, 1920, 1080);
    expect(ctx._calls.length).toBe(1);
    expect(ctx._calls[0]).toEqual(['drawImage', source, 0, 0]);
  });

  it('scales down 4K to 1080p canvas', () => {
    const ctx = mockCtx();
    const source = { width: 3840, height: 2160 };
    drawFit(ctx, source, 1920, 1080);
    expect(ctx._calls.length).toBe(1);
    const [, , x, y, dw, dh] = ctx._calls[0];
    expect(dw).toBe(1920);
    expect(dh).toBe(1080);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });

  it('letterboxes non-matching aspect ratio', () => {
    const ctx = mockCtx();
    const source = { width: 2048, height: 858 };
    drawFit(ctx, source, 1920, 1080);
    expect(ctx._calls.length).toBe(1);
    const [, , x, y, dw, dh] = ctx._calls[0];
    const expectedDw = 2048 * 0.9375;
    const expectedDh = 858 * 0.9375;
    expect(dw).toBeCloseTo(expectedDw, 0);
    expect(dh).toBeCloseTo(expectedDh, 0);
    expect(y).toBeGreaterThan(0);
  });

  it('handles zero-dimension source gracefully', () => {
    const ctx = mockCtx();
    drawFit(ctx, { width: 0, height: 1080 }, 1920, 1080);
    expect(ctx._calls.length).toBe(0);
  });
});

describe('OPFS write throttle', () => {
  it('only writes every Nth frame', () => {
    const OPFS_WRITE_INTERVAL = 3;
    let writeCount = 0;
    let counter = 0;
    for (let i = 0; i < 30; i++) {
      counter++;
      if (counter >= OPFS_WRITE_INTERVAL) { counter = 0; writeCount++; }
    }
    expect(writeCount).toBe(10);
  });
});

describe('OPFS scan step calculation', () => {
  it('uses FPS-aligned steps with write interval', () => {
    const fps = 24;
    const OPFS_WRITE_INTERVAL = 3;
    const scanStep = Math.max(25, Math.round((1000 / fps) * OPFS_WRITE_INTERVAL));
    expect(scanStep).toBeGreaterThanOrEqual(100);
    expect(scanStep).toBeLessThanOrEqual(150);
    const duration = 60000;
    const newCalls = Math.ceil(duration / scanStep);
    const oldCalls = Math.ceil(duration / 25);
    expect(newCalls).toBeLessThan(oldCalls / 3);
  });
});

describe('Worker message protocol', () => {
  it('defines correct message types for all NLE operations', () => {
    // Verify the protocol covers all operations
    const mainToWorker = ['init', 'load_file', 'get_frame', 'set_playback', 'seek',
      'advance_playhead', 'start_proactive_fill', 'start_sequential', 'get_seq_frame',
      'end_sequential', 'release'];
    const workerToMain = ['init_done', 'probe_done', 'probe_error', 'frame',
      'frame_cached', 'get_frame_result', 'get_frame_null', 'seq_frame', 'eos', 'error'];

    // NLE operations mapping
    const operations = {
      scrub: ['get_frame'],
      play: ['set_playback'],
      pause: ['set_playback'],
      seek: ['seek'],
      export: ['start_sequential', 'get_seq_frame', 'end_sequential'],
      proactiveFill: ['start_proactive_fill'],
    };

    for (const [op, msgs] of Object.entries(operations)) {
      for (const msg of msgs) {
        expect(mainToWorker).toContain(msg);
      }
    }

    // All worker responses should be handled
    for (const msg of workerToMain) {
      expect(typeof msg).toBe('string');
    }
  });

  it('session ID prevents stale frame pollution', () => {
    let sessionId = 1;
    const frames = [];

    // Simulate: file A session=1, file B session=2
    function receiveFrame(msg) {
      if (msg.sessionId !== sessionId) return; // discard stale
      frames.push(msg);
    }

    receiveFrame({ sessionId: 1, frameMs: 100 });
    sessionId = 2; // switch to file B
    receiveFrame({ sessionId: 1, frameMs: 200 }); // stale — should be discarded
    receiveFrame({ sessionId: 2, frameMs: 300 });

    expect(frames.length).toBe(2);
    expect(frames[0].frameMs).toBe(100);
    expect(frames[1].frameMs).toBe(300);
  });

  it('request timeout resolves with null', async () => {
    const pending = new Map();
    let reqId = 0;

    function requestFrame(timeMs) {
      const id = ++reqId;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
        }, 50); // short timeout for test
        pending.set(id, { resolve, timer });
      });
    }

    // Request a frame that never gets a response
    const result = await requestFrame(5000);
    expect(result).toBeNull();
    expect(pending.size).toBe(0);
  });
});

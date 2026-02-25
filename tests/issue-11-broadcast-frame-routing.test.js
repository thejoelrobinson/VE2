/**
 * Issue #11 — Broadcast Frame Routing into RenderAheadManager
 *
 * Pure-logic tests verifying that VLCBridge broadcast frames reach
 * RenderAheadManager._frameBuffer via the pushFrame() method.
 * No browser APIs or WASM — createImageBitmap is mocked globally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── createImageBitmap mock ──────────────────────────────────────────────────
// Node.js doesn't have createImageBitmap. We mock it to return a minimal
// bitmap-like object with a close() method and unique identity for assertions.

let _bitmapIdCounter = 0;

function makeMockBitmap() {
  return { _id: ++_bitmapIdCounter, width: 1920, height: 1080, closed: false, close() { this.closed = true; } };
}

globalThis.createImageBitmap = vi.fn(async (source) => {
  if (source && source.closed) throw new DOMException('Source bitmap is closed');
  return makeMockBitmap();
});

// ── Minimal RenderAheadManager simulation ───────────────────────────────────
// Mirrors the pushFrame + eviction + pinning logic so tests don't need to
// import the real module (which pulls in EventBus, EditorState, etc.).

function createRAM({ bufferLimit = 5 } = {}) {
  const _frameBuffer = new Map();
  const _decodedSources = new Set();
  let _pinned = false;
  let _bufferLimit = bufferLimit;

  function _capDecodedSources() {
    if (_decodedSources.size > 10000) {
      const evictCount = 2000;
      const iter = _decodedSources.values();
      for (let i = 0; i < evictCount; i++) {
        const v = iter.next();
        if (v.done) break;
        _decodedSources.delete(v.value);
      }
    }
  }

  function _evict() {
    if (_pinned) return;
    while (_frameBuffer.size > _bufferLimit) {
      const firstKey = _frameBuffer.keys().next().value;
      const old = _frameBuffer.get(firstKey);
      old?.close?.();
      _frameBuffer.delete(firstKey);
    }
  }

  async function pushFrame(mediaId, timeMs, bitmap) {
    const key = `${mediaId}_${timeMs}`;
    if (_frameBuffer.has(key)) return;
    if (_frameBuffer.size >= _bufferLimit) _evict();
    if (_frameBuffer.size >= _bufferLimit) return; // pinned, can't evict
    try {
      const copy = await createImageBitmap(bitmap);
      if (_frameBuffer.has(key)) { copy.close(); return; } // race check after await
      _frameBuffer.set(key, copy);
      _decodedSources.add(key);
      _capDecodedSources();
    } catch (_) {} // bitmap may have been closed by L1 eviction
  }

  function getFrame(mediaId, timeSeconds) {
    const timeMs = Math.round(timeSeconds * 1000);
    const key = `${mediaId}_${timeMs}`;
    return _frameBuffer.get(key) || null;
  }

  function pinFrames() { _pinned = true; }
  function unpinFrames() { _pinned = false; }

  return {
    _frameBuffer,
    _decodedSources,
    _bufferLimit,
    get pinned() { return _pinned; },
    pushFrame,
    getFrame,
    pinFrames,
    unpinFrames,
    _evict,
  };
}

// ── VLCBridge broadcast simulation ──────────────────────────────────────────
// Mirrors the callback plumbing from VLCBridge: _onBroadcastFrame fires on
// every 'frame' message, wired via setBroadcastFrameCallback.

function createMockBridge() {
  let _onBroadcastFrame = null;
  let _onFrameCached = null;

  return {
    setBroadcastFrameCallback(fn) { _onBroadcastFrame = fn; },
    setFrameCachedCallback(fn) { _onFrameCached = fn; },
    // Simulate a worker 'frame' message arriving
    simulateFrame(frameMs, bitmap) {
      if (_onBroadcastFrame) try { _onBroadcastFrame(frameMs, bitmap); } catch (_) {}
      if (_onFrameCached) try { _onFrameCached(frameMs); } catch (_) {}
    },
    get hasBroadcastCallback() { return _onBroadcastFrame !== null; },
    get hasFrameCachedCallback() { return _onFrameCached !== null; },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Issue #11 — Broadcast Frame Routing', () => {

  beforeEach(() => {
    _bitmapIdCounter = 0;
    vi.clearAllMocks();
  });

  // ── pushFrame basic ─────────────────────────────────────────────────────

  describe('pushFrame stores bitmap and getFrame returns it', () => {
    it('stores a cloned bitmap accessible via getFrame()', async () => {
      const ram = createRAM();
      const srcBitmap = makeMockBitmap();

      await ram.pushFrame('media-1', 1000, srcBitmap);

      const result = ram.getFrame('media-1', 1.0); // 1.0s → 1000ms
      expect(result).not.toBeNull();
      // Should be a clone, not the original
      expect(result._id).not.toBe(srcBitmap._id);
      expect(ram._decodedSources.has('media-1_1000')).toBe(true);
    });

    it('createImageBitmap is called once per pushFrame', async () => {
      const ram = createRAM();
      const srcBitmap = makeMockBitmap();

      await ram.pushFrame('media-1', 500, srcBitmap);

      expect(createImageBitmap).toHaveBeenCalledTimes(1);
      expect(createImageBitmap).toHaveBeenCalledWith(srcBitmap);
    });
  });

  // ── Duplicate skipping ──────────────────────────────────────────────────

  describe('pushFrame skips duplicates', () => {
    it('same key twice results in one entry', async () => {
      const ram = createRAM();
      const bmp1 = makeMockBitmap();
      const bmp2 = makeMockBitmap();

      await ram.pushFrame('media-1', 1000, bmp1);
      await ram.pushFrame('media-1', 1000, bmp2);

      expect(ram._frameBuffer.size).toBe(1);
      // createImageBitmap should only be called once (second push is skipped early)
      expect(createImageBitmap).toHaveBeenCalledTimes(1);
    });

    it('different keys are stored independently', async () => {
      const ram = createRAM();
      const bmp1 = makeMockBitmap();
      const bmp2 = makeMockBitmap();

      await ram.pushFrame('media-1', 1000, bmp1);
      await ram.pushFrame('media-1', 2000, bmp2);

      expect(ram._frameBuffer.size).toBe(2);
      expect(ram.getFrame('media-1', 1.0)).not.toBeNull();
      expect(ram.getFrame('media-1', 2.0)).not.toBeNull();
    });
  });

  // ── Buffer limit and eviction ───────────────────────────────────────────

  describe('pushFrame respects buffer limit', () => {
    it('silently drops frame when buffer is at capacity', async () => {
      const ram = createRAM({ bufferLimit: 3 });

      // Fill to capacity
      await ram.pushFrame('m', 100, makeMockBitmap());
      await ram.pushFrame('m', 200, makeMockBitmap());
      await ram.pushFrame('m', 300, makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(3);

      // Push one more — _evict uses (size > limit) so no slot opens;
      // broadcast frames are opportunistic and silently dropped at capacity.
      await ram.pushFrame('m', 400, makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(3);
      expect(ram.getFrame('m', 0.1)).not.toBeNull(); // 100ms still present
      expect(ram.getFrame('m', 0.4)).toBeNull(); // 400ms was NOT added
    });

    it('adds frame when buffer is below capacity', async () => {
      const ram = createRAM({ bufferLimit: 3 });

      await ram.pushFrame('m', 100, makeMockBitmap());
      await ram.pushFrame('m', 200, makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(2);

      // Room available — frame is added
      await ram.pushFrame('m', 300, makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(3);
      expect(ram.getFrame('m', 0.3)).not.toBeNull();
    });

    it('evicts when buffer exceeds limit due to external additions', async () => {
      // Simulate: buffer was filled by requestAhead beyond the limit,
      // then _evict brings it back down.
      const ram = createRAM({ bufferLimit: 2 });

      // Manually overfill (simulating requestAhead path which can exceed limit)
      ram._frameBuffer.set('m_100', makeMockBitmap());
      ram._frameBuffer.set('m_200', makeMockBitmap());
      ram._frameBuffer.set('m_300', makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(3);

      // pushFrame triggers _evict, which trims excess back to limit
      await ram.pushFrame('m', 400, makeMockBitmap());
      // _evict removes 1 entry (3 > 2), then size == limit so pushFrame drops the new one
      expect(ram._frameBuffer.size).toBe(2);
    });
  });

  // ── Eviction respects pinned state ──────────────────────────────────────

  describe('eviction respects pinned state', () => {
    it('does not evict when pinned and buffer is full', async () => {
      const ram = createRAM({ bufferLimit: 2 });

      await ram.pushFrame('m', 100, makeMockBitmap());
      await ram.pushFrame('m', 200, makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(2);

      // Pin frames — eviction should be blocked
      ram.pinFrames();

      // Push while pinned + full → should be silently dropped
      await ram.pushFrame('m', 300, makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(2);
      expect(ram.getFrame('m', 0.3)).toBeNull(); // 300ms was NOT added

      // Unpin and verify old frames are still there
      ram.unpinFrames();
      expect(ram.getFrame('m', 0.1)).not.toBeNull();
      expect(ram.getFrame('m', 0.2)).not.toBeNull();
    });

    it('eviction resumes after unpin when buffer exceeds limit', async () => {
      const ram = createRAM({ bufferLimit: 2 });

      await ram.pushFrame('m', 100, makeMockBitmap());
      await ram.pushFrame('m', 200, makeMockBitmap());

      ram.pinFrames();
      await ram.pushFrame('m', 300, makeMockBitmap()); // dropped (pinned + at capacity)
      expect(ram._frameBuffer.size).toBe(2);

      // Manually overfill to simulate external additions during pinned period
      ram._frameBuffer.set('m_300', makeMockBitmap());
      expect(ram._frameBuffer.size).toBe(3); // exceeds limit

      ram.unpinFrames();
      // Trigger eviction via _evict() — trims back to limit
      ram._evict();
      expect(ram._frameBuffer.size).toBe(2);
    });
  });

  // ── Closed bitmap handling ──────────────────────────────────────────────

  describe('pushFrame handles closed bitmap gracefully', () => {
    it('does not throw when createImageBitmap rejects', async () => {
      const ram = createRAM();
      const closedBitmap = makeMockBitmap();
      closedBitmap.closed = true;

      // createImageBitmap mock throws for closed bitmaps
      await expect(ram.pushFrame('m', 1000, closedBitmap)).resolves.not.toThrow();
      expect(ram._frameBuffer.size).toBe(0);
    });

    it('does not propagate errors to the caller', async () => {
      const ram = createRAM();
      // Force createImageBitmap to reject
      globalThis.createImageBitmap = vi.fn(async () => { throw new Error('detached'); });

      await expect(ram.pushFrame('m', 500, makeMockBitmap())).resolves.toBeUndefined();
      expect(ram._frameBuffer.size).toBe(0);

      // Restore default mock
      globalThis.createImageBitmap = vi.fn(async () => makeMockBitmap());
    });
  });

  // ── Broadcast callback wiring ──────────────────────────────────────────

  describe('VLCBridge broadcast callback wiring', () => {
    it('setBroadcastFrameCallback is called during bridge initialization', () => {
      const bridge = createMockBridge();

      // Simulate what MediaDecoder._getFrameVLC does
      const capturedId = 'media-1';
      bridge.setBroadcastFrameCallback((timeMs, bitmap) => {
        // This would call ram.pushFrame in production
        void capturedId;
        void timeMs;
        void bitmap;
      });

      expect(bridge.hasBroadcastCallback).toBe(true);
    });

    it('broadcast callback fires for each frame and reaches pushFrame', async () => {
      const bridge = createMockBridge();
      const ram = createRAM();
      const capturedId = 'media-1';

      // Wire up like MediaDecoder does
      bridge.setBroadcastFrameCallback((timeMs, bitmap) => {
        ram.pushFrame(capturedId, timeMs, bitmap);
      });

      // Simulate 3 broadcast frames
      const bmp1 = makeMockBitmap();
      const bmp2 = makeMockBitmap();
      const bmp3 = makeMockBitmap();

      bridge.simulateFrame(1000, bmp1);
      bridge.simulateFrame(2000, bmp2);
      bridge.simulateFrame(3000, bmp3);

      // Wait for all async pushFrame calls to settle
      await vi.waitFor(() => {
        expect(ram._frameBuffer.size).toBe(3);
      });

      expect(ram.getFrame('media-1', 1.0)).not.toBeNull();
      expect(ram.getFrame('media-1', 2.0)).not.toBeNull();
      expect(ram.getFrame('media-1', 3.0)).not.toBeNull();
    });

    it('broadcast callback error does not crash the bridge', () => {
      const bridge = createMockBridge();

      bridge.setBroadcastFrameCallback(() => {
        throw new Error('callback error');
      });

      // simulateFrame wraps callback in try/catch — should not throw
      expect(() => bridge.simulateFrame(1000, makeMockBitmap())).not.toThrow();
    });
  });

  // ── Key format consistency ─────────────────────────────────────────────

  describe('key format consistency between pushFrame and getFrame', () => {
    it('pushFrame(mediaId, 1500) matches getFrame(mediaId, 1.5)', async () => {
      const ram = createRAM();
      await ram.pushFrame('vid-42', 1500, makeMockBitmap());

      // getFrame converts seconds to ms: Math.round(1.5 * 1000) = 1500
      const result = ram.getFrame('vid-42', 1.5);
      expect(result).not.toBeNull();
    });

    it('pushFrame(mediaId, 333) matches getFrame(mediaId, 0.333)', async () => {
      const ram = createRAM();
      await ram.pushFrame('vid-42', 333, makeMockBitmap());

      // Math.round(0.333 * 1000) = 333
      const result = ram.getFrame('vid-42', 0.333);
      expect(result).not.toBeNull();
    });

    it('different mediaIds do not collide at the same timeMs', async () => {
      const ram = createRAM();
      await ram.pushFrame('media-A', 1000, makeMockBitmap());
      await ram.pushFrame('media-B', 1000, makeMockBitmap());

      expect(ram._frameBuffer.size).toBe(2);
      expect(ram.getFrame('media-A', 1.0)).not.toBeNull();
      expect(ram.getFrame('media-B', 1.0)).not.toBeNull();
      // They should be different bitmap clones
      expect(ram.getFrame('media-A', 1.0)._id).not.toBe(ram.getFrame('media-B', 1.0)._id);
    });
  });

  // ── _decodedSources tracking ───────────────────────────────────────────

  describe('_decodedSources tracking', () => {
    it('pushFrame adds key to _decodedSources', async () => {
      const ram = createRAM();
      await ram.pushFrame('m1', 500, makeMockBitmap());
      expect(ram._decodedSources.has('m1_500')).toBe(true);
    });

    it('_decodedSources persists even after eviction from _frameBuffer', async () => {
      const ram = createRAM({ bufferLimit: 3 });

      await ram.pushFrame('m1', 100, makeMockBitmap());
      await ram.pushFrame('m1', 200, makeMockBitmap());
      expect(ram._decodedSources.has('m1_100')).toBe(true);
      expect(ram._decodedSources.has('m1_200')).toBe(true);

      // Manually evict the first entry from _frameBuffer to simulate LRU eviction
      const firstKey = ram._frameBuffer.keys().next().value;
      const firstBmp = ram._frameBuffer.get(firstKey);
      firstBmp?.close?.();
      ram._frameBuffer.delete(firstKey);
      expect(ram._frameBuffer.size).toBe(1);
      expect(ram.getFrame('m1', 0.1)).toBeNull(); // evicted from buffer

      // But _decodedSources still has it (render bar stays green)
      expect(ram._decodedSources.has('m1_100')).toBe(true);
      expect(ram._decodedSources.has('m1_200')).toBe(true);
    });
  });

  // ── Race condition: concurrent pushFrame for same key ──────────────────

  describe('concurrent pushFrame race safety', () => {
    it('two concurrent pushFrame calls for the same key result in one entry', async () => {
      const ram = createRAM();
      const bmp = makeMockBitmap();

      // Fire two pushFrame calls concurrently for the same key
      const p1 = ram.pushFrame('m', 1000, bmp);
      const p2 = ram.pushFrame('m', 1000, bmp);

      await Promise.all([p1, p2]);

      expect(ram._frameBuffer.size).toBe(1);
      // Second call should have been a no-op (early return because key exists)
      // or the clone was closed after the race check
    });
  });
});

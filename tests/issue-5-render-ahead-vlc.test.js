/**
 * Issue #5 — RenderAheadManager: Replace DecodeWorker with VLC
 *
 * After this issue is resolved:
 * - DecodeWorker creation and worker message handlers are removed
 * - MXF special cases (endsWith('.mxf') checks) are removed
 * - registerMedia simplified: just store + startIdleFill
 * - requestAhead uses mediaDecoder.getFrame() instead of worker postMessage
 * - Concurrency limit of ~4 parallel decodes
 * - ensureBuffered uses mediaDecoder.getFrame() with timeout
 * - markMXFFrameDecoded renamed to markFrameDecoded
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Simulated ImageBitmap ───────────────────────────────────────────────────

function createMockBitmap(mediaId, timeMs) {
  return {
    type: 'image-bitmap',
    mediaId,
    timeMs,
    _closed: false,
    close() { this._closed = true; }
  };
}

// ── Simulated mediaDecoder.getFrame (returns ImageBitmap or null) ───────────

function createMockMediaDecoder(options = {}) {
  const decodeDelay = options.decodeDelay || 0;
  const failFor = new Set(options.failFor || []);
  let callCount = 0;

  return {
    callCount: () => callCount,
    async getFrame(mediaId, url, timeSeconds, width, height) {
      callCount++;
      if (failFor.has(mediaId)) return null;
      if (decodeDelay > 0) {
        await new Promise(r => setTimeout(r, decodeDelay));
      }
      const timeMs = Math.round(timeSeconds * 1000);
      return createMockBitmap(mediaId, timeMs);
    }
  };
}

// ── Simulated RenderAheadManager (EXPECTED behavior after issue #5) ─────────

function createRenderAheadManager(mediaDecoder) {
  const manager = {
    _frameBuffer: new Map(),       // `${mediaId}_${timeMs}` -> ImageBitmap
    _bufferLimit: 150,
    _decodedSources: new Set(),
    _registeredMedia: new Set(),
    _idleFillStarted: false,
    _activeConcurrent: 0,
    _maxConcurrent: 4,             // concurrency limit
    _frameDecodedThrottle: null,

    // Simplified registerMedia: just store + startIdleFill (no worker, no MXF skip)
    registerMedia(mediaId) {
      if (this._registeredMedia.has(mediaId)) return false; // skip duplicate
      this._registeredMedia.add(mediaId);
      this._startIdleFill();
      return true;
    },

    _startIdleFill() {
      this._idleFillStarted = true;
    },

    // requestAhead: uses mediaDecoder.getFrame() with concurrency limit
    async requestAhead(mediaId, times) {
      if (this._frameBuffer.size >= this._bufferLimit * 0.9) {
        return { sent: 0, skippedFull: true };
      }

      let sent = 0;
      const allPromises = [];
      const inFlight = new Set();

      for (const timeSeconds of times) {
        const timeMs = Math.round(timeSeconds * 1000);
        const key = `${mediaId}_${timeMs}`;

        // Skip already decoded
        if (this._decodedSources.has(key)) continue;

        // Respect concurrency limit — wait for one to complete before starting another
        if (this._activeConcurrent >= this._maxConcurrent) {
          if (inFlight.size > 0) {
            await Promise.race(inFlight);
          }
        }

        this._activeConcurrent++;
        const p = mediaDecoder.getFrame(mediaId, null, timeSeconds, 1920, 1080)
          .then(bitmap => {
            this._activeConcurrent--;
            inFlight.delete(p);
            if (bitmap) {
              this._frameBuffer.set(key, bitmap);
              this._decodedSources.add(key);
            }
            return bitmap;
          })
          .catch(() => {
            this._activeConcurrent--;
            inFlight.delete(p);
            return null;
          });

        inFlight.add(p);
        allPromises.push(p);
        sent++;
      }

      await Promise.all(allPromises);
      return { sent, skippedFull: false };
    },

    // ensureBuffered: decode all missing frames for a time range with timeout
    async ensureBuffered(mediaId, times, timeoutMs = 5000) {
      const missing = [];
      for (const timeSeconds of times) {
        const timeMs = Math.round(timeSeconds * 1000);
        const key = `${mediaId}_${timeMs}`;
        if (!this._frameBuffer.has(key)) {
          missing.push(timeSeconds);
        }
      }
      if (missing.length === 0) return { filled: 0, timedOut: false };

      let filled = 0;
      let timedOut = false;

      const decodePromise = Promise.all(
        missing.map(async (timeSeconds) => {
          const timeMs = Math.round(timeSeconds * 1000);
          const key = `${mediaId}_${timeMs}`;
          const bitmap = await mediaDecoder.getFrame(mediaId, null, timeSeconds, 1920, 1080);
          if (bitmap) {
            this._frameBuffer.set(key, bitmap);
            this._decodedSources.add(key);
            filled++;
          }
        })
      );

      const timeoutPromise = new Promise(resolve => {
        setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
      });

      await Promise.race([decodePromise, timeoutPromise]);
      return { filled, timedOut };
    },

    // Renamed from markMXFFrameDecoded
    markFrameDecoded(mediaId, timeMs) {
      const key = `${mediaId}_${timeMs}`;
      this._decodedSources.add(key);
    },

    getFrame(mediaId, timeSeconds) {
      const timeMs = Math.round(timeSeconds * 1000);
      const key = `${mediaId}_${timeMs}`;
      return this._frameBuffer.get(key) || null;
    },

    // Buffer cleanup releases ImageBitmaps
    cleanup() {
      for (const [, bitmap] of this._frameBuffer) {
        bitmap?.close?.();
      }
      this._frameBuffer.clear();
      this._decodedSources.clear();
      this._registeredMedia.clear();
    }
  };

  return manager;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #5 — registerMedia simplified', () => {
  let mediaDecoder;
  let manager;

  beforeEach(() => {
    mediaDecoder = createMockMediaDecoder();
    manager = createRenderAheadManager(mediaDecoder);
  });

  it('stores mediaId and starts idle fill', () => {
    manager.registerMedia('media-1');
    expect(manager._registeredMedia.has('media-1')).toBe(true);
    expect(manager._idleFillStarted).toBe(true);
  });

  it('skips duplicate registration', () => {
    const first = manager.registerMedia('media-1');
    const second = manager.registerMedia('media-1');
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(manager._registeredMedia.size).toBe(1);
  });

  it('registers multiple media IDs', () => {
    manager.registerMedia('media-1');
    manager.registerMedia('media-2');
    manager.registerMedia('media-3');
    expect(manager._registeredMedia.size).toBe(3);
  });

  it('registers non-MXF formats without any special handling', () => {
    // All formats go through the same path
    manager.registerMedia('media-mp4');
    manager.registerMedia('media-mov');
    manager.registerMedia('media-webm');
    manager.registerMedia('media-mxf');
    expect(manager._registeredMedia.size).toBe(4);
  });
});

describe('Issue #5 — requestAhead uses mediaDecoder.getFrame()', () => {
  let mediaDecoder;
  let manager;

  beforeEach(() => {
    mediaDecoder = createMockMediaDecoder();
    manager = createRenderAheadManager(mediaDecoder);
    manager.registerMedia('media-1');
  });

  it('stores ImageBitmap results in frame buffer', async () => {
    await manager.requestAhead('media-1', [1.0, 2.0, 3.0]);
    expect(manager._frameBuffer.size).toBe(3);
    expect(manager._frameBuffer.get('media-1_1000')).toBeTruthy();
    expect(manager._frameBuffer.get('media-1_2000')).toBeTruthy();
    expect(manager._frameBuffer.get('media-1_3000')).toBeTruthy();
  });

  it('skips already-decoded frames', async () => {
    await manager.requestAhead('media-1', [1.0]);
    const firstCallCount = mediaDecoder.callCount();

    // Request same frame again
    await manager.requestAhead('media-1', [1.0]);
    expect(mediaDecoder.callCount()).toBe(firstCallCount); // no new calls
  });

  it('respects concurrency limit (max 4 parallel)', async () => {
    // Use non-zero delay so multiple calls are genuinely in-flight
    const slowDecoder = createMockMediaDecoder({ decodeDelay: 10 });
    const concurrentManager = createRenderAheadManager(slowDecoder);
    concurrentManager.registerMedia('media-1');

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const originalGetFrame = slowDecoder.getFrame;
    slowDecoder.getFrame = async (...args) => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      const result = await originalGetFrame.call(slowDecoder, ...args);
      currentConcurrent--;
      return result;
    };

    // Request 8 frames — should never exceed 4 concurrent
    const times = [1, 2, 3, 4, 5, 6, 7, 8].map(t => t * 0.1);
    await concurrentManager.requestAhead('media-1', times);
    expect(maxConcurrent).toBeGreaterThan(1); // proves concurrency actually happened
    expect(maxConcurrent).toBeLessThanOrEqual(4);
    expect(concurrentManager._frameBuffer.size).toBe(8);
  });

  it('skips when buffer >= 90% full', async () => {
    // Fill buffer to 90% of limit
    manager._bufferLimit = 10;
    for (let i = 0; i < 9; i++) {
      manager._frameBuffer.set(`fill_${i}`, createMockBitmap('fill', i));
    }

    const result = await manager.requestAhead('media-1', [1.0, 2.0]);
    expect(result.sent).toBe(0);
    expect(result.skippedFull).toBe(true);
  });

  it('handles decode failures gracefully (null return)', async () => {
    const failDecoder = createMockMediaDecoder({ failFor: ['media-1'] });
    const failManager = createRenderAheadManager(failDecoder);
    failManager.registerMedia('media-1');

    await failManager.requestAhead('media-1', [1.0, 2.0]);
    // Failures return null — no bitmap stored
    expect(failManager._frameBuffer.size).toBe(0);
  });

  it('handles decode errors (thrown exceptions) and decrements _activeConcurrent', async () => {
    const throwingDecoder = {
      callCount: () => 0,
      async getFrame() {
        throw new Error('decode explosion');
      }
    };
    const throwManager = createRenderAheadManager(throwingDecoder);
    throwManager.registerMedia('media-1');

    await throwManager.requestAhead('media-1', [1.0, 2.0, 3.0]);
    // .catch handler should have decremented _activeConcurrent back to 0
    expect(throwManager._activeConcurrent).toBe(0);
    // No frames should be stored
    expect(throwManager._frameBuffer.size).toBe(0);
  });
});

describe('Issue #5 — ensureBuffered fills missing frames with timeout', () => {
  let mediaDecoder;
  let manager;

  beforeEach(() => {
    mediaDecoder = createMockMediaDecoder();
    manager = createRenderAheadManager(mediaDecoder);
    manager.registerMedia('media-1');
  });

  it('fills all missing frames for a time range', async () => {
    const result = await manager.ensureBuffered('media-1', [1.0, 2.0, 3.0]);
    expect(result.filled).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(manager._frameBuffer.size).toBe(3);
  });

  it('skips already-buffered frames', async () => {
    // Pre-fill one frame
    manager._frameBuffer.set('media-1_1000', createMockBitmap('media-1', 1000));

    const result = await manager.ensureBuffered('media-1', [1.0, 2.0, 3.0]);
    expect(result.filled).toBe(2); // only 2 new frames
    expect(manager._frameBuffer.size).toBe(3);
  });

  it('returns filled=0 when all frames are already buffered', async () => {
    manager._frameBuffer.set('media-1_1000', createMockBitmap('media-1', 1000));
    manager._frameBuffer.set('media-1_2000', createMockBitmap('media-1', 2000));

    const result = await manager.ensureBuffered('media-1', [1.0, 2.0]);
    expect(result.filled).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('times out gracefully on slow decode', async () => {
    const slowDecoder = createMockMediaDecoder({ decodeDelay: 200 });
    const slowManager = createRenderAheadManager(slowDecoder);
    slowManager.registerMedia('media-1');

    const totalFrames = 2;
    const result = await slowManager.ensureBuffered('media-1', [1.0, 2.0], 50);
    expect(result.timedOut).toBe(true);
    // On timeout, filled count should be at most the number of requested frames
    expect(result.filled).toBeLessThanOrEqual(totalFrames);
    // Background decode promises may still resolve after the timeout returns,
    // but the caller has already received the timedOut result.
  });
});

describe('Issue #5 — markFrameDecoded (renamed from markMXFFrameDecoded)', () => {
  let mediaDecoder;
  let manager;

  beforeEach(() => {
    mediaDecoder = createMockMediaDecoder();
    manager = createRenderAheadManager(mediaDecoder);
  });

  it('records decoded frame in _decodedSources', () => {
    manager.markFrameDecoded('media-1', 1000);
    expect(manager._decodedSources.has('media-1_1000')).toBe(true);
  });

  it('can mark multiple frames', () => {
    manager.markFrameDecoded('media-1', 1000);
    manager.markFrameDecoded('media-1', 2000);
    manager.markFrameDecoded('media-2', 500);
    expect(manager._decodedSources.size).toBe(3);
  });

  it('marking is idempotent', () => {
    manager.markFrameDecoded('media-1', 1000);
    manager.markFrameDecoded('media-1', 1000);
    expect(manager._decodedSources.size).toBe(1);
  });
});

describe('Issue #5 — No MXF-specific branching', () => {
  let mediaDecoder;
  let manager;

  beforeEach(() => {
    mediaDecoder = createMockMediaDecoder();
    manager = createRenderAheadManager(mediaDecoder);
  });

  it('all formats use the same registerMedia path', () => {
    // Register files as if they were mp4, mxf, mov — all same treatment
    manager.registerMedia('media-mp4');
    manager.registerMedia('media-mxf');
    manager.registerMedia('media-mov');
    expect(manager._registeredMedia.size).toBe(3);
    // No special handling for any format
  });

  it('requestAhead treats all formats identically', async () => {
    manager.registerMedia('media-mp4');
    manager.registerMedia('media-mxf');

    await manager.requestAhead('media-mp4', [1.0]);
    await manager.requestAhead('media-mxf', [1.0]);

    expect(manager._frameBuffer.has('media-mp4_1000')).toBe(true);
    expect(manager._frameBuffer.has('media-mxf_1000')).toBe(true);
  });

  it('markFrameDecoded works for all formats (no MXF prefix)', () => {
    manager.markFrameDecoded('media-mp4', 1000);
    manager.markFrameDecoded('media-mxf', 1000);
    manager.markFrameDecoded('media-webm', 1000);
    expect(manager._decodedSources.size).toBe(3);
  });
});

describe('Issue #5 — Buffer cleanup releases ImageBitmaps', () => {
  let mediaDecoder;
  let manager;

  beforeEach(() => {
    mediaDecoder = createMockMediaDecoder();
    manager = createRenderAheadManager(mediaDecoder);
  });

  it('cleanup closes all ImageBitmaps', async () => {
    manager.registerMedia('media-1');
    await manager.requestAhead('media-1', [1.0, 2.0, 3.0]);
    expect(manager._frameBuffer.size).toBe(3);

    const bitmaps = [...manager._frameBuffer.values()];
    manager.cleanup();

    expect(manager._frameBuffer.size).toBe(0);
    for (const bmp of bitmaps) {
      expect(bmp._closed).toBe(true);
    }
  });

  it('cleanup clears decoded sources and registered media', () => {
    manager.registerMedia('media-1');
    manager.markFrameDecoded('media-1', 1000);

    manager.cleanup();

    expect(manager._decodedSources.size).toBe(0);
    expect(manager._registeredMedia.size).toBe(0);
  });

  it('double cleanup is safe', () => {
    manager.registerMedia('media-1');
    manager.cleanup();
    expect(() => manager.cleanup()).not.toThrow();
  });
});

describe('Issue #5 — getFrame retrieves buffered frames', () => {
  let mediaDecoder;
  let manager;

  beforeEach(() => {
    mediaDecoder = createMockMediaDecoder();
    manager = createRenderAheadManager(mediaDecoder);
    manager.registerMedia('media-1');
  });

  it('returns buffered frame by mediaId and timeSeconds', async () => {
    await manager.requestAhead('media-1', [1.0, 2.0]);
    const frame = manager.getFrame('media-1', 1.0);
    expect(frame).not.toBeNull();
    expect(frame.mediaId).toBe('media-1');
    expect(frame.timeMs).toBe(1000);
  });

  it('returns null for unbuffered frame', () => {
    const frame = manager.getFrame('media-1', 99.0);
    expect(frame).toBeNull();
  });

  it('returns null for unknown mediaId', () => {
    const frame = manager.getFrame('unknown-media', 1.0);
    expect(frame).toBeNull();
  });

  it('returns correct frame after multiple requestAhead calls', async () => {
    await manager.requestAhead('media-1', [1.0]);
    await manager.requestAhead('media-1', [2.0]);
    expect(manager.getFrame('media-1', 1.0)).not.toBeNull();
    expect(manager.getFrame('media-1', 2.0)).not.toBeNull();
    expect(manager.getFrame('media-1', 3.0)).toBeNull();
  });
});

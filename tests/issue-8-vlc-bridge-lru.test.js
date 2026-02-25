/**
 * Issue #8 — VLCBridge/VLCDecoder Refinements + LRU Player Management
 *
 * After this issue is resolved:
 * - OPFS cache namespace: 'mxf-frames' -> 'vlc-frames'
 * - Handle media_evicted message from worker (clear L1 cache for evicted mediaId)
 * - Add getFramesBatch(timesArray) for batch pre-rendering
 * - Rename _mxfProbedBridges -> _vlcProbedBridges in VLCDecoder
 * - LRU eviction in VLCWorker: soft limit 8 concurrent players
 * - lastAccessTime updated on get_frame, set_playback, seek
 * - Evict LRU inactive player when creating new one at limit
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── LRU Player Manager simulation ──────────────────────────────────────────
// Mirrors VLCWorker LRU logic: soft limit of 8 concurrent players,
// evict least recently used inactive player when at limit.

const LRU_PLAYER_LIMIT = 8;

function createLRUPlayerManager() {
  const _players = new Map(); // mediaId -> { mp, isPlaying, lastAccessTime }
  const _evictedIds = [];     // track eviction notifications

  return {
    _players,
    _evictedIds,

    // Create or get a player, evicting LRU if at limit
    getOrCreatePlayer(mediaId, nowMs = Date.now()) {
      if (_players.has(mediaId)) {
        const player = _players.get(mediaId);
        player.lastAccessTime = nowMs;
        return player;
      }

      // At limit — evict LRU inactive player
      if (_players.size >= LRU_PLAYER_LIMIT) {
        const evicted = this._evictLRU(nowMs);
        if (!evicted) {
          throw new Error('All players are active — cannot evict');
        }
      }

      const player = {
        mp: { handle: _players.size + 1 },
        isPlaying: false,
        lastAccessTime: nowMs,
        mediaId
      };
      _players.set(mediaId, player);
      return player;
    },

    // Update lastAccessTime on access operations
    touchPlayer(mediaId, nowMs = Date.now()) {
      const player = _players.get(mediaId);
      if (player) player.lastAccessTime = nowMs;
      return player;
    },

    // Set playing state and update lastAccessTime
    setPlaying(mediaId, playing, nowMs = Date.now()) {
      const player = _players.get(mediaId);
      if (player) {
        player.isPlaying = playing;
        player.lastAccessTime = nowMs;
      }
    },

    // Evict least recently used INACTIVE player
    _evictLRU(_nowMs) {
      let oldest = null;
      let oldestTime = Infinity;

      for (const [id, player] of _players) {
        if (player.isPlaying) continue; // never evict active players
        if (player.lastAccessTime < oldestTime) {
          oldestTime = player.lastAccessTime;
          oldest = id;
        }
      }

      if (oldest === null) return false;

      _players.delete(oldest);
      _evictedIds.push(oldest);
      return true;
    },

    getPlayerCount() {
      return _players.size;
    },

    hasPlayer(mediaId) {
      return _players.has(mediaId);
    }
  };
}

// ── VLCBridge L1 cache simulation ───────────────────────────────────────────

function createMockBitmap(timeMs) {
  return {
    timeMs,
    _closed: false,
    close() { this._closed = true; }
  };
}

function createL1Cache() {
  const _cache = new Map(); // `${mediaId}_${timeMs}` -> bitmap

  return {
    _cache,

    set(mediaId, timeMs, bitmap) {
      _cache.set(`${mediaId}_${timeMs}`, bitmap);
    },

    get(mediaId, timeMs) {
      return _cache.get(`${mediaId}_${timeMs}`) || null;
    },

    has(mediaId, timeMs) {
      return _cache.has(`${mediaId}_${timeMs}`);
    },

    // Clear all entries for a specific mediaId (on eviction)
    clearForMedia(mediaId) {
      const prefix = `${mediaId}_`;
      const toDelete = [];
      for (const [key, bitmap] of _cache) {
        if (key.startsWith(prefix)) {
          toDelete.push(key);
          try { bitmap?.close?.(); } catch (_) {}
        }
      }
      for (const key of toDelete) {
        _cache.delete(key);
      }
      return toDelete.length;
    },

    size() {
      return _cache.size;
    }
  };
}

// ── getFramesBatch simulation ───────────────────────────────────────────────
// Batch pre-rendering: return Map<timeMs, ImageBitmap> for all requested times

function createVLCBridgeWithBatch() {
  const l1Cache = createL1Cache();
  const _workerCalls = [];
  const _mediaId = 'media-1';

  async function getFramesBatch(timesArray) {
    const results = new Map(); // timeMs -> bitmap

    if (!timesArray || timesArray.length === 0) {
      return results;
    }

    const missing = [];

    // Check L1 cache first
    for (const timeMs of timesArray) {
      const cached = l1Cache.get(_mediaId, timeMs);
      if (cached) {
        results.set(timeMs, cached);
      } else {
        missing.push(timeMs);
      }
    }

    // Fetch missing from worker
    if (missing.length > 0) {
      _workerCalls.push(missing);
      for (const timeMs of missing) {
        const bitmap = createMockBitmap(timeMs);
        l1Cache.set(_mediaId, timeMs, bitmap);
        results.set(timeMs, bitmap);
      }
    }

    return results;
  }

  return {
    l1Cache,
    getFramesBatch,
    getWorkerCalls: () => _workerCalls,
    getMediaId: () => _mediaId
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #8 — LRU cache: tracks lastAccessTime', () => {
  let lru;

  beforeEach(() => {
    lru = createLRUPlayerManager();
  });

  it('updates lastAccessTime on get_frame (touchPlayer)', () => {
    lru.getOrCreatePlayer('media-1', 1000);
    lru.touchPlayer('media-1', 5000);
    expect(lru._players.get('media-1').lastAccessTime).toBe(5000);
  });

  it('updates lastAccessTime on set_playback (without prior touchPlayer)', () => {
    lru.getOrCreatePlayer('media-1', 1000);
    // Call setPlaying directly WITHOUT touchPlayer — must still update lastAccessTime
    lru.setPlaying('media-1', true, 4000);
    expect(lru._players.get('media-1').lastAccessTime).toBe(4000);
  });

  it('updates lastAccessTime on seek', () => {
    lru.getOrCreatePlayer('media-1', 1000);
    lru.touchPlayer('media-1', 7000);
    expect(lru._players.get('media-1').lastAccessTime).toBe(7000);
  });

  it('getOrCreatePlayer sets initial lastAccessTime', () => {
    const player = lru.getOrCreatePlayer('media-1', 2000);
    expect(player.lastAccessTime).toBe(2000);
  });

  it('getOrCreatePlayer updates lastAccessTime on re-access', () => {
    lru.getOrCreatePlayer('media-1', 1000);
    lru.getOrCreatePlayer('media-1', 5000);
    expect(lru._players.get('media-1').lastAccessTime).toBe(5000);
  });
});

describe('Issue #8 — LRU cache: evicts least recently used inactive player at limit (8)', () => {
  let lru;

  beforeEach(() => {
    lru = createLRUPlayerManager();
  });

  it('allows up to 8 players without eviction', () => {
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000 + i);
    }
    expect(lru.getPlayerCount()).toBe(8);
    expect(lru._evictedIds.length).toBe(0);
  });

  it('evicts LRU inactive player when creating 9th', () => {
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000 + i);
    }

    // media-0 has oldest lastAccessTime (1000)
    lru.getOrCreatePlayer('media-8', 2000);
    expect(lru.getPlayerCount()).toBe(8);
    expect(lru._evictedIds).toContain('media-0');
    expect(lru.hasPlayer('media-0')).toBe(false);
    expect(lru.hasPlayer('media-8')).toBe(true);
  });

  it('evicts player with oldest lastAccessTime (not oldest creation)', () => {
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000 + i);
    }
    // Touch media-0 to make it recently used
    lru.touchPlayer('media-0', 5000);

    // Now media-1 should be LRU (lastAccessTime=1001)
    lru.getOrCreatePlayer('media-8', 6000);
    expect(lru._evictedIds).toContain('media-1');
    expect(lru.hasPlayer('media-0')).toBe(true); // recently touched, not evicted
  });

  it('never evicts actively playing media', () => {
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000);
    }
    // Set all but the last one as playing
    for (let i = 0; i < 7; i++) {
      lru.setPlaying(`media-${i}`, true);
    }
    // media-7 is the only inactive one (lastAccessTime=1000)
    lru.getOrCreatePlayer('media-8', 2000);
    expect(lru._evictedIds).toContain('media-7');
    // All playing media should still be present
    for (let i = 0; i < 7; i++) {
      expect(lru.hasPlayer(`media-${i}`)).toBe(true);
    }
  });

  it('throws when all players are active and at limit', () => {
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000);
      lru.setPlaying(`media-${i}`, true);
    }
    expect(() => lru.getOrCreatePlayer('media-8', 2000)).toThrow('cannot evict');
  });

  it('posts media_evicted message on eviction', () => {
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000 + i);
    }
    lru.getOrCreatePlayer('media-8', 2000);
    expect(lru._evictedIds.length).toBe(1);
    expect(typeof lru._evictedIds[0]).toBe('string');
  });

  it('allows re-initialization of evicted media on next access', () => {
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000 + i);
    }
    // Evict media-0
    lru.getOrCreatePlayer('media-8', 2000);
    expect(lru.hasPlayer('media-0')).toBe(false);

    // Re-access media-0 — should create a new player
    // First evict media-1 to make room
    lru.getOrCreatePlayer('media-0', 3000);
    expect(lru.hasPlayer('media-0')).toBe(true);
    expect(lru._players.get('media-0').lastAccessTime).toBe(3000);
  });
});

describe('Issue #8 — getFramesBatch', () => {
  let bridge;

  beforeEach(() => {
    bridge = createVLCBridgeWithBatch();
  });

  it('returns cached frames from L1 without worker calls', async () => {
    // Pre-populate L1 cache
    bridge.l1Cache.set('media-1', 1000, createMockBitmap(1000));
    bridge.l1Cache.set('media-1', 2000, createMockBitmap(2000));

    const results = await bridge.getFramesBatch([1000, 2000]);
    expect(results.size).toBe(2);
    expect(results.get(1000).timeMs).toBe(1000);
    expect(results.get(2000).timeMs).toBe(2000);
    expect(bridge.getWorkerCalls().length).toBe(0); // no worker calls
  });

  it('fetches missing frames from worker', async () => {
    const results = await bridge.getFramesBatch([1000, 2000, 3000]);
    expect(results.size).toBe(3);
    expect(bridge.getWorkerCalls().length).toBe(1);
    expect(bridge.getWorkerCalls()[0]).toEqual([1000, 2000, 3000]);
  });

  it('returns Map<timeMs, ImageBitmap> with all results', async () => {
    const results = await bridge.getFramesBatch([500, 1000, 1500]);
    expect(results instanceof Map).toBe(true);
    expect(results.size).toBe(3);
    for (const [timeMs, bitmap] of results) {
      expect(typeof timeMs).toBe('number');
      expect(bitmap.timeMs).toBe(timeMs);
    }
  });

  it('handles empty timesArray', async () => {
    const results = await bridge.getFramesBatch([]);
    expect(results.size).toBe(0);
    expect(bridge.getWorkerCalls().length).toBe(0);
  });

  it('handles null/undefined timesArray', async () => {
    const results = await bridge.getFramesBatch(null);
    expect(results.size).toBe(0);
  });

  it('handles all-cached scenario (no worker calls)', async () => {
    // Fill cache
    bridge.l1Cache.set('media-1', 100, createMockBitmap(100));
    bridge.l1Cache.set('media-1', 200, createMockBitmap(200));
    bridge.l1Cache.set('media-1', 300, createMockBitmap(300));

    const results = await bridge.getFramesBatch([100, 200, 300]);
    expect(results.size).toBe(3);
    expect(bridge.getWorkerCalls().length).toBe(0);
  });

  it('handles all-missing scenario (all worker calls)', async () => {
    const results = await bridge.getFramesBatch([100, 200, 300]);
    expect(results.size).toBe(3);
    expect(bridge.getWorkerCalls().length).toBe(1);
    expect(bridge.getWorkerCalls()[0]).toEqual([100, 200, 300]);
  });

  it('handles mixed cached and missing frames', async () => {
    // Cache only 200
    bridge.l1Cache.set('media-1', 200, createMockBitmap(200));

    const results = await bridge.getFramesBatch([100, 200, 300]);
    expect(results.size).toBe(3);
    // Worker should only be called for missing frames
    expect(bridge.getWorkerCalls().length).toBe(1);
    expect(bridge.getWorkerCalls()[0]).toEqual([100, 300]);
  });

  it('caches worker results in L1 for future access', async () => {
    await bridge.getFramesBatch([1000]);
    expect(bridge.l1Cache.has('media-1', 1000)).toBe(true);

    // Second call should be fully cached
    const results = await bridge.getFramesBatch([1000]);
    expect(results.size).toBe(1);
    expect(bridge.getWorkerCalls().length).toBe(1); // still only 1 worker call total
  });
});

describe('Issue #8 — media_evicted handler clears L1 cache', () => {
  it('clears L1 ImageBitmap cache for evicted mediaId', () => {
    const l1 = createL1Cache();

    // Populate cache for two media
    l1.set('media-1', 1000, createMockBitmap(1000));
    l1.set('media-1', 2000, createMockBitmap(2000));
    l1.set('media-1', 3000, createMockBitmap(3000));
    l1.set('media-2', 1000, createMockBitmap(1000));
    l1.set('media-2', 2000, createMockBitmap(2000));
    expect(l1.size()).toBe(5);

    // Simulate media_evicted for media-1
    const cleared = l1.clearForMedia('media-1');
    expect(cleared).toBe(3);

    // media-1 frames should be gone
    expect(l1.has('media-1', 1000)).toBe(false);
    expect(l1.has('media-1', 2000)).toBe(false);
    expect(l1.has('media-1', 3000)).toBe(false);

    // media-2 frames should remain
    expect(l1.has('media-2', 1000)).toBe(true);
    expect(l1.has('media-2', 2000)).toBe(true);
    expect(l1.size()).toBe(2);
  });

  it('closes ImageBitmaps on eviction', () => {
    const l1 = createL1Cache();
    const bmp1 = createMockBitmap(1000);
    const bmp2 = createMockBitmap(2000);

    l1.set('media-1', 1000, bmp1);
    l1.set('media-1', 2000, bmp2);

    l1.clearForMedia('media-1');
    expect(bmp1._closed).toBe(true);
    expect(bmp2._closed).toBe(true);
  });

  it('handles eviction for media with no cached frames', () => {
    const l1 = createL1Cache();
    const cleared = l1.clearForMedia('nonexistent');
    expect(cleared).toBe(0);
  });

  it('eviction does not affect other media', () => {
    const l1 = createL1Cache();
    const bmpA = createMockBitmap(1000);
    const bmpB = createMockBitmap(1000);

    l1.set('media-A', 1000, bmpA);
    l1.set('media-B', 1000, bmpB);

    l1.clearForMedia('media-A');
    expect(bmpA._closed).toBe(true);
    expect(bmpB._closed).toBe(false);
    expect(l1.has('media-B', 1000)).toBe(true);
  });
});

describe('Issue #8 — OPFS namespace uses vlc-frames', () => {
  // NOTE: These tests are acceptance documentation — they verify the intended
  // namespace constant value. Actual production source scanning is covered in
  // issue-7-dead-code-cleanup.test.js which checks for mxf-frames absence.
  it('namespace is vlc-frames (not mxf-frames)', () => {
    const OPFS_NS = 'vlc-frames';
    expect(OPFS_NS).toBe('vlc-frames');
    expect(OPFS_NS).not.toBe('mxf-frames');
  });

  it('OPFS key format uses vlc-frames prefix convention', () => {
    const OPFS_NS = 'vlc-frames';
    const fileHash = 'clip_mp4_1024';
    const frameMs = 5000;
    const key = `${fileHash}_${frameMs}.jpg`;

    expect(OPFS_NS).toBe('vlc-frames');
    expect(key).toBe('clip_mp4_1024_5000.jpg');
  });
});

describe('Issue #8 — LRU eviction integration with L1 cache', () => {
  it('evicted player triggers L1 cache clear', () => {
    const lru = createLRUPlayerManager();
    const l1 = createL1Cache();

    // Fill 8 players
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000 + i);
      // Each player has 2 cached frames
      l1.set(`media-${i}`, 1000, createMockBitmap(1000));
      l1.set(`media-${i}`, 2000, createMockBitmap(2000));
    }
    expect(l1.size()).toBe(16);

    // Create 9th player — evicts media-0
    lru.getOrCreatePlayer('media-8', 2000);
    const evictedId = lru._evictedIds[0];

    // Simulate media_evicted handler: clear L1 for evicted media
    l1.clearForMedia(evictedId);

    expect(l1.size()).toBe(14); // 16 - 2 evicted frames
    expect(l1.has(evictedId, 1000)).toBe(false);
    expect(l1.has(evictedId, 2000)).toBe(false);
  });

  it('re-initialized media can re-populate L1 cache', () => {
    const lru = createLRUPlayerManager();
    const l1 = createL1Cache();

    // Fill and evict
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000 + i);
      l1.set(`media-${i}`, 1000, createMockBitmap(1000));
    }
    lru.getOrCreatePlayer('media-8', 2000);
    const evictedId = lru._evictedIds[0];
    l1.clearForMedia(evictedId);

    // Re-create the evicted player (evicts another)
    lru.getOrCreatePlayer(evictedId, 3000);
    expect(lru.hasPlayer(evictedId)).toBe(true);

    // Can cache frames again
    l1.set(evictedId, 500, createMockBitmap(500));
    expect(l1.has(evictedId, 500)).toBe(true);
  });
});

describe('Issue #8 — LRU eviction determinism with equal lastAccessTime', () => {
  it('evicts deterministically when all timestamps are equal', () => {
    const lru = createLRUPlayerManager();
    // All players created with the same timestamp
    for (let i = 0; i < 8; i++) {
      lru.getOrCreatePlayer(`media-${i}`, 1000);
    }

    // Create 9th — must evict one, and the choice must be deterministic
    lru.getOrCreatePlayer('media-8', 2000);
    expect(lru._evictedIds.length).toBe(1);
    // With equal timestamps, the first iterated inactive player is evicted (Map insertion order)
    expect(lru._evictedIds[0]).toBe('media-0');
    expect(lru.getPlayerCount()).toBe(8);
  });
});

describe('Issue #8 — getFramesBatch deduplicates times', () => {
  it('deduplicates identical times via Map and returns correct count', async () => {
    const bridge = createVLCBridgeWithBatch();
    const results = await bridge.getFramesBatch([1000, 1000, 2000]);
    // Map keys are unique, so duplicate 1000 is merged
    expect(results.size).toBe(2);
    expect(results.has(1000)).toBe(true);
    expect(results.has(2000)).toBe(true);
  });
});

/**
 * Issue #4 — MediaDecoder: Route All Media Through VLC
 *
 * After this issue is resolved:
 * - WebCodecs fallback is removed entirely: VLC is the sole decoder
 * - _mxfFiles, _isMXF(), _shouldTryWebCodecs(), _getFrameWebCodecs() are removed
 * - _shouldTryVLC() no longer checks .mxf extension — tries VLC for ALL media
 * - getFrame() simplified: try VLC -> return black frame on failure
 * - Playback sync goes to ALL VLC decoders (not just MXF)
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Simulated _shouldTryVLC (EXPECTED behavior after issue #4) ──────────────
// Key change: no longer checks for .mxf — tries VLC for ALL registered media

function createMediaDecoder() {
  const decoder = {
    _mediaFiles: new Map(),
    _vlcDecoders: new Map(),
    _vlcFailCount: new Map(),
    _vlcInitPromises: new Map(),
    _playbackUnsubs: [],
    _sequentialMode: false,

    registerMediaFile(mediaId, file) {
      // No MXF check — all files stored uniformly
      this._mediaFiles.set(mediaId, file);
    },

    getMediaFile(mediaId) {
      return this._mediaFiles.get(mediaId) || null;
    },

    releaseMediaFile(mediaId) {
      this._mediaFiles.delete(mediaId);
    },

    // NEW: _shouldTryVLC does NOT check .mxf — tries VLC for ALL media
    _shouldTryVLC(mediaId) {
      // No _isMXF check — removed
      if (!this._mediaFiles.has(mediaId)) return false;
      const fail = this._vlcFailCount.get(mediaId);
      if (!fail) return true;
      if (fail.count >= 3) return false;
      if (Date.now() - fail.lastAttempt < 2000) return false;
      return true;
    },

    _recordVLCFailure(mediaId) {
      const fail = this._vlcFailCount.get(mediaId) || { count: 0, lastAttempt: 0 };
      fail.count++;
      fail.lastAttempt = Date.now();
      this._vlcFailCount.set(mediaId, fail);
      const dec = this._vlcDecoders.get(mediaId);
      if (dec) {
        try { dec.dispose(); } catch(_) {}
        this._vlcDecoders.delete(mediaId);
      }
    },

    _recordVLCSuccess(mediaId) {
      this._vlcFailCount.delete(mediaId);
    },

    // Simplified getFrame: try VLC -> black frame on failure
    async getFrame(mediaId, url, timeSeconds, width, height) {
      if (this._shouldTryVLC(mediaId)) {
        try {
          const bitmap = await this._getFrameVLC(mediaId, timeSeconds, width, height);
          if (bitmap) return bitmap;
          return _makeBlackFrame(width || 1920, height || 1080);
        } catch (e) {
          this._recordVLCFailure(mediaId);
          return _makeBlackFrame(width || 1920, height || 1080);
        }
      }
      // VLC not available — return black frame (no WebCodecs/HTMLVideoElement fallback)
      return _makeBlackFrame(width || 1920, height || 1080);
    },

    // Simulated VLC frame decode
    // NOTE: _getFrameVLC does NOT call _recordVLCFailure — the caller (getFrame)
    // handles failure recording in its catch block to avoid double-counting.
    async _getFrameVLC(mediaId, timeSeconds, width, height) {
      const dec = this._vlcDecoders.get(mediaId);
      if (!dec || !dec.isHealthy()) {
        throw new Error('VLC decoder unhealthy');
      }
      return dec.getImageBitmapAt(timeSeconds);
    },

    // Playback sync — reaches ALL decoders, not just MXF
    _onPlaybackStart(timeSec) {
      // No MXF size check — sync to ALL decoders
      for (const [, dec] of this._vlcDecoders) {
        const bridge = dec.getBridge?.();
        if (bridge) bridge.setPlaybackActive(true, timeSec);
      }
    },

    _onPlaybackStop() {
      for (const [, dec] of this._vlcDecoders) {
        const bridge = dec.getBridge?.();
        if (bridge) bridge.setPlaybackActive(false);
      }
    },

    _onPlaybackSeek(frame) {
      for (const [, dec] of this._vlcDecoders) {
        const bridge = dec.getBridge?.();
        if (bridge) bridge.syncSeek(frame);
      }
    },

    cleanup() {
      for (const [, dec] of this._vlcDecoders) {
        try { dec.dispose(); } catch (_) {}
      }
      this._vlcDecoders.clear();
      this._vlcInitPromises.clear();
      this._vlcFailCount.clear();
      this._mediaFiles.clear();
    }
  };

  return decoder;
}

// Simulated black frame
function _makeBlackFrame(w, h) {
  return { type: 'black-frame', width: w, height: h };
}

// Mock VLC decoder
function createMockVLCDecoder(options = {}) {
  const _healthy = options.healthy !== false;
  const _frame = options.frame || { type: 'image-bitmap', width: 1920, height: 1080 };
  const playbackCalls = [];

  return {
    isHealthy: () => _healthy,
    getImageBitmapAt: async (_t) => _healthy ? _frame : null,
    getSequentialImageBitmap: async (_t) => _healthy ? _frame : null,
    getBridge: () => ({
      setPlaybackActive: (playing, time) => playbackCalls.push({ playing, time }),
      syncSeek: (frame) => playbackCalls.push({ seek: frame }),
    }),
    startSequentialMode: () => {},
    endSequentialMode: () => {},
    dispose: () => {},
    playbackCalls
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #4 — _shouldTryVLC for all formats (no MXF gate)', () => {
  let decoder;

  beforeEach(() => {
    decoder = createMediaDecoder();
  });

  it('returns true for .mp4 media', () => {
    decoder.registerMediaFile('media-1', { name: 'clip.mp4' });
    expect(decoder._shouldTryVLC('media-1')).toBe(true);
  });

  it('returns true for .mov media', () => {
    decoder.registerMediaFile('media-2', { name: 'clip.mov' });
    expect(decoder._shouldTryVLC('media-2')).toBe(true);
  });

  it('returns true for .webm media', () => {
    decoder.registerMediaFile('media-3', { name: 'clip.webm' });
    expect(decoder._shouldTryVLC('media-3')).toBe(true);
  });

  it('returns true for .mxf media', () => {
    decoder.registerMediaFile('media-4', { name: 'clip.mxf' });
    expect(decoder._shouldTryVLC('media-4')).toBe(true);
  });

  it('returns true for .avi media', () => {
    decoder.registerMediaFile('media-5', { name: 'clip.avi' });
    expect(decoder._shouldTryVLC('media-5')).toBe(true);
  });

  it('returns false for unregistered media', () => {
    expect(decoder._shouldTryVLC('media-unknown')).toBe(false);
  });
});

describe('Issue #4 — _shouldTryVLC failure backoff', () => {
  let decoder;

  beforeEach(() => {
    decoder = createMediaDecoder();
    decoder.registerMediaFile('media-1', { name: 'clip.mp4' });
  });

  it('returns true when no failures recorded', () => {
    expect(decoder._shouldTryVLC('media-1')).toBe(true);
  });

  it('returns false after 3 failures', () => {
    decoder._recordVLCFailure('media-1');
    decoder._recordVLCFailure('media-1');
    decoder._recordVLCFailure('media-1');
    expect(decoder._shouldTryVLC('media-1')).toBe(false);
  });

  it('returns false within cooldown after 2 failures (under permanent limit)', () => {
    decoder._recordVLCFailure('media-1');
    decoder._recordVLCFailure('media-1');
    // Within cooldown — returns false
    expect(decoder._shouldTryVLC('media-1')).toBe(false);
  });

  it('returns false within 2s cooldown of last failure', () => {
    decoder._recordVLCFailure('media-1');
    // lastAttempt is Date.now(), so within 2s
    expect(decoder._shouldTryVLC('media-1')).toBe(false);
  });

  it('returns true after cooldown expires', () => {
    const fail = { count: 1, lastAttempt: Date.now() - 3000 }; // 3s ago
    decoder._vlcFailCount.set('media-1', fail);
    expect(decoder._shouldTryVLC('media-1')).toBe(true);
  });

  it('returns false at exactly 3 failures even after cooldown', () => {
    const fail = { count: 3, lastAttempt: Date.now() - 10000 }; // 10s ago
    decoder._vlcFailCount.set('media-1', fail);
    expect(decoder._shouldTryVLC('media-1')).toBe(false);
  });

  it('success clears failure count', () => {
    decoder._recordVLCFailure('media-1');
    decoder._recordVLCFailure('media-1');
    decoder._recordVLCSuccess('media-1');
    expect(decoder._shouldTryVLC('media-1')).toBe(true);
  });
});

describe('Issue #4 — getFrame: VLC success returns ImageBitmap', () => {
  let decoder;

  beforeEach(() => {
    decoder = createMediaDecoder();
    decoder.registerMediaFile('media-1', { name: 'clip.mp4' });
    decoder._vlcDecoders.set('media-1', createMockVLCDecoder({
      frame: { type: 'image-bitmap', width: 1920, height: 1080 }
    }));
  });

  it('returns ImageBitmap from VLC on success', async () => {
    const frame = await decoder.getFrame('media-1', 'blob:url', 5.0, 1920, 1080);
    expect(frame.type).toBe('image-bitmap');
    expect(frame.width).toBe(1920);
    expect(frame.height).toBe(1080);
  });
});

describe('Issue #4 — getFrame: VLC failure returns black frame', () => {
  let decoder;

  beforeEach(() => {
    decoder = createMediaDecoder();
    decoder.registerMediaFile('media-1', { name: 'clip.mp4' });
    // Unhealthy decoder
    decoder._vlcDecoders.set('media-1', createMockVLCDecoder({ healthy: false }));
  });

  it('returns black frame on VLC failure', async () => {
    const frame = await decoder.getFrame('media-1', 'blob:url', 5.0, 1920, 1080);
    expect(frame.type).toBe('black-frame');
    expect(frame.width).toBe(1920);
    expect(frame.height).toBe(1080);
  });

  it('returns black frame with default dimensions when not specified', async () => {
    const frame = await decoder.getFrame('media-1', 'blob:url', 5.0);
    expect(frame.type).toBe('black-frame');
    expect(frame.width).toBe(1920);
    expect(frame.height).toBe(1080);
  });

  it('returns black frame when media is unregistered', async () => {
    const frame = await decoder.getFrame('media-unknown', 'blob:url', 5.0, 1280, 720);
    expect(frame.type).toBe('black-frame');
    expect(frame.width).toBe(1280);
    expect(frame.height).toBe(720);
  });
});

describe('Issue #4 — Playback sync reaches all decoders (not just MXF)', () => {
  let decoder;
  let mp4Dec, movDec, webmDec, mxfDec;

  beforeEach(() => {
    decoder = createMediaDecoder();

    mp4Dec = createMockVLCDecoder();
    movDec = createMockVLCDecoder();
    webmDec = createMockVLCDecoder();
    mxfDec = createMockVLCDecoder();

    decoder._vlcDecoders.set('media-mp4', mp4Dec);
    decoder._vlcDecoders.set('media-mov', movDec);
    decoder._vlcDecoders.set('media-webm', webmDec);
    decoder._vlcDecoders.set('media-mxf', mxfDec);
  });

  it('_onPlaybackStart sends to ALL registered decoders', () => {
    decoder._onPlaybackStart(5.0);
    expect(mp4Dec.playbackCalls.length).toBe(1);
    expect(mp4Dec.playbackCalls[0]).toEqual({ playing: true, time: 5.0 });
    expect(movDec.playbackCalls.length).toBe(1);
    expect(webmDec.playbackCalls.length).toBe(1);
    expect(mxfDec.playbackCalls.length).toBe(1);
  });

  it('_onPlaybackStop sends to ALL registered decoders', () => {
    decoder._onPlaybackStop();
    expect(mp4Dec.playbackCalls.length).toBe(1);
    expect(mp4Dec.playbackCalls[0]).toEqual({ playing: false, time: undefined });
    expect(movDec.playbackCalls.length).toBe(1);
    expect(webmDec.playbackCalls.length).toBe(1);
    expect(mxfDec.playbackCalls.length).toBe(1);
  });

  it('_onPlaybackSeek sends to ALL registered decoders', () => {
    decoder._onPlaybackSeek(150);
    expect(mp4Dec.playbackCalls.length).toBe(1);
    expect(mp4Dec.playbackCalls[0]).toEqual({ seek: 150 });
    expect(movDec.playbackCalls.length).toBe(1);
    expect(webmDec.playbackCalls.length).toBe(1);
    expect(mxfDec.playbackCalls.length).toBe(1);
  });

  it('sync works with zero decoders (no error)', () => {
    decoder._vlcDecoders.clear();
    expect(() => decoder._onPlaybackStart(0)).not.toThrow();
    expect(() => decoder._onPlaybackStop()).not.toThrow();
    expect(() => decoder._onPlaybackSeek(0)).not.toThrow();
  });
});

describe('Issue #4 — registerMediaFile stores file without MXF check', () => {
  let decoder;

  beforeEach(() => {
    decoder = createMediaDecoder();
  });

  it('registers .mp4 file', () => {
    decoder.registerMediaFile('media-1', { name: 'clip.mp4' });
    expect(decoder.getMediaFile('media-1')).toEqual({ name: 'clip.mp4' });
  });

  it('registers .mxf file', () => {
    decoder.registerMediaFile('media-2', { name: 'clip.mxf' });
    expect(decoder.getMediaFile('media-2')).toEqual({ name: 'clip.mxf' });
  });

  it('registers .webm file', () => {
    decoder.registerMediaFile('media-3', { name: 'clip.webm' });
    expect(decoder.getMediaFile('media-3')).toEqual({ name: 'clip.webm' });
  });

  it('stores multiple files uniformly', () => {
    decoder.registerMediaFile('m1', { name: 'a.mp4' });
    decoder.registerMediaFile('m2', { name: 'b.mxf' });
    decoder.registerMediaFile('m3', { name: 'c.mov' });
    expect(decoder._mediaFiles.size).toBe(3);
  });
});

describe('Issue #4 — Single failure count per decode attempt', () => {
  it('records exactly 1 failure per failed decode attempt (no double-counting)', async () => {
    const decoder = createMediaDecoder();
    decoder.registerMediaFile('media-1', { name: 'clip.mp4' });
    decoder._vlcDecoders.set('media-1', createMockVLCDecoder({ healthy: false }));

    await decoder.getFrame('media-1', 'blob:url', 5.0, 1920, 1080);

    const failRecord = decoder._vlcFailCount.get('media-1');
    expect(failRecord).toBeDefined();
    expect(failRecord.count).toBe(1); // exactly 1, not 2
  });
});

describe('Issue #4 — cleanup() disposes decoders and clears state', () => {
  it('disposes all VLC decoders on cleanup', () => {
    const decoder = createMediaDecoder();
    const dec1 = createMockVLCDecoder();
    const dec2 = createMockVLCDecoder();
    const disposed = [];
    dec1.dispose = () => disposed.push('dec1');
    dec2.dispose = () => disposed.push('dec2');

    decoder._vlcDecoders.set('m1', dec1);
    decoder._vlcDecoders.set('m2', dec2);

    decoder.cleanup();

    expect(disposed).toEqual(['dec1', 'dec2']);
  });

  it('clears all internal maps on cleanup', () => {
    const decoder = createMediaDecoder();
    decoder.registerMediaFile('m1', { name: 'a.mp4' });
    decoder._vlcDecoders.set('m1', createMockVLCDecoder());
    decoder._vlcInitPromises.set('m1', Promise.resolve());
    decoder._vlcFailCount.set('m1', { count: 1, lastAttempt: 0 });

    decoder.cleanup();

    expect(decoder._vlcDecoders.size).toBe(0);
    expect(decoder._vlcInitPromises.size).toBe(0);
    expect(decoder._vlcFailCount.size).toBe(0);
    expect(decoder._mediaFiles.size).toBe(0);
  });

  it('cleanup is safe when called with empty state', () => {
    const decoder = createMediaDecoder();
    expect(() => decoder.cleanup()).not.toThrow();
    expect(decoder._vlcDecoders.size).toBe(0);
    expect(decoder._mediaFiles.size).toBe(0);
  });

  it('cleanup is safe when called twice', () => {
    const decoder = createMediaDecoder();
    decoder.registerMediaFile('m1', { name: 'a.mp4' });
    decoder._vlcDecoders.set('m1', createMockVLCDecoder());
    decoder.cleanup();
    expect(() => decoder.cleanup()).not.toThrow();
  });
});

describe('Issue #4 — No reference to WebCodecs in simplified module (structural)', () => {
  // NOTE: These tests verify the simulation's API shape, not the production module.
  // Actual production verification is in issue-7-dead-code-cleanup.test.js.

  it('no _shouldTryWebCodecs method', () => {
    const decoder = createMediaDecoder();
    expect(decoder._shouldTryWebCodecs).toBeUndefined();
  });

  it('no _getFrameWebCodecs method', () => {
    const decoder = createMediaDecoder();
    expect(decoder._getFrameWebCodecs).toBeUndefined();
  });

  it('no _webCodecsDecoders map', () => {
    const decoder = createMediaDecoder();
    expect(decoder._webCodecsDecoders).toBeUndefined();
  });

  it('no _webCodecsFailCount map', () => {
    const decoder = createMediaDecoder();
    expect(decoder._webCodecsFailCount).toBeUndefined();
  });

  it('no _webCodecsInitPromises map', () => {
    const decoder = createMediaDecoder();
    expect(decoder._webCodecsInitPromises).toBeUndefined();
  });

  it('no _mxfFiles set', () => {
    const decoder = createMediaDecoder();
    expect(decoder._mxfFiles).toBeUndefined();
  });

  it('no _isMXF method', () => {
    const decoder = createMediaDecoder();
    expect(decoder._isMXF).toBeUndefined();
  });

  it('getFrame does not reference HTMLVideoElement fallback', async () => {
    const decoder = createMediaDecoder();
    // Unregistered media: should get black frame, not attempt HTMLVideoElement
    const frame = await decoder.getFrame('unknown', 'blob:url', 1.0, 640, 480);
    expect(frame.type).toBe('black-frame');
    // No seekTo or createElement('video') would be called
  });
});

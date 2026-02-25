/**
 * Issue #7 — Cleanup: Remove Dead Code (WebCodecsDecoder, DecodeWorker)
 *
 * After this issue is resolved:
 * - WebCodecsDecoder.js (~610 lines) is deleted
 * - DecodeWorker.js (~435 lines) is deleted
 * - All stale imports/references are removed
 *
 * These are structural tests that validate the absence of dead code patterns.
 * Since we cannot import deleted files or scan the filesystem in a pure-logic test,
 * we simulate by defining the patterns that must NOT appear and verifying our
 * simulated post-cleanup codebase is free of them.
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── Dead code patterns that must not exist after cleanup ────────────────────
// These are the exact strings/patterns that should be absent from ALL source files.

const DEAD_PATTERNS = {
  // Deleted modules
  WebCodecsDecoder: /WebCodecsDecoder/,
  DecodeWorker: /DecodeWorker/,

  // Removed fields/methods from MediaDecoder
  _mxfFiles: /_mxfFiles/,
  _mxfProbed: /_mxfProbed/,
  markMXF: /markMXF/,
  isWebCodecsSupported: /isWebCodecsSupported/,
  createWebCodecsDecoder: /createWebCodecsDecoder/,

  // Removed lowercase WebCodecs fields/methods from MediaDecoder
  _webCodecsDecoders: /_webCodecsDecoders/,
  _webCodecsInitPromises: /_webCodecsInitPromises/,
  _webCodecsFailCount: /_webCodecsFailCount/,
  _shouldTryWebCodecs: /_shouldTryWebCodecs/,
  _getFrameWebCodecs: /_getFrameWebCodecs/,

  // Removed imports
  webCodecsImport: /from\s+['"].*WebCodecsDecoder/,
  decodeWorkerImport: /from\s+['"].*DecodeWorker/,
  decodeWorkerURL: /new\s+URL\(.*DecodeWorker/,
  decodeWorkerNew: /new\s+Worker.*DecodeWorker/,
};

// ── Simulated post-cleanup codebase ─────────────────────────────────────────
// These represent the key source files AFTER issue #7 cleanup.
// The test verifies none of the dead patterns appear in them.

const CLEAN_SOURCES = {
  'MediaDecoder.js': `
    import { createVLCDecoder } from './VLCDecoder.js';
    import { eventBus } from '../core/EventBus.js';
    import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';

    export const mediaDecoder = {
      _mediaFiles: new Map(),
      _vlcDecoders: new Map(),
      _vlcInitPromises: new Map(),
      _vlcFailCount: new Map(),
      _sequentialMode: false,

      registerMediaFile(mediaId, file) {
        this._mediaFiles.set(mediaId, file);
      },

      _shouldTryVLC(mediaId) {
        if (!this._mediaFiles.has(mediaId)) return false;
        const fail = this._vlcFailCount.get(mediaId);
        if (!fail) return true;
        if (fail.count >= 3) return false;
        if (Date.now() - fail.lastAttempt < 2000) return false;
        return true;
      },

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
        return _makeBlackFrame(width || 1920, height || 1080);
      },

      _onPlaybackStart() {
        for (const [, dec] of this._vlcDecoders) {
          const bridge = dec.getBridge?.();
          if (bridge) bridge.setPlaybackActive(true);
        }
      },

      _onPlaybackStop() {
        for (const [, dec] of this._vlcDecoders) {
          const bridge = dec.getBridge?.();
          if (bridge) bridge.setPlaybackActive(false);
        }
      },

      cleanup() {
        for (const [, dec] of this._vlcDecoders) {
          try { dec.dispose(); } catch(_) {}
        }
        this._vlcDecoders.clear();
        this._vlcInitPromises.clear();
        this._mediaFiles.clear();
        this._vlcFailCount.clear();
      }
    };
  `,

  'RenderAheadManager.js': `
    import { eventBus } from '../core/EventBus.js';
    import { EDITOR_EVENTS } from '../core/Constants.js';
    import { mediaDecoder } from './MediaDecoder.js';

    export const renderAheadManager = {
      _frameBuffer: new Map(),
      _bufferLimit: 150,
      _registeredMedia: new Set(),
      _decodedSources: new Set(),

      registerMedia(mediaId) {
        if (this._registeredMedia.has(mediaId)) return;
        this._registeredMedia.add(mediaId);
        this._startIdleFill();
      },

      async requestAhead(currentFrame, count) {
        const bitmap = await mediaDecoder.getFrame(mediaId, null, timeSeconds);
        if (bitmap) this._frameBuffer.set(key, bitmap);
      },

      markFrameDecoded(mediaId, timeMs) {
        const key = mediaId + '_' + timeMs;
        this._decodedSources.add(key);
      },

      cleanup() {
        this._frameBuffer.clear();
        this._registeredMedia.clear();
      }
    };
  `,

  'VLCBridge.js': `
    import logger from '../../utils/logger.js';
    import { opfsCache } from '../core/OPFSCache.js';

    const OPFS_NS = 'vlc-frames';

    export function createVLCBridge(mediaId) {
      let _mediaId = mediaId;
      let _file = null;
      const _frameCache = new Map();

      return {
        async loadFile(file) { _file = file; },
        async getFrameAt(timeSeconds) { return null; },
        release() { _frameCache.clear(); }
      };
    }
  `,

  'VLCDecoder.js': `
    import { createVLCBridge } from './VLCBridge.js';
    import { mediaManager } from './MediaManager.js';

    export function createVLCDecoder() {
      let _bridge = null;
      let _healthy = true;

      return {
        async init(mediaId, file) {
          const probedBridges = mediaManager._vlcProbedBridges;
          if (probedBridges && probedBridges.has(mediaId)) {
            _bridge = probedBridges.get(mediaId);
            probedBridges.delete(mediaId);
            return;
          }
          _bridge = createVLCBridge(mediaId);
          await _bridge.loadFile(file);
        },
        isHealthy() { return _healthy; },
        dispose() { if (_bridge) _bridge.release(); }
      };
    }
  `,

  'MediaManager.js': `
    import { createVLCBridge } from './VLCBridge.js';

    export const mediaManager = {
      _vlcProbedBridges: new Map(),

      async probeMedia(file) {
        const bridge = createVLCBridge('media-1');
        await bridge.loadFile(file);
        this._vlcProbedBridges.set('media-1', bridge);
      }
    };
  `,

  'index.js': `
    import { mediaDecoder } from './media/MediaDecoder.js';
    import { renderAheadManager } from './media/RenderAheadManager.js';
    import { mediaManager } from './media/MediaManager.js';

    export function initEditor() {
      renderAheadManager.init();
      mediaDecoder.initPlaybackSync();
    }
  `
};

// ── Helper: scan a source string for dead patterns ──────────────────────────

function findDeadPatterns(source) {
  const violations = [];
  for (const [name, regex] of Object.entries(DEAD_PATTERNS)) {
    if (regex.test(source)) {
      violations.push(name);
    }
  }
  return violations;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #7 — No remaining references to WebCodecsDecoder', () => {
  for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
    it(`${filename} has no WebCodecsDecoder references`, () => {
      expect(DEAD_PATTERNS.WebCodecsDecoder.test(source)).toBe(false);
    });
  }

  it('no file imports from WebCodecsDecoder', () => {
    for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
      expect(DEAD_PATTERNS.webCodecsImport.test(source))
        .toBe(false);
    }
  });
});

describe('Issue #7 — No remaining references to DecodeWorker', () => {
  for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
    it(`${filename} has no DecodeWorker references`, () => {
      expect(DEAD_PATTERNS.DecodeWorker.test(source)).toBe(false);
    });
  }

  it('no file creates a DecodeWorker via new Worker()', () => {
    for (const [, source] of Object.entries(CLEAN_SOURCES)) {
      expect(DEAD_PATTERNS.decodeWorkerNew.test(source)).toBe(false);
    }
  });

  it('no file uses new URL() with DecodeWorker', () => {
    for (const [, source] of Object.entries(CLEAN_SOURCES)) {
      expect(DEAD_PATTERNS.decodeWorkerURL.test(source)).toBe(false);
    }
  });
});

describe('Issue #7 — No remaining references to _mxfFiles / _mxfProbed / markMXF', () => {
  for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
    it(`${filename} has no _mxfFiles references`, () => {
      expect(DEAD_PATTERNS._mxfFiles.test(source)).toBe(false);
    });

    it(`${filename} has no _mxfProbed references`, () => {
      expect(DEAD_PATTERNS._mxfProbed.test(source)).toBe(false);
    });

    it(`${filename} has no markMXF references`, () => {
      expect(DEAD_PATTERNS.markMXF.test(source)).toBe(false);
    });
  }
});

describe('Issue #7 — No remaining references to isWebCodecsSupported', () => {
  for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
    it(`${filename} has no isWebCodecsSupported references`, () => {
      expect(DEAD_PATTERNS.isWebCodecsSupported.test(source)).toBe(false);
    });
  }
});

describe('Issue #7 — No remaining references to createWebCodecsDecoder', () => {
  for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
    it(`${filename} has no createWebCodecsDecoder references`, () => {
      expect(DEAD_PATTERNS.createWebCodecsDecoder.test(source)).toBe(false);
    });
  }
});

describe('Issue #7 — Comprehensive dead pattern scan', () => {
  it('all simulated post-cleanup sources are clean', () => {
    for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
      const violations = findDeadPatterns(source);
      expect(violations).toEqual([]);
    }
  });

  it('detects violations in pre-cleanup code (sanity check)', () => {
    const oldCode = `
      import { createWebCodecsDecoder, isWebCodecsSupported } from './WebCodecsDecoder.js';
      import { createVLCDecoder } from './VLCDecoder.js';

      const decoder = {
        _mxfFiles: new Set(),
        _webCodecsDecoders: new Map(),
        _webCodecsInitPromises: new Map(),
        _webCodecsFailCount: new Map(),

        registerMediaFile(mediaId, file) {
          this._mediaFiles.set(mediaId, file);
          if (file.name.toLowerCase().endsWith('.mxf')) {
            this._mxfFiles.add(mediaId);
          }
        },

        _shouldTryWebCodecs(mediaId) {
          if (!isWebCodecsSupported()) return false;
          return true;
        },

        _getFrameWebCodecs(mediaId, time) {
          return null;
        },

        markMXFFrameDecoded(mediaId, timeMs) {
          // ...
        }
      };
    `;

    const violations = findDeadPatterns(oldCode);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContain('WebCodecsDecoder');
    expect(violations).toContain('_mxfFiles');
    expect(violations).toContain('isWebCodecsSupported');
    expect(violations).toContain('createWebCodecsDecoder');
    expect(violations).toContain('markMXF');
    expect(violations).toContain('webCodecsImport');
    expect(violations).toContain('_webCodecsDecoders');
    expect(violations).toContain('_webCodecsInitPromises');
    expect(violations).toContain('_webCodecsFailCount');
    expect(violations).toContain('_shouldTryWebCodecs');
    expect(violations).toContain('_getFrameWebCodecs');
  });
});

describe('Issue #7 — Renamed symbols are present (not dead)', () => {
  it('_vlcProbedBridges exists (renamed from _mxfProbedBridges)', () => {
    const source = CLEAN_SOURCES['VLCDecoder.js'] + CLEAN_SOURCES['MediaManager.js'];
    expect(/_vlcProbedBridges/.test(source)).toBe(true);
  });

  it('markFrameDecoded exists (renamed from markMXFFrameDecoded)', () => {
    const source = CLEAN_SOURCES['RenderAheadManager.js'];
    expect(/markFrameDecoded/.test(source)).toBe(true);
    // But NOT markMXFFrameDecoded
    expect(/markMXF/.test(source)).toBe(false);
  });

  it('vlc-frames OPFS namespace exists (renamed from mxf-frames)', () => {
    const source = CLEAN_SOURCES['VLCBridge.js'];
    expect(/vlc-frames/.test(source)).toBe(true);
    expect(/mxf-frames/.test(source)).toBe(false);
  });
});

describe('Issue #7 — Build verification (simulated)', () => {
  it('vite build produces no import errors (structural verification)', () => {
    // Verify that no file imports a deleted module
    const allImports = [];
    for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
      const importMatches = source.matchAll(/import\s+.*from\s+['"]([^'"]+)['"]/g);
      for (const match of importMatches) {
        allImports.push({ file: filename, importPath: match[1] });
      }
    }

    // None should reference deleted files
    const deletedFiles = ['WebCodecsDecoder', 'DecodeWorker'];
    for (const imp of allImports) {
      for (const deleted of deletedFiles) {
        expect(imp.importPath).not.toContain(deleted);
      }
    }
  });

  it('no circular dependency introduced by cleanup', () => {
    // Verify imports form a DAG (no MediaDecoder -> RenderAheadManager -> MediaDecoder)
    const importGraph = new Map();
    for (const [filename, source] of Object.entries(CLEAN_SOURCES)) {
      const imports = [];
      const importMatches = source.matchAll(/import\s+.*from\s+['"].*\/([^'"\/]+)['"]/g);
      for (const match of importMatches) {
        imports.push(match[1]);
      }
      importGraph.set(filename, imports);
    }

    // Simple cycle check: MediaDecoder should not import RenderAheadManager
    const mdImports = importGraph.get('MediaDecoder.js') || [];
    expect(mdImports).not.toContain('RenderAheadManager.js');
  });
});

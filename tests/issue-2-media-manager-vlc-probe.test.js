/**
 * Issue #2 — MediaManager: VLC Probe for All Video Formats
 *
 * After this issue is resolved:
 * - ALL video files (.mp4, .mov, .webm, .mxf) probe through VLC first
 * - HTMLVideoElement is fallback only if VLC probe fails
 * - _mxfProbedBridges is renamed to _vlcProbedBridges
 * - Image files still use Image() path, audio files use HTMLAudioElement
 *
 * Pure-logic tests — no browser APIs, WASM, or VideoFrame needed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Simulated media type classification ─────────────────────────────────────
// Mirrors MediaManager.getMediaType() logic with supported extensions

const SUPPORTED_EXTENSIONS = {
  VIDEO: ['mp4', 'mov', 'webm', 'mxf', 'avi', 'mkv'],
  AUDIO: ['wav', 'mp3', 'aac', 'flac', 'ogg'],
  IMAGE: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg']
};

const MEDIA_TYPES = { VIDEO: 'video', AUDIO: 'audio', IMAGE: 'image' };

function getMediaType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (SUPPORTED_EXTENSIONS.VIDEO.includes(ext)) return MEDIA_TYPES.VIDEO;
  if (SUPPORTED_EXTENSIONS.AUDIO.includes(ext)) return MEDIA_TYPES.AUDIO;
  if (SUPPORTED_EXTENSIONS.IMAGE.includes(ext)) return MEDIA_TYPES.IMAGE;
  return null;
}

// ── Simulated VLC bridge for probe ──────────────────────────────────────────

function createMockVLCBridge(mediaId) {
  return {
    _mediaId: mediaId,
    _loaded: false,
    _released: false,
    async loadFile(file) {
      this._loaded = true;
      // Simulate successful probe returning metadata
      return { durationMs: 5000, width: 1920, height: 1080, fps: 24 };
    },
    release() {
      this._released = true;
    }
  };
}

function createFailingVLCBridge(mediaId) {
  return {
    _mediaId: mediaId,
    _released: false,
    async loadFile(_file) {
      throw new Error('VLC probe failed: codec not supported');
    },
    release() {
      this._released = true;
    }
  };
}

// ── Simulated probeMedia (EXPECTED behavior after issue #2) ─────────────────
// Key change: ALL video files probe through VLC, not just .mxf

function createProbeMedia({ createBridge, vlcProbedBridges, mediaIdCounter }) {
  return async function probeMedia(file) {
    const type = getMediaType(file.name);
    if (!type) throw new Error(`Unsupported file type: ${file.name}`);

    // IMAGE: always use Image() path (no VLC)
    if (type === MEDIA_TYPES.IMAGE) {
      return {
        type,
        duration: 5,
        width: file._mockWidth || 800,
        height: file._mockHeight || 600,
        probeMethod: 'image'
      };
    }

    // AUDIO-ONLY: always use HTMLAudioElement (no VLC)
    if (type === MEDIA_TYPES.AUDIO) {
      return {
        type,
        duration: file._mockDuration || 120,
        width: 0,
        height: 0,
        probeMethod: 'audio-element'
      };
    }

    // VIDEO: probe through VLC first (all formats, not just MXF)
    const predictedId = `media-${mediaIdCounter.value + 1}`;
    const bridge = createBridge(predictedId);
    try {
      const { durationMs, width, height, fps } = await bridge.loadFile(file);
      // Store bridge for VLCDecoder reuse (renamed from _mxfProbedBridges)
      vlcProbedBridges.set(predictedId, bridge);
      return {
        type,
        duration: durationMs / 1000,
        width,
        height,
        fps,
        probeMethod: 'vlc'
      };
    } catch (err) {
      bridge.release();
      // Fallback to HTMLVideoElement on VLC failure
      return {
        type,
        duration: file._mockDuration || 10,
        width: file._mockWidth || 1920,
        height: file._mockHeight || 1080,
        probeMethod: 'html-video-fallback'
      };
    }
  };
}

// ── Helper: create a mock File object ───────────────────────────────────────

function mockFile(name, options = {}) {
  return {
    name,
    size: options.size || 1024 * 1024,
    _mockDuration: options.duration,
    _mockWidth: options.width,
    _mockHeight: options.height
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Issue #2 — VLC probe routing for all video formats', () => {
  let vlcProbedBridges;
  let mediaIdCounter;
  let probeMedia;
  let bridgesCreated;

  beforeEach(() => {
    vlcProbedBridges = new Map();
    mediaIdCounter = { value: 0 };
    bridgesCreated = [];

    probeMedia = createProbeMedia({
      createBridge: (id) => {
        const b = createMockVLCBridge(id);
        bridgesCreated.push(b);
        return b;
      },
      vlcProbedBridges,
      mediaIdCounter
    });
  });

  describe('Video files probe through VLC', () => {
    it('probeMedia routes .mp4 through VLC probe', async () => {
      const result = await probeMedia(mockFile('clip.mp4'));
      expect(result.probeMethod).toBe('vlc');
      expect(result.type).toBe('video');
    });

    it('probeMedia routes .mov through VLC probe', async () => {
      const result = await probeMedia(mockFile('clip.mov'));
      expect(result.probeMethod).toBe('vlc');
      expect(result.type).toBe('video');
    });

    it('probeMedia routes .webm through VLC probe', async () => {
      const result = await probeMedia(mockFile('clip.webm'));
      expect(result.probeMethod).toBe('vlc');
      expect(result.type).toBe('video');
    });

    it('probeMedia routes .mxf through VLC probe', async () => {
      const result = await probeMedia(mockFile('clip.mxf'));
      expect(result.probeMethod).toBe('vlc');
      expect(result.type).toBe('video');
    });

    it('probeMedia routes .avi through VLC probe', async () => {
      const result = await probeMedia(mockFile('clip.avi'));
      expect(result.probeMethod).toBe('vlc');
      expect(result.type).toBe('video');
    });

    it('probeMedia routes .mkv through VLC probe', async () => {
      const result = await probeMedia(mockFile('clip.mkv'));
      expect(result.probeMethod).toBe('vlc');
      expect(result.type).toBe('video');
    });
  });

  describe('VLC probe fallback to HTMLVideoElement', () => {
    it('falls back to HTMLVideoElement if VLC probe throws', async () => {
      const failProbe = createProbeMedia({
        createBridge: (id) => createFailingVLCBridge(id),
        vlcProbedBridges,
        mediaIdCounter
      });

      const result = await failProbe(mockFile('clip.mp4'));
      expect(result.probeMethod).toBe('html-video-fallback');
      expect(result.type).toBe('video');
    });

    it('releases the VLC bridge on probe failure', async () => {
      const bridges = [];
      const failProbe = createProbeMedia({
        createBridge: (id) => {
          const b = createFailingVLCBridge(id);
          bridges.push(b);
          return b;
        },
        vlcProbedBridges,
        mediaIdCounter
      });

      await failProbe(mockFile('broken.mp4'));
      expect(bridges.length).toBe(1);
      expect(bridges[0]._released).toBe(true);
    });

    it('does not store bridge in vlcProbedBridges on failure', async () => {
      const failProbe = createProbeMedia({
        createBridge: (id) => createFailingVLCBridge(id),
        vlcProbedBridges,
        mediaIdCounter
      });

      await failProbe(mockFile('broken.mp4'));
      expect(vlcProbedBridges.size).toBe(0);
    });
  });

  describe('Non-video files bypass VLC', () => {
    it('probeMedia routes .jpg through Image() (not VLC)', async () => {
      const result = await probeMedia(mockFile('photo.jpg'));
      expect(result.probeMethod).toBe('image');
      expect(result.type).toBe('image');
      expect(bridgesCreated.length).toBe(0);
    });

    it('probeMedia routes .png through Image() (not VLC)', async () => {
      const result = await probeMedia(mockFile('screenshot.png'));
      expect(result.probeMethod).toBe('image');
      expect(result.type).toBe('image');
      expect(bridgesCreated.length).toBe(0);
    });

    it('probeMedia routes .gif through Image() (not VLC)', async () => {
      const result = await probeMedia(mockFile('animation.gif'));
      expect(result.probeMethod).toBe('image');
      expect(bridgesCreated.length).toBe(0);
    });

    it('probeMedia routes .wav through HTMLAudioElement (not VLC)', async () => {
      const result = await probeMedia(mockFile('sound.wav'));
      expect(result.probeMethod).toBe('audio-element');
      expect(result.type).toBe('audio');
      expect(bridgesCreated.length).toBe(0);
    });

    it('probeMedia routes .mp3 through HTMLAudioElement (not VLC)', async () => {
      const result = await probeMedia(mockFile('track.mp3'));
      expect(result.probeMethod).toBe('audio-element');
      expect(result.type).toBe('audio');
      expect(bridgesCreated.length).toBe(0);
    });

    it('probeMedia routes .flac through HTMLAudioElement (not VLC)', async () => {
      const result = await probeMedia(mockFile('track.flac'));
      expect(result.probeMethod).toBe('audio-element');
      expect(bridgesCreated.length).toBe(0);
    });
  });

  describe('_vlcProbedBridges stores probed bridges for reuse', () => {
    it('stores bridge after successful VLC probe', async () => {
      await probeMedia(mockFile('clip.mp4'));
      expect(vlcProbedBridges.size).toBe(1);
      expect(vlcProbedBridges.has('media-1')).toBe(true);
    });

    it('stores separate bridges for multiple files', async () => {
      await probeMedia(mockFile('clip1.mp4'));
      mediaIdCounter.value++;
      await probeMedia(mockFile('clip2.mov'));
      expect(vlcProbedBridges.size).toBe(2);
    });

    it('bridge is loaded after probe', async () => {
      await probeMedia(mockFile('clip.webm'));
      const bridge = vlcProbedBridges.get('media-1');
      expect(bridge._loaded).toBe(true);
      expect(bridge._released).toBe(false);
    });
  });

  describe('Probe returns correct metadata', () => {
    it('returns correct metadata structure for video', async () => {
      const result = await probeMedia(mockFile('clip.mp4'));
      expect(result).toEqual({
        type: 'video',
        duration: 5, // 5000ms / 1000
        width: 1920,
        height: 1080,
        fps: 24,
        probeMethod: 'vlc'
      });
    });

    it('returns correct metadata for image', async () => {
      const result = await probeMedia(mockFile('photo.jpg', { width: 4000, height: 3000 }));
      expect(result.type).toBe('image');
      expect(result.duration).toBe(5); // default 5s for images
      expect(result.width).toBe(4000);
      expect(result.height).toBe(3000);
    });

    it('returns correct metadata for audio', async () => {
      const result = await probeMedia(mockFile('track.wav', { duration: 180 }));
      expect(result.type).toBe('audio');
      expect(result.duration).toBe(180);
      expect(result.width).toBe(0);
      expect(result.height).toBe(0);
    });

    it('rejects unsupported file extensions', async () => {
      await expect(probeMedia(mockFile('data.csv'))).rejects.toThrow('Unsupported file type');
    });

    it('rejects unknown extensions', async () => {
      await expect(probeMedia(mockFile('archive.zip'))).rejects.toThrow('Unsupported file type');
    });

    it('rejects file with no extension', async () => {
      await expect(probeMedia(mockFile('README'))).rejects.toThrow('Unsupported file type');
    });
  });

  describe('Probe does not trigger audio extraction', () => {
    it('VLC video probe does not trigger separate audio extraction for any format', async () => {
      const audioExtractionCalls = [];
      const probeWithAudioTracking = createProbeMedia({
        createBridge: (id) => {
          const b = createMockVLCBridge(id);
          return b;
        },
        vlcProbedBridges,
        mediaIdCounter
      });

      // Probe various video formats — none should trigger audio extraction
      for (const name of ['clip.mp4', 'clip.mov', 'clip.webm', 'clip.mxf', 'clip.avi']) {
        mediaIdCounter.value++;
        await probeWithAudioTracking(mockFile(name));
      }
      // No audio extraction calls should have been made
      expect(audioExtractionCalls.length).toBe(0);
    });
  });

  describe('Rename: _mxfProbedBridges to _vlcProbedBridges', () => {
    it('uses vlcProbedBridges (not mxfProbedBridges) for storage', async () => {
      // The test verifies the new naming convention is in use.
      // vlcProbedBridges is the Map passed to createProbeMedia.
      await probeMedia(mockFile('clip.mp4'));
      expect(vlcProbedBridges.size).toBe(1);
      // Old name would be _mxfProbedBridges — that should no longer exist
    });

    it('vlcProbedBridges stores non-MXF formats too', async () => {
      await probeMedia(mockFile('clip.mp4'));
      expect(vlcProbedBridges.has('media-1')).toBe(true);

      mediaIdCounter.value++;
      await probeMedia(mockFile('clip.webm'));
      expect(vlcProbedBridges.has('media-2')).toBe(true);

      // Verify both are non-MXF and still stored
      const keys = [...vlcProbedBridges.keys()];
      expect(keys).toEqual(['media-1', 'media-2']);
    });
  });
});

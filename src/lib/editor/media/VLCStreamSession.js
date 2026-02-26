// VLCStreamSession — clean stream lifecycle wrapper over a VLCBridge instance.
// Hides VLC-specific quirks: seek-flood prevention, clip-bounds/callback
// orchestration, and burst-decode lifecycle.
//
// One session per VLCDecoder instance (owned by VLCDecoder, exposed via
// getSession()); shared between SequenceStreamController and RenderAheadManager.
import { VLC_CONFIG } from './VLCBridge.js';

export function createVLCStreamSession(bridge) {
  let _activated = false;

  return {
    // True if setPlaybackActive(true) has been issued and not yet stopped.
    // Callers (SSC) query this to decide whether to promote a pre-roll clip.
    get isActive() { return _activated; },

    // Set clip boundaries and register the clip-end callback.
    // Safe to call on a pre-roll clip before playback starts.
    configure(startMs, endMs, onClipEnd) {
      bridge.setClipBounds(startMs, endMs);
      bridge.setClipEndCallback(onClipEnd);
    },

    // Start (or resume) playback from seekSeconds.
    // IDEMPOTENT — if already active, this is a no-op.
    // This is the central guard against VLC's seek-flood bug.
    start(seekSeconds) {
      if (_activated) return;
      _activated = true;
      bridge.setPlaybackActive(true, seekSeconds);
    },

    // Stop playback and clear clip bounds. Full teardown.
    stop() {
      if (_activated) {
        _activated = false;
        bridge.setPlaybackActive(false, 0);
      }
      bridge.clearClipBounds();
      bridge.setClipEndCallback(null);
    },

    // Seek without changing active/inactive state (for scrubbing while paused).
    seek(timeSeconds) {
      bridge.syncSeek(timeSeconds);
    },

    // Burst-decode startMs..burstEndMs of the clip.
    // Optional timeoutOverrideMs to cap the wait (e.g. for long clips).
    // Auto-cleans up afterwards. Returns a Promise that resolves when done.
    async burstDecode(startMs, burstEndMs, timeoutOverrideMs = null) {
      const burstDurationMs = burstEndMs - startMs;
      const waitMs = timeoutOverrideMs ?? (burstDurationMs + VLC_CONFIG.PRE_CACHE_BURST_TIMEOUT_MARGIN_MS);
      await new Promise(resolve => {
        let done = false;
        const tid = setTimeout(() => {
          if (!done) { done = true; resolve(); }
        }, waitMs);
        bridge.setClipEndCallback(() => {
          if (!done) { done = true; clearTimeout(tid); resolve(); }
        });
        bridge.setClipBounds(startMs, burstEndMs);
        bridge.setPlaybackActive(true, startMs / 1000);
      });
      bridge.setPlaybackActive(false, 0);
      bridge.clearClipBounds();
      bridge.setClipEndCallback(null);
      _activated = false;
    },
  };
}

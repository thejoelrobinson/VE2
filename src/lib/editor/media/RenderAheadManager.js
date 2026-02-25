// Render-ahead frame buffer + mediaDecoder coordination + complexity scoring
// @ts-check

import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { clipContainsFrame, getSourceFrameAtPlayhead, getClipEndFrame } from '../timeline/Clip.js';
import { getTransitionZone } from '../effects/Transitions.js';
import { frameToSeconds } from '../timeline/TimelineMath.js';
import { mediaManager } from './MediaManager.js';
import { mediaDecoder } from './MediaDecoder.js';
import { MEDIA_TYPES } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { clamp } from '../core/MathUtils.js';
import logger from '../../utils/logger.js';

// Concurrency limit for parallel mediaDecoder.getFrame() calls.
// Set to 1 because VLC WASM is single-threaded — concurrent requests
// just queue up and timeout, creating cascading failures.
const MAX_CONCURRENT_DECODES = 1;

export const renderAheadManager = {
  _frameBuffer: new Map(), // `${mediaId}_${timeMs}` -> ImageBitmap
  _bufferLimit: 150, // max total frames -- recalculated on init from resolution
  _memoryBudgetMB: 512, // target GPU memory budget in MB
  _complexityCache: new Map(), // frame -> { score: number } | null (cached)
  _complexityCacheValid: true, // invalidated on timeline changes
  _decodedSources: new Set(), // `${mediaId}_${timeMs}` keys for all ever-decoded frames (lightweight)
  _failedFrames: new Map(), // `${mediaId}_${timeMs}` -> timestamp of last failure (prevents infinite retries)
  _failedFrameTTL: 5000, // skip failed frames for 5 seconds before retrying
  _activeConcurrent: 0, // current number of in-flight mediaDecoder.getFrame() calls
  _initialized: false,
  _registeredMedia: new Set(), // media IDs registered for decode-ahead
  _idleFillTimer: null, // setTimeout ID for idle pre-render
  _idleFillGen: 0, // generation counter -- incremented on stop to cancel stale ticks
  _idleFillFrame: 0, // next frame to request in forward fill
  _idleFillPhase: 0, // 0=forward from playhead, 1=backward, 2=done
  _idleFillBackFrame: 0, // next frame for backward fill
  _eventHandlers: null, // stored event handlers for cleanup
  _exportPaused: false, // true while export is active (prevents decode contention)
  _pinned: false, // true during _buildRenderCommand (prevents eviction)
  _stateUnsub: null, // unsubscriber for editorState.subscribe

  init() {
    if (this._initialized) return;

    // Store handler references for cleanup
    this._eventHandlers = {
      timelineUpdated: data => {
        // Only clear complexity cache (timeline positions changed), NOT the frame buffer.
        // The frame buffer is keyed by source media time -- decoded frames are valid
        // regardless of clip position. This makes green bars "travel" with clips on move.
        this._complexityCacheValid = false;
        if (data && data.ranges && data.ranges.length > 0) {
          const merged = this._mergeRanges(data.ranges);
          for (const { start, end } of merged) {
            for (let f = start; f <= end; f++) {
              this._complexityCache.delete(f);
            }
          }
        } else {
          this._complexityCache.clear();
        }
        eventBus.emit(EDITOR_EVENTS.RENDER_BUFFER_CHANGED);
        this._startIdleFill();
      },
      clipAdded: (data) => {
        this._complexityCacheValid = false;
        // When a clip is added, ensure its media is registered and restart
        // idle fill so frames get decoded promptly
        if (data?.clip?.mediaId) {
          this.registerMedia(data.clip.mediaId);
        }
        this._startIdleFill();
      },
      clipRemoved: () => {
        this._complexityCacheValid = false;
      },
      trackAdded: () => {
        this._complexityCacheValid = false;
      },
      trackRemoved: () => {
        this._complexityCacheValid = false;
      },
      playbackStop: () => {
        this._startIdleFill();
      },
      playbackSeek: () => {
        if (!editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) this._startIdleFill();
      },
      playbackStart: () => {
        this._stopIdleFill();
      },
      mediaImported: () => {
        this._startIdleFill();
      },
      sequenceActivated: () => {
        this._invalidateAll();
        this._recalcBufferLimit();
      }
    };

    eventBus.on(EDITOR_EVENTS.TIMELINE_UPDATED, this._eventHandlers.timelineUpdated);
    eventBus.on(EDITOR_EVENTS.PLAYBACK_STOP, this._eventHandlers.playbackStop);
    eventBus.on(EDITOR_EVENTS.PLAYBACK_SEEK, this._eventHandlers.playbackSeek);
    eventBus.on(EDITOR_EVENTS.PLAYBACK_START, this._eventHandlers.playbackStart);
    eventBus.on(EDITOR_EVENTS.MEDIA_IMPORTED, this._eventHandlers.mediaImported);
    eventBus.on(EDITOR_EVENTS.SEQUENCE_ACTIVATED, this._eventHandlers.sequenceActivated);
    eventBus.on(EDITOR_EVENTS.CLIP_ADDED, this._eventHandlers.clipAdded);
    eventBus.on(EDITOR_EVENTS.CLIP_REMOVED, this._eventHandlers.clipRemoved);
    eventBus.on(EDITOR_EVENTS.TRACK_ADDED, this._eventHandlers.trackAdded);
    eventBus.on(EDITOR_EVENTS.TRACK_REMOVED, this._eventHandlers.trackRemoved);

    // Calculate resolution-aware buffer limit from project canvas size
    this._recalcBufferLimit();
    this._stateUnsub = editorState.subscribe(STATE_PATHS.PROJECT_CANVAS, () =>
      this._recalcBufferLimit()
    );

    this._initialized = true;
    logger.info(`[RenderAhead] Initialized (buffer limit: ${this._bufferLimit} frames)`);
  },

  // Register media for decode-ahead. All formats go through the same path.
  registerMedia(mediaId) {
    if (this._registeredMedia.has(mediaId)) return;
    this._registeredMedia.add(mediaId);
    this._startIdleFill();
  },

  // Get a pre-decoded frame (non-blocking, returns null if not cached)
  getFrame(mediaId, timeSeconds) {
    const timeMs = Math.round(timeSeconds * 1000);
    const key = `${mediaId}_${timeMs}`;
    return this._frameBuffer.get(key) || null;
  },

  // Request decode-ahead for upcoming frames using mediaDecoder.getFrame() directly.
  // Concurrency is limited to MAX_CONCURRENT_DECODES parallel calls.
  // Awaits all decode promises before returning so callers can sequence work.
  // Returns Promise<{ sent: number, skippedFull: boolean }>
  async requestAhead(currentFrame, count) {
    // Skip if frame buffer is already near capacity
    if (this._frameBuffer.size >= this._bufferLimit * 0.9) {
      return { sent: 0, skippedFull: true };
    }

    const videoTracks = timelineEngine.getVideoTracks();
    const now = Date.now();

    // Collect needed frames per media: { mediaId, sourceTime }
    const needed = [];

    for (let offset = 0; offset < count; offset++) {
      const frame = currentFrame + offset;

      for (const track of videoTracks) {
        if (track.muted) continue;

        for (const clip of track.clips) {
          if (clip.disabled) continue;
          if (!clipContainsFrame(clip, frame)) continue;

          const mediaItem = mediaManager.getItem(clip.mediaId);
          if (!mediaItem || mediaItem.type !== MEDIA_TYPES.VIDEO) continue;

          // Ensure media is registered
          this.registerMedia(clip.mediaId);

          const sourceFrame = getSourceFrameAtPlayhead(clip, frame);
          const sourceTime = frameToSeconds(sourceFrame);
          const timeMs = Math.round(sourceTime * 1000);
          const key = `${clip.mediaId}_${timeMs}`;

          // Skip if already decoded (in buffer or previously decoded)
          if (this._decodedSources.has(key)) continue;

          // Skip if recently failed (prevents infinite retry loops on VLC timeouts)
          const failTime = this._failedFrames.get(key);
          if (failTime && now - failTime < this._failedFrameTTL) continue;

          needed.push({ mediaId: clip.mediaId, sourceTime, timeMs, key });
        }
      }
    }

    if (needed.length === 0) return { sent: 0, skippedFull: false };

    // Dispatch decode requests with concurrency limiting
    let sent = 0;
    const allPromises = [];
    const inFlight = new Set();

    for (const { mediaId, sourceTime, timeMs, key } of needed) {
      // Skip if already queued in this batch (dedup within the same requestAhead call)
      if (this._decodedSources.has(key)) continue;

      const decodeOne = async () => {
        // Wait for a concurrency slot if at limit
        while (this._activeConcurrent >= MAX_CONCURRENT_DECODES) {
          if (inFlight.size > 0) {
            await Promise.race(inFlight);
          } else {
            break;
          }
        }

        this._activeConcurrent++;
        try {
          const bitmap = await mediaDecoder.getFrame(mediaId, null, sourceTime, 1920, 1080);
          if (bitmap) {
            // Close existing bitmap if overwriting
            const old = this._frameBuffer.get(key);
            if (old) old.close?.();
            this._frameBuffer.set(key, bitmap);
            this._decodedSources.add(key);
            this._capDecodedSources();
            // Clear any prior failure record for this frame
            this._failedFrames.delete(key);
          } else {
            // Null return (decode failed silently) -- record failure to prevent infinite retries
            this._failedFrames.set(key, Date.now());
          }
        } catch (err) {
          // Decode failure -- log, record failure, and continue
          this._failedFrames.set(key, Date.now());
          logger.warn(`[RenderAhead] Decode failed for ${mediaId} @ ${sourceTime}s:`, err.message);
        } finally {
          this._activeConcurrent--;
        }
      };

      const p = decodeOne();
      // Wrap so we can remove from inFlight on settle
      const tracked = p.then(
        () => { inFlight.delete(tracked); },
        () => { inFlight.delete(tracked); }
      );
      inFlight.add(tracked);
      allPromises.push(tracked);
      sent++;
    }

    // Await all decode promises so callers can sequence work (prevents unbounded cascading)
    await Promise.all(allPromises);
    this._evict();
    if (sent > 0) {
      eventBus.emit(EDITOR_EVENTS.RENDER_BUFFER_CHANGED);
    }

    return { sent, skippedFull: false };
  },

  // Check if every video frame in the range has been decoded at least once
  isRangeDecoded(startFrame, endFrame) {
    const videoTracks = timelineEngine.getVideoTracks();
    for (let frame = startFrame; frame < endFrame; frame++) {
      for (const track of videoTracks) {
        if (track.muted) continue;
        for (const clip of track.clips) {
          if (clip.disabled) continue;
          if (!clipContainsFrame(clip, frame)) continue;
          const mediaItem = mediaManager.getItem(clip.mediaId);
          if (!mediaItem || mediaItem.type !== MEDIA_TYPES.VIDEO) continue;
          const sourceFrame = getSourceFrameAtPlayhead(clip, frame);
          const sourceTime = frameToSeconds(sourceFrame);
          const timeMs = Math.round(sourceTime * 1000);
          const key = `${clip.mediaId}_${timeMs}`;
          if (!this._decodedSources.has(key)) return false;
        }
      }
    }
    return true;
  },

  // Ensure frames are buffered for export. Uses mediaDecoder.getFrame() with a timeout.
  // Returns a Promise that resolves when all requested frames are in the buffer
  // or the timeout expires.
  async ensureBuffered(startFrame, count) {
    const videoTracks = timelineEngine.getVideoTracks();
    const needed = []; // { mediaId, sourceTime, key }

    for (let offset = 0; offset < count; offset++) {
      const frame = startFrame + offset;
      for (const track of videoTracks) {
        if (track.muted) continue;
        for (const clip of track.clips) {
          if (clip.disabled) continue;
          if (!clipContainsFrame(clip, frame)) continue;
          const mediaItem = mediaManager.getItem(clip.mediaId);
          if (!mediaItem || mediaItem.type !== MEDIA_TYPES.VIDEO) continue;
          // Auto-register media if not yet registered
          this.registerMedia(clip.mediaId);
          const sourceFrame = getSourceFrameAtPlayhead(clip, frame);
          const sourceTime = frameToSeconds(sourceFrame);
          const timeMs = Math.round(sourceTime * 1000);
          const key = `${clip.mediaId}_${timeMs}`;
          // Only request frames NOT currently in the bitmap buffer
          if (this._frameBuffer.has(key)) continue;
          needed.push({ mediaId: clip.mediaId, sourceTime, timeMs, key });
        }
      }
    }

    if (needed.length === 0) return Promise.resolve();

    let filled = 0;

    // Throttled decode with same concurrency limit as requestAhead
    const results = [];
    const inFlight = new Set();

    for (const { mediaId, sourceTime, key } of needed) {
      while (this._activeConcurrent >= MAX_CONCURRENT_DECODES) {
        if (inFlight.size > 0) {
          await Promise.race(inFlight);
        } else {
          await new Promise(r => setTimeout(r, 10));
        }
      }

      this._activeConcurrent++;
      const p = mediaDecoder.getFrame(mediaId, null, sourceTime, 1920, 1080)
        .then(bitmap => {
          this._activeConcurrent--;
          inFlight.delete(p);
          if (bitmap) {
            const old = this._frameBuffer.get(key);
            if (old) old.close?.();
            this._frameBuffer.set(key, bitmap);
            this._decodedSources.add(key);
            filled++;
          }
        })
        .catch(err => {
          this._activeConcurrent--;
          inFlight.delete(p);
          logger.warn(`[RenderAhead] ensureBuffered decode failed for ${mediaId} @ ${sourceTime}s:`, err.message);
        });

      inFlight.add(p);
      results.push(p);
    }

    const decodePromise = Promise.all(results);

    const timeoutPromise = new Promise(resolve => {
      setTimeout(() => {
        logger.warn(
          `[RenderAhead] ensureBuffered timeout: ${needed.length - filled}/${needed.length} frames still pending after 5s`
        );
        resolve();
      }, 5000);
    });

    return Promise.race([decodePromise, timeoutPromise]).then(() => {
      this._evict();
      if (filled > 0) {
        eventBus.emit(EDITOR_EVENTS.RENDER_BUFFER_CHANGED);
      }
    });
  },

  // Classify a frame's complexity for render bar coloring.
  // Complexity is cached (only changes on timeline edits); buffer state is checked live.
  getSegmentStatus(frame) {
    let cached = this._complexityCache.get(frame);
    if (cached === undefined || !this._complexityCacheValid) {
      cached = this._computeComplexity(frame);
      this._complexityCache.set(frame, cached);
      if (!this._complexityCacheValid) {
        this._complexityCacheValid = true;
      }
    }
    if (cached === null) return null; // no video at this frame
    if (this._isFrameBuffered(frame)) return 'green';
    if (cached.score <= 1.5) return 'yellow';
    return 'red';
  },

  _computeComplexity(frame) {
    const videoTracks = timelineEngine.getVideoTracks();
    let hasVideo = false;
    let score = 0;

    for (const track of videoTracks) {
      if (track.muted) continue;

      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (!clipContainsFrame(clip, frame)) continue;

        const mediaItem = mediaManager.getItem(clip.mediaId);
        if (!mediaItem || mediaItem.type !== MEDIA_TYPES.VIDEO) continue;

        hasVideo = true;
        score += 1; // base decode cost

        // Score effects
        const effects = (clip.effects || []).filter(fx => fx.enabled);
        for (const fx of effects) {
          if (fx.effectId === 'transform' || fx.effectId === 'opacity') {
            score += 0.1; // compositing effect
          } else {
            score += 1.5; // pixel effect
          }
        }
      }

      // Check transitions
      if (track.transitions) {
        for (const trans of track.transitions) {
          const clipA = track.clips.find(c => c.id === trans.clipAId);
          if (!clipA) continue;
          const editPoint = getClipEndFrame(clipA);
          const { start, end } = getTransitionZone(trans, editPoint);
          if (frame >= start && frame < end) {
            score += 2;
          }
        }
      }
    }

    if (!hasVideo) return null;
    return { score };
  },

  // Check if ALL video clips at this frame have been decoded.
  // Uses _decodedSources (lightweight Set) rather than _frameBuffer so that
  // green bars persist even after ImageBitmaps are LRU-evicted from GPU memory.
  // Unified check for all formats (no MXF-specific branch).
  _isFrameBuffered(frame) {
    const videoTracks = timelineEngine.getVideoTracks();
    for (const track of videoTracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        if (clip.disabled) continue;
        if (!clipContainsFrame(clip, frame)) continue;
        const mediaItem = mediaManager.getItem(clip.mediaId);
        if (!mediaItem || mediaItem.type !== MEDIA_TYPES.VIDEO) continue;
        const sourceFrame = getSourceFrameAtPlayhead(clip, frame);
        const sourceTime = frameToSeconds(sourceFrame);
        const timeMs = Math.round(sourceTime * 1000);
        const key = `${clip.mediaId}_${timeMs}`;
        if (!this._decodedSources.has(key)) return false;
      }
    }
    return true;
  },

  // Mark a frame as decoded so the render bar turns green progressively.
  // Throttled to avoid flooding the event bus with RENDER_BUFFER_CHANGED events.
  _renderBarThrottle: null,

  // Called by MediaDecoder._getFrameVLC() after VLC delivers a frame.
  markFrameDecoded(mediaId, timeMs) {
    const key = `${mediaId}_${timeMs}`;
    this._decodedSources.add(key);
    // Throttle: emit at most once per 100ms instead of on every frame
    if (!this._renderBarThrottle) {
      this._renderBarThrottle = setTimeout(() => {
        this._renderBarThrottle = null;
        eventBus.emit(EDITOR_EVENTS.RENDER_BUFFER_CHANGED);
      }, 100);
    }
  },

  // Push a broadcast frame directly into _frameBuffer from VLCBridge.
  // Clones the bitmap via createImageBitmap (~0.5ms) so VLCBridge's L1 cache
  // and _frameBuffer each own independent ImageBitmap references.
  async pushFrame(mediaId, timeMs, bitmap) {
    const key = `${mediaId}_${timeMs}`;
    if (this._frameBuffer.has(key)) return;
    if (this._frameBuffer.size >= this._bufferLimit) this._evict();
    if (this._frameBuffer.size >= this._bufferLimit) return; // pinned, can't evict
    try {
      const copy = await createImageBitmap(bitmap);
      if (this._frameBuffer.has(key)) { copy.close(); return; } // race check after await
      this._frameBuffer.set(key, copy);
      this._decodedSources.add(key);
      this._capDecodedSources();
    } catch (_) {} // bitmap may have been closed by L1 eviction
  },

  // Delegate to PacketExtractWorker for stream copy export (Issue #6).
  // Lazy-import to avoid circular dependency -- PacketExtractWorker is only needed during export.
  async extractPackets(mediaId, startTimeUs, endTimeUs, prependConfig) {
    const { packetExtractWorker } = await import('./PacketExtractWorker.js');
    return packetExtractWorker.extractPackets(mediaId, startTimeUs, endTimeUs, prependConfig);
  },

  // Cap _decodedSources to prevent unbounded growth.
  // Evict oldest 20% when limit reached to avoid full-clear render bar flicker.
  _capDecodedSources() {
    if (this._decodedSources.size > 10000) {
      const evictCount = 2000;
      const iter = this._decodedSources.values();
      for (let i = 0; i < evictCount; i++) {
        const v = iter.next();
        if (v.done) break;
        this._decodedSources.delete(v.value);
      }
    }
  },

  // Force-invalidate all buffered frames (used by cleanup and "Delete Render Files" action)
  _invalidateAll() {
    for (const [, bitmap] of this._frameBuffer) {
      bitmap?.close?.();
    }
    this._frameBuffer.clear();
    this._decodedSources.clear();
    this._failedFrames.clear();
    this._complexityCache.clear();
    eventBus.emit(EDITOR_EVENTS.RENDER_BUFFER_CHANGED);
    this._startIdleFill();
  },

  _mergeRanges(ranges) {
    if (ranges.length === 0) return [];
    if (ranges.length === 1) return ranges;
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    const merged = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      if (sorted[i].start <= last.end + 1) {
        last.end = Math.max(last.end, sorted[i].end);
      } else {
        merged.push(sorted[i]);
      }
    }
    return merged;
  },

  // Calculate buffer limit based on project resolution and available memory.
  // Each ImageBitmap ~ width * height * 4 bytes (RGBA) of GPU memory.
  _recalcBufferLimit() {
    const { width, height } = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    const bytesPerFrame = width * height * 4;
    const budgetBytes = this._memoryBudgetMB * 1024 * 1024;

    // Scale budget by device memory if available (default 4GB assumed)
    const deviceGB = navigator.deviceMemory || 4;
    const scaledBudget =
      deviceGB <= 2 ? budgetBytes * 0.5 : deviceGB >= 8 ? budgetBytes * 1.5 : budgetBytes;

    // Scale by hardware concurrency (core count)
    const cores = navigator.hardwareConcurrency || 4;
    const coreMultiplier = cores >= 12 ? 1.25 : cores >= 8 ? 1.1 : cores <= 2 ? 0.75 : 1;
    const finalBudget = scaledBudget * coreMultiplier;

    // Clamp to 30..600 frames
    const computed = Math.floor(finalBudget / bytesPerFrame);
    const oldLimit = this._bufferLimit;
    this._bufferLimit = clamp(computed, 30, 600);

    if (oldLimit !== this._bufferLimit) {
      logger.info(
        `[RenderAhead] Buffer limit: ${this._bufferLimit} frames (${width}x${height}, ${deviceGB}GB device, ${cores} cores)`
      );
      this._evict(); // trim if new limit is smaller
    }
  },

  // Prevent eviction during compositor's _buildRenderCommand (async, spans await boundaries).
  // Eviction could close bitmaps between getFrame() and postMessage().
  pinFrames() {
    this._pinned = true;
  },
  unpinFrames() {
    this._pinned = false;
  },

  _evict() {
    if (this._pinned) return; // defer eviction until unpin
    while (this._frameBuffer.size > this._bufferLimit) {
      const firstKey = this._frameBuffer.keys().next().value;
      const old = this._frameBuffer.get(firstKey);
      old?.close?.();
      this._frameBuffer.delete(firstKey);
    }
  },

  // Pause idle fill during export to avoid contention for the decoder.
  // Export's explicit ensureBuffered() calls still work -- only background fill is paused.
  pauseForExport() {
    this._exportPaused = true;
    this._stopIdleFill();
  },

  resumeAfterExport() {
    this._exportPaused = false;
    this._startIdleFill();
  },

  // Idle pre-render: fill buffer for entire timeline when paused.
  // Phase 0: fill forward from playhead (highest priority for immediate playback).
  // Phase 1: fill backward from playhead to frame 0.
  // Phase 2: done.
  // Frames already in the buffer are skipped by requestAhead().
  //
  // Tuned for VLC WASM single-threaded decoder:
  // - 4 frames per tick (VLC decodes sequentially)
  // - 200ms base interval (gives VLC time to respond)
  // - Backoff to 2000ms when all frames in a tick were skipped/failed
  // - Awaits requestAhead completion before scheduling next tick
  _idleFillFramesPerTick: 4,
  _idleFillBaseDelay: 200,
  _idleFillBackoffDelay: 2000,

  _startIdleFill() {
    if (editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) return;
    if (this._exportPaused) return;
    this._stopIdleFill();
    const playhead = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
    this._idleFillFrame = playhead;
    this._idleFillPhase = 0; // 0=forward from playhead, 1=backward, 2=done
    this._idleFillBackFrame = playhead - this._idleFillFramesPerTick;
    this._idleFillTick(this._idleFillGen);
  },

  async _idleFillTick(gen) {
    if (gen !== this._idleFillGen) return; // stale tick from previous fill cycle
    if (editorState.get(STATE_PATHS.PLAYBACK_PLAYING)) return;
    if (this._exportPaused) return;

    const duration = timelineEngine.getDuration();
    const framesPerTick = this._idleFillFramesPerTick;
    let result = null;

    if (this._idleFillPhase === 0) {
      // Phase 0: forward from playhead
      if (this._idleFillFrame < duration) {
        result = await this.requestAhead(this._idleFillFrame, framesPerTick);
        this._idleFillFrame += framesPerTick;
      } else {
        // Forward pass done, start backward
        this._idleFillPhase = 1;
      }
    }

    if (this._idleFillPhase === 1) {
      // Phase 1: backward from playhead to frame 0
      if (this._idleFillBackFrame >= 0) {
        result = await this.requestAhead(Math.max(0, this._idleFillBackFrame), framesPerTick);
        this._idleFillBackFrame -= framesPerTick;
      } else {
        // Backward pass done -- full timeline covered
        this._idleFillPhase = 2;
      }
    }

    if (this._idleFillPhase === 2) {
      // All phases complete
      return;
    }

    // Re-check gen after await -- a new fill cycle may have started while we were decoding
    if (gen !== this._idleFillGen) return;

    // Backoff when no frames were sent (all skipped, failed, or buffer full)
    const nothingSent = !result || result.sent === 0;
    const delay = nothingSent ? this._idleFillBackoffDelay : this._idleFillBaseDelay;

    const currentGen = gen;
    this._idleFillTimer = setTimeout(() => this._idleFillTick(currentGen), delay);
  },

  _stopIdleFill() {
    this._idleFillGen++; // invalidate any pending scheduled ticks
    if (this._idleFillTimer !== null) {
      clearTimeout(this._idleFillTimer);
      this._idleFillTimer = null;
    }
  },

  cleanup() {
    this._stopIdleFill();

    // Unsubscribe from EditorState
    if (this._stateUnsub) {
      this._stateUnsub();
      this._stateUnsub = null;
    }

    // Deregister event listeners
    if (this._eventHandlers) {
      eventBus.off(EDITOR_EVENTS.TIMELINE_UPDATED, this._eventHandlers.timelineUpdated);
      eventBus.off(EDITOR_EVENTS.PLAYBACK_STOP, this._eventHandlers.playbackStop);
      eventBus.off(EDITOR_EVENTS.PLAYBACK_SEEK, this._eventHandlers.playbackSeek);
      eventBus.off(EDITOR_EVENTS.PLAYBACK_START, this._eventHandlers.playbackStart);
      eventBus.off(EDITOR_EVENTS.MEDIA_IMPORTED, this._eventHandlers.mediaImported);
      eventBus.off(EDITOR_EVENTS.SEQUENCE_ACTIVATED, this._eventHandlers.sequenceActivated);
      eventBus.off(EDITOR_EVENTS.CLIP_ADDED, this._eventHandlers.clipAdded);
      eventBus.off(EDITOR_EVENTS.CLIP_REMOVED, this._eventHandlers.clipRemoved);
      eventBus.off(EDITOR_EVENTS.TRACK_ADDED, this._eventHandlers.trackAdded);
      eventBus.off(EDITOR_EVENTS.TRACK_REMOVED, this._eventHandlers.trackRemoved);
      this._eventHandlers = null;
    }

    // Clear render bar throttle timer
    if (this._renderBarThrottle) {
      clearTimeout(this._renderBarThrottle);
      this._renderBarThrottle = null;
    }

    for (const [, bitmap] of this._frameBuffer) {
      bitmap?.close?.();
    }
    this._frameBuffer.clear();
    this._decodedSources.clear();
    this._failedFrames.clear();
    this._complexityCache.clear();
    this._registeredMedia.clear();
    this._activeConcurrent = 0;
    this._exportPaused = false;
    this._pinned = false;
    this._initialized = false;
  }
};

export default renderAheadManager;

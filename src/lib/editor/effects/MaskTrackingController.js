// Mask tracking controller — drives MaskTrackingWorker with frame data,
// @ts-check
// writes tracked positions back as path keyframes on the mask.
//
// Flow (strictly sequential — one frame in flight at a time):
//   1. _onTrackRequest → post 'track' to worker, wait for 'track_started'
//   2. 'track_started'  → _feedNextFrame (frame N, stored as reference pyramid)
//   3. 'frame_processed'→ _feedNextFrame (frame N+1, tracked against N)
//   4. 'tracked'        → write keyframe, _feedNextFrame (frame N+2, tracked against N+1)
//   5. repeat 4 until clip end

/** @typedef {import('../media/MaskTrackingWorker.js').MTW_Request} MTW_Request */
/** @typedef {import('../media/MaskTrackingWorker.js').MTW_Response} MTW_Response */

import { eventBus } from '../core/EventBus.js';
import { editorState } from '../core/EditorState.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { mediaManager } from '../media/MediaManager.js';
import { mediaDecoder } from '../media/MediaDecoder.js';
import { getSourceFrameAtPlayhead, getClipDuration } from '../timeline/Clip.js';
import { frameToSeconds } from '../timeline/TimelineMath.js';
import { resolveMaskPath } from './MaskUtils.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import { history } from '../core/History.js';
import logger from '../../utils/logger.js';

export const maskTrackingController = {
  _worker: null,
  _tracking: false,
  _cancelled: false,
  _feeding: false, // guard against concurrent _feedNextFrame calls
  _clip: null,
  _mask: null,
  _source: 'mask', // 'mask' | 'roto'
  _effectInstanceId: null,
  _rotoEffect: null,
  _rotoShape: null,
  _direction: 'forward',
  _currentFrame: 0,
  _endFrame: 0,
  _step: 1,
  _totalFrames: 0,
  _processedFrames: 0,
  _beforePathKeyframes: null,
  _mediaItem: null,
  _canvas: null,
  _initialPath: null,

  init() {
    eventBus.on(EDITOR_EVENTS.MASK_TRACK_REQUEST, data => {
      this._onTrackRequest(data);
    });
    eventBus.on(EDITOR_EVENTS.ROTO_TRACK_REQUEST, data => {
      this._onTrackRequest({ ...data, source: 'roto' });
    });
  },

  cleanup() {
    this.cancel();
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  },

  _ensureWorker() {
    if (this._worker) return;
    this._worker = new Worker(new URL('../media/MaskTrackingWorker.js', import.meta.url), {
      type: 'module'
    });
    this._worker.onmessage = e => this._onWorkerMessage(e);
    this._worker.onerror = err => {
      logger.error('[MaskTracking] Worker error:', err.message || err);
      this._finishTracking(false);
    };
  },

  _onTrackRequest({ maskId, shapeId, effectInstanceId, direction, clipId, source }) {
    if (this._tracking) {
      logger.warn('[MaskTracking] Already tracking, cancel first');
      return;
    }

    const isRoto = source === 'roto';
    this._source = isRoto ? 'roto' : 'mask';

    // Resolve clip from selection
    const selectedIds = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [];
    const videoTracks = timelineEngine.getVideoTracks();
    let clip = null;

    if (clipId) {
      clip = timelineEngine.getClip(clipId);
    } else {
      for (const track of videoTracks) {
        for (const c of track.clips) {
          if (selectedIds.includes(c.id)) {
            clip = c;
            break;
          }
        }
        if (clip) break;
      }
    }

    if (!clip) {
      logger.warn('[MaskTracking] No clip selected');
      return;
    }

    this._effectInstanceId = effectInstanceId || null;

    let mask = null;
    if (isRoto) {
      // Roto brush uses stroke-based matte propagation (in applyRotoEffects via
      // buildTrimapFromPrevMatte), not point-based mask tracking. The tracking
      // controller cannot propagate roto strokes — bail out gracefully.
      logger.warn(
        '[MaskTracking] Roto brush propagation is handled by the matte pipeline, not mask tracking'
      );
      return;
    } else {
      mask = (clip.masks || []).find(m => m.id === maskId);
      if (!mask) {
        logger.warn('[MaskTracking] Mask not found:', maskId);
        return;
      }
      this._rotoEffect = null;
      this._rotoShape = null;
    }

    const mediaItem = mediaManager.getItem(clip.mediaId);
    if (!mediaItem) {
      logger.warn('[MaskTracking] No media for clip');
      return;
    }

    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
    const path = resolveMaskPath(mask, currentFrame);
    if (!path || !path.points || path.points.length < 1) {
      logger.warn('[MaskTracking] Mask has no points to track');
      return;
    }

    const canvas = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    const pixelPoints = path.points.map(p => ({
      x: p.x * canvas.width,
      y: p.y * canvas.height
    }));

    const clipEnd = clip.startFrame + getClipDuration(clip);
    const step = direction === 'forward' ? 1 : -1;
    const endFrame = direction === 'forward' ? clipEnd : clip.startFrame;

    this._clip = clip;
    this._mask = mask;
    this._direction = direction;
    this._step = step;
    this._currentFrame = currentFrame;
    this._endFrame = endFrame;
    this._totalFrames = Math.abs(endFrame - currentFrame);
    this._processedFrames = 0;
    this._tracking = true;
    this._cancelled = false;
    this._feeding = false;
    this._mediaItem = mediaItem;
    this._canvas = canvas;
    this._initialPath = path;

    // Snapshot for undo
    this._beforePathKeyframes = mask.pathKeyframes
      ? JSON.parse(JSON.stringify(mask.pathKeyframes))
      : [];

    // Ensure path keyframing — add initial keyframe at current frame
    if (!mask.pathKeyframes) mask.pathKeyframes = [];
    if (!mask.pathKeyframes.find(kf => kf.frame === currentFrame)) {
      mask.pathKeyframes.push({
        frame: currentFrame,
        value: JSON.parse(JSON.stringify(path))
      });
      mask.pathKeyframes.sort((a, b) => a.frame - b.frame);
    }

    // Initialize worker — do NOT feed frames yet, wait for 'track_started'
    this._ensureWorker();
    this._worker.postMessage({
      type: 'track',
      points: pixelPoints,
      frameWidth: canvas.width,
      frameHeight: canvas.height
    });

    this._emitProgress(0);
    logger.info(
      `[MaskTracking] Starting ${direction} tracking from frame ${currentFrame} to ${endFrame}`
    );
  },

  // Feed exactly one frame to the worker. Returns only after postMessage.
  // The NEXT feed is triggered by the worker's response, never by this method.
  async _feedNextFrame() {
    // Prevent concurrent calls (async gap between decode and postMessage)
    if (this._feeding) return;
    if (this._cancelled || !this._tracking) return;

    const frame = this._currentFrame;

    // Bounds check
    if (this._direction === 'forward' && frame >= this._endFrame) {
      this._finishTracking(true);
      return;
    }
    if (this._direction === 'backward' && frame <= this._endFrame) {
      this._finishTracking(true);
      return;
    }

    this._feeding = true;

    const sourceFrame = getSourceFrameAtPlayhead(this._clip, frame);
    if (sourceFrame === null) {
      this._feeding = false;
      this._finishTracking(true);
      return;
    }
    const sourceTime = frameToSeconds(sourceFrame);

    try {
      const bitmap = await mediaDecoder.getFrame(
        this._mediaItem.id,
        this._mediaItem.url,
        sourceTime
      );

      // Re-check after await (could have been cancelled during decode)
      if (!bitmap || this._cancelled || !this._tracking) {
        this._feeding = false;
        if (!this._cancelled && this._tracking) this._finishTracking(true);
        return;
      }

      // Create a transferable copy (don't close the cached bitmap)
      const transferBitmap = await createImageBitmap(bitmap, {
        colorSpaceConversion: 'none'
      });

      this._worker.postMessage({ type: 'frame', bitmap: transferBitmap, frameIndex: frame }, [
        transferBitmap
      ]);

      // Advance frame counter AFTER posting — next feed triggered by worker response
      this._currentFrame += this._step;
      this._feeding = false;
    } catch (err) {
      this._feeding = false;
      logger.error('[MaskTracking] Frame decode error:', err);
      this._finishTracking(false);
    }
  },

  _onWorkerMessage(e) {
    const { type } = e.data;

    if (type === 'track_started') {
      // Worker initialized — now feed the first frame
      logger.info('[MaskTracking] Worker ready, feeding first frame');
      this._feedNextFrame();
      return;
    }

    if (type === 'frame_processed') {
      // First frame stored as reference pyramid — feed the second frame
      this._feedNextFrame();
      return;
    }

    if (type === 'tracked') {
      this._handleTrackedResult(e.data);
      return;
    }

    if (type === 'error') {
      logger.warn('[MaskTracking] Worker error at frame', e.data.frameIndex, ':', e.data.message);
      // Skip this frame, try next
      this._feedNextFrame();
      return;
    }

    if (type === 'cancelled' || type === 'stopped') {
      this._tracking = false;
      return;
    }
  },

  _handleTrackedResult({ frameIndex, points }) {
    this._processedFrames++;

    const canvas = this._canvas;
    const prevPath = this._initialPath;

    // Convert tracked pixel points back to normalized and build full path with handles
    const trackedPoints = prevPath.points.map((origPt, i) => {
      const tracked = points[i];
      const nx = tracked.x / canvas.width;
      const ny = tracked.y / canvas.height;
      // Translate handles by the same delta as the vertex
      const dx = nx - origPt.x;
      const dy = ny - origPt.y;
      return {
        x: nx,
        y: ny,
        inX: origPt.inX + dx,
        inY: origPt.inY + dy,
        outX: origPt.outX + dx,
        outY: origPt.outY + dy
      };
    });

    const pathKf = {
      frame: frameIndex,
      value: { closed: prevPath.closed, points: trackedPoints }
    };

    // Write path keyframe
    if (!this._mask.pathKeyframes) this._mask.pathKeyframes = [];
    const idx = this._mask.pathKeyframes.findIndex(kf => kf.frame === frameIndex);
    if (idx >= 0) {
      this._mask.pathKeyframes[idx] = pathKf;
    } else {
      this._mask.pathKeyframes.push(pathKf);
      this._mask.pathKeyframes.sort((a, b) => a.frame - b.frame);
    }

    // Update reference path for next frame's handle offset computation
    this._initialPath = pathKf.value;

    // Progress
    const progress = this._totalFrames > 0 ? this._processedFrames / this._totalFrames : 0;
    this._emitProgress(progress);

    // Seek playhead so Program Monitor renders the mask at this position.
    // Throttle to every 3 frames. Use direct state set + event emit instead of
    // playbackEngine.seek() to avoid triggering renderAheadManager.requestAhead()
    // which would compete with the tracking decoder for resources.
    if (this._processedFrames % 3 === 0) {
      editorState.set(STATE_PATHS.PLAYBACK_CURRENT_FRAME, frameIndex);
      eventBus.emit(EDITOR_EVENTS.PLAYBACK_FRAME, { frame: frameIndex });
    }

    // Feed next frame (strictly sequential — only here after worker is done)
    this._feedNextFrame();
  },

  _finishTracking(success) {
    if (!this._tracking) return;
    this._tracking = false;

    if (this._worker) {
      this._worker.postMessage({ type: 'stop' });
    }

    // Push undo
    if (success && this._mask && this._processedFrames > 0) {
      const mask = this._mask;
      const beforeKfs = this._beforePathKeyframes;
      const afterKfs = JSON.parse(JSON.stringify(mask.pathKeyframes || []));
      const updateEvent =
        this._source === 'roto' ? EDITOR_EVENTS.ROTO_UPDATED : EDITOR_EVENTS.MASK_UPDATED;

      history.pushWithoutExecute({
        description: `Track ${this._source === 'roto' ? 'roto shape' : 'mask'} ${this._direction}`,
        execute() {
          mask.pathKeyframes = JSON.parse(JSON.stringify(afterKfs));
          eventBus.emit(updateEvent);
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        },
        undo() {
          mask.pathKeyframes = JSON.parse(JSON.stringify(beforeKfs));
          eventBus.emit(updateEvent);
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      });
    }

    // Seek to last tracked frame so Program Monitor shows final result
    const lastFrame = this._currentFrame - this._step;
    if (lastFrame >= 0) {
      playbackEngine.seek(lastFrame);
    }

    this._emitProgress(1);

    logger.info(
      `[MaskTracking] Tracking ${success ? 'complete' : 'failed'}: ${this._processedFrames} frames processed`
    );

    this._clip = null;
    this._mask = null;
    this._source = 'mask';
    this._effectInstanceId = null;
    this._rotoEffect = null;
    this._rotoShape = null;
    this._mediaItem = null;
    this._canvas = null;
    this._initialPath = null;
    this._beforePathKeyframes = null;
  },

  cancel() {
    if (!this._tracking) return;
    this._cancelled = true;
    if (this._worker) {
      this._worker.postMessage({ type: 'cancel' });
    }
    this._finishTracking(true);
    logger.info('[MaskTracking] Tracking cancelled');
  },

  isTracking() {
    return this._tracking;
  },

  _emitProgress(progress) {
    const progressEvent =
      this._source === 'roto'
        ? EDITOR_EVENTS.ROTO_TRACKING_PROGRESS
        : EDITOR_EVENTS.MASK_TRACKING_PROGRESS;
    eventBus.emit(progressEvent, {
      maskId: this._mask?.id,
      shapeId: this._rotoShape?.id,
      effectInstanceId: this._effectInstanceId,
      progress: Math.min(1, progress),
      done: progress >= 1 || !this._tracking,
      processedFrames: this._processedFrames,
      totalFrames: this._totalFrames
    });
  }
};

export default maskTrackingController;

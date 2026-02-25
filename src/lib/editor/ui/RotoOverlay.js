// Roto brush stroke painting overlay for Program Monitor.
// Users paint foreground (green) and background (red) strokes
// that define regions for the roto brush effect.
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS, TOOL_TYPES } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { clipContainsFrame } from '../timeline/Clip.js';
import { createStroke } from '../effects/RotoEffect.js';
import { history } from '../core/History.js';
import { programMonitor } from './ProgramMonitor.js';
import { segmentationManager } from '../media/SegmentationManager.js';
import { mediaDecoder } from '../media/MediaDecoder.js';
import { mediaManager } from '../media/MediaManager.js';
import { frameToSeconds } from '../timeline/TimelineMath.js';
import { getSourceFrameAtPlayhead } from '../timeline/Clip.js';
import logger from '../../utils/logger.js';
import { sizeCanvasHD } from './uiUtils.js';

const COLORS = {
  FG_STROKE: 'rgba(0, 200, 0, 0.4)',
  BG_STROKE: 'rgba(200, 0, 0, 0.4)',
  FG_CURSOR: 'rgba(0, 200, 0, 0.8)',
  BG_CURSOR: 'rgba(200, 0, 0, 0.8)',
  ERASER_CURSOR: 'rgba(180, 180, 180, 0.8)',
  ACTIVE_STROKE: 'rgba(0, 200, 0, 0.6)'
};

export const rotoOverlay = {
  _canvas: null,
  _ctx: null,
  _resizeObserver: null,
  _previewArea: null,
  _displayCanvas: null,

  // Coordinate mapping (same as TransformOverlay)
  _offsetX: 0,
  _offsetY: 0,
  _scaleX: 1,
  _scaleY: 1,
  _previewRect: null,

  // Current clip
  _clip: null,

  // Brush state
  _brushRadius: 20,
  _currentStroke: null,
  _mousePos: null,
  _altDown: false,
  _painting: false,
  _segRequestId: 0,  // generation counter for debouncing concurrent segmentation requests

  // Bound handlers
  _onMouseDown: null,
  _onMouseMove: null,
  _onMouseUp: null,
  _onKeyDown: null,
  _onKeyUp: null,

  init(container) {
    this._previewArea = programMonitor._previewArea;
    this._displayCanvas = programMonitor._displayCanvas;
    if (!this._previewArea || !this._displayCanvas) {
      logger.warn('[RotoOverlay] Preview area or display canvas not found');
      return;
    }

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'nle-roto-overlay';
    this._previewArea.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    this._resizeObserver = new ResizeObserver(() => {
      this._sizeCanvas();
      this._updateMapping();
      this._draw();
    });
    this._resizeObserver.observe(this._previewArea);
    this._sizeCanvas();
    this._updateMapping();

    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);

    this._canvas.addEventListener('mousedown', this._onMouseDown);
    this._canvas.addEventListener('mousemove', this._onMouseMove);

    this._onScroll = () => { this._updateMapping(); this._draw(); };
    this._scrollTarget = this._previewArea;
    this._previewArea.addEventListener('scroll', this._onScroll);

    const redraw = () => this._onSelectionOrFrame();

    this._unsubEvents = subscribeEvents({
      [EDITOR_EVENTS.CLIP_SELECTED]: redraw,
      [EDITOR_EVENTS.CLIP_DESELECTED]: redraw,
      [EDITOR_EVENTS.SELECTION_CHANGED]: redraw,
      [EDITOR_EVENTS.PLAYBACK_FRAME]: redraw,
      [EDITOR_EVENTS.PLAYBACK_SEEK]: redraw,
      [EDITOR_EVENTS.TIMELINE_UPDATED]: () => { if (!this._painting) redraw(); },
      [EDITOR_EVENTS.ROTO_UPDATED]: redraw,
      [EDITOR_EVENTS.ROTO_SELECTION_CHANGED]: redraw,
    });

    this._unsubRotoMode = editorState.subscribe(STATE_PATHS.UI_ROTO_EDIT_MODE, () => {
      this._updatePointerEvents();
      this._draw();
    });
    this._unsubRotoTool = editorState.subscribe(STATE_PATHS.UI_ROTO_TOOL, () => {
      this._updatePointerEvents();
      this._draw();
    });

    this._onSelectionOrFrame();
  },

  cleanup() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    const scrollTarget = this._scrollTarget || this._previewArea;
    if (scrollTarget && this._onScroll) {
      scrollTarget.removeEventListener('scroll', this._onScroll);
    }
    this._scrollTarget = null;
    if (this._canvas) {
      this._canvas.removeEventListener('mousedown', this._onMouseDown);
      this._canvas.removeEventListener('mousemove', this._onMouseMove);
      this._canvas.remove();
      this._canvas = null;
    }
    this._stopPainting(true);
    if (this._unsubEvents) this._unsubEvents();
    if (this._unsubRotoMode) this._unsubRotoMode();
    if (this._unsubRotoTool) this._unsubRotoTool();
    this._clip = null;
    this._currentStroke = null;
    this._mousePos = null;
  },

  // ── Canvas Sizing ──

  _sizeCanvas() {
    if (!this._canvas || !this._previewArea) return;
    const rect = this._previewArea.getBoundingClientRect();
    if (this._ctx) sizeCanvasHD(this._canvas, this._ctx, rect.width, rect.height);
  },

  // ── Coordinate Mapping (identical to TransformOverlay) ──

  _updateMapping() {
    if (!this._displayCanvas || !this._previewArea) return;
    const proj = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    if (!proj) return;
    const canvasRect = this._displayCanvas.getBoundingClientRect();
    const previewRect = this._previewArea.getBoundingClientRect();
    this._previewRect = previewRect;
    this._offsetX = canvasRect.left - previewRect.left;
    this._offsetY = canvasRect.top - previewRect.top;
    this._scaleX = proj.width / canvasRect.width;
    this._scaleY = proj.height / canvasRect.height;
  },

  _screenToNormalized(screenX, screenY) {
    if (!this._previewRect) return { x: 0, y: 0 };
    const relX = screenX - this._previewRect.left - this._offsetX;
    const relY = screenY - this._previewRect.top - this._offsetY;
    const proj = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    if (!proj || !proj.width || !proj.height) return { x: 0, y: 0 };
    return {
      x: (relX * this._scaleX) / proj.width,
      y: (relY * this._scaleY) / proj.height
    };
  },

  _normalizedToScreen(nx, ny) {
    const proj = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    if (!proj) return { x: 0, y: 0 };
    const projX = nx * proj.width;
    const projY = ny * proj.height;
    return {
      x: projX / this._scaleX + this._offsetX,
      y: projY / this._scaleY + this._offsetY
    };
  },

  // ── Clip Resolution ──

  _resolveClip() {
    const selectedIds = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [];
    if (selectedIds.length === 0) {
      this._clip = null;
      return;
    }
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
    const videoTracks = timelineEngine.getVideoTracks();
    let bestClip = null;
    for (let i = videoTracks.length - 1; i >= 0; i--) {
      for (const clip of videoTracks[i].clips) {
        if (!selectedIds.includes(clip.id)) continue;
        if (clipContainsFrame(clip, frame)) { bestClip = clip; break; }
        if (!bestClip) bestClip = clip;
      }
      if (bestClip && clipContainsFrame(bestClip, frame)) break;
    }
    this._clip = bestClip;
  },

  _getRotoEffect() {
    if (!this._clip) return null;
    return (this._clip.effects || []).find(fx => fx.effectId === 'roto-brush' && fx.enabled) || null;
  },

  _onSelectionOrFrame() {
    this._updateMapping();
    this._resolveClip();
    this._updatePointerEvents();
    this._draw();
  },

  _updatePointerEvents() {
    if (!this._canvas) return;
    const rotoEditMode = editorState.get(STATE_PATHS.UI_ROTO_EDIT_MODE);
    const rotoTool = editorState.get(STATE_PATHS.UI_ROTO_TOOL);
    const rotoActive = rotoEditMode || rotoTool;
    this._canvas.style.pointerEvents = rotoActive ? 'auto' : 'none';
    // Hide system cursor when brush tool is active — we draw our own
    this._canvas.style.cursor = rotoTool ? 'none' : 'default';
  },

  // ── Effective Tool ──

  _getEffectiveTool() {
    const rotoTool = editorState.get(STATE_PATHS.UI_ROTO_TOOL);
    if (!rotoTool) return null;
    // Alt key swaps FG and BG
    if (this._altDown) {
      if (rotoTool === TOOL_TYPES.ROTO_BRUSH_FG) return TOOL_TYPES.ROTO_BRUSH_BG;
      if (rotoTool === TOOL_TYPES.ROTO_BRUSH_BG) return TOOL_TYPES.ROTO_BRUSH_FG;
    }
    return rotoTool;
  },

  _getStrokeType() {
    const tool = this._getEffectiveTool();
    if (tool === TOOL_TYPES.ROTO_BRUSH_FG) return 'foreground';
    if (tool === TOOL_TYPES.ROTO_BRUSH_BG) return 'background';
    return null;
  },

  // ── Mouse Handlers ──

  _handleMouseDown(e) {
    if (e.button !== 0) return;
    this._updateMapping();

    const tool = this._getEffectiveTool();
    if (!tool) return;

    e.preventDefault();
    e.stopPropagation();

    if (!this._clip) {
      this._resolveClip();
      if (!this._clip) return;
    }

    const fx = this._getRotoEffect();
    if (!fx) {
      logger.warn('[RotoOverlay] No enabled roto-brush effect on selected clip');
      return;
    }

    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;

    // Eraser tool: remove strokes near cursor
    if (tool === TOOL_TYPES.ROTO_ERASER) {
      this._eraseAtPoint(fx, frame, e.clientX, e.clientY);
      this._painting = true;
      document.addEventListener('mousemove', this._onMouseMove);
      document.addEventListener('mouseup', this._onMouseUp);
      document.addEventListener('keydown', this._onKeyDown);
      document.addEventListener('keyup', this._onKeyUp);
      return;
    }

    // Brush tool: start new stroke
    const strokeType = this._getStrokeType();
    if (!strokeType) return;

    const beforeStrokes = JSON.parse(JSON.stringify(fx.params.strokes || []));

    const stroke = createStroke(frame, strokeType, this._brushRadius);
    const norm = this._screenToNormalized(e.clientX, e.clientY);
    stroke.points.push({ x: norm.x, y: norm.y });

    this._currentStroke = stroke;
    this._beforeStrokes = beforeStrokes;
    this._painting = true;

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('keyup', this._onKeyUp);

    this._draw();
  },

  _handleMouseMove(e) {
    if (this._painting) {
      e.preventDefault();

      const tool = this._getEffectiveTool();

      // Eraser drag
      if (tool === TOOL_TYPES.ROTO_ERASER) {
        const fx = this._getRotoEffect();
        const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
        if (fx) this._eraseAtPoint(fx, frame, e.clientX, e.clientY);
      }

      // Brush drag: add point to current stroke
      if (this._currentStroke) {
        const norm = this._screenToNormalized(e.clientX, e.clientY);
        this._currentStroke.points.push({ x: norm.x, y: norm.y });
      }
    }

    // Always update mouse position for cursor
    if (this._previewRect) {
      this._mousePos = {
        x: e.clientX - this._previewRect.left,
        y: e.clientY - this._previewRect.top
      };
    }

    this._draw();
  },

  _handleMouseUp(e) {
    if (!this._painting) return;
    e.preventDefault();
    this._stopPainting(false);
  },

  _stopPainting(cancelled) {
    if (!this._painting) return;

    if (!cancelled && this._currentStroke && this._currentStroke.points.length >= 1) {
      const fx = this._getRotoEffect();
      if (fx) {
        if (!fx.params.strokes) fx.params.strokes = [];
        fx.params.strokes.push(this._currentStroke);

        const afterStrokes = JSON.parse(JSON.stringify(fx.params.strokes));
        const beforeStrokes = this._beforeStrokes;
        const fxRef = fx;

        history.pushWithoutExecute({
          description: 'Paint roto stroke',
          execute() {
            fxRef.params.strokes = JSON.parse(JSON.stringify(afterStrokes));
            eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          },
          undo() {
            fxRef.params.strokes = JSON.parse(JSON.stringify(beforeStrokes));
            eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          }
        });

        this._emitRotoUpdate();

        // Trigger MediaPipe segmentation if available
        this._requestSegmentation(fx);
      }
    }

    this._currentStroke = null;
    this._beforeStrokes = null;
    this._painting = false;

    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);

    this._draw();
  },

  _handleKeyDown(e) {
    if (e.key === 'Alt') {
      this._altDown = true;
      this._draw();
      e.preventDefault();
    } else if (e.key === '[') {
      this._brushRadius = Math.max(5, this._brushRadius - 5);
      this._draw();
      e.preventDefault();
    } else if (e.key === ']') {
      this._brushRadius = Math.min(200, this._brushRadius + 5);
      this._draw();
      e.preventDefault();
    } else if (e.key === 'Escape') {
      if (this._painting) {
        this._stopPainting(true);
      } else {
        editorState.set(STATE_PATHS.UI_ROTO_EDIT_MODE, false);
        editorState.set(STATE_PATHS.UI_ROTO_TOOL, null);
      }
      e.preventDefault();
    }
  },

  _handleKeyUp(e) {
    if (e.key === 'Alt') {
      this._altDown = false;
      this._draw();
      e.preventDefault();
    }
  },

  // ── Eraser Logic ──

  _eraseAtPoint(fx, frame, screenX, screenY) {
    if (!fx.params.strokes || fx.params.strokes.length === 0) return;

    const norm = this._screenToNormalized(screenX, screenY);
    const proj = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    if (!proj) return;

    // Brush radius in normalized coords
    const radiusNormX = (this._brushRadius * this._scaleX) / proj.width;
    const radiusNormY = (this._brushRadius * this._scaleY) / proj.height;
    const radiusNorm = Math.max(radiusNormX, radiusNormY);

    const beforeStrokes = JSON.parse(JSON.stringify(fx.params.strokes));
    let removed = false;

    fx.params.strokes = fx.params.strokes.filter(stroke => {
      if (stroke.frame !== frame) return true;
      // Check if any point in the stroke is within eraser radius
      for (const pt of stroke.points) {
        const dx = pt.x - norm.x;
        const dy = pt.y - norm.y;
        if (Math.sqrt(dx * dx + dy * dy) < radiusNorm) {
          removed = true;
          return false;
        }
      }
      return true;
    });

    if (removed) {
      const afterStrokes = JSON.parse(JSON.stringify(fx.params.strokes));
      const fxRef = fx;

      history.pushWithoutExecute({
        description: 'Erase roto stroke',
        execute() {
          fxRef.params.strokes = JSON.parse(JSON.stringify(afterStrokes));
          eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        },
        undo() {
          fxRef.params.strokes = JSON.parse(JSON.stringify(beforeStrokes));
          eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      });

      this._emitRotoUpdate();
      this._draw();
    }
  },

  // ── Helpers ──

  _emitRotoUpdate() {
    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  },

  // ── MediaPipe Segmentation ──

  async _requestSegmentation(fx) {
    if (!segmentationManager.isReady()) return;
    if (!this._clip || !fx) return;

    // Increment generation counter — stale requests check this before writing results
    const requestId = ++this._segRequestId;

    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
    const strokes = (fx.params.strokes || []).filter(s => s.frame === frame);
    if (strokes.length === 0) return;

    const canvas = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    if (!canvas) return;
    const { width: w, height: h } = canvas;

    // Sample points from strokes (every ~10px along each polyline)
    const positivePoints = [];
    const negativePoints = [];
    for (const stroke of strokes) {
      const pts = this._sampleStrokePoints(stroke, w, h);
      if (stroke.type === 'foreground') {
        positivePoints.push(...pts);
      } else {
        negativePoints.push(...pts);
      }
    }

    if (positivePoints.length === 0) return;

    try {
      // Get current frame as bitmap for encoding
      const mediaItem = mediaManager.getItem(this._clip.mediaId);
      if (!mediaItem) return;

      const sourceFrame = getSourceFrameAtPlayhead(this._clip, frame);
      if (sourceFrame === null) return;
      const sourceTime = frameToSeconds(sourceFrame);

      const bitmap = await mediaDecoder.getFrame(mediaItem.id, mediaItem.url, sourceTime);
      if (!bitmap) return;

      // Create a transferable copy at project canvas dimensions
      const transferBitmap = await createImageBitmap(bitmap, {
        colorSpaceConversion: 'none',
        resizeWidth: w,
        resizeHeight: h
      });

      const frameKey = `${mediaItem.id}-${sourceTime}`;
      await segmentationManager.encodeFrame(transferBitmap, w, h, frameKey);

      const result = await segmentationManager.decodeMask(positivePoints, negativePoints, w, h);

      // Discard stale result if a newer request has been made
      if (requestId !== this._segRequestId) return;

      // Validate mask dimensions match project canvas before storing
      if (result.mask.length !== w * h) {
        logger.warn(`[RotoOverlay] Segmentation mask size mismatch: ${result.mask.length} vs ${w * h}, skipping`);
        return;
      }

      // Store segmentation mask on the effect for the compositor to use.
      // The mask IS the keyframe — strokes are consumed after producing it.
      if (!fx.params._segMasks) fx.params._segMasks = new Map();
      fx.params._segMasks.set(frame, result.mask);

      // Consume strokes: they served their purpose producing the mask
      fx.params.strokes = (fx.params.strokes || []).filter(s => s.frame !== frame);

      // Invalidate old trimap cache for this frame
      if (fx.params._matteCache) fx.params._matteCache.delete(frame);

      this._emitRotoUpdate();

      // Force program monitor to re-composite the current frame with the new mask.
      // _emitRotoUpdate() fires TIMELINE_UPDATED which ProgramMonitor listens to,
      // triggering _requestRender(). This is sufficient — no need for PLAYBACK_SEEK
      // which has unwanted side effects (AudioMixer, RenderAheadManager, ConformEncoder).

      logger.info(`[RotoOverlay] MediaPipe segmentation complete for frame ${frame} (${positivePoints.length} FG, ${negativePoints.length} BG points)`);
    } catch (err) {
      logger.warn('[RotoOverlay] MediaPipe segmentation failed, using fallback:', err.message);
    }
  },

  // Sample representative points along a stroke polyline (pixel coordinates)
  _sampleStrokePoints(stroke, w, h) {
    const points = stroke.points;
    if (!points || points.length === 0) return [];

    const result = [];
    const SAMPLE_INTERVAL = 10; // pixels between samples

    // Always include the first point
    result.push({ x: Math.round(points[0].x * w), y: Math.round(points[0].y * h) });

    if (points.length === 1) return result;

    let accumulated = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = (points[i].x - points[i - 1].x) * w;
      const dy = (points[i].y - points[i - 1].y) * h;
      const dist = Math.sqrt(dx * dx + dy * dy);
      accumulated += dist;
      if (accumulated >= SAMPLE_INTERVAL) {
        result.push({ x: Math.round(points[i].x * w), y: Math.round(points[i].y * h) });
        accumulated = 0;
      }
    }

    // Always include the last point if not already added
    const last = points[points.length - 1];
    const lastPt = { x: Math.round(last.x * w), y: Math.round(last.y * h) };
    const prevPt = result[result.length - 1];
    if (prevPt.x !== lastPt.x || prevPt.y !== lastPt.y) {
      result.push(lastPt);
    }

    // Cap at ~20 points per stroke (MediaPipe works best with fewer well-placed points)
    if (result.length > 20) {
      const step = result.length / 20;
      const sampled = [];
      for (let i = 0; i < 20; i++) {
        sampled.push(result[Math.round(i * step)]);
      }
      return sampled;
    }

    return result;
  },

  // ── Drawing ──

  _draw() {
    if (!this._ctx || !this._canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this._canvas.width / dpr;
    const h = this._canvas.height / dpr;
    this._ctx.clearRect(0, 0, w, h);

    const fx = this._getRotoEffect();
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;

    // Draw stored strokes for current frame
    if (fx && fx.params.strokes) {
      for (const stroke of fx.params.strokes) {
        if (stroke.frame !== frame) continue;
        this._drawStroke(stroke, false);
      }
    }

    // Draw in-progress stroke
    if (this._currentStroke) {
      this._drawStroke(this._currentStroke, true);
    }

    // Draw brush cursor
    this._drawCursor();
  },

  _drawStroke(stroke, isActive) {
    if (!stroke.points || stroke.points.length < 1) return;
    const ctx = this._ctx;

    const isFg = stroke.type === 'foreground';
    const color = isActive
      ? (isFg ? COLORS.ACTIVE_STROKE : 'rgba(200, 0, 0, 0.6)')
      : (isFg ? COLORS.FG_STROKE : COLORS.BG_STROKE);
    const radius = (stroke.radius * 2) / this._scaleX;

    // Single-point stroke: draw as filled circle
    if (stroke.points.length === 1) {
      const p = this._normalizedToScreen(stroke.points[0].x, stroke.points[0].y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      return;
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = radius;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    const p0 = this._normalizedToScreen(stroke.points[0].x, stroke.points[0].y);
    ctx.moveTo(p0.x, p0.y);

    for (let i = 1; i < stroke.points.length; i++) {
      const pt = this._normalizedToScreen(stroke.points[i].x, stroke.points[i].y);
      ctx.lineTo(pt.x, pt.y);
    }

    ctx.stroke();
  },

  _drawCursor() {
    if (!this._mousePos) return;
    const tool = this._getEffectiveTool();
    if (!tool) return;

    const ctx = this._ctx;
    const mx = this._mousePos.x;
    const my = this._mousePos.y;
    const radius = this._brushRadius / this._scaleX;

    // Premiere Pro-style brush cursor: thin circle + crosshair center
    // Outer circle — white with dark outline for visibility on any background
    ctx.beginPath();
    ctx.arc(mx, my, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(mx, my, radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Crosshair at center (4px arms)
    const cross = 4;
    ctx.beginPath();
    ctx.moveTo(mx - cross, my);
    ctx.lineTo(mx + cross, my);
    ctx.moveTo(mx, my - cross);
    ctx.lineTo(mx, my + cross);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(mx - cross, my);
    ctx.lineTo(mx + cross, my);
    ctx.moveTo(mx, my - cross);
    ctx.lineTo(mx, my + cross);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Subtle inner tint showing FG (green) / BG (red) / Eraser (gray)
    if (tool !== TOOL_TYPES.ROTO_ERASER) {
      const tint = tool === TOOL_TYPES.ROTO_BRUSH_BG
        ? 'rgba(200, 0, 0, 0.08)'
        : 'rgba(0, 200, 0, 0.08)';
      ctx.beginPath();
      ctx.arc(mx, my, radius, 0, Math.PI * 2);
      ctx.fillStyle = tint;
      ctx.fill();
    }
  },

  // ── Public API ──

  selectTool(type) {
    if (type === 'foreground') {
      editorState.set(STATE_PATHS.UI_ROTO_TOOL, TOOL_TYPES.ROTO_BRUSH_FG);
    } else if (type === 'background') {
      editorState.set(STATE_PATHS.UI_ROTO_TOOL, TOOL_TYPES.ROTO_BRUSH_BG);
    } else if (type === 'eraser') {
      editorState.set(STATE_PATHS.UI_ROTO_TOOL, TOOL_TYPES.ROTO_ERASER);
    } else {
      editorState.set(STATE_PATHS.UI_ROTO_TOOL, null);
    }
    this._updatePointerEvents();
    this._draw();
  },

  setBrushRadius(radius) {
    this._brushRadius = Math.max(5, Math.min(200, radius));
    this._draw();
  },

  getBrushRadius() {
    return this._brushRadius;
  },

  clearStrokes(frame) {
    const fx = this._getRotoEffect();
    if (!fx || !fx.params.strokes) return;

    const beforeStrokes = JSON.parse(JSON.stringify(fx.params.strokes));
    fx.params.strokes = fx.params.strokes.filter(s => s.frame !== frame);
    const afterStrokes = JSON.parse(JSON.stringify(fx.params.strokes));
    const fxRef = fx;

    history.pushWithoutExecute({
      description: 'Clear roto strokes for frame',
      execute() {
        fxRef.params.strokes = JSON.parse(JSON.stringify(afterStrokes));
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        fxRef.params.strokes = JSON.parse(JSON.stringify(beforeStrokes));
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    this._emitRotoUpdate();
    this._draw();
  },

  clearAllStrokes() {
    const fx = this._getRotoEffect();
    if (!fx || !fx.params.strokes) return;

    const beforeStrokes = JSON.parse(JSON.stringify(fx.params.strokes));
    fx.params.strokes = [];
    const fxRef = fx;

    history.pushWithoutExecute({
      description: 'Clear all roto strokes',
      execute() {
        fxRef.params.strokes = [];
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        fxRef.params.strokes = JSON.parse(JSON.stringify(beforeStrokes));
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    this._emitRotoUpdate();
    this._draw();
  },

  exitEditMode() {
    editorState.set(STATE_PATHS.UI_ROTO_EDIT_MODE, false);
    editorState.set(STATE_PATHS.UI_ROTO_TOOL, null);
    this._draw();
  }
};

export default rotoOverlay;

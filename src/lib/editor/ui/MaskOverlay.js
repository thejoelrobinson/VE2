// Mask drawing/editing overlay for Program Monitor.
// Follows TransformOverlay pattern: canvas overlay with same coordinate mapping.
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS, TOOL_TYPES } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { clipContainsFrame } from '../timeline/Clip.js';
import { createMask, resolveMaskPath } from '../effects/MaskUtils.js';
import { history } from '../core/History.js';
import { programMonitor } from './ProgramMonitor.js';
import logger from '../../utils/logger.js';
import { sizeCanvasHD } from './uiUtils.js';

const VERTEX_RADIUS = 5;
const HANDLE_RADIUS = 4;
const HIT_RADIUS = 10;

const COLORS = {
  PATH: '#00ff88',
  PATH_SELECTED: '#00ff88',
  VERTEX: '#ffffff',
  VERTEX_STROKE: '#00ff88',
  HANDLE: '#ffaa00',
  HANDLE_LINE: 'rgba(255,170,0,0.5)',
  PREVIEW: 'rgba(0,255,136,0.15)'
};

const DRAG_MODE = {
  NONE: 'none',
  VERTEX: 'vertex',
  HANDLE_IN: 'handle-in',
  HANDLE_OUT: 'handle-out',
  MOVE_PATH: 'move-path',
  DRAW_SHAPE: 'draw-shape' // for ellipse/rect bounding box
};

export const maskOverlay = {
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

  // Current clip & mask
  _clip: null,
  _activeMaskId: null,

  // Drag state
  _dragging: false,
  _dragMode: DRAG_MODE.NONE,
  _dragVertexIdx: -1,
  _dragStartMouse: null,
  _dragStartPath: null,
  _shapeStart: null, // for draw-shape mode

  // Pen tool state
  _penDrawing: false,

  // Bound handlers
  _onMouseDown: null,
  _onMouseMove: null,
  _onMouseUp: null,
  _onKeyDown: null,
  _onDblClick: null,

  init(container) {
    this._previewArea = programMonitor._previewArea;
    this._displayCanvas = programMonitor._displayCanvas;
    if (!this._previewArea || !this._displayCanvas) {
      logger.warn('[MaskOverlay] Preview area or display canvas not found');
      return;
    }

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'nle-mask-overlay';
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
    this._onDblClick = this._handleDblClick.bind(this);

    this._canvas.addEventListener('mousedown', this._onMouseDown);
    this._canvas.addEventListener('mousemove', this._onMouseMove);
    this._canvas.addEventListener('dblclick', this._onDblClick);

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
      [EDITOR_EVENTS.TIMELINE_UPDATED]: () => { if (!this._dragging) redraw(); },
      [EDITOR_EVENTS.MASK_UPDATED]: redraw,
      [EDITOR_EVENTS.MASK_SELECTION_CHANGED]: redraw,
    });

    this._unsubMaskMode = editorState.subscribe(STATE_PATHS.UI_MASK_EDIT_MODE, () => {
      this._updatePointerEvents();
      this._draw();
    });
    this._unsubRotoMode = editorState.subscribe(STATE_PATHS.UI_ROTO_EDIT_MODE, () => {
      this._updatePointerEvents();
    });
    this._unsubRotoTool = editorState.subscribe(STATE_PATHS.UI_ROTO_TOOL, () => {
      this._updatePointerEvents();
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
      this._canvas.removeEventListener('dblclick', this._onDblClick);
      this._canvas.remove();
      this._canvas = null;
    }
    this._stopDrag(true);
    if (this._unsubEvents) this._unsubEvents();
    if (this._unsubMaskMode) this._unsubMaskMode();
    if (this._unsubRotoMode) this._unsubRotoMode();
    if (this._unsubRotoTool) this._unsubRotoTool();
    this._clip = null;
    this._activeMaskId = null;
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

  // ── Clip/Mask Resolution ──

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

  _getActiveMask() {
    if (!this._clip || !this._clip.masks) return null;
    const maskId = this._activeMaskId || editorState.get(STATE_PATHS.SELECTION_MASK_ID);
    return this._clip.masks.find(m => m.id === maskId) || null;
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
    // Disable mask overlay when roto is active
    if (rotoEditMode || rotoTool) {
      this._canvas.style.pointerEvents = 'none';
      return;
    }
    const maskEditMode = editorState.get(STATE_PATHS.UI_MASK_EDIT_MODE);
    const maskTool = editorState.get(STATE_PATHS.UI_MASK_TOOL);
    this._canvas.style.pointerEvents = (maskEditMode || maskTool) ? 'auto' : 'none';
  },

  // ── Hit Testing ──

  _hitTestVertex(screenX, screenY, mask) {
    if (!mask || !mask.path || !mask.path.points) return -1;
    if (!this._previewRect) return -1;
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
    const path = resolveMaskPath(mask, frame);
    if (!path || !path.points) return -1;
    const mx = screenX - this._previewRect.left;
    const my = screenY - this._previewRect.top;

    for (let i = 0; i < path.points.length; i++) {
      const pt = path.points[i];
      const s = this._normalizedToScreen(pt.x, pt.y);
      if (Math.hypot(mx - s.x, my - s.y) < HIT_RADIUS) return i;
    }
    return -1;
  },

  _hitTestHandle(screenX, screenY, mask) {
    if (!mask || !mask.path || !mask.path.points) return null;
    if (!this._previewRect) return null;
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
    const path = resolveMaskPath(mask, frame);
    if (!path || !path.points) return null;
    const mx = screenX - this._previewRect.left;
    const my = screenY - this._previewRect.top;

    for (let i = 0; i < path.points.length; i++) {
      const pt = path.points[i];
      // In handle
      const sIn = this._normalizedToScreen(pt.inX, pt.inY);
      if (Math.hypot(mx - sIn.x, my - sIn.y) < HIT_RADIUS) {
        return { idx: i, type: 'in' };
      }
      // Out handle
      const sOut = this._normalizedToScreen(pt.outX, pt.outY);
      if (Math.hypot(mx - sOut.x, my - sOut.y) < HIT_RADIUS) {
        return { idx: i, type: 'out' };
      }
    }
    return null;
  },

  _hitTestPath(screenX, screenY, mask) {
    if (!mask || !mask.path || !mask.path.points || mask.path.points.length < 2) return false;
    if (!this._previewRect) return false;
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
    const path = resolveMaskPath(mask, frame);
    if (!path || !path.points || path.points.length < 2) return false;
    const proj = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    const mx = screenX - this._previewRect.left;
    const my = screenY - this._previewRect.top;

    // Use canvas hit test
    const ctx = this._ctx;
    ctx.beginPath();
    const pts = path.points;
    const toScreen = (nx, ny) => this._normalizedToScreen(nx, ny);
    const s0 = toScreen(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const cp1 = toScreen(prev.outX, prev.outY);
      const cp2 = toScreen(curr.inX, curr.inY);
      const end = toScreen(curr.x, curr.y);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
    }
    if (path.closed && pts.length >= 3) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      const cp1 = toScreen(last.outX, last.outY);
      const cp2 = toScreen(first.inX, first.inY);
      const end = toScreen(first.x, first.y);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
    }
    ctx.closePath();

    return ctx.isPointInPath(mx, my);
  },

  // ── Mouse Handlers ──

  _handleMouseDown(e) {
    if (e.button !== 0) return;
    this._updateMapping();

    const maskTool = editorState.get(STATE_PATHS.UI_MASK_TOOL);
    const maskEditMode = editorState.get(STATE_PATHS.UI_MASK_EDIT_MODE);

    // Drawing new shapes
    if (maskTool === TOOL_TYPES.MASK_ELLIPSE || maskTool === TOOL_TYPES.MASK_RECTANGLE) {
      e.preventDefault();
      e.stopPropagation();
      this._startShapeDraw(e, maskTool === TOOL_TYPES.MASK_ELLIPSE ? 'ellipse' : 'rectangle');
      return;
    }

    // Pen tool drawing
    if (maskTool === TOOL_TYPES.MASK_PEN) {
      e.preventDefault();
      e.stopPropagation();
      this._handlePenClick(e);
      return;
    }

    // Edit mode interactions
    if (!maskEditMode) return;

    const mask = this._getActiveMask();
    if (!mask) return;

    // Hit test: vertex > handle > path (move)
    const vertexIdx = this._hitTestVertex(e.clientX, e.clientY, mask);
    if (vertexIdx >= 0) {
      e.preventDefault();
      e.stopPropagation();
      this._startVertexDrag(e, mask, vertexIdx);
      return;
    }

    const handle = this._hitTestHandle(e.clientX, e.clientY, mask);
    if (handle) {
      e.preventDefault();
      e.stopPropagation();
      this._startHandleDrag(e, mask, handle);
      return;
    }

    if (this._hitTestPath(e.clientX, e.clientY, mask)) {
      e.preventDefault();
      e.stopPropagation();
      this._startPathMove(e, mask);
      return;
    }
  },

  _handleMouseMove(e) {
    if (!this._dragging) {
      // Update cursor
      const maskEditMode = editorState.get(STATE_PATHS.UI_MASK_EDIT_MODE);
      const maskTool = editorState.get(STATE_PATHS.UI_MASK_TOOL);
      if (maskTool) {
        this._canvas.style.cursor = 'crosshair';
        return;
      }
      if (maskEditMode) {
        const mask = this._getActiveMask();
        if (mask) {
          if (this._hitTestVertex(e.clientX, e.clientY, mask) >= 0) {
            this._canvas.style.cursor = 'move';
          } else if (this._hitTestHandle(e.clientX, e.clientY, mask)) {
            this._canvas.style.cursor = 'crosshair';
          } else if (this._hitTestPath(e.clientX, e.clientY, mask)) {
            this._canvas.style.cursor = 'move';
          } else {
            this._canvas.style.cursor = 'default';
          }
        }
      }
      return;
    }

    e.preventDefault();

    if (this._dragMode === DRAG_MODE.DRAW_SHAPE) {
      this._updateShapeDraw(e);
      return;
    }

    const mask = this._getActiveMask();
    if (!mask) return;

    const norm = this._screenToNormalized(e.clientX, e.clientY);
    const startNorm = this._screenToNormalized(this._dragStartMouse.x, this._dragStartMouse.y);

    if (this._dragMode === DRAG_MODE.VERTEX) {
      const dx = norm.x - startNorm.x;
      const dy = norm.y - startNorm.y;
      const origPt = this._dragStartPath.points[this._dragVertexIdx];
      const pt = mask.path.points[this._dragVertexIdx];
      pt.x = origPt.x + dx;
      pt.y = origPt.y + dy;
      pt.inX = origPt.inX + dx;
      pt.inY = origPt.inY + dy;
      pt.outX = origPt.outX + dx;
      pt.outY = origPt.outY + dy;
      this._emitMaskUpdate();
    } else if (this._dragMode === DRAG_MODE.HANDLE_IN) {
      const pt = mask.path.points[this._dragVertexIdx];
      pt.inX = norm.x;
      pt.inY = norm.y;
      // Mirror out handle (smooth) unless alt key
      if (!e.altKey) {
        const dx = pt.x - pt.inX;
        const dy = pt.y - pt.inY;
        pt.outX = pt.x + dx;
        pt.outY = pt.y + dy;
      }
      this._emitMaskUpdate();
    } else if (this._dragMode === DRAG_MODE.HANDLE_OUT) {
      const pt = mask.path.points[this._dragVertexIdx];
      pt.outX = norm.x;
      pt.outY = norm.y;
      // Mirror in handle (smooth) unless alt key
      if (!e.altKey) {
        const dx = pt.x - pt.outX;
        const dy = pt.y - pt.outY;
        pt.inX = pt.x + dx;
        pt.inY = pt.y + dy;
      }
      this._emitMaskUpdate();
    } else if (this._dragMode === DRAG_MODE.MOVE_PATH) {
      const dx = norm.x - startNorm.x;
      const dy = norm.y - startNorm.y;
      for (let i = 0; i < mask.path.points.length; i++) {
        const orig = this._dragStartPath.points[i];
        const pt = mask.path.points[i];
        pt.x = orig.x + dx;
        pt.y = orig.y + dy;
        pt.inX = orig.inX + dx;
        pt.inY = orig.inY + dy;
        pt.outX = orig.outX + dx;
        pt.outY = orig.outY + dy;
      }
      this._emitMaskUpdate();
    }

    this._draw();
  },

  _handleMouseUp(e) {
    if (!this._dragging) return;
    e.preventDefault();
    this._stopDrag(false);
  },

  _handleKeyDown(e) {
    if (e.key === 'Escape') {
      if (this._dragging) {
        // Revert drag
        const mask = this._getActiveMask();
        if (mask && this._dragStartPath) {
          mask.path = JSON.parse(JSON.stringify(this._dragStartPath));
          this._emitMaskUpdate();
        }
        this._stopDrag(true);
      } else if (this._penDrawing) {
        this._penDrawing = false;
        this._draw();
      } else {
        // Exit mask edit mode
        editorState.set(STATE_PATHS.UI_MASK_EDIT_MODE, false);
        editorState.set(STATE_PATHS.UI_MASK_TOOL, null);
      }
      e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      this._deleteSelectedVertex();
      e.preventDefault();
    }
  },

  _handleDblClick(e) {
    // Double-click to close pen path
    if (this._penDrawing) {
      const mask = this._getActiveMask();
      if (mask && mask.path.points.length >= 3) {
        mask.path.closed = true;
        this._penDrawing = false;
        this._pushMaskUndo(mask, 'Close mask path');
        this._emitMaskUpdate();
        this._draw();
      }
    }
  },

  // ── Pen Tool ──

  _handlePenClick(e) {
    if (!this._clip) {
      this._resolveClip();
      if (!this._clip) return;
    }

    let mask = this._getActiveMask();

    // Start new mask if no active mask or active mask is closed
    if (!mask || mask.path.closed) {
      mask = createMask('bezier');
      mask.path = { closed: false, points: [] };
      this._clip.masks = this._clip.masks || [];
      this._clip.masks.push(mask);
      this._activeMaskId = mask.id;
      editorState.set(STATE_PATHS.SELECTION_MASK_ID, mask.id);
      editorState.set(STATE_PATHS.UI_MASK_EDIT_MODE, true);
      this._penDrawing = true;
    }

    const norm = this._screenToNormalized(e.clientX, e.clientY);

    // Check if clicking first point to close
    if (mask.path.points.length >= 3) {
      const first = mask.path.points[0];
      const firstScreen = this._normalizedToScreen(first.x, first.y);
      const mx = e.clientX - this._previewRect.left;
      const my = e.clientY - this._previewRect.top;
      if (Math.hypot(mx - firstScreen.x, my - firstScreen.y) < HIT_RADIUS) {
        mask.path.closed = true;
        this._penDrawing = false;
        this._pushMaskUndo(mask, 'Close mask path');
        this._emitMaskUpdate();
        this._draw();
        return;
      }
    }

    // Add new vertex
    mask.path.points.push({
      x: norm.x, y: norm.y,
      inX: norm.x, inY: norm.y,
      outX: norm.x, outY: norm.y
    });

    this._emitMaskUpdate();
    this._draw();
  },

  // ── Shape Drawing (Ellipse/Rectangle) ──

  _startShapeDraw(e, type) {
    if (!this._clip) {
      this._resolveClip();
      if (!this._clip) return;
    }

    this._shapeStart = this._screenToNormalized(e.clientX, e.clientY);
    this._shapeType = type;
    this._dragging = true;
    this._dragMode = DRAG_MODE.DRAW_SHAPE;
    this._dragStartMouse = { x: e.clientX, y: e.clientY };

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
  },

  _updateShapeDraw(e) {
    const end = this._screenToNormalized(e.clientX, e.clientY);
    // Just redraw the preview
    this._shapeEnd = end;
    this._draw();
  },

  _finishShapeDraw() {
    if (!this._shapeStart || !this._shapeEnd) return;

    const s = this._shapeStart;
    const en = this._shapeEnd;
    const left = Math.min(s.x, en.x);
    const top = Math.min(s.y, en.y);
    const right = Math.max(s.x, en.x);
    const bottom = Math.max(s.y, en.y);

    if (right - left < 0.01 || bottom - top < 0.01) {
      this._shapeStart = null;
      this._shapeEnd = null;
      return;
    }

    const mask = createMask(this._shapeType);

    if (this._shapeType === 'rectangle') {
      mask.path = {
        closed: true,
        points: [
          { x: left, y: top, inX: left, inY: top, outX: left, outY: top },
          { x: right, y: top, inX: right, inY: top, outX: right, outY: top },
          { x: right, y: bottom, inX: right, inY: bottom, outX: right, outY: bottom },
          { x: left, y: bottom, inX: left, inY: bottom, outX: left, outY: bottom }
        ]
      };
    } else {
      // Ellipse
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const rx = (right - left) / 2;
      const ry = (bottom - top) / 2;
      const k = 0.5522847498;
      mask.path = {
        closed: true,
        points: [
          { x: cx, y: cy - ry, inX: cx - rx * k, inY: cy - ry, outX: cx + rx * k, outY: cy - ry },
          { x: cx + rx, y: cy, inX: cx + rx, inY: cy - ry * k, outX: cx + rx, outY: cy + ry * k },
          { x: cx, y: cy + ry, inX: cx + rx * k, inY: cy + ry, outX: cx - rx * k, outY: cy + ry },
          { x: cx - rx, y: cy, inX: cx - rx, inY: cy + ry * k, outX: cx - rx, outY: cy - ry * k }
        ]
      };
    }

    this._clip.masks = this._clip.masks || [];
    this._clip.masks.push(mask);
    this._activeMaskId = mask.id;
    editorState.set(STATE_PATHS.SELECTION_MASK_ID, mask.id);
    editorState.set(STATE_PATHS.UI_MASK_EDIT_MODE, true);
    editorState.set(STATE_PATHS.UI_MASK_TOOL, null);

    this._pushMaskUndo(mask, `Add ${this._shapeType} mask`);
    this._emitMaskUpdate();

    this._shapeStart = null;
    this._shapeEnd = null;
    this._draw();
  },

  // ── Drag Operations ──

  _startVertexDrag(e, mask, idx) {
    this._dragging = true;
    this._dragMode = DRAG_MODE.VERTEX;
    this._dragVertexIdx = idx;
    this._dragStartMouse = { x: e.clientX, y: e.clientY };
    this._dragStartPath = JSON.parse(JSON.stringify(mask.path));

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
  },

  _startHandleDrag(e, mask, handle) {
    this._dragging = true;
    this._dragMode = handle.type === 'in' ? DRAG_MODE.HANDLE_IN : DRAG_MODE.HANDLE_OUT;
    this._dragVertexIdx = handle.idx;
    this._dragStartMouse = { x: e.clientX, y: e.clientY };
    this._dragStartPath = JSON.parse(JSON.stringify(mask.path));

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
  },

  _startPathMove(e, mask) {
    this._dragging = true;
    this._dragMode = DRAG_MODE.MOVE_PATH;
    this._dragStartMouse = { x: e.clientX, y: e.clientY };
    this._dragStartPath = JSON.parse(JSON.stringify(mask.path));

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.addEventListener('keydown', this._onKeyDown);
  },

  _stopDrag(cancelled) {
    if (!this._dragging) return;

    if (this._dragMode === DRAG_MODE.DRAW_SHAPE && !cancelled) {
      this._finishShapeDraw();
    } else if (!cancelled) {
      const mask = this._getActiveMask();
      if (mask && this._dragStartPath) {
        const beforePath = this._dragStartPath;
        const afterPath = JSON.parse(JSON.stringify(mask.path));
        const maskRef = mask;

        history.pushWithoutExecute({
          description: 'Edit mask',
          execute() {
            maskRef.path = JSON.parse(JSON.stringify(afterPath));
            eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          },
          undo() {
            maskRef.path = JSON.parse(JSON.stringify(beforePath));
            eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          }
        });
      }
    }

    this._dragging = false;
    this._dragMode = DRAG_MODE.NONE;
    this._dragVertexIdx = -1;
    this._dragStartMouse = null;
    this._dragStartPath = null;

    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('keydown', this._onKeyDown);

    this._draw();
  },

  // ── Vertex Deletion ──

  _deleteSelectedVertex() {
    const mask = this._getActiveMask();
    if (!mask || !mask.path || mask.path.points.length < 3) return;

    // Delete the last vertex if no specific vertex selected
    // In a real app we'd track which vertex is selected
    const beforePath = JSON.parse(JSON.stringify(mask.path));
    mask.path.points.pop();
    const afterPath = JSON.parse(JSON.stringify(mask.path));
    const maskRef = mask;

    history.pushWithoutExecute({
      description: 'Delete mask vertex',
      execute() {
        maskRef.path = JSON.parse(JSON.stringify(afterPath));
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        maskRef.path = JSON.parse(JSON.stringify(beforePath));
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    this._emitMaskUpdate();
    this._draw();
  },

  // ── Helpers ──

  _emitMaskUpdate() {
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  },

  _pushMaskUndo(mask, description) {
    const clip = this._clip;
    const masksCopy = JSON.parse(JSON.stringify(clip.masks));

    history.pushWithoutExecute({
      description,
      execute() {
        clip.masks = JSON.parse(JSON.stringify(masksCopy));
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.masks = clip.masks.filter(m => m.id !== mask.id);
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // ── Drawing ──

  _draw() {
    if (!this._ctx || !this._canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this._canvas.width / dpr;
    const h = this._canvas.height / dpr;
    this._ctx.clearRect(0, 0, w, h);

    // Draw shape preview during drag
    if (this._dragMode === DRAG_MODE.DRAW_SHAPE && this._shapeStart && this._shapeEnd) {
      this._drawShapePreview();
    }

    if (!this._clip || !this._clip.masks) return;

    const maskEditMode = editorState.get(STATE_PATHS.UI_MASK_EDIT_MODE);
    const activeMaskId = this._activeMaskId || editorState.get(STATE_PATHS.SELECTION_MASK_ID);
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;

    // Draw all mask paths
    for (const mask of this._clip.masks) {
      if (!mask.enabled) continue;
      const path = resolveMaskPath(mask, frame);
      if (!path || !path.points || path.points.length < 2) continue;

      const isActive = mask.id === activeMaskId;
      this._drawMaskPath(path, isActive);

      // Draw vertices and handles only for active mask in edit mode
      if (isActive && maskEditMode) {
        this._drawVerticesAndHandles(path);
      }
    }
  },

  _drawMaskPath(path, isActive) {
    const ctx = this._ctx;
    const pts = path.points;

    ctx.beginPath();
    const s0 = this._normalizedToScreen(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);

    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const cp1 = this._normalizedToScreen(prev.outX, prev.outY);
      const cp2 = this._normalizedToScreen(curr.inX, curr.inY);
      const end = this._normalizedToScreen(curr.x, curr.y);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
    }

    if (path.closed && pts.length >= 3) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      const cp1 = this._normalizedToScreen(last.outX, last.outY);
      const cp2 = this._normalizedToScreen(first.inX, first.inY);
      const end = this._normalizedToScreen(first.x, first.y);
      ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, end.x, end.y);
      ctx.closePath();
    }

    // Fill preview
    if (isActive) {
      ctx.fillStyle = COLORS.PREVIEW;
      ctx.fill();
    }

    // Stroke
    ctx.strokeStyle = isActive ? COLORS.PATH_SELECTED : 'rgba(0,255,136,0.4)';
    ctx.lineWidth = isActive ? 2 : 1;
    ctx.setLineDash(isActive ? [] : [4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  },

  _drawVerticesAndHandles(path) {
    const ctx = this._ctx;
    const pts = path.points;

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const vs = this._normalizedToScreen(pt.x, pt.y);
      const inS = this._normalizedToScreen(pt.inX, pt.inY);
      const outS = this._normalizedToScreen(pt.outX, pt.outY);

      // Handle lines
      ctx.beginPath();
      ctx.moveTo(inS.x, inS.y);
      ctx.lineTo(vs.x, vs.y);
      ctx.lineTo(outS.x, outS.y);
      ctx.strokeStyle = COLORS.HANDLE_LINE;
      ctx.lineWidth = 1;
      ctx.stroke();

      // In handle
      ctx.beginPath();
      ctx.arc(inS.x, inS.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.HANDLE;
      ctx.fill();

      // Out handle
      ctx.beginPath();
      ctx.arc(outS.x, outS.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.HANDLE;
      ctx.fill();

      // Vertex
      ctx.beginPath();
      ctx.arc(vs.x, vs.y, VERTEX_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.VERTEX;
      ctx.strokeStyle = COLORS.VERTEX_STROKE;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  },

  _drawShapePreview() {
    const ctx = this._ctx;
    const s = this._normalizedToScreen(this._shapeStart.x, this._shapeStart.y);
    const e = this._normalizedToScreen(this._shapeEnd.x, this._shapeEnd.y);

    ctx.strokeStyle = COLORS.PATH;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);

    if (this._shapeType === 'rectangle') {
      ctx.strokeRect(
        Math.min(s.x, e.x), Math.min(s.y, e.y),
        Math.abs(e.x - s.x), Math.abs(e.y - s.y)
      );
    } else {
      // Ellipse
      const cx = (s.x + e.x) / 2;
      const cy = (s.y + e.y) / 2;
      const rx = Math.abs(e.x - s.x) / 2;
      const ry = Math.abs(e.y - s.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.setLineDash([]);
  },

  // Public API for external mask selection
  selectMask(maskId) {
    this._activeMaskId = maskId;
    editorState.set(STATE_PATHS.SELECTION_MASK_ID, maskId);
    this._draw();
  },

  enterEditMode(maskId) {
    this._activeMaskId = maskId;
    editorState.set(STATE_PATHS.SELECTION_MASK_ID, maskId);
    editorState.set(STATE_PATHS.UI_MASK_EDIT_MODE, true);
    this._draw();
  },

  exitEditMode() {
    editorState.set(STATE_PATHS.UI_MASK_EDIT_MODE, false);
    editorState.set(STATE_PATHS.UI_MASK_TOOL, null);
    this._penDrawing = false;
    this._draw();
  }
};

export default maskOverlay;

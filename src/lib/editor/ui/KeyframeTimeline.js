// Unified keyframe timeline — single canvas in right pane of split Effect Controls
// Rows are vertically aligned with property rows in the left pane.
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { keyframeEngine, EASING } from '../effects/KeyframeEngine.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import { getClipDuration } from '../timeline/Clip.js';
import { contextMenu } from './ContextMenu.js';
import { sizeCanvasHD } from './uiUtils.js';
import { clamp } from '../core/MathUtils.js';

const DIAMOND_SIZE = 5;
const PLAYHEAD_COLOR = '#4a90d9';
const KF_COLOR = '#e5c07b';
const KF_SELECTED_COLOR = '#4a90d9';
const KF_LINE_COLOR = '#444';
const RULER_BG = '#1e1e1e';
const CANVAS_BG = '#1e1e1e';
const ROW_LINE_COLOR = '#2a2a2a';
const TICK_COLOR = '#555';
const LABEL_COLOR = '#888';
const CLIP_BAR_COLOR = '#5a7aa3';
const SNAP_DISTANCE = 6; // pixels

export const keyframeTimeline = {
  _clip: null,
  _linkedClip: null,
  _rows: [],
  _rightPane: null,
  _canvas: null,
  _ctx: null,
  _rulerCanvas: null,
  _rulerCtx: null,
  _clipBarEl: null,
  _zoomInput: null,
  _scrollTop: 0,
  _zoom: 1,
  _scrollLeft: 0,
  _selectedKf: null,
  _dragging: null,
  _scrubbing: false,
  _unsubs: [],
  _cleanups: [],
  _resizeObserver: null,

  mount(clip, linkedClip, rowMetas, rightPane) {
    this.unmount();
    this._clip = clip;
    this._linkedClip = linkedClip;
    this._rows = rowMetas || [];
    this._rightPane = rightPane;

    if (!rightPane) return;

    // Cache DOM elements
    this._clipBarEl = rightPane.querySelector('.nle-ec-clip-bar');
    this._rulerCanvas = rightPane.querySelector('.nle-ec-ruler');
    this._canvas = rightPane.querySelector('.nle-ec-canvas');
    this._zoomInput = rightPane.querySelector('.nle-ec-zoom');

    if (this._rulerCanvas) this._rulerCtx = this._rulerCanvas.getContext('2d');
    if (this._canvas) this._ctx = this._canvas.getContext('2d');

    // Clip bar info
    this._updateClipBar();

    // Zoom slider
    if (this._zoomInput) {
      this._zoomInput.value = 100;
      this._zoom = 1;
      this._scrollLeft = 0;
      const onZoom = () => {
        const val = parseInt(this._zoomInput.value);
        this._zoom = Math.max(0.01, val / 100);
        this._clampScrollLeft();
        this.render();
      };
      this._zoomInput.addEventListener('input', onZoom);
      this._cleanups.push(() => this._zoomInput.removeEventListener('input', onZoom));
    }

    // ResizeObserver — re-render when panel becomes visible or resizes
    if (this._canvas) {
      this._resizeObserver = new ResizeObserver(() => this.render());
      this._resizeObserver.observe(this._canvas);
      if (this._rulerCanvas) this._resizeObserver.observe(this._rulerCanvas);
    }

    // Attach interaction handlers
    this._attachCanvasHandlers();
    this._attachRulerHandlers();
    this._attachDividerHandlers();

    // Subscribe to events
    const onFrame = () => this.render();
    const onSeek = () => this.render();
    const onUpdate = () => this.render();
    eventBus.on(EDITOR_EVENTS.PLAYBACK_FRAME, onFrame);
    eventBus.on(EDITOR_EVENTS.PLAYBACK_SEEK, onSeek);
    eventBus.on(EDITOR_EVENTS.TIMELINE_UPDATED, onUpdate);
    this._unsubs.push(
      () => eventBus.off(EDITOR_EVENTS.PLAYBACK_FRAME, onFrame),
      () => eventBus.off(EDITOR_EVENTS.PLAYBACK_SEEK, onSeek),
      () => eventBus.off(EDITOR_EVENTS.TIMELINE_UPDATED, onUpdate)
    );

    this.render();
  },

  unmount() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    for (const cleanup of this._cleanups) cleanup();
    this._cleanups = [];
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this._clip = null;
    this._linkedClip = null;
    this._rows = [];
    this._rightPane = null;
    this._canvas = null;
    this._ctx = null;
    this._rulerCanvas = null;
    this._rulerCtx = null;
    this._clipBarEl = null;
    this._zoomInput = null;
    this._selectedKf = null;
    this._dragging = null;
    this._scrubbing = false;
    this._scrollTop = 0;
  },

  setScrollTop(scrollTop) {
    this._scrollTop = scrollTop;
    this._drawCanvas();
  },

  updateRows(rowMetas) {
    this._rows = rowMetas || [];
    this.render();
  },

  render() {
    this._drawRuler();
    this._drawCanvas();
  },

  // -- Clip range helpers (use Clip.js getClipDuration) --

  _getDuration() {
    if (!this._clip) return 1;
    return getClipDuration(this._clip) || 1;
  },

  _getClipRange() {
    if (!this._clip) return { start: 0, end: 1 };
    const start = this._clip.startFrame;
    const end = start + this._getDuration();
    return { start, end };
  },

  _updateClipBar() {
    if (!this._clipBarEl || !this._clip) return;
    const duration = this._getDuration();
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const sec = duration / fps;
    this._clipBarEl.innerHTML = '';
    const colorDot = document.createElement('span');
    colorDot.className = 'nle-ec-clip-color';
    colorDot.style.background = this._clip.color || CLIP_BAR_COLOR;
    this._clipBarEl.appendChild(colorDot);
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${this._clip.name || 'Clip'} (${sec.toFixed(1)}s)`;
    this._clipBarEl.appendChild(nameSpan);
  },

  // -- Visible range (zoom-aware) --

  _visibleDuration() {
    return this._getDuration() * this._zoom;
  },

  _visibleStart() {
    if (!this._clip) return 0;
    return this._clip.startFrame + this._scrollLeft;
  },

  _visibleEnd() {
    return this._visibleStart() + this._visibleDuration();
  },

  _frameToX(frame, width) {
    const vStart = this._visibleStart();
    const vDur = this._visibleDuration();
    if (vDur <= 0) return 0;
    return ((frame - vStart) / vDur) * width;
  },

  _xToFrame(x, width) {
    const vStart = this._visibleStart();
    const vDur = this._visibleDuration();
    return Math.round(vStart + (x / width) * vDur);
  },

  _clampScrollLeft() {
    const totalDur = this._getDuration();
    const visDur = this._visibleDuration();
    const maxScroll = Math.max(0, totalDur - visDur);
    this._scrollLeft = clamp(this._scrollLeft, 0, maxScroll);
  },

  // -- Ruler drawing --

  _drawRuler() {
    if (!this._rulerCanvas || !this._rulerCtx) return;
    const canvas = this._rulerCanvas;
    const ctx = this._rulerCtx;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight || 20;
    if (w <= 0 || h <= 0) return;
    sizeCanvasHD(canvas, ctx, w, h);

    ctx.fillStyle = RULER_BG;
    ctx.fillRect(0, 0, w, h);

    if (!this._clip) return;

    const vStart = this._visibleStart();
    const vEnd = this._visibleEnd();
    const vDur = this._visibleDuration();
    if (vDur <= 0) return;

    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const pxPerFrame = w / vDur;

    // Pick tick interval
    let tickFrames = 1;
    const intervals = [1, 5, 10, 15, 30, fps, fps * 2, fps * 5, fps * 10, fps * 30, fps * 60];
    for (const iv of intervals) {
      if (iv * pxPerFrame >= 40) { tickFrames = iv; break; }
    }

    ctx.font = '9px sans-serif';
    ctx.textBaseline = 'top';
    const firstTick = Math.ceil(vStart / tickFrames) * tickFrames;
    for (let f = firstTick; f <= vEnd; f += tickFrames) {
      const x = this._frameToX(f, w);
      ctx.strokeStyle = TICK_COLOR;
      ctx.beginPath();
      ctx.moveTo(x, h - 8);
      ctx.lineTo(x, h);
      ctx.stroke();

      const sec = f / fps;
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(Math.floor(sec % 60)).padStart(2, '0');
      const ff = String(Math.floor(f % fps)).padStart(2, '0');
      ctx.fillStyle = LABEL_COLOR;
      ctx.fillText(`${mm}:${ss}:${ff}`, x + 2, 2);
    }

    // Playhead triangle + line
    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    if (currentFrame >= vStart && currentFrame <= vEnd) {
      const px = this._frameToX(currentFrame, w);
      ctx.fillStyle = PLAYHEAD_COLOR;
      ctx.beginPath();
      ctx.moveTo(px - 4, 0);
      ctx.lineTo(px + 4, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = PLAYHEAD_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 8);
      ctx.lineTo(px, h);
      ctx.stroke();
    }

    // Bottom border
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
  },

  // -- Main keyframe canvas --

  _drawCanvas() {
    if (!this._canvas || !this._ctx) return;
    const canvas = this._canvas;
    const ctx = this._ctx;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;
    sizeCanvasHD(canvas, ctx, w, h);

    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, w, h);

    if (!this._clip || this._rows.length === 0) return;

    const scrollTop = this._scrollTop;

    // Draw row guides and keyframes
    for (let ri = 0; ri < this._rows.length; ri++) {
      const row = this._rows[ri];
      const rowY = row.y - scrollTop;
      const rowH = row.height;
      if (rowY + rowH < 0 || rowY > h) continue;

      const cy = rowY + rowH / 2;

      // Row guide line
      ctx.strokeStyle = ROW_LINE_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(w, cy);
      ctx.stroke();

      // Row bottom border
      ctx.strokeStyle = '#222';
      ctx.beginPath();
      ctx.moveTo(0, rowY + rowH);
      ctx.lineTo(w, rowY + rowH);
      ctx.stroke();

      // Keyframes
      const kfs = row.keyframesRef();
      if (!kfs || kfs.length === 0) continue;

      const sorted = [...kfs].sort((a, b) => a.frame - b.frame);

      // Connecting lines
      if (sorted.length > 1) {
        ctx.strokeStyle = KF_LINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < sorted.length; i++) {
          const x = this._frameToX(sorted[i].frame, w);
          if (i === 0) ctx.moveTo(x, cy);
          else ctx.lineTo(x, cy);
        }
        ctx.stroke();
      }

      // Diamonds
      for (let i = 0; i < sorted.length; i++) {
        const kf = sorted[i];
        const x = this._frameToX(kf.frame, w);
        const isSelected = this._selectedKf &&
          this._selectedKf.rowIdx === ri &&
          this._selectedKf.kf === kf;

        ctx.fillStyle = isSelected ? KF_SELECTED_COLOR : KF_COLOR;
        ctx.beginPath();
        ctx.moveTo(x, cy - DIAMOND_SIZE);
        ctx.lineTo(x + DIAMOND_SIZE, cy);
        ctx.lineTo(x, cy + DIAMOND_SIZE);
        ctx.lineTo(x - DIAMOND_SIZE, cy);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Playhead vertical line
    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const vStart = this._visibleStart();
    const vEnd = this._visibleEnd();
    if (currentFrame >= vStart && currentFrame <= vEnd) {
      const px = this._frameToX(currentFrame, w);
      ctx.strokeStyle = PLAYHEAD_COLOR;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  },

  // -- Hit testing --

  _hitTestKeyframe(mouseX, mouseY) {
    if (!this._canvas) return null;
    const w = this._canvas.clientWidth;
    const scrollTop = this._scrollTop;
    const hitRadius = DIAMOND_SIZE + 3;

    for (let ri = 0; ri < this._rows.length; ri++) {
      const row = this._rows[ri];
      const rowY = row.y - scrollTop;
      const cy = rowY + row.height / 2;
      if (Math.abs(mouseY - cy) > row.height / 2) continue;

      const kfs = row.keyframesRef();
      if (!kfs || kfs.length === 0) continue;

      const sorted = [...kfs].sort((a, b) => a.frame - b.frame);
      for (let i = 0; i < sorted.length; i++) {
        const x = this._frameToX(sorted[i].frame, w);
        if (Math.abs(mouseX - x) <= hitRadius) {
          return { rowIdx: ri, kfIndex: i, kf: sorted[i], row };
        }
      }
    }
    return null;
  },

  _hitTestRow(mouseY) {
    const scrollTop = this._scrollTop;
    for (let ri = 0; ri < this._rows.length; ri++) {
      const row = this._rows[ri];
      const rowY = row.y - scrollTop;
      if (mouseY >= rowY && mouseY < rowY + row.height) {
        return { rowIdx: ri, row };
      }
    }
    return null;
  },

  // -- Canvas mouse handlers --

  _attachCanvasHandlers() {
    if (!this._canvas) return;
    const canvas = this._canvas;

    // Make focusable for keyboard events
    canvas.setAttribute('tabindex', '0');
    canvas.style.outline = 'none';

    const onMouseDown = (e) => {
      canvas.focus();
      if (e.button === 2) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._hitTestKeyframe(x, y);

      if (hit) {
        // Select and start drag — store direct kf object reference (not sort index)
        this._selectedKf = { rowIdx: hit.rowIdx, kf: hit.kf };
        this._dragging = {
          kf: hit.kf,
          originalFrame: hit.kf.frame,
          startX: e.clientX
        };
        this.render();

        const onMouseMove = (me) => {
          if (!this._dragging) return;
          const dx = me.clientX - this._dragging.startX;
          const w = canvas.clientWidth;
          const vDur = this._visibleDuration();
          const frameDelta = Math.round((dx / w) * vDur);
          const { start, end } = this._getClipRange();
          let newFrame = clamp(this._dragging.originalFrame + frameDelta, start, end);

          // Snap to playhead
          const playhead = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
          const playheadX = this._frameToX(playhead, w);
          const newX = this._frameToX(newFrame, w);
          if (Math.abs(newX - playheadX) < SNAP_DISTANCE) {
            newFrame = playhead;
          }

          this._dragging.kf.frame = newFrame;
          this.render();
        };

        const onMouseUp = () => {
          if (this._dragging) {
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            this._dragging = null;
          }
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      } else {
        // Double-click on empty row space = add keyframe at that frame
        this._selectedKf = null;
        this.render();
      }
    };

    const onDblClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const w = canvas.clientWidth;

      // If double-clicking a keyframe, ignore (already handled)
      const hit = this._hitTestKeyframe(x, y);
      if (hit) return;

      // Find which row was clicked
      const rowHit = this._hitTestRow(y);
      if (!rowHit) return;

      const frame = this._xToFrame(x, w);
      const { start, end } = this._getClipRange();
      if (frame < start || frame > end) return;

      // Add a keyframe at this frame with the current param value
      const row = rowHit.row;
      const fx = row.effectRef;
      if (!fx.keyframes) fx.keyframes = {};
      if (!fx.keyframes[row.paramId]) fx.keyframes[row.paramId] = [];
      keyframeEngine.addKeyframe(fx.keyframes[row.paramId], frame, fx.params[row.paramId]);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      this.render();
    };

    const onContextMenu = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._hitTestKeyframe(x, y);
      if (!hit) return;

      this._selectedKf = { rowIdx: hit.rowIdx, kf: hit.kf };
      this.render();

      const row = this._rows[hit.rowIdx];
      const kf = hit.kf;
      if (!kf) return;

      const easingItems = [
        { label: 'Linear', easing: EASING.LINEAR },
        { label: 'Ease In', easing: EASING.EASE_IN },
        { label: 'Ease Out', easing: EASING.EASE_OUT },
        { label: 'Ease In/Out', easing: EASING.EASE_IN_OUT },
        { label: 'Hold', easing: EASING.HOLD }
      ];

      const items = easingItems.map(item => ({
        label: `${item.label}${kf.easing === item.easing ? ' \u2713' : ''}`,
        action: () => {
          kf.easing = item.easing;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          this.render();
        }
      }));

      items.push({ separator: true });
      items.push({
        label: 'Delete Keyframe',
        action: () => {
          const arr = row.keyframesRef();
          const idx = arr.findIndex(k => k.frame === kf.frame);
          if (idx >= 0) arr.splice(idx, 1);
          this._selectedKf = null;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          this.render();
        }
      });

      contextMenu.show(e.clientX, e.clientY, items);
    };

    // Shift+wheel = horizontal scroll
    const onWheel = (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const delta = e.deltaY || e.deltaX;
      const vDur = this._visibleDuration();
      this._scrollLeft += Math.sign(delta) * Math.max(1, Math.round(vDur * 0.05));
      this._clampScrollLeft();
      this.render();
    };

    // Delete/Backspace removes selected keyframe
    const onKeyDown = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this._selectedKf) {
        const row = this._rows[this._selectedKf.rowIdx];
        const kf = this._selectedKf.kf;
        if (row && kf) {
          const kfs = row.keyframesRef();
          const idx = kfs.indexOf(kf);
          if (idx >= 0) kfs.splice(idx, 1);
          this._selectedKf = null;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          this.render();
          e.preventDefault();
        }
      }
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);

    this._cleanups.push(
      () => canvas.removeEventListener('mousedown', onMouseDown),
      () => canvas.removeEventListener('dblclick', onDblClick),
      () => canvas.removeEventListener('contextmenu', onContextMenu),
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('keydown', onKeyDown)
    );
  },

  // -- Ruler scrub handlers --

  _attachRulerHandlers() {
    if (!this._rulerCanvas) return;
    const canvas = this._rulerCanvas;

    const seekToX = (x) => {
      const w = canvas.clientWidth;
      const frame = this._xToFrame(x, w);
      const { start, end } = this._getClipRange();
      playbackEngine.seek(clamp(frame, start, end));
    };

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      seekToX(e.clientX - rect.left);
      this._scrubbing = true;

      const onMouseMove = (me) => {
        if (!this._scrubbing) return;
        const rx = me.clientX - rect.left;
        seekToX(clamp(rx, 0, canvas.clientWidth));
      };

      const onMouseUp = () => {
        this._scrubbing = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onWheel = (e) => {
      if (!e.shiftKey) return;
      e.preventDefault();
      const delta = e.deltaY || e.deltaX;
      const vDur = this._visibleDuration();
      this._scrollLeft += Math.sign(delta) * Math.max(1, Math.round(vDur * 0.05));
      this._clampScrollLeft();
      this.render();
    };

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    this._cleanups.push(
      () => canvas.removeEventListener('mousedown', onMouseDown),
      () => canvas.removeEventListener('wheel', onWheel)
    );
  },

  // -- Divider drag --

  _attachDividerHandlers() {
    if (!this._rightPane) return;
    const divider = this._rightPane.parentElement?.querySelector('.nle-ec-divider');
    const leftPane = this._rightPane.parentElement?.querySelector('.nle-ec-left');
    if (!divider || !leftPane) return;

    const onMouseDown = (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = leftPane.offsetWidth;
      divider.classList.add('dragging');

      const onMouseMove = (me) => {
        const dx = me.clientX - startX;
        const parentW = leftPane.parentElement.offsetWidth;
        const newWidth = clamp(startWidth + dx, 180, parentW - 120);
        leftPane.style.width = `${newWidth}px`;
        this.render();
      };

      const onMouseUp = () => {
        divider.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    divider.addEventListener('mousedown', onMouseDown);
    this._cleanups.push(() => divider.removeEventListener('mousedown', onMouseDown));
  }
};

export default keyframeTimeline;

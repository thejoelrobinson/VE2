// Timecode ruler with zoom-adaptive tick marks
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, TIMELINE_DEFAULTS, STATE_PATHS } from '../core/Constants.js';
import { frameToPixel, frameToTimecode, getRulerTickInterval, pixelToFrame } from '../timeline/TimelineMath.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { getClipEndFrame } from '../timeline/Clip.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import { renderBarOverlay } from './RenderBarOverlay.js';
import { conformBarOverlay } from './ConformBarOverlay.js';
import { sizeCanvasHD, startDrag } from './uiUtils.js';

export const timelineRuler = {
  _canvas: null,
  _ctx: null,
  _container: null,
  _resizeDebounceId: 0,
  _tooltipEl: null,
  _onKeyDown: null,

  init(container) {
    this._container = container;
    this._canvas = container.querySelector('.nle-ruler-canvas');
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.className = 'nle-ruler-canvas';
      container.appendChild(this._canvas);
    }
    this._ctx = this._canvas.getContext('2d', { alpha: false });

    // Scrub timecode tooltip
    this._tooltipEl = document.createElement('div');
    this._tooltipEl.className = 'nle-ruler-scrub-tooltip';
    this._tooltipEl.style.display = 'none';
    document.body.appendChild(this._tooltipEl);

    // Click to seek, or drag in/out handles
    this._canvas.addEventListener('mousedown', (e) => {
      const rect = this._canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);

      const inPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT);
      const outPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT);

      // Check if near in-point handle
      if (inPoint !== null) {
        const inX = frameToPixel(inPoint) - scrollX;
        if (Math.abs(x - inX) <= 8) {
          startDrag(e, {
            onMove: (e2) => {
              const x2 = e2.clientX - rect.left;
              // Re-read scrollX on each move — timeline may auto-scroll during drag
              const sx = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
              editorState.set(STATE_PATHS.PLAYBACK_IN_POINT, Math.max(0, Math.round(pixelToFrame(x2 + sx))));
              this.render();
              this._updateScrubTooltip(e2);
            },
            onUp: () => this._hideScrubTooltip()
          });
          return;
        }
      }

      // Check if near out-point handle
      if (outPoint !== null) {
        const outX = frameToPixel(outPoint) - scrollX;
        if (Math.abs(x - outX) <= 8) {
          startDrag(e, {
            onMove: (e2) => {
              const x2 = e2.clientX - rect.left;
              const sx = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
              editorState.set(STATE_PATHS.PLAYBACK_OUT_POINT, Math.max(0, Math.round(pixelToFrame(x2 + sx))));
              this.render();
              this._updateScrubTooltip(e2);
            },
            onUp: () => this._hideScrubTooltip()
          });
          return;
        }
      }

      // Default: seek
      this._handleSeek(e);
      startDrag(e, {
        onMove: (e2) => {
          this._handleSeek(e2);
          this._updateScrubTooltip(e2);
        },
        onUp: () => this._hideScrubTooltip()
      });
    });

    // Cursor change + tooltip on hover
    this._canvas.addEventListener('mousemove', (e) => {
      const rect = this._canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
      const inPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT);
      const outPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT);
      let nearHandle = false;
      if (inPoint !== null && Math.abs(x - (frameToPixel(inPoint) - scrollX)) <= 8) nearHandle = true;
      if (outPoint !== null && Math.abs(x - (frameToPixel(outPoint) - scrollX)) <= 8) nearHandle = true;
      this._canvas.style.cursor = nearHandle ? 'ew-resize' : 'pointer';
      this._updateScrubTooltip(e);
    });

    this._canvas.addEventListener('mouseleave', () => {
      this._hideScrubTooltip();
    });

    // Previous / Next edit point (Up / Down arrow keys)
    this._onKeyDown = (e) => {
      if (e.target.closest('input, textarea, [contenteditable]')) return;
      if (e.ctrlKey || e.metaKey) return;

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
        const tracks = timelineEngine.getTracks();

        // Collect all edit points (clip start and end frames, including speed-adjusted clips)
        const editPoints = new Set([0]);
        for (const track of tracks) {
          for (const clip of track.clips) {
            editPoints.add(clip.startFrame);
            editPoints.add(getClipEndFrame(clip));
          }
        }
        const sorted = [...editPoints].sort((a, b) => a - b);

        if (e.key === 'ArrowUp') {
          // Previous edit point (strictly before currentFrame)
          const prev = sorted.filter(f => f < currentFrame).pop();
          if (prev !== undefined) playbackEngine.seek(prev);
        } else {
          // Next edit point (strictly after currentFrame)
          const next = sorted.find(f => f > currentFrame);
          if (next !== undefined) playbackEngine.seek(next);
        }
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

    eventBus.on(EDITOR_EVENTS.PLAYBACK_FRAME, () => this.render());
    eventBus.on(EDITOR_EVENTS.ZOOM_CHANGED, () => this.render());
    eventBus.on(EDITOR_EVENTS.SCROLL_CHANGED, () => this.render());
    eventBus.on(EDITOR_EVENTS.TIMELINE_UPDATED, () => this.render());
    eventBus.on(EDITOR_EVENTS.RENDER_BUFFER_CHANGED, () => this.render());
    eventBus.on(EDITOR_EVENTS.CONFORM_BUFFER_CHANGED, () => this.render());

    // Re-render when in/out points change
    editorState.subscribe(STATE_PATHS.PLAYBACK_IN_POINT, () => this.render());
    editorState.subscribe(STATE_PATHS.PLAYBACK_OUT_POINT, () => this.render());

    this._resizeObs = new ResizeObserver(() => {
      clearTimeout(this._resizeDebounceId);
      this._resizeDebounceId = setTimeout(() => this.render(), 100);
    });
    this._resizeObs.observe(container);
    this.render();
  },

  cleanup() {
    if (this._resizeDebounceId) {
      clearTimeout(this._resizeDebounceId);
      this._resizeDebounceId = 0;
    }
    if (this._resizeObs) {
      this._resizeObs.disconnect();
      this._resizeObs = null;
    }
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._tooltipEl) {
      this._tooltipEl.remove();
      this._tooltipEl = null;
    }
  },

  _handleSeek(e) {
    const rect = this._canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const frame = pixelToFrame(x + scrollX);
    playbackEngine.seek(Math.max(0, frame));
  },

  _updateScrubTooltip(e) {
    if (!this._tooltipEl) return;
    const rect = this._canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const frame = Math.max(0, pixelToFrame(x + scrollX));
    this._tooltipEl.textContent = frameToTimecode(Math.round(frame));
    this._tooltipEl.style.display = 'block';
    this._tooltipEl.style.left = `${e.clientX}px`;
    this._tooltipEl.style.top = `${rect.top - 28}px`;
  },

  _hideScrubTooltip() {
    if (this._tooltipEl) this._tooltipEl.style.display = 'none';
  },

  render() {
    if (!this._canvas || !this._ctx) return;

    const container = this._container;
    const rect = container.getBoundingClientRect();
    sizeCanvasHD(this._canvas, this._ctx, rect.width, TIMELINE_DEFAULTS.RULER_HEIGHT);

    const ctx = this._ctx;

    const w = rect.width;
    const h = TIMELINE_DEFAULTS.RULER_HEIGHT;
    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const interval = getRulerTickInterval();

    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Ticks and labels
    const startFrame = pixelToFrame(scrollX);
    const endFrame = pixelToFrame(scrollX + w);
    const firstTick = Math.floor(startFrame / interval) * interval;

    ctx.fillStyle = '#888';
    ctx.strokeStyle = '#555';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';

    for (let frame = firstTick; frame <= endFrame; frame += interval) {
      const x = frameToPixel(frame) - scrollX;

      // Major tick
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, h - 10);
      ctx.stroke();

      // Label
      ctx.fillText(frameToTimecode(frame), x, h - 14);

      // Minor ticks (subdivide)
      const subInterval = interval / 4;
      if (subInterval >= 1) {
        for (let sub = 1; sub < 4; sub++) {
          const subFrame = frame + sub * subInterval;
          const subX = frameToPixel(subFrame) - scrollX;
          ctx.beginPath();
          ctx.moveTo(subX, h);
          ctx.lineTo(subX, h - 5);
          ctx.stroke();
        }
      }
    }

    // Render bars (green/yellow/red performance indicators)
    renderBarOverlay.draw(ctx, w, h, scrollX);

    // Conform bars (blue — pre-encoded at sequence settings)
    conformBarOverlay.draw(ctx, w, h, scrollX);

    // In/Out point region (like Premiere's blue highlight between I and O)
    const inPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT);
    const outPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT);

    if (inPoint !== null || outPoint !== null) {
      const inX = inPoint !== null ? frameToPixel(inPoint) - scrollX : 0;
      const outX = outPoint !== null ? frameToPixel(outPoint) - scrollX : w;

      // Shaded region between in and out
      ctx.fillStyle = 'rgba(66, 133, 244, 0.15)';
      ctx.fillRect(inX, 0, outX - inX, h);

      // Dim regions outside in/out range
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      if (inPoint !== null && inX > 0) {
        ctx.fillRect(0, 0, inX, h);
      }
      if (outPoint !== null && outX < w) {
        ctx.fillRect(outX, 0, w - outX, h);
      }

      // In point bracket
      if (inPoint !== null) {
        ctx.fillStyle = '#4285f4';
        ctx.fillRect(inX, 0, 2, h);
        // Bracket shape
        ctx.fillRect(inX, 0, 6, 2);
        ctx.fillRect(inX, h - 2, 6, 2);
      }

      // Out point bracket
      if (outPoint !== null) {
        ctx.fillStyle = '#4285f4';
        ctx.fillRect(outX - 2, 0, 2, h);
        // Bracket shape
        ctx.fillRect(outX - 6, 0, 6, 2);
        ctx.fillRect(outX - 6, h - 2, 6, 2);
      }
    }

    // Playhead indicator
    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const playheadX = frameToPixel(currentFrame) - scrollX;
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.moveTo(playheadX - 5, 0);
    ctx.lineTo(playheadX + 5, 0);
    ctx.lineTo(playheadX + 5, 8);
    ctx.lineTo(playheadX, 14);
    ctx.lineTo(playheadX - 5, 8);
    ctx.closePath();
    ctx.fill();

    // Bottom border
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
  }
};

export default timelineRuler;

// Output preview canvas with fit-to-panel scaling
// Supports two modes:
//   1. Worker mode: display canvas transferred to CompositorWorker via OffscreenCanvas.
//      Worker draws directly to the visible canvas. ProgramMonitor only manages sizing.
//   2. Main-thread mode (fallback): compositor renders to hidden canvas,
//      ProgramMonitor blits to display canvas.
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { videoCompositor } from '../playback/VideoCompositor.js';
import { colorManagement } from '../core/ColorManagement.js';
import logger from '../../utils/logger.js';

const ZOOM_LEVELS = ['fit', 0.25, 0.5, 0.75, 1, 1.5, 2, 4];

export const programMonitor = {
  _container: null,
  _canvas: null,          // Hidden compositing canvas (main-thread mode only)
  _displayCanvas: null,   // Visible canvas element
  _displayCtx: null,      // 2D context (main-thread mode only; null in worker mode)
  _resizeObserver: null,
  _rendering: false,
  _pendingFrame: null,
  _workerMode: false,     // True if compositor worker owns the display canvas
  _zoomLevel: 'fit',
  _zoomSelect: null,
  _zoomRafId: 0,

  init(container) {
    if (!container) {
      this._container = document.querySelector('.nle-program-monitor');
    } else {
      this._container = container;
    }
    if (!this._container) return;

    this._previewArea = this._container.querySelector('.nle-program-preview');
    if (!this._previewArea) {
      this._previewArea = this._container;
    }

    // Create (or find) the display canvas
    this._displayCanvas = this._previewArea.querySelector('.nle-program-canvas');
    if (!this._displayCanvas) {
      this._displayCanvas = document.createElement('canvas');
      this._displayCanvas.className = 'nle-program-canvas';
      this._displayCanvas.width = 960;
      this._displayCanvas.height = 540;
      this._previewArea.appendChild(this._displayCanvas);
    }

    // Detect display P3 support and check working space for wide-gamut canvas output
    const supportsP3 = window.matchMedia?.('(color-gamut: p3)')?.matches;
    const workingSpace = colorManagement.getWorkingSpace();
    const useP3Canvas = supportsP3 && workingSpace === 'display-p3';
    if (useP3Canvas) {
      logger.info('Display P3 canvas output enabled (display supports P3, working space is display-p3)');
    }

    // Try to set up compositor worker with the display canvas.
    // If successful, the worker owns the display canvas (OffscreenCanvas) and
    // draws directly to it. We don't need a separate compositing canvas.
    this._workerMode = videoCompositor.initWorker(this._displayCanvas, { useP3: useP3Canvas });

    if (this._workerMode) {
      // Worker mode: create a hidden compositing canvas for the main-thread
      // fallback path (compositeFrameTo for export still needs it).
      this._canvas = document.createElement('canvas');
      videoCompositor.init(this._canvas);
      // No display context — worker draws directly to the display canvas
      this._displayCtx = null;

      // If the worker crashes, switch to main-thread rendering
      videoCompositor._onWorkerFallback = () => {
        this._workerMode = false;
        // Re-create the display canvas (OffscreenCanvas transfer is irreversible)
        const newCanvas = document.createElement('canvas');
        newCanvas.className = 'nle-program-canvas';
        this._displayCanvas.replaceWith(newCanvas);
        this._displayCanvas = newCanvas;
        const ctxOpts = { alpha: false };
        if (useP3Canvas) ctxOpts.colorSpace = 'display-p3';
        this._displayCtx = this._displayCanvas.getContext('2d', ctxOpts);
        this._fitCanvas();
        this._requestRender();
        logger.info('ProgramMonitor switched to main-thread rendering after worker crash');
      };
    } else {
      // Main-thread mode: create display context with P3 colorSpace when available
      const ctxOpts = { alpha: false };
      if (useP3Canvas) ctxOpts.colorSpace = 'display-p3';
      this._displayCtx = this._displayCanvas.getContext('2d', ctxOpts);
      this._canvas = document.createElement('canvas');
      videoCompositor.init(this._canvas);
    }

    // Resize display canvas to fit panel
    this._resizeObserver = new ResizeObserver(() => {
      this._fitCanvas();
      const clips = editorState.get(STATE_PATHS.TIMELINE_TRACKS);
      if (!clips || clips.length === 0) {
        if (!this._workerMode) this._drawPlaceholder();
      } else {
        this._requestRender();
      }
    });
    this._resizeObserver.observe(this._previewArea);
    this._fitCanvas();

    if (!this._workerMode) {
      this._drawPlaceholder();
    }

    // Refit display canvas when sequence resolution changes
    editorState.subscribe(STATE_PATHS.PROJECT_CANVAS, () => {
      this._fitCanvas();
      this._requestRender();
    });

    // Listen for frame updates
    eventBus.on(EDITOR_EVENTS.PLAYBACK_FRAME, () => this._requestRender());
    eventBus.on(EDITOR_EVENTS.PLAYBACK_SEEK, () => this._requestRender());
    eventBus.on(EDITOR_EVENTS.TIMELINE_UPDATED, () => this._requestRender());

    // On sequence switch, refit canvas for new resolution
    eventBus.on(EDITOR_EVENTS.SEQUENCE_ACTIVATED, () => {
      this._fitCanvas();
      this._requestRender();
    });

    // Zoom controls
    this._zoomSelect = this._container.querySelector('.nle-program-zoom-select');
    if (this._zoomSelect) {
      this._zoomSelect.addEventListener('change', (e) => {
        this._setZoom(e.target.value === 'fit' ? 'fit' : parseFloat(e.target.value));
      });
    }

    // Ctrl+wheel zoom on preview area
    this._onWheel = this._onWheel.bind(this);
    this._previewArea.addEventListener('wheel', this._onWheel, { passive: false });
  },

  _drawPlaceholder() {
    if (!this._displayCtx || !this._displayCanvas) return;
    const w = this._displayCanvas.width;
    const h = this._displayCanvas.height;
    this._displayCtx.fillStyle = '#000';
    this._displayCtx.fillRect(0, 0, w, h);
    this._displayCtx.fillStyle = '#555';
    this._displayCtx.font = '14px sans-serif';
    this._displayCtx.textAlign = 'center';
    this._displayCtx.textBaseline = 'middle';
    this._displayCtx.fillText('No Sequence', w / 2, h / 2);
  },

  _setZoom(value) {
    this._zoomLevel = value;
    if (this._zoomSelect) {
      this._zoomSelect.value = value === 'fit' ? 'fit' : String(value);
    }
    const isZoomed = value !== 'fit';
    this._previewArea.classList.toggle('zoomed', isZoomed);
    this._fitCanvas();

    // When at a fixed zoom, scroll to center the canvas
    if (isZoomed) {
      this._zoomRafId = requestAnimationFrame(() => {
        if (!this._previewArea) return;
        const pa = this._previewArea;
        pa.scrollLeft = (pa.scrollWidth - pa.clientWidth) / 2;
        pa.scrollTop = (pa.scrollHeight - pa.clientHeight) / 2;
      });
    }
  },

  _onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const idx = ZOOM_LEVELS.indexOf(this._zoomLevel);
    const newIdx = e.deltaY < 0
      ? Math.min(idx + 1, ZOOM_LEVELS.length - 1)
      : Math.max(idx - 1, 0);
    if (newIdx !== idx) this._setZoom(ZOOM_LEVELS[newIdx]);
  },

  _fitCanvas() {
    if (!this._previewArea || !this._displayCanvas) return;
    const { width: projW, height: projH } = editorState.get(STATE_PATHS.PROJECT_CANVAS);

    let newW, newH;

    if (this._zoomLevel === 'fit') {
      const rect = this._previewArea.getBoundingClientRect();
      const containerW = rect.width - 16;
      const containerH = rect.height - 16;
      const scale = Math.min(containerW / projW, containerH / projH);
      newW = Math.round(projW * scale);
      newH = Math.round(projH * scale);
    } else {
      const zoom = this._zoomLevel;
      newW = Math.round(projW * zoom);
      newH = Math.round(projH * zoom);
    }

    this._displayCanvas.style.width = `${newW}px`;
    this._displayCanvas.style.height = `${newH}px`;

    if (!this._workerMode) {
      this._displayCanvas.width = newW;
      this._displayCanvas.height = newH;
    }
  },

  _requestRender() {
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    if (this._rendering) {
      this._pendingFrame = frame;
      return;
    }
    this._processRender(frame);
  },

  async _processRender(frame) {
    this._rendering = true;
    this._pendingFrame = null;

    try {
      await this._renderFrame(frame);
    } catch (e) {
      logger.warn('ProgramMonitor render error:', e);
    }

    this._rendering = false;

    if (this._pendingFrame !== null) {
      const next = this._pendingFrame;
      this._pendingFrame = null;
      try {
        await this._processRender(next);
      } catch (err) {
        logger.warn('[ProgramMonitor] Deferred render failed:', err);
      }
    }
  },

  async _renderFrame(frame) {
    if (this._workerMode) {
      // Worker mode: just tell the compositor to render.
      // The worker draws directly to the OffscreenCanvas (display canvas).
      await videoCompositor.compositeFrame(frame);
      // No blit needed — the worker canvas IS the display canvas.
    } else {
      // Main-thread mode: compositor renders to hidden canvas, we blit to display.
      await videoCompositor.compositeFrame(frame);

      if (this._displayCtx && this._canvas) {
        this._displayCtx.clearRect(0, 0, this._displayCanvas.width, this._displayCanvas.height);
        this._displayCtx.drawImage(
          this._canvas,
          0, 0, this._canvas.width, this._canvas.height,
          0, 0, this._displayCanvas.width, this._displayCanvas.height
        );
      }
    }
  },

  cleanup() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
    if (this._previewArea && this._onWheel) {
      this._previewArea.removeEventListener('wheel', this._onWheel);
    }
    if (this._zoomRafId) {
      cancelAnimationFrame(this._zoomRafId);
      this._zoomRafId = 0;
    }
    this._rendering = false;
    this._pendingFrame = null;
    this._workerMode = false;
    this._zoomLevel = 'fit';
    videoCompositor.cleanup();
  }
};

export default programMonitor;

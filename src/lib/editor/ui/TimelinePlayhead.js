// Red playhead line with scrub handle
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, TIMELINE_DEFAULTS, STATE_PATHS } from '../core/Constants.js';
import { frameToPixel, pixelToFrame } from '../timeline/TimelineMath.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import { startDrag } from './uiUtils.js';

export const timelinePlayhead = {
  _element: null,
  _container: null,

  init(container) {
    this._container = container;

    // Create playhead element
    this._element = container.querySelector('.nle-playhead');
    if (!this._element) {
      this._element = document.createElement('div');
      this._element.className = 'nle-playhead';
      this._element.innerHTML = '<div class="nle-playhead-line"></div>';
      container.appendChild(this._element);
    }

    // Scrubbing via mouse on the track area
    this._container.addEventListener('mousedown', (e) => {
      // Only handle clicks on the timeline body (not clips, not headers)
      if (e.target.closest('.nle-clip') || e.target.closest('.nle-track-header')) return;
      if (!e.target.closest('.nle-timeline-body')) return;

      this._handleScrub(e);
      startDrag(e, { onMove: (e2) => this._handleScrub(e2) });
    });

    eventBus.on(EDITOR_EVENTS.PLAYBACK_FRAME, () => this._updatePosition());
    eventBus.on(EDITOR_EVENTS.PLAYBACK_SEEK, () => this._updatePosition());
    eventBus.on(EDITOR_EVENTS.ZOOM_CHANGED, () => this._updatePosition());

    this._updatePosition();
  },

  _handleScrub(e) {
    const body = this._container.querySelector('.nle-timeline-body');
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const x = e.clientX - rect.left - TIMELINE_DEFAULTS.TRACK_HEADER_WIDTH;
    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const frame = pixelToFrame(x + scrollX);
    playbackEngine.seek(Math.max(0, frame));
  },

  _updatePosition() {
    if (!this._element) return;
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    // Use absolute frame position — the scroll container handles scroll offset.
    // The CSS left: 180px offsets past the track headers.
    const x = frameToPixel(frame);
    this._element.style.transform = `translateX(${x}px)`;
  }
};

export default timelinePlayhead;

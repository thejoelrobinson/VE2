// Source clip preview with in/out marking
import { mediaManager } from '../media/MediaManager.js';
import { MEDIA_TYPES, STATE_PATHS } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { secondsToFrame } from '../timeline/TimelineMath.js';

export const sourceMonitor = {
  _container: null,
  _videoEl: null,
  _canvasEl: null,
  _ctx: null,
  _currentMediaId: null,
  _inTime: null,
  _outTime: null,

  init(container) {
    this._container = container;

    this._videoEl = container.querySelector('.nle-source-video');
    if (!this._videoEl) {
      this._videoEl = document.createElement('video');
      this._videoEl.className = 'nle-source-video';
      this._videoEl.controls = true;
      this._videoEl.muted = false;
      container.querySelector('.nle-source-preview')?.appendChild(this._videoEl);
    }
    // Hide until a clip is loaded
    this._videoEl.style.display = 'none';

    // In/Out buttons
    container.querySelector('.nle-source-mark-in')?.addEventListener('click', () => {
      this._inTime = this._videoEl.currentTime;
      this._updateMarks();
    });

    container.querySelector('.nle-source-mark-out')?.addEventListener('click', () => {
      this._outTime = this._videoEl.currentTime;
      this._updateMarks();
    });

    // Insert to timeline
    container.querySelector('.nle-source-insert')?.addEventListener('click', () => {
      this._insertToTimeline();
    });
  },

  loadMedia(mediaId) {
    const item = mediaManager.getItem(mediaId);
    if (!item) return;

    this._currentMediaId = mediaId;
    this._inTime = null;
    this._outTime = null;

    // Hide empty-state placeholder
    const emptyEl = this._container?.querySelector('.nle-source-empty');
    if (emptyEl) emptyEl.style.display = 'none';

    if (item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.AUDIO) {
      this._videoEl.src = item.url;
      this._videoEl.style.display = '';
      // Hide any existing image element from a previous IMAGE load
      const existingImg = this._container?.querySelector('.nle-source-image');
      if (existingImg) existingImg.style.display = 'none';
    } else if (item.type === MEDIA_TYPES.IMAGE) {
      // Show image in an img tag instead
      this._videoEl.style.display = 'none';
      let imgEl = this._container?.querySelector('.nle-source-image');
      if (!imgEl) {
        imgEl = document.createElement('img');
        imgEl.className = 'nle-source-image nle-source-video';
        this._container?.querySelector('.nle-source-preview')?.appendChild(imgEl);
      }
      imgEl.src = item.url;
      imgEl.style.display = '';
    }

    this._updateMarks();
  },

  _updateMarks() {
    const inEl = this._container?.querySelector('.nle-source-in-display');
    const outEl = this._container?.querySelector('.nle-source-out-display');
    if (inEl) inEl.textContent = this._inTime !== null ? this._formatTime(this._inTime) : '—';
    if (outEl) outEl.textContent = this._outTime !== null ? this._formatTime(this._outTime) : '—';
  },

  _insertToTimeline() {
    const item = mediaManager.getItem(this._currentMediaId);
    if (!item) return;

    const tracks = timelineEngine.getVideoTracks();
    const track = tracks[0] || timelineEngine.addTrack('video');

    const inFrame = this._inTime !== null ? secondsToFrame(this._inTime) : 0;
    const outFrame = this._outTime !== null ? secondsToFrame(this._outTime) : secondsToFrame(item.duration);

    const playheadFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const clip = timelineEngine.addClip(track.id, item, playheadFrame);

    if (clip) {
      clip.sourceInFrame = inFrame;
      clip.sourceOutFrame = outFrame;
    }
  },

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }
};

export default sourceMonitor;

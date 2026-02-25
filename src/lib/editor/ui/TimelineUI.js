// Timeline panel rendering and interaction dispatch
import { editorState } from '../core/EditorState.js';
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import {
  EDITOR_EVENTS,
  ZOOM_LEVELS,
  TIMELINE_DEFAULTS,
  STATE_PATHS,
  MEDIA_TYPES
} from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { timelineRuler } from './TimelineRuler.js';
import { timelinePlayhead } from './TimelinePlayhead.js';
import { timelineTrackUI } from './TimelineTrackUI.js';
import { timelineClipUI } from './TimelineClipUI.js';
import { frameToPixel, pixelToFrame } from '../timeline/TimelineMath.js';
import { getClipEndFrame } from '../timeline/Clip.js';
import { clipOperations } from '../timeline/ClipOperations.js';
import { contextMenu } from './ContextMenu.js';
import { waveformCanvasPool } from './CanvasPool.js';
import { rafScheduler, PRIORITY } from '../core/RafScheduler.js';
import { mediaManager } from '../media/MediaManager.js';
import { thumbnailGenerator } from '../media/ThumbnailGenerator.js';
import { waveformGenerator } from '../media/WaveformGenerator.js';

export const timelineUI = {
  _container: null,
  _rulerContainer: null,
  _bodyContainer: null,
  _tracksContainer: null,

  // Phase A: DOM caches
  _trackElements: new Map(), // trackId -> { row, lane, header }
  _clipElements: new Map(), // clipId -> HTMLElement

  // Phase B: Render throttling
  _renderPending: false,
  _isDragging: false,
  _schedulerId: null,
  _scrollRafId: 0,
  _zoomRafId: 0,
  _pendingZoomDelta: 0,
  _directRafId: 0,

  init(container) {
    this._container = container;
    this._domCleanups = [];

    this._rulerContainer = container.querySelector('.nle-timeline-ruler');
    this._bodyContainer = container.querySelector('.nle-timeline-body');
    this._tracksContainer = container.querySelector('.nle-timeline-tracks');

    // Init sub-components
    if (this._rulerContainer) {
      timelineRuler.init(this._rulerContainer);
    }
    this._schedulerId = rafScheduler.register(() => {
      this._renderPending = false;
      this._doRender();
      rafScheduler.deactivate(this._schedulerId);
    }, PRIORITY.UI);

    timelinePlayhead.init(container);
    timelineClipUI.init(container, this);

    // Tool cursor — set data-tool attribute so CSS can apply cursors
    const activeTool = editorState.get(STATE_PATHS.UI_ACTIVE_TOOL) || 'selection';
    container.setAttribute('data-tool', activeTool);

    // Horizontal scroll
    if (this._bodyContainer) {
      this._onBodyScroll = () => {
        if (this._scrollRafId) return;
        this._scrollRafId = requestAnimationFrame(() => {
          this._scrollRafId = 0;
          editorState.set(STATE_PATHS.TIMELINE_SCROLL_X, this._bodyContainer.scrollLeft);
          eventBus.emit(EDITOR_EVENTS.SCROLL_CHANGED);
        });
      };
      this._bodyContainer.addEventListener('scroll', this._onBodyScroll);
    }

    // Zoom with Ctrl+Wheel
    this._onWheel = e => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this._pendingZoomDelta += (e.deltaY < 0 ? 1 : -1);
        if (this._zoomRafId) return;
        this._zoomRafId = requestAnimationFrame(() => {
          this._zoomRafId = 0;
          const delta = this._pendingZoomDelta;
          this._pendingZoomDelta = 0;
          if (delta === 0) return;
          const zoomIndex = editorState.get(STATE_PATHS.TIMELINE_ZOOM_INDEX);
          const newIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, zoomIndex + (delta > 0 ? 1 : -1)));
          if (newIndex !== zoomIndex) {
            editorState.set(STATE_PATHS.TIMELINE_ZOOM_INDEX, newIndex);
            eventBus.emit(EDITOR_EVENTS.ZOOM_CHANGED);
            this.render();
          }
        });
      }
    };
    container.addEventListener('wheel', this._onWheel, { passive: false });

    // Marquee selection / gap selection / deselect on click in empty area
    this._onMouseDown = e => {
      if (e.button !== 0) return;
      if (
        e.target.closest('.nle-clip') ||
        e.target.closest('.nle-track-header') ||
        e.target.closest('.nle-transition')
      )
        return;

      const tool = editorState.get(STATE_PATHS.UI_ACTIVE_TOOL) || 'selection';
      const inBody = e.target.closest('.nle-timeline-body');

      if (tool === 'selection' && inBody) {
        // Check if clicking inside a gap between clips
        const lane = e.target.closest('.nle-track-lane');
        if (lane) {
          const gap = this._findGapAtClick(e, lane);
          if (gap) {
            e.stopPropagation();
            editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
            editorState.set(STATE_PATHS.SELECTION_TRANSITION_ID, null);
            editorState.set(STATE_PATHS.SELECTION_GAP, gap);
            this._renderGapHighlight();
            return;
          }
        }
        // No gap hit — start marquee drag
        editorState.set(STATE_PATHS.SELECTION_GAP, null);
        this._renderGapHighlight();
        this._startMarquee(e);
        return;
      }

      // Fallback: deselect
      editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
      editorState.set(STATE_PATHS.SELECTION_TRANSITION_ID, null);
      editorState.set(STATE_PATHS.SELECTION_GAP, null);
      this._renderGapHighlight();
      eventBus.emit(EDITOR_EVENTS.CLIP_DESELECTED);
    };
    container.addEventListener('mousedown', this._onMouseDown);

    // Right-click on empty lane area for gap context menu
    this._onContextMenu = e => {
      if (
        e.target.closest('.nle-clip') ||
        e.target.closest('.nle-track-header') ||
        e.target.closest('.nle-transition')
      )
        return;
      const lane = e.target.closest('.nle-track-lane');
      if (!lane) return;
      const gap = this._findGapAtClick(e, lane);
      if (!gap) return;

      e.preventDefault();
      e.stopPropagation();
      editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
      editorState.set(STATE_PATHS.SELECTION_TRANSITION_ID, null);
      editorState.set(STATE_PATHS.SELECTION_GAP, gap);
      this._renderGapHighlight();

      contextMenu.show(e.clientX, e.clientY, [
        {
          label: 'Ripple Delete',
          action: () => {
            clipOperations.closeGap(gap.trackId, gap.startFrame, gap.endFrame);
            editorState.set(STATE_PATHS.SELECTION_GAP, null);
            this._renderGapHighlight();
          }
        }
      ]);
    };
    container.addEventListener('contextmenu', this._onContextMenu);

    // Drag and drop files onto timeline
    this._onDragOver = e => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        container.classList.add('nle-drag-over');
      }
    };
    this._onDragLeave = () => {
      container.classList.remove('nle-drag-over');
    };
    this._onDrop = e => {
      e.preventDefault();
      container.classList.remove('nle-drag-over');
      if (e.dataTransfer.files.length > 0) {
        this._handleFileDrop(e);
      }
    };
    container.addEventListener('dragover', this._onDragOver);
    container.addEventListener('dragleave', this._onDragLeave);
    container.addEventListener('drop', this._onDrop);

    // Subscribe to events
    this._unsub = subscribeEvents({
      [EDITOR_EVENTS.TOOL_CHANGED]: ({ tool }) => {
        container.setAttribute('data-tool', tool);
      },
      [EDITOR_EVENTS.TIMELINE_UPDATED]: () => this.render(),
      [EDITOR_EVENTS.CLIP_ADDED]: () => this.render(),
      [EDITOR_EVENTS.CLIP_REMOVED]: () => this.render(),
      [EDITOR_EVENTS.CLIP_SPLIT]: () => this.render(),
      [EDITOR_EVENTS.TRACK_ADDED]: () => this.render(),
      [EDITOR_EVENTS.TRACK_REMOVED]: () => this.render(),
      [EDITOR_EVENTS.ZOOM_CHANGED]: () => this.render(),
      [EDITOR_EVENTS.SEQUENCE_ACTIVATED]: () => this.forceFullRebuild(),
      [EDITOR_EVENTS.MEDIA_THUMBNAILS_READY]: ({ mediaId }) => {
        // Invalidate cached clip elements for this media so they get recreated with thumbnails
        for (const [clipId, clipEl] of this._clipElements) {
          const clip = timelineEngine.getClip(clipId);
          if (clip && clip.mediaId === mediaId) {
            const waveCanvas = clipEl.querySelector('.nle-clip-waveform-canvas');
            if (waveCanvas) waveformCanvasPool.release(waveCanvas);
            clipEl.remove();
            this._clipElements.delete(clipId);
          }
        }
        this.render();
      },
      // MXF: audio extraction completed — regenerate waveform then rebuild clip elements
      [EDITOR_EVENTS.MEDIA_AUDIO_READY]: ({ item }) => {
        if (!item) return;
        waveformGenerator.generateWaveform(item).then(() => {
          for (const [clipId, clipEl] of this._clipElements) {
            const clip = timelineEngine.getClip(clipId);
            if (clip && clip.mediaId === item.id) {
              const waveCanvas = clipEl.querySelector('.nle-clip-waveform-canvas');
              if (waveCanvas) waveformCanvasPool.release(waveCanvas);
              clipEl.remove();
              this._clipElements.delete(clipId);
            }
          }
          this.render();
        });
      },
      [EDITOR_EVENTS.CLIP_SELECTED]: ({ clipId }) => {
        this._highlightClips([clipId]);
      },
      [EDITOR_EVENTS.CLIP_DESELECTED]: () => {
        this._highlightClips([]);
      }
    });

    this.render();
  },

  // Handle files dropped onto timeline
  async _handleFileDrop(e) {
    const fileList = e.dataTransfer.files;
    const items = await mediaManager.importFiles(fileList);

    // Generate thumbnails and waveforms
    for (const item of items) {
      thumbnailGenerator.generateThumbnails(item);
      if (item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.AUDIO) {
        waveformGenerator.generateWaveform(item);
      }
    }

    // Get drop position in timeline
    const rect = this._bodyContainer.getBoundingClientRect();
    const dropX = e.clientX - rect.left;
    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    let frame = pixelToFrame(dropX + scrollX);
    frame = Math.max(0, frame);

    // Find target track (video track if available, otherwise first track)
    const tracks = timelineEngine.getTracks();
    let targetTrack = tracks.find(t => t.type === 'video');
    if (!targetTrack) {
      targetTrack = tracks[0];
    }

    // Add each imported media item to the timeline
    for (const item of items) {
      if (item.type === MEDIA_TYPES.VIDEO) {
        // Add video clip with linked audio
        timelineEngine.addClipWithLinkedAudio(item, frame);
        frame += Math.round(item.duration * 30); // Move forward by duration
      } else if (item.type === MEDIA_TYPES.AUDIO) {
        // Add audio clip to audio track
        const audioTracks = tracks.filter(t => t.type === 'audio');
        const audioTrack =
          audioTracks.length > 0 ? audioTracks[0] : timelineEngine.addTrack('audio');
        timelineEngine.addClip(audioTrack.id, item, frame);
        frame += Math.round(item.duration * 30);
      } else if (item.type === MEDIA_TYPES.IMAGE) {
        // Add image clip (5 second default duration)
        timelineEngine.addClip(targetTrack.id, item, frame);
        frame += 150; // 5 seconds at 30fps
      }
    }

    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  },

  cleanup() {
    if (this._unsub) this._unsub();
    this._unsub = null;
    for (const fn of this._domCleanups) fn();
    this._domCleanups = [];
    if (this._scrollRafId) {
      cancelAnimationFrame(this._scrollRafId);
      this._scrollRafId = 0;
    }
    if (this._zoomRafId) {
      cancelAnimationFrame(this._zoomRafId);
      this._zoomRafId = 0;
    }
    if (this._directRafId) {
      cancelAnimationFrame(this._directRafId);
      this._directRafId = 0;
    }
    if (this._bodyContainer && this._onBodyScroll) {
      this._bodyContainer.removeEventListener('scroll', this._onBodyScroll);
    }
    if (this._container) {
      if (this._onWheel) this._container.removeEventListener('wheel', this._onWheel);
      if (this._onMouseDown) this._container.removeEventListener('mousedown', this._onMouseDown);
      if (this._onContextMenu)
        this._container.removeEventListener('contextmenu', this._onContextMenu);
      if (this._onDragOver) this._container.removeEventListener('dragover', this._onDragOver);
      if (this._onDragLeave) this._container.removeEventListener('dragleave', this._onDragLeave);
      if (this._onDrop) this._container.removeEventListener('drop', this._onDrop);
    }
    // Remove marquee element from body if it was appended there
    if (this._marqueeEl) {
      this._marqueeEl.remove();
      this._marqueeEl = null;
    }
    timelineClipUI.cleanup();
    timelineRuler.cleanup();
    timelinePlayhead.cleanup();
  },

  // Phase B: Signal drag start/end for throttling
  setDragging(dragging) {
    this._isDragging = dragging;
    if (!dragging && this._renderPending) {
      // Flush any pending render on drag end via scheduler for consistency
      this._renderPending = false;
      if (this._schedulerId) {
        rafScheduler.activate(this._schedulerId);
      } else {
        if (this._directRafId) cancelAnimationFrame(this._directRafId);
      this._directRafId = requestAnimationFrame(() => {
        this._directRafId = 0;
        this._doRender();
      });
      }
    }
  },

  render() {
    if (!this._tracksContainer) return;

    // Phase B: Throttle during drag — coalesce to 1 render per rAF via scheduler
    if (this._isDragging) {
      if (!this._renderPending) {
        this._renderPending = true;
        if (this._schedulerId) {
          rafScheduler.activate(this._schedulerId);
        } else {
          if (this._directRafId) cancelAnimationFrame(this._directRafId);
          this._directRafId = requestAnimationFrame(() => {
            this._directRafId = 0;
            this._renderPending = false;
            this._doRender();
          });
        }
      }
      return;
    }

    this._doRender();
  },

  _doRender() {
    if (!this._tracksContainer) return;

    const tracks = timelineEngine.getTracks();

    // Set scrollable width based on duration
    const duration = timelineEngine.getDuration();
    const totalWidth = frameToPixel(duration) + 200;
    if (this._bodyContainer) {
      this._bodyContainer.style.setProperty('--nle-timeline-width', `${totalWidth}px`);
    }

    // Phase A: Diff-based track rows
    const currentTrackIds = new Set(tracks.map(t => t.id));

    // Remove track rows that no longer exist
    for (const [trackId, cached] of this._trackElements) {
      if (!currentTrackIds.has(trackId)) {
        cached.row.remove();
        this._trackElements.delete(trackId);
        // Remove clip elements belonging to this track
        for (const [clipId, clipEl] of this._clipElements) {
          if (clipEl.parentElement === cached.lane || clipEl._trackId === trackId) {
            const waveCanvas = clipEl.querySelector('.nle-clip-waveform-canvas');
            if (waveCanvas) waveformCanvasPool.release(waveCanvas);
            clipEl.remove();
            this._clipElements.delete(clipId);
          }
        }
      }
    }

    // Create or reorder track rows
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      let cached = this._trackElements.get(track.id);

      if (!cached) {
        // New track — create row with header + lane (lane uses event delegation)
        const row = timelineTrackUI.createTrackRow(track);
        const lane = row.querySelector('.nle-track-lane');
        const header = row.querySelector('.nle-track-header');

        // Phase C: Set up event delegation on the lane
        if (lane) {
          timelineClipUI.setupLaneDelegation(lane, track);
        }

        cached = { row, lane, header };
        this._trackElements.set(track.id, cached);
        this._tracksContainer.appendChild(row);
      }

      // Ensure correct order
      const expectedChild = this._tracksContainer.children[i];
      if (expectedChild !== cached.row) {
        this._tracksContainer.insertBefore(cached.row, expectedChild || null);
      }

      // Update clips in lane
      if (cached.lane) {
        this._renderClipsInLane(cached.lane, track);
      }
    }

    // Update ruler
    timelineRuler.render();

    // Highlight selected clips, transitions, and gap
    const selectedIds = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS);
    this._highlightClips(selectedIds);
    this._highlightTransition(editorState.get(STATE_PATHS.SELECTION_TRANSITION_ID));
    this._renderGapHighlight();
  },

  _renderClipsInLane(lane, track) {
    const currentClipIds = new Set(track.clips.map(c => c.id));

    // Remove clip elements that no longer exist in this track
    const laneClips = lane.querySelectorAll('.nle-clip');
    for (const el of laneClips) {
      const clipId = el.dataset.clipId;
      if (!currentClipIds.has(clipId)) {
        const waveCanvas = el.querySelector('.nle-clip-waveform-canvas');
        if (waveCanvas) waveformCanvasPool.release(waveCanvas);
        el.remove();
        this._clipElements.delete(clipId);
      }
    }

    // Create or update clip elements
    for (const clip of track.clips) {
      let clipEl = this._clipElements.get(clip.id);

      if (clipEl) {
        // Existing clip — check if it's in the right lane
        if (clipEl.parentElement !== lane) {
          // Clip moved to a different track
          clipEl.remove();
          lane.appendChild(clipEl);
        }
        // Update position and width only
        timelineClipUI.updateClipPosition(clipEl, clip);
      } else {
        // New clip — create element (no per-element event listeners, delegation handles it)
        clipEl = timelineClipUI.createClipElement(clip);
        clipEl._trackId = track.id;
        timelineClipUI.updateClipPosition(clipEl, clip);
        lane.appendChild(clipEl);
        this._clipElements.set(clip.id, clipEl);
      }
    }

    // Render transition indicators
    timelineClipUI.renderTransitions(track, lane);
  },

  _highlightClips(clipIds) {
    if (!this._tracksContainer) return;
    // Remove all selections
    this._tracksContainer.querySelectorAll('.nle-clip.selected').forEach(el => {
      el.classList.remove('selected');
    });
    // Add selections
    for (const id of clipIds) {
      const el = this._clipElements.get(id);
      if (el) el.classList.add('selected');
    }
  },

  _highlightTransition(transitionId) {
    if (!this._tracksContainer) return;
    this._tracksContainer.querySelectorAll('.nle-transition.selected').forEach(el => {
      el.classList.remove('selected');
    });
    if (transitionId) {
      const el = this._tracksContainer.querySelector(`[data-transition-id="${transitionId}"]`);
      if (el) el.classList.add('selected');
    }
  },

  // --- Gap selection ---

  _gapHighlightEl: null,

  // Find the gap (empty space between clips) at a click point on a lane
  _findGapAtClick(e, lane) {
    const trackId = lane.dataset.trackId;
    const track = timelineEngine.getTrack(trackId);
    if (!track || track.clips.length === 0) return null;

    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const laneRect = lane.getBoundingClientRect();
    const clickX = e.clientX - laneRect.left;
    const clickFrame = pixelToFrame(clickX + scrollX);

    // Build sorted list of occupied ranges
    const clips = track.clips.slice().sort((a, b) => a.startFrame - b.startFrame);

    // Check gap before first clip
    if (clips[0].startFrame > 0 && clickFrame < clips[0].startFrame) {
      return { trackId, startFrame: 0, endFrame: clips[0].startFrame };
    }

    // Check gaps between adjacent clips
    for (let i = 0; i < clips.length - 1; i++) {
      const endOfCurrent = getClipEndFrame(clips[i]);
      const startOfNext = clips[i + 1].startFrame;
      if (startOfNext > endOfCurrent && clickFrame >= endOfCurrent && clickFrame < startOfNext) {
        return { trackId, startFrame: endOfCurrent, endFrame: startOfNext };
      }
    }

    return null;
  },

  _renderGapHighlight() {
    const gap = editorState.get(STATE_PATHS.SELECTION_GAP);

    if (!gap) {
      if (this._gapHighlightEl) {
        this._gapHighlightEl.style.display = 'none';
      }
      return;
    }

    const cached = this._trackElements.get(gap.trackId);
    if (!cached || !cached.lane) {
      if (this._gapHighlightEl) this._gapHighlightEl.style.display = 'none';
      return;
    }

    // Create highlight element if needed
    if (!this._gapHighlightEl) {
      this._gapHighlightEl = document.createElement('div');
      this._gapHighlightEl.className = 'nle-gap-highlight';
    }

    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const x = frameToPixel(gap.startFrame) - scrollX;
    const width = frameToPixel(gap.endFrame - gap.startFrame);

    this._gapHighlightEl.style.display = 'block';
    this._gapHighlightEl.style.transform = `translateX(${x}px)`;
    this._gapHighlightEl.style.width = `${Math.max(2, width)}px`;

    // Ensure it's in the correct lane
    if (this._gapHighlightEl.parentElement !== cached.lane) {
      cached.lane.appendChild(this._gapHighlightEl);
    }
  },

  // --- Marquee selection ---

  _marqueeEl: null,
  _marqueeActive: false,

  _startMarquee(e) {
    if (this._marqueeActive) return;
    this._marqueeActive = true;

    const startX = e.clientX;
    const startY = e.clientY;
    const shiftKey = e.shiftKey;
    const priorSelection = shiftKey
      ? [...(editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [])]
      : [];
    let active = false;
    let lastSelectionKey = priorSelection.join(',');

    // Create marquee overlay (reused across drags)
    if (!this._marqueeEl) {
      this._marqueeEl = document.createElement('div');
      this._marqueeEl.className = 'nle-marquee-selection';
      document.body.appendChild(this._marqueeEl);
    }
    this._marqueeEl.style.display = 'none';

    // Cache clip bounding rects at drag start to avoid per-frame layout thrashing
    const clipRects = new Map();
    for (const [clipId, clipEl] of this._clipElements) {
      clipRects.set(clipId, clipEl.getBoundingClientRect());
    }

    const onMove = e2 => {
      const dx = e2.clientX - startX;
      const dy = e2.clientY - startY;

      // 3px drag threshold before activating marquee
      if (!active && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
        active = true;
        this._marqueeEl.style.display = 'block';
      }
      if (!active) return;

      // Compute screen-space rect
      const left = Math.min(startX, e2.clientX);
      const top = Math.min(startY, e2.clientY);
      const width = Math.abs(dx);
      const height = Math.abs(dy);

      this._marqueeEl.style.left = left + 'px';
      this._marqueeEl.style.top = top + 'px';
      this._marqueeEl.style.width = width + 'px';
      this._marqueeEl.style.height = height + 'px';

      // Hit test clips via cached bounding rects (intersection-based)
      const marqueeRect = { left, top, right: left + width, bottom: top + height };
      const hitIds = this._getClipsInMarquee(marqueeRect, clipRects);

      // Shift = additive, else replace
      const newSelection = shiftKey ? [...new Set([...priorSelection, ...hitIds])] : hitIds;

      // Only update DOM when selection actually changes
      const selectionKey = newSelection.join(',');
      if (selectionKey !== lastSelectionKey) {
        lastSelectionKey = selectionKey;
        editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, newSelection);
        this._highlightClips(newSelection);
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this._marqueeActive = false;

      if (this._marqueeEl) {
        this._marqueeEl.style.display = 'none';
      }

      if (!active) {
        // No drag — treat as deselect click (original behavior)
        if (!shiftKey) {
          editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
          editorState.set(STATE_PATHS.SELECTION_TRANSITION_ID, null);
          eventBus.emit(EDITOR_EVENTS.CLIP_DESELECTED);
        }
      } else {
        // Marquee ended — emit appropriate event
        const selected = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [];
        if (selected.length > 0) {
          eventBus.emit(EDITOR_EVENTS.CLIP_SELECTED, { clipId: selected[0] });
        } else {
          eventBus.emit(EDITOR_EVENTS.CLIP_DESELECTED);
        }
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  },

  _getClipsInMarquee(rect, clipRects) {
    const hitIds = [];
    const linkedSelection = editorState.get(STATE_PATHS.UI_LINKED_SELECTION);

    for (const [clipId, cr] of clipRects) {
      // Intersection: any overlap selects the clip
      if (
        rect.left < cr.right &&
        rect.right > cr.left &&
        rect.top < cr.bottom &&
        rect.bottom > cr.top
      ) {
        hitIds.push(clipId);

        // Include linked clip if linked selection is on
        if (linkedSelection) {
          const clip = timelineEngine.getClip(clipId);
          if (clip && clip.linkedClipId && !hitIds.includes(clip.linkedClipId)) {
            hitIds.push(clip.linkedClipId);
          }
        }
      }
    }
    return hitIds;
  },

  // Called by undo/redo or track add/remove to force full rebuild
  forceFullRebuild() {
    // Clean up marquee element
    if (this._marqueeEl) {
      this._marqueeEl.remove();
      this._marqueeEl = null;
    }
    // Release pooled waveform canvases before destroying DOM
    for (const [, clipEl] of this._clipElements) {
      const waveCanvas = clipEl.querySelector('.nle-clip-waveform-canvas');
      if (waveCanvas) waveformCanvasPool.release(waveCanvas);
    }
    // Clear all caches
    this._trackElements.clear();
    this._clipElements.clear();
    if (this._tracksContainer) {
      this._tracksContainer.innerHTML = '';
    }
    this._doRender();
  }
};

export default timelineUI;

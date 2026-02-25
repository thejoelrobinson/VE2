// Clip rendering on timeline (thumbnail filmstrip, label, trim handles)
// Phase C: Event delegation — listeners on track lane, not individual clips
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import {
  EDITOR_EVENTS,
  TOOL_TYPES,
  MEDIA_TYPES,
  EDIT_MODES,
  STATE_PATHS
} from '../core/Constants.js';
import {
  frameToPixel,
  pixelToFrame,
  getSnapPoints,
  snapFrame,
  getPixelsPerFrame
} from '../timeline/TimelineMath.js';
import { getClipDuration, getClipEndFrame } from '../timeline/Clip.js';
import { clipOperations } from '../timeline/ClipOperations.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { mediaManager } from '../media/MediaManager.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import { history } from '../core/History.js';
import { contextMenu } from './ContextMenu.js';
import { waveformGenerator } from '../media/WaveformGenerator.js';
import { frameToSeconds, secondsToFrame } from '../timeline/TimelineMath.js';
import { clamp } from '../core/MathUtils.js';
import { TRANSITION_TYPES, getTransitionZone } from '../effects/Transitions.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { keyframeEngine } from '../effects/KeyframeEngine.js';
import { getIntrinsicEffect } from '../timeline/Clip.js';
import { waveformCanvasPool } from './CanvasPool.js';
import { startDrag } from './uiUtils.js';
import { sceneDetectionDialog } from './SceneDetectionDialog.js';

// Premiere-style clip label colors
const LABEL_COLORS = {
  violet:      '#9b59b6',
  iris:        '#8b8bcb',
  caribbean:   '#3498db',
  lavender:    '#c39bd3',
  cerise:      '#e74c3c',
  rose:        '#f1948a',
  mango:       '#e67e22',
  lemon:       '#f9e547',
  forest:      '#27ae60',
  mint:        '#2ecc71',
  teal:        '#1abc9c',
  ultramarine: '#2980b9',
  blue:        '#3498db',
  smoke:       '#95a5a6',
  none:        null
};

export const timelineClipUI = {
  _container: null,
  _timelineUI: null, // Reference to timelineUI for setDragging
  _activeLanes: [], // Track lanes with delegation listeners for cleanup

  init(container, timelineUI) {
    this._container = container;
    this._timelineUI = timelineUI || null;
    this._activeLanes = [];
  },

  // Phase C: Set up delegated event listeners on a track lane
  setupLaneDelegation(lane, track) {
    // Abort previous delegation listeners if re-setting up on the same lane
    if (lane._delegationAC) lane._delegationAC.abort();
    const ac = new AbortController();
    lane._delegationAC = ac;
    // Track this lane for cleanup
    if (!this._activeLanes.includes(lane)) {
      this._activeLanes.push(lane);
    }
    const sigOpt = { signal: ac.signal };

    // Delegated mousedown — handles clip selection, drag, razor, and trim handles
    lane.addEventListener(
      'mousedown',
      e => {
        if (e.button !== 0) return;

        const clipEl = e.target.closest('.nle-clip');
        if (!clipEl) return;

        const clipId = clipEl.dataset.clipId;
        const clip = this._findClip(clipId);
        if (!clip) return;

        const tool = editorState.get(STATE_PATHS.UI_ACTIVE_TOOL);

        // Razor tool takes priority over trim handles
        if (tool === TOOL_TYPES.RAZOR) {
          // handled below in the tool switch
        } else {
          // Check for trim handles (only when not using razor)
          const leftHandle = e.target.closest('.nle-clip-handle-left');
          const rightHandle = e.target.closest('.nle-clip-handle-right');

          if (leftHandle) {
            e.stopPropagation();
            this._startTrim(e, clip, 'left');
            return;
          }

          if (rightHandle) {
            e.stopPropagation();
            this._startTrim(e, clip, 'right');
            return;
          }
        }

        if (tool === TOOL_TYPES.RAZOR) {
          e.stopPropagation();
          const rect = clipEl.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
          // Get the clip's pixel offset from its transform
          const clipX = this._getClipPixelX(clipEl);
          const frame = pixelToFrame(x + clipX + scrollX);
          clipOperations.split(clip.id, frame);
          return;
        }

        if (tool === TOOL_TYPES.PEN) {
          e.stopPropagation();
          this._handlePenTool(e, clip, clipEl);
          return;
        }

        e.stopPropagation();

        // Build selection including linked clips
        let current = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [];
        if (e.shiftKey) {
          if (!current.includes(clip.id)) {
            current = [...current, clip.id];
          }
        } else if (e.ctrlKey || e.metaKey) {
          if (current.includes(clip.id)) {
            current = current.filter(id => id !== clip.id);
          } else {
            current = [...current, clip.id];
          }
        } else {
          current = [clip.id];
        }

        // Also select linked clip (Premiere linked selection)
        if (clip.linkedClipId && !e.altKey && editorState.get(STATE_PATHS.UI_LINKED_SELECTION)) {
          if (!current.includes(clip.linkedClipId)) {
            current.push(clip.linkedClipId);
          }
        }

        editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, current);
        editorState.set(STATE_PATHS.SELECTION_GAP, null);
        eventBus.emit(EDITOR_EVENTS.CLIP_SELECTED, { clipId: clip.id });

        if (tool === TOOL_TYPES.SELECTION) {
          this._startDrag(e, clipEl, clip);
        }
      },
      sigOpt
    );

    // Delegated context menu
    lane.addEventListener(
      'contextmenu',
      e => {
        const clipEl = e.target.closest('.nle-clip');
        if (!clipEl) return;

        e.preventDefault();
        e.stopPropagation();

        const clipId = clipEl.dataset.clipId;
        const clip = this._findClip(clipId);
        if (!clip) return;

        const selected = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [];
        if (!selected.includes(clip.id)) {
          const sel = [clip.id];
          if (clip.linkedClipId) sel.push(clip.linkedClipId);
          editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, sel);
          eventBus.emit(EDITOR_EVENTS.CLIP_SELECTED, { clipId: clip.id });
        }

        const clipTrack = timelineEngine.getTrack(clip.trackId);
        const { prev, next } = this._getAdjacentClips(clip, clipTrack);

        // Check adjacency for transition items
        const prevAdjacent = prev && getClipEndFrame(prev) === clip.startFrame;
        const nextAdjacent = next && getClipEndFrame(clip) === next.startFrame;
        const hasHeadTrans =
          prevAdjacent &&
          clipTrack.transitions.find(t => t.clipAId === prev.id && t.clipBId === clip.id);
        const hasTailTrans =
          nextAdjacent &&
          clipTrack.transitions.find(t => t.clipAId === clip.id && t.clipBId === next.id);

        const menuItems = [
          {
            label: 'Cut',
            action: () => {
              clipOperations.cutClips(selected);
              editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
            }
          },
          { label: 'Copy', action: () => clipOperations.copyClips(selected) },
          { label: 'Paste', action: () => clipOperations.pasteClips() },
          { label: 'Duplicate', action: () => clipOperations.duplicateClips(selected) },
          { separator: true },
          { label: 'Rename...', action: () => this._renameClip(clip, clipEl) },
          { label: 'Speed/Duration...', action: () => this._showSpeedDialog(clip) },
          { separator: true },
          clip.linkedClipId
            ? { label: 'Unlink', action: () => timelineEngine.unlinkClip(clip.id) }
            : { label: 'Link', action: () => this._linkSelected(clip) },
          { separator: true },
          {
            label: 'Split at Playhead',
            action: () => {
              const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
              clipOperations.split(clip.id, frame);
            }
          },
          ...(prevAdjacent && !hasHeadTrans
            ? [
                {
                  label: 'Add Cross Dissolve to Head',
                  action: () => {
                    timelineEngine.addTransition(
                      clipTrack.id,
                      prev.id,
                      clip.id,
                      TRANSITION_TYPES.CROSS_DISSOLVE,
                      30
                    );
                  }
                }
              ]
            : []),
          ...(nextAdjacent && !hasTailTrans
            ? [
                {
                  label: 'Add Cross Dissolve to Tail',
                  action: () => {
                    timelineEngine.addTransition(
                      clipTrack.id,
                      clip.id,
                      next.id,
                      TRANSITION_TYPES.CROSS_DISSOLVE,
                      30
                    );
                  }
                }
              ]
            : []),
          { label: 'Ripple Delete', action: () => clipOperations.rippleDelete([clip.id]) },
          { separator: true },
          { label: 'Add Fade In', action: () => this._addFade(clip, clipTrack, 'in') },
          { label: 'Add Fade Out', action: () => this._addFade(clip, clipTrack, 'out') },
          { separator: true },
          {
            label: clip.disabled ? 'Enable' : 'Disable',
            action: () => {
              clip.disabled = !clip.disabled;
              const linked = this._getLinkedClip(clip);
              if (linked) linked.disabled = clip.disabled;
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            }
          },
          { separator: true },
          ...Object.keys(LABEL_COLORS).map(color => ({
            label: `Label: ${color.charAt(0).toUpperCase() + color.slice(1)}`,
            action: () => {
              clip.labelColor = color === 'none' ? null : color;
              const linked = this._getLinkedClip(clip);
              if (linked) linked.labelColor = clip.labelColor;
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            }
          })),
          { separator: true },
          {
            label: 'Scene Edit Detection...',
            action: () => sceneDetectionDialog.show(clip.id),
            disabled: (() => {
              const mi = mediaManager.getItem(clip.mediaId);
              return !mi || mi.type !== MEDIA_TYPES.VIDEO;
            })()
          },
          { label: 'Delete', action: () => timelineEngine.removeClip(clip.id) }
        ];

        contextMenu.show(e.clientX, e.clientY, menuItems);
      },
      sigOpt
    );

    // Delegated dragover/dragleave/drop for effect drops on clips
    lane.addEventListener(
      'dragover',
      e => {
        // Check if over a clip element for effect drops
        const clipEl = e.target.closest('.nle-clip');
        if (clipEl && e.dataTransfer.types.includes('application/x-nle-effect')) {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          clipEl.classList.add('nle-clip-drop-target');
        }
      },
      sigOpt
    );

    lane.addEventListener(
      'dragleave',
      e => {
        const clipEl = e.target.closest('.nle-clip');
        if (clipEl && !clipEl.contains(e.relatedTarget)) {
          clipEl.classList.remove('nle-clip-drop-target');
        }
      },
      sigOpt
    );

    // We need to handle effect drops on clips via delegation
    // The lane already has a drop handler in timelineTrackUI for media/effect drops on the lane itself.
    // We add a capture-phase listener to intercept effect drops on clips before the lane handler.
    lane.addEventListener(
      'drop',
      e => {
        const clipEl = e.target.closest('.nle-clip');
        if (!clipEl) return; // Let lane-level drop handler handle it

        clipEl.classList.remove('nle-clip-drop-target');
        const effectId = e.dataTransfer.getData('application/x-nle-effect');
        if (!effectId) return;

        e.preventDefault();
        e.stopPropagation();

        const clipId = clipEl.dataset.clipId;
        const clip = this._findClip(clipId);
        if (!clip) return;

        const def = effectRegistry.get(effectId);
        if (!def) return;

        if (def.type === 'transition') {
          this._dropTransition(e, clipEl, clip, effectId);
        } else {
          const instance = effectRegistry.createInstance(effectId);
          if (instance) {
            clip.effects.push(instance);
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          }
        }
      },
      { capture: true, signal: ac.signal }
    ); // capture phase to intercept before lane-level drop
  },

  // Create clip element — DOM only, no event listeners (delegation handles them)
  createClipElement(clip) {
    const el = document.createElement('div');
    el.className = 'nle-clip';
    el.dataset.clipId = clip.id;

    const mediaItem = mediaManager.getItem(clip.mediaId);
    const track = timelineEngine.getTrack(clip.trackId);
    const isAudio = track && track.type === 'audio';
    if (clip.color) el.style.backgroundColor = clip.color;

    if (isAudio) el.classList.add('audio');
    else el.classList.add('video');

    // Clip label — underline if linked (Premiere convention)
    const label = document.createElement('div');
    label.className = 'nle-clip-label';
    if (clip.linkedClipId) label.classList.add('nle-linked');
    label.textContent = clip.name;
    el.appendChild(label);

    // Thumbnail strip (video clips) — offset to match clip's source in-point
    if (mediaItem && mediaItem.thumbnails.length > 0 && !isAudio) {
      const strip = document.createElement('div');
      strip.className = 'nle-clip-thumbstrip';
      const totalDuration = mediaItem.duration || 1;
      const sourceInSec = frameToSeconds(clip.sourceInFrame);
      const sourceOutSec = frameToSeconds(clip.sourceOutFrame);
      const clipDurSec = sourceOutSec - sourceInSec;
      // The strip contains all thumbnails (full source). The clip element's width
      // represents the visible duration. We need the strip's total width to represent
      // the full source duration at the same scale, then offset by sourceIn.
      // Scale factor: (full source duration) / (visible clip duration)
      const scaleFactor = totalDuration / (clipDurSec || 1);
      const clipWidthPx = frameToPixel(getClipDuration(clip));
      const stripTotalWidth = clipWidthPx * scaleFactor;
      const offsetPx = (sourceInSec / totalDuration) * stripTotalWidth;
      strip.style.width = `${stripTotalWidth}px`;
      strip.style.left = `${-offsetPx}px`;
      for (const thumb of mediaItem.thumbnails) {
        const img = document.createElement('img');
        img.src = thumb.url;
        img.className = 'nle-clip-thumb';
        img.style.width = `${stripTotalWidth / mediaItem.thumbnails.length}px`;
        img.draggable = false;
        strip.appendChild(img);
      }
      el.appendChild(strip);
    }

    // Waveform canvas for audio clips (pooled)
    if (isAudio && mediaItem) {
      const waveCanvas = waveformCanvasPool.acquire(1, 40);
      waveCanvas.className = 'nle-clip-waveform-canvas';
      el.appendChild(waveCanvas);

      if (mediaItem.waveform) {
        this._drawWaveform(waveCanvas, mediaItem, clip);
      } else {
        waveformGenerator.generateWaveform(mediaItem).then(peaks => {
          if (peaks) this._drawWaveform(waveCanvas, mediaItem, clip);
        });
      }
    }

    // FX badge for applied (non-intrinsic) effects
    const appliedEffects = (clip.effects || []).filter(fx => !fx.intrinsic);
    if (appliedEffects.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'nle-clip-fx-badge';
      badge.textContent = 'fx';
      el.appendChild(badge);
    }

    // Speed badge — shown when speed is not 1.0 (100%)
    const speed = clip.speed ?? 1.0;
    const speedPct = Math.round(speed * 100);
    const isNonDefaultSpeed = (speedPct !== 100);
    if (isNonDefaultSpeed) {
      const speedBadge = document.createElement('div');
      speedBadge.className = 'nle-clip-speed-badge';
      speedBadge.textContent = `${speedPct}%`;
      el.appendChild(speedBadge);
    }

    // Disabled clip visual
    if (clip.disabled) {
      el.classList.add('nle-clip-disabled');
    }

    // Label color tint
    if (clip.labelColor && LABEL_COLORS[clip.labelColor]) {
      el.style.setProperty('--clip-label-color', LABEL_COLORS[clip.labelColor]);
      el.classList.add('nle-clip-labeled');
    }

    // Rubber band canvas (opacity/volume overlay for pen tool)
    const rbCanvas = document.createElement('canvas');
    rbCanvas.className = 'nle-clip-rubberband';
    el.appendChild(rbCanvas);

    // Trim handles
    const leftHandle = document.createElement('div');
    leftHandle.className = 'nle-clip-handle nle-clip-handle-left';
    el.appendChild(leftHandle);

    const rightHandle = document.createElement('div');
    rightHandle.className = 'nle-clip-handle nle-clip-handle-right';
    el.appendChild(rightHandle);

    return el;
  },

  updateClipPosition(el, clip) {
    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const x = frameToPixel(clip.startFrame) - scrollX;
    const width = frameToPixel(getClipDuration(clip));
    el.style.transform = `translateX(${x}px)`;
    el.style.width = `${Math.max(4, width)}px`;

    // Sync thumbnail strip offset when sourceInFrame changes (trim left handle, slip, etc.)
    const strip = el.querySelector('.nle-clip-thumbstrip');
    if (strip) {
      const mediaItem = mediaManager.getItem(clip.mediaId);
      if (mediaItem && mediaItem.thumbnails.length > 0) {
        const totalDuration = mediaItem.duration || 1;
        const sourceInSec = frameToSeconds(clip.sourceInFrame);
        const sourceOutSec = frameToSeconds(clip.sourceOutFrame);
        const clipDurSec = (sourceOutSec - sourceInSec) || 1;
        const scaleFactor = totalDuration / clipDurSec;
        const clipWidthPx = Math.max(4, width);
        const stripTotalWidth = clipWidthPx * scaleFactor;
        const offsetPx = (sourceInSec / totalDuration) * stripTotalWidth;
        strip.style.width = `${stripTotalWidth}px`;
        strip.style.left = `${-offsetPx}px`;
        // Keep individual thumb widths in sync — only write DOM if the value changed
        const thumbEls = strip.querySelectorAll('.nle-clip-thumb');
        if (thumbEls.length > 0) {
          const thumbW = `${stripTotalWidth / thumbEls.length}px`;
          if (thumbEls[0].style.width !== thumbW) {
            for (const img of thumbEls) img.style.width = thumbW;
          }
        }
      }
    }

    // Update speed badge
    let speedBadge = el.querySelector('.nle-clip-speed-badge');
    const speed = clip.speed ?? 1.0;
    const speedPct = Math.round(speed * 100);
    const isNonDefaultSpeed = (speedPct !== 100);
    if (isNonDefaultSpeed && !speedBadge) {
      speedBadge = document.createElement('div');
      speedBadge.className = 'nle-clip-speed-badge';
      el.appendChild(speedBadge);
    }
    if (speedBadge) {
      speedBadge.textContent = `${speedPct}%`;
      speedBadge.style.display = isNonDefaultSpeed ? '' : 'none';
    }

    // Update disabled state
    el.classList.toggle('nle-clip-disabled', !!clip.disabled);

    // Update label color
    if (clip.labelColor && LABEL_COLORS[clip.labelColor]) {
      el.style.setProperty('--clip-label-color', LABEL_COLORS[clip.labelColor]);
      el.classList.add('nle-clip-labeled');
    } else {
      el.style.removeProperty('--clip-label-color');
      el.classList.remove('nle-clip-labeled');
    }

    // Redraw rubber band overlay
    const rbCanvas = el.querySelector('.nle-clip-rubberband');
    if (rbCanvas) {
      this._drawRubberBand(rbCanvas, clip, null, width);
    }
  },

  // Helper to extract pixel X from transform for razor tool
  _getClipPixelX(el) {
    const transform = el.style.transform;
    const match = transform && transform.match(/translateX\(([^)]+)px\)/);
    return match ? parseFloat(match[1]) : 0;
  },

  // Find a clip by ID across all tracks
  _findClip(clipId) {
    return timelineEngine.getClip(clipId);
  },

  // Get the linked clip if linked selection is active
  _getLinkedClip(clip) {
    if (!clip.linkedClipId) return null;
    return timelineEngine.getClip(clip.linkedClipId);
  },

  _drawWaveform(canvas, mediaItem, clip) {
    if (!mediaItem.waveform) return;
    const clipWidth = frameToPixel(getClipDuration(clip));
    canvas.width = Math.max(1, Math.round(clipWidth));
    const totalDuration = mediaItem.duration || 1;
    const startRatio = frameToSeconds(clip.sourceInFrame) / totalDuration;
    const endRatio = frameToSeconds(clip.sourceOutFrame) / totalDuration;
    waveformGenerator.renderWaveform(canvas, mediaItem.waveform, startRatio, endRatio, '#a0d8e8');
  },

  _linkSelected(clip) {
    const selected = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [];
    if (selected.length !== 2) {
      alert('Select exactly 2 clips (one video, one audio) to link.');
      return;
    }
    const other = selected.find(id => id !== clip.id);
    if (other) {
      timelineEngine.linkClips(clip.id, other);
    }
  },

  _renameClip(clip, el) {
    const name = prompt('Clip name:', clip.name);
    if (name !== null && name.trim()) {
      clip.name = name.trim();
      const label = el.querySelector('.nle-clip-label');
      if (label) label.textContent = clip.name;
    }
  },

  _showSpeedDialog(clip) {
    const input = prompt('Speed (e.g. 1 = normal, 2 = 2x, 0.5 = half):', String(clip.speed));
    if (input !== null) {
      const speed = parseFloat(input);
      if (isFinite(speed) && speed > 0) {
        clip.speed = speed;
        const linked = this._getLinkedClip(clip);
        if (linked) linked.speed = speed;
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    }
  },

  _startDrag(e, el, clip) {
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startFrame = clip.startFrame;
    const startTrackId = clip.trackId;
    const tracks = timelineEngine.getTracks();
    const snapPoints = getSnapPoints(tracks, clip.id);
    const linked = editorState.get(STATE_PATHS.UI_LINKED_SELECTION)
      ? this._getLinkedClip(clip)
      : null;
    const linkedStartFrame = linked ? linked.startFrame : 0;
    const linkedStartTrackId = linked ? linked.trackId : null;

    // Snapshot all tracks before drag for undo
    const allTrackIds = tracks.map(t => t.id);
    const beforeSnapshot = clipOperations.snapshotTracks(allTrackIds);

    // Phase B: Signal drag start
    if (this._timelineUI) this._timelineUI.setDragging(true);

    const onMove = e2 => {
      const dx = e2.clientX - startMouseX;
      const deltaFrames = pixelToFrame(dx);
      let newFrame = startFrame + deltaFrames;
      newFrame = Math.max(0, newFrame);
      newFrame = snapFrame(newFrame, snapPoints);
      clip.startFrame = newFrame;

      // Move linked clip in sync
      if (linked) {
        linked.startFrame = linkedStartFrame + (newFrame - startFrame);
      }

      // Vertical: detect track change
      const laneUnder = document.elementFromPoint(e2.clientX, e2.clientY);
      const trackLane = laneUnder?.closest?.('.nle-track-lane');
      if (trackLane) {
        const targetTrackId = trackLane.dataset.trackId;
        if (targetTrackId && targetTrackId !== clip.trackId) {
          const targetTrack = timelineEngine.getTrack(targetTrackId);
          const sourceTrack = timelineEngine.getTrack(clip.trackId);
          if (targetTrack && sourceTrack && targetTrack.type === sourceTrack.type) {
            // Move primary clip to target track
            sourceTrack.clips = sourceTrack.clips.filter(c => c.id !== clip.id);
            clip.trackId = targetTrackId;
            targetTrack.clips.push(clip);
            targetTrack.clips.sort((a, b) => a.startFrame - b.startFrame);

            // Move linked clip to corresponding track (by index), creating if needed
            if (linked) {
              const isVideo = sourceTrack.type === 'video';
              const primaryTracks = isVideo
                ? timelineEngine.getVideoTracks()
                : timelineEngine.getAudioTracks();
              const linkedTracks = isVideo
                ? timelineEngine.getAudioTracks()
                : timelineEngine.getVideoTracks();
              const targetIdx = primaryTracks.indexOf(targetTrack);
              let linkedTarget =
                targetIdx >= 0 && targetIdx < linkedTracks.length ? linkedTracks[targetIdx] : null;
              if (!linkedTarget) {
                linkedTarget = timelineEngine.addTrack(isVideo ? 'audio' : 'video');
              }
              const linkedSource = timelineEngine.getTrack(linked.trackId);
              if (linkedSource && linkedTarget && linkedTarget.id !== linked.trackId) {
                linkedSource.clips = linkedSource.clips.filter(c => c.id !== linked.id);
                linked.trackId = linkedTarget.id;
                linkedTarget.clips.push(linked);
                linkedTarget.clips.sort((a, b) => a.startFrame - b.startFrame);
              }
            }
          }
        }
      }

      // Visual feedback: edit mode indicator on clip
      el.dataset.editMode =
        e2.ctrlKey || e2.metaKey ? 'insert' : e2.altKey ? 'replace' : 'overwrite';

      this.updateClipPosition(el, clip);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    };

    const onUp = e2 => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);

      // Phase B: Signal drag end
      if (this._timelineUI) this._timelineUI.setDragging(false);

      // Clean up visual feedback
      delete el.dataset.editMode;

      // Auto-create new track if dropped beyond existing tracks
      const sourceTrack = timelineEngine.getTrack(clip.trackId);
      if (sourceTrack) {
        const laneUnder = document.elementFromPoint(e2.clientX, e2.clientY);
        const trackLane = laneUnder?.closest?.('.nle-track-lane');
        const trackRow = laneUnder?.closest?.('.nle-track-row');

        if (!trackLane && !trackRow) {
          const tracksContainer = this._container?.querySelector('.nle-timeline-tracks');
          if (tracksContainer) {
            const containerRect = tracksContainer.getBoundingClientRect();
            const isAbove = e2.clientY < containerRect.top;
            const isBelow = e2.clientY > containerRect.bottom;

            if (isAbove || isBelow) {
              const newTrack = timelineEngine.addTrack(sourceTrack.type);
              sourceTrack.clips = sourceTrack.clips.filter(c => c.id !== clip.id);
              clip.trackId = newTrack.id;
              newTrack.clips.push(clip);
              newTrack.clips.sort((a, b) => a.startFrame - b.startFrame);

              // Also create a corresponding track for linked clip
              if (linked) {
                const linkedType = sourceTrack.type === 'video' ? 'audio' : 'video';
                const linkedNewTrack = timelineEngine.addTrack(linkedType);
                const linkedSource = timelineEngine.getTrack(linked.trackId);
                if (linkedSource) {
                  linkedSource.clips = linkedSource.clips.filter(c => c.id !== linked.id);
                  linked.trackId = linkedNewTrack.id;
                  linkedNewTrack.clips.push(linked);
                  linkedNewTrack.clips.sort((a, b) => a.startFrame - b.startFrame);
                }
              }
            }
          }
        }
      }

      // Check if target track is locked — revert if so
      const targetTrack = timelineEngine.getTrack(clip.trackId);
      if (targetTrack && targetTrack.locked) {
        clipOperations.restoreTracksFromSnapshot(beforeSnapshot);
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        return;
      }

      // Determine edit mode from modifier keys at drop time
      let editMode = EDIT_MODES.OVERWRITE;
      if (e2.ctrlKey || e2.metaKey) editMode = EDIT_MODES.INSERT;
      else if (e2.altKey) editMode = EDIT_MODES.REPLACE;

      // Build exclude list (the clip being dragged + its linked partner)
      const excludeIds = [clip.id];
      if (linked) excludeIds.push(linked.id);

      // Apply edit mode to the clip's track
      clipOperations.applyEditMode(editMode, clip.trackId, clip, excludeIds);

      // Apply edit mode to linked clip's track if different
      if (linked && linked.trackId !== clip.trackId) {
        clipOperations.applyEditMode(editMode, linked.trackId, linked, excludeIds);
      }

      // Snapshot after mutations for redo
      const currentTrackIds = timelineEngine.getTracks().map(t => t.id);
      const afterSnapshot = clipOperations.snapshotTracks(currentTrackIds);

      // Push snapshot-based undo (mutations already applied, skip execute)
      const modeLabel = editMode.charAt(0).toUpperCase() + editMode.slice(1);
      history.pushWithoutExecute({
        description: `${modeLabel}: ${clip.name}`,
        execute() {
          clipOperations.restoreTracksFromSnapshot(afterSnapshot);
          timelineEngine._recalcDuration();
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        },
        undo() {
          clipOperations.restoreTracksFromSnapshot(beforeSnapshot);
          timelineEngine._recalcDuration();
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      });

      timelineEngine._recalcDuration();
      if (clip.trackId !== startTrackId) {
        eventBus.emit(EDITOR_EVENTS.CLIP_MOVED, {
          clip,
          oldTrackId: startTrackId,
          newTrackId: clip.trackId
        });
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    };

    startDrag(e, { onMove, onUp });
  },

  // Get total source duration in frames for a clip's media item
  _getMediaDurationFrames(clip) {
    const mediaItem = mediaManager.getItem(clip.mediaId);
    if (!mediaItem || !mediaItem.duration) return Infinity;
    return secondsToFrame(mediaItem.duration);
  },

  // Show/update/hide a timecode tooltip near the cursor during trim
  _showTrimTooltip(e, text) {
    if (!this._trimTooltip) {
      this._trimTooltip = document.createElement('div');
      this._trimTooltip.className = 'nle-trim-tooltip';
      document.body.appendChild(this._trimTooltip);
    }
    this._trimTooltip.textContent = text;
    this._trimTooltip.style.left = `${e.clientX + 12}px`;
    this._trimTooltip.style.top = `${e.clientY - 28}px`;
    this._trimTooltip.style.display = 'block';
  },

  _hideTrimTooltip() {
    if (this._trimTooltip) {
      this._trimTooltip.remove();
      this._trimTooltip = null;
    }
  },

  _formatTrimDelta(deltaFrames) {
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const sign = deltaFrames >= 0 ? '+' : '-';
    const abs = Math.abs(deltaFrames);
    const sec = Math.floor(abs / fps);
    const fr = abs % fps;
    return `${sign}${String(sec).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
  },

  _startTrim(e, clip, side) {
    // Block trim on locked tracks
    const track = timelineEngine.getTrack(clip.trackId);
    if (track && track.locked) return;

    const startMouseX = e.clientX;
    const tracks = timelineEngine.getTracks();
    const snapPoints = getSnapPoints(tracks, clip.id);
    const linked = editorState.get(STATE_PATHS.UI_LINKED_SELECTION)
      ? this._getLinkedClip(clip)
      : null;

    // Capture original values for both sides (used by the relevant onMove branch)
    const origStartFrame = clip.startFrame;
    const origSourceIn = clip.sourceInFrame;
    const origSourceOut = clip.sourceOutFrame;
    const endFrame = getClipEndFrame(clip);
    const mediaDurationFrames = this._getMediaDurationFrames(clip);
    const linkedOrigStart = linked ? linked.startFrame : 0;
    const linkedOrigSourceIn = linked ? linked.sourceInFrame : 0;
    const linkedOrigSourceOut = linked ? linked.sourceOutFrame : 0;

    // Snapshot for undo
    const allTrackIds = tracks.map(t => t.id);
    const beforeSnapshot = clipOperations.snapshotTracks(allTrackIds);

    if (this._timelineUI) this._timelineUI.setDragging(true);

    const onMove = e2 => {
      const dx = e2.clientX - startMouseX;
      const deltaFrames = pixelToFrame(dx);

      if (side === 'left') {
        let newStart = origStartFrame + deltaFrames;
        newStart = Math.max(0, newStart);
        newStart = snapFrame(newStart, snapPoints);
        if (newStart >= endFrame - 1) return;

        const delta = newStart - origStartFrame;
        let newSourceIn = origSourceIn + Math.round(delta * clip.speed);

        // Clamp to media boundary (can't go before source start)
        if (newSourceIn < 0) {
          newSourceIn = 0;
          const clampedDelta = Math.round((newSourceIn - origSourceIn) / clip.speed);
          newStart = origStartFrame + clampedDelta;
        }

        clip.startFrame = newStart;
        clip.sourceInFrame = newSourceIn;

        if (linked) {
          const linkedDelta = newStart - origStartFrame;
          linked.startFrame = linkedOrigStart + linkedDelta;
          linked.sourceInFrame = Math.max(0, linkedOrigSourceIn + Math.round(linkedDelta * linked.speed));
        }

        this._showTrimTooltip(e2, this._formatTrimDelta(Math.round(newStart - origStartFrame)));
      } else {
        let newSourceOut = origSourceOut + Math.round(deltaFrames * clip.speed);

        // Clamp to media boundary (can't extend past source end)
        newSourceOut = Math.min(newSourceOut, mediaDurationFrames);
        if (newSourceOut <= clip.sourceInFrame + 1) return;

        const newDuration = Math.round((newSourceOut - clip.sourceInFrame) / clip.speed);
        let newEnd = clip.startFrame + newDuration;
        newEnd = snapFrame(newEnd, snapPoints);
        const snappedDuration = newEnd - clip.startFrame;
        const snappedSourceOut = clip.sourceInFrame + Math.round(snappedDuration * clip.speed);

        // Re-check media boundary after snap
        clip.sourceOutFrame = Math.min(snappedSourceOut, mediaDurationFrames);

        if (linked) {
          const linkedMediaDur = this._getMediaDurationFrames(linked);
          linked.sourceOutFrame = Math.min(
            linked.sourceInFrame + Math.round(snappedDuration * linked.speed),
            linkedMediaDur
          );
        }

        const origEndFrame = clip.startFrame + Math.round((origSourceOut - clip.sourceInFrame) / clip.speed);
        this._showTrimTooltip(e2, this._formatTrimDelta(Math.round(getClipEndFrame(clip) - origEndFrame)));
      }

      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    };

    startDrag(e, {
      onMove,
      onUp: () => {
        if (this._timelineUI) this._timelineUI.setDragging(false);
        this._hideTrimTooltip();
        timelineEngine._recalcDuration();

        const changed = side === 'left'
          ? (clip.startFrame !== origStartFrame || clip.sourceInFrame !== origSourceIn)
          : (clip.sourceOutFrame !== origSourceOut);

        if (changed) {
          const afterSnapshot = clipOperations.snapshotTracks(allTrackIds);
          history.pushWithoutExecute({
            description: `Trim ${side === 'left' ? 'head' : 'tail'}: ${clip.name}`,
            execute() {
              clipOperations.restoreTracksFromSnapshot(afterSnapshot);
              timelineEngine._recalcDuration();
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            },
            undo() {
              clipOperations.restoreTracksFromSnapshot(beforeSnapshot);
              timelineEngine._recalcDuration();
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            }
          });
        }
      }
    });
  },

  // --- Transition rendering ---

  renderTransitions(track, laneEl) {
    // Remove old transition indicators
    laneEl.querySelectorAll('.nle-transition').forEach(el => el.remove());

    if (!track.transitions || track.transitions.length === 0) return;

    const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
    const selectedTransId = editorState.get(STATE_PATHS.SELECTION_TRANSITION_ID);

    for (const trans of track.transitions) {
      const clipA = track.clips.find(c => c.id === trans.clipAId);
      if (!clipA) continue;

      const editPoint = getClipEndFrame(clipA);
      const { start } = getTransitionZone(trans, editPoint);

      const x = frameToPixel(start) - scrollX;
      const width = frameToPixel(trans.duration);

      const el = document.createElement('div');
      el.className = 'nle-transition';
      if (trans.id === selectedTransId) el.classList.add('selected');
      el.dataset.transitionId = trans.id;
      el.dataset.trackId = track.id;
      el.style.transform = `translateX(${x}px)`;
      el.style.width = `${Math.max(4, width)}px`;

      // Label
      const label = document.createElement('span');
      label.className = 'nle-transition-label';
      const typeName = trans.type.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      label.textContent = typeName;
      el.appendChild(label);

      // Resize handles (left and right edges)
      const leftHandle = document.createElement('div');
      leftHandle.className = 'nle-transition-handle left';
      el.appendChild(leftHandle);

      const rightHandle = document.createElement('div');
      rightHandle.className = 'nle-transition-handle right';
      el.appendChild(rightHandle);

      // Drag-to-resize on edge handles
      leftHandle.addEventListener('mousedown', e => {
        e.stopPropagation();
        this._startTransitionResize(e, trans, track, 'left');
      });
      rightHandle.addEventListener('mousedown', e => {
        e.stopPropagation();
        this._startTransitionResize(e, trans, track, 'right');
      });

      // Click body to select + drag-to-reposition
      el.addEventListener('mousedown', e => {
        if (e.target.classList.contains('nle-transition-handle')) return;
        e.stopPropagation();
        editorState.set(STATE_PATHS.SELECTION_TRANSITION_ID, trans.id);
        editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
        eventBus.emit(EDITOR_EVENTS.SELECTION_CHANGED);
        this._startTransitionDrag(e, trans, track);
      });

      // Context menu
      el.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        editorState.set(STATE_PATHS.SELECTION_TRANSITION_ID, trans.id);
        contextMenu.show(e.clientX, e.clientY, [
          {
            label: 'Delete Transition',
            action: () => {
              timelineEngine.removeTransition(track.id, trans.id);
              editorState.set(STATE_PATHS.SELECTION_TRANSITION_ID, null);
            }
          }
        ]);
      });

      laneEl.appendChild(el);
    }
  },

  _startTransitionResize(e, trans, track, side) {
    const startX = e.clientX;
    const startDuration = trans.duration;
    const startOffset = trans.offset || 0;

    startDrag(e, {
      onMove: me => {
        me.preventDefault();
        const dx = me.clientX - startX;
        const frameDelta = Math.round(pixelToFrame(dx));
        if (side === 'right') {
          trans.duration = Math.max(1, startDuration + frameDelta);
        } else {
          const newDuration = Math.max(1, startDuration - frameDelta);
          trans.duration = newDuration;
          trans.offset = startOffset + (startDuration - newDuration);
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      onUp: () => {
        const afterDuration = trans.duration;
        const afterOffset = trans.offset || 0;
        if (afterDuration !== startDuration || afterOffset !== startOffset) {
          history.pushWithoutExecute({
            description: 'Resize transition',
            execute() {
              trans.duration = afterDuration;
              trans.offset = afterOffset;
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            },
            undo() {
              trans.duration = startDuration;
              trans.offset = startOffset;
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            }
          });
        }
      }
    });
  },

  _startTransitionDrag(e, trans, track) {
    const startX = e.clientX;
    const startOffset = trans.offset || 0;
    let moved = false;

    startDrag(e, {
      onMove: me => {
        me.preventDefault();
        moved = true;
        const dx = me.clientX - startX;
        trans.offset = startOffset + Math.round(pixelToFrame(dx));
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      onUp: () => {
        const afterOffset = trans.offset || 0;
        if (moved && afterOffset !== startOffset) {
          history.pushWithoutExecute({
            description: 'Reposition transition',
            execute() {
              trans.offset = afterOffset;
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            },
            undo() {
              trans.offset = startOffset;
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            }
          });
        }
      }
    });
  },

  // Drop a transition effect onto a clip — pick head or tail based on drop position
  _dropTransition(e, el, clip, effectId) {
    const track = timelineEngine.getTrack(clip.trackId);
    if (!track) return;

    const { prev, next } = this._getAdjacentClips(clip, track);
    const clipEnd = getClipEndFrame(clip);

    const prevAdjacent = prev && getClipEndFrame(prev) === clip.startFrame;
    const nextAdjacent = next && clipEnd === next.startFrame;

    // Determine side from drop position within the clip element
    const rect = el.getBoundingClientRect();
    const dropX = e.clientX - rect.left;
    const isLeftHalf = dropX < rect.width / 2;

    // Check for existing transitions
    const hasHeadTrans =
      prevAdjacent && track.transitions.find(t => t.clipAId === prev.id && t.clipBId === clip.id);
    const hasTailTrans =
      nextAdjacent && track.transitions.find(t => t.clipAId === clip.id && t.clipBId === next.id);

    if (isLeftHalf && prevAdjacent && !hasHeadTrans) {
      timelineEngine.addTransition(track.id, prev.id, clip.id, effectId, 30);
    } else if (!isLeftHalf && nextAdjacent && !hasTailTrans) {
      timelineEngine.addTransition(track.id, clip.id, next.id, effectId, 30);
    } else if (prevAdjacent && !hasHeadTrans) {
      timelineEngine.addTransition(track.id, prev.id, clip.id, effectId, 30);
    } else if (nextAdjacent && !hasTailTrans) {
      timelineEngine.addTransition(track.id, clip.id, next.id, effectId, 30);
    }
  },

  _addFade(clip, track, direction) {
    const isAudio = track && track.type === 'audio';
    const fadeDuration = 15; // frames
    const endFrame = getClipEndFrame(clip);

    if (isAudio) {
      const volFx = getIntrinsicEffect(clip, 'audio-volume');
      if (!volFx) return;
      if (!volFx.keyframes) volFx.keyframes = {};
      if (!volFx.keyframes.gain) volFx.keyframes.gain = [];
      const kfs = volFx.keyframes.gain;
      if (direction === 'in') {
        keyframeEngine.addKeyframe(kfs, clip.startFrame, 0);
        keyframeEngine.addKeyframe(kfs, clip.startFrame + fadeDuration, volFx.params.gain);
      } else {
        keyframeEngine.addKeyframe(kfs, endFrame - fadeDuration, volFx.params.gain);
        keyframeEngine.addKeyframe(kfs, endFrame, 0);
      }
    } else {
      const opFx = getIntrinsicEffect(clip, 'opacity');
      if (!opFx) return;
      if (!opFx.keyframes) opFx.keyframes = {};
      if (!opFx.keyframes.opacity) opFx.keyframes.opacity = [];
      const kfs = opFx.keyframes.opacity;
      if (direction === 'in') {
        keyframeEngine.addKeyframe(kfs, clip.startFrame, 0);
        keyframeEngine.addKeyframe(kfs, clip.startFrame + fadeDuration, opFx.params.opacity);
      } else {
        keyframeEngine.addKeyframe(kfs, endFrame - fadeDuration, opFx.params.opacity);
        keyframeEngine.addKeyframe(kfs, endFrame, 0);
      }
    }
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  },

  // --- Rubber band / Pen tool ---

  _getRubberBandContext(clip, track) {
    const isAudio = track && track.type === 'audio';
    if (isAudio) {
      const effect = getIntrinsicEffect(clip, 'audio-volume');
      return {
        effect,
        paramId: 'gain',
        maxValue: 200,
        hasKfs: !!(
          effect &&
          effect.keyframes &&
          effect.keyframes.gain &&
          effect.keyframes.gain.length
        )
      };
    }
    const effect = getIntrinsicEffect(clip, 'opacity');
    return {
      effect,
      paramId: 'opacity',
      maxValue: 100,
      hasKfs: !!(
        effect &&
        effect.keyframes &&
        effect.keyframes.opacity &&
        effect.keyframes.opacity.length
      )
    };
  },

  _drawRubberBand(canvas, clip, track, clipWidthOverride) {
    if (!track) track = timelineEngine.getTrack(clip.trackId);
    const clipWidth = clipWidthOverride || frameToPixel(getClipDuration(clip));
    // Track row is 48px, clip is top:2 height:calc(100%-4px) = 44px
    const clipHeight = 44;
    if (clipWidth < 2) return;

    canvas.width = Math.max(1, Math.round(clipWidth));
    canvas.height = Math.max(1, Math.round(clipHeight));

    const { effect, paramId, maxValue, hasKfs } = this._getRubberBandContext(clip, track);
    if (!effect) return;

    // Only draw when pen tool is active or clip has keyframes
    const tool = editorState.get(STATE_PATHS.UI_ACTIVE_TOOL);
    if (tool !== TOOL_TYPES.PEN && !hasKfs) return;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const kfs = (effect.keyframes && effect.keyframes[paramId]) || [];
    const staticValue = effect.params[paramId] ?? (paramId === 'gain' ? 100 : 100);
    const ppf = getPixelsPerFrame();

    const valueToY = val => clipHeight * (1 - val / maxValue);
    const frameToX = f => (f - clip.startFrame) * ppf;

    // Draw the rubber band line
    ctx.strokeStyle = '#e8c84a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    if (kfs.length === 0) {
      // Flat line at static value
      const y = valueToY(staticValue);
      ctx.moveTo(0, y);
      ctx.lineTo(clipWidth, y);
    } else {
      // Interpolated segments
      const clipEndFrame = clip.startFrame + getClipDuration(clip);
      // Draw from clip start to first keyframe
      const firstVal = keyframeEngine.getValueAtFrame(kfs, clip.startFrame);
      ctx.moveTo(0, valueToY(firstVal));
      // Sample at each keyframe that falls within clip range
      for (const kf of kfs) {
        if (kf.frame < clip.startFrame || kf.frame > clipEndFrame) continue;
        const x = frameToX(kf.frame);
        const y = valueToY(kf.value);
        ctx.lineTo(x, y);
      }
      // Draw to clip end
      const lastVal = keyframeEngine.getValueAtFrame(kfs, clipEndFrame);
      ctx.lineTo(clipWidth, valueToY(lastVal));
    }
    ctx.stroke();

    // Draw keyframe diamonds
    if (kfs.length > 0) {
      const clipEndFrame = clip.startFrame + getClipDuration(clip);
      ctx.fillStyle = '#e8c84a';
      for (const kf of kfs) {
        if (kf.frame < clip.startFrame || kf.frame > clipEndFrame) continue;
        const x = frameToX(kf.frame);
        const y = valueToY(kf.value);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
      }
    }
  },

  _handlePenTool(e, clip, clipEl) {
    const track = timelineEngine.getTrack(clip.trackId);
    if (!track) return;

    const { effect, paramId, maxValue } = this._getRubberBandContext(clip, track);
    if (!effect) return;

    // Ensure keyframes array exists
    if (!effect.keyframes) effect.keyframes = {};
    if (!effect.keyframes[paramId]) effect.keyframes[paramId] = [];
    const kfs = effect.keyframes[paramId];

    // Get click position relative to clip
    const rect = clipEl.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    const relY = e.clientY - rect.top;
    const clipWidth = rect.width;
    const clipHeight = rect.height;

    // Convert to frame and value
    const ppf = getPixelsPerFrame();
    const clickFrame = Math.round(clip.startFrame + relX / ppf);
    const clickValue = clamp(maxValue * (1 - relY / clipHeight), 0, maxValue);

    // Hit test existing keyframes (6px threshold)
    const hitKf = this._findNearbyKeyframe(
      kfs,
      clickFrame,
      clickValue,
      clip,
      clipWidth,
      clipHeight,
      maxValue
    );

    if (hitKf && (e.ctrlKey || e.metaKey)) {
      // Ctrl+click = delete keyframe
      const beforeKfs = kfs.map(k => ({ ...k }));
      keyframeEngine.removeKeyframe(kfs, hitKf.frame);
      const afterKfs = kfs.map(k => ({ ...k }));
      history.pushWithoutExecute({
        description: `Delete keyframe: ${paramId}`,
        execute() {
          effect.keyframes[paramId] = afterKfs.map(k => ({ ...k }));
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        },
        undo() {
          effect.keyframes[paramId] = beforeKfs.map(k => ({ ...k }));
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      });
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    } else if (hitKf) {
      // Drag existing keyframe
      this._startKeyframeDrag(hitKf, kfs, clip, clipEl, maxValue, effect, paramId);
    } else {
      // Add new keyframe at click position
      const beforeKfs = kfs.map(k => ({ ...k }));
      keyframeEngine.addKeyframe(kfs, clickFrame, clickValue);
      const afterKfs = kfs.map(k => ({ ...k }));
      history.pushWithoutExecute({
        description: `Add keyframe: ${paramId}`,
        execute() {
          effect.keyframes[paramId] = afterKfs.map(k => ({ ...k }));
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        },
        undo() {
          effect.keyframes[paramId] = beforeKfs.map(k => ({ ...k }));
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      });
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    }
  },

  _findNearbyKeyframe(kfs, clickFrame, clickValue, clip, clipWidth, clipHeight, maxValue) {
    const ppf = getPixelsPerFrame();
    const threshold = 6; // pixels
    for (const kf of kfs) {
      if (kf.frame < clip.startFrame || kf.frame > clip.startFrame + getClipDuration(clip))
        continue;
      const kfX = (kf.frame - clip.startFrame) * ppf;
      const kfY = clipHeight * (1 - kf.value / maxValue);
      const clickX = (clickFrame - clip.startFrame) * ppf;
      const clickY = clipHeight * (1 - clickValue / maxValue);
      const dist = Math.sqrt((kfX - clickX) ** 2 + (kfY - clickY) ** 2);
      if (dist <= threshold) return kf;
    }
    return null;
  },

  _startKeyframeDrag(hitKf, kfs, clip, clipEl, maxValue, effect, paramId) {
    const beforeKfs = kfs.map(k => ({ ...k }));
    const rect = clipEl.getBoundingClientRect();

    const onMove = e2 => {
      const relY = e2.clientY - rect.top;
      let newValue = maxValue * (1 - relY / rect.height);
      newValue = clamp(newValue, 0, maxValue);
      // Snap to 0% and 100% within 3px
      const snapThreshold = 3;
      const zeroY = rect.height; // y for value 0
      const fullY = 0; // y for maxValue
      const mouseY = e2.clientY - rect.top;
      if (Math.abs(mouseY - zeroY) < snapThreshold) newValue = 0;
      if (Math.abs(mouseY - fullY) < snapThreshold) newValue = maxValue;
      // Snap to default (100 for opacity, 100 for gain)
      const defaultVal = paramId === 'gain' ? 100 : 100;
      const defaultY = rect.height * (1 - defaultVal / maxValue);
      if (Math.abs(mouseY - defaultY) < snapThreshold) newValue = defaultVal;

      hitKf.value = newValue;
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    };

    startDrag(null, {
      onMove,
      onUp: () => {
        const afterKfs = kfs.map(k => ({ ...k }));
        history.pushWithoutExecute({
          description: `Move keyframe: ${paramId}`,
          execute() {
            effect.keyframes[paramId] = afterKfs.map(k => ({ ...k }));
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          },
          undo() {
            effect.keyframes[paramId] = beforeKfs.map(k => ({ ...k }));
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          }
        });
      }
    });
  },

  // Get adjacent clip info for transition context menu items
  _getAdjacentClips(clip, track) {
    const clips = track.clips.slice().sort((a, b) => a.startFrame - b.startFrame);
    const idx = clips.findIndex(c => c.id === clip.id);
    const prev = idx > 0 ? clips[idx - 1] : null;
    const next = idx < clips.length - 1 ? clips[idx + 1] : null;
    return { prev, next };
  },

  cleanup() {
    // Abort all active delegation listeners on lanes
    for (const lane of this._activeLanes) {
      try {
        if (lane._delegationAC) {
          lane._delegationAC.abort();
          lane._delegationAC = null;
        }
      } catch (err) {
        // Lane may have been removed from DOM
      }
    }
    this._activeLanes = [];
  }
};

export default timelineClipUI;

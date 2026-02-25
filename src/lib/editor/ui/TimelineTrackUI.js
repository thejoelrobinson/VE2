// Track header (name, mute/solo/lock) + clip lane
import { TRACK_TYPES, MEDIA_TYPES, EDITOR_EVENTS, EDIT_MODES, STATE_PATHS } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { editorState } from '../core/EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { timelineClipUI } from './TimelineClipUI.js';
import { mediaManager } from '../media/MediaManager.js';
import { pixelToFrame, getSnapPoints, snapFrame } from '../timeline/TimelineMath.js';
import { getClipEndFrame, getClipDuration } from '../timeline/Clip.js';
import { clipOperations } from '../timeline/ClipOperations.js';
import { history } from '../core/History.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { contextMenu } from './ContextMenu.js';

export const timelineTrackUI = {
  createTrackRow(track) {
    const row = document.createElement('div');
    row.className = 'nle-track-row';
    row.dataset.trackId = track.id;

    // Header
    const header = document.createElement('div');
    header.className = `nle-track-header ${track.type}`;
    row.dataset.trackType = track.type;

    // A. Track Visibility Toggle (video tracks only)
    track.hidden = track.hidden ?? false;
    if (track.type === TRACK_TYPES.VIDEO) {
      const eyeOpenSvg = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="7" cy="7" rx="5" ry="3.5"/><circle cx="7" cy="7" r="1.5" fill="currentColor"/></svg>';
      const eyeClosedSvg = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3"><line x1="2" y1="2" x2="12" y2="12"/><path d="M4.5 5.5A5 3.5 0 0 0 7 7"/><path d="M9.5 8.5A5 3.5 0 0 0 7 7"/></svg>';
      const visBtn = document.createElement('button');
      visBtn.className = `nle-track-icon-btn nle-track-vis-btn${track.hidden ? ' hidden' : ''}`;
      visBtn.title = 'Toggle Visibility';
      visBtn.innerHTML = track.hidden ? eyeClosedSvg : eyeOpenSvg;
      if (track.hidden) row.classList.add('nle-track-hidden');
      visBtn.addEventListener('click', () => {
        track.hidden = !track.hidden;
        visBtn.classList.toggle('hidden', track.hidden);
        visBtn.innerHTML = track.hidden ? eyeClosedSvg : eyeOpenSvg;
        row.classList.toggle('nle-track-hidden', track.hidden);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      });
      header.appendChild(visBtn);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'nle-track-name';
    nameEl.textContent = track.name;
    header.appendChild(nameEl);

    // C. Inline Rename on Double-Click
    nameEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      nameEl.contentEditable = 'true';
      nameEl.classList.add('editing');
      nameEl.focus();
      const range = document.createRange();
      range.selectNodeContents(nameEl);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);

      const commit = () => {
        nameEl.contentEditable = 'false';
        nameEl.classList.remove('editing');
        const name = nameEl.textContent.trim();
        if (name) {
          track.name = name;
        } else {
          nameEl.textContent = track.name;
        }
      };

      const onKeydown = (ke) => {
        ke.stopPropagation(); // prevent timeline shortcuts (V, C, I, O…) from firing while typing
        if (ke.key === 'Enter')  { ke.preventDefault(); nameEl.blur(); }
        if (ke.key === 'Escape') { nameEl.textContent = track.name; nameEl.blur(); }
      };
      nameEl.addEventListener('keydown', onKeydown);
      nameEl.addEventListener('blur', () => {
        nameEl.removeEventListener('keydown', onKeydown);
        commit();
      }, { once: true });
    });

    const controls = document.createElement('div');
    controls.className = 'nle-track-controls';

    // Mute
    const muteBtn = document.createElement('button');
    muteBtn.className = `nle-track-btn${track.muted ? ' active' : ''}`;
    muteBtn.textContent = 'M';
    muteBtn.title = 'Mute';
    muteBtn.addEventListener('click', () => {
      track.muted = !track.muted;
      muteBtn.classList.toggle('active', track.muted);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });
    controls.appendChild(muteBtn);

    // Solo
    const soloBtn = document.createElement('button');
    soloBtn.className = `nle-track-btn${track.solo ? ' active' : ''}`;
    soloBtn.textContent = 'S';
    soloBtn.title = 'Solo';
    soloBtn.addEventListener('click', () => {
      track.solo = !track.solo;
      soloBtn.classList.toggle('active', track.solo);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });
    controls.appendChild(soloBtn);

    // Lock
    const lockBtn = document.createElement('button');
    lockBtn.className = `nle-track-btn${track.locked ? ' active' : ''}`;
    lockBtn.textContent = 'L';
    lockBtn.title = 'Lock';
    lockBtn.addEventListener('click', () => {
      track.locked = !track.locked;
      lockBtn.classList.toggle('active', track.locked);
    });
    controls.appendChild(lockBtn);

    // B. Sync Lock Toggle
    track.syncLocked = track.syncLocked ?? false;
    const syncBtn = document.createElement('button');
    syncBtn.className = `nle-track-icon-btn nle-track-sync-btn${track.syncLocked ? ' active' : ''}`;
    syncBtn.title = 'Sync Lock';
    syncBtn.innerHTML = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6 8a3 3 0 004-1l1-1a3 3 0 00-4.24-4.24L5.5 3"/><path d="M8 6a3 3 0 00-4 1l-1 1a3 3 0 004.24 4.24L8.5 11"/></svg>';
    syncBtn.addEventListener('click', () => {
      track.syncLocked = !track.syncLocked;
      syncBtn.classList.toggle('active', track.syncLocked);
    });
    controls.appendChild(syncBtn);

    header.appendChild(controls);

    // Track header context menu
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tracks = timelineEngine.getTracks();
      const canDelete = tracks.length > 1;

      contextMenu.show(e.clientX, e.clientY, [
        { label: 'Add Video Track', action: () => timelineEngine.addTrack(TRACK_TYPES.VIDEO) },
        { label: 'Add Audio Track', action: () => timelineEngine.addTrack(TRACK_TYPES.AUDIO) },
        { separator: true },
        { label: 'Rename Track...', action: () => {
          nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        }},
        { separator: true },
        { label: 'Delete Track', disabled: !canDelete, action: () => {
          timelineEngine.removeTrack(track.id);
        }}
      ]);
    });

    row.appendChild(header);

    // Clip lane
    const lane = document.createElement('div');
    lane.className = 'nle-track-lane';
    lane.dataset.trackId = track.id;

    // Drop target for media from bin and effects from panel
    lane.addEventListener('dragover', (e) => {
      const hasMedia = e.dataTransfer.types.includes('application/x-nle-media');
      const hasEffect = e.dataTransfer.types.includes('application/x-nle-effect');
      if (!hasMedia && !hasEffect) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      lane.classList.add('nle-drop-target');
    });
    lane.addEventListener('dragleave', () => {
      lane.classList.remove('nle-drop-target');
    });
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('nle-drop-target');

      // --- Media drop (from project bin) ---
      const mediaId = e.dataTransfer.getData('application/x-nle-media');
      if (mediaId) {
        const item = mediaManager.getItem(mediaId);
        if (item) {
          // Skip if track is locked
          if (track.locked) return;

          const rect = lane.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
          let frame = pixelToFrame(x + scrollX);

          const tracks = timelineEngine.getTracks();
          const snapPoints = getSnapPoints(tracks);
          frame = snapFrame(frame, snapPoints);
          frame = Math.max(0, frame);

          // Determine edit mode from modifier keys
          let editMode = EDIT_MODES.OVERWRITE;
          if (e.ctrlKey || e.metaKey) editMode = EDIT_MODES.INSERT;
          else if (e.altKey) editMode = EDIT_MODES.REPLACE;

          // Snapshot before for undo
          const allTrackIds = tracks.map(t => t.id);
          const beforeSnapshot = clipOperations.snapshotTracks(allTrackIds);

          // For INSERT mode, push clips out of the way first
          let result;
          if (item.type === MEDIA_TYPES.VIDEO) {
            result = timelineEngine.addClipWithLinkedAudio(item, frame);
          } else {
            const newClip = timelineEngine.addClip(track.id, item, frame);
            result = newClip ? { singleClip: newClip } : null;
          }

          if (result) {
            // Build exclude list for the newly added clips
            const excludeIds = [];
            let primaryClip;
            if (result.videoClip) {
              excludeIds.push(result.videoClip.id);
              excludeIds.push(result.audioClip.id);
              primaryClip = result.videoClip;
            } else if (result.singleClip) {
              excludeIds.push(result.singleClip.id);
              primaryClip = result.singleClip;
            }

            // Apply edit mode
            if (editMode === EDIT_MODES.INSERT) {
              // Insert: push clips right on affected tracks
              const duration = getClipDuration(primaryClip);
              clipOperations.insertSpace(primaryClip.trackId, primaryClip.startFrame, duration, excludeIds);
              if (result.audioClip) {
                clipOperations.insertSpace(result.audioClip.trackId, result.audioClip.startFrame, duration, excludeIds);
              }
            } else {
              // Overwrite (default) or Replace (falls through to overwrite for bin drops)
              if (result.videoClip) {
                clipOperations.overwriteRange(
                  result.videoClip.trackId,
                  result.videoClip.startFrame,
                  getClipEndFrame(result.videoClip),
                  excludeIds
                );
                clipOperations.overwriteRange(
                  result.audioClip.trackId,
                  result.audioClip.startFrame,
                  getClipEndFrame(result.audioClip),
                  excludeIds
                );
              } else if (result.singleClip) {
                clipOperations.overwriteRange(
                  result.singleClip.trackId,
                  result.singleClip.startFrame,
                  getClipEndFrame(result.singleClip),
                  excludeIds
                );
              }
            }

            // Snapshot after for redo
            const currentTrackIds = timelineEngine.getTracks().map(t => t.id);
            const afterSnapshot = clipOperations.snapshotTracks(currentTrackIds);

            // Push snapshot-based undo (mutations already applied, skip execute)
            const modeLabel = editMode.charAt(0).toUpperCase() + editMode.slice(1);
            history.pushWithoutExecute({
              description: `${modeLabel} drop: ${item.name}`,
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
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          }
        }
        return;
      }

      // --- Effect/transition drop (from effects panel) ---
      const effectId = e.dataTransfer.getData('application/x-nle-effect');
      if (effectId) {
        const def = effectRegistry.get(effectId);
        if (!def) return;

        const rect = lane.getBoundingClientRect();
        const scrollX = editorState.get(STATE_PATHS.TIMELINE_SCROLL_X);
        const dropFrame = pixelToFrame(e.clientX - rect.left + scrollX);

        if (def.type === 'transition') {
          // Find nearest edit point (where clipA ends exactly where clipB starts)
          const clips = track.clips.slice().sort((a, b) => a.startFrame - b.startFrame);
          let bestDist = Infinity, bestA = null, bestB = null;
          for (let i = 0; i < clips.length - 1; i++) {
            const endFrame = getClipEndFrame(clips[i]);
            if (endFrame === clips[i + 1].startFrame) {
              const dist = Math.abs(dropFrame - endFrame);
              if (dist < bestDist) {
                bestDist = dist;
                bestA = clips[i];
                bestB = clips[i + 1];
              }
            }
          }
          if (bestA && bestB) {
            // Only add if no transition already exists at this edit point
            const exists = track.transitions.find(
              t => t.clipAId === bestA.id && t.clipBId === bestB.id
            );
            if (!exists) {
              timelineEngine.addTransition(track.id, bestA.id, bestB.id, effectId, 30);
            }
          }
        } else {
          // Regular effect — find the clip under/nearest to drop position
          let bestClip = null, bestDist = Infinity;
          for (const c of track.clips) {
            const clipEnd = getClipEndFrame(c);
            if (dropFrame >= c.startFrame && dropFrame <= clipEnd) {
              bestClip = c;
              break;
            }
            const dist = Math.min(
              Math.abs(dropFrame - c.startFrame),
              Math.abs(dropFrame - clipEnd)
            );
            if (dist < bestDist) {
              bestDist = dist;
              bestClip = c;
            }
          }
          if (bestClip) {
            const instance = effectRegistry.createInstance(effectId);
            if (instance) {
              bestClip.effects.push(instance);
              eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
            }
          }
        }
      }
    });

    row.appendChild(lane);

    // D. Track Height Resize Handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'nle-track-resize-handle';
    resizeHandle.title = 'Drag to resize track height';

    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startY = e.clientY;
      const startHeight = row.getBoundingClientRect().height;

      const onMove = (e2) => {
        const newHeight = Math.max(24, Math.min(200, startHeight + (e2.clientY - startY)));
        row.style.height = `${newHeight}px`;
        // header height is governed by flex stretch — no need to set it explicitly
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    row.appendChild(resizeHandle);

    return row;
  }
};

export default timelineTrackUI;

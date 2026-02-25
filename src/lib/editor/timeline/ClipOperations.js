// Clip editing operations: trim, split, move, delete, overwrite, insert, replace, copy/paste
import { timelineEngine } from './TimelineEngine.js';
import { getClipEndFrame, getClipDuration, createClip } from './Clip.js';
import { history } from '../core/History.js';
import { eventBus } from '../core/EventBus.js';
import { editorState } from '../core/EditorState.js';
import { EDITOR_EVENTS, EDIT_MODES, STATE_PATHS } from '../core/Constants.js';
import { clamp } from '../core/MathUtils.js';

export const clipOperations = {
  _clipboard: null,  // { clips: [...deepCopied], trackTypes: [...], baseFrame: number }

  // Copy selected clips to internal clipboard
  copyClips(clipIds) {
    if (!clipIds || clipIds.length === 0) return;

    // Include linked clips if linked selection is on
    const allIds = [...clipIds];
    for (const id of clipIds) {
      const c = timelineEngine.getClip(id);
      if (c?.linkedClipId && !allIds.includes(c.linkedClipId)) {
        allIds.push(c.linkedClipId);
      }
    }

    const clips = [];
    let minFrame = Infinity;

    for (const id of allIds) {
      const clip = timelineEngine.getClip(id);
      if (!clip) continue;
      const track = timelineEngine.getTrack(clip.trackId);
      if (clip.startFrame < minFrame) minFrame = clip.startFrame;
      clips.push({
        data: {
          mediaId: clip.mediaId,
          name: clip.name,
          startFrame: clip.startFrame,
          sourceInFrame: clip.sourceInFrame,
          sourceOutFrame: clip.sourceOutFrame,
          speed: clip.speed,
          color: clip.color,
          volume: clip.volume,
          linkedClipId: clip.linkedClipId,
          effects: JSON.parse(JSON.stringify(clip.effects || []))
        },
        originalId: clip.id,
        trackType: track ? track.type : 'video'
      });
    }

    if (clips.length === 0) return;

    // Store relative offsets from earliest clip
    for (const c of clips) {
      c.frameOffset = c.data.startFrame - minFrame;
    }

    this._clipboard = { clips, baseFrame: minFrame };
  },

  // Cut = copy then delete
  cutClips(clipIds) {
    this.copyClips(clipIds);
    this.deleteClips(clipIds);
  },

  // Paste clipboard contents at target frame (defaults to playhead)
  pasteClips(targetFrame) {
    if (!this._clipboard || this._clipboard.clips.length === 0) return;
    if (targetFrame == null) {
      targetFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    }

    const tracks = timelineEngine.getTracks();
    const allTrackIds = tracks.map(t => t.id);
    const beforeSnapshot = this.snapshotTracks(allTrackIds);

    // Map original IDs to new IDs for re-linking
    const idMap = new Map();
    const newClips = [];

    for (const entry of this._clipboard.clips) {
      const pasteFrame = targetFrame + entry.frameOffset;

      // Find first available track of matching type
      const targetTrack = tracks.find(t => t.type === entry.trackType && !t.locked);
      if (!targetTrack) continue;

      const newClip = createClip({
        mediaId: entry.data.mediaId,
        trackId: targetTrack.id,
        name: entry.data.name,
        startFrame: pasteFrame,
        sourceInFrame: entry.data.sourceInFrame,
        sourceOutFrame: entry.data.sourceOutFrame,
        speed: entry.data.speed,
        color: entry.data.color,
        volume: entry.data.volume,
        effects: JSON.parse(JSON.stringify(entry.data.effects || []))
      });

      targetTrack.clips.push(newClip);
      targetTrack.clips.sort((a, b) => a.startFrame - b.startFrame);
      idMap.set(entry.originalId, newClip.id);
      newClips.push(newClip);
    }

    // Re-link pasted A/V pairs (bidirectional)
    for (const entry of this._clipboard.clips) {
      if (entry.data.linkedClipId && idMap.has(entry.originalId) && idMap.has(entry.data.linkedClipId)) {
        const newId = idMap.get(entry.originalId);
        const linkedNewId = idMap.get(entry.data.linkedClipId);
        const clip = timelineEngine.getClip(newId);
        if (clip) clip.linkedClipId = linkedNewId;
        const linkedClip = timelineEngine.getClip(linkedNewId);
        if (linkedClip) linkedClip.linkedClipId = newId;
      }
    }

    const afterSnapshot = this.snapshotTracks(allTrackIds);

    history.pushWithoutExecute({
      description: `Paste ${newClips.length} clip(s)`,
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

    // Select pasted clips
    editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, newClips.map(c => c.id));
  },

  // Duplicate = copy then paste immediately after rightmost selected clip
  duplicateClips(clipIds) {
    if (!clipIds || clipIds.length === 0) return;
    this.copyClips(clipIds);
    if (!this._clipboard) return;

    // Find rightmost end frame among selected (including linked)
    let maxEnd = 0;
    for (const entry of this._clipboard.clips) {
      const dur = Math.round((entry.data.sourceOutFrame - entry.data.sourceInFrame) / entry.data.speed);
      const end = entry.data.startFrame + dur;
      if (end > maxEnd) maxEnd = end;
    }

    this.pasteClips(maxEnd);
  },

  // Trim the left edge (changes sourceInFrame and startFrame)
  trimLeft(clipId, newStartFrame) {
    const clip = timelineEngine.getClip(clipId);
    if (!clip) return;

    const oldStartFrame = clip.startFrame;
    const oldSourceIn = clip.sourceInFrame;
    const endFrame = getClipEndFrame(clip);

    // Don't allow trimming past end
    if (newStartFrame >= endFrame) return;
    if (newStartFrame < 0) newStartFrame = 0;

    const delta = newStartFrame - oldStartFrame;

    history.push({
      description: `Trim left: ${clip.name}`,
      execute() {
        clip.startFrame = newStartFrame;
        clip.sourceInFrame = oldSourceIn + Math.round(delta * clip.speed);
        eventBus.emit(EDITOR_EVENTS.CLIP_TRIMMED, { clip });
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.startFrame = oldStartFrame;
        clip.sourceInFrame = oldSourceIn;
        eventBus.emit(EDITOR_EVENTS.CLIP_TRIMMED, { clip });
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // Trim the right edge (changes sourceOutFrame)
  trimRight(clipId, newEndFrame) {
    const clip = timelineEngine.getClip(clipId);
    if (!clip) return;

    const oldSourceOut = clip.sourceOutFrame;

    // Don't allow trimming past start
    if (newEndFrame <= clip.startFrame) return;

    const newDuration = newEndFrame - clip.startFrame;
    const newSourceOut = clip.sourceInFrame + Math.round(newDuration * clip.speed);

    history.push({
      description: `Trim right: ${clip.name}`,
      execute() {
        clip.sourceOutFrame = newSourceOut;
        eventBus.emit(EDITOR_EVENTS.CLIP_TRIMMED, { clip });
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.sourceOutFrame = oldSourceOut;
        eventBus.emit(EDITOR_EVENTS.CLIP_TRIMMED, { clip });
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // Split clip at frame position
  split(clipId, frame) {
    const clip = timelineEngine.getClip(clipId);
    if (!clip) return null;

    const endFrame = getClipEndFrame(clip);
    if (frame <= clip.startFrame || frame >= endFrame) return null;

    const track = timelineEngine.getTrack(clip.trackId);
    if (!track) return null;

    // Calculate source frame at split point
    const offsetInClip = frame - clip.startFrame;
    const splitSourceFrame = clip.sourceInFrame + Math.round(offsetInClip * clip.speed);

    const oldSourceOut = clip.sourceOutFrame;
    const oldLinkedClipId = clip.linkedClipId;
    let newClip = null;
    let newLinkedClip = null;
    let linkedClipRef = null;
    let linkedTrackRef = null;
    let linkedOldOut = null;

    history.push({
      description: `Split: ${clip.name}`,
      execute() {
        // Trim original to left portion
        clip.sourceOutFrame = splitSourceFrame;

        // Create right portion (deep-copy effects so each clip has independent instances)
        newClip = createClip({
          mediaId: clip.mediaId,
          trackId: clip.trackId,
          name: clip.name,
          startFrame: frame,
          sourceInFrame: splitSourceFrame,
          sourceOutFrame: oldSourceOut,
          speed: clip.speed,
          color: clip.color,
          volume: clip.volume,
          effects: JSON.parse(JSON.stringify(clip.effects || []))
        });

        track.clips.push(newClip);
        track.clips.sort((a, b) => a.startFrame - b.startFrame);

        // Split linked clip at the same frame and re-link the halves
        if (clip.linkedClipId) {
          linkedClipRef = timelineEngine.getClip(clip.linkedClipId);
          if (linkedClipRef) {
            linkedTrackRef = timelineEngine.getTrack(linkedClipRef.trackId);
            if (linkedTrackRef) {
              const linkedSplitSource = linkedClipRef.sourceInFrame + Math.round((frame - linkedClipRef.startFrame) * linkedClipRef.speed);
              linkedOldOut = linkedClipRef.sourceOutFrame;
              linkedClipRef.sourceOutFrame = linkedSplitSource;

              newLinkedClip = createClip({
                mediaId: linkedClipRef.mediaId,
                trackId: linkedClipRef.trackId,
                name: linkedClipRef.name,
                startFrame: frame,
                sourceInFrame: linkedSplitSource,
                sourceOutFrame: linkedOldOut,
                speed: linkedClipRef.speed,
                color: linkedClipRef.color,
                volume: linkedClipRef.volume,
                effects: JSON.parse(JSON.stringify(linkedClipRef.effects || []))
              });

              linkedTrackRef.clips.push(newLinkedClip);
              linkedTrackRef.clips.sort((a, b) => a.startFrame - b.startFrame);

              // Re-link: left halves linked, right halves linked
              clip.linkedClipId = linkedClipRef.id;
              linkedClipRef.linkedClipId = clip.id;
              newClip.linkedClipId = newLinkedClip.id;
              newLinkedClip.linkedClipId = newClip.id;
            }
          }
        }

        eventBus.emit(EDITOR_EVENTS.CLIP_SPLIT, { original: clip, newClip });
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        // Remove the new clip
        track.clips = track.clips.filter(c => c.id !== newClip.id);
        // Restore original
        clip.sourceOutFrame = oldSourceOut;

        // Undo linked clip split
        if (newLinkedClip && linkedTrackRef) {
          linkedTrackRef.clips = linkedTrackRef.clips.filter(c => c.id !== newLinkedClip.id);
        }
        if (linkedClipRef && linkedOldOut != null) {
          linkedClipRef.sourceOutFrame = linkedOldOut;
          linkedClipRef.linkedClipId = clip.id;
        }
        clip.linkedClipId = oldLinkedClipId;

        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    return newClip;
  },

  // Slip: move source in/out within clip (changes what media is visible, not position)
  slip(clipId, deltaFrames) {
    const clip = timelineEngine.getClip(clipId);
    if (!clip) return;

    const oldSourceIn = clip.sourceInFrame;
    const oldSourceOut = clip.sourceOutFrame;
    const delta = Math.round(deltaFrames * clip.speed);

    // Clamp: don't allow source to go below 0
    const newSourceIn = Math.max(0, oldSourceIn + delta);
    const actualDelta = newSourceIn - oldSourceIn;
    const newSourceOut = oldSourceOut + actualDelta;

    history.push({
      description: `Slip: ${clip.name}`,
      execute() {
        clip.sourceInFrame = newSourceIn;
        clip.sourceOutFrame = newSourceOut;
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.sourceInFrame = oldSourceIn;
        clip.sourceOutFrame = oldSourceOut;
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // Slide: move clip in timeline without changing source, shift neighbors
  slide(clipId, deltaFrames) {
    const clip = timelineEngine.getClip(clipId);
    if (!clip) return;

    const track = timelineEngine.getTrack(clip.trackId);
    if (!track) return;

    const oldStartFrame = clip.startFrame;
    const clipIdx = track.clips.indexOf(clip);
    const prevClip = clipIdx > 0 ? track.clips[clipIdx - 1] : null;
    const nextClip = clipIdx < track.clips.length - 1 ? track.clips[clipIdx + 1] : null;

    // Snapshot neighbor state
    const prevOldSourceOut = prevClip ? prevClip.sourceOutFrame : null;
    const nextOldSourceIn = nextClip ? nextClip.sourceInFrame : null;
    const nextOldStartFrame = nextClip ? nextClip.startFrame : null;

    const newStartFrame = Math.max(0, oldStartFrame + deltaFrames);
    const actualDelta = newStartFrame - oldStartFrame;

    history.push({
      description: `Slide: ${clip.name}`,
      execute() {
        clip.startFrame = newStartFrame;
        // Adjust previous clip's out point
        if (prevClip && actualDelta < 0) {
          prevClip.sourceOutFrame = prevOldSourceOut + Math.round(actualDelta * prevClip.speed);
        }
        // Adjust next clip's in point and start
        if (nextClip && actualDelta > 0) {
          const nextDelta = Math.round(actualDelta * nextClip.speed);
          nextClip.sourceInFrame = nextOldSourceIn + nextDelta;
          nextClip.startFrame = nextOldStartFrame + actualDelta;
        }
        track.clips.sort((a, b) => a.startFrame - b.startFrame);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.startFrame = oldStartFrame;
        if (prevClip) prevClip.sourceOutFrame = prevOldSourceOut;
        if (nextClip) {
          nextClip.sourceInFrame = nextOldSourceIn;
          nextClip.startFrame = nextOldStartFrame;
        }
        track.clips.sort((a, b) => a.startFrame - b.startFrame);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // Roll: move the edit point between two adjacent clips
  roll(clipId, side, deltaFrames) {
    // side: 'left' (affects this clip and previous) or 'right' (affects this clip and next)
    const clip = timelineEngine.getClip(clipId);
    if (!clip) return;

    const track = timelineEngine.getTrack(clip.trackId);
    if (!track) return;
    const clipIdx = track.clips.indexOf(clip);

    if (side === 'left' && clipIdx > 0) {
      const prevClip = track.clips[clipIdx - 1];
      const oldPrevSourceOut = prevClip.sourceOutFrame;
      const oldClipSourceIn = clip.sourceInFrame;
      const oldClipStartFrame = clip.startFrame;
      const delta = Math.round(deltaFrames * clip.speed);

      history.push({
        description: `Roll edit: ${clip.name}`,
        execute() {
          prevClip.sourceOutFrame = oldPrevSourceOut + delta;
          clip.sourceInFrame = oldClipSourceIn + delta;
          clip.startFrame = oldClipStartFrame + deltaFrames;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        },
        undo() {
          prevClip.sourceOutFrame = oldPrevSourceOut;
          clip.sourceInFrame = oldClipSourceIn;
          clip.startFrame = oldClipStartFrame;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      });
    } else if (side === 'right' && clipIdx < track.clips.length - 1) {
      const nextClip = track.clips[clipIdx + 1];
      const oldClipSourceOut = clip.sourceOutFrame;
      const oldNextSourceIn = nextClip.sourceInFrame;
      const oldNextStartFrame = nextClip.startFrame;
      const delta = Math.round(deltaFrames * clip.speed);

      history.push({
        description: `Roll edit: ${clip.name}`,
        execute() {
          clip.sourceOutFrame = oldClipSourceOut + delta;
          nextClip.sourceInFrame = oldNextSourceIn + delta;
          nextClip.startFrame = oldNextStartFrame + deltaFrames;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        },
        undo() {
          clip.sourceOutFrame = oldClipSourceOut;
          nextClip.sourceInFrame = oldNextSourceIn;
          nextClip.startFrame = oldNextStartFrame;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      });
    }
  },

  // Ripple delete: remove clip and close the gap
  rippleDelete(clipIds) {
    const removed = [];
    for (const id of clipIds) {
      const clip = timelineEngine.getClip(id);
      if (clip) {
        const track = timelineEngine.getTrack(clip.trackId);
        if (!track) continue;
        const duration = getClipDuration(clip);
        removed.push({
          clip: JSON.parse(JSON.stringify(clip)),
          trackId: track.id,
          duration
        });
      }
    }
    if (removed.length === 0) return;

    // Snapshot positions of all clips that will shift
    const shiftSnapshots = new Map();
    for (const { clip, trackId, duration } of removed) {
      const track = timelineEngine.getTrack(trackId);
      if (!track) continue;
      for (const c of track.clips) {
        if (c.startFrame > clip.startFrame && !clipIds.includes(c.id)) {
          if (!shiftSnapshots.has(c.id)) {
            shiftSnapshots.set(c.id, c.startFrame);
          }
        }
      }
    }

    history.push({
      description: `Ripple delete ${removed.length} clip(s)`,
      execute() {
        for (const { clip, trackId, duration } of removed) {
          timelineEngine.removeClip(clip.id);
          // Shift subsequent clips left
          const track = timelineEngine.getTrack(trackId);
          if (track) {
            for (const c of track.clips) {
              if (c.startFrame > clip.startFrame) {
                c.startFrame = Math.max(0, c.startFrame - duration);
              }
            }
            track.clips.sort((a, b) => a.startFrame - b.startFrame);
          }
        }
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        for (const { clip, trackId } of removed) {
          const track = timelineEngine.getTrack(trackId);
          if (track) {
            track.clips.push(clip);
          }
        }
        // Restore positions
        for (const [clipId, origFrame] of shiftSnapshots) {
          const c = timelineEngine.getClip(clipId);
          if (c) c.startFrame = origFrame;
        }
        for (const track of timelineEngine.getTracks()) {
          track.clips.sort((a, b) => a.startFrame - b.startFrame);
        }
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // Close a gap (empty space) on a track by shifting subsequent clips left
  // Linked clips on other tracks move together
  closeGap(trackId, gapStart, gapEnd) {
    const track = timelineEngine.getTrack(trackId);
    if (!track) return;
    const gapDuration = gapEnd - gapStart;
    if (gapDuration <= 0) return;

    // Collect clips to shift: those on this track past the gap
    // + their linked partners (only when linked selection is on)
    const linkedSelection = editorState.get(STATE_PATHS.UI_LINKED_SELECTION);
    const snapshots = new Map(); // clipId → original startFrame
    for (const c of track.clips) {
      if (c.startFrame >= gapEnd) {
        snapshots.set(c.id, c.startFrame);
        if (linkedSelection && c.linkedClipId) {
          const linked = timelineEngine.getClip(c.linkedClipId);
          if (linked && !snapshots.has(linked.id)) {
            snapshots.set(linked.id, linked.startFrame);
          }
        }
      }
    }
    if (snapshots.size === 0) return;

    // Track all affected track IDs for re-sorting
    const affectedTrackIds = new Set([trackId]);
    for (const [clipId] of snapshots) {
      const c = timelineEngine.getClip(clipId);
      if (c) affectedTrackIds.add(c.trackId);
    }

    history.push({
      description: 'Close gap',
      execute() {
        for (const [clipId] of snapshots) {
          const c = timelineEngine.getClip(clipId);
          if (c) c.startFrame -= gapDuration;
        }
        for (const tid of affectedTrackIds) {
          const t = timelineEngine.getTrack(tid);
          if (t) t.clips.sort((a, b) => a.startFrame - b.startFrame);
        }
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        for (const [clipId, origFrame] of snapshots) {
          const c = timelineEngine.getClip(clipId);
          if (c) c.startFrame = origFrame;
        }
        for (const tid of affectedTrackIds) {
          const t = timelineEngine.getTrack(tid);
          if (t) t.clips.sort((a, b) => a.startFrame - b.startFrame);
        }
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // Set clip speed (speed ramping)
  setSpeed(clipId, newSpeed) {
    const clip = timelineEngine.getClip(clipId);
    if (!clip) return;

    const oldSpeed = clip.speed;
    newSpeed = clamp(newSpeed, 0.1, 10);

    history.push({
      description: `Speed: ${clip.name} (${newSpeed}x)`,
      execute() {
        clip.speed = newSpeed;
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.speed = oldSpeed;
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  },

  // --- Edit Mode Operations ---

  // Clear a frame range on a single track (Overwrite mode)
  overwriteRange(trackId, rangeStart, rangeEnd, excludeClipIds = []) {
    const track = timelineEngine.getTrack(trackId);
    if (!track || track.locked) return;

    const toDelete = [];
    const toTrim = [];

    for (const clip of [...track.clips]) {
      if (excludeClipIds.includes(clip.id)) continue;

      const clipEnd = getClipEndFrame(clip);

      // No overlap
      if (clipEnd <= rangeStart || clip.startFrame >= rangeEnd) continue;

      // Fully covered — mark for deletion
      if (clip.startFrame >= rangeStart && clipEnd <= rangeEnd) {
        toDelete.push(clip);
        continue;
      }

      // Straddle — clip extends both sides of the range (split into two)
      if (clip.startFrame < rangeStart && clipEnd > rangeEnd) {
        // Trim right side of the original to rangeStart
        const origSourceOut = clip.sourceOutFrame;
        const leftDuration = rangeStart - clip.startFrame;
        clip.sourceOutFrame = clip.sourceInFrame + Math.round(leftDuration * clip.speed);

        // Create right portion starting at rangeEnd
        const rightOffset = rangeEnd - clip.startFrame;
        const rightSourceIn = clip.sourceInFrame + Math.round(rightOffset * clip.speed);
        const rightClip = createClip({
          mediaId: clip.mediaId,
          trackId: clip.trackId,
          name: clip.name,
          startFrame: rangeEnd,
          sourceInFrame: rightSourceIn,
          sourceOutFrame: origSourceOut,
          speed: clip.speed,
          color: clip.color,
          volume: clip.volume,
          effects: JSON.parse(JSON.stringify(clip.effects || []))
        });
        track.clips.push(rightClip);
        continue;
      }

      // Left overlap — clip starts before range, ends within
      if (clip.startFrame < rangeStart && clipEnd > rangeStart) {
        const newDuration = rangeStart - clip.startFrame;
        clip.sourceOutFrame = clip.sourceInFrame + Math.round(newDuration * clip.speed);
        continue;
      }

      // Right overlap — clip starts within range, ends after
      if (clip.startFrame < rangeEnd && clipEnd > rangeEnd) {
        const trimAmount = rangeEnd - clip.startFrame;
        clip.sourceInFrame += Math.round(trimAmount * clip.speed);
        clip.startFrame = rangeEnd;
        continue;
      }
    }

    // Delete fully covered clips
    for (const clip of toDelete) {
      this._removeTransitionsForClip(track, clip.id);
      track.clips = track.clips.filter(c => c.id !== clip.id);
    }

    // Remove zero-duration clips created by trimming
    const zeroDurationIds = [];
    for (const clip of track.clips) {
      if (excludeClipIds.includes(clip.id)) continue;
      if (getClipDuration(clip) <= 0) {
        this._removeTransitionsForClip(track, clip.id);
        zeroDurationIds.push(clip.id);
      }
    }
    if (zeroDurationIds.length > 0) {
      track.clips = track.clips.filter(c => !zeroDurationIds.includes(c.id));
    }

    track.clips.sort((a, b) => a.startFrame - b.startFrame);
  },

  // Push all clips at or after frame rightward by duration (Insert mode)
  insertSpace(trackId, frame, duration, excludeClipIds = []) {
    const track = timelineEngine.getTrack(trackId);
    if (!track || track.locked) return;

    for (const clip of track.clips) {
      if (excludeClipIds.includes(clip.id)) continue;
      if (clip.startFrame >= frame) {
        clip.startFrame += duration;
      }
    }
    track.clips.sort((a, b) => a.startFrame - b.startFrame);
  },

  // Swap target clip's media to match source (Replace mode)
  replaceClip(sourceClip, targetClipId) {
    const target = timelineEngine.getClip(targetClipId);
    if (!target) return;

    target.mediaId = sourceClip.mediaId;
    target.sourceInFrame = sourceClip.sourceInFrame;
    target.sourceOutFrame = sourceClip.sourceInFrame + Math.round(getClipDuration(target) * target.speed);
    target.name = sourceClip.name;
  },

  // Dispatcher — applies the appropriate edit mode
  applyEditMode(editMode, trackId, placedClip, excludeClipIds = []) {
    const track = timelineEngine.getTrack(trackId);
    if (!track || track.locked) return;

    const clipEnd = getClipEndFrame(placedClip);

    if (editMode === EDIT_MODES.INSERT) {
      this.insertSpace(trackId, placedClip.startFrame, getClipDuration(placedClip), excludeClipIds);
    } else if (editMode === EDIT_MODES.REPLACE) {
      // Find clip under the placed clip's start frame
      for (const c of track.clips) {
        if (excludeClipIds.includes(c.id)) continue;
        if (c.startFrame <= placedClip.startFrame && getClipEndFrame(c) > placedClip.startFrame) {
          this.replaceClip(placedClip, c.id);
          break;
        }
      }
    } else {
      // Default: OVERWRITE
      this.overwriteRange(trackId, placedClip.startFrame, clipEnd, excludeClipIds);
    }
  },

  // Deep-copy track clips + transitions for snapshot-based undo
  snapshotTracks(trackIds) {
    const snapshots = [];
    for (const id of trackIds) {
      const track = timelineEngine.getTrack(id);
      if (!track) continue;
      snapshots.push({
        trackId: id,
        clips: track.clips.map(c => ({
          ...c,
          effects: JSON.parse(JSON.stringify(c.effects || []))
        })),
        transitions: JSON.parse(JSON.stringify(track.transitions || []))
      });
    }
    return snapshots;
  },

  // Restore tracks from a snapshot
  restoreTracksFromSnapshot(snapshots) {
    for (const snap of snapshots) {
      const track = timelineEngine.getTrack(snap.trackId);
      if (!track) continue;
      track.clips = snap.clips.map(c => ({ ...c, effects: JSON.parse(JSON.stringify(c.effects || [])) }));
      track.transitions = JSON.parse(JSON.stringify(snap.transitions || []));
      // Re-assign trackId on clips (defensive)
      for (const c of track.clips) c.trackId = snap.trackId;
      track.clips.sort((a, b) => a.startFrame - b.startFrame);
    }
  },

  // Remove transitions referencing a clip (overlay model — no clip mutation to reverse)
  _removeTransitionsForClip(track, clipId) {
    track.transitions = track.transitions.filter(
      t => t.clipAId !== clipId && t.clipBId !== clipId
    );
  },

  // Delete clip(s) with undo
  deleteClips(clipIds) {
    // Include linked clips in deletion
    const allIds = [...clipIds];
    for (const id of clipIds) {
      const c = timelineEngine.getClip(id);
      if (c?.linkedClipId && !allIds.includes(c.linkedClipId)) {
        allIds.push(c.linkedClipId);
      }
    }

    const removed = [];
    for (const id of allIds) {
      const clip = timelineEngine.getClip(id);
      if (clip) {
        const track = timelineEngine.getTrack(clip.trackId);
        if (!track) continue;
        removed.push({ clip: { ...clip }, trackId: track.id });
      }
    }
    if (removed.length === 0) return;

    history.push({
      description: `Delete ${removed.length} clip(s)`,
      execute() {
        for (const { clip, trackId } of removed) {
          timelineEngine.removeClip(clip.id);
        }
      },
      undo() {
        for (const { clip, trackId } of removed) {
          const track = timelineEngine.getTrack(trackId);
          if (track) {
            track.clips.push(clip);
            track.clips.sort((a, b) => a.startFrame - b.startFrame);
          }
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
  }
};

export default clipOperations;

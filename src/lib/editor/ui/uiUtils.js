// Shared UI utilities for canvas/DOM operations
import { editorState } from '../core/EditorState.js';
import { TRACK_TYPES, STATE_PATHS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';

/**
 * Size a canvas for high-DPI displays.
 * Sets the backing-store resolution to CSS-size * devicePixelRatio and
 * applies the DPR scale transform so all subsequent drawing uses CSS pixels.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w  CSS width in px
 * @param {number} h  CSS height in px
 * @returns {number} devicePixelRatio used
 */
export function sizeCanvasHD(canvas, ctx, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return dpr;
}

/**
 * Sets up window-level mousemove/mouseup listeners for a drag operation.
 * Call from within a mousedown handler. The mousedown listener stays on the element.
 * @param {MouseEvent} e - The initiating mousedown event (unused but kept for call-site clarity)
 * @param {{ onMove: (e: MouseEvent) => void, onUp?: (e: MouseEvent) => void }} handlers
 */
export function startDrag(e, { onMove, onUp }) {
  const move = (e2) => onMove(e2);
  const up = (e2) => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    onUp?.(e2);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/**
 * Resolve a linked video+audio pair from an array of selected clip IDs.
 * Returns { video, audio } if the selection is a linked pair, or null.
 */
export function resolveLinkedPair(selectedIds) {
  if (selectedIds.length === 1) {
    const clip = timelineEngine.getClip(selectedIds[0]);
    if (clip?.linkedClipId) {
      const partner = timelineEngine.getClip(clip.linkedClipId);
      if (partner) {
        const trackA = timelineEngine.getTrack(clip.trackId);
        const video = trackA?.type === TRACK_TYPES.AUDIO ? partner : clip;
        const audio = trackA?.type === TRACK_TYPES.AUDIO ? clip : partner;
        return { video, audio };
      }
    }
    return null;
  }
  if (selectedIds.length !== 2) return null;
  const a = timelineEngine.getClip(selectedIds[0]);
  const b = timelineEngine.getClip(selectedIds[1]);
  if (!a || !b) return null;
  if (a.linkedClipId !== b.id || b.linkedClipId !== a.id) return null;
  const trackA = timelineEngine.getTrack(a.trackId);
  const trackB = timelineEngine.getTrack(b.trackId);
  if (!trackA || !trackB) return null;
  const video = trackA.type === TRACK_TYPES.AUDIO ? b : a;
  const audio = trackA.type === TRACK_TYPES.AUDIO ? a : b;
  return { video, audio };
}

/**
 * Resolve the selected clip from the current editor selection state.
 *
 * Returns one of:
 *   { clip, linkedPair }          - single clip (or linked pair resolved to video clip)
 *   { multiSelect: true, count }  - multiple non-linked clips selected
 *   null                          - nothing selected or clip not found
 */
export function resolveSelectedClip() {
  const selectedIds = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS) || [];
  if (selectedIds.length === 0) return null;

  const linkedPair = resolveLinkedPair(selectedIds);

  if (!linkedPair && selectedIds.length > 1) {
    return { multiSelect: true, count: selectedIds.length };
  }

  const clip = linkedPair
    ? linkedPair.video
    : timelineEngine.getClip(selectedIds[0]);
  if (!clip) return null;

  return { clip, linkedPair };
}

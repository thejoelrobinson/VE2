// Frame <-> pixel conversion, zoom, snapping
import { ZOOM_LEVELS, SNAP_THRESHOLD_PX, DEFAULT_FRAME_RATE, STATE_PATHS } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { getClipEndFrame } from './Clip.js';

export function getPixelsPerFrame() {
  const zoomIndex = editorState.get(STATE_PATHS.TIMELINE_ZOOM_INDEX);
  return ZOOM_LEVELS[zoomIndex] || 1;
}

export function frameToPixel(frame) {
  return frame * getPixelsPerFrame();
}

export function pixelToFrame(pixel) {
  const ppf = getPixelsPerFrame();
  return Math.round(pixel / ppf);
}

export function frameToTimecode(frame, fps = null) {
  fps = fps || editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  const totalSeconds = frame / fps;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const f = Math.floor(frame % fps);
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

export function frameToSeconds(frame, fps = null) {
  fps = fps || editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  return frame / fps;
}

export function secondsToFrame(seconds, fps = null) {
  fps = fps || editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  return Math.round(seconds * fps);
}

export function timecodeToFrame(tc, fps = null) {
  fps = fps || editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  const parts = tc.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  let h = 0, m = 0, s = 0, f = 0;
  if (parts.length === 4) [h, m, s, f] = parts;
  else if (parts.length === 3) [m, s, f] = parts;
  else if (parts.length === 2) [s, f] = parts;
  else if (parts.length === 1) [f] = parts;
  else return null;
  return Math.round((h * 3600 + m * 60 + s) * fps + f);
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

export function getSnapPoints(tracks, excludeClipId = null) {
  const points = new Set();
  points.add(0); // Timeline start

  // Playhead
  const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
  points.add(currentFrame);

  // In/out points
  const inPt = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT);
  const outPt = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT);
  if (inPt !== null) points.add(inPt);
  if (outPt !== null) points.add(outPt);

  // Clip edges
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      points.add(clip.startFrame);
      points.add(getClipEndFrame(clip));
    }
  }

  return [...points];
}

export function snapFrame(frame, snapPoints) {
  if (!editorState.get(STATE_PATHS.UI_SNAP_ENABLED)) return frame;
  const ppf = getPixelsPerFrame();
  const thresholdFrames = Math.ceil(SNAP_THRESHOLD_PX / ppf);

  let closest = frame;
  let minDist = Infinity;
  for (const point of snapPoints) {
    const dist = Math.abs(frame - point);
    if (dist < minDist && dist <= thresholdFrames) {
      minDist = dist;
      closest = point;
    }
  }
  return closest;
}

// Compute ruler tick interval based on zoom
export function getRulerTickInterval() {
  const ppf = getPixelsPerFrame();
  const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || DEFAULT_FRAME_RATE;
  const minTickSpacingPx = 80;

  // Try intervals in frames: 1, 5, 10, fps/2, fps, fps*2, fps*5, fps*10, fps*30, fps*60
  const candidates = [1, 5, 10, fps / 2, fps, fps * 2, fps * 5, fps * 10, fps * 30, fps * 60];
  for (const interval of candidates) {
    if (interval * ppf >= minTickSpacingPx) {
      return Math.round(interval);
    }
  }
  return fps * 60;
}

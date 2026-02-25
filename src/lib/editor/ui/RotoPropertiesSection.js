// Roto Brush properties section rendered inside PropertiesPanel / Effect Controls.
// After Effects-style flat controls: view mode, matte sliders, tool buttons,
// propagation/tracking, freeze, stroke info.
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS, TOOL_TYPES } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { keyframeEngine } from '../effects/KeyframeEngine.js';
import { history } from '../core/History.js';
import { rotoOverlay } from './RotoOverlay.js';
import { segmentationManager } from '../media/SegmentationManager.js';
import { mediaManager } from '../media/MediaManager.js';
import { mediaDecoder } from '../media/MediaDecoder.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { getSourceFrameAtPlayhead, getClipDuration } from '../timeline/Clip.js';
import { frameToSeconds } from '../timeline/TimelineMath.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import logger from '../../utils/logger.js';

// Render AE-style roto brush sections for a clip's roto effect into a target container.
// Returns cleanup function.
export function renderRotoSections(clip, rotoFx, target, kfBindings, rowMetas) {
  if (!clip || !rotoFx) return () => {};

  const cleanupFns = [];

  // ── Section header with enable toggle ──
  const headerRow = document.createElement('div');
  headerRow.className = 'nle-props-section-header expanded';

  const enableToggle = document.createElement('input');
  enableToggle.type = 'checkbox';
  enableToggle.checked = rotoFx.enabled !== false;
  enableToggle.className = 'nle-prop-toggle';
  enableToggle.addEventListener('change', () => {
    rotoFx.enabled = enableToggle.checked;
    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });
  headerRow.appendChild(enableToggle);

  const headerLabel = document.createElement('span');
  headerLabel.textContent = 'Roto Brush';
  headerLabel.style.flex = '1';
  headerRow.appendChild(headerLabel);

  target.appendChild(headerRow);

  // ── Main body ──
  const body = document.createElement('div');
  body.className = 'nle-props-section-body';

  headerRow.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const isExpanded = headerRow.classList.toggle('expanded');
    body.classList.toggle('collapsed', !isExpanded);
  });

  // ── AI Segmentation Status ──
  const aiRow = document.createElement('div');
  aiRow.className = 'nle-prop-row';
  aiRow.style.padding = '4px 8px';
  aiRow.style.fontSize = '10px';

  const aiLabel = document.createElement('span');
  aiLabel.style.color = '#888';
  if (segmentationManager.isReady()) {
    aiLabel.textContent = 'AI Selection: Ready';
    aiLabel.style.color = '#6c6';
  } else if (segmentationManager.isLoading()) {
    aiLabel.textContent = 'AI Selection: Loading model...';
    aiLabel.style.color = '#cc6';
  } else if (segmentationManager.getLoadError()) {
    aiLabel.textContent = 'AI Selection: Unavailable';
    aiLabel.style.color = '#c66';
  } else {
    aiLabel.textContent = 'AI Selection: Initializing...';
  }
  aiRow.appendChild(aiLabel);
  body.appendChild(aiRow);

  // ── View Mode toggle buttons ──
  const viewLabel = document.createElement('div');
  viewLabel.className = 'nle-roto-sub-header';
  viewLabel.textContent = 'View Mode';
  body.appendChild(viewLabel);

  const viewBar = document.createElement('div');
  viewBar.className = 'nle-roto-view-bar';

  const viewModes = ['composite', 'matte', 'boundary', 'overlay'];
  for (const mode of viewModes) {
    const btn = document.createElement('button');
    btn.className = 'nle-roto-view-btn';
    btn.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
    if (rotoFx.params.viewMode === mode) btn.classList.add('active');
    btn.addEventListener('click', () => {
      rotoFx.params.viewMode = mode;
      viewBar.querySelectorAll('.nle-roto-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });
    viewBar.appendChild(btn);
  }
  body.appendChild(viewBar);

  // ── Roto Brush Matte sliders ──
  const matteLabel = document.createElement('div');
  matteLabel.className = 'nle-roto-sub-header';
  matteLabel.textContent = 'Roto Brush Matte';
  body.appendChild(matteLabel);

  const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);

  const sliderDefs = [
    { paramId: 'feather',       label: 'Feather',        unit: 'px', min: 0,    max: 200, step: 0.5 },
    { paramId: 'contrast',      label: 'Contrast',       unit: '%',  min: 0,    max: 100, step: 1 },
    { paramId: 'shiftEdge',     label: 'Shift Edge',     unit: 'px', min: -100, max: 100, step: 0.5 },
    { paramId: 'choke',         label: 'Choke',          unit: '',   min: -100, max: 100, step: 1 },
    { paramId: 'refineRadius',  label: 'Refine Radius',  unit: 'px', min: 1,    max: 50,  step: 1 },
  ];

  for (const def of sliderDefs) {
    _appendRotoSlider(body, rotoFx, def.paramId, def.label, def.unit, def.min, def.max, def.step, currentFrame, kfBindings, rowMetas);
  }

  // ── Tool buttons ──
  const toolLabel = document.createElement('div');
  toolLabel.className = 'nle-roto-sub-header';
  toolLabel.textContent = 'Tools';
  body.appendChild(toolLabel);

  const toolBar = document.createElement('div');
  toolBar.className = 'nle-roto-tool-bar';

  const tools = [
    { type: TOOL_TYPES.ROTO_BRUSH_FG, label: 'FG Brush', title: 'Foreground brush', cssClass: 'fg-tool' },
    { type: TOOL_TYPES.ROTO_BRUSH_BG, label: 'BG Brush', title: 'Background brush', cssClass: 'bg-tool' },
    { type: TOOL_TYPES.ROTO_ERASER,   label: 'Eraser',   title: 'Erase strokes',    cssClass: '' },
  ];

  for (const tool of tools) {
    const btn = document.createElement('button');
    btn.className = 'nle-roto-tool-btn';
    if (tool.cssClass) btn.classList.add(tool.cssClass);
    btn.textContent = tool.label;
    btn.title = tool.title;
    const currentTool = editorState.get(STATE_PATHS.UI_ROTO_TOOL);
    if (currentTool === tool.type) btn.classList.add('active');
    btn.addEventListener('click', () => {
      const current = editorState.get(STATE_PATHS.UI_ROTO_TOOL);
      if (current === tool.type) {
        editorState.set(STATE_PATHS.UI_ROTO_TOOL, null);
        btn.classList.remove('active');
      } else {
        editorState.set(STATE_PATHS.UI_ROTO_TOOL, tool.type);
        toolBar.querySelectorAll('.nle-roto-tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
    toolBar.appendChild(btn);
  }
  body.appendChild(toolBar);

  // Brush Size slider (not keyframeable)
  const brushRow = document.createElement('div');
  brushRow.className = 'nle-prop-row';

  const brushLabel = document.createElement('label');
  brushLabel.className = 'nle-prop-label';
  brushLabel.textContent = 'Brush Size';
  brushRow.appendChild(brushLabel);

  const brushSlider = document.createElement('input');
  brushSlider.className = 'nle-prop-slider';
  brushSlider.type = 'range';
  brushSlider.min = 5;
  brushSlider.max = 200;
  brushSlider.step = 1;
  brushSlider.value = rotoOverlay.getBrushRadius ? rotoOverlay.getBrushRadius() : 20;
  brushRow.appendChild(brushSlider);

  const brushVal = document.createElement('span');
  brushVal.className = 'nle-prop-value';
  brushVal.textContent = `${brushSlider.value} px`;
  brushRow.appendChild(brushVal);

  brushSlider.addEventListener('input', () => {
    const val = parseInt(brushSlider.value, 10);
    brushVal.textContent = `${val} px`;
    rotoOverlay.setBrushRadius(val);
  });
  body.appendChild(brushRow);

  // ── Propagation / Tracking ──
  const propLabel = document.createElement('div');
  propLabel.className = 'nle-roto-sub-header';
  propLabel.textContent = 'Propagation';
  body.appendChild(propLabel);

  const trackRow = document.createElement('div');
  trackRow.className = 'nle-prop-row nle-roto-track-row';

  const trackBackBtn = document.createElement('button');
  trackBackBtn.className = 'nle-roto-track-btn';
  trackBackBtn.textContent = '\u25c0 Track Backward';
  trackBackBtn.title = 'Track roto backward';

  const trackFwdBtn = document.createElement('button');
  trackFwdBtn.className = 'nle-roto-track-btn';
  trackFwdBtn.textContent = 'Track Forward \u25b6';
  trackFwdBtn.title = 'Track roto forward';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'nle-roto-track-btn nle-roto-track-cancel';
  cancelBtn.textContent = 'Cancel';

  const progressBar = document.createElement('div');
  progressBar.className = 'nle-roto-track-progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'nle-roto-track-progress-fill';
  progressBar.appendChild(progressFill);

  const progressPct = document.createElement('span');
  progressPct.className = 'nle-roto-track-pct';
  progressPct.textContent = '';

  // Show appropriate buttons based on propagation state
  if (rotoFx._propagating) {
    trackBackBtn.style.display = 'none';
    trackFwdBtn.style.display = 'none';
  } else {
    cancelBtn.style.display = 'none';
    progressBar.style.display = 'none';
    progressPct.style.display = 'none';
  }

  // Store propagation state on the effect instance so it survives re-renders.
  // The properties panel re-renders on TIMELINE_UPDATED which destroys local state.
  if (!rotoFx._propagating) rotoFx._propagating = false;
  if (!rotoFx._cancelPropagation) rotoFx._cancelPropagation = false;

  const startTracking = async (direction) => {
    if (rotoFx._propagating) {
      logger.warn('[RotoProp] Already propagating');
      return;
    }
    if (!segmentationManager.isReady()) {
      logger.warn('[RotoProp] Segmentation model not ready');
      return;
    }

    try {
      const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;

      // Get the starting mask
      let prevMask = null;
      if (rotoFx.params._segMasks && rotoFx.params._segMasks.has(currentFrame)) {
        prevMask = rotoFx.params._segMasks.get(currentFrame);
      }
      if (!prevMask) {
        logger.warn('[RotoProp] No mask on current frame', currentFrame, '— paint strokes first');
        return;
      }

      // Show progress UI immediately
      trackBackBtn.style.display = 'none';
      trackFwdBtn.style.display = 'none';
      cancelBtn.style.display = '';
      progressBar.style.display = '';
      progressPct.style.display = '';
      progressFill.style.width = '0%';
      progressPct.textContent = '0%';

      rotoFx._propagating = true;
      rotoFx._cancelPropagation = false;

      const canvas = editorState.get(STATE_PATHS.PROJECT_CANVAS);
      if (!canvas) { rotoFx._propagating = false; return; }
      const { width: w, height: h } = canvas;

      const mediaItem = mediaManager.getItem(clip.mediaId);
      if (!mediaItem) { rotoFx._propagating = false; return; }

      const clipEnd = clip.startFrame + getClipDuration(clip);
      const step = direction === 'forward' ? 1 : -1;
      const endFrame = direction === 'forward' ? clipEnd : clip.startFrame;
      const totalFrames = Math.abs(endFrame - currentFrame);

      if (!rotoFx.params._segMasks) rotoFx.params._segMasks = new Map();

      logger.info(`[RotoProp] ${direction} from frame ${currentFrame} to ${endFrame} (${totalFrames} frames)`);

      let processedFrames = 0;
      let frame = currentFrame + step;

      while ((direction === 'forward' ? frame < endFrame : frame > endFrame) && !rotoFx._cancelPropagation) {
        const sourceFrame = getSourceFrameAtPlayhead(clip, frame);
        if (sourceFrame === null) { logger.warn('[RotoProp] sourceFrame null at timeline frame', frame); break; }

        const sourceTime = frameToSeconds(sourceFrame);

        const bitmap = await mediaDecoder.getFrame(mediaItem.id, mediaItem.url, sourceTime);
        if (!bitmap || rotoFx._cancelPropagation) { logger.warn('[RotoProp] No bitmap at', frame); break; }

        const transferBitmap = await createImageBitmap(bitmap, {
          colorSpaceConversion: 'none',
          resizeWidth: w,
          resizeHeight: h
        });

        const frameKey = `${mediaItem.id}-${sourceTime}-prop-${frame}`;
        await segmentationManager.encodeFrame(transferBitmap, w, h, frameKey);

        const promptPoints = _sampleMaskInteriorPoints(prevMask, w, h, 5);
        if (promptPoints.length === 0) { logger.warn('[RotoProp] Empty mask — no points at frame', frame); break; }

        const result = await segmentationManager.decodeMask(promptPoints, [], w, h);
        if (!result.mask || result.mask.length !== w * h) {
          logger.warn('[RotoProp] Bad mask result at frame', frame, result.mask?.length, 'vs', w * h);
          break;
        }

        // Store mask and update binary seed for next frame
        rotoFx.params._segMasks.set(frame, result.mask);
        const binaryMask = new Float32Array(result.mask.length);
        for (let i = 0; i < binaryMask.length; i++) {
          binaryMask[i] = result.mask[i] > 0.5 ? 1.0 : 0.0;
        }
        prevMask = binaryMask;

        processedFrames++;
        const pct = Math.round((processedFrames / totalFrames) * 100);
        progressFill.style.width = `${pct}%`;
        progressPct.textContent = `${pct}%`;

        // Update playhead every 3 frames
        if (processedFrames % 3 === 0) {
          editorState.set(STATE_PATHS.PLAYBACK_CURRENT_FRAME, frame);
          eventBus.emit(EDITOR_EVENTS.PLAYBACK_FRAME, { frame });
        }

        frame += step;
        await new Promise(r => setTimeout(r, 0));
      }

      playbackEngine.seek(frame - step);
      logger.info(`[RotoProp] Done: ${processedFrames} frames propagated ${direction}`);

    } catch (err) {
      logger.error('[RotoProp] Propagation error:', err.message, err.stack);
    } finally {
      rotoFx._propagating = false;
      // Restore button state
      trackBackBtn.style.display = '';
      trackFwdBtn.style.display = '';
      cancelBtn.style.display = 'none';
      progressBar.style.display = 'none';
      progressPct.style.display = 'none';
      eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    }
  };

  trackBackBtn.addEventListener('click', () => startTracking('backward'));
  trackFwdBtn.addEventListener('click', () => startTracking('forward'));
  cancelBtn.addEventListener('click', () => {
    rotoFx._cancelPropagation = true;
    logger.info('[RotoProp] Cancellation requested');
  });

  trackRow.appendChild(trackBackBtn);
  trackRow.appendChild(trackFwdBtn);
  trackRow.appendChild(cancelBtn);
  trackRow.appendChild(progressBar);
  trackRow.appendChild(progressPct);
  body.appendChild(trackRow);

  // ── Freeze / Unfreeze ──
  const freezeRow = document.createElement('div');
  freezeRow.className = 'nle-prop-row nle-roto-freeze-row';

  const freezeBtn = document.createElement('button');
  freezeBtn.className = 'nle-roto-freeze-btn';
  if (rotoFx.params.frozen) freezeBtn.classList.add('frozen');
  freezeBtn.textContent = rotoFx.params.frozen ? 'Unfreeze' : 'Freeze';
  freezeBtn.addEventListener('click', () => {
    if (rotoFx.params.frozen) {
      rotoFx.params.frozen = false;
      rotoFx.params._matteCache = null;
      freezeBtn.textContent = 'Freeze';
      freezeBtn.classList.remove('frozen');
    } else {
      rotoFx.params.frozen = true;
      freezeBtn.textContent = 'Unfreeze';
      freezeBtn.classList.add('frozen');
    }
    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
  });
  freezeRow.appendChild(freezeBtn);
  body.appendChild(freezeRow);

  // ── Stroke info ──
  const strokeRow = document.createElement('div');
  strokeRow.className = 'nle-prop-row nle-roto-stroke-row';

  const strokes = rotoFx.params.strokes || [];
  const frameStrokes = strokes.filter(s => s.frame === currentFrame);

  const strokeInfo = document.createElement('span');
  strokeInfo.className = 'nle-roto-stroke-info';
  strokeInfo.textContent = `Strokes: ${frameStrokes.length} on this frame`;
  strokeRow.appendChild(strokeInfo);

  const clearFrameBtn = document.createElement('button');
  clearFrameBtn.className = 'nle-roto-clear-btn';
  clearFrameBtn.textContent = 'Clear Frame';
  clearFrameBtn.addEventListener('click', () => {
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const before = JSON.parse(JSON.stringify(rotoFx.params.strokes || []));
    rotoFx.params.strokes = (rotoFx.params.strokes || []).filter(s => s.frame !== frame);
    // Clear stale segmentation masks and matte cache for this frame
    if (rotoFx.params._segMasks) rotoFx.params._segMasks.delete(frame);
    if (rotoFx.params._matteCache) rotoFx.params._matteCache.delete(frame);
    const after = JSON.parse(JSON.stringify(rotoFx.params.strokes));

    history.pushWithoutExecute({
      description: 'Clear roto strokes on frame',
      execute() {
        rotoFx.params.strokes = JSON.parse(JSON.stringify(after));
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        rotoFx.params.strokes = JSON.parse(JSON.stringify(before));
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });
  strokeRow.appendChild(clearFrameBtn);

  const clearAllBtn = document.createElement('button');
  clearAllBtn.className = 'nle-roto-clear-btn';
  clearAllBtn.textContent = 'Clear All';
  clearAllBtn.addEventListener('click', () => {
    const before = JSON.parse(JSON.stringify(rotoFx.params.strokes || []));
    rotoFx.params.strokes = [];
    // Clear all stale segmentation masks and matte cache
    if (rotoFx.params._segMasks) rotoFx.params._segMasks.clear();
    if (rotoFx.params._matteCache) rotoFx.params._matteCache.clear();
    const after = [];

    history.pushWithoutExecute({
      description: 'Clear all roto strokes',
      execute() {
        rotoFx.params.strokes = JSON.parse(JSON.stringify(after));
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        rotoFx.params.strokes = JSON.parse(JSON.stringify(before));
        eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });
  strokeRow.appendChild(clearAllBtn);
  body.appendChild(strokeRow);

  target.appendChild(body);

  return () => {
    for (const fn of cleanupFns) fn();
  };
}

// Keyframeable slider for roto effect params (reads/writes rotoFx.params[paramId])
function _appendRotoSlider(container, rotoFx, paramId, label, unit, min, max, step, currentFrame, kfBindings, rowMetas) {
  const kfs = rotoFx.keyframes?.[paramId] || [];
  const hasKf = kfs.length > 0;
  const currentVal = hasKf
    ? keyframeEngine.getValueAtFrame(kfs, currentFrame)
    : (rotoFx.params[paramId] ?? min);

  const row = document.createElement('div');
  row.className = 'nle-prop-row nle-prop-row--kf';

  // Stopwatch
  const stopwatch = document.createElement('button');
  stopwatch.className = `nle-kf-stopwatch${hasKf ? ' active' : ''}`;
  stopwatch.innerHTML = '&#9201;';
  row.appendChild(stopwatch);

  // Label
  const labelEl = document.createElement('label');
  labelEl.className = 'nle-prop-label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  // Keyframe diamond
  const kfBtn = document.createElement('button');
  kfBtn.className = `nle-keyframe-btn${hasKf ? ' active' : ''}`;
  row.appendChild(kfBtn);

  // Slider
  const slider = document.createElement('input');
  slider.className = 'nle-prop-slider';
  slider.type = 'range';
  slider.min = min;
  slider.max = max;
  slider.value = currentVal;
  slider.step = step;
  row.appendChild(slider);

  // Value display
  const valueEl = document.createElement('span');
  valueEl.className = 'nle-prop-value';
  valueEl.textContent = _formatVal(currentVal, step, unit);
  row.appendChild(valueEl);

  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    rotoFx.params[paramId] = val;
    valueEl.textContent = _formatVal(val, step, unit);
    if (rotoFx.keyframes?.[paramId]?.length > 0) {
      keyframeEngine.addKeyframe(rotoFx.keyframes[paramId], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
    }
    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  kfBtn.addEventListener('click', () => {
    if (!rotoFx.keyframes) rotoFx.keyframes = {};
    if (!rotoFx.keyframes[paramId]) rotoFx.keyframes[paramId] = [];
    const kfArr = rotoFx.keyframes[paramId];
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const existing = kfArr.findIndex(kf => kf.frame === frame);
    if (existing >= 0) {
      kfArr.splice(existing, 1);
    } else {
      keyframeEngine.addKeyframe(kfArr, frame, rotoFx.params[paramId]);
    }
    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  stopwatch.addEventListener('click', () => {
    if (!rotoFx.keyframes) rotoFx.keyframes = {};
    const existing = rotoFx.keyframes[paramId];
    if (existing && existing.length > 0) {
      rotoFx.keyframes[paramId] = [];
      stopwatch.classList.remove('active');
    } else {
      if (!rotoFx.keyframes[paramId]) rotoFx.keyframes[paramId] = [];
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      keyframeEngine.addKeyframe(rotoFx.keyframes[paramId], frame, rotoFx.params[paramId]);
      stopwatch.classList.add('active');
    }
    eventBus.emit(EDITOR_EVENTS.ROTO_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  if (kfBindings) {
    kfBindings.push({
      effectRef: rotoFx,
      paramId,
      slider,
      display: valueEl,
      unit,
      step
    });
  }

  container.appendChild(row);

  if (rowMetas) {
    rowMetas.push({
      effectRef: rotoFx,
      paramId,
      keyframesRef: () => rotoFx.keyframes?.[paramId] || [],
      rowEl: row,
      y: 0,
      height: 0
    });
  }
}

function _formatVal(val, step, unit) {
  const text = step < 1 ? val.toFixed(1) : Math.round(val);
  return unit ? `${text} ${unit}` : `${text}`;
}

// Find the centroid (center of mass) of a binary mask in pixel coordinates.
// Returns { x, y } or null if mask is empty.
function _findMaskCentroid(mask, w, h) {
  let sumX = 0, sumY = 0, total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const val = mask[y * w + x];
      if (val > 0.5) {
        sumX += x;
        sumY += y;
        total++;
      }
    }
  }
  if (total === 0) return null;
  return { x: Math.round(sumX / total), y: Math.round(sumY / total) };
}

// Sample multiple interior points from a mask for better scribble-based propagation.
// Returns array of {x, y} pixel coordinates evenly distributed inside the mask.
function _sampleMaskInteriorPoints(mask, w, h, maxPoints = 5) {
  const points = [];
  const centroid = _findMaskCentroid(mask, w, h);
  if (!centroid) return points;
  points.push(centroid);

  // Sample along horizontal and vertical lines through the centroid
  const cx = centroid.x;
  const cy = centroid.y;

  // Find mask extents on the centroid's row
  let leftX = cx, rightX = cx;
  for (let x = cx - 1; x >= 0; x--) {
    if (mask[cy * w + x] <= 0.5) break;
    leftX = x;
  }
  for (let x = cx + 1; x < w; x++) {
    if (mask[cy * w + x] <= 0.5) break;
    rightX = x;
  }
  // Add points at 25% and 75% of horizontal span
  if (rightX - leftX > 20) {
    points.push({ x: Math.round(leftX + (rightX - leftX) * 0.25), y: cy });
    points.push({ x: Math.round(leftX + (rightX - leftX) * 0.75), y: cy });
  }

  // Find mask extents on the centroid's column
  let topY = cy, bottomY = cy;
  for (let y = cy - 1; y >= 0; y--) {
    if (mask[y * w + cx] <= 0.5) break;
    topY = y;
  }
  for (let y = cy + 1; y < h; y++) {
    if (mask[y * w + cx] <= 0.5) break;
    bottomY = y;
  }
  if (bottomY - topY > 20) {
    points.push({ x: cx, y: Math.round(topY + (bottomY - topY) * 0.25) });
    points.push({ x: cx, y: Math.round(topY + (bottomY - topY) * 0.75) });
  }

  return points.slice(0, maxPoints);
}

export default renderRotoSections;

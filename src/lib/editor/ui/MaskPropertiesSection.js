// Mask properties section rendered inside PropertiesPanel / Effect Controls.
// Shows per-mask controls: mode, invert, feather, opacity, expansion, path keyframe, tracking.
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS, TOOL_TYPES } from '../core/Constants.js';
import { editorState } from '../core/EditorState.js';
import { createMask } from '../effects/MaskUtils.js';
import { keyframeEngine } from '../effects/KeyframeEngine.js';
import { maskTrackingController } from '../effects/MaskTrackingController.js';
import { history } from '../core/History.js';
import { maskOverlay } from './MaskOverlay.js';

// Render mask sections for a clip into a target container.
// Returns cleanup function.
export function renderMaskSections(clip, target, kfBindings, rowMetas) {
  if (!clip) return () => {};

  const cleanupFns = [];

  // Render existing masks
  const masks = clip.masks || [];
  for (const mask of masks) {
    renderSingleMask(clip, mask, target, kfBindings, rowMetas, cleanupFns);
  }

  // Add Mask button
  const addBar = document.createElement('div');
  addBar.className = 'nle-mask-add-bar';

  const addBtn = document.createElement('button');
  addBtn.className = 'nle-mask-add-btn';
  addBtn.textContent = '+ Add Mask';
  addBtn.addEventListener('click', () => {
    const newMask = createMask('rectangle');
    clip.masks = clip.masks || [];

    const beforeMasks = JSON.parse(JSON.stringify(clip.masks));
    clip.masks.push(newMask);
    const afterMasks = JSON.parse(JSON.stringify(clip.masks));

    history.pushWithoutExecute({
      description: 'Add mask',
      execute() {
        clip.masks = JSON.parse(JSON.stringify(afterMasks));
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.masks = JSON.parse(JSON.stringify(beforeMasks));
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    editorState.set(STATE_PATHS.SELECTION_MASK_ID, newMask.id);
    editorState.set(STATE_PATHS.UI_MASK_EDIT_MODE, true);
    maskOverlay.selectMask(newMask.id);
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  // Mask tool buttons
  const toolBar = document.createElement('div');
  toolBar.className = 'nle-mask-tool-bar';

  const tools = [
    { type: TOOL_TYPES.MASK_PEN, label: 'Pen', title: 'Draw bezier mask' },
    { type: TOOL_TYPES.MASK_ELLIPSE, label: 'Ellipse', title: 'Draw ellipse mask' },
    { type: TOOL_TYPES.MASK_RECTANGLE, label: 'Rect', title: 'Draw rectangle mask' }
  ];

  for (const tool of tools) {
    const btn = document.createElement('button');
    btn.className = 'nle-mask-tool-btn';
    btn.textContent = tool.label;
    btn.title = tool.title;
    btn.addEventListener('click', () => {
      const current = editorState.get(STATE_PATHS.UI_MASK_TOOL);
      if (current === tool.type) {
        editorState.set(STATE_PATHS.UI_MASK_TOOL, null);
        btn.classList.remove('active');
      } else {
        editorState.set(STATE_PATHS.UI_MASK_TOOL, tool.type);
        toolBar.querySelectorAll('.nle-mask-tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
    toolBar.appendChild(btn);
  }

  addBar.appendChild(addBtn);
  addBar.appendChild(toolBar);
  target.appendChild(addBar);

  return () => {
    for (const fn of cleanupFns) fn();
  };
}

function renderSingleMask(clip, mask, target, kfBindings, rowMetas, cleanupFns) {
  const section = document.createElement('div');
  section.className = 'nle-props-section nle-mask-section';

  // Header
  const header = document.createElement('div');
  header.className = 'nle-props-section-header expanded';

  // Enable toggle
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = mask.enabled;
  toggle.className = 'nle-prop-toggle';
  toggle.addEventListener('change', () => {
    mask.enabled = toggle.checked;
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });
  header.appendChild(toggle);

  // Name
  const nameSpan = document.createElement('span');
  nameSpan.textContent = mask.name;
  nameSpan.className = 'nle-mask-name';
  header.appendChild(nameSpan);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'nle-prop-remove-btn';
  deleteBtn.textContent = '\u00d7';
  deleteBtn.title = 'Delete mask';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const beforeMasks = JSON.parse(JSON.stringify(clip.masks));
    clip.masks = clip.masks.filter(m => m.id !== mask.id);
    const afterMasks = JSON.parse(JSON.stringify(clip.masks));

    history.pushWithoutExecute({
      description: 'Delete mask',
      execute() {
        clip.masks = JSON.parse(JSON.stringify(afterMasks));
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clip.masks = JSON.parse(JSON.stringify(beforeMasks));
        eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    if (editorState.get(STATE_PATHS.SELECTION_MASK_ID) === mask.id) {
      editorState.set(STATE_PATHS.SELECTION_MASK_ID, null);
      editorState.set(STATE_PATHS.UI_MASK_EDIT_MODE, false);
    }
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });
  header.appendChild(deleteBtn);

  // Collapse toggle
  header.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    const isExpanded = header.classList.toggle('expanded');
    body.classList.toggle('collapsed', !isExpanded);
  });

  section.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'nle-props-section-body';

  // Mode dropdown
  const modeRow = document.createElement('div');
  modeRow.className = 'nle-prop-row';
  const modeLabel = document.createElement('label');
  modeLabel.className = 'nle-prop-label';
  modeLabel.textContent = 'Mode';
  modeRow.appendChild(modeLabel);

  const modeSelect = document.createElement('select');
  modeSelect.className = 'nle-prop-select';
  for (const mode of ['add', 'subtract', 'intersect', 'difference']) {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
    if (mask.mode === mode) opt.selected = true;
    modeSelect.appendChild(opt);
  }
  modeSelect.addEventListener('change', () => {
    mask.mode = modeSelect.value;
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });
  modeRow.appendChild(modeSelect);
  body.appendChild(modeRow);

  // Invert checkbox
  const invertRow = document.createElement('div');
  invertRow.className = 'nle-prop-row nle-prop-row--checkbox';
  const invertCb = document.createElement('input');
  invertCb.type = 'checkbox';
  invertCb.className = 'nle-prop-checkbox';
  invertCb.checked = mask.inverted;
  invertCb.addEventListener('change', () => {
    mask.inverted = invertCb.checked;
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });
  const invertLabel = document.createElement('label');
  invertLabel.className = 'nle-prop-label';
  invertLabel.textContent = 'Inverted';
  invertRow.appendChild(invertCb);
  invertRow.appendChild(invertLabel);
  body.appendChild(invertRow);

  // Feather slider
  const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
  _appendMaskSlider(body, mask, 'feather', 'Mask Feather', 'px', 0, 1000, 1, currentFrame, kfBindings, rowMetas);

  // Opacity slider
  _appendMaskSlider(body, mask, 'opacity', 'Mask Opacity', '%', 0, 100, 1, currentFrame, kfBindings, rowMetas);

  // Expansion slider
  _appendMaskSlider(body, mask, 'expansion', 'Mask Expansion', 'px', -1000, 1000, 1, currentFrame, kfBindings, rowMetas);

  // Edit Mask button
  const editRow = document.createElement('div');
  editRow.className = 'nle-prop-row nle-mask-edit-row';
  const editBtn = document.createElement('button');
  editBtn.className = 'nle-mask-edit-btn';
  editBtn.textContent = 'Edit Mask';
  editBtn.addEventListener('click', () => {
    maskOverlay.enterEditMode(mask.id);
  });
  editRow.appendChild(editBtn);

  // Mask Path keyframe row (stopwatch + diamond)
  const pathKfRow = document.createElement('div');
  pathKfRow.className = 'nle-prop-row nle-mask-path-kf-row';

  const pathStopwatch = document.createElement('button');
  pathStopwatch.className = `nle-kf-stopwatch${mask.pathKeyframes?.length > 0 ? ' active' : ''}`;
  pathStopwatch.title = 'Enable mask path keyframing';
  pathStopwatch.innerHTML = '&#9201;';
  pathStopwatch.addEventListener('click', () => {
    if (mask.pathKeyframes && mask.pathKeyframes.length > 0) {
      mask.pathKeyframes = [];
      pathStopwatch.classList.remove('active');
    } else {
      if (!mask.pathKeyframes) mask.pathKeyframes = [];
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      mask.pathKeyframes.push({ frame, value: JSON.parse(JSON.stringify(mask.path)) });
      mask.pathKeyframes.sort((a, b) => a.frame - b.frame);
      pathStopwatch.classList.add('active');
    }
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  const pathLabel = document.createElement('label');
  pathLabel.className = 'nle-prop-label';
  pathLabel.textContent = 'Mask Path';

  const pathKfBtn = document.createElement('button');
  pathKfBtn.className = 'nle-keyframe-btn';
  pathKfBtn.title = 'Add/Remove path keyframe';
  pathKfBtn.addEventListener('click', () => {
    if (!mask.pathKeyframes) mask.pathKeyframes = [];
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const existing = mask.pathKeyframes.findIndex(kf => kf.frame === frame);
    if (existing >= 0) {
      mask.pathKeyframes.splice(existing, 1);
    } else {
      mask.pathKeyframes.push({ frame, value: JSON.parse(JSON.stringify(mask.path)) });
      mask.pathKeyframes.sort((a, b) => a.frame - b.frame);
    }
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  pathKfRow.appendChild(pathStopwatch);
  pathKfRow.appendChild(pathLabel);
  pathKfRow.appendChild(pathKfBtn);
  editRow.appendChild(pathKfRow);
  body.appendChild(editRow);

  // Tracking buttons + progress
  const trackRow = document.createElement('div');
  trackRow.className = 'nle-prop-row nle-mask-track-row';

  const trackBackBtn = document.createElement('button');
  trackBackBtn.className = 'nle-mask-track-btn';
  trackBackBtn.textContent = '\u25c0 Track Backward';
  trackBackBtn.title = 'Track mask backward';

  const trackFwdBtn = document.createElement('button');
  trackFwdBtn.className = 'nle-mask-track-btn';
  trackFwdBtn.textContent = 'Track Forward \u25b6';
  trackFwdBtn.title = 'Track mask forward';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'nle-mask-track-btn nle-mask-track-cancel';
  cancelBtn.textContent = 'Cancel Tracking';

  const progressBar = document.createElement('div');
  progressBar.className = 'nle-mask-track-progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'nle-mask-track-progress-fill';
  progressBar.appendChild(progressFill);

  // If tracking is already in progress for this mask, show cancel/progress immediately
  const isCurrentlyTracking = maskTrackingController.isTracking()
    && maskTrackingController._mask?.id === mask.id;
  if (isCurrentlyTracking) {
    trackBackBtn.style.display = 'none';
    trackFwdBtn.style.display = 'none';
  } else {
    cancelBtn.style.display = 'none';
    progressBar.style.display = 'none';
  }

  const startTracking = (direction) => {
    trackBackBtn.style.display = 'none';
    trackFwdBtn.style.display = 'none';
    cancelBtn.style.display = '';
    progressBar.style.display = '';
    progressFill.style.width = '0%';
    eventBus.emit(EDITOR_EVENTS.MASK_TRACK_REQUEST, { maskId: mask.id, direction });
  };

  trackBackBtn.addEventListener('click', () => startTracking('backward'));
  trackFwdBtn.addEventListener('click', () => startTracking('forward'));

  cancelBtn.addEventListener('click', () => {
    maskTrackingController.cancel();
  });

  // Listen for progress updates
  const onProgress = (data) => {
    if (data.maskId !== mask.id) return;
    const pct = Math.round((data.progress || 0) * 100);
    progressFill.style.width = `${pct}%`;

    if (data.done || data.progress >= 1) {
      // Tracking finished — restore buttons
      trackBackBtn.style.display = '';
      trackFwdBtn.style.display = '';
      cancelBtn.style.display = 'none';
      progressBar.style.display = 'none';
    }
  };
  eventBus.on(EDITOR_EVENTS.MASK_TRACKING_PROGRESS, onProgress);
  cleanupFns.push(() => eventBus.off(EDITOR_EVENTS.MASK_TRACKING_PROGRESS, onProgress));

  trackRow.appendChild(trackBackBtn);
  trackRow.appendChild(trackFwdBtn);
  trackRow.appendChild(cancelBtn);
  trackRow.appendChild(progressBar);
  body.appendChild(trackRow);

  section.appendChild(body);
  target.appendChild(section);
}

// Simplified slider row for mask params (reuses the pattern from PropertiesPanel)
function _appendMaskSlider(container, mask, paramId, label, unit, min, max, step, currentFrame, kfBindings, rowMetas) {
  const kfs = mask.keyframes?.[paramId] || [];
  const hasKf = kfs.length > 0;
  const currentVal = hasKf
    ? keyframeEngine.getValueAtFrame(kfs, currentFrame)
    : mask.params[paramId];

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
  valueEl.textContent = `${Math.round(currentVal)}${unit}`;
  row.appendChild(valueEl);

  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    mask.params[paramId] = val;
    valueEl.textContent = `${Math.round(val)}${unit}`;
    if (mask.keyframes?.[paramId]?.length > 0) {
      keyframeEngine.addKeyframe(mask.keyframes[paramId], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
    }
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  kfBtn.addEventListener('click', () => {
    if (!mask.keyframes) mask.keyframes = {};
    if (!mask.keyframes[paramId]) mask.keyframes[paramId] = [];
    const kfArr = mask.keyframes[paramId];
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    const existing = kfArr.findIndex(kf => kf.frame === frame);
    if (existing >= 0) {
      kfArr.splice(existing, 1);
    } else {
      keyframeEngine.addKeyframe(kfArr, frame, mask.params[paramId]);
    }
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  stopwatch.addEventListener('click', () => {
    if (!mask.keyframes) mask.keyframes = {};
    const kfs = mask.keyframes[paramId];
    if (kfs && kfs.length > 0) {
      mask.keyframes[paramId] = [];
      stopwatch.classList.remove('active');
    } else {
      if (!mask.keyframes[paramId]) mask.keyframes[paramId] = [];
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      keyframeEngine.addKeyframe(mask.keyframes[paramId], frame, mask.params[paramId]);
      stopwatch.classList.add('active');
    }
    eventBus.emit(EDITOR_EVENTS.MASK_UPDATED);
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
  });

  // Track binding for live updates during playback
  if (kfBindings) {
    kfBindings.push({
      effectRef: { params: mask.params, keyframes: mask.keyframes },
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
      effectRef: { params: mask.params, keyframes: mask.keyframes },
      paramId,
      keyframesRef: () => mask.keyframes?.[paramId] || [],
      rowEl: row,
      y: 0,
      height: 0
    });
  }
}

export default renderMaskSections;

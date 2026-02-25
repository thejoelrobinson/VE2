// Premiere Pro-style Effect Controls with split-panel layout
// Left: property controls. Right: unified keyframe timeline.
import { editorState } from '../core/EditorState.js';
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import { EDITOR_EVENTS, TRACK_TYPES, STATE_PATHS } from '../core/Constants.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { keyframeEngine, EASING } from '../effects/KeyframeEngine.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import { keyframeTimeline } from './KeyframeTimeline.js';
import { resolveSelectedClip } from './uiUtils.js';
import { attachScrubby } from './ScrubbyInput.js';
import { renderMaskSections } from './MaskPropertiesSection.js';
import { renderRotoSections } from './RotoPropertiesSection.js';
import { maskTrackingController } from '../effects/MaskTrackingController.js';

export const propertiesPanel = {
  _container: null,
  _contentEl: null,
  _leftPane: null,
  _rightPane: null,

  init(container) {
    this._container = container;
    this._contentEl = container.querySelector('.nle-ec-content') || container.querySelector('.nle-properties-content');
    this._leftPane = container.querySelector('.nle-ec-left');
    this._rightPane = container.querySelector('.nle-ec-right');
    this._kfBindings = [];
    this._rowMetas = [];
    this._scrubbies = [];

    // Scroll sync: left pane scroll drives right pane keyframe canvas
    if (this._leftPane) {
      this._scrollLeftPane = this._leftPane; // Store reference for reliable cleanup
      this._onLeftScroll = () => {
        keyframeTimeline.setScrollTop(this._leftPane.scrollTop);
      };
      this._leftPane.addEventListener('scroll', this._onLeftScroll);
    }

    this._onRender = () => this._render();
    this._onPlaybackFrame = () => this._updateKeyframedValues();
    // Skip full re-render during mask/roto tracking to preserve cancel button state
    this._onMaskUpdated = () => {
      if (maskTrackingController.isTracking()) return;
      this._render();
    };

    this._unsubEvents = subscribeEvents({
      [EDITOR_EVENTS.CLIP_SELECTED]: this._onRender,
      [EDITOR_EVENTS.CLIP_DESELECTED]: this._onRender,
      [EDITOR_EVENTS.SELECTION_CHANGED]: this._onRender,
      [EDITOR_EVENTS.TIMELINE_UPDATED]: this._onRender,
      [EDITOR_EVENTS.PLAYBACK_FRAME]: this._onPlaybackFrame,
      [EDITOR_EVENTS.MASK_UPDATED]: this._onMaskUpdated,
      [EDITOR_EVENTS.ROTO_UPDATED]: this._onMaskUpdated,
    });

    this._render();
  },

  destroy() {
    if (this._unsubEvents) this._unsubEvents();
    const scrollPane = this._scrollLeftPane || this._leftPane;
    if (scrollPane && this._onLeftScroll) {
      scrollPane.removeEventListener('scroll', this._onLeftScroll);
    }
    this._scrollLeftPane = null;
    if (this._maskCleanup) { this._maskCleanup(); this._maskCleanup = null; }
    if (this._rotoCleanup) { this._rotoCleanup(); this._rotoCleanup = null; }
    for (const s of this._scrubbies) s.destroy();
    this._scrubbies = [];
    keyframeTimeline.unmount();
    this._kfBindings = [];
    this._rowMetas = [];
  },

  _render() {
    const target = this._leftPane || this._contentEl;
    if (!target) return;

    this._kfBindings = [];
    this._rowMetas = [];
    if (this._maskCleanup) { this._maskCleanup(); this._maskCleanup = null; }
    if (this._rotoCleanup) { this._rotoCleanup(); this._rotoCleanup = null; }
    for (const s of this._scrubbies) s.destroy();
    this._scrubbies = [];
    keyframeTimeline.unmount();

    const resolved = resolveSelectedClip();
    if (!resolved) {
      target.innerHTML = '<div class="nle-props-empty">Select a clip to view properties</div>';
      if (this._rightPane) this._rightPane.style.display = 'none';
      const divider = this._container?.querySelector('.nle-ec-divider');
      if (divider) divider.style.display = 'none';
      return;
    }
    if (resolved.multiSelect) {
      target.innerHTML = `<div class="nle-props-empty">${resolved.count} clips selected</div>`;
      if (this._rightPane) this._rightPane.style.display = 'none';
      const divider = this._container?.querySelector('.nle-ec-divider');
      if (divider) divider.style.display = 'none';
      return;
    }
    const { clip, linkedPair } = resolved;

    // Show right pane + divider
    if (this._rightPane) this._rightPane.style.display = '';
    const divider = this._container?.querySelector('.nle-ec-divider');
    if (divider) divider.style.display = '';

    target.innerHTML = '';
    this._currentClip = clip;
    this._linkedClip = linkedPair ? linkedPair.audio : null;

    // Clip info section
    this._renderClipInfo(clip, target);

    // Motion control (video clips)
    const track = timelineEngine.getTrack(clip.trackId);
    if (track && track.type !== TRACK_TYPES.AUDIO) {
      this._renderMotionControl(clip, target);
    }

    // Opacity control (video clips)
    if (track && track.type !== TRACK_TYPES.AUDIO) {
      this._renderOpacityControl(clip, target);
    }

    // Mask controls (video clips)
    if (track && track.type !== TRACK_TYPES.AUDIO) {
      this._maskCleanup = renderMaskSections(clip, target, this._kfBindings, this._rowMetas);
    }

    // Roto Brush controls (video clips)
    if (track && track.type !== TRACK_TYPES.AUDIO) {
      const rotoEffects = (clip.effects || []).filter(fx => fx.effectId === 'roto-brush');
      const rotoCleanups = [];
      for (const rotoFx of rotoEffects) {
        rotoCleanups.push(renderRotoSections(clip, rotoFx, target, this._kfBindings, this._rowMetas));
      }
      if (rotoCleanups.length > 0) {
        this._rotoCleanup = () => rotoCleanups.forEach(fn => fn());
      }
    }

    // Time Remapping (video clips)
    if (track && track.type !== TRACK_TYPES.AUDIO) {
      this._renderTimeRemappingControl(clip, target);
    }

    // Volume control — use linked audio clip if this is a linked pair
    const volumeClip = this._linkedClip || clip;
    this._renderVolumeControl(volumeClip, target);

    // Panner control
    this._renderPannerControl(volumeClip, target);

    // Channel Volume control
    this._renderChannelVolumeControl(volumeClip, target);

    // Speed control (only show when time-remap is disabled)
    const timeRemapFx = clip.effects?.find(fx => fx.id === 'intrinsic-time-remap');
    if (!timeRemapFx || !timeRemapFx.enabled) {
      this._renderSpeedControl(clip, target);
    }

    // Effects list for both clips in a linked pair
    this._renderEffects(clip, target);
    if (this._linkedClip) {
      this._renderEffects(this._linkedClip, target);
    }

    // Mount keyframe timeline in right pane after DOM settles
    requestAnimationFrame(() => {
      this._measureRowPositions();
      keyframeTimeline.mount(clip, this._linkedClip, this._rowMetas, this._rightPane);
    });
  },

  _measureRowPositions() {
    if (!this._leftPane || this._rowMetas.length === 0) return;
    const leftRect = this._leftPane.getBoundingClientRect();
    const scrollTop = this._leftPane.scrollTop;
    for (const meta of this._rowMetas) {
      if (!meta.rowEl) continue;
      const rect = meta.rowEl.getBoundingClientRect();
      meta.y = rect.top - leftRect.top + scrollTop;
      meta.height = rect.height;
    }
  },

  _renderClipInfo(clip, target) {
    const { section, body } = this._createSection('Clip', true);
    body.innerHTML = `
      <div class="nle-prop-row">
        <label class="nle-prop-label">Name</label>
        <input class="nle-prop-input" type="text" data-prop="name">
      </div>
      <div class="nle-prop-row">
        <label class="nle-prop-label">Start</label>
        <span class="nle-prop-value">${clip.startFrame}</span>
      </div>
    `;

    const nameInput = body.querySelector('[data-prop="name"]');
    if (nameInput) nameInput.value = clip.name;
    nameInput?.addEventListener('change', () => {
      clip.name = nameInput.value;
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    target.appendChild(section);
  },

  // ── Motion Section (Premiere-style intrinsic) ──

  _renderMotionControl(clip, target) {
    const motionFx = clip.effects?.find(fx => fx.id === 'intrinsic-motion');
    if (!motionFx) return;

    const { section, body } = this._createSection('Motion', true);
    section.classList.add('nle-props-section--keyframeable');

    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);

    // Position (X, Y) — shared stopwatch
    this._appendXYRow(body, motionFx, 'posX', 'posY', 'Position', currentFrame);

    // Scale
    this._appendSliderRow(body, motionFx, 'scale', 'Scale', '%', 0, 600, 0.1, currentFrame);

    // Uniform Scale checkbox
    const uniformRow = document.createElement('div');
    uniformRow.className = 'nle-prop-row nle-prop-row--checkbox';
    const uniformCb = document.createElement('input');
    uniformCb.type = 'checkbox';
    uniformCb.className = 'nle-prop-checkbox';
    uniformCb.checked = motionFx.params.uniformScale;
    const uniformLabel = document.createElement('label');
    uniformLabel.className = 'nle-prop-label';
    uniformLabel.textContent = 'Uniform Scale';
    uniformRow.appendChild(uniformCb);
    uniformRow.appendChild(uniformLabel);
    body.appendChild(uniformRow);

    // Scale Width (hidden when uniform)
    const scaleWidthContainer = document.createElement('div');
    scaleWidthContainer.style.display = motionFx.params.uniformScale ? 'none' : '';
    this._appendSliderRow(scaleWidthContainer, motionFx, 'scaleWidth', 'Scale Width', '%', 0, 600, 0.1, currentFrame);
    body.appendChild(scaleWidthContainer);

    // Uniform Scale toggle logic
    uniformCb.addEventListener('change', () => {
      motionFx.params.uniformScale = uniformCb.checked;
      scaleWidthContainer.style.display = uniformCb.checked ? 'none' : '';
      if (uniformCb.checked) {
        motionFx.params.scaleWidth = motionFx.params.scale;
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    // Bind scale slider to also update scaleWidth when uniform
    const scaleBinding = this._kfBindings.find(b => b.effectRef === motionFx && b.paramId === 'scale');
    if (scaleBinding && scaleBinding.slider) {
      scaleBinding.slider.addEventListener('input', () => {
        if (motionFx.params.uniformScale) {
          motionFx.params.scaleWidth = motionFx.params.scale;
        }
      });
    }

    // Rotation (angle dial)
    this._appendAngleRow(body, motionFx, 'rotation', 'Rotation', '\u00b0', -3600, 3600, 0.1, currentFrame);

    // Anchor Point (X, Y)
    this._appendXYRow(body, motionFx, 'anchorX', 'anchorY', 'Anchor Point', currentFrame);

    // Anti-flicker Filter
    this._appendSliderRow(body, motionFx, 'antiFlicker', 'Anti-flicker', '', 0, 1, 0.01, currentFrame);

    // Crop Left/Top/Right/Bottom
    this._appendSliderRow(body, motionFx, 'cropLeft', 'Crop Left', '%', 0, 100, 0.1, currentFrame);
    this._appendSliderRow(body, motionFx, 'cropTop', 'Crop Top', '%', 0, 100, 0.1, currentFrame);
    this._appendSliderRow(body, motionFx, 'cropRight', 'Crop Right', '%', 0, 100, 0.1, currentFrame);
    this._appendSliderRow(body, motionFx, 'cropBottom', 'Crop Bottom', '%', 0, 100, 0.1, currentFrame);

    target.appendChild(section);
  },

  _renderOpacityControl(clip, target) {
    const opFx = clip.effects?.find(fx => fx.intrinsic && fx.effectId === 'opacity');
    if (!opFx) return;

    const { section, body } = this._createSection('Opacity', true);
    section.classList.add('nle-props-section--keyframeable');

    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    this._appendSliderRow(body, opFx, 'opacity', 'Opacity', '%', 0, 100, 1, currentFrame);

    target.appendChild(section);
  },

  _renderTimeRemappingControl(clip, target) {
    const trFx = clip.effects?.find(fx => fx.id === 'intrinsic-time-remap');
    if (!trFx) return;

    const { section, body } = this._createSection('Time Remapping', true);
    section.classList.add('nle-props-section--keyframeable');

    // Enable toggle in header
    const header = section.querySelector('.nle-props-section-header');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = trFx.enabled;
    toggle.className = 'nle-prop-toggle';
    toggle.addEventListener('change', () => {
      trFx.enabled = toggle.checked;
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      this._render();
    });
    header.prepend(toggle);

    if (trFx.enabled) {
      const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      this._appendSliderRow(body, trFx, 'speed', 'Speed', '%', -1000, 1000, 1, currentFrame);
    } else {
      const hint = document.createElement('div');
      hint.className = 'nle-prop-row';
      hint.innerHTML = '<span class="nle-prop-value" style="min-width:auto;color:#555;font-size:10px">Enable to remap time with keyframes</span>';
      body.appendChild(hint);
    }

    target.appendChild(section);
  },

  _renderVolumeControl(clip, target) {
    const volFx = clip.effects?.find(fx => fx.intrinsic && fx.effectId === 'audio-volume');
    if (!volFx) return;

    const { section, body } = this._createSection('Volume', true);
    section.classList.add('nle-props-section--keyframeable');

    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    this._appendSliderRow(body, volFx, 'gain', 'Level', '%', 0, 200, 1, currentFrame);

    target.appendChild(section);
  },

  _renderPannerControl(clip, target) {
    const panFx = clip.effects?.find(fx => fx.id === 'intrinsic-panner');
    if (!panFx) return;

    const { section, body } = this._createSection('Panner', true);
    section.classList.add('nle-props-section--keyframeable');

    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    this._appendSliderRow(body, panFx, 'pan', 'Balance', '', -100, 100, 1, currentFrame);

    target.appendChild(section);
  },

  _renderChannelVolumeControl(clip, target) {
    const cvFx = clip.effects?.find(fx => fx.id === 'intrinsic-channel-volume');
    if (!cvFx) return;

    const { section, body } = this._createSection('Channel Volume', true);
    section.classList.add('nle-props-section--keyframeable');

    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
    this._appendSliderRow(body, cvFx, 'left', 'Left', '%', 0, 200, 1, currentFrame);
    this._appendSliderRow(body, cvFx, 'right', 'Right', '%', 0, 200, 1, currentFrame);

    target.appendChild(section);
  },

  _renderSpeedControl(clip, target) {
    const { section, body } = this._createSection('Speed', true);
    const row = document.createElement('div');
    row.className = 'nle-prop-row';
    row.innerHTML = `
      <label class="nle-prop-label">Speed</label>
      <input class="nle-prop-slider" type="range" min="10" max="400" value="${(clip.speed ?? 1) * 100}" step="5">
      <span class="nle-prop-value">${Math.round((clip.speed ?? 1) * 100)}%</span>
    `;

    const slider = row.querySelector('.nle-prop-slider');
    const valueEl = row.querySelector('.nle-prop-value');

    const speedScrubby = attachScrubby(valueEl, {
      value: (clip.speed ?? 1) * 100, min: 10, max: 400, step: 5, unit: '%',
      formatValue: (v) => `${Math.round(v)}%`,
      onChange: (val) => {
        clip.speed = val / 100;
        if (slider) slider.value = val;
        const linked = clip.linkedClipId ? timelineEngine.getClip(clip.linkedClipId) : null;
        if (linked) linked.speed = clip.speed;
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
    this._scrubbies.push(speedScrubby);

    slider?.addEventListener('input', () => {
      clip.speed = slider.value / 100;
      const linked = clip.linkedClipId ? timelineEngine.getClip(clip.linkedClipId) : null;
      if (linked) linked.speed = clip.speed;
      speedScrubby.setValue(parseFloat(slider.value));
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    body.appendChild(row);
    target.appendChild(section);
  },

  _renderEffects(clip, target) {
    if (!clip.effects || clip.effects.length === 0) return;

    for (const fx of clip.effects.filter(fx => !fx.intrinsic)) {
      const def = effectRegistry.get(fx.effectId);
      if (!def) continue;

      const { section, body } = this._createSection(fx.name, true);
      section.classList.add('nle-props-effect');

      const hasRangeParams = def.params.some(p => p.type === 'range');
      if (hasRangeParams) {
        section.classList.add('nle-props-section--keyframeable');
      }

      // Enable toggle
      const header = section.querySelector('.nle-props-section-header');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = fx.enabled;
      toggle.className = 'nle-prop-toggle';
      toggle.addEventListener('change', () => {
        fx.enabled = toggle.checked;
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      });
      header.prepend(toggle);

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'nle-prop-remove-btn';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove effect';
      removeBtn.addEventListener('click', () => {
        clip.effects = clip.effects.filter(e => e.id !== fx.id);
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        this._render();
      });
      header.appendChild(removeBtn);

      const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);

      // Params
      for (const paramDef of def.params) {
        if (paramDef.type === 'range' && paramDef.unit === '\u00b0') {
          this._appendAngleRow(body, fx, paramDef.id, paramDef.name, '\u00b0', paramDef.min, paramDef.max, paramDef.step || 1, currentFrame);
        } else if (paramDef.type === 'range') {
          this._appendSliderRow(body, fx, paramDef.id, paramDef.name, paramDef.unit || '', paramDef.min, paramDef.max, paramDef.step || 1, currentFrame);
        } else if (paramDef.type === 'color') {
          const row = document.createElement('div');
          row.className = 'nle-prop-row';
          const colorLabel = document.createElement('label');
          colorLabel.className = 'nle-prop-label';
          colorLabel.textContent = paramDef.name;
          row.appendChild(colorLabel);
          const colorInput = document.createElement('input');
          colorInput.className = 'nle-prop-color';
          colorInput.type = 'color';
          colorInput.value = fx.params[paramDef.id] || '#000000';
          row.appendChild(colorInput);
          colorInput.addEventListener('input', () => {
            fx.params[paramDef.id] = colorInput.value;
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          });
          body.appendChild(row);
        } else if (paramDef.type === 'checkbox') {
          const row = document.createElement('div');
          row.className = 'nle-prop-row nle-prop-row--checkbox';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'nle-prop-checkbox';
          cb.checked = fx.params[paramDef.id];
          const label = document.createElement('label');
          label.className = 'nle-prop-label';
          label.textContent = paramDef.name;
          row.appendChild(cb);
          row.appendChild(label);
          cb.addEventListener('change', () => {
            fx.params[paramDef.id] = cb.checked;
            eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
          });
          body.appendChild(row);
        }
      }

      target.appendChild(section);
    }
  },

  // ── Reusable row builders ──

  _appendSliderRow(container, fx, paramId, label, unit, min, max, step, currentFrame) {
    const kfs = fx.keyframes?.[paramId] || [];
    const hasKf = kfs.length > 0;
    const currentVal = hasKf
      ? keyframeEngine.getValueAtFrame(kfs, currentFrame)
      : fx.params[paramId];

    const row = this._createKeyframeRow({ label, value: currentVal, unit, min, max, step, hasKf });

    const slider = row.querySelector('.nle-prop-slider');
    const valueEl = row.querySelector('.nle-prop-value');
    const kfBtn = row.querySelector('.nle-keyframe-btn');
    const stopwatch = row.querySelector('.nle-kf-stopwatch');
    const prevBtn = row.querySelector('.nle-kf-nav-prev');
    const nextBtn = row.querySelector('.nle-kf-nav-next');

    // Mark value blue if keyframed
    if (hasKf) valueEl.classList.add('keyframed');

    // Binding object (scrubby added below)
    const binding = { effectRef: fx, paramId, slider, display: valueEl, unit, step, scrubby: null };

    slider?.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      fx.params[paramId] = val;
      if (binding.scrubby) {
        binding.scrubby.setValue(val);
      } else {
        valueEl.textContent = this._formatValue(val, unit, step);
      }
      if (fx.keyframes?.[paramId]?.length > 0) {
        keyframeEngine.addKeyframe(fx.keyframes[paramId], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    // Scrubby on value display
    const scrubby = attachScrubby(valueEl, {
      value: currentVal, min, max, step, unit,
      formatValue: (v) => this._formatValue(v, unit, step),
      onChange: (val) => {
        fx.params[paramId] = val;
        if (slider) slider.value = val;
        if (fx.keyframes?.[paramId]?.length > 0) {
          keyframeEngine.addKeyframe(fx.keyframes[paramId], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
    binding.scrubby = scrubby;
    this._scrubbies.push(scrubby);

    kfBtn?.addEventListener('click', () => {
      if (!fx.keyframes) fx.keyframes = {};
      if (!fx.keyframes[paramId]) fx.keyframes[paramId] = [];
      const kfArr = fx.keyframes[paramId];
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      const existing = kfArr.findIndex(kf => kf.frame === frame);
      if (existing >= 0) {
        kfArr.splice(existing, 1);
      } else {
        keyframeEngine.addKeyframe(kfArr, frame, fx.params[paramId]);
      }
      this._updateKfButtonState(kfBtn, kfArr, frame);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    stopwatch?.addEventListener('click', () => {
      this._handleStopwatch(fx, paramId, fx.params[paramId], stopwatch);
    });

    prevBtn?.addEventListener('click', () => {
      this._seekToAdjacentKf(fx.keyframes?.[paramId], -1);
    });

    nextBtn?.addEventListener('click', () => {
      this._seekToAdjacentKf(fx.keyframes?.[paramId], 1);
    });

    this._kfBindings.push(binding);

    container.appendChild(row);

    // Collect row metadata for right-pane keyframe timeline
    this._rowMetas.push({
      effectRef: fx,
      paramId,
      keyframesRef: () => fx.keyframes?.[paramId] || [],
      rowEl: row,
      y: 0,
      height: 0
    });
  },

  _appendAngleRow(container, fx, paramId, label, unit, min, max, step, currentFrame) {
    const kfs = fx.keyframes?.[paramId] || [];
    const hasKf = kfs.length > 0;
    const currentVal = hasKf
      ? keyframeEngine.getValueAtFrame(kfs, currentFrame)
      : fx.params[paramId];

    const row = document.createElement('div');
    row.className = 'nle-prop-row nle-prop-row--kf';

    // Stopwatch
    const stopwatch = document.createElement('button');
    stopwatch.className = `nle-kf-stopwatch${hasKf ? ' active' : ''}`;
    stopwatch.title = hasKf ? 'Disable keyframing' : 'Enable keyframing';
    stopwatch.innerHTML = '&#9201;';
    row.appendChild(stopwatch);

    // Label
    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    // Keyframe nav
    const prevBtn = document.createElement('button');
    prevBtn.className = 'nle-kf-nav-prev';
    prevBtn.title = 'Previous keyframe';
    prevBtn.innerHTML = '&#9664;';
    row.appendChild(prevBtn);

    const kfBtn = document.createElement('button');
    kfBtn.className = `nle-keyframe-btn${hasKf ? ' active' : ''}`;
    kfBtn.title = 'Toggle keyframe';
    row.appendChild(kfBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'nle-kf-nav-next';
    nextBtn.title = 'Next keyframe';
    nextBtn.innerHTML = '&#9654;';
    row.appendChild(nextBtn);

    // Angle dial canvas
    const dpr = window.devicePixelRatio || 1;
    const dialSize = 24;
    const canvas = document.createElement('canvas');
    canvas.className = 'nle-angle-dial';
    canvas.width = dialSize * dpr;
    canvas.height = dialSize * dpr;
    canvas.style.width = `${dialSize}px`;
    canvas.style.height = `${dialSize}px`;
    row.appendChild(canvas);

    this._drawAngleDial(canvas, currentVal);

    // Scrubby value display
    const valueEl = document.createElement('span');
    valueEl.className = 'nle-prop-value';
    valueEl.textContent = this._formatValue(currentVal, unit, step);
    row.appendChild(valueEl);

    if (hasKf) valueEl.classList.add('keyframed');

    const binding = { effectRef: fx, paramId, slider: null, display: valueEl, unit, step, scrubby: null, angleDial: canvas };

    // Helper to apply angle value
    const applyAngle = (val) => {
      val = Math.max(min, Math.min(max, val));
      fx.params[paramId] = val;
      this._drawAngleDial(canvas, val);
      if (binding.scrubby) {
        binding.scrubby.setValue(val);
      } else {
        valueEl.textContent = this._formatValue(val, unit, step);
      }
      if (fx.keyframes?.[paramId]?.length > 0) {
        keyframeEngine.addKeyframe(fx.keyframes[paramId], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    };

    // Dial drag interaction — relative delta tracking to preserve multi-revolution values
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cxR = rect.width / 2;
      const cyR = rect.height / 2;

      const mouseAngle = (evt) => {
        const dx = evt.clientX - rect.left - cxR;
        const dy = evt.clientY - rect.top - cyR;
        return Math.atan2(dy, dx) * 180 / Math.PI + 90;
      };

      let prevAngle = mouseAngle(e);
      let accumVal = fx.params[paramId];

      const onMove = (e2) => {
        const curAngle = mouseAngle(e2);
        let delta = curAngle - prevAngle;
        // Handle wrap-around at ±180° boundary
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        prevAngle = curAngle;
        accumVal += delta;
        const finalVal = e2.shiftKey ? Math.round(accumVal / 45) * 45 : accumVal;
        applyAngle(finalVal);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // Scrubby on value display
    const scrubby = attachScrubby(valueEl, {
      value: currentVal, min, max, step, unit,
      formatValue: (v) => this._formatValue(v, unit, step),
      onChange: (val) => {
        fx.params[paramId] = val;
        this._drawAngleDial(canvas, val);
        if (fx.keyframes?.[paramId]?.length > 0) {
          keyframeEngine.addKeyframe(fx.keyframes[paramId], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
    binding.scrubby = scrubby;
    this._scrubbies.push(scrubby);

    // Keyframe controls
    kfBtn.addEventListener('click', () => {
      if (!fx.keyframes) fx.keyframes = {};
      if (!fx.keyframes[paramId]) fx.keyframes[paramId] = [];
      const kfArr = fx.keyframes[paramId];
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      const existing = kfArr.findIndex(kf => kf.frame === frame);
      if (existing >= 0) {
        kfArr.splice(existing, 1);
      } else {
        keyframeEngine.addKeyframe(kfArr, frame, fx.params[paramId]);
      }
      this._updateKfButtonState(kfBtn, kfArr, frame);
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    stopwatch.addEventListener('click', () => {
      this._handleStopwatch(fx, paramId, fx.params[paramId], stopwatch);
    });

    prevBtn.addEventListener('click', () => {
      this._seekToAdjacentKf(fx.keyframes?.[paramId], -1);
    });

    nextBtn.addEventListener('click', () => {
      this._seekToAdjacentKf(fx.keyframes?.[paramId], 1);
    });

    this._kfBindings.push(binding);
    container.appendChild(row);

    this._rowMetas.push({
      effectRef: fx,
      paramId,
      keyframesRef: () => fx.keyframes?.[paramId] || [],
      rowEl: row,
      y: 0,
      height: 0
    });
  },

  _drawAngleDial(canvas, angleDeg) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.width / dpr;
    const cx = size / 2;
    const cy = size / 2;
    const r = cx - 2;
    const rad = (angleDeg - 90) * Math.PI / 180;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    // Circle outline
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Angle line from center to edge
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(rad), cy + r * Math.sin(rad));
    ctx.strokeStyle = '#4a90d9';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#4a90d9';
    ctx.fill();

    ctx.restore();
  },

  _appendXYRow(container, fx, paramIdX, paramIdY, label, currentFrame) {
    const kfsX = fx.keyframes?.[paramIdX] || [];
    const kfsY = fx.keyframes?.[paramIdY] || [];
    const hasKfX = kfsX.length > 0;
    const hasKfY = kfsY.length > 0;
    const hasKf = hasKfX || hasKfY;

    const valX = hasKfX ? keyframeEngine.getValueAtFrame(kfsX, currentFrame) : fx.params[paramIdX];
    const valY = hasKfY ? keyframeEngine.getValueAtFrame(kfsY, currentFrame) : fx.params[paramIdY];

    const row = document.createElement('div');
    row.className = 'nle-prop-row-group';

    // Stopwatch (shared for both X and Y)
    const stopwatch = document.createElement('button');
    stopwatch.className = `nle-kf-stopwatch${hasKf ? ' active' : ''}`;
    stopwatch.title = hasKf ? 'Disable keyframing' : 'Enable keyframing';
    stopwatch.innerHTML = '&#9201;';
    row.appendChild(stopwatch);

    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    // Prev/diamond/next (shared navigation)
    const prevBtn = document.createElement('button');
    prevBtn.className = 'nle-kf-nav-prev';
    prevBtn.innerHTML = '&#9664;';
    row.appendChild(prevBtn);

    const kfBtn = document.createElement('button');
    kfBtn.className = `nle-keyframe-btn${hasKf ? ' active' : ''}`;
    row.appendChild(kfBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'nle-kf-nav-next';
    nextBtn.innerHTML = '&#9654;';
    row.appendChild(nextBtn);

    // X input
    const xLabel = document.createElement('span');
    xLabel.className = 'nle-prop-xy-label';
    xLabel.textContent = 'X';
    row.appendChild(xLabel);

    const xInput = document.createElement('input');
    xInput.type = 'number';
    xInput.className = `nle-prop-number-input${hasKfX ? ' keyframed' : ''}`;
    xInput.value = typeof valX === 'number' ? parseFloat(valX.toFixed(1)) : valX;
    xInput.step = '0.5';
    row.appendChild(xInput);

    // Y input
    const yLabel = document.createElement('span');
    yLabel.className = 'nle-prop-xy-label';
    yLabel.textContent = 'Y';
    row.appendChild(yLabel);

    const yInput = document.createElement('input');
    yInput.type = 'number';
    yInput.className = `nle-prop-number-input${hasKfY ? ' keyframed' : ''}`;
    yInput.value = typeof valY === 'number' ? parseFloat(valY.toFixed(1)) : valY;
    yInput.step = '0.5';
    row.appendChild(yInput);

    // Reset button
    const resetBtn = this._createResetButton(() => {
      const def = effectRegistry.get(fx.effectId);
      if (!def) return;
      const defX = def.params.find(p => p.id === paramIdX);
      const defY = def.params.find(p => p.id === paramIdY);
      if (defX) { fx.params[paramIdX] = defX.default; xInput.value = defX.default; }
      if (defY) { fx.params[paramIdY] = defY.default; yInput.value = defY.default; }
      if (!fx.keyframes) fx.keyframes = {};
      fx.keyframes[paramIdX] = [];
      fx.keyframes[paramIdY] = [];
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      this._render();
    });
    row.appendChild(resetBtn);

    // Event handlers
    xInput.addEventListener('change', () => {
      const val = parseFloat(xInput.value) || 0;
      fx.params[paramIdX] = val;
      if (fx.keyframes?.[paramIdX]?.length > 0) {
        keyframeEngine.addKeyframe(fx.keyframes[paramIdX], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    yInput.addEventListener('change', () => {
      const val = parseFloat(yInput.value) || 0;
      fx.params[paramIdY] = val;
      if (fx.keyframes?.[paramIdY]?.length > 0) {
        keyframeEngine.addKeyframe(fx.keyframes[paramIdY], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    kfBtn.addEventListener('click', () => {
      if (!fx.keyframes) fx.keyframes = {};
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      for (const pid of [paramIdX, paramIdY]) {
        if (!fx.keyframes[pid]) fx.keyframes[pid] = [];
        const kfArr = fx.keyframes[pid];
        const existing = kfArr.findIndex(kf => kf.frame === frame);
        if (existing >= 0) {
          kfArr.splice(existing, 1);
        } else {
          keyframeEngine.addKeyframe(kfArr, frame, fx.params[pid]);
        }
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });

    stopwatch.addEventListener('click', () => {
      if (!fx.keyframes) fx.keyframes = {};
      const anyKf = (fx.keyframes[paramIdX]?.length > 0) || (fx.keyframes[paramIdY]?.length > 0);
      if (anyKf) {
        fx.keyframes[paramIdX] = [];
        fx.keyframes[paramIdY] = [];
        stopwatch.classList.remove('active');
      } else {
        const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
        if (!fx.keyframes[paramIdX]) fx.keyframes[paramIdX] = [];
        if (!fx.keyframes[paramIdY]) fx.keyframes[paramIdY] = [];
        keyframeEngine.addKeyframe(fx.keyframes[paramIdX], frame, fx.params[paramIdX]);
        keyframeEngine.addKeyframe(fx.keyframes[paramIdY], frame, fx.params[paramIdY]);
        stopwatch.classList.add('active');
      }
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      this._render();
    });

    prevBtn.addEventListener('click', () => {
      const allKfs = [...(fx.keyframes?.[paramIdX] || []), ...(fx.keyframes?.[paramIdY] || [])];
      this._seekToAdjacentKf(allKfs, -1);
    });

    nextBtn.addEventListener('click', () => {
      const allKfs = [...(fx.keyframes?.[paramIdX] || []), ...(fx.keyframes?.[paramIdY] || [])];
      this._seekToAdjacentKf(allKfs, 1);
    });

    // Scrubby on X/Y inputs
    const xScrubby = attachScrubby(xInput, {
      value: valX, min: -10000, max: 10000, step: 0.5, precision: 1,
      onChange: (val) => {
        fx.params[paramIdX] = val;
        if (fx.keyframes?.[paramIdX]?.length > 0) {
          keyframeEngine.addKeyframe(fx.keyframes[paramIdX], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
    const yScrubby = attachScrubby(yInput, {
      value: valY, min: -10000, max: 10000, step: 0.5, precision: 1,
      onChange: (val) => {
        fx.params[paramIdY] = val;
        if (fx.keyframes?.[paramIdY]?.length > 0) {
          keyframeEngine.addKeyframe(fx.keyframes[paramIdY], editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });
    this._scrubbies.push(xScrubby, yScrubby);

    // Bind for live playback updates
    this._kfBindings.push({
      effectRef: fx, paramId: paramIdX,
      slider: null, display: xInput, unit: '', step: 0.5,
      isNumberInput: true, scrubby: xScrubby
    });
    this._kfBindings.push({
      effectRef: fx, paramId: paramIdY,
      slider: null, display: yInput, unit: '', step: 0.5,
      isNumberInput: true, scrubby: yScrubby
    });

    container.appendChild(row);

    // Collect row metadata for X and Y (both share same row element for Y positioning)
    this._rowMetas.push({
      effectRef: fx,
      paramId: paramIdX,
      keyframesRef: () => fx.keyframes?.[paramIdX] || [],
      rowEl: row,
      y: 0,
      height: 0
    });
    this._rowMetas.push({
      effectRef: fx,
      paramId: paramIdY,
      keyframesRef: () => fx.keyframes?.[paramIdY] || [],
      rowEl: row,
      y: 0,
      height: 0
    });
  },

  // Update slider values as playhead moves through keyframes
  _updateKeyframedValues() {
    if (!this._kfBindings || this._kfBindings.length === 0) return;
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);

    for (const binding of this._kfBindings) {
      const { effectRef, paramId, slider, display, unit, step, isNumberInput, scrubby, angleDial } = binding;
      const kfs = effectRef.keyframes?.[paramId];
      if (!kfs || kfs.length === 0) continue;
      const val = keyframeEngine.getValueAtFrame(kfs, frame);
      effectRef.params[paramId] = val;
      if (slider) slider.value = val;
      if (angleDial) this._drawAngleDial(angleDial, val);
      if (scrubby) {
        scrubby.setValue(val);
      } else if (display) {
        if (isNumberInput) {
          display.value = parseFloat(val.toFixed(1));
        } else {
          display.textContent = this._formatValue(val, unit, step);
        }
      }
    }
  },

  // -- Keyframe helpers --

  _handleStopwatch(effectRef, paramId, currentValue, stopwatchEl) {
    if (!effectRef.keyframes) effectRef.keyframes = {};
    const kfs = effectRef.keyframes[paramId];

    if (kfs && kfs.length > 0) {
      effectRef.keyframes[paramId] = [];
      stopwatchEl.classList.remove('active');
    } else {
      if (!effectRef.keyframes[paramId]) effectRef.keyframes[paramId] = [];
      const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
      keyframeEngine.addKeyframe(effectRef.keyframes[paramId], frame, currentValue);
      stopwatchEl.classList.add('active');
    }
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    this._render();
  },

  _seekToAdjacentKf(kfs, direction) {
    if (!kfs || kfs.length === 0) return;
    const sorted = [...kfs].sort((a, b) => a.frame - b.frame);
    const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);

    if (direction < 0) {
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (sorted[i].frame < currentFrame) {
          playbackEngine.seek(sorted[i].frame);
          return;
        }
      }
    } else {
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].frame > currentFrame) {
          playbackEngine.seek(sorted[i].frame);
          return;
        }
      }
    }
  },

  _updateKfButtonState(btn, kfArr, frame) {
    const hasKf = kfArr.length > 0;
    const atFrame = kfArr.some(kf => kf.frame === frame);
    btn.classList.toggle('active', hasKf);
    btn.classList.toggle('at-frame', atFrame);
  },

  _formatValue(val, unit, step) {
    if (step >= 1) return `${Math.round(val)}${unit}`;
    return `${parseFloat(val.toFixed(1))}${unit}`;
  },

  // -- DOM helpers --

  _createKeyframeRow({ label, value, unit, min, max, step, hasKf }) {
    const row = document.createElement('div');
    row.className = 'nle-prop-row nle-prop-row--kf';

    const stopwatch = document.createElement('button');
    stopwatch.className = `nle-kf-stopwatch${hasKf ? ' active' : ''}`;
    stopwatch.title = hasKf ? 'Disable keyframing' : 'Enable keyframing';
    stopwatch.innerHTML = '&#9201;';
    row.appendChild(stopwatch);

    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    row.appendChild(labelEl);

    const prevBtn = document.createElement('button');
    prevBtn.className = 'nle-kf-nav-prev';
    prevBtn.title = 'Previous keyframe';
    prevBtn.innerHTML = '&#9664;';
    row.appendChild(prevBtn);

    const kfBtn = document.createElement('button');
    kfBtn.className = `nle-keyframe-btn${hasKf ? ' active' : ''}`;
    kfBtn.title = 'Toggle keyframe';
    row.appendChild(kfBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'nle-kf-nav-next';
    nextBtn.title = 'Next keyframe';
    nextBtn.innerHTML = '&#9654;';
    row.appendChild(nextBtn);

    const slider = document.createElement('input');
    slider.className = 'nle-prop-slider';
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.value = value;
    slider.step = step;
    row.appendChild(slider);

    const valueEl = document.createElement('span');
    valueEl.className = 'nle-prop-value';
    valueEl.textContent = `${step >= 1 ? Math.round(value) : parseFloat(Number(value).toFixed(1))}${unit}`;
    row.appendChild(valueEl);

    return row;
  },

  _createResetButton(onClick) {
    const btn = document.createElement('button');
    btn.className = 'nle-prop-reset-btn';
    btn.title = 'Reset to default';
    btn.innerHTML = '&#x21ba;';
    btn.addEventListener('click', onClick);
    return btn;
  },

  _createSection(title, collapsible = false) {
    const section = document.createElement('div');
    section.className = 'nle-props-section';

    const header = document.createElement('div');
    header.className = 'nle-props-section-header expanded';
    header.innerHTML = `<span>${title}</span>`;
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'nle-props-section-body';
    section.appendChild(body);

    if (collapsible) {
      header.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        const isExpanded = header.classList.toggle('expanded');
        body.classList.toggle('collapsed', !isExpanded);
        // Re-measure row positions after collapse/expand settles
        requestAnimationFrame(() => {
          this._measureRowPositions();
          keyframeTimeline.updateRows(this._rowMetas);
        });
      });
    }

    return { section, body };
  }
};

export default propertiesPanel;

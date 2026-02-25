// Lumetri Color Panel — unified color grading UI
// Singleton module following project conventions
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import { editorState } from '../core/EditorState.js';
import { EDITOR_EVENTS } from '../core/Constants.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { TRACK_TYPES } from '../core/Constants.js';
import { glEffectRenderer } from '../effects/GLEffectRenderer.js';
import { buildCurveLUTTexture, buildHSLCurveLUT } from '../effects/LumetriCurveUtils.js';
import { CurveEditor } from './widgets/CurveEditor.js';
import { ColorWheel } from './widgets/ColorWheel.js';
import { RangeSelector } from './widgets/RangeSelector.js';
import { resolveSelectedClip } from './uiUtils.js';
import { attachScrubby } from './ScrubbyInput.js';
import logger from '../../utils/logger.js';

const EFFECT_ID = 'lumetri-color';

// Section definitions for building UI
const SECTIONS = [
  {
    id: 'basic', title: 'Basic Correction', enableParam: 'basic_enabled',
    params: [
      { header: 'White Balance' },
      { id: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1, default: 0 },
      { id: 'tint', label: 'Tint', min: -100, max: 100, step: 1, default: 0 },
      { header: 'Tone' },
      { id: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01, default: 0 },
      { id: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, default: 0 },
      { id: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, default: 0 },
      { id: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, default: 0 },
      { id: 'whites', label: 'Whites', min: -100, max: 100, step: 1, default: 0 },
      { id: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1, default: 0 },
      { header: '' },
      { id: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1, default: 100 },
      { id: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, default: 0 }
    ]
  },
  {
    id: 'creative', title: 'Creative', enableParam: 'creative_enabled',
    params: [
      { id: 'faded_film', label: 'Faded Film', min: 0, max: 100, step: 1, default: 0 },
      { id: 'creative_sharpen', label: 'Sharpen', min: 0, max: 100, step: 1, default: 0 },
      { id: 'creative_vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, default: 0 },
      { id: 'creative_saturation', label: 'Saturation', min: 0, max: 200, step: 1, default: 100 },
      { id: 'shadow_tint', label: 'Shadow Tint', type: 'color', default: '#808080' },
      { id: 'highlight_tint', label: 'Highlight Tint', type: 'color', default: '#808080' },
      { id: 'tint_balance', label: 'Tint Balance', min: -100, max: 100, step: 1, default: 0 }
    ]
  },
  {
    id: 'curves', title: 'Curves', enableParam: 'curves_enabled',
    custom: 'curves'
  },
  {
    id: 'wheels', title: 'Color Wheels & Match', enableParam: 'wheels_enabled',
    custom: 'wheels'
  },
  {
    id: 'hsl', title: 'HSL Secondary', enableParam: 'hsl_enabled',
    custom: 'hsl'
  },
  {
    id: 'vignette', title: 'Vignette', enableParam: 'vignette_enabled',
    params: [
      { id: 'vignette_amount', label: 'Amount', min: -100, max: 100, step: 1, default: 0 },
      { id: 'vignette_midpoint', label: 'Midpoint', min: 0, max: 100, step: 1, default: 50 },
      { id: 'vignette_roundness', label: 'Roundness', min: 0, max: 100, step: 1, default: 50 },
      { id: 'vignette_feather', label: 'Feather', min: 0, max: 100, step: 1, default: 50 }
    ]
  }
];

export const lumetriColorPanel = {
  _container: null,
  _contentEl: null,
  _clip: null,
  _effectInstance: null,
  _widgets: [],      // CurveEditor, ColorWheel, RangeSelector instances
  _sliderEls: {},    // paramId -> { slider, valueEl }
  _sectionEls: {},   // sectionId -> { el, bodyEl, enableCb }
  _paramToSection: {}, // paramId -> section definition (for auto-enable)
  _updateTimer: null,
  _emitting: false,  // guard against self-notification from TIMELINE_UPDATED

  init(container) {
    this._container = container;
    this._contentEl = document.createElement('div');
    this._contentEl.className = 'nle-lumetri-content';
    container.appendChild(this._contentEl);

    const onClipSelected = () => this._onClipSelected();
    const onClipDeselected = () => this._onClipDeselected();
    const onExternalUpdate = () => {
      // Only sync from external TIMELINE_UPDATED (undo/redo), skip our own emissions
      if (!this._emitting) this._syncFromEffect();
    };

    this._unsubEvents = subscribeEvents({
      [EDITOR_EVENTS.CLIP_SELECTED]: onClipSelected,
      [EDITOR_EVENTS.CLIP_DESELECTED]: onClipDeselected,
      [EDITOR_EVENTS.SELECTION_CHANGED]: onClipSelected,
      [EDITOR_EVENTS.TIMELINE_UPDATED]: onExternalUpdate,
    });

    this._render();
  },

  destroy() {
    if (this._updateTimer) {
      cancelAnimationFrame(this._updateTimer);
      this._updateTimer = null;
    }
    if (this._unsubEvents) this._unsubEvents();
    this._destroyWidgets();
    if (this._contentEl) {
      this._contentEl.remove();
      this._contentEl = null;
    }
  },

  _destroyWidgets() {
    for (const w of this._widgets) {
      if (w && typeof w.destroy === 'function') w.destroy();
    }
    for (const entry of Object.values(this._sliderEls)) {
      if (entry.scrubby) entry.scrubby.destroy();
    }
    this._widgets = [];
    this._sliderEls = {};
    this._sectionEls = {};
    this._paramToSection = {};
  },

  _onClipSelected() {
    const resolved = resolveSelectedClip();
    if (!resolved || resolved.multiSelect) {
      this._clip = null;
      this._effectInstance = null;
      this._render();
      return;
    }

    const { clip } = resolved;

    // Only apply Lumetri to video/image clips, not standalone audio
    const track = timelineEngine.getTrack(clip.trackId);
    if (track && track.type === TRACK_TYPES.AUDIO) {
      this._clip = null;
      this._effectInstance = null;
      this._render();
      return;
    }

    this._clip = clip;
    this._ensureEffect();
    this._render();
  },

  _onClipDeselected() {
    this._clip = null;
    this._effectInstance = null;
    this._render();
  },

  _ensureEffect() {
    if (!this._clip) return;

    // Find existing lumetri-color effect — don't auto-create yet
    const effects = this._clip.effects || [];
    const existing = effects.find(fx => fx.effectId === EFFECT_ID);
    this._effectInstance = existing || null;
  },

  // Lazily create the effect only when the user first modifies a param
  _ensureEffectCreated() {
    if (this._effectInstance) return true;
    if (!this._clip) return false;

    const instance = effectRegistry.createInstance(EFFECT_ID);
    if (!instance) return false;

    if (!this._clip.effects) this._clip.effects = [];
    this._clip.effects.push(instance);
    this._effectInstance = instance;
    return true;
  },

  _getParam(paramId) {
    if (!this._effectInstance) return undefined;
    return this._effectInstance.params[paramId];
  },

  _setParam(paramId, value) {
    if (!this._ensureEffectCreated()) return;
    this._effectInstance.params[paramId] = value;
    this._autoEnableSection(this._paramToSection[paramId]);
    this._scheduleUpdate();
  },

  _setParamImmediate(paramId, value) {
    if (!this._ensureEffectCreated()) return;
    this._effectInstance.params[paramId] = value;
    this._autoEnableSection(this._paramToSection[paramId]);
    this._emitUpdate();
  },

  // Auto-enable a section when the user interacts with any of its controls.
  // The checkbox can still be manually unchecked to disable the section.
  _autoEnableSection(section) {
    if (!section) return;
    if (this._effectInstance && this._effectInstance.params[section.enableParam]) return;
    if (!this._ensureEffectCreated()) return;
    this._effectInstance.params[section.enableParam] = true;
    const sectionEl = this._sectionEls[section.id];
    if (sectionEl) sectionEl.enableCb.checked = true;
  },

  _scheduleUpdate() {
    // Batch updates — emit on next frame
    if (this._updateTimer) return;
    this._updateTimer = requestAnimationFrame(() => {
      this._updateTimer = null;
      this._emitUpdate();
    });
  },

  _emitUpdate() {
    this._rebuildCurveLUTs();
    this._emitting = true;
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    eventBus.emit(EDITOR_EVENTS.LUMETRI_UPDATED);
    this._emitting = false;
  },

  _rebuildCurveLUTs() {
    if (!this._effectInstance) return;
    const p = this._effectInstance.params;
    if (!p.curves_enabled) {
      p._curveLUT = null;
      p._hslCurveLUT = null;
      p._curveLUTData = null;
      p._hslCurveLUTData = null;
      return;
    }

    // Build RGB curve LUT texture + keep raw data for worker transfer
    const curveLUTData = buildCurveLUTTexture(
      p.curve_master, p.curve_red, p.curve_green, p.curve_blue
    );
    p._curveLUT = glEffectRenderer.uploadLUT('nle-lumetri-curve', curveLUTData, 256, 1);
    p._curveLUTData = curveLUTData;

    // Build HSL curve LUT if any HSL curves have points
    const hasHSL = [p.curve_hue_vs_sat, p.curve_hue_vs_hue, p.curve_hue_vs_luma,
      p.curve_luma_vs_sat, p.curve_sat_vs_sat].some(c => c && c.length >= 2);
    if (hasHSL) {
      const hslData = buildHSLCurveLUT(
        p.curve_hue_vs_sat, p.curve_hue_vs_hue, p.curve_hue_vs_luma,
        p.curve_luma_vs_sat, p.curve_sat_vs_sat
      );
      p._hslCurveLUT = glEffectRenderer.uploadLUT('nle-lumetri-hsl-curve', hslData, 256, 5);
      p._hslCurveLUTData = hslData;
    } else {
      p._hslCurveLUT = null;
      p._hslCurveLUTData = null;
    }
  },

  _syncFromEffect() {
    // Full re-render on external updates (undo/redo) to sync all widgets
    if (!this._clip) return;
    this._ensureEffect();
    this._render();
  },

  _render() {
    this._destroyWidgets();
    this._contentEl.innerHTML = '';

    if (!this._clip) {
      const empty = document.createElement('div');
      empty.className = 'nle-lumetri-empty';
      empty.textContent = 'Select a clip to open Lumetri Color';
      this._contentEl.appendChild(empty);
      return;
    }

    // Build each section
    for (const section of SECTIONS) {
      this._buildSection(section);
    }
  },

  _buildSection(section) {
    const el = document.createElement('div');
    el.className = 'nle-lumetri-section';
    const enabled = this._getParam(section.enableParam);
    if (!enabled && section.id !== 'basic') {
      el.classList.add('collapsed');
    }

    // Header
    const header = document.createElement('div');
    header.className = 'nle-lumetri-section-header';

    const toggle = document.createElement('span');
    toggle.className = 'nle-lumetri-section-toggle';
    toggle.textContent = '\u25BC'; // down arrow
    header.appendChild(toggle);

    const enableCb = document.createElement('input');
    enableCb.type = 'checkbox';
    enableCb.className = 'nle-lumetri-section-enable';
    enableCb.checked = !!this._getParam(section.enableParam);
    enableCb.addEventListener('change', (e) => {
      e.stopPropagation();
      this._setParamImmediate(section.enableParam, enableCb.checked);
    });
    header.appendChild(enableCb);

    const title = document.createElement('span');
    title.className = 'nle-lumetri-section-title';
    title.textContent = section.title;
    header.appendChild(title);

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.className = 'nle-lumetri-reset-btn';
    resetBtn.textContent = 'Reset';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._resetSection(section);
    });
    header.appendChild(resetBtn);

    header.addEventListener('click', () => {
      el.classList.toggle('collapsed');
    });

    el.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.className = 'nle-lumetri-section-body';

    if (section.custom) {
      this._buildCustomSection(section, body);
    } else if (section.params) {
      for (const param of section.params) {
        if (param.header !== undefined) {
          if (param.header) {
            const subH = document.createElement('div');
            subH.className = 'nle-lumetri-sub-header';
            subH.textContent = param.header;
            body.appendChild(subH);
          }
          continue;
        }
        this._paramToSection[param.id] = section;
        if (param.type === 'color') {
          this._buildColorRow(body, param);
        } else {
          this._buildSliderRow(body, param);
        }
      }
    }

    el.appendChild(body);
    this._contentEl.appendChild(el);

    this._sectionEls[section.id] = { el, bodyEl: body, enableCb };
  },

  _buildSliderRow(container, param) {
    const row = document.createElement('div');
    row.className = 'nle-lumetri-row';

    const label = document.createElement('span');
    label.className = 'nle-lumetri-row-label';
    label.textContent = param.label;
    row.appendChild(label);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'nle-lumetri-row-slider';
    slider.min = param.min;
    slider.max = param.max;
    slider.step = param.step;
    slider.value = this._getParam(param.id) != null ? this._getParam(param.id) : param.default;
    row.appendChild(slider);

    const valueEl = document.createElement('span');
    valueEl.className = 'nle-lumetri-row-value';
    valueEl.textContent = formatValue(parseFloat(slider.value), param.step);
    row.appendChild(valueEl);

    // Scrubby on value display
    const scrubby = attachScrubby(valueEl, {
      value: parseFloat(slider.value),
      min: param.min, max: param.max, step: param.step,
      formatValue: (v) => formatValue(v, param.step),
      onChange: (val) => {
        slider.value = val;
        this._setParam(param.id, val);
      },
      onCommit: (val) => {
        slider.value = val;
        this._setParamImmediate(param.id, val);
      }
    });

    // Live update on input (batched)
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      scrubby.setValue(val);
      this._setParam(param.id, val);
    });

    // Final commit on mouseup
    slider.addEventListener('change', () => {
      const val = parseFloat(slider.value);
      this._setParamImmediate(param.id, val);
    });

    // Double-click to reset
    slider.addEventListener('dblclick', () => {
      slider.value = param.default;
      scrubby.setValue(param.default);
      this._setParamImmediate(param.id, param.default);
    });

    container.appendChild(row);
    this._sliderEls[param.id] = { slider, valueEl, step: param.step, scrubby };
  },

  _buildColorRow(container, param) {
    const row = document.createElement('div');
    row.className = 'nle-lumetri-row';

    const label = document.createElement('span');
    label.className = 'nle-lumetri-row-label';
    label.textContent = param.label;
    row.appendChild(label);

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'nle-lumetri-color-input';
    colorInput.value = this._getParam(param.id) || param.default;
    colorInput.addEventListener('input', () => {
      this._setParam(param.id, colorInput.value);
    });
    colorInput.addEventListener('change', () => {
      this._setParamImmediate(param.id, colorInput.value);
    });
    row.appendChild(colorInput);

    container.appendChild(row);
  },

  _buildCustomSection(section, body) {
    switch (section.custom) {
      case 'curves':
        this._buildCurvesSection(section, body);
        break;
      case 'wheels':
        this._buildWheelsSection(section, body);
        break;
      case 'hsl':
        this._buildHSLSection(section, body);
        break;
    }
  },

  _buildCurvesSection(section, body) {
    // Register all curve params for auto-enable
    for (const id of ['curve_master', 'curve_red', 'curve_green', 'curve_blue',
      'curve_hue_vs_sat', 'curve_hue_vs_hue', 'curve_hue_vs_luma', 'curve_luma_vs_sat', 'curve_sat_vs_sat']) {
      this._paramToSection[id] = section;
    }

    // RGB curves
    const rgbEditor = new CurveEditor(body, {
      channels: ['master', 'red', 'green', 'blue'],
      width: 256,
      height: 256,
      onChange: (channel, points) => {
        const paramMap = {
          master: 'curve_master',
          red: 'curve_red',
          green: 'curve_green',
          blue: 'curve_blue'
        };
        if (paramMap[channel]) {
          this._setParamImmediate(paramMap[channel], points);
        }
      }
    });

    // Set initial points
    rgbEditor.setPoints('master', this._getParam('curve_master'));
    rgbEditor.setPoints('red', this._getParam('curve_red'));
    rgbEditor.setPoints('green', this._getParam('curve_green'));
    rgbEditor.setPoints('blue', this._getParam('curve_blue'));
    this._widgets.push(rgbEditor);

    // HSL curves
    const hslHeader = document.createElement('div');
    hslHeader.className = 'nle-lumetri-sub-header';
    hslHeader.textContent = 'HSL Curves';
    body.appendChild(hslHeader);

    const hslChannels = ['hueVsSat', 'hueVsHue', 'hueVsLuma', 'lumaVsSat', 'satVsSat'];
    const hslParamMap = {
      hueVsSat: 'curve_hue_vs_sat',
      hueVsHue: 'curve_hue_vs_hue',
      hueVsLuma: 'curve_hue_vs_luma',
      lumaVsSat: 'curve_luma_vs_sat',
      satVsSat: 'curve_sat_vs_sat'
    };

    const hslEditor = new CurveEditor(body, {
      channels: hslChannels,
      width: 256,
      height: 256,
      onChange: (channel, points) => {
        if (hslParamMap[channel]) {
          this._setParamImmediate(hslParamMap[channel], points);
        }
      }
    });

    for (const ch of hslChannels) {
      const pts = this._getParam(hslParamMap[ch]);
      if (pts && pts.length >= 2) {
        hslEditor.setPoints(ch, pts);
      }
    }
    this._widgets.push(hslEditor);
  },

  _buildWheelsSection(section, body) {
    const wheelsContainer = document.createElement('div');
    wheelsContainer.className = 'nle-lumetri-wheels-container';

    const wheelDefs = [
      { label: 'Shadows', hueParam: 'shadow_hue', satParam: 'shadow_sat', lumaParam: 'shadow_luma' },
      { label: 'Midtones', hueParam: 'midtone_hue', satParam: 'midtone_sat', lumaParam: 'midtone_luma' },
      { label: 'Highlights', hueParam: 'highlight_hue', satParam: 'highlight_sat', lumaParam: 'highlight_luma' }
    ];

    for (const def of wheelDefs) {
      const wheel = new ColorWheel(wheelsContainer, {
        label: def.label,
        onChange: (hue, sat, luma) => {
          if (!this._ensureEffectCreated()) return;
          this._effectInstance.params[def.hueParam] = hue;
          this._effectInstance.params[def.satParam] = sat;
          this._effectInstance.params[def.lumaParam] = luma;
          this._autoEnableSection(section);
          this._scheduleUpdate();
        }
      });

      wheel.setValues(
        this._getParam(def.hueParam) || 0,
        this._getParam(def.satParam) || 0,
        this._getParam(def.lumaParam) || 0
      );
      this._widgets.push(wheel);
    }

    body.appendChild(wheelsContainer);
  },

  _buildHSLSection(section, body) {
    // Register slider params for auto-enable (range selectors handled via explicit callbacks below)
    for (const id of ['hsl_hue_center', 'hsl_hue_range', 'hsl_sat_center', 'hsl_sat_range',
      'hsl_luma_center', 'hsl_luma_range', 'hsl_denoise', 'hsl_temperature', 'hsl_tint',
      'hsl_contrast', 'hsl_sharpen', 'hsl_saturation', 'hsl_show_mask']) {
      this._paramToSection[id] = section;
    }

    // Hue range selector
    const hueSelector = new RangeSelector(body, {
      label: 'Hue',
      gradient: 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)',
      min: 0,
      max: 360,
      center: this._getParam('hsl_hue_center') || 0,
      range: this._getParam('hsl_hue_range') || 30,
      onChange: (center, range) => {
        if (!this._ensureEffectCreated()) return;
        this._effectInstance.params.hsl_hue_center = center;
        this._effectInstance.params.hsl_hue_range = range;
        this._autoEnableSection(section);
        this._scheduleUpdate();
      }
    });
    this._widgets.push(hueSelector);

    // Saturation range selector
    const satSelector = new RangeSelector(body, {
      label: 'Saturation',
      gradient: 'linear-gradient(to right, #888, #ff4444)',
      min: 0,
      max: 100,
      center: this._getParam('hsl_sat_center') || 50,
      range: this._getParam('hsl_sat_range') || 50,
      onChange: (center, range) => {
        if (!this._ensureEffectCreated()) return;
        this._effectInstance.params.hsl_sat_center = center;
        this._effectInstance.params.hsl_sat_range = range;
        this._autoEnableSection(section);
        this._scheduleUpdate();
      }
    });
    this._widgets.push(satSelector);

    // Luminance range selector
    const lumaSelector = new RangeSelector(body, {
      label: 'Luminance',
      gradient: 'linear-gradient(to right, #000, #fff)',
      min: 0,
      max: 100,
      center: this._getParam('hsl_luma_center') || 50,
      range: this._getParam('hsl_luma_range') || 50,
      onChange: (center, range) => {
        if (!this._ensureEffectCreated()) return;
        this._effectInstance.params.hsl_luma_center = center;
        this._effectInstance.params.hsl_luma_range = range;
        this._autoEnableSection(section);
        this._scheduleUpdate();
      }
    });
    this._widgets.push(lumaSelector);

    // Denoise slider
    this._buildSliderRow(body, {
      id: 'hsl_denoise', label: 'Denoise', min: 0, max: 100, step: 1, default: 10
    });

    // Correction sub-header
    const corrHeader = document.createElement('div');
    corrHeader.className = 'nle-lumetri-sub-header';
    corrHeader.textContent = 'Correction';
    body.appendChild(corrHeader);

    // Correction sliders
    const corrParams = [
      { id: 'hsl_temperature', label: 'Temperature', min: -100, max: 100, step: 1, default: 0 },
      { id: 'hsl_tint', label: 'Tint', min: -100, max: 100, step: 1, default: 0 },
      { id: 'hsl_contrast', label: 'Contrast', min: -100, max: 100, step: 1, default: 0 },
      { id: 'hsl_sharpen', label: 'Sharpen', min: 0, max: 100, step: 1, default: 0 },
      { id: 'hsl_saturation', label: 'Saturation', min: 0, max: 200, step: 1, default: 100 }
    ];

    for (const param of corrParams) {
      this._buildSliderRow(body, param);
    }

    // Show Mask toggle
    const maskRow = document.createElement('div');
    maskRow.className = 'nle-lumetri-checkbox-row';
    const maskCb = document.createElement('input');
    maskCb.type = 'checkbox';
    maskCb.id = 'nle-lumetri-show-mask';
    maskCb.checked = !!this._getParam('hsl_show_mask');
    maskCb.addEventListener('change', () => {
      this._setParamImmediate('hsl_show_mask', maskCb.checked);
    });
    const maskLabel = document.createElement('label');
    maskLabel.htmlFor = 'nle-lumetri-show-mask';
    maskLabel.textContent = 'Show Mask';
    maskRow.appendChild(maskCb);
    maskRow.appendChild(maskLabel);
    body.appendChild(maskRow);
  },

  _resetSection(section) {
    if (!this._effectInstance) return;
    const def = effectRegistry.get(EFFECT_ID);
    if (!def) return;

    // Reset all params in this section to defaults
    const sectionParamIds = new Set();
    if (section.params) {
      for (const p of section.params) {
        if (p.id) sectionParamIds.add(p.id);
      }
    }
    // Also add custom section params
    if (section.custom === 'curves') {
      sectionParamIds.add('curve_master');
      sectionParamIds.add('curve_red');
      sectionParamIds.add('curve_green');
      sectionParamIds.add('curve_blue');
      sectionParamIds.add('curve_hue_vs_sat');
      sectionParamIds.add('curve_hue_vs_hue');
      sectionParamIds.add('curve_hue_vs_luma');
      sectionParamIds.add('curve_luma_vs_sat');
      sectionParamIds.add('curve_sat_vs_sat');
    } else if (section.custom === 'wheels') {
      for (const prefix of ['shadow', 'midtone', 'highlight']) {
        sectionParamIds.add(`${prefix}_hue`);
        sectionParamIds.add(`${prefix}_sat`);
        sectionParamIds.add(`${prefix}_luma`);
      }
    } else if (section.custom === 'hsl') {
      for (const id of ['hsl_hue_center', 'hsl_hue_range', 'hsl_sat_center', 'hsl_sat_range',
        'hsl_luma_center', 'hsl_luma_range', 'hsl_denoise', 'hsl_temperature', 'hsl_tint',
        'hsl_contrast', 'hsl_sharpen', 'hsl_saturation', 'hsl_show_mask']) {
        sectionParamIds.add(id);
      }
    }

    // Find defaults from effect definition
    for (const paramDef of def.params) {
      if (sectionParamIds.has(paramDef.id)) {
        this._effectInstance.params[paramDef.id] = Array.isArray(paramDef.default)
          ? JSON.parse(JSON.stringify(paramDef.default))
          : paramDef.default;
      }
    }

    this._emitUpdate();
    this._render(); // Re-render to update all UI
  }
};

function formatValue(val, step) {
  if (step != null && step < 1) {
    return val.toFixed(2);
  }
  return Math.round(val).toString();
}

export default lumetriColorPanel;

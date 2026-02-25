// Essential Audio Panel — Premiere-style clip-type-based audio workflow
// Singleton module. Assigns audio clip types (Dialogue/Music/SFX/Ambience)
// and shows type-specific processing controls that map to the essential-audio compound effect.
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import { editorState } from '../core/EditorState.js';
import { EDITOR_EVENTS, TRACK_TYPES, STATE_PATHS } from '../core/Constants.js';
import { effectRegistry } from '../effects/EffectRegistry.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { resolveSelectedClip } from './uiUtils.js';
import { attachScrubby } from './ScrubbyInput.js';
import { EFFECT_ID, DEFAULT_PARAMS, REVERB_PRESETS, EQ_CLARITY_PRESETS } from '../effects/EssentialAudioEffect.js';
import { clamp } from '../core/MathUtils.js';
import { mediaManager } from '../media/MediaManager.js';
import { getClipDuration } from '../timeline/Clip.js';
import { frameToSeconds } from '../timeline/TimelineMath.js';
import logger from '../../utils/logger.js';

const AUDIO_TYPES = ['dialogue', 'music', 'sfx', 'ambience'];

// Which sections are visible per audio type
const SECTIONS_FOR_TYPE = {
  dialogue: ['loudness', 'repair', 'clarity', 'creative-reverb', 'eq', 'clip-volume'],
  music: ['loudness', 'ducking', 'eq', 'clip-volume'],
  sfx: ['loudness', 'creative-reverb', 'pan', 'eq', 'clip-volume'],
  ambience: ['loudness', 'ducking', 'creative-reverb', 'stereo-width', 'eq', 'clip-volume'],
};

// Reverb presets per type
const REVERB_PRESETS_FOR_TYPE = {
  dialogue: ['none', 'auditorium', 'church', 'large-reflective', 'outside-club', 'warm-room', 'warm-voice', 'thicken-voice'],
  sfx: ['none', 'heavy', 'light', 'outside', 'room'],
  ambience: ['none', 'large-room-amb', 'outside-amb', 'room-amb', 'wind-effect'],
};

// Top-level presets per audio type (Premiere-style)
const TYPE_PRESETS = {
  dialogue: {
    'None': null,
    'Balanced Male Voice': { repair_noise: 3, repair_rumble: 4, repair_dehum: 2, clarity_dynamics: 4, clarity_eq_preset: 'male-voice', clarity_eq_amount: 6, loudness_enabled: true, loudness_target: -23 },
    'Balanced Female Voice': { repair_noise: 3, repair_rumble: 3, repair_dehum: 2, clarity_dynamics: 4, clarity_eq_preset: 'female-voice', clarity_eq_amount: 6, loudness_enabled: true, loudness_target: -23 },
    'Podcast Voice': { repair_noise: 5, repair_rumble: 5, repair_deess: 4, clarity_dynamics: 6, clarity_eq_preset: 'podcast', clarity_eq_amount: 7, loudness_enabled: true, loudness_target: -16 },
    'Noisy Dialogue': { repair_noise: 7, repair_rumble: 5, repair_dehum: 4, repair_reverb: 3, clarity_dynamics: 5, clarity_eq_preset: 'broadcast', clarity_eq_amount: 5, loudness_enabled: true, loudness_target: -23 },
  },
  music: {
    'None': null,
    'Background Music': { loudness_enabled: true, loudness_target: -25, duck_enabled: true, duck_against_dialogue: true, duck_amount: -12, duck_fades: 800 },
    'Prominent Music': { loudness_enabled: true, loudness_target: -20, duck_enabled: true, duck_against_dialogue: true, duck_amount: -4, duck_fades: 500 },
    'Music Only': { loudness_enabled: true, loudness_target: -14 },
  },
  sfx: {
    'None': null,
    'Subtle SFX': { loudness_enabled: true, loudness_target: -24, creative_reverb_preset: 'light', creative_reverb: 15 },
    'Prominent SFX': { loudness_enabled: true, loudness_target: -18, creative_reverb_preset: 'room', creative_reverb: 10 },
    'Heavy SFX': { loudness_enabled: true, loudness_target: -14, creative_reverb_preset: 'heavy', creative_reverb: 25 },
  },
  ambience: {
    'None': null,
    'Subtle Ambience': { loudness_enabled: true, loudness_target: -30, creative_stereo_width: 130, duck_enabled: true, duck_against_dialogue: true, duck_amount: -8 },
    'Spacious Ambience': { loudness_enabled: true, loudness_target: -26, creative_stereo_width: 170, creative_reverb_preset: 'large-room-amb', creative_reverb: 20 },
    'Outdoor Ambience': { loudness_enabled: true, loudness_target: -28, creative_stereo_width: 150, creative_reverb_preset: 'outside-amb', creative_reverb: 15 },
  }
};

function formatValue(v, step) {
  if (step < 1) return v.toFixed(Math.min(2, String(step).split('.')[1]?.length || 1));
  return String(Math.round(v));
}

export const essentialAudioPanel = {
  _container: null,
  _contentEl: null,
  _clip: null,
  _effectInstance: null,
  _sectionEls: {},
  _sliderEls: {},
  _typeButtons: {},
  _unsubEvents: null,
  _updateTimer: null,
  _emitting: false,

  init(container) {
    this._container = container;
    this._contentEl = document.createElement('div');
    this._contentEl.className = 'nle-ea-content';
    container.appendChild(this._contentEl);

    const onClipChange = () => this._onClipSelected();
    const onExternal = () => { if (!this._emitting) this._syncFromEffect(); };

    this._unsubEvents = subscribeEvents({
      [EDITOR_EVENTS.CLIP_SELECTED]: onClipChange,
      [EDITOR_EVENTS.CLIP_DESELECTED]: () => this._onClipDeselected(),
      [EDITOR_EVENTS.SELECTION_CHANGED]: onClipChange,
      [EDITOR_EVENTS.TIMELINE_UPDATED]: onExternal,
    });

    this._render();
  },

  destroy() {
    if (this._unsubEvents) this._unsubEvents();
    if (this._updateTimer) cancelAnimationFrame(this._updateTimer);
    this._destroyWidgets();
    this._container = null;
    this._contentEl = null;
  },

  _destroyWidgets() {
    for (const entry of Object.values(this._sliderEls)) {
      if (entry.scrubby) entry.scrubby.destroy();
    }
    this._sliderEls = {};
    this._sectionEls = {};
    this._typeButtons = {};
  },

  // ── Clip Selection ──

  _onClipSelected() {
    const resolved = resolveSelectedClip();
    if (!resolved || resolved.multiSelect) {
      this._clip = null;
      this._effectInstance = null;
      this._render();
      return;
    }
    const { clip } = resolved;
    // Only show for audio clips or linked audio of video clips
    const track = timelineEngine.getTrack(clip.trackId);
    if (track && track.type === TRACK_TYPES.AUDIO) {
      this._clip = clip;
    } else if (clip.linkedClipId) {
      const linked = timelineEngine.getClip(clip.linkedClipId);
      const linkedTrack = linked ? timelineEngine.getTrack(linked.trackId) : null;
      this._clip = (linkedTrack && linkedTrack.type === TRACK_TYPES.AUDIO) ? linked : null;
    } else {
      this._clip = null;
    }
    this._ensureEffect();
    this._render();
  },

  _onClipDeselected() {
    this._clip = null;
    this._effectInstance = null;
    this._render();
  },

  _ensureEffect() {
    if (!this._clip) { this._effectInstance = null; return; }
    const fx = (this._clip.effects || []).find(f => f.effectId === EFFECT_ID);
    this._effectInstance = fx || null;
  },

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

  // ── Param Access ──

  _getParam(id) {
    if (!this._effectInstance) return DEFAULT_PARAMS[id];
    return this._effectInstance.params[id] ?? DEFAULT_PARAMS[id];
  },

  _setParam(id, value) {
    if (!this._ensureEffectCreated()) return;
    this._effectInstance.params[id] = value;
    this._scheduleUpdate();
  },

  _setParamImmediate(id, value) {
    if (!this._ensureEffectCreated()) return;
    this._effectInstance.params[id] = value;
    this._emitUpdate();
  },

  _scheduleUpdate() {
    if (this._updateTimer) return;
    this._updateTimer = requestAnimationFrame(() => {
      this._updateTimer = null;
      this._emitUpdate();
    });
  },

  _emitUpdate() {
    this._emitting = true;
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    this._emitting = false;
  },

  _syncFromEffect() {
    if (!this._clip) return;
    this._ensureEffect();
    this._render();
  },

  // ── Audio Type ──

  _getAudioType() {
    return this._clip?.audioType || 'unassigned';
  },

  _setAudioType(type) {
    if (!this._clip) return;
    this._clip.audioType = type;
    // Auto-set loudness target per type (Premiere defaults)
    if (type === 'dialogue') this._setParamImmediate('loudness_target', -23);
    else if (type === 'music') this._setParamImmediate('loudness_target', -25);
    else if (type === 'sfx') this._setParamImmediate('loudness_target', -21);
    else if (type === 'ambience') this._setParamImmediate('loudness_target', -30);
    this._render();
    this._emitUpdate();
  },

  // ── Rendering ──

  _render() {
    if (!this._contentEl) return;
    this._destroyWidgets();
    this._contentEl.innerHTML = '';

    if (!this._clip) {
      this._contentEl.innerHTML = `
        <div class="nle-ea-placeholder">
          <div class="nle-ea-placeholder-icons">
            <div class="nle-ea-placeholder-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg></div>
            <div class="nle-ea-placeholder-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
            <div class="nle-ea-placeholder-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg></div>
            <div class="nle-ea-placeholder-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><path d="M8 12c0-2 1.5-4 4-4M12 20c-2 0-4-1.5-4-4"/></svg></div>
          </div>
          <span>Select an audio clip to edit</span>
        </div>`;
      return;
    }

    const type = this._getAudioType();

    // Header bar with "Edit:" label + clip name (Premiere style)
    const header = document.createElement('div');
    header.className = 'nle-ea-header';
    const editLabel = document.createElement('div');
    editLabel.className = 'nle-ea-edit-label';
    editLabel.textContent = 'Edit';
    const nameEl = document.createElement('div');
    nameEl.className = 'nle-ea-clip-name';
    nameEl.textContent = this._clip.name || 'Audio Clip';
    header.appendChild(editLabel);
    header.appendChild(nameEl);
    this._contentEl.appendChild(header);

    // Type selector
    this._buildTypeSelector(type);

    if (type === 'unassigned') return;

    // Top-level preset dropdown
    const presets = TYPE_PRESETS[type];
    if (presets) {
      const presetRow = document.createElement('div');
      presetRow.className = 'nle-ea-preset-row';
      const presetLabel = document.createElement('span');
      presetLabel.className = 'nle-ea-row-label';
      presetLabel.textContent = 'Preset';
      presetRow.appendChild(presetLabel);
      const presetSel = document.createElement('select');
      presetSel.className = 'nle-ea-select';
      for (const name of Object.keys(presets)) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        presetSel.appendChild(o);
      }
      presetSel.addEventListener('change', () => {
        const preset = presets[presetSel.value];
        if (preset) {
          this._applyPreset(preset);
        }
      });
      presetRow.appendChild(presetSel);
      this._contentEl.appendChild(presetRow);
    }

    // Build visible sections for this type
    const sections = SECTIONS_FOR_TYPE[type] || [];
    for (const sec of sections) {
      switch (sec) {
        case 'loudness': this._buildLoudnessSection(); break;
        case 'repair': this._buildRepairSection(); break;
        case 'clarity': this._buildClaritySection(); break;
        case 'ducking': this._buildDuckingSection(); break;
        case 'creative-reverb': this._buildCreativeReverbSection(); break;
        case 'stereo-width': this._buildStereoWidthSection(); break;
        case 'pan': this._buildPanSection(); break;
        case 'eq': this._buildEQSection(); break;
        case 'clip-volume': this._buildClipVolumeSection(); break;
      }
    }
  },

  // ── Type Selector ──

  _buildTypeSelector(currentType) {
    const TYPE_SVGS = {
      dialogue: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>',
      music: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      sfx: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>',
      ambience: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 18c0-3.87 3.13-7 7-7h4c3.87 0 7 3.13 7 7"/><path d="M7 14c0-2.76 2.24-5 5-5s5 2.24 5 5"/><circle cx="12" cy="14" r="2"/><path d="M5 21h14"/></svg>'
    };
    const wrapper = document.createElement('div');
    wrapper.className = 'nle-ea-type-selector';

    for (const t of AUDIO_TYPES) {
      const btn = document.createElement('button');
      btn.className = 'nle-ea-type-btn';
      if (t === currentType) btn.classList.add('active');
      const icon = document.createElement('span');
      icon.className = 'nle-ea-type-icon';
      icon.innerHTML = TYPE_SVGS[t] || '';
      const label = document.createElement('span');
      label.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      btn.appendChild(icon);
      btn.appendChild(label);
      btn.addEventListener('click', () => this._setAudioType(t));
      wrapper.appendChild(btn);
      this._typeButtons[t] = btn;
    }
    this._contentEl.appendChild(wrapper);
  },

  // ── Section Builder Helpers ──

  _buildSection(id, title, enableParamId, buildBody) {
    const el = document.createElement('div');
    el.className = 'nle-ea-section';

    const header = document.createElement('div');
    header.className = 'nle-ea-section-header';

    const toggle = document.createElement('span');
    toggle.className = 'nle-ea-section-toggle';
    toggle.textContent = '\u25BC';

    const enableCb = document.createElement('input');
    enableCb.type = 'checkbox';
    enableCb.className = 'nle-ea-section-enable';
    if (enableParamId) {
      enableCb.checked = !!this._getParam(enableParamId);
      enableCb.addEventListener('change', (e) => {
        e.stopPropagation();
        this._setParamImmediate(enableParamId, enableCb.checked);
      });
    } else {
      enableCb.checked = true;
      enableCb.disabled = true;
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'nle-ea-section-title';
    titleEl.textContent = title;

    const resetBtn = document.createElement('button');
    resetBtn.className = 'nle-ea-section-reset';
    resetBtn.title = 'Reset to defaults';
    resetBtn.textContent = '\u21BA';
    resetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._resetSection(id);
    });

    header.appendChild(toggle);
    header.appendChild(enableCb);
    header.appendChild(titleEl);
    header.appendChild(resetBtn);

    header.addEventListener('click', () => {
      el.classList.toggle('collapsed');
      toggle.textContent = el.classList.contains('collapsed') ? '\u25B6' : '\u25BC';
    });

    const body = document.createElement('div');
    body.className = 'nle-ea-section-body';
    buildBody(body);

    el.appendChild(header);
    el.appendChild(body);
    this._contentEl.appendChild(el);
    this._sectionEls[id] = { el, body, enableCb };
  },

  _buildSliderRow(container, paramId, label, min, max, step, unit, defaultVal) {
    const row = document.createElement('div');
    row.className = 'nle-ea-row';

    const lbl = document.createElement('span');
    lbl.className = 'nle-ea-row-label';
    lbl.textContent = label;
    row.appendChild(lbl);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min; slider.max = max; slider.step = step;
    slider.value = this._getParam(paramId) ?? defaultVal;
    row.appendChild(slider);

    const valueEl = document.createElement('span');
    valueEl.className = 'nle-ea-row-value';
    valueEl.textContent = formatValue(parseFloat(slider.value), step) + (unit ? ` ${unit}` : '');
    row.appendChild(valueEl);

    const scrubby = attachScrubby(valueEl, {
      value: parseFloat(slider.value),
      min, max, step,
      formatValue: (v) => formatValue(v, step) + (unit ? ` ${unit}` : ''),
      onChange: (val) => { slider.value = val; this._setParam(paramId, val); },
      onCommit: (val) => { slider.value = val; this._setParamImmediate(paramId, val); }
    });

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      scrubby.setValue(val);
      valueEl.textContent = formatValue(val, step) + (unit ? ` ${unit}` : '');
      this._setParam(paramId, val);
    });
    slider.addEventListener('change', () => {
      this._setParamImmediate(paramId, parseFloat(slider.value));
    });
    slider.addEventListener('dblclick', () => {
      slider.value = defaultVal;
      scrubby.setValue(defaultVal);
      valueEl.textContent = formatValue(defaultVal, step) + (unit ? ` ${unit}` : '');
      this._setParamImmediate(paramId, defaultVal);
    });

    container.appendChild(row);
    this._sliderEls[paramId] = { slider, valueEl, scrubby, step };
  },

  _buildCheckboxRow(container, paramId, label) {
    const row = document.createElement('div');
    row.className = 'nle-ea-row ea-row-checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!this._getParam(paramId);
    cb.addEventListener('change', () => this._setParamImmediate(paramId, cb.checked));
    const lbl = document.createElement('label');
    lbl.textContent = label;
    lbl.prepend(cb);
    row.appendChild(lbl);
    container.appendChild(row);
  },

  _buildDropdownRow(container, paramId, label, options) {
    const row = document.createElement('div');
    row.className = 'nle-ea-row';
    const lbl = document.createElement('span');
    lbl.className = 'nle-ea-row-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    const sel = document.createElement('select');
    sel.className = 'nle-ea-select';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      if (opt === 'none') o.textContent = 'None';
      sel.appendChild(o);
    }
    sel.value = this._getParam(paramId) || options[0];
    sel.addEventListener('change', () => this._setParamImmediate(paramId, sel.value));
    row.appendChild(sel);
    container.appendChild(row);
  },

  // ── Section Builders ──

  _buildLoudnessSection() {
    this._buildSection('loudness', 'Loudness', 'loudness_enabled', (body) => {
      this._buildSliderRow(body, 'loudness_target', 'Target', -40, 0, 1, 'LUFS', -23);
      this._buildSliderRow(body, 'loudness_gain', 'Gain', -40, 40, 0.5, 'dB', 0);

      const matchBtn = document.createElement('button');
      matchBtn.className = 'nle-ea-btn';
      matchBtn.textContent = 'Auto Match';
      matchBtn.addEventListener('click', () => this._autoMatchLoudness());
      body.appendChild(matchBtn);
    });
  },

  _buildRepairSection() {
    this._buildSection('repair', 'Repair', null, (body) => {
      this._buildSliderRow(body, 'repair_noise', 'Reduce Noise', 0, 10, 1, '', 0);
      this._buildSliderRow(body, 'repair_rumble', 'Reduce Rumble', 0, 10, 1, '', 0);
      this._buildSliderRow(body, 'repair_dehum', 'DeHum', 0, 10, 1, '', 0);

      // DeHum frequency radio
      const freqRow = document.createElement('div');
      freqRow.className = 'nle-ea-row ea-row-radio';
      for (const freq of [50, 60]) {
        const lbl = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio'; radio.name = 'dehum-freq';
        radio.value = freq;
        radio.checked = (this._getParam('repair_dehum_freq') || 60) === freq;
        radio.addEventListener('change', () => this._setParamImmediate('repair_dehum_freq', freq));
        lbl.appendChild(radio);
        lbl.append(` ${freq} Hz`);
        freqRow.appendChild(lbl);
      }
      body.appendChild(freqRow);

      this._buildSliderRow(body, 'repair_deess', 'DeEss', 0, 10, 1, '', 0);
      this._buildSliderRow(body, 'repair_reverb', 'Reduce Reverb', 0, 10, 1, '', 0);
    });
  },

  _buildClaritySection() {
    this._buildSection('clarity', 'Clarity', null, (body) => {
      this._buildSliderRow(body, 'clarity_dynamics', 'Dynamics', 0, 10, 1, '', 0);
      this._buildDropdownRow(body, 'clarity_eq_preset', 'EQ Preset',
        Object.keys(EQ_CLARITY_PRESETS));
      this._buildSliderRow(body, 'clarity_eq_amount', 'EQ Amount', 0, 10, 1, '', 0);
      this._buildCheckboxRow(body, 'clarity_enhance', 'Enhance Speech');
      this._buildDropdownRow(body, 'clarity_enhance_tone', 'Tone', ['high', 'low']);
    });
  },

  _buildDuckingSection() {
    this._buildSection('ducking', 'Ducking', 'duck_enabled', (body) => {
      this._buildCheckboxRow(body, 'duck_against_dialogue', 'Duck against Dialogue');
      this._buildCheckboxRow(body, 'duck_against_sfx', 'Duck against SFX');
      this._buildCheckboxRow(body, 'duck_against_ambience', 'Duck against Ambience');
      this._buildCheckboxRow(body, 'duck_against_untagged', 'Duck against Untagged');
      this._buildSliderRow(body, 'duck_sensitivity', 'Sensitivity', 1, 10, 1, '', 5);
      this._buildSliderRow(body, 'duck_amount', 'Duck Amount', -30, 0, 1, 'dB', -6);
      this._buildSliderRow(body, 'duck_fades', 'Fades', 50, 3000, 50, 'ms', 500);
      this._buildDropdownRow(body, 'duck_fade_position', 'Fade Position',
        ['outside', 'inside', 'center']);

      const genBtn = document.createElement('button');
      genBtn.className = 'nle-ea-btn';
      genBtn.textContent = 'Generate Keyframes';
      genBtn.addEventListener('click', () => this._generateDuckKeyframes());
      body.appendChild(genBtn);
    });
  },

  _buildCreativeReverbSection() {
    const type = this._getAudioType();
    const presets = REVERB_PRESETS_FOR_TYPE[type] || ['none'];
    this._buildSection('creative-reverb', 'Reverb', null, (body) => {
      this._buildDropdownRow(body, 'creative_reverb_preset', 'Preset', presets);
      this._buildSliderRow(body, 'creative_reverb', 'Amount', 0, 100, 1, '%', 0);
      this._buildSliderRow(body, 'creative_reverb_decay', 'Decay', 0.1, 10, 0.1, 's', 1.5);
    });
  },

  _buildStereoWidthSection() {
    this._buildSection('stereo-width', 'Stereo Width', null, (body) => {
      this._buildSliderRow(body, 'creative_stereo_width', 'Width', 0, 200, 1, '%', 100);
    });
  },

  _buildPanSection() {
    this._buildSection('pan', 'Pan', null, (body) => {
      this._buildSliderRow(body, 'creative_pan', 'Pan', -100, 100, 1, '', 0);
    });
  },

  _buildEQSection() {
    this._buildSection('eq', 'Parametric EQ', 'eq_enabled', (body) => {
      // EQ canvas (frequency response curve)
      const canvas = document.createElement('canvas');
      canvas.className = 'nle-ea-eq-canvas';
      canvas.width = 260; canvas.height = 100;
      body.appendChild(canvas);
      this._drawEQCurve(canvas);
      this._makeEQDraggable(canvas);

      this._buildSliderRow(body, 'eq_lp_freq', 'Low Shelf Freq', 20, 500, 5, 'Hz', 200);
      this._buildSliderRow(body, 'eq_lp_gain', 'Low Shelf Gain', -12, 12, 0.5, 'dB', 0);
      this._buildSliderRow(body, 'eq_m1_freq', 'Mid 1 Freq', 100, 2000, 10, 'Hz', 500);
      this._buildSliderRow(body, 'eq_m1_gain', 'Mid 1 Gain', -12, 12, 0.5, 'dB', 0);
      this._buildSliderRow(body, 'eq_m2_freq', 'Mid 2 Freq', 500, 8000, 50, 'Hz', 2000);
      this._buildSliderRow(body, 'eq_m2_gain', 'Mid 2 Gain', -12, 12, 0.5, 'dB', 0);
      this._buildSliderRow(body, 'eq_m3_freq', 'Mid 3 Freq', 1000, 16000, 100, 'Hz', 5000);
      this._buildSliderRow(body, 'eq_m3_gain', 'Mid 3 Gain', -12, 12, 0.5, 'dB', 0);
      this._buildSliderRow(body, 'eq_hp_freq', 'High Shelf Freq', 2000, 20000, 100, 'Hz', 8000);
      this._buildSliderRow(body, 'eq_hp_gain', 'High Shelf Gain', -12, 12, 0.5, 'dB', 0);
    });
  },

  _buildClipVolumeSection() {
    this._buildSection('clip-volume', 'Clip Volume', null, (body) => {
      // Read from intrinsic volume effect
      const volFx = this._clip?.effects?.find(f => f.id === 'intrinsic-volume');
      const gain = volFx ? volFx.params.gain : 100;

      const row = document.createElement('div');
      row.className = 'nle-ea-row';
      const lbl = document.createElement('span');
      lbl.className = 'nle-ea-row-label';
      lbl.textContent = 'Volume';
      row.appendChild(lbl);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = 0; slider.max = 200; slider.step = 1;
      slider.value = gain;
      row.appendChild(slider);

      const valueEl = document.createElement('span');
      valueEl.className = 'nle-ea-row-value';
      valueEl.textContent = `${Math.round(gain)}%`;
      row.appendChild(valueEl);

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        valueEl.textContent = `${Math.round(val)}%`;
        if (volFx) volFx.params.gain = val;
        this._scheduleUpdate();
      });
      slider.addEventListener('change', () => {
        if (volFx) volFx.params.gain = parseFloat(slider.value);
        this._emitUpdate();
      });

      const muteBtn = document.createElement('button');
      muteBtn.className = 'nle-ea-btn ea-mute-btn';
      muteBtn.textContent = gain === 0 ? 'Unmute' : 'Mute';
      muteBtn.addEventListener('click', () => {
        if (volFx) {
          if (volFx.params.gain > 0) {
            volFx.params.preMuteGain = volFx.params.gain;
            volFx.params.gain = 0;
            muteBtn.textContent = 'Unmute';
          } else {
            volFx.params.gain = volFx.params.preMuteGain || 100;
            muteBtn.textContent = 'Mute';
          }
          slider.value = volFx.params.gain;
          valueEl.textContent = `${Math.round(volFx.params.gain)}%`;
          this._emitUpdate();
        }
      });

      body.appendChild(row);
      body.appendChild(muteBtn);
    });
  },

  // ── EQ Visualization ──

  _drawEQCurve(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    for (let x = 0; x < w; x += w / 5) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    ctx.stroke();

    // Flat line (0dB) when no EQ applied
    const bands = [
      { f: this._getParam('eq_lp_freq'), g: this._getParam('eq_lp_gain') },
      { f: this._getParam('eq_m1_freq'), g: this._getParam('eq_m1_gain') },
      { f: this._getParam('eq_m2_freq'), g: this._getParam('eq_m2_gain') },
      { f: this._getParam('eq_m3_freq'), g: this._getParam('eq_m3_gain') },
      { f: this._getParam('eq_hp_freq'), g: this._getParam('eq_hp_gain') },
    ];

    ctx.strokeStyle = '#4a90d9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      const freq = 20 * Math.pow(1000, px / w); // log scale 20Hz-20kHz
      let totalGain = 0;
      for (const b of bands) {
        const dist = Math.log2(freq / b.f);
        totalGain += b.g * Math.exp(-dist * dist * 2);
      }
      const y = h / 2 - (totalGain / 12) * (h / 2);
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();

    // Band markers
    ctx.fillStyle = '#4a90d9';
    for (const b of bands) {
      const px = (Math.log(b.f / 20) / Math.log(1000)) * w;
      const py = h / 2 - (b.g / 12) * (h / 2);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  _makeEQDraggable(canvas) {
    const bandParams = [
      { freqId: 'eq_lp_freq', gainId: 'eq_lp_gain', minF: 20, maxF: 500 },
      { freqId: 'eq_m1_freq', gainId: 'eq_m1_gain', minF: 100, maxF: 2000 },
      { freqId: 'eq_m2_freq', gainId: 'eq_m2_gain', minF: 500, maxF: 8000 },
      { freqId: 'eq_m3_freq', gainId: 'eq_m3_gain', minF: 1000, maxF: 16000 },
      { freqId: 'eq_hp_freq', gainId: 'eq_hp_gain', minF: 2000, maxF: 20000 },
    ];
    const w = canvas.width, h = canvas.height;

    const freqToX = (f) => (Math.log(f / 20) / Math.log(1000)) * w;
    const xToFreq = (x) => 20 * Math.pow(1000, x / w);
    const gainToY = (g) => h / 2 - (g / 12) * (h / 2);
    const yToGain = (y) => -((y - h / 2) / (h / 2)) * 12;

    let activeBand = null;

    const hitTest = (mx, my) => {
      for (let i = 0; i < bandParams.length; i++) {
        const bp = bandParams[i];
        const bx = freqToX(this._getParam(bp.freqId) || 1000);
        const by = gainToY(this._getParam(bp.gainId) || 0);
        if (Math.hypot(mx - bx, my - by) < 8) return i;
      }
      return -1;
    };

    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = w / rect.width;
      const scaleY = h / rect.height;
      const mx = (e.clientX - rect.left) * scaleX;
      const my = (e.clientY - rect.top) * scaleY;
      const idx = hitTest(mx, my);
      if (idx < 0) return;

      activeBand = idx;
      canvas.style.cursor = 'grabbing';

      const onMove = (e2) => {
        const mx2 = (e2.clientX - rect.left) * scaleX;
        const my2 = (e2.clientY - rect.top) * scaleY;
        const bp = bandParams[activeBand];
        const newFreq = clamp(Math.round(xToFreq(mx2)), bp.minF, bp.maxF);
        const newGain = clamp(Math.round(yToGain(my2) * 2) / 2, -12, 12);
        this._setParam(bp.freqId, newFreq);
        this._setParam(bp.gainId, newGain);
        this._drawEQCurve(canvas);
        // Update corresponding sliders
        const freqSlider = this._sliderEls[bp.freqId];
        if (freqSlider) { freqSlider.slider.value = newFreq; freqSlider.valueEl.textContent = formatValue(newFreq, 5) + ' Hz'; }
        const gainSlider = this._sliderEls[bp.gainId];
        if (gainSlider) { gainSlider.slider.value = newGain; gainSlider.valueEl.textContent = formatValue(newGain, 0.5) + ' dB'; }
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        canvas.style.cursor = '';
        activeBand = null;
        const bp = bandParams[idx];
        this._setParamImmediate(bp.freqId, this._getParam(bp.freqId));
        this._setParamImmediate(bp.gainId, this._getParam(bp.gainId));
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (activeBand !== null) return;
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (w / rect.width);
      const my = (e.clientY - rect.top) * (h / rect.height);
      canvas.style.cursor = hitTest(mx, my) >= 0 ? 'grab' : 'default';
    });
  },

  // ── Actions ──

  async _autoMatchLoudness() {
    if (!this._clip) return;
    const target = this._getParam('loudness_target') || -23;

    try {
      // Render the clip's audio to a buffer for LUFS measurement
      const mediaItem = mediaManager.getItem(this._clip.mediaId);
      if (!mediaItem) return;

      const clipDur = frameToSeconds(getClipDuration(this._clip));
      const ctx = new OfflineAudioContext(2, Math.ceil(clipDur * 48000), 48000);

      // Decode audio
      const resp = await fetch(mediaItem.url);
      const arrayBuf = await resp.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuf);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      // K-weighting filters per ITU-R BS.1770
      // Stage 1: Pre-filter (high shelf +4dB at 1681Hz)
      const preFilter = ctx.createBiquadFilter();
      preFilter.type = 'highshelf';
      preFilter.frequency.value = 1681;
      preFilter.gain.value = 4;

      // Stage 2: High-pass (RLB weighting, ~38Hz)
      const rlbFilter = ctx.createBiquadFilter();
      rlbFilter.type = 'highpass';
      rlbFilter.frequency.value = 38;
      rlbFilter.Q.value = 0.5;

      source.connect(preFilter);
      preFilter.connect(rlbFilter);
      rlbFilter.connect(ctx.destination);

      const sourceIn = frameToSeconds(this._clip.sourceInFrame);
      source.start(0, sourceIn, clipDur);

      const rendered = await ctx.startRendering();

      // Compute integrated loudness (simplified BS.1770)
      const blockSize = Math.floor(0.4 * rendered.sampleRate); // 400ms blocks
      const overlap = Math.floor(blockSize * 0.75);
      const step = blockSize - overlap;
      const ch0 = rendered.getChannelData(0);
      const ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : ch0;
      const blockPowers = [];

      for (let i = 0; i + blockSize <= rendered.length; i += step) {
        let sumSq = 0;
        for (let j = 0; j < blockSize; j++) {
          sumSq += ch0[i + j] * ch0[i + j] + ch1[i + j] * ch1[i + j];
        }
        blockPowers.push(sumSq / blockSize);
      }

      if (blockPowers.length === 0) return;

      // Absolute gate (-70 LUFS)
      const absGate = Math.pow(10, -7); // -70 LUFS in linear power
      const ungated = blockPowers.filter(p => p > absGate);
      if (ungated.length === 0) return;

      const avgUngated = ungated.reduce((a, b) => a + b, 0) / ungated.length;
      const relGate = avgUngated * Math.pow(10, -1); // -10 LU relative gate

      const gated = ungated.filter(p => p > relGate);
      if (gated.length === 0) return;

      const avgGated = gated.reduce((a, b) => a + b, 0) / gated.length;
      const measuredLUFS = -0.691 + 10 * Math.log10(avgGated);

      const gain = Math.round((target - measuredLUFS) * 2) / 2; // round to 0.5dB
      this._setParamImmediate('loudness_gain', clamp(gain, -40, 40));
      this._setParamImmediate('loudness_enabled', true);
      this._render();
      logger.info(`[EssentialAudio] Auto-match: measured=${measuredLUFS.toFixed(1)} LUFS, target=${target}, gain=${gain} dB`);
    } catch (err) {
      logger.warn('[EssentialAudio] LUFS measurement failed:', err.message);
      // Fallback to rough estimate
      const gain = target - (-18);
      this._setParamImmediate('loudness_gain', gain);
      this._setParamImmediate('loudness_enabled', true);
      this._render();
    }
  },

  _generateDuckKeyframes() {
    if (!this._clip || !this._ensureEffectCreated()) return;

    const duckParams = {
      dialogue: this._getParam('duck_against_dialogue'),
      sfx: this._getParam('duck_against_sfx'),
      ambience: this._getParam('duck_against_ambience'),
      untagged: this._getParam('duck_against_untagged'),
    };
    const amount = this._getParam('duck_amount') || -6;
    const fadeDur = (this._getParam('duck_fades') || 500) / 1000; // seconds
    const fadePos = this._getParam('duck_fade_position') || 'outside';

    // Find all clips whose audioType matches duck_against settings
    const allClips = timelineEngine.getAllClips();
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const myStart = this._clip.startFrame;
    const myEnd = myStart + getClipDuration(this._clip);
    const triggerRanges = [];

    for (const clip of allClips) {
      if (clip.id === this._clip.id) continue;
      const clipType = clip.audioType || 'unassigned';
      const shouldDuck = (clipType === 'dialogue' && duckParams.dialogue) ||
                         (clipType === 'sfx' && duckParams.sfx) ||
                         (clipType === 'ambience' && duckParams.ambience) ||
                         (clipType === 'unassigned' && duckParams.untagged);
      if (!shouldDuck) continue;

      const cStart = clip.startFrame;
      const cEnd = cStart + getClipDuration(clip);
      // Check overlap with our clip
      if (cEnd > myStart && cStart < myEnd) {
        triggerRanges.push({ start: Math.max(cStart, myStart), end: Math.min(cEnd, myEnd) });
      }
    }

    if (triggerRanges.length === 0) {
      logger.info('[EssentialAudio] No overlapping trigger clips found for ducking');
      return;
    }

    // Merge overlapping ranges
    triggerRanges.sort((a, b) => a.start - b.start);
    const merged = [triggerRanges[0]];
    for (let i = 1; i < triggerRanges.length; i++) {
      const last = merged[merged.length - 1];
      if (triggerRanges[i].start <= last.end) {
        last.end = Math.max(last.end, triggerRanges[i].end);
      } else {
        merged.push(triggerRanges[i]);
      }
    }

    // Generate gain keyframes on the intrinsic volume effect
    const volFx = this._clip.effects?.find(f => f.id === 'intrinsic-volume');
    if (!volFx) return;

    const fadeFrames = Math.round(fadeDur * fps);
    const duckGain = Math.pow(10, amount / 20) * 100; // convert dB to % for volume effect
    const normalGain = volFx.params.gain || 100;
    const keyframes = [];

    for (const range of merged) {
      let fadeInStart, fadeOutEnd;
      if (fadePos === 'outside') {
        fadeInStart = range.start - fadeFrames;
        fadeOutEnd = range.end + fadeFrames;
      } else if (fadePos === 'inside') {
        fadeInStart = range.start;
        fadeOutEnd = range.end;
      } else { // center
        fadeInStart = range.start - Math.floor(fadeFrames / 2);
        fadeOutEnd = range.end + Math.floor(fadeFrames / 2);
      }

      // Clamp to clip bounds (relative to clip start)
      const rel = f => f - myStart;
      keyframes.push({ frame: Math.max(0, rel(fadeInStart)), value: normalGain });
      keyframes.push({ frame: Math.max(0, rel(fadeInStart + fadeFrames)), value: duckGain });
      keyframes.push({ frame: Math.min(rel(myEnd), rel(range.end)), value: duckGain });
      keyframes.push({ frame: Math.min(rel(myEnd), rel(fadeOutEnd)), value: normalGain });
    }

    // Remove duplicate frames and sort
    const uniqueKfs = [];
    const seen = new Set();
    for (const kf of keyframes) {
      if (!seen.has(kf.frame)) {
        seen.add(kf.frame);
        uniqueKfs.push(kf);
      }
    }
    uniqueKfs.sort((a, b) => a.frame - b.frame);

    volFx.keyframes.gain = uniqueKfs;
    this._emitUpdate();
    this._render();
    logger.info(`[EssentialAudio] Generated ${uniqueKfs.length} duck keyframes for ${merged.length} trigger ranges`);
  },

  _applyPreset(preset) {
    if (!this._ensureEffectCreated()) return;
    // Reset all params to defaults first, then apply preset overrides
    for (const [key, val] of Object.entries(DEFAULT_PARAMS)) {
      this._effectInstance.params[key] = val;
    }
    for (const [key, val] of Object.entries(preset)) {
      this._effectInstance.params[key] = val;
    }
    this._emitUpdate();
    this._render();
  },

  _resetSection(sectionId) {
    if (!this._effectInstance) return;
    const sectionParams = {
      'loudness': ['loudness_enabled', 'loudness_target', 'loudness_gain'],
      'repair': ['repair_noise', 'repair_rumble', 'repair_dehum', 'repair_dehum_freq', 'repair_deess', 'repair_reverb'],
      'clarity': ['clarity_dynamics', 'clarity_eq_preset', 'clarity_eq_amount', 'clarity_enhance', 'clarity_enhance_tone'],
      'ducking': ['duck_enabled', 'duck_against_dialogue', 'duck_against_sfx', 'duck_against_ambience', 'duck_against_untagged', 'duck_sensitivity', 'duck_amount', 'duck_fades', 'duck_fade_position'],
      'creative-reverb': ['creative_reverb', 'creative_reverb_preset', 'creative_reverb_decay'],
      'stereo-width': ['creative_stereo_width'],
      'pan': ['creative_pan'],
      'eq': ['eq_enabled', 'eq_lp_freq', 'eq_lp_gain', 'eq_m1_freq', 'eq_m1_gain', 'eq_m1_q', 'eq_m2_freq', 'eq_m2_gain', 'eq_m2_q', 'eq_m3_freq', 'eq_m3_gain', 'eq_m3_q', 'eq_hp_freq', 'eq_hp_gain'],
    };
    const params = sectionParams[sectionId] || [];
    for (const p of params) {
      this._effectInstance.params[p] = DEFAULT_PARAMS[p];
    }
    this._emitUpdate();
    this._render();
  },
};

export default essentialAudioPanel;

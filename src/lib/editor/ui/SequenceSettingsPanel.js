// Dockable Sequence Settings panel — resolution, fps, codec, bitrate + conform progress
import { editorState } from '../core/EditorState.js';
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import {
  EDITOR_EVENTS, CANVAS_PRESETS, FRAME_RATES,
  SEQUENCE_CODECS, SEQUENCE_BITRATE_OPTIONS, STATE_PATHS,
  BITRATE_MODES, QUALITY_OPTIONS, COLOR_MANAGEMENT_PRESETS
} from '../core/Constants.js';
import { colorManagement } from '../core/ColorManagement.js';
import { conformEncoder } from '../media/ConformEncoder.js';
import { clamp } from '../core/MathUtils.js';

export const sequenceSettingsPanel = {
  _el: null,
  _progressBar: null,
  _progressLabel: null,
  _qualityRow: null,
  _unsubs: [],

  init(el) {
    this._el = el;
    this._buildUI();
    this._bindEvents();
    this._updateProgress();
  },

  _buildUI() {
    const el = this._el;
    el.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'nle-seq-settings';

    // Resolution
    wrap.appendChild(this._buildRow('Resolution', this._buildResolutionControl()));

    // Frame Rate
    wrap.appendChild(this._buildRow('Frame Rate', this._buildFpsControl()));

    // Codec
    wrap.appendChild(this._buildRow('Codec', this._buildCodecControl()));

    // Bitrate
    wrap.appendChild(this._buildRow('Bitrate', this._buildBitrateControl()));

    // Rate Control
    wrap.appendChild(this._buildRow('Rate Control', this._buildBitrateModeControl()));

    // Quality (hidden in CBR mode)
    this._qualityRow = this._buildRow('Quality', this._buildQualityControl());
    if (editorState.get(STATE_PATHS.PROJECT_BITRATE_MODE) === 'constant') {
      this._qualityRow.classList.add('nle-hidden');
    }
    wrap.appendChild(this._qualityRow);

    // Color Management section
    const colorSection = document.createElement('div');
    colorSection.className = 'nle-seq-tuning-section';

    const colorHeader = document.createElement('div');
    colorHeader.className = 'nle-seq-progress-header';
    colorHeader.textContent = 'Color Management';
    colorSection.appendChild(colorHeader);

    colorSection.appendChild(this._buildRow('Color Preset', this._buildColorPresetControl()));
    colorSection.appendChild(this._buildRow('Working Space', this._buildReadOnlyText(STATE_PATHS.PROJECT_WORKING_SPACE)));
    colorSection.appendChild(this._buildRow('Output Space', this._buildReadOnlyText(STATE_PATHS.PROJECT_OUTPUT_SPACE)));
    colorSection.appendChild(this._buildRow('Linear Compositing', this._buildCheckboxControl(STATE_PATHS.PROJECT_LINEAR_COMPOSITING)));
    colorSection.appendChild(this._buildRow('Color Aware Effects', this._buildCheckboxControl(STATE_PATHS.PROJECT_COLOR_AWARE_EFFECTS)));

    wrap.appendChild(colorSection);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'nle-seq-divider';
    wrap.appendChild(divider);

    // Conform tuning
    const tuningSection = document.createElement('div');
    tuningSection.className = 'nle-seq-tuning-section';

    const tuningHeader = document.createElement('div');
    tuningHeader.className = 'nle-seq-progress-header';
    tuningHeader.textContent = 'Conform Tuning';
    tuningSection.appendChild(tuningHeader);

    tuningSection.appendChild(this._buildRow('Batch Size',
      this._buildTuningSlider('_maxPerTick', 1, 32, conformEncoder._maxPerTick,
        'Frames composited per idle tick. Higher = faster conforming but more main-thread work. Lower if UI feels sluggish during conform.')));
    tuningSection.appendChild(this._buildRow('Pipeline Depth',
      this._buildTuningSlider('_maxPending', 1, 32, conformEncoder._maxPending,
        'Max encodes in-flight to the GPU. Higher = better GPU utilization. Lower if system runs hot or memory-constrained.')));

    wrap.appendChild(tuningSection);

    // Conform progress
    const progressSection = document.createElement('div');
    progressSection.className = 'nle-seq-progress-section';

    const progressHeader = document.createElement('div');
    progressHeader.className = 'nle-seq-progress-header';
    progressHeader.textContent = 'Conform Status';
    progressSection.appendChild(progressHeader);

    const progressBarWrap = document.createElement('div');
    progressBarWrap.className = 'nle-seq-progress-bar-wrap';
    this._progressBar = document.createElement('div');
    this._progressBar.className = 'nle-seq-progress-bar';
    this._progressBar.style.width = '0%';
    progressBarWrap.appendChild(this._progressBar);
    progressSection.appendChild(progressBarWrap);

    this._progressLabel = document.createElement('div');
    this._progressLabel.className = 'nle-seq-progress-label';
    this._progressLabel.textContent = '0/0 frames pre-encoded';
    progressSection.appendChild(this._progressLabel);

    // Buttons row
    const btnRow = document.createElement('div');
    btnRow.className = 'nle-seq-btn-row';

    const reconformBtn = document.createElement('button');
    reconformBtn.className = 'nle-seq-btn';
    reconformBtn.textContent = 'Re-conform';
    reconformBtn.title = 'Invalidate all conformed packets and restart';
    reconformBtn.addEventListener('click', () => {
      conformEncoder._invalidateAll();
      conformEncoder._restartIdleFill();
    });
    btnRow.appendChild(reconformBtn);

    progressSection.appendChild(btnRow);
    wrap.appendChild(progressSection);

    el.appendChild(wrap);
  },

  _buildRow(label, control) {
    const row = document.createElement('div');
    row.className = 'nle-seq-row';
    const lbl = document.createElement('span');
    lbl.className = 'nle-seq-label';
    lbl.textContent = label;
    row.appendChild(lbl);
    row.appendChild(control);
    return row;
  },

  _buildResolutionControl() {
    const wrap = document.createElement('div');
    wrap.className = 'nle-seq-control';

    const select = document.createElement('select');
    select.className = 'nle-seq-select';

    for (const [key, preset] of Object.entries(CANVAS_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = preset.label;
      select.appendChild(opt);
    }

    // Custom option
    const customOpt = document.createElement('option');
    customOpt.value = 'custom';
    customOpt.textContent = 'Custom';
    select.appendChild(customOpt);

    // Set current value
    const canvas = editorState.get(STATE_PATHS.PROJECT_CANVAS);
    const currentKey = `${canvas.width}x${canvas.height}`;
    if (CANVAS_PRESETS[currentKey]) {
      select.value = currentKey;
    } else {
      select.value = 'custom';
    }

    // Custom W x H inputs
    const customWrap = document.createElement('div');
    customWrap.className = 'nle-seq-custom-res';
    customWrap.style.display = select.value === 'custom' ? 'flex' : 'none';

    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.className = 'nle-seq-num-input';
    widthInput.value = canvas.width;
    widthInput.min = 128;
    widthInput.max = 7680;

    const xLabel = document.createElement('span');
    xLabel.className = 'nle-seq-x-label';
    xLabel.textContent = '\u00D7';

    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.className = 'nle-seq-num-input';
    heightInput.value = canvas.height;
    heightInput.min = 128;
    heightInput.max = 4320;

    customWrap.appendChild(widthInput);
    customWrap.appendChild(xLabel);
    customWrap.appendChild(heightInput);

    select.addEventListener('change', () => {
      if (select.value === 'custom') {
        customWrap.style.display = 'flex';
      } else {
        customWrap.style.display = 'none';
        const preset = CANVAS_PRESETS[select.value];
        if (preset) {
          editorState.set(STATE_PATHS.PROJECT_CANVAS, { width: preset.width, height: preset.height });
        }
      }
    });

    const applyCustom = () => {
      const w = clamp(parseInt(widthInput.value) || 1920, 128, 7680);
      const h = clamp(parseInt(heightInput.value) || 1080, 128, 4320);
      widthInput.value = w;
      heightInput.value = h;
      editorState.set(STATE_PATHS.PROJECT_CANVAS, { width: w, height: h });
    };

    widthInput.addEventListener('change', applyCustom);
    heightInput.addEventListener('change', applyCustom);

    wrap.appendChild(select);
    wrap.appendChild(customWrap);
    return wrap;
  },

  _buildFpsControl() {
    const select = document.createElement('select');
    select.className = 'nle-seq-select';

    const fpsValues = Object.values(FRAME_RATES);
    const current = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE);

    for (const fps of fpsValues) {
      const opt = document.createElement('option');
      opt.value = fps;
      opt.textContent = `${fps} fps`;
      if (fps === current) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      editorState.set(STATE_PATHS.PROJECT_FRAME_RATE, parseInt(select.value));
    });

    return select;
  },

  _buildCodecControl() {
    const select = document.createElement('select');
    select.className = 'nle-seq-select';

    const codecEntries = [
      { value: SEQUENCE_CODECS.H264, label: 'H.264 High' },
      { value: SEQUENCE_CODECS.VP9, label: 'VP9' }
    ];

    const current = editorState.get(STATE_PATHS.PROJECT_CODEC);

    for (const { value, label } of codecEntries) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === current) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      editorState.set(STATE_PATHS.PROJECT_CODEC, select.value);
    });

    return select;
  },

  _buildBitrateControl() {
    const select = document.createElement('select');
    select.className = 'nle-seq-select';

    const current = editorState.get(STATE_PATHS.PROJECT_BITRATE);

    for (const br of SEQUENCE_BITRATE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = br;
      const numStr = br.replace(/[mMkK]$/, '');
      const unit = br.endsWith('M') || br.endsWith('m') ? 'Mbps' : 'Kbps';
      opt.textContent = `${numStr} ${unit}`;
      if (br === current) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      editorState.set(STATE_PATHS.PROJECT_BITRATE, select.value);
    });

    return select;
  },

  _buildBitrateModeControl() {
    const select = document.createElement('select');
    select.className = 'nle-seq-select';

    const modes = [
      { value: BITRATE_MODES.VARIABLE, label: 'Variable (VBR)' },
      { value: BITRATE_MODES.CONSTANT, label: 'Constant (CBR)' }
    ];
    const current = editorState.get(STATE_PATHS.PROJECT_BITRATE_MODE);

    for (const { value, label } of modes) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === current) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      editorState.set(STATE_PATHS.PROJECT_BITRATE_MODE, select.value);
      // Toggle quality row visibility
      if (this._qualityRow) {
        if (select.value === 'constant') {
          this._qualityRow.classList.add('nle-hidden');
        } else {
          this._qualityRow.classList.remove('nle-hidden');
        }
      }
    });

    return select;
  },

  _buildQualityControl() {
    const select = document.createElement('select');
    select.className = 'nle-seq-select';

    const current = editorState.get(STATE_PATHS.PROJECT_QUALITY);

    for (const q of QUALITY_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = q;
      opt.textContent = q.charAt(0).toUpperCase() + q.slice(1);
      if (q === current) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      editorState.set(STATE_PATHS.PROJECT_QUALITY, select.value);
    });

    return select;
  },

  _colorSpaceLabel(id) {
    const labels = {
      'rec709': 'Rec.709',
      'display-p3': 'Display P3',
      'rec2020': 'Rec.2020',
      'srgb': 'sRGB'
    };
    return labels[id] || id;
  },

  _buildColorPresetControl() {
    const select = document.createElement('select');
    select.className = 'nle-seq-select';

    const current = editorState.get(STATE_PATHS.PROJECT_COLOR_PRESET) || 'direct-709';

    for (const [key, preset] of Object.entries(COLOR_MANAGEMENT_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = preset.name;
      if (key === current) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      colorManagement.applyPreset(select.value);
    });

    return select;
  },

  _buildReadOnlyText(statePath) {
    const span = document.createElement('span');
    span.className = 'nle-seq-label';
    span.style.textAlign = 'right';
    span.style.flex = '1';
    const val = editorState.get(statePath) || '';
    span.textContent = this._colorSpaceLabel(val);
    return span;
  },

  _buildCheckboxControl(statePath) {
    const wrap = document.createElement('div');
    wrap.className = 'nle-seq-control';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'nle-seq-checkbox';
    checkbox.checked = !!editorState.get(statePath);
    checkbox.addEventListener('change', () => {
      editorState.set(statePath, checkbox.checked);
    });
    wrap.appendChild(checkbox);
    return wrap;
  },

  _buildTuningSlider(prop, min, max, initial, tooltip) {
    const wrap = document.createElement('div');
    wrap.className = 'nle-seq-tuning-control';
    wrap.title = tooltip;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'nle-seq-slider';
    slider.min = min;
    slider.max = max;
    slider.value = initial;

    const valueLabel = document.createElement('span');
    valueLabel.className = 'nle-seq-tuning-value';
    valueLabel.textContent = initial;

    slider.addEventListener('input', () => {
      const val = parseInt(slider.value);
      valueLabel.textContent = val;
      conformEncoder[prop] = val;
    });

    wrap.appendChild(slider);
    wrap.appendChild(valueLabel);
    return wrap;
  },

  _bindEvents() {
    // EventBus subscriptions
    this._unsubEvents = subscribeEvents({
      [EDITOR_EVENTS.CONFORM_BUFFER_CHANGED]: () => this._updateProgress(),
      [EDITOR_EVENTS.SEQUENCE_ACTIVATED]: () => this._rebuildControls(),
    });

    // Update controls when settings change externally
    const settingsFn = () => this._rebuildControls();
    for (const path of [STATE_PATHS.PROJECT_CANVAS, STATE_PATHS.PROJECT_FRAME_RATE, STATE_PATHS.PROJECT_CODEC, STATE_PATHS.PROJECT_BITRATE, STATE_PATHS.PROJECT_BITRATE_MODE, STATE_PATHS.PROJECT_QUALITY, STATE_PATHS.PROJECT_COLOR_PRESET, STATE_PATHS.PROJECT_WORKING_SPACE, STATE_PATHS.PROJECT_OUTPUT_SPACE, STATE_PATHS.PROJECT_LINEAR_COMPOSITING, STATE_PATHS.PROJECT_COLOR_AWARE_EFFECTS]) {
      const unsub = editorState.subscribe(path, settingsFn);
      this._unsubs.push(unsub);
    }
  },

  _rebuildControls() {
    // Simple approach: rebuild the entire panel UI when settings change externally
    if (this._el) this._buildUI();
  },

  _updateProgress() {
    if (!this._progressBar || !this._progressLabel) return;
    const { conformed, total } = conformEncoder.getProgress();
    const pct = total > 0 ? Math.round((conformed / total) * 100) : 0;
    this._progressBar.style.width = `${pct}%`;
    this._progressLabel.textContent = `${conformed}/${total} frames pre-encoded (${pct}%)`;
  },

  destroy() {
    if (this._unsubEvents) this._unsubEvents();
    for (const unsub of this._unsubs) {
      if (typeof unsub === 'function') unsub();
    }
    this._unsubs = [];
    if (this._el) this._el.innerHTML = '';
    this._progressBar = null;
    this._progressLabel = null;
    this._qualityRow = null;
  }
};

export default sequenceSettingsPanel;

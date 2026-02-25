// Properties panel — Premiere Pro-style editable clip properties
// Shows clip info, editable speed/opacity/volume, transform quick-access, effects summary
import { editorState } from '../core/EditorState.js';
import { eventBus, subscribeEvents } from '../core/EventBus.js';
import { EDITOR_EVENTS, TRACK_TYPES, STATE_PATHS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { getClipDuration, getClipEndFrame } from '../timeline/Clip.js';
import { mediaManager } from '../media/MediaManager.js';
import { keyframeEngine } from '../effects/KeyframeEngine.js';
import { resolveSelectedClip } from './uiUtils.js';
import { attachScrubby } from './ScrubbyInput.js';

export const basicPropertiesPanel = {
  _container: null,
  _contentEl: null,
  _currentClip: null,
  _linkedClip: null,
  _liveEls: null,
  _scrubbies: [],

  init(container) {
    this._container = container;
    this._contentEl = container.querySelector('.nle-properties-content');
    if (!this._contentEl) return;

    this._onRender = () => this._render();
    this._onFrame = () => this._updateLiveValues();
    this._onTimelineUpdate = () => this._updateTimeValues();

    this._unsubEvents = subscribeEvents({
      [EDITOR_EVENTS.CLIP_SELECTED]: this._onRender,
      [EDITOR_EVENTS.CLIP_DESELECTED]: this._onRender,
      [EDITOR_EVENTS.SELECTION_CHANGED]: this._onRender,
      [EDITOR_EVENTS.TIMELINE_UPDATED]: this._onTimelineUpdate,
      [EDITOR_EVENTS.PLAYBACK_FRAME]: this._onFrame,
    });

    this._render();
  },

  destroy() {
    if (this._unsubEvents) this._unsubEvents();
    for (const s of this._scrubbies) s.destroy();
    this._scrubbies = [];
    this._currentClip = null;
    this._linkedClip = null;
    this._liveEls = null;
  },

  _render() {
    if (!this._contentEl) return;
    this._liveEls = null;
    for (const s of this._scrubbies) s.destroy();
    this._scrubbies = [];

    const resolved = resolveSelectedClip();
    if (!resolved) {
      this._contentEl.innerHTML = '<div class="nle-props-empty">Select a clip to view properties</div>';
      this._currentClip = null;
      this._linkedClip = null;
      return;
    }
    if (resolved.multiSelect) {
      this._contentEl.innerHTML = `<div class="nle-props-empty">${resolved.count} clips selected</div>`;
      this._currentClip = null;
      this._linkedClip = null;
      return;
    }

    const { clip, linkedPair } = resolved;
    this._currentClip = clip;
    this._linkedClip = linkedPair ? linkedPair.audio : null;
    this._contentEl.innerHTML = '';
    this._liveEls = {};

    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const track = timelineEngine.getTrack(clip.trackId);
    const isVideo = track && track.type !== TRACK_TYPES.AUDIO;
    const duration = getClipDuration(clip);
    const endFrame = getClipEndFrame(clip);
    const media = clip.mediaId ? mediaManager.getItem(clip.mediaId) : null;
    const audioClip = this._linkedClip || clip;

    // ── Clip Section (editable name) ──
    const clipSection = this._section('Clip');
    const clipBody = clipSection.querySelector('.nle-props-section-body');
    this._editableRow(clipBody, 'Name', clip.name, (val) => {
      clip.name = val;
      if (this._linkedClip) this._linkedClip.name = val;
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });
    if (track) this._readonlyRow(clipBody, 'Track', `${track.name || track.id} (${track.type})`);
    if (media) this._readonlyRow(clipBody, 'Source', media.name || media.fileName || '\u2014');
    this._contentEl.appendChild(clipSection);

    // ── Time Section ──
    const timeSection = this._section('Time');
    const timeBody = timeSection.querySelector('.nle-props-section-body');
    this._liveEls.start = this._readonlyRow(timeBody, 'Start', this._framesToTC(clip.startFrame, fps));
    this._liveEls.end = this._readonlyRow(timeBody, 'End', this._framesToTC(endFrame, fps));
    this._liveEls.duration = this._readonlyRow(timeBody, 'Duration', this._framesToTC(duration, fps));
    this._contentEl.appendChild(timeSection);

    // ── Speed / Duration Section (editable) ──
    const speedSection = this._section('Speed / Duration');
    const speedBody = speedSection.querySelector('.nle-props-section-body');
    this._sliderRow(speedBody, 'Speed', '%', 10, 400, 5, Math.round((clip.speed ?? 1) * 100), (val) => {
      clip.speed = val / 100;
      if (this._linkedClip) this._linkedClip.speed = clip.speed;
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
    });
    this._contentEl.appendChild(speedSection);

    // ── Transform Section (video only, quick-access) ──
    if (isVideo) {
      const transformSection = this._section('Transform');
      const tBody = transformSection.querySelector('.nle-props-section-body');

      const motionFx = clip.effects?.find(fx => fx.id === 'intrinsic-motion');
      if (motionFx) {
        const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
        const posXKfs = motionFx.keyframes?.posX || [];
        const posYKfs = motionFx.keyframes?.posY || [];
        const posX = posXKfs.length > 0 ? keyframeEngine.getValueAtFrame(posXKfs, frame) : motionFx.params.posX;
        const posY = posYKfs.length > 0 ? keyframeEngine.getValueAtFrame(posYKfs, frame) : motionFx.params.posY;
        const scaleKfs = motionFx.keyframes?.scale || [];
        const scale = scaleKfs.length > 0 ? keyframeEngine.getValueAtFrame(scaleKfs, frame) : motionFx.params.scale;
        const rotKfs = motionFx.keyframes?.rotation || [];
        const rotation = rotKfs.length > 0 ? keyframeEngine.getValueAtFrame(rotKfs, frame) : motionFx.params.rotation;

        this._liveEls.posX = this._numberRow(tBody, 'Position X', posX, 0.5, (val) => {
          motionFx.params.posX = val;
          if (motionFx.keyframes?.posX?.length > 0) {
            keyframeEngine.addKeyframe(motionFx.keyframes.posX, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
          }
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        });
        this._liveEls.posY = this._numberRow(tBody, 'Position Y', posY, 0.5, (val) => {
          motionFx.params.posY = val;
          if (motionFx.keyframes?.posY?.length > 0) {
            keyframeEngine.addKeyframe(motionFx.keyframes.posY, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
          }
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        });
        this._liveEls.scale = this._numberRow(tBody, 'Scale', scale, 0.1, (val) => {
          motionFx.params.scale = val;
          if (motionFx.params.uniformScale) motionFx.params.scaleWidth = val;
          if (motionFx.keyframes?.scale?.length > 0) {
            keyframeEngine.addKeyframe(motionFx.keyframes.scale, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
          }
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        });
        this._liveEls.rotation = this._numberRow(tBody, 'Rotation', rotation, 0.1, (val) => {
          motionFx.params.rotation = val;
          if (motionFx.keyframes?.rotation?.length > 0) {
            keyframeEngine.addKeyframe(motionFx.keyframes.rotation, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
          }
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        });
      }

      // Opacity
      const opFx = clip.effects?.find(fx => fx.intrinsic && fx.effectId === 'opacity');
      if (opFx) {
        const opKfs = opFx.keyframes?.opacity || [];
        const opVal = opKfs.length > 0 ? keyframeEngine.getValueAtFrame(opKfs, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME)) : opFx.params.opacity;
        this._liveEls.opacity = this._sliderRow(tBody, 'Opacity', '%', 0, 100, 1, Math.round(opVal), (val) => {
          opFx.params.opacity = val;
          if (opFx.keyframes?.opacity?.length > 0) {
            keyframeEngine.addKeyframe(opFx.keyframes.opacity, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
          }
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        });
      }

      this._contentEl.appendChild(transformSection);
    }

    // ── Audio Section ──
    const volFx = audioClip.effects?.find(fx => fx.intrinsic && fx.effectId === 'audio-volume');
    if (volFx) {
      const audioSection = this._section('Audio');
      const aBody = audioSection.querySelector('.nle-props-section-body');
      const volKfs = volFx.keyframes?.gain || [];
      const volVal = volKfs.length > 0 ? keyframeEngine.getValueAtFrame(volKfs, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME)) : volFx.params.gain;
      this._liveEls.volume = this._sliderRow(aBody, 'Volume', '%', 0, 200, 1, Math.round(volVal), (val) => {
        volFx.params.gain = val;
        if (volFx.keyframes?.gain?.length > 0) {
          keyframeEngine.addKeyframe(volFx.keyframes.gain, editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME), val);
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      });
      this._contentEl.appendChild(audioSection);
    }

    // ── Source Media Section ──
    if (media) {
      const mediaSection = this._section('Source Media');
      const mBody = mediaSection.querySelector('.nle-props-section-body');
      this._readonlyRow(mBody, 'In', this._framesToTC(clip.sourceInFrame, fps));
      this._readonlyRow(mBody, 'Out', this._framesToTC(clip.sourceOutFrame, fps));
      if (media.width && media.height) {
        this._readonlyRow(mBody, 'Resolution', `${media.width} \u00d7 ${media.height}`);
      }
      if (media.duration) {
        this._readonlyRow(mBody, 'Media Duration', `${media.duration.toFixed(2)}s`);
      }
      if (media.codec) {
        this._readonlyRow(mBody, 'Codec', media.codec);
      }
      this._contentEl.appendChild(mediaSection);
    }

    // ── Effects Summary ──
    const userEffects = (clip.effects || []).filter(fx => !fx.intrinsic);
    const linkedUserFx = this._linkedClip
      ? (this._linkedClip.effects || []).filter(fx => !fx.intrinsic)
      : [];
    const allUserFx = [...userEffects, ...linkedUserFx];
    if (allUserFx.length > 0) {
      const fxSection = this._section(`Effects (${allUserFx.length})`);
      const fxBody = fxSection.querySelector('.nle-props-section-body');
      for (const fx of allUserFx) {
        this._toggleRow(fxBody, fx.name, fx.enabled, (checked) => {
          fx.enabled = checked;
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        });
      }
      this._contentEl.appendChild(fxSection);
    }
  },

  _updateTimeValues() {
    if (!this._liveEls || !this._currentClip) return;
    const clip = this._currentClip;
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const duration = getClipDuration(clip);
    const endFrame = getClipEndFrame(clip);
    if (this._liveEls.start) this._liveEls.start.textContent = this._framesToTC(clip.startFrame, fps);
    if (this._liveEls.end) this._liveEls.end.textContent = this._framesToTC(endFrame, fps);
    if (this._liveEls.duration) this._liveEls.duration.textContent = this._framesToTC(duration, fps);
  },

  _updateLiveValues() {
    if (!this._liveEls || !this._currentClip) return;
    const clip = this._currentClip;
    const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);

    // Update transform values during keyframed playback
    const motionFx = clip.effects?.find(fx => fx.id === 'intrinsic-motion');
    if (motionFx) {
      this._updateNumberEl(this._liveEls.posX, motionFx, 'posX', frame);
      this._updateNumberEl(this._liveEls.posY, motionFx, 'posY', frame);
      this._updateNumberEl(this._liveEls.scale, motionFx, 'scale', frame);
      this._updateNumberEl(this._liveEls.rotation, motionFx, 'rotation', frame);
    }

    const opFx = clip.effects?.find(fx => fx.intrinsic && fx.effectId === 'opacity');
    if (opFx) {
      this._updateSliderEl(this._liveEls.opacity, opFx, 'opacity', frame);
    }

    const audioClip = this._linkedClip || clip;
    const volFx = audioClip.effects?.find(fx => fx.intrinsic && fx.effectId === 'audio-volume');
    if (volFx) {
      this._updateSliderEl(this._liveEls.volume, volFx, 'gain', frame);
    }
  },

  _updateNumberEl(el, fx, paramId, frame) {
    if (!el) return;
    const kfs = fx.keyframes?.[paramId];
    if (!kfs || kfs.length === 0) return;
    const val = keyframeEngine.getValueAtFrame(kfs, frame);
    fx.params[paramId] = val;
    if (el.scrubby) {
      el.scrubby.setValue(val);
    } else if (el.input && document.activeElement !== el.input) {
      el.input.value = parseFloat(val.toFixed(1));
    }
  },

  _updateSliderEl(el, fx, paramId, frame) {
    if (!el) return;
    const kfs = fx.keyframes?.[paramId];
    if (!kfs || kfs.length === 0) return;
    const val = keyframeEngine.getValueAtFrame(kfs, frame);
    fx.params[paramId] = val;
    if (el.slider) el.slider.value = Math.round(val);
    if (el.scrubby) {
      el.scrubby.setValue(val);
    } else if (el.display) {
      el.display.textContent = `${Math.round(val)}${el.unit || ''}`;
    }
  },

  // ── DOM helpers ──

  _section(title) {
    const section = document.createElement('div');
    section.className = 'nle-props-section';
    const header = document.createElement('div');
    header.className = 'nle-props-section-header expanded';
    const span = document.createElement('span');
    span.textContent = title;
    header.appendChild(span);
    section.appendChild(header);
    const body = document.createElement('div');
    body.className = 'nle-props-section-body';
    section.appendChild(body);
    header.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      header.classList.toggle('expanded');
      body.classList.toggle('collapsed');
    });
    return section;
  },

  _readonlyRow(body, label, value) {
    const row = document.createElement('div');
    row.className = 'nle-prop-row';
    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    const valEl = document.createElement('span');
    valEl.className = 'nle-prop-value';
    valEl.textContent = value;
    row.appendChild(labelEl);
    row.appendChild(valEl);
    body.appendChild(row);
    return valEl;
  },

  _editableRow(body, label, value, onChange) {
    const row = document.createElement('div');
    row.className = 'nle-prop-row';
    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    const input = document.createElement('input');
    input.className = 'nle-prop-input';
    input.type = 'text';
    input.value = value;
    input.addEventListener('change', () => onChange(input.value));
    row.appendChild(labelEl);
    row.appendChild(input);
    body.appendChild(row);
    return input;
  },

  _sliderRow(body, label, unit, min, max, step, value, onChange) {
    const row = document.createElement('div');
    row.className = 'nle-prop-row';
    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    const slider = document.createElement('input');
    slider.className = 'nle-prop-slider';
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.value = value;
    const display = document.createElement('span');
    display.className = 'nle-prop-value';
    display.textContent = `${value}${unit}`;

    const scrubby = attachScrubby(display, {
      value, min, max, step, unit,
      formatValue: (v) => `${Math.round(v)}${unit}`,
      onChange: (val) => {
        slider.value = val;
        onChange(val);
      }
    });
    this._scrubbies.push(scrubby);

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      scrubby.setValue(val);
      onChange(val);
    });
    row.appendChild(labelEl);
    row.appendChild(slider);
    row.appendChild(display);
    body.appendChild(row);
    return { slider, display, unit, scrubby };
  },

  _numberRow(body, label, value, step, onChange) {
    const row = document.createElement('div');
    row.className = 'nle-prop-row';
    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    const input = document.createElement('input');
    input.className = 'nle-prop-number-input';
    input.type = 'number';
    input.step = step;
    input.value = typeof value === 'number' ? parseFloat(value.toFixed(1)) : value;
    input.addEventListener('change', () => {
      const val = parseFloat(input.value) || 0;
      scrubby.setValue(val);
      onChange(val);
    });

    const scrubby = attachScrubby(input, {
      value: typeof value === 'number' ? value : 0,
      min: -10000, max: 10000, step,
      precision: step >= 1 ? 0 : 1,
      onChange: (val) => { onChange(val); }
    });
    this._scrubbies.push(scrubby);

    row.appendChild(labelEl);
    row.appendChild(input);
    body.appendChild(row);
    return { input, scrubby };
  },

  _toggleRow(body, label, checked, onChange) {
    const row = document.createElement('div');
    row.className = 'nle-prop-row nle-prop-row--checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'nle-prop-checkbox';
    cb.checked = checked;
    const labelEl = document.createElement('label');
    labelEl.className = 'nle-prop-label';
    labelEl.textContent = label;
    cb.addEventListener('change', () => onChange(cb.checked));
    row.appendChild(cb);
    row.appendChild(labelEl);
    body.appendChild(row);
  },

  _framesToTC(frames, fps) {
    const totalSec = frames / fps;
    const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const ss = String(Math.floor(totalSec % 60)).padStart(2, '0');
    const ff = String(Math.floor(frames % fps)).padStart(2, '0');
    return `${mm}:${ss}:${ff}`;
  },

};

export default basicPropertiesPanel;

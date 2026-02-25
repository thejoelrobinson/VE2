// Premiere Pro-style real-time audio meters panel
import { EDITOR_EVENTS, TRACK_TYPES } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { audioMixer } from '../playback/AudioMixer.js';
import { rafScheduler, PRIORITY } from '../core/RafScheduler.js';
import logger from '../../utils/logger.js';
import { sizeCanvasHD } from './uiUtils.js';
import { clamp } from '../core/MathUtils.js';
import { createModule } from '../core/BaseModule.js';

const PEAK_HOLD_TIME = 1500; // ms before peak indicator decays
const DECAY_TIMEOUT = 2000; // ms to keep rendering after playback stops
const METER_GAP = 3; // px between meter bars
const METER_PADDING = 8; // px padding on sides
const LABEL_HEIGHT = 16; // px for track labels at bottom
const SCALE_WIDTH = 28; // px for dB scale on right
const DB_MARKS = [0, -3, -6, -12, -24, -48];
const DB_MIN = -60;

function rmsToDb(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function computeRms(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const sample = (data[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / data.length);
}

function dbToY(db, meterTop, meterHeight) {
  if (db <= DB_MIN) return meterTop + meterHeight;
  if (db >= 0) return meterTop;
  const ratio = 1 - db / DB_MIN;
  return meterTop + meterHeight * (1 - ratio);
}

export const audioMetersPanel = createModule({
  _container: null,
  _canvas: null,
  _ctx2d: null,
  _rafId: null,
  _schedulerId: null,
  _peakHolds: {}, // key -> { level, timestamp }
  _isRunning: false,
  _stopTime: 0,
  _timeDomainData: null,
  _width: 0,
  _height: 0,

  init(container) {
    this._container = container;
    this._destroyed = false;
    this._canvas = container.querySelector('.nle-audio-meters-canvas');
    if (!this._canvas) {
      logger.warn('[AudioMetersPanel] Canvas not found');
      return;
    }
    this._ctx2d = this._canvas.getContext('2d', { alpha: false });
    this._timeDomainData = new Uint8Array(128);

    // Subscribe to events
    this._subscribeEvents({
      [EDITOR_EVENTS.PLAYBACK_START]: () => this._startMetering(),
      [EDITOR_EVENTS.PLAYBACK_STOP]: () => this._stopMetering(),
      [EDITOR_EVENTS.PLAYBACK_FRAME]: () => {
        if (!this._isRunning) this._startMetering();
      },
      [EDITOR_EVENTS.TIMELINE_UPDATED]: () => this._draw(),
      [EDITOR_EVENTS.LAYOUT_RESIZED]: () => this._resize()
    });

    // ResizeObserver to keep canvas sized
    this._observeResize(() => this._resize(), this._container);

    this._schedulerId = rafScheduler.register(ts => this._tick(ts), PRIORITY.UI);

    this._resize();
    logger.info('[AudioMetersPanel] initialized');
  },

  cleanup() {
    this._destroyed = true;
    if (this._schedulerId) {
      rafScheduler.deactivate(this._schedulerId);
      rafScheduler.unregister(this._schedulerId);
      this._schedulerId = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._isRunning = false;
    this._peakHolds = {};
    this._container = null;
    this._canvas = null;
    this._ctx2d = null;
  },

  _resize() {
    if (!this._canvas || !this._container) return;
    const rect = this._container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return; // Panel is detached or hidden
    if (w === this._width && h === this._height) return; // No change
    this._width = w;
    this._height = h;
    sizeCanvasHD(this._canvas, this._ctx2d, w, h);
    this._draw();
  },

  _startMetering() {
    if (this._isRunning) return;
    this._isRunning = true;
    if (this._schedulerId) {
      rafScheduler.activate(this._schedulerId);
    } else {
      this._tick();
    }
  },

  _stopMetering() {
    this._stopTime = performance.now();
    // Keep running for decay
  },

  _tick() {
    if (this._destroyed || !this._canvas) return;

    // Stop loop if we've decayed long enough after playback stop
    const now = performance.now();
    if (!this._isPlaying() && this._stopTime > 0 && now - this._stopTime > DECAY_TIMEOUT) {
      this._isRunning = false;
      if (this._schedulerId) {
        rafScheduler.deactivate(this._schedulerId);
      }
      this._rafId = null;
      this._draw(); // Final draw with empty meters
      return;
    }

    this._draw();
    // Self-schedule only if not using the centralized scheduler
    if (!this._schedulerId) {
      this._rafId = requestAnimationFrame(() => this._tick());
    }
  },

  _isPlaying() {
    return audioMixer.isPlaying();
  },

  _draw() {
    const ctx = this._ctx2d;
    if (!ctx || !this._canvas) return;

    const w = this._width;
    const h = this._height;
    if (w <= 0 || h <= 0) return;

    ctx.clearRect(0, 0, w, h);

    // Gather audio tracks
    const audioTracks = timelineEngine.getTracks().filter(t => t.type === TRACK_TYPES.AUDIO);
    const meterCount = audioTracks.length + 1; // +1 for master

    const meterTop = 4;
    const meterHeight = h - meterTop - LABEL_HEIGHT - 4;
    if (meterHeight < 10) return;

    const availableWidth = w - METER_PADDING * 2 - SCALE_WIDTH;
    const meterWidth = clamp((availableWidth - METER_GAP * (meterCount - 1)) / meterCount, 6, 24);
    const totalMetersWidth = meterCount * meterWidth + (meterCount - 1) * METER_GAP;
    const startX = METER_PADDING;

    const now = performance.now();
    const levels = [];

    // Get levels for each audio track
    for (let i = 0; i < audioTracks.length; i++) {
      const track = audioTracks[i];
      const analyser = audioMixer.getTrackAnalyser(track.id);
      const db = this._getLevel(analyser);
      const key = 'track-' + track.id;
      this._updatePeakHold(key, db, now);
      levels.push({ db, peak: this._peakHolds[key]?.level ?? DB_MIN, label: 'A' + (i + 1) });
    }

    // Master level
    const masterAnalyser = audioMixer.getMasterAnalyser();
    const masterDb = this._getLevel(masterAnalyser);
    this._updatePeakHold('master', masterDb, now);
    levels.push({ db: masterDb, peak: this._peakHolds['master']?.level ?? DB_MIN, label: 'M' });

    // Draw each meter
    for (let i = 0; i < levels.length; i++) {
      const x = startX + i * (meterWidth + METER_GAP);
      const { db, peak, label } = levels[i];
      const isMaster = i === levels.length - 1;

      // Background
      ctx.fillStyle = '#141414';
      ctx.fillRect(x, meterTop, meterWidth, meterHeight);

      // Level fill with gradient segments
      if (db > DB_MIN) {
        const levelY = dbToY(db, meterTop, meterHeight);
        const greenEnd = dbToY(-12, meterTop, meterHeight);
        const yellowEnd = dbToY(-3, meterTop, meterHeight);
        const bottom = meterTop + meterHeight;

        // Green zone (-inf to -12dB)
        if (levelY < bottom) {
          const segTop = Math.max(levelY, greenEnd);
          if (segTop < bottom) {
            ctx.fillStyle = '#30d158';
            ctx.fillRect(x, segTop, meterWidth, bottom - segTop);
          }
        }

        // Yellow zone (-12dB to -3dB)
        if (levelY < greenEnd) {
          const segTop = Math.max(levelY, yellowEnd);
          ctx.fillStyle = '#e5c07b';
          ctx.fillRect(x, segTop, meterWidth, greenEnd - segTop);
        }

        // Red zone (-3dB to 0dB)
        if (levelY < yellowEnd) {
          ctx.fillStyle = '#ff3b30';
          ctx.fillRect(x, levelY, meterWidth, yellowEnd - levelY);
        }
      }

      // Peak hold indicator
      if (peak > DB_MIN) {
        const peakY = dbToY(peak, meterTop, meterHeight);
        ctx.fillStyle = peak >= -3 ? '#ff3b30' : peak >= -12 ? '#e5c07b' : '#30d158';
        ctx.fillRect(x, peakY, meterWidth, 2);
      }

      // Divider line before master
      if (isMaster && audioTracks.length > 0) {
        const divX = x - METER_GAP / 2 - 0.5;
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(divX, meterTop);
        ctx.lineTo(divX, meterTop + meterHeight);
        ctx.stroke();
      }

      // Label
      ctx.fillStyle = isMaster ? '#e5c07b' : '#888';
      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x + meterWidth / 2, meterTop + meterHeight + LABEL_HEIGHT - 3);
    }

    // dB scale on the right
    const scaleX = startX + totalMetersWidth + 6;
    ctx.fillStyle = '#555';
    ctx.font = '8px -apple-system, sans-serif';
    ctx.textAlign = 'left';

    for (const db of DB_MARKS) {
      const y = dbToY(db, meterTop, meterHeight);
      ctx.fillText(db === 0 ? '0' : String(db), scaleX, y + 3);

      // Tick line
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(startX + totalMetersWidth, y);
      ctx.stroke();
    }
  },

  _getLevel(analyser) {
    if (!analyser) return DB_MIN;
    const data = this._timeDomainData;
    if (data.length !== analyser.frequencyBinCount) {
      this._timeDomainData = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteTimeDomainData(this._timeDomainData);
    const rms = computeRms(this._timeDomainData);
    return rmsToDb(rms);
  },

  _updatePeakHold(key, db, now) {
    const hold = this._peakHolds[key];
    if (!hold || db > hold.level) {
      this._peakHolds[key] = { level: db, timestamp: now };
    } else if (now - hold.timestamp > PEAK_HOLD_TIME) {
      // Decay peak towards current level
      hold.level = Math.max(db, hold.level - 0.5);
      hold.timestamp = now;
    }
  }
});

export default audioMetersPanel;

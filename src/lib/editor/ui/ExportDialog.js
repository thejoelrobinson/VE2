// Export dialog: preset picker, custom settings, progress bar, download
import { getPresetList, getPreset } from '../export/ExportPresets.js';
import { exportPipeline } from '../export/ExportPipeline.js';
import { editorState } from '../core/EditorState.js';
import { STATE_PATHS, SEQUENCE_BITRATE_OPTIONS, QUALITY_OPTIONS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { frameToTimecode } from '../timeline/TimelineMath.js';
import logger from '../../utils/logger.js';

export const exportDialog = {
  _overlay: null,
  _dialog: null,
  _eventUnsubs: [],

  show() {
    if (this._overlay) return;

    this._overlay = document.createElement('div');
    this._overlay.className = 'nle-export-overlay';

    this._dialog = document.createElement('div');
    this._dialog.className = 'nle-export-dialog';
    this._dialog.innerHTML = this._buildHTML();
    this._overlay.appendChild(this._dialog);

    document.getElementById('video-editor')?.appendChild(this._overlay);

    this._bindEvents();
  },

  hide() {
    // Unsubscribe from any export pipeline events
    for (const unsub of this._eventUnsubs) unsub();
    this._eventUnsubs = [];

    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
      this._dialog = null;
    }
  },

  _buildHTML() {
    const presets = getPresetList();
    return `
      <div class="nle-export-header">
        <h3>Export Video</h3>
        <button class="nle-export-close-btn" title="Close">×</button>
      </div>
      <div class="nle-export-body">
        <div class="nle-export-section">
          <label class="nle-export-label">Preset</label>
          <select class="nle-export-preset-select nle-export-preset-picker">
            ${presets.map(p => `<option value="${p.id}">${p.name}</option>`).join('')}
          </select>
        </div>
        <div class="nle-export-encoding-controls">
          <div class="nle-export-encoding-row">
            <label class="nle-export-label">Rate Control</label>
            <select class="nle-export-preset-select nle-export-bitrate-mode">
              <option value="variable">Variable Bitrate (VBR)</option>
              <option value="constant">Constant Bitrate (CBR)</option>
            </select>
          </div>
          <div class="nle-export-encoding-row">
            <label class="nle-export-label">Target Bitrate</label>
            <select class="nle-export-preset-select nle-export-bitrate">
              ${SEQUENCE_BITRATE_OPTIONS.map(b => `<option value="${b}">${parseInt(b)} Mbps</option>`).join('')}
            </select>
          </div>
          <div class="nle-export-encoding-row nle-export-quality-row">
            <label class="nle-export-label">Quality</label>
            <select class="nle-export-preset-select nle-export-quality">
              ${QUALITY_OPTIONS.map(q => `<option value="${q}">${q.charAt(0).toUpperCase() + q.slice(1)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="nle-export-details">
          <div class="nle-export-detail-row">
            <span>Resolution:</span>
            <span class="nle-export-resolution">1920×1080</span>
          </div>
          <div class="nle-export-detail-row">
            <span>Format:</span>
            <span class="nle-export-format">MP4 (H.264)</span>
          </div>
          <div class="nle-export-detail-row">
            <span>Frame Rate:</span>
            <span class="nle-export-fps">30 fps</span>
          </div>
          <div class="nle-export-detail-row">
            <span>Rate Control:</span>
            <span class="nle-export-rate-control-detail">VBR</span>
          </div>
          <div class="nle-export-detail-row">
            <span>Source Range:</span>
            <span class="nle-export-range">${this._getSourceRangeText()}</span>
          </div>
          <div class="nle-export-detail-row">
            <span>Duration:</span>
            <span class="nle-export-duration">${this._getExportDurationText()}</span>
          </div>
        </div>
        <div class="nle-export-progress nle-hidden">
          <div class="nle-export-progress-bar">
            <div class="nle-export-progress-fill"></div>
          </div>
          <span class="nle-export-progress-text">Preparing...</span>
        </div>
      </div>
      <div class="nle-export-footer">
        <button class="nle-export-cancel-btn">Cancel</button>
        <button class="nle-export-start-btn">Export</button>
      </div>
    `;
  },

  _bindEvents() {
    const closeBtn = this._dialog.querySelector('.nle-export-close-btn');
    const cancelBtn = this._dialog.querySelector('.nle-export-cancel-btn');
    const startBtn = this._dialog.querySelector('.nle-export-start-btn');
    const presetSelect = this._dialog.querySelector('.nle-export-preset-picker');
    const bitrateMode = this._dialog.querySelector('.nle-export-bitrate-mode');
    const qualityRow = this._dialog.querySelector('.nle-export-quality-row');

    closeBtn?.addEventListener('click', () => this.hide());
    cancelBtn?.addEventListener('click', () => {
      if (exportPipeline.isExporting()) {
        exportPipeline.cancel();
      } else {
        this.hide();
      }
    });

    presetSelect?.addEventListener('change', () => this._updatePresetDetails());
    this._updatePresetDetails();

    // Toggle quality row visibility based on rate control mode
    bitrateMode?.addEventListener('change', () => {
      if (bitrateMode.value === 'constant') {
        qualityRow?.classList.add('nle-hidden');
      } else {
        qualityRow?.classList.remove('nle-hidden');
      }
      this._updateDetailRows();
    });

    startBtn?.addEventListener('click', () => this._startExport());

    // Close on overlay click
    this._overlay?.addEventListener('click', (e) => {
      if (e.target === this._overlay) this.hide();
    });
  },

  _getSourceRangeText() {
    const inPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT);
    const outPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT);
    if (inPoint !== null || outPoint !== null) {
      const inTc = frameToTimecode(inPoint ?? 0);
      const duration = timelineEngine.getDuration();
      const outTc = frameToTimecode(outPoint ?? duration);
      return `In/Out (${inTc} - ${outTc})`;
    }
    return 'Entire Sequence';
  },

  _getExportDurationText() {
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE);
    const duration = timelineEngine.getDuration();
    const inPoint = editorState.get(STATE_PATHS.PLAYBACK_IN_POINT) ?? 0;
    const outPoint = editorState.get(STATE_PATHS.PLAYBACK_OUT_POINT) ?? duration;
    const totalFrames = outPoint - inPoint;
    const seconds = totalFrames / fps;
    return `${frameToTimecode(totalFrames)} (${totalFrames} frames, ${seconds.toFixed(1)}s)`;
  },

  _updatePresetDetails() {
    const select = this._dialog.querySelector('.nle-export-preset-picker');
    const preset = getPreset(select.value);

    this._dialog.querySelector('.nle-export-resolution').textContent =
      `${preset.width}×${preset.height}`;
    this._dialog.querySelector('.nle-export-format').textContent =
      `${preset.format.toUpperCase()} (${preset.videoCodec || 'auto'})`;
    this._dialog.querySelector('.nle-export-fps').textContent =
      `${preset.fps} fps`;

    // Sync encoding controls from preset defaults
    const bitrateMode = this._dialog.querySelector('.nle-export-bitrate-mode');
    const bitrateSelect = this._dialog.querySelector('.nle-export-bitrate');
    const qualitySelect = this._dialog.querySelector('.nle-export-quality');
    const qualityRow = this._dialog.querySelector('.nle-export-quality-row');

    // Hide encoding controls entirely for codecs without bitrate (e.g., GIF)
    const encodingControls = this._dialog.querySelector('.nle-export-encoding-controls');
    if (!preset.videoCodec || !preset.videoBitrate) {
      encodingControls?.classList.add('nle-hidden');
    } else {
      encodingControls?.classList.remove('nle-hidden');
      if (bitrateMode) bitrateMode.value = preset.bitrateMode || 'variable';
      if (bitrateSelect) bitrateSelect.value = preset.videoBitrate;
      if (qualitySelect) qualitySelect.value = preset.quality || 'medium';

      // Show/hide quality row based on rate control
      if (bitrateMode?.value === 'constant') {
        qualityRow?.classList.add('nle-hidden');
      } else {
        qualityRow?.classList.remove('nle-hidden');
      }
    }

    this._updateDetailRows();
  },

  _updateDetailRows() {
    const bitrateMode = this._dialog.querySelector('.nle-export-bitrate-mode');
    const rateLabel = bitrateMode?.value === 'constant' ? 'CBR' : 'VBR';
    const rateRow = this._dialog.querySelector('.nle-export-rate-control-detail');
    if (rateRow) rateRow.textContent = rateLabel;
  },

  async _startExport() {
    const select = this._dialog.querySelector('.nle-export-preset-picker');
    const presetId = select.value;
    const preset = getPreset(presetId);

    // Collect encoding overrides from UI controls
    const bitrateMode = this._dialog.querySelector('.nle-export-bitrate-mode')?.value || 'variable';
    const videoBitrate = this._dialog.querySelector('.nle-export-bitrate')?.value || preset.videoBitrate;
    const quality = this._dialog.querySelector('.nle-export-quality')?.value || 'medium';
    const overrides = { bitrateMode, videoBitrate, quality };

    const progressEl = this._dialog.querySelector('.nle-export-progress');
    const progressFill = this._dialog.querySelector('.nle-export-progress-fill');
    const progressText = this._dialog.querySelector('.nle-export-progress-text');
    const startBtn = this._dialog.querySelector('.nle-export-start-btn');

    progressEl?.classList.remove('nle-hidden');
    startBtn.disabled = true;
    startBtn.textContent = 'Exporting...';

    try {
      const blob = await exportPipeline.export(presetId, ({ stage, progress, message }) => {
        if (progressFill) progressFill.style.width = `${Math.round(progress * 100)}%`;
        if (progressText) progressText.textContent = message;
      }, overrides);

      if (blob) {
        const projectName = editorState.get(STATE_PATHS.PROJECT_NAME) || 'export';
        const filename = `${projectName}.${preset.format}`;
        exportPipeline.download(blob, filename);
        if (progressText) progressText.textContent = 'Download started!';
      }
    } catch (err) {
      logger.error('Export error:', err);
      if (progressText) progressText.textContent = `Error: ${err.message}`;
    } finally {
      startBtn.disabled = false;
      startBtn.textContent = 'Export';
    }
  }
};

export default exportDialog;

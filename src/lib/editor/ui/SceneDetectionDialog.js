// Scene Edit Detection dialog — analyzes clip for cut points via histogram comparison
// @ts-check

/** @typedef {import('../media/SceneDetectionWorker.js').SDW_Request} SDW_Request */
/** @typedef {import('../media/SceneDetectionWorker.js').SDW_Response} SDW_Response */

import { timelineEngine } from '../timeline/TimelineEngine.js';
import { clipOperations } from '../timeline/ClipOperations.js';
import { mediaManager } from '../media/MediaManager.js';
import { metadataCache } from '../core/MetadataCache.js';
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { history } from '../core/History.js';
import { EDITOR_EVENTS, STATE_PATHS, MEDIA_TYPES } from '../core/Constants.js';
import { createClip, getClipDuration, getClipEndFrame } from '../timeline/Clip.js';
import { frameToTimecode, frameToSeconds } from '../timeline/TimelineMath.js';
import { markerManager, MARKER_COLORS } from '../timeline/Markers.js';
import { createDemuxer } from '../media/Demuxer.js';
import logger from '../../utils/logger.js';

export const sceneDetectionDialog = {
  _overlay: null,
  _dialog: null,
  _worker: null,
  _clipId: null,
  _results: null,
  _cancelled: false,

  show(clipId) {
    if (this._overlay) return;

    const clip = timelineEngine.getClip(clipId);
    if (!clip) return;

    const mediaItem = mediaManager.getItem(clip.mediaId);
    if (!mediaItem || mediaItem.type !== MEDIA_TYPES.VIDEO) return;

    this._clipId = clipId;
    this._results = null;
    this._cancelled = false;

    this._overlay = document.createElement('div');
    this._overlay.className = 'nle-sed-overlay';

    this._dialog = document.createElement('div');
    this._dialog.className = 'nle-sed-dialog';
    this._dialog.innerHTML = this._buildHTML(clip, mediaItem);
    this._overlay.appendChild(this._dialog);

    document.getElementById('video-editor')?.appendChild(this._overlay);

    this._bindEvents();
  },

  hide() {
    this._cancelWorker();

    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
      this._dialog = null;
    }

    this._clipId = null;
    this._results = null;
  },

  _buildHTML(clip, mediaItem) {
    const fps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;
    const duration = getClipDuration(clip);
    const durationTC = frameToTimecode(duration, fps);
    const durationSec = frameToSeconds(duration, fps).toFixed(1);
    const safeName = clip.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return `
      <div class="nle-sed-header">
        <h3>Scene Edit Detection</h3>
        <button class="nle-sed-close-btn" title="Close">&times;</button>
      </div>
      <div class="nle-sed-body">
        <div class="nle-sed-clip-info">
          ${safeName} &mdash; ${durationTC} (${durationSec}s)
        </div>

        <div class="nle-sed-section-label">Options</div>
        <div class="nle-sed-option">
          <input type="checkbox" id="nle-sed-opt-cuts" checked>
          <label for="nle-sed-opt-cuts">Apply cuts at detected edit points</label>
        </div>
        <div class="nle-sed-option">
          <input type="checkbox" id="nle-sed-opt-markers">
          <label for="nle-sed-opt-markers">Create markers at detected edit points</label>
        </div>

        <div class="nle-sed-sensitivity">
          <div class="nle-sed-section-label">Sensitivity</div>
          <div class="nle-sed-sensitivity-row">
            <span class="nle-sed-sensitivity-value">3</span>
            <input type="range" id="nle-sed-sensitivity" min="1" max="5" step="1" value="3">
          </div>
          <div class="nle-sed-sensitivity-labels">
            <span>More cuts</span>
            <span>Fewer cuts</span>
          </div>
        </div>

        <div class="nle-sed-progress" id="nle-sed-progress">
          <div class="nle-sed-progress-bar-track">
            <div class="nle-sed-progress-bar-fill" id="nle-sed-progress-fill"></div>
          </div>
          <div class="nle-sed-progress-text" id="nle-sed-progress-text">Preparing...</div>
        </div>

        <div class="nle-sed-results" id="nle-sed-results">
          <div class="nle-sed-results-summary" id="nle-sed-results-summary"></div>
          <div class="nle-sed-results-list" id="nle-sed-results-list"></div>
        </div>
      </div>
      <div class="nle-sed-actions">
        <button class="nle-sed-btn" id="nle-sed-cancel-btn">Cancel</button>
        <button class="nle-sed-btn nle-sed-btn-primary" id="nle-sed-detect-btn">Detect</button>
      </div>
    `;
  },

  _bindEvents() {
    const closeBtn = this._dialog.querySelector('.nle-sed-close-btn');
    const cancelBtn = this._dialog.querySelector('#nle-sed-cancel-btn');
    const detectBtn = this._dialog.querySelector('#nle-sed-detect-btn');
    const slider = this._dialog.querySelector('#nle-sed-sensitivity');
    const valueLabel = this._dialog.querySelector('.nle-sed-sensitivity-value');

    closeBtn?.addEventListener('click', () => this.hide());
    cancelBtn?.addEventListener('click', () => {
      if (this._worker) {
        this._cancelWorker();
        this._resetToOptions();
      } else {
        this.hide();
      }
    });
    detectBtn?.addEventListener('click', () => this._onDetectClick());

    slider?.addEventListener('input', () => {
      if (valueLabel) valueLabel.textContent = slider.value;
    });

    // Close on overlay click (outside dialog)
    this._overlay?.addEventListener('click', e => {
      if (e.target === this._overlay) this.hide();
    });
  },

  _resetToOptions() {
    this._results = null;

    const progress = this._dialog?.querySelector('#nle-sed-progress');
    const results = this._dialog?.querySelector('#nle-sed-results');
    const detectBtn = this._dialog?.querySelector('#nle-sed-detect-btn');

    if (progress) progress.classList.remove('active');
    if (results) results.classList.remove('active');
    if (detectBtn) {
      detectBtn.textContent = 'Detect';
      detectBtn.disabled = false;
    }
  },

  async _onDetectClick() {
    const detectBtn = this._dialog?.querySelector('#nle-sed-detect-btn');

    // If results are showing, this is the "Apply" button
    if (this._results) {
      this._applyResults();
      return;
    }

    const clip = timelineEngine.getClip(this._clipId);
    if (!clip) return;

    const mediaItem = mediaManager.getItem(clip.mediaId);
    if (!mediaItem) return;

    // Show progress
    const progress = this._dialog?.querySelector('#nle-sed-progress');
    if (progress) progress.classList.add('active');
    if (detectBtn) {
      detectBtn.disabled = true;
      detectBtn.textContent = 'Detecting...';
    }

    try {
      await this._startDetection(clip, mediaItem);
    } catch (err) {
      logger.error('[SceneDetection] Detection failed:', err);
      this._showError(err.message || 'Detection failed');
    }
  },

  async _startDetection(clip, mediaItem) {
    // Get codec config and samples from cache or re-demux
    const { codecConfig, samples, fps } = await this._getMediaMetadata(mediaItem);

    if (!codecConfig || !samples || samples.length === 0) {
      throw new Error('Could not read video metadata');
    }

    // Map sensitivity slider (1-5) to algorithm parameter (1.0-4.0)
    const slider = this._dialog?.querySelector('#nle-sed-sensitivity');
    const sliderValue = slider ? parseInt(slider.value) : 3;
    const sensitivity = sliderValue * 0.75 + 0.25;

    // Filter samples to clip's source range
    const sourceInUs = (clip.sourceInFrame / fps) * 1000000;
    const sourceOutUs = (clip.sourceOutFrame / fps) * 1000000;

    // Find the relevant samples (include full GOPs)
    let startIdx = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].type === 'key' && samples[i].timestamp <= sourceInUs) {
        startIdx = i;
        break;
      }
    }
    let endIdx = samples.length - 1;
    for (let i = startIdx; i < samples.length; i++) {
      if (samples[i].timestamp > sourceOutUs) {
        endIdx = i;
        break;
      }
    }

    const relevantSamples = samples.slice(startIdx, endIdx + 1);

    // Create worker
    this._cancelled = false;
    this._worker = new Worker(new URL('../media/SceneDetectionWorker.js', import.meta.url), {
      type: 'module'
    });

    this._worker.onmessage = e => {
      const { type } = e.data;

      if (type === 'progress') {
        this._onProgress(e.data);
      } else if (type === 'complete') {
        this._onComplete(e.data, clip, fps);
      } else if (type === 'error') {
        this._showError(e.data.message);
      }
    };

    this._worker.onerror = err => {
      logger.error('[SceneDetection] Worker error:', err);
      this._showError('Worker crashed unexpectedly');
    };

    // Prepare codec config — ensure description is transferable
    const config = { ...codecConfig };
    if (config.description && !(config.description instanceof Uint8Array)) {
      config.description = new Uint8Array(config.description);
    }

    this._worker.postMessage({
      type: 'analyze',
      file: mediaItem.file,
      codecConfig: config,
      samples: relevantSamples,
      fps,
      sensitivity,
      totalFrames: relevantSamples.length
    });
  },

  async _getMediaMetadata(mediaItem) {
    // Try cache first
    if (mediaItem.file) {
      const cached = await metadataCache.get(mediaItem.file);
      if (cached && cached.chunkMetas && cached.videoConfig && cached.trackInfo) {
        const config = { ...cached.videoConfig };
        if (cached.videoConfig.description) {
          config.description = new Uint8Array(cached.videoConfig.description);
        }
        return {
          codecConfig: config,
          samples: cached.chunkMetas,
          fps: cached.trackInfo.frameRate || 30
        };
      }
    }

    // Re-demux if not cached
    const demuxer = createDemuxer();
    const metas = [];
    let config = null;

    await demuxer.init(mediaItem.file || mediaItem.url, {
      onVideoConfig(cfg) {
        config = cfg;
      },
      onVideoChunk(chunk, sample) {
        metas.push({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          offset: sample.offset,
          size: sample.size
        });
      }
    });

    const trackInfo = demuxer.getVideoTrackInfo();
    demuxer.cleanup();

    return {
      codecConfig: config,
      samples: metas,
      fps: trackInfo?.frameRate || 30
    };
  },

  _onProgress(data) {
    const fill = this._dialog?.querySelector('#nle-sed-progress-fill');
    const text = this._dialog?.querySelector('#nle-sed-progress-text');

    if (fill) fill.style.width = `${Math.round(data.percent)}%`;
    if (text) {
      text.textContent = `Analyzing... ${Math.round(data.percent)}% — ${data.cutsFound} edit point${data.cutsFound !== 1 ? 's' : ''} found`;
    }
  },

  _onComplete(data, clip, fps) {
    this._cancelWorker();

    const seqFps = editorState.get(STATE_PATHS.PROJECT_FRAME_RATE) || 30;

    // Convert worker frame indices (source-relative) to timeline frames
    const results = (data.cuts || [])
      .filter(cut => {
        // Only keep cuts within the clip's source range
        const sourceFrame = Math.round(cut.time * fps);
        return sourceFrame > clip.sourceInFrame && sourceFrame < clip.sourceOutFrame;
      })
      .map(cut => {
        const sourceFrame = Math.round(cut.time * fps);
        // Convert source frame to timeline frame
        const timelineFrame =
          clip.startFrame + Math.round((sourceFrame - clip.sourceInFrame) / clip.speed);
        return {
          sourceFrame,
          timelineFrame,
          time: cut.time,
          confidence: cut.confidence
        };
      })
      .filter(r => r.timelineFrame > clip.startFrame && r.timelineFrame < getClipEndFrame(clip));

    this._results = results;
    this._showResults(results, seqFps);
  },

  _showResults(results, fps) {
    const progress = this._dialog?.querySelector('#nle-sed-progress');
    const resultsEl = this._dialog?.querySelector('#nle-sed-results');
    const summary = this._dialog?.querySelector('#nle-sed-results-summary');
    const list = this._dialog?.querySelector('#nle-sed-results-list');
    const detectBtn = this._dialog?.querySelector('#nle-sed-detect-btn');

    if (progress) progress.classList.remove('active');
    if (resultsEl) resultsEl.classList.add('active');

    if (summary) {
      summary.textContent =
        results.length === 0
          ? 'No edit points detected.'
          : `Found ${results.length} edit point${results.length !== 1 ? 's' : ''}:`;
    }

    if (list) {
      if (results.length === 0) {
        list.innerHTML =
          '<div class="nle-sed-no-results">No scene changes were detected in this clip.</div>';
      } else {
        list.innerHTML = results
          .map(
            (r, i) => `
          <div class="nle-sed-result-item">
            <span class="nle-sed-result-num">#${i + 1}</span>
            <span class="nle-sed-result-time">${frameToTimecode(r.timelineFrame, fps)}</span>
            <span class="nle-sed-result-confidence">${Math.round(r.confidence * 100)}%</span>
          </div>
        `
          )
          .join('');
      }
    }

    if (detectBtn) {
      if (results.length > 0) {
        detectBtn.textContent = 'Apply';
        detectBtn.disabled = false;
      } else {
        detectBtn.textContent = 'Close';
        detectBtn.disabled = false;
        detectBtn.onclick = () => this.hide();
      }
    }
  },

  _showError(message) {
    this._cancelWorker();

    const text = this._dialog?.querySelector('#nle-sed-progress-text');
    const fill = this._dialog?.querySelector('#nle-sed-progress-fill');
    const detectBtn = this._dialog?.querySelector('#nle-sed-detect-btn');

    if (text) text.textContent = `Error: ${message}`;
    if (fill) fill.style.width = '0%';
    if (detectBtn) {
      detectBtn.textContent = 'Retry';
      detectBtn.disabled = false;
      this._results = null; // Allow retry
    }
  },

  _applyResults() {
    if (!this._results || this._results.length === 0) {
      this.hide();
      return;
    }

    const clip = timelineEngine.getClip(this._clipId);
    if (!clip) {
      this.hide();
      return;
    }

    const optCuts = this._dialog?.querySelector('#nle-sed-opt-cuts')?.checked;
    const optMarkers = this._dialog?.querySelector('#nle-sed-opt-markers')?.checked;

    if (!optCuts && !optMarkers) {
      this.hide();
      return;
    }

    // Use snapshot-based undo for the entire operation (atomic undo for all cuts + markers)
    const allTrackIds = timelineEngine.getTracks().map(t => t.id);
    const beforeSnapshot = clipOperations.snapshotTracks(allTrackIds);
    const markersBefore = markerManager.getAllMarkers().map(m => ({ ...m }));

    if (optMarkers) {
      const ascending = [...this._results].sort((a, b) => a.timelineFrame - b.timelineFrame);
      for (let i = 0; i < ascending.length; i++) {
        markerManager._addMarkerDirect(
          ascending[i].timelineFrame,
          `Scene ${i + 1}`,
          MARKER_COLORS.CYAN
        );
      }
    }

    if (optCuts) {
      // Sort descending — split right-to-left so frame positions remain valid
      const sorted = [...this._results].sort((a, b) => b.timelineFrame - a.timelineFrame);

      const currentClipId = this._clipId;
      let splitCount = 0;

      for (const r of sorted) {
        const currentClip = timelineEngine.getClip(currentClipId);
        if (!currentClip) continue;

        const endFrame = getClipEndFrame(currentClip);
        if (r.timelineFrame <= currentClip.startFrame || r.timelineFrame >= endFrame) {
          continue;
        }

        // Direct split — bypass history (we handle undo via snapshot below)
        const track = timelineEngine.getTrack(currentClip.trackId);
        if (!track) continue;

        const offsetInClip = r.timelineFrame - currentClip.startFrame;
        const splitSourceFrame =
          currentClip.sourceInFrame + Math.round(offsetInClip * currentClip.speed);
        const oldSourceOut = currentClip.sourceOutFrame;

        // Trim original to left portion
        currentClip.sourceOutFrame = splitSourceFrame;

        // Create right portion
        const newClip = createClip({
          mediaId: currentClip.mediaId,
          trackId: currentClip.trackId,
          name: currentClip.name,
          startFrame: r.timelineFrame,
          sourceInFrame: splitSourceFrame,
          sourceOutFrame: oldSourceOut,
          speed: currentClip.speed,
          color: currentClip.color,
          volume: currentClip.volume,
          effects: JSON.parse(JSON.stringify(currentClip.effects || []))
        });

        track.clips.push(newClip);
        track.clips.sort((a, b) => a.startFrame - b.startFrame);

        // Also split linked audio clip at same frame
        if (currentClip.linkedClipId) {
          const linkedClip = timelineEngine.getClip(currentClip.linkedClipId);
          if (linkedClip) {
            const linkedTrack = timelineEngine.getTrack(linkedClip.trackId);
            if (linkedTrack) {
              const linkedSplitSource =
                linkedClip.sourceInFrame +
                Math.round((r.timelineFrame - linkedClip.startFrame) * linkedClip.speed);
              const linkedOldOut = linkedClip.sourceOutFrame;

              // Only split linked clip if split point is within its source range
              if (
                linkedSplitSource > linkedClip.sourceInFrame &&
                linkedSplitSource < linkedOldOut
              ) {
                linkedClip.sourceOutFrame = linkedSplitSource;

                const newLinkedClip = createClip({
                  mediaId: linkedClip.mediaId,
                  trackId: linkedClip.trackId,
                  name: linkedClip.name,
                  startFrame: r.timelineFrame,
                  sourceInFrame: linkedSplitSource,
                  sourceOutFrame: linkedOldOut,
                  speed: linkedClip.speed,
                  color: linkedClip.color,
                  volume: linkedClip.volume,
                  effects: JSON.parse(JSON.stringify(linkedClip.effects || []))
                });

                linkedTrack.clips.push(newLinkedClip);
                linkedTrack.clips.sort((a, b) => a.startFrame - b.startFrame);

                // Re-link halves
                currentClip.linkedClipId = linkedClip.id;
                linkedClip.linkedClipId = currentClip.id;
                newClip.linkedClipId = newLinkedClip.id;
                newLinkedClip.linkedClipId = newClip.id;
              }
            }
          }
        }

        splitCount++;
        // currentClipId stays the same — it's the left portion for the next iteration
      }

      logger.info(`[SceneDetection] Split into ${splitCount + 1} clips`);
    }

    // Push snapshot-based undo (all mutations already applied)
    const currentTrackIds = timelineEngine.getTracks().map(t => t.id);
    const afterSnapshot = clipOperations.snapshotTracks(currentTrackIds);
    const markersAfter = markerManager.getAllMarkers().map(m => ({ ...m }));

    history.pushWithoutExecute({
      description: `Scene Edit Detection: ${this._results.length} edits`,
      execute() {
        clipOperations.restoreTracksFromSnapshot(afterSnapshot);
        // Restore markers to after state
        markerManager._clearAllMarkersDirect();
        for (const m of markersAfter) markerManager._addMarkerDirect(m.frame, m.name, m.color);
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      },
      undo() {
        clipOperations.restoreTracksFromSnapshot(beforeSnapshot);
        // Restore markers to before state
        markerManager._clearAllMarkersDirect();
        for (const m of markersBefore) markerManager._addMarkerDirect(m.frame, m.name, m.color);
        timelineEngine._recalcDuration();
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      }
    });

    timelineEngine._recalcDuration();
    eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);

    logger.info(
      `[SceneDetection] Applied ${this._results.length} edit points (cuts: ${optCuts}, markers: ${optMarkers})`
    );
    this.hide();
  },

  _cancelWorker() {
    if (this._worker) {
      this._cancelled = true;
      try {
        this._worker.postMessage({ type: 'cancel' });
      } catch (_) {
        /* worker may already be dead */
      }
      this._worker.terminate();
      this._worker = null;
    }
  }
};

export default sceneDetectionDialog;

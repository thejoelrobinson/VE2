// Media browser with thumbnails and drag-to-timeline + sequence list
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, MEDIA_TYPES, TRACK_TYPES, CANVAS_PRESETS, FRAME_RATES, SEQUENCE_CODECS, SEQUENCE_BITRATE_OPTIONS } from '../core/Constants.js';
import { mediaManager } from '../media/MediaManager.js';
import { thumbnailGenerator } from '../media/ThumbnailGenerator.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { createTrack } from '../timeline/Track.js';
import { contextMenu } from './ContextMenu.js';
import { sourceMonitor } from './SourceMonitor.js';
import { waveformGenerator } from '../media/WaveformGenerator.js';

export const projectPanel = {
  _container: null,
  _seqListEl: null,
  _listEl: null,

  init(container) {
    this._container = container;

    // Import button
    const importBtn = container.querySelector('.nle-import-btn');
    if (importBtn) {
      importBtn.addEventListener('click', () => this._handleImport());
    }

    // Sequence list
    this._seqListEl = container.querySelector('.nle-sequence-list');
    if (!this._seqListEl) {
      // Create sequence section dynamically if not in HTML template
      const seqSection = document.createElement('div');
      seqSection.className = 'nle-sequence-section';

      const seqHeader = document.createElement('div');
      seqHeader.className = 'nle-section-header';
      const seqLabel = document.createElement('span');
      seqLabel.textContent = 'Sequences';
      seqHeader.appendChild(seqLabel);

      const newSeqBtn = document.createElement('button');
      newSeqBtn.className = 'nle-new-seq-btn';
      newSeqBtn.title = 'New Sequence';
      newSeqBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      newSeqBtn.addEventListener('click', () => this._showNewSequenceDialog());
      seqHeader.appendChild(newSeqBtn);

      seqSection.appendChild(seqHeader);

      this._seqListEl = document.createElement('div');
      this._seqListEl.className = 'nle-sequence-list';
      seqSection.appendChild(this._seqListEl);

      // Divider
      const divider = document.createElement('div');
      divider.className = 'nle-section-divider';
      seqSection.appendChild(divider);

      // Insert sequence section at the top of container, before media list
      const mediaList = container.querySelector('.nle-media-list');
      if (mediaList) {
        container.insertBefore(seqSection, mediaList);
      } else {
        container.appendChild(seqSection);
      }
    }

    // Media list
    this._listEl = container.querySelector('.nle-media-list');

    // Drop zone for files
    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      container.classList.add('nle-drag-over');
    });
    container.addEventListener('dragleave', () => {
      container.classList.remove('nle-drag-over');
    });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.classList.remove('nle-drag-over');
      if (e.dataTransfer.files.length > 0) {
        this._importFiles(e.dataTransfer.files);
      }
    });

    // Listen for media changes
    eventBus.on(EDITOR_EVENTS.MEDIA_IMPORTED, () => this._renderMedia());
    eventBus.on(EDITOR_EVENTS.MEDIA_REMOVED, () => this._renderMedia());
    eventBus.on(EDITOR_EVENTS.MEDIA_THUMBNAILS_READY, () => this._renderMedia());
    eventBus.on(EDITOR_EVENTS.IMPORT_PARTIAL, ({ failedFiles }) => this._onImportPartial(failedFiles));
    // MXF: retry waveform generation once audio extraction completes in background
    eventBus.on(EDITOR_EVENTS.MEDIA_AUDIO_READY, ({ item }) => {
      if (item && !item.waveform) {
        waveformGenerator.generateWaveform(item).then(() => this._renderMedia());
      }
    });

    // Listen for sequence changes
    eventBus.on(EDITOR_EVENTS.SEQUENCE_CREATED, () => this._renderSequences());
    eventBus.on(EDITOR_EVENTS.SEQUENCE_DELETED, () => this._renderSequences());
    eventBus.on(EDITOR_EVENTS.SEQUENCE_ACTIVATED, () => this._renderSequences());

    this._renderSequences();
    this._renderMedia();
  },

  async _handleImport() {
    await mediaManager.openFilePicker();
    // Generate thumbnails and waveforms for newly imported items
    for (const item of mediaManager.getAllItems()) {
      if (item.thumbnails.length === 0) {
        thumbnailGenerator.generateThumbnails(item);
      }
      if (!item.waveform && (item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.AUDIO)) {
        waveformGenerator.generateWaveform(item);
      }
    }
  },

  async _importFiles(fileList) {
    const items = await mediaManager.importFiles(fileList);
    for (const item of items) {
      thumbnailGenerator.generateThumbnails(item);
      if (item.type === MEDIA_TYPES.VIDEO || item.type === MEDIA_TYPES.AUDIO) {
        waveformGenerator.generateWaveform(item);
      }
    }
  },

  _onImportPartial(failedFiles) {
    if (!failedFiles || failedFiles.length === 0) return;
    const list = failedFiles.join('\n  • ');
    alert(`Could not import ${failedFiles.length} file${failedFiles.length > 1 ? 's' : ''} (unsupported format):\n\n  • ${list}`);
  },

  // --- Sequence list rendering ---

  _renderSequences() {
    if (!this._seqListEl) return;
    const sequences = editorState.getAllSequences();
    const activeId = editorState.getActiveSequenceId();

    this._seqListEl.innerHTML = '';
    for (const seq of sequences) {
      const el = this._createSequenceItem(seq, seq.id === activeId);
      this._seqListEl.appendChild(el);
    }
  },

  _createSequenceItem(seq, isActive) {
    const el = document.createElement('div');
    el.className = 'nle-sequence-item' + (isActive ? ' active' : '');
    el.dataset.seqId = seq.id;

    // Icon
    const icon = document.createElement('div');
    icon.className = 'nle-seq-icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/><line x1="2" y1="15" x2="22" y2="15"/></svg>';
    el.appendChild(icon);

    // Info
    const info = document.createElement('div');
    info.className = 'nle-seq-item-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'nle-seq-item-name';
    nameEl.textContent = seq.name;
    info.appendChild(nameEl);

    const metaEl = document.createElement('span');
    metaEl.className = 'nle-seq-item-meta';
    metaEl.textContent = `${seq.canvas.width}x${seq.canvas.height} ${seq.frameRate}fps`;
    info.appendChild(metaEl);

    el.appendChild(info);

    // Double-click to activate
    el.addEventListener('dblclick', () => {
      timelineEngine.switchSequence(seq.id);
    });

    // Context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const items = [
        { label: 'Open', action: () => timelineEngine.switchSequence(seq.id) },
        { separator: true },
        { label: 'Rename...', action: () => this._renameSequence(seq.id) },
        { label: 'Duplicate', action: () => this._duplicateSequence(seq.id) },
        { separator: true },
        {
          label: 'Delete',
          disabled: editorState.getAllSequences().length <= 1,
          action: () => {
            if (confirm(`Delete "${seq.name}"?`)) {
              editorState.deleteSequence(seq.id);
            }
          }
        }
      ];
      contextMenu.show(e.clientX, e.clientY, items);
    });

    return el;
  },

  _renameSequence(seqId) {
    const seq = editorState.getSequence(seqId);
    if (!seq) return;
    const newName = prompt('Rename sequence:', seq.name);
    if (newName && newName.trim() && newName.trim() !== seq.name) {
      seq.name = newName.trim();
      editorState.markDirty();
      // Re-render locally since sequence name isn't an observable path
      this._renderSequences();
    }
  },

  _duplicateSequence(seqId) {
    const seq = editorState.getSequence(seqId);
    if (!seq) return;
    const newSeq = editorState.createSequence({
      name: `${seq.name} (Copy)`,
      frameRate: seq.frameRate,
      canvas: { ...seq.canvas },
      codec: seq.codec,
      bitrate: seq.bitrate
    });
    // Deep copy tracks using createTrack for proper structure
    newSeq.tracks = seq.tracks.map(srcTrack => {
      const track = createTrack({
        name: srcTrack.name,
        type: srcTrack.type,
        height: srcTrack.height
      });
      track.muted = srcTrack.muted;
      track.solo = srcTrack.solo;
      track.locked = srcTrack.locked;
      track.clips = srcTrack.clips.map(srcClip => ({
        ...JSON.parse(JSON.stringify(srcClip)),
        id: `clip-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        trackId: track.id,
        linkedClipId: null
      }));
      return track;
    });
    newSeq.duration = seq.duration;
  },

  _showNewSequenceDialog() {
    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.className = 'nle-seq-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'nle-seq-dialog';

    dialog.innerHTML = `
      <div class="nle-seq-dialog-title">New Sequence</div>
      <div class="nle-seq-dialog-body">
        <label class="nle-seq-dialog-label">Name
          <input type="text" class="nle-seq-dialog-input" value="Sequence ${editorState.getState().project.nextSequenceId}" />
        </label>
        <label class="nle-seq-dialog-label">Resolution
          <select class="nle-seq-dialog-select nle-seq-dialog-res"></select>
        </label>
        <label class="nle-seq-dialog-label">Frame Rate
          <select class="nle-seq-dialog-select nle-seq-dialog-fps"></select>
        </label>
        <label class="nle-seq-dialog-label">Codec
          <select class="nle-seq-dialog-select nle-seq-dialog-codec"></select>
        </label>
        <label class="nle-seq-dialog-label">Bitrate
          <select class="nle-seq-dialog-select nle-seq-dialog-bitrate"></select>
        </label>
      </div>
      <div class="nle-seq-dialog-actions">
        <button class="nle-seq-dialog-btn cancel">Cancel</button>
        <button class="nle-seq-dialog-btn ok">Create</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Populate selects
    const resSelect = dialog.querySelector('.nle-seq-dialog-res');
    for (const [key, preset] of Object.entries(CANVAS_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = preset.label;
      resSelect.appendChild(opt);
    }

    const fpsSelect = dialog.querySelector('.nle-seq-dialog-fps');
    for (const fps of Object.values(FRAME_RATES)) {
      const opt = document.createElement('option');
      opt.value = fps;
      opt.textContent = `${fps} fps`;
      if (fps === 30) opt.selected = true;
      fpsSelect.appendChild(opt);
    }

    const codecSelect = dialog.querySelector('.nle-seq-dialog-codec');
    for (const [label, value] of [['H.264 High', SEQUENCE_CODECS.H264], ['VP9', SEQUENCE_CODECS.VP9]]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      codecSelect.appendChild(opt);
    }

    const bitrateSelect = dialog.querySelector('.nle-seq-dialog-bitrate');
    for (const br of SEQUENCE_BITRATE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = br;
      const num = br.replace(/[mMkK]$/, '');
      const unit = br.endsWith('M') || br.endsWith('m') ? 'Mbps' : 'Kbps';
      opt.textContent = `${num} ${unit}`;
      if (br === '8M') opt.selected = true;
      bitrateSelect.appendChild(opt);
    }

    const nameInput = dialog.querySelector('.nle-seq-dialog-input');
    nameInput.focus();
    nameInput.select();

    const close = () => overlay.remove();

    dialog.querySelector('.cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    dialog.querySelector('.ok').addEventListener('click', () => {
      const resKey = resSelect.value;
      const preset = CANVAS_PRESETS[resKey];
      const canvas = preset ? { width: preset.width, height: preset.height } : { width: 1920, height: 1080 };

      const seq = editorState.createSequence({
        name: nameInput.value.trim() || 'Untitled Sequence',
        frameRate: parseInt(fpsSelect.value),
        canvas,
        codec: codecSelect.value,
        bitrate: bitrateSelect.value
      });

      // Initialize with default V1+A1 tracks
      seq.tracks = [
        createTrack({ name: 'V1', type: TRACK_TYPES.VIDEO }),
        createTrack({ name: 'A1', type: TRACK_TYPES.AUDIO })
      ];

      close();

      // Auto-activate the new sequence
      timelineEngine.switchSequence(seq.id);
    });

    // Enter to create
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dialog.querySelector('.ok').click();
      if (e.key === 'Escape') close();
    });
  },

  // --- Media list rendering ---

  _renderMedia() {
    if (!this._listEl) return;
    const items = mediaManager.getAllItems();

    if (items.length === 0) {
      this._listEl.innerHTML = `
        <div class="nle-media-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span>Import media or drag files here</span>
        </div>`;
      return;
    }

    this._listEl.innerHTML = '';
    for (const item of items) {
      const el = this._createMediaItem(item);
      this._listEl.appendChild(el);
    }
  },

  _createMediaItem(item) {
    const el = document.createElement('div');
    el.className = 'nle-media-item';
    el.draggable = true;
    el.dataset.mediaId = item.id;

    // Thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'nle-media-thumb';
    if (item.thumbnails.length > 0) {
      thumb.style.backgroundImage = `url(${item.thumbnails[0].url})`;
    } else {
      // Icon based on type
      const icon = item.type === MEDIA_TYPES.AUDIO ? '\uD83C\uDFB5' :
                   item.type === MEDIA_TYPES.IMAGE ? '\uD83D\uDDBC' : '\uD83C\uDFAC';
      thumb.textContent = icon;
    }
    el.appendChild(thumb);

    // Info
    const info = document.createElement('div');
    info.className = 'nle-media-info';
    info.innerHTML = `
      <span class="nle-media-name" title="${item.name}">${item.name}</span>
      <span class="nle-media-duration">${this._formatDuration(item.duration)}</span>
    `;
    el.appendChild(info);

    // Drag start - carry media ID
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-nle-media', item.id);
      e.dataTransfer.effectAllowed = 'copy';
    });

    // Double-click to open in Source Monitor
    el.addEventListener('dblclick', () => {
      sourceMonitor.loadMedia(item.id);
    });

    // Context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      contextMenu.show(e.clientX, e.clientY, [
        { label: 'Add to Timeline', action: () => this._addToTimeline(item) },
        { separator: true },
        { label: 'Properties', action: () => {
          const info = [
            `Name: ${item.name}`,
            `Type: ${item.type}`,
            `Duration: ${this._formatDuration(item.duration)}`,
            item.width ? `Resolution: ${item.width}x${item.height}` : null
          ].filter(Boolean).join('\n');
          alert(info);
        }},
        { separator: true },
        { label: 'Remove from Project', action: () => mediaManager.removeItem(item.id) }
      ]);
    });

    return el;
  },

  _addToTimeline(item) {
    const tracks = timelineEngine.getTracks();
    const targetType = item.type === MEDIA_TYPES.AUDIO ? TRACK_TYPES.AUDIO : TRACK_TYPES.VIDEO;
    let track = tracks.find(t => t.type === targetType);
    if (!track) {
      track = timelineEngine.addTrack(targetType);
    }
    // Find end of last clip on this track (or use playhead)
    const lastClip = track.clips[track.clips.length - 1];
    const startFrame = lastClip
      ? lastClip.startFrame + Math.round((lastClip.sourceOutFrame - lastClip.sourceInFrame) / lastClip.speed)
      : 0;

    // Video clips get linked audio (Premiere-style)
    if (item.type === MEDIA_TYPES.VIDEO) {
      timelineEngine.addClipWithLinkedAudio(item, startFrame);
    } else {
      timelineEngine.addClip(track.id, item, startFrame);
    }
  },

  _formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return '\u2014';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
};

export default projectPanel;

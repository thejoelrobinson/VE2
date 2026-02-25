// File, Edit, Clip, Sequence, Window menus
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { history } from '../core/History.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { clipOperations } from '../timeline/ClipOperations.js';
import { mediaManager } from '../media/MediaManager.js';
import { projectManager } from '../project/ProjectManager.js';
import { exportDialog } from './ExportDialog.js';
import { playbackEngine } from '../playback/PlaybackEngine.js';
import { markerManager } from '../timeline/Markers.js';
import { indexedDBImporter } from '../media/IndexedDBImporter.js';
import { TRACK_TYPES, EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { dockManager } from './DockManager.js';
import { sceneDetectionDialog } from './SceneDetectionDialog.js';

const MENU_DEFS = [
  {
    label: 'File',
    items: [
      { label: 'New Project', shortcut: 'Ctrl+N', action: 'file:new' },
      { type: 'divider' },
      { label: 'Import Media...', shortcut: 'Ctrl+I', action: 'file:import' },
      { label: 'Import from Recordings...', action: 'file:import-recordings' },
      { type: 'divider' },
      { label: 'Save Project', shortcut: 'Ctrl+S', action: 'file:save' },
      { label: 'Load Project...', action: 'file:load' },
      { type: 'divider' },
      { label: 'Export...', shortcut: 'Ctrl+E', action: 'file:export' }
    ]
  },
  {
    label: 'Edit',
    items: [
      { label: 'Undo', shortcut: 'Ctrl+Z', action: 'edit:undo' },
      { label: 'Redo', shortcut: 'Ctrl+Shift+Z', action: 'edit:redo' },
      { type: 'divider' },
      { label: 'Delete', shortcut: 'Delete', action: 'edit:delete' },
      { label: 'Select All', shortcut: 'Ctrl+A', action: 'edit:select-all' },
      { label: 'Deselect All', shortcut: 'Ctrl+D', action: 'edit:deselect' }
    ]
  },
  {
    label: 'Clip',
    items: [
      { label: 'Split at Playhead', shortcut: 'Ctrl+K', action: 'clip:split' },
      { type: 'divider' },
      { label: 'Speed/Duration...', action: 'clip:speed' },
      { label: 'Enable/Disable', action: 'clip:toggle-disable' },
      { type: 'divider' },
      { label: 'Scene Edit Detection...', action: 'clip:scene-detect' }
    ]
  },
  {
    label: 'Sequence',
    items: [
      { label: 'Add Video Track', action: 'seq:add-video' },
      { label: 'Add Audio Track', action: 'seq:add-audio' },
      { type: 'divider' },
      { label: 'Add Marker', shortcut: 'M', action: 'seq:add-marker' },
      { label: 'Clear In/Out', action: 'seq:clear-io' },
      { type: 'divider' },
      { label: 'Toggle Snap', shortcut: 'S', action: 'seq:toggle-snap' }
    ]
  },
  {
    label: 'Window',
    items: [
      { label: 'Source Monitor', action: 'win:source', checkable: 'source-monitor' },
      { label: 'Program Monitor', action: 'win:program', checkable: 'program-monitor' },
      { label: 'Project Panel', action: 'win:project', checkable: 'project' },
      { label: 'Effects Panel', action: 'win:effects', checkable: 'effects' },
      { label: 'Properties Panel', action: 'win:properties', checkable: 'properties' },
      { label: 'Essential Audio', action: 'win:essential-audio', checkable: 'essential-audio' },
      { label: 'Lumetri Color', action: 'win:lumetri', checkable: 'lumetri-color' },
      { label: 'Audio Meters', action: 'win:audio-meters', checkable: 'audio-meters' },
      { type: 'divider' },
      { label: 'Workspaces', type: 'submenu', items: [
        { label: 'Editing', action: 'win:workspace:editing' },
        { label: 'Color', action: 'win:workspace:color' },
        { label: 'Audio', action: 'win:workspace:audio' }
      ]},
      { type: 'divider' },
      { label: 'Reset Layout', action: 'win:reset' }
    ]
  }
];

export const menuBar = {
  _container: null,
  _openMenu: null,

  init(container) {
    if (!container) {
      this._container = document.querySelector('.nle-menubar');
    } else {
      this._container = container;
    }
    if (!this._container) return;

    this._render();

    // Close menus on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nle-menubar')) {
        this._closeAll();
      }
    });
  },

  _render() {
    if (!this._container) return;
    this._container.innerHTML = '';

    for (const menu of MENU_DEFS) {
      const item = document.createElement('div');
      item.className = 'nle-menu-item';

      const trigger = document.createElement('button');
      trigger.className = 'nle-menu-trigger';
      trigger.textContent = menu.label;
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleMenu(item, menu);
      });
      trigger.addEventListener('mouseenter', () => {
        if (this._openMenu && this._openMenu !== item) {
          this._closeAll();
          this._showMenu(item, menu);
        }
      });
      item.appendChild(trigger);

      this._container.appendChild(item);
    }
  },

  _toggleMenu(itemEl, menuDef) {
    if (this._openMenu === itemEl) {
      this._closeAll();
    } else {
      this._closeAll();
      this._showMenu(itemEl, menuDef);
    }
  },

  _showMenu(itemEl, menuDef) {
    const dropdown = document.createElement('div');
    dropdown.className = 'nle-menu-dropdown';

    for (const entry of menuDef.items) {
      if (entry.type === 'divider') {
        const div = document.createElement('div');
        div.className = 'nle-menu-divider';
        dropdown.appendChild(div);
        continue;
      }

      if (entry.type === 'submenu' && entry.items) {
        const row = document.createElement('div');
        row.className = 'nle-menu-dropdown-item nle-menu-submenu-trigger';
        row.innerHTML = `<span>${entry.label}</span><span class="nle-menu-arrow">\u25B6</span>`;
        const submenu = document.createElement('div');
        submenu.className = 'nle-menu-dropdown nle-menu-submenu';
        for (const sub of entry.items) {
          const subRow = document.createElement('div');
          subRow.className = 'nle-menu-dropdown-item';
          subRow.innerHTML = `<span>${sub.label}</span>`;
          subRow.addEventListener('click', () => {
            this._closeAll();
            this._executeAction(sub.action);
          });
          submenu.appendChild(subRow);
        }
        row.appendChild(submenu);
        dropdown.appendChild(row);
        continue;
      }

      const row = document.createElement('div');
      row.className = 'nle-menu-dropdown-item';
      const checked = entry.checkable ? dockManager.isPanelVisible(entry.checkable) : false;
      const checkMark = entry.checkable ? `<span class="nle-menu-check">${checked ? '\u2713' : '\u00A0\u00A0'}</span>` : '';
      row.innerHTML = `
        ${checkMark}<span>${entry.label}</span>
        ${entry.shortcut ? `<span class="shortcut">${entry.shortcut}</span>` : ''}
      `;
      row.addEventListener('click', () => {
        this._closeAll();
        this._executeAction(entry.action);
      });
      dropdown.appendChild(row);
    }

    itemEl.appendChild(dropdown);
    this._openMenu = itemEl;
  },

  _closeAll() {
    this._container?.querySelectorAll('.nle-menu-dropdown').forEach(d => d.remove());
    this._openMenu = null;
  },

  async _executeAction(action) {
    switch (action) {
      case 'file:new':
        if (editorState.get(STATE_PATHS.PROJECT_DIRTY)) {
          if (!confirm('Unsaved changes will be lost. Continue?')) return;
        }
        location.reload();
        break;

      case 'file:import':
        await mediaManager.openFilePicker();
        break;

      case 'file:import-recordings':
        await this._showRecordingsImportDialog();
        break;

      case 'file:save':
        await projectManager.save();
        break;

      case 'file:load':
        await this._showLoadProjectDialog();
        break;

      case 'file:export':
        exportDialog.show();
        break;

      case 'edit:undo':
        history.undo();
        break;

      case 'edit:redo':
        history.redo();
        break;

      case 'edit:delete': {
        const selectedIds = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS);
        if (selectedIds.length > 0) {
          clipOperations.deleteClips(selectedIds);
          editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
        }
        break;
      }

      case 'edit:select-all': {
        const allClips = timelineEngine.getAllClips();
        editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, allClips.map(c => c.id));
        eventBus.emit(EDITOR_EVENTS.SELECTION_CHANGED);
        break;
      }

      case 'edit:deselect':
        editorState.set(STATE_PATHS.SELECTION_CLIP_IDS, []);
        eventBus.emit(EDITOR_EVENTS.CLIP_DESELECTED);
        break;

      case 'clip:split': {
        const frame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME);
        const selected = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS);
        if (selected.length > 0) {
          for (const clipId of selected) {
            clipOperations.split(clipId, frame);
          }
        } else {
          // Split all clips at playhead
          for (const clip of timelineEngine.getAllClips()) {
            if (clip.startFrame < frame &&
                clip.startFrame + Math.round((clip.sourceOutFrame - clip.sourceInFrame) / clip.speed) > frame) {
              clipOperations.split(clip.id, frame);
            }
          }
        }
        break;
      }

      case 'clip:toggle-disable': {
        const selected = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS);
        for (const clipId of selected) {
          const clip = timelineEngine.getClip(clipId);
          if (clip) clip.disabled = !clip.disabled;
        }
        eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        break;
      }

      case 'clip:scene-detect': {
        const selected = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS);
        if (selected.length === 1) {
          sceneDetectionDialog.show(selected[0]);
        }
        break;
      }

      case 'seq:add-video':
        timelineEngine.addTrack(TRACK_TYPES.VIDEO);
        break;

      case 'seq:add-audio':
        timelineEngine.addTrack(TRACK_TYPES.AUDIO);
        break;

      case 'seq:add-marker':
        markerManager.addMarkerAtPlayhead();
        break;

      case 'seq:clear-io':
        markerManager.clearInOutPoints();
        break;

      case 'seq:toggle-snap': {
        const snap = !editorState.get(STATE_PATHS.UI_SNAP_ENABLED);
        editorState.set(STATE_PATHS.UI_SNAP_ENABLED, snap);
        break;
      }

      case 'win:source':
        dockManager.togglePanel('source-monitor');
        break;
      case 'win:program':
        dockManager.togglePanel('program-monitor');
        break;
      case 'win:project':
        dockManager.togglePanel('project');
        break;
      case 'win:effects':
        dockManager.togglePanel('effects');
        break;
      case 'win:properties':
        dockManager.togglePanel('properties');
        break;
      case 'win:lumetri':
        dockManager.togglePanel('lumetri-color');
        break;
      case 'win:essential-audio':
        dockManager.togglePanel('essential-audio');
        break;
      case 'win:audio-meters':
        dockManager.togglePanel('audio-meters');
        break;
      case 'win:workspace:editing':
        dockManager.applyPreset('editing');
        break;
      case 'win:workspace:color':
        dockManager.applyPreset('color');
        break;
      case 'win:workspace:audio':
        dockManager.applyPreset('audio');
        break;
      case 'win:reset':
        dockManager.applyPreset('editing');
        break;
    }
  },

  async _showRecordingsImportDialog() {
    const recordings = await indexedDBImporter.listRecordings();
    if (recordings.size === 0) {
      alert('No recordings found.');
      return;
    }

    // Build simple selection dialog
    const overlay = document.createElement('div');
    overlay.className = 'nle-export-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'nle-export-dialog';
    dialog.innerHTML = `
      <div class="nle-export-header">
        <h3>Import Recordings</h3>
        <button class="nle-export-close-btn">×</button>
      </div>
      <div class="nle-export-body" style="max-height: 400px; overflow-y: auto;">
        <div class="nle-recordings-import-list"></div>
      </div>
      <div class="nle-export-footer">
        <button class="nle-export-cancel-btn">Cancel</button>
        <button class="nle-export-start-btn">Import Selected</button>
      </div>
    `;

    const list = dialog.querySelector('.nle-recordings-import-list');
    const checkboxes = [];

    for (const [sessionId, info] of recordings) {
      const row = document.createElement('label');
      row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 6px 0; cursor: pointer; font-size: 12px; color: #d4d4d4;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = sessionId;
      cb.style.accentColor = '#4a90d9';
      checkboxes.push(cb);
      const date = new Date(info.startTime);
      row.innerHTML = '';
      row.appendChild(cb);
      const text = document.createElement('span');
      text.textContent = `${info.label} — ${date.toLocaleString()} (${info.formattedDuration}, ${info.formattedSize})`;
      row.appendChild(text);
      list.appendChild(row);
    }

    overlay.appendChild(dialog);
    document.getElementById('video-editor')?.appendChild(overlay);

    dialog.querySelector('.nle-export-close-btn').addEventListener('click', () => overlay.remove());
    dialog.querySelector('.nle-export-cancel-btn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    dialog.querySelector('.nle-export-start-btn').addEventListener('click', async () => {
      const selectedIds = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
      if (selectedIds.length === 0) return;

      const btn = dialog.querySelector('.nle-export-start-btn');
      btn.disabled = true;
      btn.textContent = 'Importing...';

      await indexedDBImporter.importMultiple(selectedIds);
      overlay.remove();
    });
  },

  async _showLoadProjectDialog() {
    const projects = await projectManager.listProjects();
    if (projects.length === 0) {
      alert('No saved projects found.');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'nle-export-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'nle-export-dialog';
    dialog.innerHTML = `
      <div class="nle-export-header">
        <h3>Load Project</h3>
        <button class="nle-export-close-btn">×</button>
      </div>
      <div class="nle-export-body" style="max-height: 400px; overflow-y: auto;">
        <div class="nle-projects-load-list"></div>
      </div>
      <div class="nle-export-footer">
        <button class="nle-export-cancel-btn">Cancel</button>
      </div>
    `;

    const list = dialog.querySelector('.nle-projects-load-list');
    for (const proj of projects) {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 8px; border-radius: 4px; cursor: pointer; transition: background 0.1s; font-size: 12px; color: #d4d4d4;';
      row.onmouseenter = () => { row.style.background = '#333'; };
      row.onmouseleave = () => { row.style.background = ''; };
      const date = new Date(proj.savedAt);
      row.innerHTML = `
        <div>
          <div style="font-weight: 500;">${proj.name}</div>
          <div style="font-size: 10px; color: #888;">${date.toLocaleString()} • ${proj.trackCount} tracks, ${proj.clipCount} clips</div>
        </div>
      `;
      row.addEventListener('click', async () => {
        try {
          await projectManager.load(proj.id);
          overlay.remove();
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        } catch (err) {
          alert('Failed to load project: ' + err.message);
        }
      });
      list.appendChild(row);
    }

    overlay.appendChild(dialog);
    document.getElementById('video-editor')?.appendChild(overlay);

    dialog.querySelector('.nle-export-close-btn').addEventListener('click', () => overlay.remove());
    dialog.querySelector('.nle-export-cancel-btn').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }
};

export default menuBar;

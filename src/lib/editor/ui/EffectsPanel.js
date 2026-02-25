// Searchable effects list with drag-to-clip
import { effectRegistry } from '../effects/EffectRegistry.js';
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, STATE_PATHS } from '../core/Constants.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { getClipEndFrame } from '../timeline/Clip.js';

export const effectsPanel = {
  _container: null,
  _listEl: null,
  _searchEl: null,
  _filterType: 'all',

  init(container) {
    this._container = container;
    this._searchEl = container.querySelector('.nle-effects-search');
    this._listEl = container.querySelector('.nle-effects-list');

    // Search input
    if (this._searchEl) {
      this._searchEl.addEventListener('input', () => this._render());
    }

    // Type filter buttons
    container.querySelectorAll('.nle-effects-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._filterType = btn.dataset.type || 'all';
        container.querySelectorAll('.nle-effects-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._render();
      });
    });

    this._render();
  },

  _render() {
    if (!this._listEl) return;

    const query = this._searchEl?.value || '';
    let effects = query ? effectRegistry.search(query) : effectRegistry.getAll();

    if (this._filterType !== 'all') {
      effects = effects.filter(e => e.type === this._filterType);
    }

    // Group by category
    const grouped = new Map();
    for (const fx of effects) {
      if (!grouped.has(fx.category)) grouped.set(fx.category, []);
      grouped.get(fx.category).push(fx);
    }

    this._listEl.innerHTML = '';

    if (grouped.size === 0) {
      this._listEl.innerHTML = '<div class="nle-effects-empty">No effects found</div>';
      return;
    }

    for (const [category, fxList] of grouped) {
      const group = document.createElement('div');
      group.className = 'nle-effects-group';

      const header = document.createElement('div');
      header.className = 'nle-effects-group-header';
      header.textContent = category;
      group.appendChild(header);

      for (const fx of fxList) {
        const item = document.createElement('div');
        item.className = 'nle-effects-item';
        item.draggable = true;
        item.dataset.effectId = fx.id;
        item.innerHTML = `
          <span class="nle-effects-item-name">${fx.name}</span>
          <span class="nle-effects-item-type">${fx.type}</span>
        `;

        // Drag to apply to clip
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('application/x-nle-effect', fx.id);
          e.dataTransfer.effectAllowed = 'copy';
        });

        // Double-click to apply to selected clip
        item.addEventListener('dblclick', () => {
          this._applyToSelectedClip(fx.id);
        });

        group.appendChild(item);
      }

      this._listEl.appendChild(group);
    }
  },

  _applyToSelectedClip(effectId) {
    const selectedIds = editorState.get(STATE_PATHS.SELECTION_CLIP_IDS);
    if (selectedIds.length === 0) return;

    const def = effectRegistry.get(effectId);
    if (!def) return;

    // Transitions go to track.transitions[], not clip.effects[]
    if (def.type === 'transition') {
      // Apply to the first selected clip's nearest adjacent edit point
      const clip = timelineEngine.getClip(selectedIds[0]);
      if (!clip) return;
      const track = timelineEngine.getTrack(clip.trackId);
      if (!track) return;

      const clips = track.clips.slice().sort((a, b) => a.startFrame - b.startFrame);
      const idx = clips.findIndex(c => c.id === clip.id);
      const clipEnd = getClipEndFrame(clip);

      // Try tail (this clip → next clip) first, then head (prev clip → this clip)
      const next = idx < clips.length - 1 ? clips[idx + 1] : null;
      const prev = idx > 0 ? clips[idx - 1] : null;

      if (next && next.startFrame === clipEnd) {
        timelineEngine.addTransition(track.id, clip.id, next.id, effectId, 30);
      } else if (prev && getClipEndFrame(prev) === clip.startFrame) {
        timelineEngine.addTransition(track.id, prev.id, clip.id, effectId, 30);
      }
      return;
    }

    for (const clipId of selectedIds) {
      const clip = timelineEngine.getClip(clipId);
      if (clip) {
        const instance = effectRegistry.createInstance(effectId);
        if (instance) {
          clip.effects.push(instance);
          eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
        }
      }
    }
  }
};

export default effectsPanel;

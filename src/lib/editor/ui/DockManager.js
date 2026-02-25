// Premiere Pro-style recursive split-tree docking panel system
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, WORKSPACE_PRESETS } from '../core/Constants.js';
import { startDrag } from './uiUtils.js';
import { clamp } from '../core/MathUtils.js';
import logger from '../../utils/logger.js';

const STORAGE_KEY = 'nle-dock-layout';
const MIN_PANEL_SIZE = 100;
const DRAG_THRESHOLD = 5;
const EDGE_ZONE = 0.25; // fraction of group size for edge drop zones
const FLOATING_MIN_WIDTH = 200;
const FLOATING_MIN_HEIGHT = 150;
const FLOATING_DEFAULT_WIDTH = 400;
const FLOATING_DEFAULT_HEIGHT = 300;
const FLOATING_BASE_Z = 1000;
const RATIO_MIN = 0.05;
const RATIO_MAX = 0.95;

// Panel display names
const PANEL_LABELS = {
  'source-monitor': 'Source',
  'program-monitor': 'Program',
  'project': 'Project',
  'effects': 'Effects',
  'properties': 'Properties',
  'effect-controls': 'Effect Controls',
  'audio-meters': 'Audio Meters',
  'sequence-settings': 'Sequence Settings',
  'timeline': 'Timeline',
  'lumetri-color': 'Lumetri Color',
  'essential-audio': 'Essential Audio'
};

let _nextId = 1;
function genId() { return 'dock-' + (_nextId++); }

// Default layout tree — uses Editing workspace preset
function defaultTree() {
  return WORKSPACE_PRESETS.editing.tree();
}

export const dockManager = {
  _editorEl: null,
  _dockRoot: null,
  _tree: null,
  _panelRegistry: {},    // panelId -> { contentEl, label }
  _panelLifecycle: {},   // panelId -> { cleanup?, init? } — optional lifecycle hooks
  _groupEls: {},         // groupId -> DOM element
  _activeGroupId: null,
  _floatingPanels: [],   // { panelId, windowEl }
  _popoutWindows: {},    // panelId → { window, cleanupFns }

  _cleanupFns: [],       // resizer + tab drag cleanup functions
  _boundOnResize: null,
  _boundOnDockRootMouseDown: null,
  _floatingZCounter: FLOATING_BASE_Z,
  _deferredRestoreIds: [],

  // ── Initialization ──

  init(editorEl) {
    this._editorEl = editorEl;
    this._dockRoot = editorEl.querySelector('.nle-dock-root');
    if (!this._dockRoot) {
      this._dockRoot = document.createElement('div');
      this._dockRoot.className = 'nle-dock-root';
      editorEl.appendChild(this._dockRoot);
    }

    // Extract panel content from existing HTML
    this._extractPanels();

    // Restore or create default tree
    const restored = this._restoreTree();
    this._tree = restored || defaultTree();

    // Render the tree
    this._render();

    // Setup active group tracking (clicks anywhere in group, not just tab bar)
    const onDockRootMouseDown = (e) => {
      const groupEl = e.target.closest('.nle-tab-group');
      if (groupEl) this._setActiveGroup(groupEl.dataset.groupId);
    };
    this._dockRoot.addEventListener('mousedown', onDockRootMouseDown);
    this._boundOnDockRootMouseDown = onDockRootMouseDown;

    // Window resize
    this._boundOnResize = () => {
      eventBus.emit(EDITOR_EVENTS.LAYOUT_RESIZED);
    };
    window.addEventListener('resize', this._boundOnResize);

    // Setup workspace selector in topbar
    this._setupWorkspaceSelector();
  },

  // ── Panel Content Extraction ──

  _extractPanels() {
    const panels = this._editorEl.querySelectorAll('[data-panel]');
    for (const panelEl of panels) {
      const panelId = panelEl.dataset.panel;

      // Remove panel header (dock system creates its own tab bar)
      const header = panelEl.querySelector('.nle-panel-header');
      if (header) header.remove();

      // Store the panel content element
      const label = PANEL_LABELS[panelId] || panelId;
      this._panelRegistry[panelId] = {
        contentEl: panelEl,
        label
      };

      // Remove panel from its current parent (will be reparented during render)
      if (panelEl.parentNode) {
        panelEl.parentNode.removeChild(panelEl);
      }
    }

    // Also extract the timeline (.nle-bottom) as a panel
    const bottomEl = this._editorEl.querySelector('.nle-bottom');
    if (bottomEl && !this._panelRegistry['timeline']) {
      this._panelRegistry['timeline'] = {
        contentEl: bottomEl,
        label: 'Timeline'
      };
      if (bottomEl.parentNode) {
        bottomEl.parentNode.removeChild(bottomEl);
      }
    }

    // Remove the now-empty .nle-mid container and the horizontal resizer
    const mid = this._editorEl.querySelector('.nle-mid');
    if (mid) mid.remove();
    const hResizer = this._editorEl.querySelector('.nle-resizer-horizontal');
    if (hResizer) hResizer.remove();
    // Also remove the inline vertical resizer
    const vResizer = this._editorEl.querySelector('.nle-resizer-vertical');
    if (vResizer) vResizer.remove();
  },

  // ── Public API ──

  getPanelContentEl(panelId) {
    return this._panelRegistry[panelId]?.contentEl || null;
  },

  // Register optional lifecycle hooks for a panel (called during re-parenting)
  registerPanelLifecycle(panelId, hooks) {
    this._panelLifecycle[panelId] = hooks;
  },

  togglePanel(panelId) {
    if (this.isPanelVisible(panelId)) {
      this._removePanelFromTree(panelId);
    } else {
      this._addPanelToFirstGroup(panelId);
    }
    this._render();
    this._save();
  },

  isPanelVisible(panelId) {
    return this._findGroupContaining(panelId) !== null;
  },

  applyPreset(name) {
    const preset = WORKSPACE_PRESETS[name];
    if (!preset) return;

    // Dock back all popout windows first
    for (const panelId of Object.keys(this._popoutWindows)) {
      this.dockBackPanel(panelId);
    }

    // Close floating panels
    for (const fp of this._floatingPanels) {
      fp.windowEl.remove();
    }
    this._floatingPanels = [];

    _nextId = 1;
    this._tree = preset.tree();
    this._render();
    this._save();

    // Update workspace selector
    const select = this._editorEl?.querySelector('.nle-workspace-select');
    if (select) select.value = name;
  },

  // ── Rendering ──

  _render() {
    // Clean up all event listeners from previous render (resizers + tab drags)
    this._cleanupListeners();

    // Clear dock root
    this._dockRoot.innerHTML = '';
    this._groupEls = {};

    // Render tree recursively
    const rootEl = this._renderNode(this._tree);
    if (rootEl) this._dockRoot.appendChild(rootEl);

    // Set first group as active if none set
    if (!this._activeGroupId || !this._groupEls[this._activeGroupId]) {
      const firstGroupId = Object.keys(this._groupEls)[0];
      if (firstGroupId) this._setActiveGroup(firstGroupId);
    }

    eventBus.emit(EDITOR_EVENTS.LAYOUT_RESIZED);
  },

  _renderNode(node) {
    if (!node) return null;
    if (node.type === 'split') return this._renderSplit(node);
    if (node.type === 'group') return this._renderGroup(node);
    return null;
  },

  _renderSplit(splitNode) {
    const container = document.createElement('div');
    container.className = `nle-split nle-split-${splitNode.direction}`;
    container.dataset.nodeId = splitNode.id;

    const child1 = splitNode.children[0];
    const child2 = splitNode.children[1];

    const el1 = this._renderNode(child1);
    const el2 = this._renderNode(child2);

    if (!el1 || !el2) return el1 || el2;

    // Apply flex-basis from ratio
    const ratio = splitNode.ratio;
    el1.className += ' nle-split-child';
    el2.className += ' nle-split-child';
    el1.style.flexBasis = `${ratio * 100}%`;
    el2.style.flexBasis = `${(1 - ratio) * 100}%`;
    el1.style.flexGrow = '1';
    el2.style.flexGrow = '1';
    el1.style.flexShrink = '1';
    el2.style.flexShrink = '1';

    // Create resizer
    const resizer = document.createElement('div');
    resizer.className = splitNode.direction === 'h'
      ? 'nle-dock-resizer-h'
      : 'nle-dock-resizer-v';

    container.appendChild(el1);
    container.appendChild(resizer);
    container.appendChild(el2);

    this._attachResizer(resizer, splitNode, el1, el2);

    return container;
  },

  _renderGroup(groupNode) {
    // Skip empty groups
    if (!groupNode.tabs || groupNode.tabs.length === 0) return null;

    const container = document.createElement('div');
    container.className = 'nle-tab-group';
    container.dataset.groupId = groupNode.id;
    this._groupEls[groupNode.id] = container;

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.className = 'nle-tab-bar';

    for (const panelId of groupNode.tabs) {
      const tab = document.createElement('div');
      tab.className = 'nle-dock-tab';
      if (panelId === groupNode.activeTab) tab.classList.add('active');
      tab.dataset.panelId = panelId;
      tab.dataset.groupId = groupNode.id;

      const label = document.createElement('span');
      label.className = 'nle-dock-tab-label';
      label.textContent = this._panelRegistry[panelId]?.label || panelId;
      tab.appendChild(label);

      // Pop-out button (hidden by default, shown on hover via CSS)
      const popoutBtn = document.createElement('span');
      popoutBtn.className = 'nle-dock-tab-popout';
      popoutBtn.title = 'Pop out to window';
      popoutBtn.textContent = '\u2197';
      popoutBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.popoutPanel(panelId);
      });
      tab.appendChild(popoutBtn);

      // Close button (hidden by default, shown on hover via CSS)
      if (groupNode.tabs.length > 1 || this._countGroups() > 1) {
        const closeBtn = document.createElement('span');
        closeBtn.className = 'nle-dock-tab-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this._removePanelFromTree(panelId);
          this._render();
          this._save();
        });
        tab.appendChild(closeBtn);
      }

      // Tab click to switch active
      tab.addEventListener('mousedown', (e) => {
        if (e.target.closest('.nle-dock-tab-close') || e.target.closest('.nle-dock-tab-popout')) return;
        groupNode.activeTab = panelId;
        this._updateGroupTabs(groupNode);
        this._setActiveGroup(groupNode.id);
      });

      // Tab drag
      this._initTabDrag(tab, panelId, groupNode.id);

      tabBar.appendChild(tab);
    }

    // Content area
    const contentArea = document.createElement('div');
    contentArea.className = 'nle-tab-content-area';

    // Place active panel content
    const activePanel = this._panelRegistry[groupNode.activeTab];
    if (activePanel?.contentEl) {
      contentArea.appendChild(activePanel.contentEl);
      activePanel.contentEl.style.display = '';
      activePanel.contentEl.classList.remove('nle-hidden');
    }

    container.appendChild(tabBar);
    container.appendChild(contentArea);

    return container;
  },

  _updateGroupTabs(groupNode) {
    const groupEl = this._groupEls[groupNode.id];
    if (!groupEl) return;

    // Update tab active states
    const tabs = groupEl.querySelectorAll('.nle-dock-tab');
    tabs.forEach(tab => {
      tab.classList.toggle('active', tab.dataset.panelId === groupNode.activeTab);
    });

    // Swap content
    const contentArea = groupEl.querySelector('.nle-tab-content-area');
    if (contentArea) {
      // Remove current content (don't destroy it)
      while (contentArea.firstChild) {
        contentArea.removeChild(contentArea.firstChild);
      }
      const activePanel = this._panelRegistry[groupNode.activeTab];
      if (activePanel?.contentEl) {
        contentArea.appendChild(activePanel.contentEl);
        activePanel.contentEl.style.display = '';
        activePanel.contentEl.classList.remove('nle-hidden');
      }
    }

    eventBus.emit(EDITOR_EVENTS.LAYOUT_RESIZED);
  },

  // ── Resizers ──

  _attachResizer(resizerEl, splitNode, child1El, child2El) {
    const isH = splitNode.direction === 'h';

    const onMouseDown = (e) => {
      e.preventDefault();
      document.body.classList.add('nle-dock-dragging');
      document.body.style.cursor = isH ? 'col-resize' : 'row-resize';

      const startPos = isH ? e.clientX : e.clientY;
      const rect1 = child1El.getBoundingClientRect();
      const rect2 = child2El.getBoundingClientRect();
      const startSize1 = isH ? rect1.width : rect1.height;
      const startSize2 = isH ? rect2.width : rect2.height;
      const totalSize = startSize1 + startSize2;

      const onMouseMove = (e2) => {
        const delta = (isH ? e2.clientX : e2.clientY) - startPos;
        let newSize1 = startSize1 + delta;
        let newSize2 = startSize2 - delta;

        // Enforce minimums
        if (newSize1 < MIN_PANEL_SIZE) {
          newSize2 += (MIN_PANEL_SIZE - newSize1);
          newSize1 = MIN_PANEL_SIZE;
        }
        if (newSize2 < MIN_PANEL_SIZE) {
          newSize1 += (MIN_PANEL_SIZE - newSize2);
          newSize2 = MIN_PANEL_SIZE;
        }

        const newRatio = newSize1 / totalSize;
        splitNode.ratio = clamp(newRatio, RATIO_MIN, RATIO_MAX);

        child1El.style.flexBasis = `${splitNode.ratio * 100}%`;
        child2El.style.flexBasis = `${(1 - splitNode.ratio) * 100}%`;

        eventBus.emit(EDITOR_EVENTS.LAYOUT_RESIZED);
      };

      startDrag(e, {
        onMove: onMouseMove,
        onUp: () => {
          document.body.classList.remove('nle-dock-dragging');
          document.body.style.cursor = '';
          this._save();
        }
      });
    };

    resizerEl.addEventListener('mousedown', onMouseDown);
    this._cleanupFns.push(() => {
      resizerEl.removeEventListener('mousedown', onMouseDown);
    });
  },

  _cleanupListeners() {
    for (const fn of this._cleanupFns) fn();
    this._cleanupFns = [];
  },

  // ── Tab Dragging ──

  _initTabDrag(tabEl, panelId, groupId) {
    let startX, startY, dragging = false, ghost = null;

    const onMouseDown = (e) => {
      if (e.target.closest('.nle-dock-tab-close') || e.target.closest('.nle-dock-tab-popout')) return;
      if (e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;

      const onMouseMove = (e2) => {
        const dx = e2.clientX - startX;
        const dy = e2.clientY - startY;

        if (!dragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
          dragging = true;
          document.body.classList.add('nle-dock-dragging');
          ghost = document.createElement('div');
          ghost.className = 'nle-tab-drag-ghost';
          ghost.textContent = this._panelRegistry[panelId]?.label || panelId;
          document.body.appendChild(ghost);
          tabEl.classList.add('nle-dock-tab-dragging');
        }

        if (!dragging) return;

        ghost.style.left = `${e2.clientX + 12}px`;
        ghost.style.top = `${e2.clientY - 12}px`;

        // Find drop zone
        this._clearDropIndicators();
        ghost.style.pointerEvents = 'none';
        const el = document.elementFromPoint(e2.clientX, e2.clientY);
        ghost.style.pointerEvents = '';

        const targetGroup = el?.closest('.nle-tab-group');
        if (targetGroup) {
          const zone = this._resolveDropZone(targetGroup, e2.clientX, e2.clientY);
          this._showDropIndicator(targetGroup, zone);
        }
      };

      startDrag(e, {
        onMove: onMouseMove,
        onUp: (e2) => {
          if (ghost) ghost.remove();
          tabEl.classList.remove('nle-dock-tab-dragging');
          document.body.classList.remove('nle-dock-dragging');
          this._clearDropIndicators();

          if (!dragging) return;

          // Determine where to drop
          const el = document.elementFromPoint(e2.clientX, e2.clientY);
          const targetGroup = el?.closest('.nle-tab-group');

          if (targetGroup) {
            const targetGroupId = targetGroup.dataset.groupId;
            const zone = this._resolveDropZone(targetGroup, e2.clientX, e2.clientY);

            if (zone === 'tab') {
              // Move tab into this group (skip if same group)
              if (targetGroupId !== groupId) {
                this.moveTab(panelId, targetGroupId);
              }
            } else {
              // Don't split if dragging the only tab in a group onto itself
              const sourceGroup = this._findNodeById(this._tree, groupId);
              if (targetGroupId === groupId && sourceGroup?.tabs?.length === 1) {
                // No-op: can't split yourself with your only tab
              } else {
                const direction = (zone === 'left' || zone === 'right') ? 'h' : 'v';
                const insertBefore = (zone === 'left' || zone === 'top');
                this._removePanelFromTree(panelId);
                this.splitGroup(targetGroupId, direction, panelId, insertBefore);
              }
            }
          } else {
            // Dropped outside all groups — float the panel
            this.floatPanel(panelId, e2.clientX - 100, e2.clientY - 20);
          }

          this._removeEmptyGroups();
          this._render();
          this._save();
        }
      });
    };

    tabEl.addEventListener('mousedown', onMouseDown);
    this._cleanupFns.push(() => {
      tabEl.removeEventListener('mousedown', onMouseDown);
    });
  },

  _resolveDropZone(groupEl, mouseX, mouseY) {
    const rect = groupEl.getBoundingClientRect();
    const relX = (mouseX - rect.left) / rect.width;
    const relY = (mouseY - rect.top) / rect.height;

    // Tab bar area → tab drop
    const tabBar = groupEl.querySelector('.nle-tab-bar');
    if (tabBar) {
      const tabBarRect = tabBar.getBoundingClientRect();
      if (mouseY >= tabBarRect.top && mouseY <= tabBarRect.bottom) {
        return 'tab';
      }
    }

    // Edge zones
    if (relX < EDGE_ZONE) return 'left';
    if (relX > 1 - EDGE_ZONE) return 'right';
    if (relY < EDGE_ZONE) return 'top';
    if (relY > 1 - EDGE_ZONE) return 'bottom';

    return 'tab'; // Center → tab
  },

  _showDropIndicator(groupEl, zone) {
    // Remove existing
    groupEl.querySelectorAll('.nle-drop-indicator').forEach(el => el.remove());

    const indicator = document.createElement('div');
    indicator.className = `nle-drop-indicator nle-drop-indicator-${zone}`;
    groupEl.appendChild(indicator);
    groupEl.style.position = 'relative';
  },

  _clearDropIndicators() {
    document.querySelectorAll('.nle-drop-indicator').forEach(el => el.remove());
  },

  // ── Tree Operations ──

  moveTab(panelId, targetGroupId) {
    if (!this._panelRegistry[panelId]) return;
    this._removePanelFromTree(panelId);
    const targetGroup = this._findNodeById(this._tree, targetGroupId);
    if (targetGroup && targetGroup.type === 'group') {
      targetGroup.tabs.push(panelId);
      targetGroup.activeTab = panelId;
    }
  },

  splitGroup(groupId, direction, panelId, insertBefore) {
    const node = this._findNodeById(this._tree, groupId);
    if (!node) return;
    if (!this._panelRegistry[panelId]) return;
    const parent = this._findParentOf(this._tree, groupId);

    const newGroup = {
      id: genId(),
      type: 'group',
      tabs: [panelId],
      activeTab: panelId
    };

    const newSplit = {
      id: genId(),
      type: 'split',
      direction,
      ratio: 0.5,
      children: insertBefore ? [newGroup, node] : [node, newGroup]
    };

    // Replace node in parent
    if (parent && parent.children) {
      const idx = parent.children.indexOf(node);
      if (idx !== -1) parent.children[idx] = newSplit;
    } else if (this._tree === node) {
      this._tree = newSplit;
    }
  },

  _removePanelFromTree(panelId) {
    // Remove from popout windows
    if (this._popoutWindows[panelId]) {
      this.dockBackPanel(panelId);
      return;
    }

    // Remove from floating
    const floatIdx = this._floatingPanels.findIndex(fp => fp.panelId === panelId);
    if (floatIdx !== -1) {
      this._floatingPanels[floatIdx].windowEl.remove();
      this._floatingPanels.splice(floatIdx, 1);
      return;
    }

    // Remove from tree
    this._walkTree(this._tree, (node) => {
      if (node.type === 'group' && node.tabs.includes(panelId)) {
        node.tabs = node.tabs.filter(t => t !== panelId);
        if (node.activeTab === panelId) {
          node.activeTab = node.tabs[0] || null;
        }
      }
    });
  },

  _addPanelToFirstGroup(panelId) {
    // Add to the first group found
    let added = false;
    this._walkTree(this._tree, (node) => {
      if (!added && node.type === 'group') {
        node.tabs.push(panelId);
        node.activeTab = panelId;
        added = true;
      }
    });
  },

  _removeEmptyGroups() {
    // Walk bottom-up, collapse splits with empty children
    const collapse = (node, parent, childIdx) => {
      if (!node) return;

      if (node.type === 'split') {
        // Null safety: ensure children array exists and has 2 elements
        if (!node.children || node.children.length < 2) {
          if (parent) {
            parent.children[childIdx] = { id: genId(), type: 'group', tabs: [], activeTab: null };
          }
          return;
        }

        collapse(node.children[0], node, 0);
        collapse(node.children[1], node, 1);

        const c0Empty = node.children[0]?.type === 'group' && (!node.children[0].tabs || node.children[0].tabs.length === 0);
        const c1Empty = node.children[1]?.type === 'group' && (!node.children[1].tabs || node.children[1].tabs.length === 0);

        if (c0Empty && c1Empty) {
          if (parent) {
            parent.children[childIdx] = { id: genId(), type: 'group', tabs: [], activeTab: null };
          } else if (this._tree === node) {
            // Root split with both children empty — collapse to empty group
            this._tree = { id: genId(), type: 'group', tabs: [], activeTab: null };
          }
        } else if (c0Empty) {
          if (parent) {
            parent.children[childIdx] = node.children[1];
          } else if (this._tree === node) {
            this._tree = node.children[1];
          }
        } else if (c1Empty) {
          if (parent) {
            parent.children[childIdx] = node.children[0];
          } else if (this._tree === node) {
            this._tree = node.children[0];
          }
        }
      }
    };

    collapse(this._tree, null, 0);

    // Handle root itself being an empty group
    if (this._tree?.type === 'group' && (!this._tree.tabs || this._tree.tabs.length === 0)) {
      // Keep the empty group as root — _render will handle it
    }
  },

  // ── Floating Panels ──

  floatPanel(panelId, x, y) {
    const panel = this._panelRegistry[panelId];
    if (!panel) return;

    this._removePanelFromTree(panelId);

    const windowEl = document.createElement('div');
    windowEl.className = 'nle-floating-panel';
    windowEl.style.left = `${x}px`;
    windowEl.style.top = `${y}px`;
    windowEl.style.width = `${FLOATING_DEFAULT_WIDTH}px`;
    windowEl.style.height = `${FLOATING_DEFAULT_HEIGHT}px`;
    windowEl.style.zIndex = ++this._floatingZCounter;

    // Bring to front on mousedown
    windowEl.addEventListener('mousedown', () => {
      windowEl.style.zIndex = ++this._floatingZCounter;
    });

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'nle-floating-titlebar';
    titleBar.textContent = panel.label;

    const closeBtn = document.createElement('span');
    closeBtn.className = 'nle-floating-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => {
      this.dockPanel(panelId);
    });
    titleBar.appendChild(closeBtn);

    // Content
    const content = document.createElement('div');
    content.className = 'nle-floating-content';
    if (panel.contentEl) {
      content.appendChild(panel.contentEl);
      panel.contentEl.style.display = '';
    }

    // Resize handle
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'nle-floating-resize-handle';

    windowEl.appendChild(titleBar);
    windowEl.appendChild(content);
    windowEl.appendChild(resizeHandle);

    this._editorEl.appendChild(windowEl);
    this._floatingPanels.push({ panelId, windowEl });

    // Draggable title bar
    this._makeFloatingDraggable(windowEl, titleBar);
    // Resizable
    this._makeFloatingResizable(windowEl, resizeHandle);
  },

  dockPanel(panelId, targetGroupId) {
    // Remove floating window
    const idx = this._floatingPanels.findIndex(fp => fp.panelId === panelId);
    if (idx !== -1) {
      this._floatingPanels[idx].windowEl.remove();
      this._floatingPanels.splice(idx, 1);
    }

    // Add to target group or first group
    if (targetGroupId) {
      const group = this._findNodeById(this._tree, targetGroupId);
      if (group && group.type === 'group') {
        group.tabs.push(panelId);
        group.activeTab = panelId;
      }
    } else {
      this._addPanelToFirstGroup(panelId);
    }

    this._render();
    this._save();
  },

  _makeFloatingDraggable(windowEl, handleEl) {
    handleEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.nle-floating-close')) return;
      e.preventDefault();
      const startX = e.clientX - windowEl.offsetLeft;
      const startY = e.clientY - windowEl.offsetTop;

      startDrag(e, {
        onMove: (e2) => {
          windowEl.style.left = `${e2.clientX - startX}px`;
          windowEl.style.top = `${e2.clientY - startY}px`;
        }
      });
    });
  },

  _makeFloatingResizable(windowEl, handleEl) {
    handleEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = windowEl.offsetWidth;
      const startH = windowEl.offsetHeight;

      startDrag(e, {
        onMove: (e2) => {
          windowEl.style.width = `${Math.max(FLOATING_MIN_WIDTH, startW + (e2.clientX - startX))}px`;
          windowEl.style.height = `${Math.max(FLOATING_MIN_HEIGHT, startH + (e2.clientY - startY))}px`;
        }
      });
    });
  },

  // ── Pop-Out Windows ──

  // Pop out a panel to a separate browser window (for multi-monitor).
  // Opens popout.html (same origin, same COOP headers) so document.adoptNode works.
  // Falls back to in-document floating panel if popup is blocked.
  popoutPanel(panelId) {
    const panel = this._panelRegistry[panelId];
    if (!panel) return;
    if (this._popoutWindows[panelId]) return;
    if (this._floatingPanels.find(fp => fp.panelId === panelId)) return;
    if (this._countTotalPanels() <= 1) return;

    // Call cleanup on panel before removing from tree (releases listeners/observers)
    const lifecycle = this._panelLifecycle[panelId];
    if (lifecycle?.cleanup) {
      try { lifecycle.cleanup(); } catch (_) { /* best-effort */ }
    }

    // Remove from dock tree
    this._removePanelFromTree(panelId);
    this._removeEmptyGroups();
    this._render();

    // Open popup to same-origin popout.html (shares COOP context)
    const width = 700;
    const height = 500;
    const left = window.screenX + 100;
    const top = window.screenY + 100;
    const features = `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no`;

    let popup;
    try {
      popup = window.open('./popout.html', `nle-popout-${panelId}`, features);
    } catch (e) {
      popup = null;
    }

    if (!popup) {
      // Popup blocked — fall back to floating panel
      this._addPanelToFirstGroup(panelId);
      this._render();
      this._save();
      return;
    }

    // Wait for popout.html to load (it sets window._popoutReady)
    const onReady = () => {
      try {
        // Inject stylesheets from main document
        this._injectCSS(popup.document);

        // Set title
        popup.document.title = panel.label;
        const titleEl = popup.document.getElementById('popout-title');
        if (titleEl) titleEl.textContent = panel.label;

        // Adopt panel DOM into the popup
        const content = popup.document.getElementById('popout-content');
        if (content && panel.contentEl) {
          const adoptedEl = popup.document.adoptNode(panel.contentEl);
          adoptedEl.style.display = '';
          adoptedEl.classList.remove('nle-hidden');
          content.appendChild(adoptedEl);
        }

        // Wire dock-back button
        const dockBtn = popup.document.getElementById('popout-dock-btn');
        if (dockBtn) {
          dockBtn.addEventListener('click', () => this.dockBackPanel(panelId));
        }
      } catch (e) {
        // If DOM access fails (COOP mismatch in edge cases), fall back to float
        this._addPanelToFirstGroup(panelId);
        this._render();
        this._save();
        try { popup.close(); } catch (_) { /* ignore */ }
        return;
      }

      // Wire event listeners
      const cleanupFns = [];

      const onBeforeUnload = () => {
        if (this._popoutWindows[panelId]) {
          this.dockBackPanel(panelId);
        }
      };
      popup.addEventListener('beforeunload', onBeforeUnload);
      cleanupFns.push(() => {
        try { popup.removeEventListener('beforeunload', onBeforeUnload); } catch (_) { /* closed */ }
      });

      const onResize = () => eventBus.emit(EDITOR_EVENTS.LAYOUT_RESIZED);
      popup.addEventListener('resize', onResize);
      cleanupFns.push(() => {
        try { popup.removeEventListener('resize', onResize); } catch (_) { /* closed */ }
      });

      this._popoutWindows[panelId] = { window: popup, cleanupFns };
      eventBus.emit(EDITOR_EVENTS.PANEL_POPPED_OUT, { panelId });
      setTimeout(() => eventBus.emit(EDITOR_EVENTS.LAYOUT_RESIZED), 50);
      this._save();
    };

    // Poll for readiness (load event is unreliable for cross-document access timing)
    let pollAttempts = 0;
    const MAX_POLL_ATTEMPTS = 100; // 5 seconds max (100 * 50ms)
    const checkReady = () => {
      try {
        if (popup.closed) {
          this._addPanelToFirstGroup(panelId);
          this._render();
          this._save();
          return;
        }
        if (popup._popoutReady || popup.document?.readyState === 'complete') {
          onReady();
          return;
        }
      } catch (_) { /* not ready yet */ }
      if (++pollAttempts >= MAX_POLL_ATTEMPTS) {
        logger.warn('[DockManager] Popout window readiness check timed out');
        this._addPanelToFirstGroup(panelId);
        this._render();
        this._save();
        try { popup.close(); } catch (_) { /* ignore */ }
        return;
      }
      setTimeout(checkReady, 50);
    };
    setTimeout(checkReady, 100);
  },

  dockBackPanel(panelId) {
    const entry = this._popoutWindows[panelId];
    if (!entry) {
      // May be a floating panel — delegate to dockPanel
      this.dockPanel(panelId);
      return;
    }

    // Remove from map immediately (prevents re-entry from beforeunload)
    delete this._popoutWindows[panelId];

    const panel = this._panelRegistry[panelId];
    const popup = entry.window;

    // Run cleanup functions
    for (const fn of entry.cleanupFns) fn();

    // Adopt DOM back to main document
    if (panel && popup && !popup.closed) {
      try {
        const popupEl = popup.document.querySelector('#popout-content > *');
        if (popupEl) {
          const adoptedEl = document.adoptNode(popupEl);
          panel.contentEl = adoptedEl;
        }
      } catch (_) { /* popup already closed or inaccessible */ }
    }

    // Close popup
    try {
      if (popup && !popup.closed) popup.close();
    } catch (_) { /* already closed */ }

    // Re-add to dock
    this._addPanelToFirstGroup(panelId);
    this._render();
    this._save();

    // Re-initialize panel internal state (listeners, observers) after re-parenting
    const lifecycle = this._panelLifecycle[panelId];
    if (lifecycle?.init && panel?.contentEl) {
      try { lifecycle.init(panel.contentEl); } catch (_) { /* best-effort */ }
    }

    eventBus.emit(EDITOR_EVENTS.PANEL_DOCKED_BACK, { panelId });
    setTimeout(() => eventBus.emit(EDITOR_EVENTS.LAYOUT_RESIZED), 50);
  },

  _injectCSS(targetDoc) {
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    for (const link of links) {
      const newLink = targetDoc.createElement('link');
      newLink.rel = 'stylesheet';
      newLink.href = link.href;
      targetDoc.head.appendChild(newLink);
    }
    const styles = document.querySelectorAll('style');
    for (const style of styles) {
      const newStyle = targetDoc.createElement('style');
      newStyle.textContent = style.textContent;
      targetDoc.head.appendChild(newStyle);
    }
  },

  _countTotalPanels() {
    let count = 0;
    this._walkTree(this._tree, (node) => {
      if (node.type === 'group') count += node.tabs.length;
    });
    count += this._floatingPanels.length;
    count += Object.keys(this._popoutWindows).length;
    return count;
  },

  // ── Active Group ──

  _setActiveGroup(groupId) {
    this._activeGroupId = groupId;
    // Update visual state
    Object.values(this._groupEls).forEach(el => {
      el.classList.remove('nle-group-active');
    });
    const el = this._groupEls[groupId];
    if (el) el.classList.add('nle-group-active');
  },

  // ── Tree Utilities ──

  _findNodeById(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = this._findNodeById(child, id);
        if (found) return found;
      }
    }
    return null;
  },

  _findParentOf(node, targetId) {
    if (!node || !node.children) return null;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i].id === targetId) return node;
      const found = this._findParentOf(node.children[i], targetId);
      if (found) return found;
    }
    return null;
  },

  _findGroupContaining(panelId) {
    let found = null;
    this._walkTree(this._tree, (node) => {
      if (node.type === 'group' && node.tabs?.includes(panelId)) {
        found = node;
      }
    });
    // Also check floating
    if (!found && this._floatingPanels.some(fp => fp.panelId === panelId)) {
      return { floating: true };
    }
    // Also check popout windows
    if (!found && this._popoutWindows[panelId]) {
      return { popout: true };
    }
    return found;
  },

  _walkTree(node, fn) {
    if (!node) return;
    fn(node);
    if (node.children) {
      for (const child of node.children) {
        this._walkTree(child, fn);
      }
    }
  },

  _countGroups() {
    let count = 0;
    this._walkTree(this._tree, (node) => {
      if (node.type === 'group') count++;
    });
    return count + this._floatingPanels.length;
  },

  // ── Persistence ──

  _save() {
    try {
      const data = {
        tree: this._serializeTree(this._tree),
        floating: this._floatingPanels.map(fp => ({
          panelId: fp.panelId,
          x: fp.windowEl.offsetLeft,
          y: fp.windowEl.offsetTop,
          w: fp.windowEl.offsetWidth,
          h: fp.windowEl.offsetHeight
        })),
        popouts: Object.keys(this._popoutWindows)
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
  },

  _serializeTree(node) {
    if (!node) return null;
    if (node.type === 'group') {
      return { type: 'group', tabs: [...node.tabs], activeTab: node.activeTab };
    }
    return {
      type: 'split',
      direction: node.direction,
      ratio: node.ratio,
      children: [
        this._serializeTree(node.children[0]),
        this._serializeTree(node.children[1])
      ]
    };
  },

  _restoreTree() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data.tree) return null;

      const tree = this._deserializeTree(data.tree);
      if (!tree) return null;

      // Verify all panels in tree exist in registry, fix stale activeTab
      const treePanels = [];
      this._walkTree(tree, (node) => {
        if (node.type === 'group') {
          node.tabs = node.tabs.filter(t => this._panelRegistry[t]);
          // Fix activeTab if it was filtered out
          if (!node.tabs.includes(node.activeTab)) {
            node.activeTab = node.tabs[0] || null;
          }
          treePanels.push(...node.tabs);
        }
      });

      // If the tree has no panels at all, discard it
      if (treePanels.length === 0) return null;

      // Determine which panels will be restored as popouts
      const popoutPanelIds = (data.popouts || []).filter(id => this._panelRegistry[id]);

      // Inject any registered panels missing from the tree into the first group
      // (but exclude panels that will be restored as popouts)
      const missingPanels = Object.keys(this._panelRegistry)
        .filter(id => !treePanels.includes(id) && !popoutPanelIds.includes(id));
      if (missingPanels.length > 0) {
        let firstGroup = null;
        this._walkTree(tree, (node) => {
          if (!firstGroup && node.type === 'group' && node.tabs.length > 0) {
            firstGroup = node;
          }
        });
        if (firstGroup) {
          for (const panelId of missingPanels) {
            firstGroup.tabs.push(panelId);
          }
        }
      }

      // Restore floating panels
      if (data.floating) {
        // We'll re-float these after render
        this._deferredRestoreIds.push(setTimeout(() => {
          for (const fp of data.floating) {
            if (this._panelRegistry[fp.panelId] && !treePanels.includes(fp.panelId)) {
              this.floatPanel(fp.panelId, fp.x, fp.y);
              const win = this._floatingPanels.find(f => f.panelId === fp.panelId);
              if (win) {
                win.windowEl.style.width = `${fp.w}px`;
                win.windowEl.style.height = `${fp.h}px`;
              }
            }
          }
        }, 0));
      }

      // Restore popout windows
      if (popoutPanelIds.length > 0) {
        this._deferredRestoreIds.push(setTimeout(() => {
          for (const panelId of popoutPanelIds) {
            if (this._panelRegistry[panelId]) {
              this.popoutPanel(panelId);
            }
          }
        }, 100));
      }

      return tree;
    } catch (e) {
      return null;
    }
  },

  _deserializeTree(data) {
    if (!data) return null;
    if (data.type === 'group') {
      return {
        id: genId(),
        type: 'group',
        tabs: data.tabs || [],
        activeTab: data.activeTab || (data.tabs?.[0] || null)
      };
    }
    if (data.type === 'split') {
      if (!data.children || data.children.length < 2) return null;
      const child0 = this._deserializeTree(data.children[0]);
      const child1 = this._deserializeTree(data.children[1]);
      if (!child0 || !child1) return child0 || child1 || null;
      return {
        id: genId(),
        type: 'split',
        direction: data.direction || 'h',
        ratio: data.ratio || 0.5,
        children: [child0, child1]
      };
    }
    return null;
  },

  // ── Workspace Selector ──

  _setupWorkspaceSelector() {
    if (!this._editorEl) return;
    const topbar = this._editorEl.querySelector('.nle-topbar');
    if (!topbar) return;

    const exportBtn = topbar.querySelector('.nle-export-btn');
    if (!exportBtn) return;

    // Don't add if already exists
    if (topbar.querySelector('.nle-workspace-select')) return;

    const select = document.createElement('select');
    select.className = 'nle-workspace-select';
    select.title = 'Layout Workspace';
    for (const [key, preset] of Object.entries(WORKSPACE_PRESETS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = preset.name;
      select.appendChild(opt);
    }

    select.value = 'editing'; // Default workspace

    select.addEventListener('change', () => {
      this.applyPreset(select.value);
    });

    const sep = document.createElement('div');
    sep.className = 'nle-topbar-separator';
    topbar.insertBefore(sep, exportBtn);
    topbar.insertBefore(select, exportBtn);
  },

  // ── Cleanup ──

  destroy() {
    // Clear deferred restore timers
    this._deferredRestoreIds.forEach(id => clearTimeout(id));
    this._deferredRestoreIds = [];

    if (this._boundOnResize) {
      window.removeEventListener('resize', this._boundOnResize);
      this._boundOnResize = null;
    }
    if (this._boundOnDockRootMouseDown && this._dockRoot) {
      this._dockRoot.removeEventListener('mousedown', this._boundOnDockRootMouseDown);
      this._boundOnDockRootMouseDown = null;
    }
    this._cleanupListeners();

    // Close popout windows
    for (const panelId of Object.keys(this._popoutWindows)) {
      const entry = this._popoutWindows[panelId];
      for (const fn of entry.cleanupFns) fn();
      try { if (entry.window && !entry.window.closed) entry.window.close(); } catch (_) { /* ignore */ }
    }
    this._popoutWindows = {};

    // Remove floating windows
    for (const fp of this._floatingPanels) {
      fp.windowEl.remove();
    }
    this._floatingPanels = [];
    this._floatingZCounter = FLOATING_BASE_Z;

    if (this._dockRoot) {
      this._dockRoot.innerHTML = '';
    }
    this._groupEls = {};
    this._panelRegistry = {};
    this._tree = null;
    this._activeGroupId = null;
    this._editorEl = null;
    this._dockRoot = null;
  }
};

export default dockManager;

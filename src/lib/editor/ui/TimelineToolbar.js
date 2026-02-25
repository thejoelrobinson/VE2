// Premiere Pro-style timeline toolbar — snap, linked selection, markers, display settings
// Also wires keyboard shortcuts and active-state sync to the vertical .nle-toolbar tool palette.
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { STATE_PATHS, EDITOR_EVENTS, ZOOM_LEVELS } from '../core/Constants.js';
import { markerManager } from '../timeline/Markers.js';

const ICONS = {
  nest: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="8" height="8" rx="1"/><rect x="5" y="1" width="8" height="8" rx="1"/></svg>',
  snap: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1v12"/><path d="M3 4l4-3 4 3"/><path d="M3 10l4 3 4-3"/></svg>',
  linked: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a3 3 0 004-1l1.5-1.5a3 3 0 00-4.24-4.24L6 2.5"/><path d="M8 6a3 3 0 00-4 1L2.5 8.5a3 3 0 004.24 4.24L8 11.5"/></svg>',
  marker: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1l2.5 4.5H11L7 13 3 5.5h1.5z"/></svg>',
  wrench: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.5a4 4 0 00-5 5l-2 5.5 5.5-2a4 4 0 005-5"/><circle cx="8" cy="6" r="1"/></svg>',
  cc: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 6a1 1 0 10 0 2"/><path d="M9.5 6a1 1 0 10 0 2"/></svg>'
};

// Tool definitions: name, keyboard shortcut
const TOOLS = [
  { name: 'selection',    key: 'V' },
  { name: 'track-select', key: 'A' },
  { name: 'ripple-edit',  key: 'B' },
  { name: 'rolling-edit', key: 'N' },
  { name: 'razor',        key: 'C' },
  { name: 'slip',         key: 'Y' },
  { name: 'slide',        key: 'U' },
  { name: 'pen',          key: 'P' },
  { name: 'hand',         key: 'H' },
  { name: 'zoom',         key: 'Z' },
  { name: 'rate-stretch', key: 'R' },
];

// Key-to-tool map for quick lookup
const KEY_TO_TOOL = {};
for (const t of TOOLS) KEY_TO_TOOL[t.key.toLowerCase()] = t.name;

let _container = null;
let _dropdown = null;
let _unsubs = [];
let _outsideClickHandler = null;
let _escHandler = null;
let _keydownHandler = null;
let _toolButtons = []; // references to .nle-tool-btn elements in the existing vertical toolbar

function _createToggleButton(parent, { icon, title, statePath }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nle-tl-toolbar-btn';
  btn.title = title;
  btn.innerHTML = icon;

  // Sync initial state
  if (editorState.get(statePath)) btn.classList.add('active');

  btn.addEventListener('click', () => {
    const next = !editorState.get(statePath);
    editorState.set(statePath, next);
  });

  const unsub = editorState.subscribe(statePath, (val) => {
    btn.classList.toggle('active', !!val);
  });
  _unsubs.push(unsub);

  parent.appendChild(btn);
  return btn;
}

function _createActionButton(parent, { icon, title, action }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nle-tl-toolbar-btn';
  btn.title = title;
  btn.innerHTML = icon;
  btn.addEventListener('click', action);
  parent.appendChild(btn);
  return btn;
}

function _dismissDropdown() {
  if (_dropdown) {
    _dropdown.remove();
    _dropdown = null;
  }
  if (_outsideClickHandler) {
    document.removeEventListener('mousedown', _outsideClickHandler, true);
    _outsideClickHandler = null;
  }
  if (_escHandler) {
    document.removeEventListener('keydown', _escHandler);
    _escHandler = null;
  }
}

function _toggleSettingsDropdown(e) {
  if (_dropdown) {
    _dismissDropdown();
    return;
  }

  const triggerBtn = e.currentTarget;
  const rect = triggerBtn.getBoundingClientRect();
  _dropdown = document.createElement('div');
  _dropdown.className = 'nle-tl-settings-dropdown';
  _dropdown.style.left = `${rect.left}px`;
  _dropdown.style.top = `${rect.bottom + 2}px`;

  const items = [
    { label: 'Show Thumbnails', statePath: STATE_PATHS.UI_SHOW_THUMBNAILS },
    { label: 'Show Waveforms', statePath: STATE_PATHS.UI_SHOW_WAVEFORMS },
    { label: 'Show Duplicate Frame Markers', statePath: STATE_PATHS.UI_SHOW_DUPLICATE_FRAMES }
  ];

  for (const item of items) {
    const row = document.createElement('label');
    row.className = 'nle-tl-settings-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!editorState.get(item.statePath);
    cb.addEventListener('change', () => {
      editorState.set(item.statePath, cb.checked);
    });

    const span = document.createElement('span');
    span.textContent = item.label;

    row.appendChild(cb);
    row.appendChild(span);
    _dropdown.appendChild(row);
  }

  document.body.appendChild(_dropdown);

  // Dismiss on outside click (capture triggerBtn ref — e.currentTarget is null after dispatch)
  _outsideClickHandler = (ev) => {
    if (_dropdown && !_dropdown.contains(ev.target) && !triggerBtn.contains(ev.target)) {
      _dismissDropdown();
    }
  };
  // Use setTimeout to avoid the current click triggering immediate dismiss
  setTimeout(() => {
    document.addEventListener('mousedown', _outsideClickHandler, true);
  }, 0);

  // Dismiss on Escape
  _escHandler = (ev) => {
    if (ev.key === 'Escape') _dismissDropdown();
  };
  document.addEventListener('keydown', _escHandler);
}

function _syncDisplayClasses() {
  const panel = _container?.closest('.nle-timeline-panel');
  if (!panel) return;
  panel.classList.toggle('hide-thumbnails', !editorState.get(STATE_PATHS.UI_SHOW_THUMBNAILS));
  panel.classList.toggle('hide-waveforms', !editorState.get(STATE_PATHS.UI_SHOW_WAVEFORMS));
}

// ── Tool management ──

function _setActiveTool(toolName) {
  editorState.set(STATE_PATHS.UI_ACTIVE_TOOL, toolName);
  eventBus.emit(EDITOR_EVENTS.TOOL_CHANGED, { tool: toolName });
  _syncToolButtons();
}

function _syncToolButtons() {
  const activeTool = editorState.get(STATE_PATHS.UI_ACTIVE_TOOL) || 'selection';
  for (const btn of _toolButtons) {
    btn.classList.toggle('active', btn.dataset.tool === activeTool);
  }
}

// ── Zoom helpers ──

function _getZoomIndex() {
  return editorState.get(STATE_PATHS.TIMELINE_ZOOM_INDEX) || 0;
}

function _setZoomIndex(index) {
  const clamped = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
  editorState.set(STATE_PATHS.TIMELINE_ZOOM_INDEX, clamped);
  eventBus.emit(EDITOR_EVENTS.ZOOM_CHANGED, { zoomIndex: clamped });
}

// ── Keyboard shortcut handler ──

function _handleKeydown(e) {
  // Skip if focus is inside an editable element
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

  // Don't shadow browser shortcuts (Ctrl/Cmd+Z, Ctrl/Cmd+K, etc.)
  if (e.ctrlKey || e.metaKey) return;

  const keyLower = e.key.toLowerCase();

  // Tool shortcuts — no shift modifier
  if (!e.shiftKey) {
    const toolName = KEY_TO_TOOL[keyLower];
    if (toolName) {
      e.preventDefault();
      _setActiveTool(toolName);
      return;
    }
  }

  // Zoom shortcuts (= / + / -)
  if (e.key === '=' || e.key === '+') { e.preventDefault(); _setZoomIndex(_getZoomIndex() + 1); return; }
  if (e.key === '-')                  { e.preventDefault(); _setZoomIndex(_getZoomIndex() - 1); return; }
  // Fit sequence in window (\) — most zoomed-out level (index 0)
  if (e.key === '\\') { e.preventDefault(); _setZoomIndex(0); return; }

  // In / Out points — use keyLower for CapsLock safety
  const currentFrame = editorState.get(STATE_PATHS.PLAYBACK_CURRENT_FRAME) || 0;
  if (keyLower === 'i' && e.shiftKey)  { e.preventDefault(); editorState.set(STATE_PATHS.PLAYBACK_IN_POINT, null); return; }
  if (keyLower === 'o' && e.shiftKey)  { e.preventDefault(); editorState.set(STATE_PATHS.PLAYBACK_OUT_POINT, null); return; }
  if (keyLower === 'i' && !e.shiftKey) { e.preventDefault(); editorState.set(STATE_PATHS.PLAYBACK_IN_POINT, currentFrame); return; }
  if (keyLower === 'o' && !e.shiftKey) { e.preventDefault(); editorState.set(STATE_PATHS.PLAYBACK_OUT_POINT, currentFrame); return; }
}

export const timelineToolbar = {
  init(container) {
    _container = container;
    _container.innerHTML = '';
    _toolButtons = [];

    // ── Left section (180px — aligns with the 180px track headers beneath it) ──
    // Contains timeline-specific toggles: snap, linked selection, markers, display, CC.
    // The tool palette lives in the separate vertical .nle-toolbar (already in the HTML).
    const left = document.createElement('div');
    left.className = 'nle-tl-toolbar-left';

    _createToggleButton(left, { icon: ICONS.nest,   title: 'Nest Sequences',          statePath: STATE_PATHS.UI_NEST_SEQUENCES });
    _createToggleButton(left, { icon: ICONS.snap,   title: 'Snap (S)',                statePath: STATE_PATHS.UI_SNAP_ENABLED });
    _createToggleButton(left, { icon: ICONS.linked, title: 'Linked Selection',        statePath: STATE_PATHS.UI_LINKED_SELECTION });
    _createActionButton(left, { icon: ICONS.marker, title: 'Add Marker (M)',          action: () => markerManager.addMarkerAtPlayhead() });
    _createActionButton(left, { icon: ICONS.wrench, title: 'Timeline Display Settings', action: _toggleSettingsDropdown });
    _createToggleButton(left, { icon: ICONS.cc,     title: 'Closed Captions',         statePath: STATE_PATHS.UI_SHOW_CAPTIONS });

    _container.appendChild(left);

    // ── Wire up the existing vertical .nle-toolbar tool buttons ──
    // The vertical toolbar is the canonical tool picker; we just attach state sync to it.
    const timelineArea = container.closest('.nle-timeline-area');
    if (timelineArea) {
      const vertBtns = timelineArea.querySelectorAll('.nle-toolbar .nle-tool-btn[data-tool]');
      for (const btn of vertBtns) {
        btn.addEventListener('click', () => _setActiveTool(btn.dataset.tool));
        _toolButtons.push(btn);
      }
      _syncToolButtons();
    }

    // Keep vertical buttons in sync when tool changes via keyboard shortcut or external source
    _unsubs.push(editorState.subscribe(STATE_PATHS.UI_ACTIVE_TOOL, _syncToolButtons));

    // ── Keyboard shortcuts ──
    _keydownHandler = _handleKeydown;
    document.addEventListener('keydown', _keydownHandler);

    // Apply initial display-toggle CSS classes and keep them in sync
    _syncDisplayClasses();
    _unsubs.push(editorState.subscribe(STATE_PATHS.UI_SHOW_THUMBNAILS, _syncDisplayClasses));
    _unsubs.push(editorState.subscribe(STATE_PATHS.UI_SHOW_WAVEFORMS, _syncDisplayClasses));
  },

  cleanup() {
    _dismissDropdown();
    if (_keydownHandler) {
      document.removeEventListener('keydown', _keydownHandler);
      _keydownHandler = null;
    }
    for (const unsub of _unsubs) {
      if (typeof unsub === 'function') unsub();
    }
    _unsubs = [];
    _toolButtons = [];
    _container = null;
  }
};

export default timelineToolbar;

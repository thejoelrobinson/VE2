// Editor entry point -- wires all subsystems together
import logger from '../utils/logger.js';
import { editorState } from './core/EditorState.js';
import { eventBus } from './core/EventBus.js';
import { history } from './core/History.js';
import { timelineEngine } from './timeline/TimelineEngine.js';
import { mediaManager } from './media/MediaManager.js';
import { thumbnailGenerator } from './media/ThumbnailGenerator.js';
import { playbackEngine } from './playback/PlaybackEngine.js';
import { videoCompositor } from './playback/VideoCompositor.js';
import { audioMixer } from './playback/AudioMixer.js';
import { dockManager } from './ui/DockManager.js';
import { programMonitor } from './ui/ProgramMonitor.js';
import { sourceMonitor } from './ui/SourceMonitor.js';
import { projectPanel } from './ui/ProjectPanel.js';
import { effectsPanel } from './ui/EffectsPanel.js';
import { propertiesPanel } from './ui/PropertiesPanel.js';
import { basicPropertiesPanel } from './ui/BasicPropertiesPanel.js';
import { timelineUI } from './ui/TimelineUI.js';
import { transportControls } from './ui/TransportControls.js';
import { toolbar } from './ui/Toolbar.js';
import { keyboardShortcuts } from './ui/KeyboardShortcuts.js';
import { exportDialog } from './ui/ExportDialog.js';
import { menuBar } from './ui/MenuBar.js';
import { timelineToolbar } from './ui/TimelineToolbar.js';
import { audioMetersPanel } from './ui/AudioMetersPanel.js';
import { projectManager } from './project/ProjectManager.js';
import { EDITOR_EVENTS, STATE_PATHS } from './core/Constants.js';
import { renderAheadManager } from './media/RenderAheadManager.js';
import { conformEncoder } from './media/ConformEncoder.js';
import { sequenceSettingsPanel } from './ui/SequenceSettingsPanel.js';
import { transformOverlay } from './ui/TransformOverlay.js';
import { waveformCanvasPool } from './ui/CanvasPool.js';
import { rafScheduler } from './core/RafScheduler.js';
import { opfsCache } from './core/OPFSCache.js';
import { metadataCache } from './core/MetadataCache.js';
// Register all effects (side-effect imports)
import './effects/VideoEffects.js';
import './effects/AudioEffects.js';
import './effects/Transitions.js';
import './effects/LumetriEffect.js';
import './effects/RotoEffect.js';
import './effects/EssentialAudioEffect.js';

// Deferred modules — dynamically imported after core init to speed up cold start
let lumetriColorPanel = null;
let essentialAudioPanel = null;
let maskOverlay = null;
let rotoOverlay = null;
let maskTrackingController = null;
let segmentationManager = null;

// Cached SSC reference — populated once the dynamic import resolves at init
// time so destroyEditor() can call cleanup() synchronously before the bridges
// and event bus are torn down.
let _sequenceStreamController = null;

let initialized = false;
let buttonHandlers = [];

function tryInit(name, fn) {
  try {
    fn();
    return true;
  } catch (err) {
    logger.error(`[Editor] Failed to init ${name}:`, err.message, err.stack);
    return false;
  }
}

export function initEditor() {
  if (initialized) return;

  const container = document.getElementById('video-editor');
  if (!container) {
    logger.error('[Editor] Container #video-editor not found');
    return;
  }

  logger.info('[Editor] Initializing video editor...');

  // Helper: init a panel module by dock panel ID
  const initPanel = (name, panelId, mod) =>
    tryInit(name, () => {
      const el = dockManager.getPanelContentEl(panelId);
      if (!el) { logger.warn(`[Editor] ${panelId} panel not found, skipping ${name}`); return; }
      mod.init(el);
    });

  // Helper: init a module from a sub-element within the timeline panel
  const initTimelineSub = (name, selector, mod) =>
    tryInit(name, () => {
      const timelineContent = dockManager.getPanelContentEl('timeline');
      const el = timelineContent?.querySelector(selector);
      if (!el) { logger.warn(`[Editor] ${selector} not found, skipping ${name}`); return; }
      mod.init(el);
    });

  // Init OPFS cache (async, non-blocking -- thumbnails check availability)
  opfsCache.init();

  // Init metadata cache (async, non-blocking -- media import checks availability)
  metadataCache.init();

  // Init timeline model
  tryInit('TimelineEngine', () => timelineEngine.init());

  // Init dock manager (must be first UI module -- extracts panels & builds layout)
  const dockOk = tryInit('DockManager', () => dockManager.init(container.querySelector('.nle-editor')));
  if (!dockOk) {
    logger.error('[Editor] DockManager init failed — aborting panel initialization');
    initialized = false;
    return;
  }

  // Init menu bar
  tryInit('MenuBar', () => {
    const el = container.querySelector('.nle-menubar');
    if (!el) { logger.warn('[Editor] .nle-menubar not found, skipping MenuBar'); return; }
    menuBar.init(el);
  });

  // Init program monitor
  initPanel('ProgramMonitor', 'program-monitor', programMonitor);

  // Init transform overlay (must come after ProgramMonitor)
  tryInit('TransformOverlay', () => {
    const el = dockManager.getPanelContentEl('program-monitor');
    if (el) transformOverlay.init(el);
  });

  // Init source monitor
  initPanel('SourceMonitor', 'source-monitor', sourceMonitor);

  // Init project panel
  initPanel('ProjectPanel', 'project', projectPanel);

  // Init effects panel
  initPanel('EffectsPanel', 'effects', effectsPanel);

  // Init audio meters panel
  initPanel('AudioMetersPanel', 'audio-meters', audioMetersPanel);

  // Init properties panel (basic clip info)
  initPanel('BasicPropertiesPanel', 'properties', basicPropertiesPanel);

  // Init effect controls panel (split-panel with keyframe timeline)
  initPanel('EffectControls', 'effect-controls', propertiesPanel);

  // Init timeline (content lives inside the timeline panel content element)
  initTimelineSub('TimelineUI', '.nle-timeline-panel', timelineUI);

  // Init transport controls
  initTimelineSub('TransportControls', '.nle-transport', transportControls);

  // Init toolbar
  initTimelineSub('Toolbar', '.nle-toolbar', toolbar);

  // Init timeline toolbar (snap, linked selection, markers, display settings)
  initTimelineSub('TimelineToolbar', '.nle-timeline-toolbar', timelineToolbar);

  // Init render-ahead manager (decode worker + buffer)
  tryInit('RenderAheadManager', () => renderAheadManager.init());

  // Init SequenceStreamController — timeline-aware per-clip VLC stream
  // orchestration (replaces the old MediaDecoder.initPlaybackSync() global).
  // Cache the reference so destroyEditor() can call cleanup() synchronously.
  import('./playback/SequenceStreamController.js').then(({ sequenceStreamController }) => {
    _sequenceStreamController = sequenceStreamController;
    sequenceStreamController.init();
  }).catch(() => {});

  // Init conform encoder (pre-encode at sequence settings during idle)
  tryInit('ConformEncoder', () => conformEncoder.init());

  // Init sequence settings panel
  initPanel('SequenceSettingsPanel', 'sequence-settings', sequenceSettingsPanel);

  // Lumetri Color and Essential Audio panels: defer to after core init
  // (effects are already registered via side-effect imports above)

  // Init playback engine (register with RAF scheduler)
  tryInit('PlaybackEngine', () => playbackEngine.init());

  // Init audio mixer
  tryInit('AudioMixer', () => audioMixer.init());

  // Init keyboard shortcuts
  tryInit('KeyboardShortcuts', () => keyboardShortcuts.init());

  // Helper to register button handlers that can be cleaned up later
  const addButtonListener = (selector, handler) => {
    const btn = container.querySelector(selector);
    if (btn) {
      btn.addEventListener('click', handler);
      buttonHandlers.push(() => btn.removeEventListener('click', handler));
    }
  };

  // Export button
  addButtonListener('.nle-export-btn', () => {
    exportDialog.show();
  });

  // Save button
  addButtonListener('.nle-save-btn', async () => {
    try {
      await projectManager.save();
      logger.info('[Editor] Project saved');
    } catch (err) {
      logger.error('[Editor] Save failed:', err);
    }
  });

  // Back button
  addButtonListener('.nle-back-btn', () => {
    exitEditor();
  });

  // Undo button
  addButtonListener('.nle-undo-btn', () => history.undo());

  // Redo button
  addButtonListener('.nle-redo-btn', () => history.redo());

  // Snap button
  addButtonListener('.nle-snap-btn', () => {
    const snap = !editorState.get(STATE_PATHS.UI_SNAP_ENABLED);
    editorState.set(STATE_PATHS.UI_SNAP_ENABLED, snap);
    const snapBtn = container.querySelector('.nle-snap-btn');
    if (snapBtn) snapBtn.classList.toggle('active', snap);
  });

  // Start autosave
  tryInit('ProjectManager autosave', () => {
    projectManager.startAutosave();
  });

  initialized = true;
  logger.info('[Editor] Video editor initialized');

  // Deferred init: load optional modules after core UI has rendered.
  // These modules are not needed for initial editor display.
  _initDeferredModules(container);
}

async function _initDeferredModules(container) {
  try {
    // Load all deferred modules in parallel
    const [lumetriMod, essentialAudioMod, maskMod, rotoMod, trackMod, segMod] = await Promise.all([
      import('./ui/LumetriColorPanel.js'),
      import('./ui/EssentialAudioPanel.js'),
      import('./ui/MaskOverlay.js'),
      import('./ui/RotoOverlay.js'),
      import('./effects/MaskTrackingController.js'),
      import('./media/SegmentationManager.js'),
    ]);

    lumetriColorPanel = lumetriMod.lumetriColorPanel;
    essentialAudioPanel = essentialAudioMod.essentialAudioPanel;
    maskOverlay = maskMod.maskOverlay;
    rotoOverlay = rotoMod.rotoOverlay;
    maskTrackingController = trackMod.maskTrackingController;
    segmentationManager = segMod.segmentationManager;

    // Init panels
    const lumetriEl = dockManager.getPanelContentEl('lumetri-color');
    if (lumetriEl) lumetriColorPanel.init(lumetriEl);

    const essentialAudioEl = dockManager.getPanelContentEl('essential-audio');
    if (essentialAudioEl) essentialAudioPanel.init(essentialAudioEl);

    // Init overlays on program monitor
    const monitorEl = dockManager.getPanelContentEl('program-monitor');
    if (monitorEl) {
      maskOverlay.init(monitorEl);
      rotoOverlay.init(monitorEl);
    }

    maskTrackingController.init();
    segmentationManager.init();
    logger.info('[Editor] Deferred modules loaded');
  } catch (err) {
    logger.error('[Editor] Deferred module init error:', err);
  }
}

export function exitEditor() {
  playbackEngine.pause();
}

export function destroyEditor() {
  if (!initialized) return;
  logger.info('[Editor] Destroying editor...');

  // Remove button listeners
  buttonHandlers.forEach(fn => fn());
  buttonHandlers = [];

  playbackEngine.pause();
  projectManager.stopAutosave();
  if (maskTrackingController) maskTrackingController.cleanup();
  if (rotoOverlay) rotoOverlay.cleanup();
  if (maskOverlay) maskOverlay.cleanup();
  transformOverlay.cleanup();
  audioMetersPanel.destroy();
  propertiesPanel.destroy();
  basicPropertiesPanel.destroy();
  sequenceSettingsPanel.destroy();
  if (lumetriColorPanel) lumetriColorPanel.destroy();
  if (essentialAudioPanel) essentialAudioPanel.destroy();
  dockManager.destroy();
  timelineToolbar.cleanup();
  rafScheduler.cleanup();
  waveformCanvasPool.cleanup();
  if (segmentationManager) segmentationManager.cleanup();
  // Clean up SSC synchronously before renderAheadManager and mediaManager so
  // all VLC stream handles are released while bridges are still valid.
  if (_sequenceStreamController) {
    _sequenceStreamController.cleanup();
    _sequenceStreamController = null;
  }
  conformEncoder.cleanup();
  renderAheadManager.cleanup();
  videoCompositor.cleanup();
  audioMixer.cleanup();
  mediaManager.cleanup();
  keyboardShortcuts.cleanup();
  eventBus.removeAll();
  history.clear();

  initialized = false;
  logger.info('[Editor] Editor destroyed');
}

// Keep cleanupEditor as alias for backwards compatibility
export const cleanupEditor = destroyEditor;

export default { initEditor, exitEditor, destroyEditor, cleanupEditor };

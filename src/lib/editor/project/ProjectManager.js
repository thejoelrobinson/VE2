// Save/load/autosave editor projects to IndexedDB
import { editorState } from '../core/EditorState.js';
import { timelineEngine } from '../timeline/TimelineEngine.js';
import { mediaManager } from '../media/MediaManager.js';
import { mediaDecoder } from '../media/MediaDecoder.js';
import { serializeProject, validateProject, migrateV1ToV2 } from './ProjectSchema.js';
import { createTrack } from '../timeline/Track.js';
import { createClip } from '../timeline/Clip.js';
import { EDITOR_EVENTS, STATE_PATHS, MEDIA_TYPES } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import logger from '../../utils/logger.js';

const DB_NAME = 'VideoChatRecordings';
const PROJECT_STORE = 'editorProjects';
const MEDIA_CACHE_STORE = 'editorMediaCache';

let autosaveTimer = null;

function restoreTracks(trackDataArray) {
  return trackDataArray.map(td => {
    const track = createTrack({
      id: td.id,
      name: td.name,
      type: td.type,
      height: td.height
    });
    track.muted = td.muted;
    track.solo = td.solo;
    track.locked = td.locked;
    track.clips = td.clips.map(cd => {
      const clip = createClip({
        id: cd.id,
        mediaId: cd.mediaId,
        trackId: cd.trackId,
        name: cd.name,
        startFrame: cd.startFrame,
        sourceInFrame: cd.sourceInFrame,
        sourceOutFrame: cd.sourceOutFrame,
        speed: cd.speed,
        color: cd.color
      });
      clip.volume = cd.volume;
      clip.disabled = cd.disabled;
      if (cd.audioType) clip.audioType = cd.audioType;
      clip.linkedClipId = cd.linkedClipId || null;
      clip.effects = cd.effects || [];
      return clip;
    });
    return track;
  });
}

export const projectManager = {
  async save(projectId = null) {
    const data = serializeProject(editorState, timelineEngine, mediaManager);
    const id = projectId || `project-${Date.now()}`;
    data.id = id;

    try {
      const db = await this._getDB();
      const tx = db.transaction([PROJECT_STORE], 'readwrite');
      const store = tx.objectStore(PROJECT_STORE);
      await new Promise((resolve, reject) => {
        const req = store.put(data);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });

      // Save media file data to cache — wait for full transaction completion
      const mediaItems = [];
      for (const item of mediaManager.getAllItems()) {
        if (item.file || item.fileHandle) {
          mediaItems.push({
            id: item.id,
            projectId: id,
            name: item.name,
            type: item.type,
            fileHandle: item.fileHandle || null,
            file: item.file || null
          });
        }
      }
      if (mediaItems.length > 0) {
        const mediaTx = db.transaction([MEDIA_CACHE_STORE], 'readwrite');
        const mediaStore = mediaTx.objectStore(MEDIA_CACHE_STORE);
        await new Promise((resolve, reject) => {
          mediaTx.oncomplete = () => resolve();
          mediaTx.onerror = () => reject(mediaTx.error);
          mediaTx.onabort = () => reject(new Error('Media cache transaction aborted'));
          for (const item of mediaItems) {
            mediaStore.put(item);
          }
        });
      }

      editorState.markClean();
      logger.info(`Project saved: ${id}`);
      return id;
    } catch (err) {
      logger.error('Failed to save project:', err);
      throw err;
    }
  },

  async load(projectId) {
    try {
      const db = await this._getDB();

      // Load project data
      const tx = db.transaction([PROJECT_STORE], 'readonly');
      const store = tx.objectStore(PROJECT_STORE);
      let data = await new Promise((resolve, reject) => {
        const req = store.get(projectId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      if (!data || !validateProject(data)) {
        throw new Error('Invalid project data');
      }

      // Migrate v1 → v2 if needed
      if (data.version === 1) {
        logger.info('[ProjectManager] Migrating v1 project to v2 (multi-sequence)');
        data = migrateV1ToV2(data);
      }

      // Load media files from cache
      const mediaTx = db.transaction([MEDIA_CACHE_STORE], 'readonly');
      const mediaStore = mediaTx.objectStore(MEDIA_CACHE_STORE);
      const mediaIndex = mediaStore.index('projectId');
      const mediaFiles = await new Promise((resolve, reject) => {
        const req = mediaIndex.getAll(projectId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      // Restore project-level state
      editorState.set(STATE_PATHS.PROJECT_NAME, data.project.name);
      editorState.set(STATE_PATHS.PROJECT_NEXT_SEQUENCE_ID, data.project.nextSequenceId || 2);

      // Restore sequences with track hydration
      const rawState = editorState.getState();
      const restoredSequences = {};
      for (const [seqId, seqData] of Object.entries(data.sequences)) {
        restoredSequences[seqId] = {
          id: seqData.id,
          name: seqData.name,
          frameRate: seqData.frameRate,
          canvas: { ...seqData.canvas },
          codec: seqData.codec,
          bitrate: seqData.bitrate,
          bitrateMode: seqData.bitrateMode || 'variable',
          quality: seqData.quality || 'medium',
          colorPreset: seqData.colorPreset || 'legacy',
          workingSpace: seqData.workingSpace || 'rec709',
          outputSpace: seqData.outputSpace || 'rec709',
          linearCompositing: seqData.linearCompositing ?? false,
          colorSpaceAwareEffects: seqData.colorSpaceAwareEffects ?? false,
          tracks: restoreTracks(seqData.tracks),
          duration: seqData.duration || 0,
          markers: (seqData.markers || []).map(m => ({ ...m })),
          playback: {
            inPoint: seqData.playback?.inPoint ?? null,
            outPoint: seqData.playback?.outPoint ?? null
          }
        };
      }
      rawState.sequences = restoredSequences;
      rawState.activeSequenceId = data.activeSequenceId;

      // Restore media items
      mediaManager.cleanup();
      const mediaFileMap = new Map(mediaFiles.map(mf => [mf.id, mf]));
      const pendingPermissions = [];
      for (const mediaData of (data.media || [])) {
        const cached = mediaFileMap.get(mediaData.id);
        if (!cached) continue;

        let file = null;
        let fileHandle = cached.fileHandle || null;

        // Try FileSystemFileHandle first (survives page reload)
        if (fileHandle) {
          try {
            const perm = await fileHandle.queryPermission({ mode: 'read' });
            if (perm === 'granted') {
              file = await fileHandle.getFile();
            } else if (perm === 'prompt') {
              // Need user gesture to request — defer to UI
              pendingPermissions.push({ mediaData, fileHandle, cached });
            }
          } catch (e) {
            logger.warn(`[ProjectManager] Could not restore handle for ${cached.name}:`, e.message);
            fileHandle = null;
          }
        }

        // Fallback to stored File object (current session only)
        if (!file && cached.file) {
          file = cached.file;
        }

        if (file) {
          if (fileHandle) file._fileHandle = fileHandle;
          const items = await mediaManager.importFiles([file]);
          if (items.length > 0) {
            const item = items[0];
            const oldId = item.id;
            const allItems = editorState.get(STATE_PATHS.MEDIA_ITEMS);
            allItems.delete(oldId);
            item.id = mediaData.id;
            allItems.set(mediaData.id, item);
            // Fix decoder registration so decode requests use the saved ID
            mediaDecoder.releaseMediaFile(oldId);
            mediaDecoder.registerMediaFile(mediaData.id, file);
          }
        } else if (!pendingPermissions.find(p => p.mediaData.id === mediaData.id)) {
          // Add offline placeholder so clips don't reference missing media
          const allItems = editorState.get(STATE_PATHS.MEDIA_ITEMS);
          allItems.set(mediaData.id, {
            id: mediaData.id,
            name: cached.name,
            type: cached.type,
            offline: true
          });
          logger.warn(`[ProjectManager] Media ${cached.name} is offline — needs re-import or permission grant`);
        }
      }

      // Restore MXF audio URL from OPFS cache (fast — bytes already stored from prior session)
      for (const mediaData of (data.media || [])) {
        const allItems = editorState.get(STATE_PATHS.MEDIA_ITEMS);
        const item = allItems.get(mediaData.id);
        if (item
            && item.type === MEDIA_TYPES.VIDEO
            && item.name?.toLowerCase().endsWith('.mxf')
            && mediaData.hasMxfAudio
            && item.file) {
          import('../media/MXFAudioExtractor.js').then(({ extractMXFAudio }) => {
            extractMXFAudio(item.file).then(audioUrl => {
              if (audioUrl) item.audioUrl = audioUrl;
            });
          });
        }
      }

      // If any handles need permission, store them for UI to resolve via user gesture
      if (pendingPermissions.length > 0) {
        editorState.set(STATE_PATHS.PROJECT_PENDING_MEDIA_PERMISSIONS, pendingPermissions);
        logger.info(`[ProjectManager] ${pendingPermissions.length} media file(s) need permission — awaiting user gesture`);
      }

      editorState.markClean();

      // Notify all UI that sequence changed (triggers full rebuild)
      eventBus.emit(EDITOR_EVENTS.SEQUENCE_ACTIVATED, { id: rawState.activeSequenceId });
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);

      logger.info(`Project loaded: ${projectId} (${Object.keys(restoredSequences).length} sequences)`);
      return true;
    } catch (err) {
      logger.error('Failed to load project:', err);
      throw err;
    }
  },

  async listProjects() {
    try {
      const db = await this._getDB();
      const tx = db.transaction([PROJECT_STORE], 'readonly');
      const store = tx.objectStore(PROJECT_STORE);
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => {
          const projects = req.result.map(p => {
            // Handle both v1 and v2 formats
            let trackCount = 0;
            let clipCount = 0;
            if (p.sequences) {
              for (const seq of Object.values(p.sequences)) {
                trackCount += (seq.tracks || []).length;
                clipCount += (seq.tracks || []).reduce((sum, t) => sum + (t.clips || []).length, 0);
              }
            } else if (p.timeline) {
              trackCount = p.timeline.tracks.length;
              clipCount = p.timeline.tracks.reduce((sum, t) => sum + t.clips.length, 0);
            }
            return {
              id: p.id,
              name: p.project.name,
              savedAt: p.savedAt,
              trackCount,
              clipCount
            };
          });
          projects.sort((a, b) => b.savedAt - a.savedAt);
          resolve(projects);
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      logger.error('Failed to list projects:', err);
      return [];
    }
  },

  async deleteProject(projectId) {
    try {
      const db = await this._getDB();
      const tx = db.transaction([PROJECT_STORE, MEDIA_CACHE_STORE], 'readwrite');
      tx.objectStore(PROJECT_STORE).delete(projectId);

      // Delete associated media cache
      const mediaStore = tx.objectStore(MEDIA_CACHE_STORE);
      const index = mediaStore.index('projectId');
      const req = index.getAll(projectId);
      req.onsuccess = () => {
        for (const item of req.result) {
          mediaStore.delete(item.id);
        }
      };

      logger.info(`Project deleted: ${projectId}`);
    } catch (err) {
      logger.error('Failed to delete project:', err);
    }
  },

  // Call from a user gesture (click handler) to request permission for
  // file handles that returned 'prompt' during project load
  async grantPendingPermissions() {
    const pending = editorState.get(STATE_PATHS.PROJECT_PENDING_MEDIA_PERMISSIONS);
    if (!pending || pending.length === 0) return 0;

    let restored = 0;
    for (const { mediaData, fileHandle } of pending) {
      try {
        const perm = await fileHandle.requestPermission({ mode: 'read' });
        if (perm === 'granted') {
          const file = await fileHandle.getFile();
          file._fileHandle = fileHandle;
          const items = await mediaManager.importFiles([file]);
          if (items.length > 0) {
            const item = items[0];
            const allItems = editorState.get(STATE_PATHS.MEDIA_ITEMS);
            allItems.delete(item.id);
            item.id = mediaData.id;
            allItems.set(mediaData.id, item);
            restored++;
          }
        }
      } catch (e) {
        logger.warn(`[ProjectManager] Permission denied for ${mediaData.id}:`, e.message);
      }
    }

    editorState.set(STATE_PATHS.PROJECT_PENDING_MEDIA_PERMISSIONS, []);
    if (restored > 0) {
      eventBus.emit(EDITOR_EVENTS.TIMELINE_UPDATED);
      logger.info(`[ProjectManager] Restored ${restored} media file(s) after permission grant`);
    }
    return restored;
  },

  _saving: false,
  _exporting: false,

  setExporting(bool) {
    this._exporting = !!bool;
  },

  startAutosave(intervalMs = 30000) {
    this.stopAutosave();
    autosaveTimer = setInterval(async () => {
      if (this._saving) return;
      if (this._exporting) return;
      if (editorState.get(STATE_PATHS.PROJECT_DIRTY)) {
        this._saving = true;
        try {
          const currentId = editorState.get(STATE_PATHS.PROJECT_AUTOSAVE_ID);
          const id = await this.save(currentId || 'autosave');
          editorState.set(STATE_PATHS.PROJECT_AUTOSAVE_ID, id);
        } catch (e) {
          logger.warn('[ProjectManager] Autosave failed:', e.message);
        } finally {
          this._saving = false;
        }
      }
    }, intervalMs);
    logger.info(`Autosave started (${intervalMs}ms interval)`);
  },

  stopAutosave() {
    if (autosaveTimer) {
      clearInterval(autosaveTimer);
      autosaveTimer = null;
    }
  },

  async _getDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 4);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Existing stores
        if (!db.objectStoreNames.contains('recordingChunks')) {
          const store = db.createObjectStore('recordingChunks', { keyPath: 'id', autoIncrement: true });
          store.createIndex('sessionId', 'sessionId');
          store.createIndex('timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('recordingMetadata')) {
          const metaStore = db.createObjectStore('recordingMetadata', { keyPath: 'sessionId' });
          metaStore.createIndex('source', 'source');
          metaStore.createIndex('startTime', 'startTime');
        }
        if (!db.objectStoreNames.contains('chatMessages')) {
          const chatStore = db.createObjectStore('chatMessages', { keyPath: 'id' });
          chatStore.createIndex('sessionId', 'sessionId');
          chatStore.createIndex('timestamp', 'timestamp');
        }
        if (!db.objectStoreNames.contains('chatFiles')) {
          const filesStore = db.createObjectStore('chatFiles', { keyPath: 'id' });
          filesStore.createIndex('messageId', 'messageId');
        }
        // New editor stores
        if (!db.objectStoreNames.contains(PROJECT_STORE)) {
          db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(MEDIA_CACHE_STORE)) {
          const mediaCache = db.createObjectStore(MEDIA_CACHE_STORE, { keyPath: 'id' });
          mediaCache.createIndex('projectId', 'projectId');
        }
      };
    });
  }
};

export default projectManager;

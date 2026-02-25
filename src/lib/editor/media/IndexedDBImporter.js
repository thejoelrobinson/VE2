// Import recordings from existing VideoChatRecordings IndexedDB
import { mediaManager } from './MediaManager.js';
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS } from '../core/Constants.js';
import logger from '../../utils/logger.js';

const DB_NAME = 'VideoChatRecordings';
const CHUNKS_STORE = 'recordingChunks';
const METADATA_STORE = 'recordingMetadata';

export const indexedDBImporter = {
  // List all available recordings from the app's IndexedDB
  async listRecordings() {
    try {
      const db = await this._openDB();
      const recordings = new Map();

      // Get all metadata
      const metaTx = db.transaction([METADATA_STORE], 'readonly');
      const metaStore = metaTx.objectStore(METADATA_STORE);
      const allMeta = await this._getAll(metaStore);

      const metaMap = new Map();
      for (const item of allMeta) {
        metaMap.set(item.sessionId, item);
      }

      // Get chunk stats per session
      const chunkTx = db.transaction([CHUNKS_STORE], 'readonly');
      const chunkStore = chunkTx.objectStore(CHUNKS_STORE);
      const allChunks = await this._getAll(chunkStore);

      // Group chunks by session
      const sessionChunks = new Map();
      for (const chunk of allChunks) {
        if (!sessionChunks.has(chunk.sessionId)) {
          sessionChunks.set(chunk.sessionId, {
            count: 0,
            totalSize: 0,
            firstTimestamp: Infinity,
            lastTimestamp: 0
          });
        }
        const info = sessionChunks.get(chunk.sessionId);
        info.count++;
        info.totalSize += chunk.size || 0;
        if (chunk.timestamp < info.firstTimestamp) info.firstTimestamp = chunk.timestamp;
        if (chunk.timestamp > info.lastTimestamp) info.lastTimestamp = chunk.timestamp;
      }

      // Build recording list
      for (const [sessionId, chunkInfo] of sessionChunks) {
        const meta = metaMap.get(sessionId) || {};
        const duration = chunkInfo.lastTimestamp > chunkInfo.firstTimestamp
          ? (chunkInfo.lastTimestamp - chunkInfo.firstTimestamp) / 1000
          : 0;

        recordings.set(sessionId, {
          sessionId,
          label: meta.label || 'Recording',
          source: meta.source || 'unknown',
          startTime: meta.startTime || chunkInfo.firstTimestamp,
          chunks: chunkInfo.count,
          totalSize: chunkInfo.totalSize,
          duration,
          formattedSize: this._formatSize(chunkInfo.totalSize),
          formattedDuration: this._formatDuration(duration)
        });
      }

      db.close();
      return recordings;
    } catch (err) {
      logger.error('Failed to list recordings:', err);
      return new Map();
    }
  },

  // Import a recording as a media item into the editor
  async importRecording(sessionId) {
    try {
      const db = await this._openDB();

      // Get all chunks for this session
      const tx = db.transaction([CHUNKS_STORE], 'readonly');
      const index = tx.objectStore(CHUNKS_STORE).index('sessionId');
      const chunks = await this._getAll(index, sessionId);

      if (chunks.length === 0) {
        throw new Error(`No chunks found for session ${sessionId}`);
      }

      // Sort by timestamp and assemble blob
      chunks.sort((a, b) => a.timestamp - b.timestamp);
      const blob = new Blob(chunks.map(c => c.chunk), { type: 'video/webm' });

      // Get metadata for naming
      const metaTx = db.transaction([METADATA_STORE], 'readonly');
      const metaStore = metaTx.objectStore(METADATA_STORE);
      const meta = await this._get(metaStore, sessionId);

      const label = meta?.label || 'Recording';
      const date = new Date(meta?.startTime || chunks[0].timestamp);
      const filename = `${label}_${date.toISOString().slice(0, 19).replace(/[T:]/g, '-')}.webm`;

      // Create File object from blob
      const file = new File([blob], filename, { type: 'video/webm' });

      db.close();

      // Import into media manager
      const items = await mediaManager.importFiles([file]);
      if (items.length > 0) {
        logger.info(`Imported recording "${filename}" (${this._formatSize(blob.size)})`);
        return items[0];
      }

      return null;
    } catch (err) {
      logger.error(`Failed to import recording ${sessionId}:`, err);
      throw err;
    }
  },

  // Import multiple recordings
  async importMultiple(sessionIds) {
    const results = [];
    for (const id of sessionIds) {
      try {
        const item = await this.importRecording(id);
        if (item) results.push(item);
      } catch (err) {
        logger.warn(`Skipping recording ${id}:`, err);
      }
    }
    return results;
  },

  _openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  },

  _getAll(storeOrIndex, query) {
    return new Promise((resolve, reject) => {
      const request = query !== undefined
        ? storeOrIndex.getAll(query)
        : storeOrIndex.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  },

  _get(store, key) {
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  },

  _formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  },

  _formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
};

export default indexedDBImporter;

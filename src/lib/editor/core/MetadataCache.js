// IndexedDB cache for parsed media metadata (sample tables, codec config, probe results, waveform peaks)
import logger from '../../utils/logger.js';

const DB_NAME = 'nle-metadata-cache';
const DB_VERSION = 1;
const STORE_NAME = 'metadata';

export const metadataCache = {
  _db: null,
  _disabled: false,
  _writeQueue: new Map(),

  async init() {
    return new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
          store.createIndex('cachedAt', 'cachedAt');
        }
      };
      req.onsuccess = (e) => {
        this._db = e.target.result;
        logger.info('[MetadataCache] Initialized');
        // Evict stale entries on startup (non-blocking)
        this.evictStale(30).catch(() => {});
        resolve();
      };
      req.onerror = (e) => {
        logger.warn('[MetadataCache] Failed to open:', e.target.error);
        this._disabled = true;
        resolve(); // non-fatal — cache is optional
      };
    });
  },

  // Generate cache key from File identity (name + size + lastModified)
  getCacheKey(file) {
    return `${file.name}|${file.size}|${file.lastModified}`;
  },

  // Get cached metadata for a file (returns null on miss)
  async get(file) {
    if (this._disabled || !this._db) return null;
    const key = this.getCacheKey(file);
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  },

  // Store metadata for a file (serialized per-key to prevent race conditions)
  async set(file, metadata) {
    if (this._disabled || !this._db) return;
    const key = this.getCacheKey(file);
    const prev = this._writeQueue.get(key) || Promise.resolve();
    const next = prev.then(() => this._doSet(key, metadata)).catch(() => {});
    this._writeQueue.set(key, next);
    return next;
  },

  // Internal: performs the actual read-merge-write IDB transaction
  async _doSet(key, metadata) {
    if (!this._db) return;
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // Read existing entry first to merge (avoids overwriting data from other callers)
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const existing = getReq.result || {};
        const merged = { ...existing, ...metadata, cacheKey: key, cachedAt: Date.now() };
        store.put(merged);
      };
      getReq.onerror = () => {
        // No existing entry — write fresh
        store.put({ ...metadata, cacheKey: key, cachedAt: Date.now() });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve(); // non-fatal
    });
  },

  // Evict entries older than maxAgeDays
  async evictStale(maxAgeDays = 30) {
    if (this._disabled || !this._db) return;
    const cutoff = Date.now() - (maxAgeDays * 86400000);
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_NAME, 'readwrite');
      const index = tx.objectStore(STORE_NAME).index('cachedAt');
      const range = IDBKeyRange.upperBound(cutoff);
      const req = index.openCursor(range);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },

  async clear() {
    if (this._disabled || !this._db) return;
    return new Promise((resolve) => {
      const tx = this._db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
};

export default metadataCache;

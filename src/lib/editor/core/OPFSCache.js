import logger from '../../utils/logger.js';

let _nextId = 0;

export const opfsCache = {
  _root: null,
  _available: false,
  _worker: null,
  _pending: new Map(), // id -> { resolve, reject }

  async init() {
    try {
      if (!navigator.storage?.getDirectory) {
        logger.info('[OPFSCache] OPFS not available');
        return;
      }
      this._root = await navigator.storage.getDirectory();
      this._available = true;

      // Request persistent storage (prevents browser eviction)
      try { await navigator.storage.persist(); } catch (_) {}

      // Try to init the sync worker for faster I/O
      try {
        this._worker = new Worker(
          new URL('./OPFSWorker.js', import.meta.url),
          { type: 'module' }
        );
        this._worker.onmessage = (e) => {
          const { id, result, error } = e.data;
          const p = this._pending.get(id);
          if (!p) return;
          this._pending.delete(id);
          if (error) p.reject(new Error(error));
          else p.resolve(result);
        };
        this._worker.onerror = () => {
          logger.warn('[OPFSCache] Worker error, falling back to async path');
          this._worker = null;
          // Reject all pending worker requests so callers fall through to async path
          for (const [, p] of this._pending) {
            p.reject(new Error('OPFS worker died'));
          }
          this._pending.clear();
        };
        logger.info('[OPFSCache] Initialized with sync worker');
      } catch (_) {
        logger.info('[OPFSCache] Sync worker not available, using async path');
        this._worker = null;
      }

      if (!this._worker) {
        logger.info('[OPFSCache] Initialized (async path)');
      }
    } catch (e) {
      logger.warn('[OPFSCache] Init failed:', e.message);
    }
  },

  _postWorker(type, dirName, fileName, data) {
    return new Promise((resolve, reject) => {
      const id = ++_nextId;
      this._pending.set(id, { resolve, reject });
      const msg = { type, id, dirName, fileName };
      if (data !== undefined) {
        // Transfer ArrayBuffer for zero-copy
        if (data instanceof ArrayBuffer) {
          msg.data = data;
          this._worker.postMessage(msg, [data]);
        } else {
          msg.data = data;
          this._worker.postMessage(msg);
        }
      } else {
        this._worker.postMessage(msg);
      }
    });
  },

  isAvailable() {
    return this._available;
  },

  // Get or create a subdirectory under OPFS root
  async _getDir(name) {
    if (!this._root) return null;
    return this._root.getDirectoryHandle(name, { create: true });
  },

  // Check if a cache file exists
  async has(dirName, fileName) {
    if (!this._root) return false;
    if (this._worker) {
      try { return await this._postWorker('has', dirName, fileName); }
      catch (_) { /* fall through to async path */ }
    }
    try {
      const dir = await this._root.getDirectoryHandle(dirName);
      await dir.getFileHandle(fileName);
      return true;
    } catch (_) {
      return false;
    }
  },

  // Read a cached file as an ArrayBuffer
  async read(dirName, fileName) {
    if (!this._root) return null;
    if (this._worker) {
      try {
        const result = await this._postWorker('read', dirName, fileName);
        return result;
      } catch (_) { /* fall through to async path */ }
    }
    try {
      const dir = await this._root.getDirectoryHandle(dirName);
      const fh = await dir.getFileHandle(fileName);
      const file = await fh.getFile();
      return await file.arrayBuffer();
    } catch (e) {
      if (e.name !== 'NotFoundError') {
        logger.warn(`[OPFSCache] Read failed ${dirName}/${fileName}:`, e.name, e.message);
      }
      return null;
    }
  },

  // Read a cached file as a Blob URL (for thumbnails)
  // Note: must use async path since worker can't create Blob URLs for main thread
  async readAsURL(dirName, fileName) {
    if (!this._root) return null;
    try {
      const dir = await this._root.getDirectoryHandle(dirName);
      const fh = await dir.getFileHandle(fileName);
      const file = await fh.getFile();
      return URL.createObjectURL(file);
    } catch (e) {
      if (e.name !== 'NotFoundError') {
        logger.warn(`[OPFSCache] ReadAsURL failed ${dirName}/${fileName}:`, e.name, e.message);
      }
      return null;
    }
  },

  // Write binary data to OPFS
  async write(dirName, fileName, data) {
    if (!this._root) return false;
    if (this._worker) {
      try {
        // Clone into a transferable ArrayBuffer
        const buf = data instanceof ArrayBuffer
          ? data.slice(0)
          : (ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : new Uint8Array(data).buffer);
        return await this._postWorker('write', dirName, fileName, buf);
      } catch (_) { /* fall through to async path */ }
    }
    try {
      const dir = await this._root.getDirectoryHandle(dirName, { create: true });
      const fh = await dir.getFileHandle(fileName, { create: true });
      if (fh.createWritable) {
        const writable = await fh.createWritable();
        await writable.write(data);
        await writable.close();
      } else {
        logger.warn('[OPFSCache] createWritable not supported, skipping write');
        return false;
      }
      return true;
    } catch (e) {
      logger.warn(`[OPFSCache] Write failed ${dirName}/${fileName}: [${e.name}]`, e.message, e);
      return false;
    }
  },

  // Delete a single cache file
  async remove(dirName, fileName) {
    if (!this._root) return;
    if (this._worker) {
      try { await this._postWorker('remove', dirName, fileName); return; }
      catch (_) { /* fall through */ }
    }
    try {
      const dir = await this._root.getDirectoryHandle(dirName);
      await dir.removeEntry(fileName);
    } catch (_) {}
  },

  // Clear an entire cache directory
  async clearDir(dirName) {
    if (!this._root) return;
    if (this._worker) {
      try { await this._postWorker('clearDir', dirName); return; }
      catch (_) { /* fall through */ }
    }
    try {
      await this._root.removeEntry(dirName, { recursive: true });
    } catch (_) {}
  },

  // Clear all caches
  async clearAll() {
    await this.clearDir('thumbnails');
    await this.clearDir('waveforms');
    logger.info('[OPFSCache] All caches cleared');
  }
};

export default opfsCache;

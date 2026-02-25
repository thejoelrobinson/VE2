// Dedicated OPFS worker using createSyncAccessHandle for high-throughput I/O.
// All OPFS operations run on this worker thread for 3-4x faster reads/writes
// compared to the main-thread async API.

const handles = new Map(); // `${dir}/${file}` -> { accessHandle, dirHandle, fileHandle }

async function getRoot() {
  return navigator.storage.getDirectory();
}

async function getOrCreateDir(root, name) {
  return root.getDirectoryHandle(name, { create: true });
}

// Get a sync access handle for a file, caching for reuse
async function getSyncHandle(dirName, fileName, create = false) {
  const key = `${dirName}/${fileName}`;
  if (handles.has(key)) return handles.get(key).accessHandle;

  const root = await getRoot();
  const dir = await getOrCreateDir(root, dirName);
  const fileHandle = await dir.getFileHandle(fileName, { create });
  const accessHandle = await fileHandle.createSyncAccessHandle();
  handles.set(key, { accessHandle, dirHandle: dir, fileHandle });
  return accessHandle;
}

function releaseSyncHandle(dirName, fileName) {
  const key = `${dirName}/${fileName}`;
  const entry = handles.get(key);
  if (entry) {
    try { entry.accessHandle.close(); } catch (_) {}
    handles.delete(key);
  }
}

self.onmessage = async (e) => {
  const { type, id, dirName, fileName, data } = e.data;

  try {
    switch (type) {
      case 'read': {
        let handle;
        try {
          handle = await getSyncHandle(dirName, fileName);
        } catch (_) {
          // File doesn't exist — return null without throwing
          self.postMessage({ id, result: null });
          break;
        }
        const size = handle.getSize();
        if (size === 0) {
          self.postMessage({ id, result: null });
          break;
        }
        const buffer = new ArrayBuffer(size);
        handle.read(new Uint8Array(buffer), { at: 0 });
        // Transfer the buffer for zero-copy
        self.postMessage({ id, result: buffer }, [buffer]);
        break;
      }

      case 'write': {
        const handle = await getSyncHandle(dirName, fileName, true);
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
        handle.truncate(0);
        handle.write(bytes, { at: 0 });
        handle.flush();
        self.postMessage({ id, result: true });
        break;
      }

      case 'has': {
        try {
          const root = await getRoot();
          const dir = await root.getDirectoryHandle(dirName);
          await dir.getFileHandle(fileName);
          self.postMessage({ id, result: true });
        } catch (_) {
          self.postMessage({ id, result: false });
        }
        break;
      }

      case 'remove': {
        releaseSyncHandle(dirName, fileName);
        try {
          const root = await getRoot();
          const dir = await root.getDirectoryHandle(dirName);
          await dir.removeEntry(fileName);
        } catch (_) {}
        self.postMessage({ id, result: true });
        break;
      }

      case 'clearDir': {
        // Release all handles for this directory
        for (const [key, entry] of handles) {
          if (key.startsWith(dirName + '/')) {
            try { entry.accessHandle.close(); } catch (_) {}
            handles.delete(key);
          }
        }
        try {
          const root = await getRoot();
          await root.removeEntry(dirName, { recursive: true });
        } catch (_) {}
        self.postMessage({ id, result: true });
        break;
      }

      default:
        self.postMessage({ id, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};

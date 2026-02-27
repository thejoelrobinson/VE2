// Project bin: import, organize, metadata catalog
import { editorState } from '../core/EditorState.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS, MEDIA_TYPES, SUPPORTED_EXTENSIONS, STATE_PATHS } from '../core/Constants.js';
import { mediaDecoder } from './MediaDecoder.js';
import { metadataCache } from '../core/MetadataCache.js';
import { createVLCBridge } from './VLCBridge.js';
import { extractMXFAudio } from './MXFAudioExtractor.js';
import logger from '../../utils/logger.js';

let mediaIdCounter = 0;

function getMediaType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  if (SUPPORTED_EXTENSIONS.VIDEO.includes(ext)) return MEDIA_TYPES.VIDEO;
  if (SUPPORTED_EXTENSIONS.AUDIO.includes(ext)) return MEDIA_TYPES.AUDIO;
  if (SUPPORTED_EXTENSIONS.IMAGE.includes(ext)) return MEDIA_TYPES.IMAGE;
  return null;
}

function probeMedia(file) {
  return new Promise((resolve, reject) => {
    const type = getMediaType(file.name);
    if (!type) {
      reject(new Error(`Unsupported file type: ${file.name}`));
      return;
    }

    // VIDEO: probe through VLC first (all formats). VLC gives accurate
    // duration/fps/resolution for containers the browser may struggle with
    // (MXF, AVI, MKV, etc.). Falls back to HTMLVideoElement if VLC fails.
    if (type === MEDIA_TYPES.VIDEO) {
      // Predict the mediaId that importFiles will assign so VLCDecoder can
      // look up this bridge later — avoids _fs_destroy/_fs_create cycles
      // that hang the shared libvlc WASM instance.
      const predictedId = `media-${mediaIdCounter + 1}`;
      const probeBridge = createVLCBridge(predictedId);
      probeBridge.loadFile(file)
        .then(({ durationMs, width, height, fps }) => {
          // Store the bridge for VLCDecoder to reuse. With _exclusivePlay
          // in VLCWorker, multiple handles coexist safely (only one is
          // active at a time).
          if (!mediaManager._vlcProbedBridges) mediaManager._vlcProbedBridges = new Map();
          mediaManager._vlcProbedBridges.set(predictedId, probeBridge);
          const url = URL.createObjectURL(file);
          resolve({ type, duration: durationMs / 1000, width, height, fps, url });
        })
        .catch(err => {
          probeBridge.release();
          // Fallback to HTMLVideoElement
          const url = URL.createObjectURL(file);
          const video = document.createElement('video');
          video.preload = 'metadata';
          video.onloadedmetadata = () => {
            resolve({
              type,
              duration: video.duration || 0,
              width: video.videoWidth || 0,
              height: video.videoHeight || 0,
              url
            });
          };
          video.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(`Failed to probe media: ${file.name}`));
          };
          video.src = url;
        });
      return;
    }

    const url = URL.createObjectURL(file);

    if (type === MEDIA_TYPES.IMAGE) {
      const img = new Image();
      img.onload = () => {
        resolve({
          type,
          duration: 5, // Default 5s for images
          width: img.naturalWidth,
          height: img.naturalHeight,
          url
        });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to load image: ${file.name}`));
      };
      img.src = url;
      return;
    }

    // Audio (video is handled above via VLC probe)
    const el = document.createElement('audio');

    el.preload = 'metadata';

    el.onloadedmetadata = () => {
      resolve({
        type,
        duration: el.duration || 0,
        width: 0,
        height: 0,
        url
      });
    };

    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to probe media: ${file.name}`));
    };

    el.src = url;
  });
}

export const mediaManager = {
  async importFiles(fileList) {
    const items = [];
    const failedFiles = [];
    for (const file of fileList) {
      try {
        // Check metadata cache before probing
        const cached = await metadataCache.get(file);
        let info;
        // Video: always re-probe via VLC (bridge must be created for decoding)
        const isVideo = getMediaType(file.name) === MEDIA_TYPES.VIDEO;
        if (!isVideo && cached && cached.type && cached.duration != null) {
          info = {
            type: cached.type,
            duration: cached.duration,
            width: cached.width || 0,
            height: cached.height || 0,
            fps: cached.fps || null,
            url: URL.createObjectURL(file)
          };
          logger.info(`[MetadataCache] Cache hit for ${file.name}`);
        } else {
          info = await probeMedia(file);
          // Cache probe results for future reloads
          await metadataCache.set(file, {
            type: info.type,
            duration: info.duration,
            width: info.width,
            height: info.height,
            fps: info.fps || null
          });
        }

        const item = {
          id: `media-${++mediaIdCounter}`,
          name: file.name,
          file,
          fileHandle: file._fileHandle || null,
          type: info.type,
          duration: info.duration,
          width: info.width,
          height: info.height,
          fps: info.fps || null,
          url: info.url,
          size: file.size,
          thumbnails: [],
          waveform: null
        };
        editorState.get(STATE_PATHS.MEDIA_ITEMS).set(item.id, item);

        // Register File handle for VLC streaming decode
        if (info.type === MEDIA_TYPES.VIDEO) {
          mediaDecoder.registerMediaFile(item.id, file);
        }

        // MXF: launch background audio extraction. audioUrl is set when ready.
        if (info.type === MEDIA_TYPES.VIDEO && file.name.toLowerCase().endsWith('.mxf')) {
          item.audioUrl = null;
          extractMXFAudio(file).then(audioUrl => {
            if (audioUrl) {
              item.audioUrl = audioUrl;
              eventBus.emit(EDITOR_EVENTS.MEDIA_AUDIO_READY, { id: item.id, item });
            }
          }).catch(err => {
            logger.warn(`[MediaManager] MXF audio extraction failed for ${file.name}:`, err.message);
          });
        }

        items.push(item);
        logger.info(`Imported media: ${file.name} (${info.type}, ${info.duration.toFixed(1)}s)`);
        eventBus.emit(EDITOR_EVENTS.MEDIA_IMPORTED, { item });
      } catch (err) {
        logger.error(`Failed to import ${file.name}:`, err);
        failedFiles.push(file.name);
      }
    }
    if (failedFiles.length > 0) {
      logger.warn(`Failed to import ${failedFiles.length} file(s): ${failedFiles.join(', ')}`);
      eventBus.emit(EDITOR_EVENTS.IMPORT_PARTIAL, { failedFiles });
    }
    return items;
  },

  getItem(id) {
    return editorState.get(STATE_PATHS.MEDIA_ITEMS).get(id);
  },

  getAllItems() {
    return [...editorState.get(STATE_PATHS.MEDIA_ITEMS).values()];
  },

  removeItem(id) {
    const items = editorState.get(STATE_PATHS.MEDIA_ITEMS);
    const item = items.get(id);
    if (item) {
      if (item.url) URL.revokeObjectURL(item.url);
      if (item.audioUrl && item.audioUrl.startsWith('blob:')) URL.revokeObjectURL(item.audioUrl);
      // Revoke cached thumbnail blob URLs (from OPFS cache reads)
      if (item.thumbnails) {
        for (const thumb of item.thumbnails) {
          if (thumb.url && thumb.url.startsWith('blob:')) URL.revokeObjectURL(thumb.url);
        }
      }
      mediaDecoder.releaseMediaFile(id);
      items.delete(id);
      eventBus.emit(EDITOR_EVENTS.MEDIA_REMOVED, { id });
    }
  },

  cleanup() {
    const items = editorState.get(STATE_PATHS.MEDIA_ITEMS);
    for (const [id, item] of items) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
    items.clear();
  },

  // Open file picker — uses showOpenFilePicker (Chromium) for persistent handles,
  // falls back to <input type="file"> on other browsers
  async openFilePicker() {
    if ('showOpenFilePicker' in window) {
      try {
        const handles = await window.showOpenFilePicker({
          types: [{
            description: 'Media Files',
            accept: {
              'video/*': SUPPORTED_EXTENSIONS.VIDEO.map(e => `.${e}`),
              'audio/*': SUPPORTED_EXTENSIONS.AUDIO.map(e => `.${e}`),
              'image/*': SUPPORTED_EXTENSIONS.IMAGE.map(e => `.${e}`)
            }
          }],
          multiple: true
        });

        const files = [];
        for (const handle of handles) {
          const file = await handle.getFile();
          file._fileHandle = handle;
          files.push(file);
        }

        return this.importFiles(files);
      } catch (e) {
        if (e.name === 'AbortError') return []; // user cancelled
        logger.warn('[MediaManager] showOpenFilePicker failed, falling back:', e.message);
      }
    }

    // Fallback: hidden input element (no persistent handle)
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = [
        ...SUPPORTED_EXTENSIONS.VIDEO.map(e => `.${e}`),
        ...SUPPORTED_EXTENSIONS.AUDIO.map(e => `.${e}`),
        ...SUPPORTED_EXTENSIONS.IMAGE.map(e => `.${e}`)
      ].join(',');

      input.onchange = async () => {
        if (input.files.length > 0) {
          const items = await this.importFiles(input.files);
          resolve(items);
        } else {
          resolve([]);
        }
      };

      input.click();
    });
  }
};

export default mediaManager;

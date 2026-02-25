// Extract frame thumbnails from video files using OffscreenCanvas
import { MEDIA_TYPES } from '../core/Constants.js';
import { eventBus } from '../core/EventBus.js';
import { EDITOR_EVENTS } from '../core/Constants.js';
import { opfsCache } from '../core/OPFSCache.js';
import { generateMediaHash } from '../../utils/mediaUtils.js';
import logger from '../../utils/logger.js';

const THUMB_HEIGHT = 40;
const THUMB_INTERVAL_SEC = 2; // One thumbnail every 2 seconds

export const thumbnailGenerator = {
  async generateThumbnails(mediaItem, count = null) {
    if (mediaItem.type === MEDIA_TYPES.AUDIO) return [];
    if (mediaItem.type === MEDIA_TYPES.IMAGE) {
      return this._generateImageThumbnail(mediaItem);
    }
    if (mediaItem.name?.toLowerCase().endsWith('.mxf')) {
      return this._generateMXFThumbnails(mediaItem, count);
    }
    return this._generateVideoThumbnails(mediaItem, count);
  },

  async _generateVideoThumbnails(mediaItem, count) {
    const hash = generateMediaHash(mediaItem);

    // Check OPFS cache first
    if (opfsCache.isAvailable()) {
      const cached = await opfsCache.has('thumbnails', `${hash}_0.jpg`);
      if (cached) {
        const thumbs = [];
        for (let i = 0; i < 5000; i++) {
          const url = await opfsCache.readAsURL('thumbnails', `${hash}_${i}.jpg`);
          if (!url) break;
          thumbs.push({ time: i * THUMB_INTERVAL_SEC, url, width: 0, height: THUMB_HEIGHT });
        }
        if (thumbs.length > 0) {
          mediaItem.thumbnails = thumbs;
          eventBus.emit(EDITOR_EVENTS.MEDIA_THUMBNAILS_READY, { mediaId: mediaItem.id });
          return thumbs;
        }
      }
    }

    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = mediaItem.url;

    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = reject;
    });

    const duration = video.duration;
    if (!count) {
      count = Math.max(1, Math.ceil(duration / THUMB_INTERVAL_SEC));
    }
    count = Math.min(count, 60); // Cap

    const aspectRatio = video.videoWidth / video.videoHeight;
    const thumbWidth = Math.round(THUMB_HEIGHT * aspectRatio);

    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = THUMB_HEIGHT;
    const ctx = canvas.getContext('2d');

    const thumbnails = [];
    for (let i = 0; i < count; i++) {
      const time = (i / count) * duration;
      video.currentTime = time;

      await new Promise((resolve) => {
        video.onseeked = resolve;
      });

      ctx.drawImage(video, 0, 0, thumbWidth, THUMB_HEIGHT);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      thumbnails.push({
        time,
        url: dataUrl,
        width: thumbWidth,
        height: THUMB_HEIGHT
      });

      // Cache thumbnail to OPFS
      if (opfsCache.isAvailable()) {
        try {
          const resp = await fetch(dataUrl);
          const blob = await resp.blob();
          const buffer = await blob.arrayBuffer();
          await opfsCache.write('thumbnails', `${hash}_${i}.jpg`, new Uint8Array(buffer));
        } catch (_) {
          // Non-critical -- continue without caching
        }
      }
    }

    // Release GPU memory held by the canvas
    canvas.width = 0;
    canvas.height = 0;

    // Release video resource
    video.src = '';
    video.load();
    mediaItem.thumbnails = thumbnails;
    eventBus.emit(EDITOR_EVENTS.MEDIA_THUMBNAILS_READY, { mediaId: mediaItem.id });
    return thumbnails;
  },

  async _generateMXFThumbnails(mediaItem, count) {
    const hash = generateMediaHash(mediaItem);

    // Check OPFS cache
    if (opfsCache.isAvailable()) {
      const cached = await opfsCache.has('thumbnails', `${hash}_0.jpg`);
      if (cached) {
        const thumbs = [];
        for (let i = 0; i < 60; i++) {
          const url = await opfsCache.readAsURL('thumbnails', `${hash}_${i}.jpg`);
          if (!url) break;
          thumbs.push({ time: i * THUMB_INTERVAL_SEC, url, width: 0, height: THUMB_HEIGHT });
        }
        if (thumbs.length > 0) {
          mediaItem.thumbnails = thumbs;
          eventBus.emit(EDITOR_EVENTS.MEDIA_THUMBNAILS_READY, { mediaId: mediaItem.id });
          return thumbs;
        }
      }
    }

    const { createVLCBridge } = await import('./VLCBridge.js');
    const bridge = createVLCBridge('_thumb_' + mediaItem.id);
    try {
      await bridge.loadFile(mediaItem.file);
    } catch (err) {
      bridge.release();
      logger.warn(`[ThumbnailGenerator] VLC not available for MXF thumbnails: ${err.message}`);
      return [];
    }

    const duration = mediaItem.duration || 0;
    if (!count) count = Math.max(1, Math.ceil(duration / THUMB_INTERVAL_SEC));
    count = Math.min(count, 10); // MXF seek is slower — cap at 10

    const aspectRatio = (mediaItem.width || 1920) / (mediaItem.height || 1080);
    const thumbWidth = Math.round(THUMB_HEIGHT * aspectRatio);

    const thumbnails = [];
    for (let i = 0; i < count; i++) {
      const time = Math.max(0, (i / count) * duration);
      try {
        const bmp = await bridge.getFrameAt(time);
        if (!bmp) continue;

        const canvas = document.createElement('canvas');
        canvas.width = thumbWidth;
        canvas.height = THUMB_HEIGHT;
        const ctx = canvas.getContext('2d');
        try {
          ctx.drawImage(bmp, 0, 0, thumbWidth, THUMB_HEIGHT);
        } finally {
          bmp.close(); // always free GPU memory even if drawImage throws
        }

        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        thumbnails.push({ time, url: dataUrl, width: thumbWidth, height: THUMB_HEIGHT });

        if (opfsCache.isAvailable()) {
          try {
            const resp = await fetch(dataUrl);
            const blob = await resp.blob();
            const buf = await blob.arrayBuffer();
            await opfsCache.write('thumbnails', `${hash}_${i}.jpg`, new Uint8Array(buf));
          } catch (_) {}
        }

        canvas.width = 0; canvas.height = 0;
      } catch (err) {
        logger.warn(`[ThumbnailGenerator] MXF thumb at ${time}s failed:`, err.message);
      }
    }

    bridge.release(); // Release thumbnail bridge — decoder makes its own
    mediaItem.thumbnails = thumbnails;
    eventBus.emit(EDITOR_EVENTS.MEDIA_THUMBNAILS_READY, { mediaId: mediaItem.id });
    return thumbnails;
  },

  async _generateImageThumbnail(mediaItem) {
    const img = new Image();
    img.src = mediaItem.url;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    if (img.naturalWidth === 0 || img.naturalHeight === 0) {
      logger.warn(`[ThumbnailGenerator] Invalid image dimensions for ${mediaItem.name}`);
      return [];
    }
    const aspectRatio = img.naturalWidth / img.naturalHeight;
    const thumbWidth = Math.round(THUMB_HEIGHT * aspectRatio);

    const canvas = document.createElement('canvas');
    canvas.width = thumbWidth;
    canvas.height = THUMB_HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, thumbWidth, THUMB_HEIGHT);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    const thumbnails = [{
      time: 0,
      url: dataUrl,
      width: thumbWidth,
      height: THUMB_HEIGHT
    }];

    mediaItem.thumbnails = thumbnails;
    eventBus.emit(EDITOR_EVENTS.MEDIA_THUMBNAILS_READY, { mediaId: mediaItem.id });
    return thumbnails;
  }
};

export default thumbnailGenerator;

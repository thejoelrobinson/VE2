// Worker-safe media access -- decodes images and video without DOM.
// Video frames are pre-decoded on the main thread (via VLC) and transferred
// as ImageBitmaps keyed by time in ms.

export function createWorkerMediaDecoder() {
  const imageBitmaps = new Map(); // mediaId -> ImageBitmap
  const videoBuffers = new Map(); // mediaId -> { type, blob/buffer/frames }

  return {
    // Register media transferred from main thread
    registerImage(mediaId, blob) {
      videoBuffers.set(mediaId, { type: 'image', blob });
    },

    registerVideo(mediaId, fileOrBuffer) {
      // Accept File (streaming path, ~0 memory) or ArrayBuffer (legacy)
      if (fileOrBuffer instanceof ArrayBuffer) {
        videoBuffers.set(mediaId, { type: 'video', buffer: fileOrBuffer });
      } else {
        videoBuffers.set(mediaId, { type: 'video', file: fileOrBuffer });
      }
    },

    registerAudio(mediaId, fileOrBuffer) {
      // Audio registration -- stored for potential future Worker-side decode
      videoBuffers.set(mediaId, { type: 'audio', source: fileOrBuffer });
    },

    // Get an ImageBitmap for an image media item
    async getImageBitmap(mediaId) {
      if (imageBitmaps.has(mediaId)) {
        return imageBitmaps.get(mediaId);
      }

      const entry = videoBuffers.get(mediaId);
      if (!entry || entry.type !== 'image') return null;

      const bitmap = await createImageBitmap(entry.blob);
      imageBitmaps.set(mediaId, bitmap);
      return bitmap;
    },

    // Get a video frame as ImageBitmap at the given time.
    // Uses pre-decoded frames transferred from main thread (VLC decode path).
    async getVideoFrame(mediaId, timeSeconds) {
      const entry = videoBuffers.get(mediaId);
      if (!entry) return null;

      // Pre-decoded ImageBitmaps (keyed by time in ms)
      if (entry.type === 'frames') {
        const key = Math.round(timeSeconds * 1000);
        return entry.frames.get(key) || null;
      }

      console.warn(`[WorkerMediaDecoder] No decode path for ${mediaId}: type=${entry.type}`);
      return null;
    },

    registerFrames(mediaId, framesMap) {
      videoBuffers.set(mediaId, { type: 'frames', frames: framesMap });
    },

    cleanup() {
      for (const [, bitmap] of imageBitmaps) {
        bitmap.close();
      }
      imageBitmaps.clear();
      videoBuffers.clear();
    }
  };
}

export default createWorkerMediaDecoder;

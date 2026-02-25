// Segmentation Worker stub — MediaPipe Interactive Segmenter runs on the main
// thread (requires DOM access for canvas/WebGL). This worker file exists only
// so Vite doesn't break the import in SegmentationManager.js.
// Actual segmentation logic lives in SegmentationManager._segmentOnMainThread().

self.onmessage = () => {
  self.postMessage({ type: 'init_error', message: 'MediaPipe runs on main thread, not in worker' });
};

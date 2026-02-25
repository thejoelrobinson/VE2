// Reusable canvas pool for waveform rendering (avoids per-clip allocation)

class CanvasPool {
  constructor(initialSize = 15) {
    this._pool = [];
    this._active = new Set();
    for (let i = 0; i < initialSize; i++) {
      this._pool.push(document.createElement('canvas'));
    }
  }

  acquire(width, height) {
    const canvas = this._pool.pop() || document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    this._active.add(canvas);
    return canvas;
  }

  release(canvas) {
    if (!this._active.has(canvas)) return;
    this._active.delete(canvas);
    this._pool.push(canvas);
  }

  cleanup() {
    this._pool = [];
    this._active.clear();
  }
}

export const waveformCanvasPool = new CanvasPool(15);
export default waveformCanvasPool;

// Centralized requestAnimationFrame scheduler.
// Merges multiple rAF consumers into a single loop, sorted by priority.

export const PRIORITY = {
  PLAYBACK: 0,
  RENDER: 1,
  UI: 2
};

let nextId = 0;

export const rafScheduler = {
  _consumers: new Map(),  // id -> { callback, priority, active }
  _sorted: [],            // rebuilt on add/remove
  _running: false,
  _rafId: null,
  _activeCount: 0,

  register(callback, priority) {
    const id = ++nextId;
    this._consumers.set(id, { callback, priority, active: false });
    this._rebuildSorted();
    return id;
  },

  unregister(id) {
    const consumer = this._consumers.get(id);
    if (consumer?.active) {
      this._activeCount--;
    }
    this._consumers.delete(id);
    this._rebuildSorted();
    if (this._consumers.size === 0 || this._activeCount === 0) {
      this._stop();
    }
  },

  activate(id) {
    const consumer = this._consumers.get(id);
    if (!consumer || consumer.active) return;
    consumer.active = true;
    this._activeCount++;
    if (!this._running || !this._rafId) {
      this._running = true;
      this._rafId = requestAnimationFrame((ts) => this._tick(ts));
    }
  },

  deactivate(id) {
    const consumer = this._consumers.get(id);
    if (!consumer || !consumer.active) return;
    consumer.active = false;
    this._activeCount--;
    if (this._activeCount === 0) {
      this._stop();
    }
  },

  _stop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._running = false;
  },

  _rebuildSorted() {
    this._sorted = Array.from(this._consumers.entries())
      .sort(([, a], [, b]) => a.priority - b.priority);
  },

  _tick(timestamp) {
    let anyActive = false;
    for (const [, consumer] of this._sorted) {
      if (consumer.active) {
        anyActive = true;
        try {
          consumer.callback(timestamp);
        } catch (err) {
          // Isolate consumer errors — a single bad callback must not stop the loop
          console.error('[RafScheduler] Consumer callback threw:', err);
        }
      }
    }
    if (anyActive) {
      this._rafId = requestAnimationFrame((ts) => this._tick(ts));
    } else {
      this._running = false;
      this._rafId = null;
    }
  },

  cleanup() {
    this._stop();
    this._consumers.clear();
    this._sorted = [];
    this._activeCount = 0;
  }
};

/**
 * Schedule low-priority background work that yields to user interactions.
 * Uses scheduler.postTask('background') when available, falls back to setTimeout.
 */
export const scheduleBackground = (fn) =>
  globalThis.scheduler?.postTask
    ? scheduler.postTask(fn, { priority: 'background' })
    : new Promise(resolve => setTimeout(() => resolve(fn()), 0));

export default rafScheduler;

// Pub/sub event bus for cross-module communication

class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
      if (listeners.size === 0) this._listeners.delete(event);
    }
  }

  emit(event, data) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    for (const cb of listeners) {
      try {
        cb(data);
      } catch (err) {
        console.error(`[EventBus] Error in listener for "${event}":`, err);
      }
    }
  }

  once(event, callback) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    this.on(event, wrapper);
    return () => this.off(event, wrapper);
  }

  removeAll(event) {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }
}

export const eventBus = new EventBus();
export default eventBus;

/**
 * Subscribe to multiple events at once. Returns an unsubscribe function
 * that removes all listeners in one call.
 *
 * Usage:
 *   this._unsub = subscribeEvents({
 *     [EDITOR_EVENTS.CLIP_SELECTED]: () => this._render(),
 *     [EDITOR_EVENTS.PLAYBACK_FRAME]: () => this._update(),
 *   });
 *   // later in destroy():
 *   this._unsub();
 */
export function subscribeEvents(eventMap) {
  const entries = Object.entries(eventMap);
  for (const [event, handler] of entries) {
    eventBus.on(event, handler);
  }
  return () => {
    for (const [event, handler] of entries) {
      eventBus.off(event, handler);
    }
  };
}

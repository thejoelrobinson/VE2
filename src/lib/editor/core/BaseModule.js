// Factory function that provides standard lifecycle and cleanup patterns for UI modules
// Eliminates ~350 lines of repetitive cleanup boilerplate across 27 modules

import { subscribeEvents } from './EventBus.js';
import { editorState } from './EditorState.js';
import logger from '../../utils/logger.js';

/**
 * Create a module with built-in cleanup management.
 * Provides helper methods that auto-track cleanup functions.
 *
 * Usage:
 *   export const myModule = createModule({
 *     init(container) {
 *       this._subscribeEvents({
 *         [EDITOR_EVENTS.FOO]: () => this._render(),
 *       });
 *       this._listen(container, 'click', () => {});
 *       this._setTimeout(() => {}, 100);
 *     },
 *     _render() { ... }
 *   });
 *
 * Cleanup is automatic:
 * - All EventBus subscriptions unsubscribed
 * - All EditorState subscriptions unsubscribed
 * - All DOM listeners removed
 * - All ResizeObservers disconnected
 * - All timeouts cleared
 * - All intervals cleared
 * - All custom cleanup functions executed
 */
export function createModule(definition) {
  return {
    ...definition,
    _cleanups: [],

    /**
     * Subscribe to multiple EventBus events at once.
     * Automatically cleaned up in cleanup().
     */
    _subscribeEvents(eventMap) {
      const unsub = subscribeEvents(eventMap);
      this._addCleanup(unsub);
      return unsub;
    },

    /**
     * Subscribe to an EditorState path.
     * Automatically cleaned up in cleanup().
     */
    _subscribeState(path, callback) {
      const unsub = editorState.subscribe(path, callback);
      this._addCleanup(unsub);
      return unsub;
    },

    /**
     * Add a DOM event listener.
     * Automatically cleaned up in cleanup().
     */
    _listen(target, event, handler, options) {
      if (!target) return;
      target.addEventListener(event, handler, options);
      this._addCleanup(() => {
        try {
          target.removeEventListener(event, handler, options);
        } catch (_err) {
          // Target may have been removed from DOM
        }
      });
      return () => target.removeEventListener(event, handler, options);
    },

    /**
     * Create a ResizeObserver.
     * Automatically cleaned up in cleanup().
     */
    _observeResize(callback, target) {
      const observer = new ResizeObserver(callback);
      if (target) observer.observe(target);
      this._addCleanup(() => {
        try {
          observer.disconnect();
        } catch (_err) {
          // Already disconnected
        }
      });
      return observer;
    },

    /**
     * Set a timeout.
     * Automatically cleaned up in cleanup().
     */
    _setTimeout(callback, delay) {
      const id = setTimeout(callback, delay);
      this._addCleanup(() => clearTimeout(id));
      return id;
    },

    /**
     * Set an interval.
     * Automatically cleaned up in cleanup().
     */
    _setInterval(callback, delay) {
      const id = setInterval(callback, delay);
      this._addCleanup(() => clearInterval(id));
      return id;
    },

    /**
     * Register a custom cleanup function.
     * Executed in cleanup() in LIFO order.
     */
    _addCleanup(fn) {
      if (typeof fn !== 'function') {
        logger.warn('_addCleanup: expected function, got', typeof fn);
        return;
      }
      this._cleanups.push(fn);
    },

    /**
     * Execute all cleanup functions.
     * Called automatically by the cleanup orchestrator.
     * Catches errors to prevent one cleanup from blocking others.
     */
    cleanup() {
      // Execute in LIFO order (reverse order of registration)
      for (let i = this._cleanups.length - 1; i >= 0; i--) {
        try {
          this._cleanups[i]();
        } catch (err) {
          logger.warn('Cleanup error:', err);
        }
      }
      this._cleanups = [];
    }
  };
}

export default createModule;

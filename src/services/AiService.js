/**
 * Promise-based front end for the AI search. Runs `core/ai/ai.worker.js` in a
 * module Web Worker so the main thread keeps rendering while the engine thinks;
 * falls back to the synchronous search (on a macrotask) when workers are
 * unavailable or the worker crashes.
 *
 * Results are never applied here: callers re-validate the game state when the
 * promise settles, because an undo or pause may have happened mid-search.
 */
import { findBestMove } from '../core/ai/Search.js';
import { momentum } from '../core/ai/Evaluate.js';

function defaultCreateWorker() {
  return new Worker(new URL('../core/ai/ai.worker.js', import.meta.url), { type: 'module' });
}

export class AiService {
  /**
   * @param {{ createWorker?: () => Worker, useWorker?: boolean }} [options]
   */
  constructor({ createWorker = defaultCreateWorker, useWorker = true } = {}) {
    /** @type {Worker | null} */
    this.worker = null;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
    this._pending = new Map();
    this._nextId = 1;

    if (useWorker && typeof Worker !== 'undefined') {
      try {
        this.worker = createWorker();
        this.worker.onmessage = (event) => this._onMessage(event.data);
        this.worker.onerror = (event) => {
          console.warn('[zenith] AI worker failed, continuing on the main thread:', event.message ?? event);
          this._fallbackToMainThread();
        };
      } catch (err) {
        console.warn('[zenith] AI worker unavailable, continuing on the main thread:', err);
        this.worker = null;
      }
    }
  }

  /** True while searches run in the worker. */
  get offThread() {
    return this.worker !== null;
  }

  /**
   * @param {object} state  core GameState
   * @param {object} [options] findBestMove options
   * @returns {Promise<import('../core/ai/Search.js').SearchResult | null>}
   */
  findBestMove(state, options = {}) {
    return this._request('best', state, options);
  }

  /**
   * Best move plus board momentum (0..1 black advantage) for the coach.
   * @returns {Promise<(import('../core/ai/Search.js').SearchResult & { momentum: number }) | null>}
   */
  analyze(state, options = {}) {
    return this._request('analyze', state, options);
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const { resolve } of this._pending.values()) resolve(null);
    this._pending.clear();
  }

  // ---------------------------------------------------------------------------

  _request(type, state, options) {
    if (!this.worker) return this._runLocally(type, state, options);
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, state, options });
    });
  }

  _onMessage(data) {
    const entry = this._pending.get(data?.id);
    if (!entry) return;
    this._pending.delete(data.id);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error ?? 'AI worker error'));
  }

  /** Same computation on the main thread, deferred one macrotask so the current frame can finish. */
  _runLocally(type, state, options) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          const best = findBestMove(state, options);
          if (type === 'analyze') {
            resolve(best ? { ...best, momentum: momentum(state.board, state.rules?.mode) } : null);
          } else {
            resolve(best);
          }
        } catch (err) {
          reject(err);
        }
      }, 0);
    });
  }

  _fallbackToMainThread() {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    // Nothing in flight can be recovered from a dead worker; callers re-schedule on null.
    for (const { resolve } of this._pending.values()) resolve(null);
    this._pending.clear();
  }
}

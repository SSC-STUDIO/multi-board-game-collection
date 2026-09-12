/**
 * Web Worker entry point: runs the alpha-beta search off the main thread so a
 * long think never stalls the render loop. Only DOM-free core modules are
 * imported here, which is what makes it loadable as a module worker without a
 * bundler.
 *
 * Protocol: { id, type: 'best' | 'analyze', state, options } →
 *           { id, ok: true, result } | { id, ok: false, error }
 */
import { findBestMove } from './Search.js';
import { momentum } from './Evaluate.js';

self.onmessage = (event) => {
  const { id, type, state, options } = event.data ?? {};
  try {
    if (type === 'best') {
      self.postMessage({ id, ok: true, result: findBestMove(state, options) });
    } else if (type === 'analyze') {
      const best = findBestMove(state, options);
      const result = best ? { ...best, momentum: momentum(state.board, state.rules?.mode) } : null;
      self.postMessage({ id, ok: true, result });
    } else {
      self.postMessage({ id, ok: false, error: `Unknown request type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err) });
  }
};

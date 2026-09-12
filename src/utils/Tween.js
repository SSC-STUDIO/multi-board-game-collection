/**
 * Minimal promise-based tween scheduler used by every 3D entity.
 * Pure JS (no Three.js / DOM) so it can be unit-tested under Node.
 *
 * Usage inside an entity:
 *   this.tweens.add({ duration: 450, ease: cubicEaseInOut, onUpdate: (k) => { ... } })
 *     .then(() => { ... });
 *   // and in update(dt): this.tweens.update(dt);
 */
import { cubicEaseInOut, clamp01 } from './Easing.js';

export class Tweens {
  constructor() {
    /** @type {Array<TweenHandle>} */
    this.active = [];
  }

  get busy() {
    return this.active.length > 0;
  }

  /**
   * @param {object} spec
   * @param {number} spec.duration      milliseconds
   * @param {number} [spec.delay]       milliseconds before the tween starts
   * @param {(t:number)=>number} [spec.ease]
   * @param {(k:number, raw:number)=>void} [spec.onUpdate]  k = eased progress, raw = linear progress
   * @param {() => void} [spec.onComplete]
   * @returns {Promise<void> & { cancel: () => void }}
   */
  add({ duration, delay = 0, ease = cubicEaseInOut, onUpdate, onComplete }) {
    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    const handle = {
      elapsed: -delay / 1000,
      duration: Math.max(duration, 1) / 1000,
      ease,
      onUpdate,
      onComplete,
      resolve: resolveFn,
      cancelled: false,
    };
    this.active.push(handle);

    promise.cancel = () => {
      handle.cancelled = true;
    };
    return promise;
  }

  /** Convenience: resolve after `ms` milliseconds of scene time. */
  wait(ms) {
    return this.add({ duration: ms, ease: (t) => t });
  }

  /** @param {number} dt seconds since last frame */
  update(dt) {
    if (this.active.length === 0) return;
    const survivors = [];
    for (const tw of this.active) {
      if (tw.cancelled) {
        tw.resolve();
        continue;
      }
      tw.elapsed += dt;
      if (tw.elapsed < 0) {
        survivors.push(tw);
        continue;
      }
      const raw = clamp01(tw.elapsed / tw.duration);
      tw.onUpdate?.(tw.ease(raw), raw);
      if (raw >= 1) {
        tw.onComplete?.();
        tw.resolve();
      } else {
        survivors.push(tw);
      }
    }
    this.active = survivors;
  }

  cancelAll() {
    for (const tw of this.active) {
      tw.cancelled = true;
      tw.resolve();
    }
    this.active = [];
  }
}

/** Real-time sleep (wall clock, not scene time). */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @typedef {object} TweenHandle
 * @property {number} elapsed
 * @property {number} duration
 * @property {(t:number)=>number} ease
 * @property {((k:number, raw:number)=>void)|undefined} onUpdate
 * @property {(()=>void)|undefined} onComplete
 * @property {() => void} resolve
 * @property {boolean} cancelled
 */

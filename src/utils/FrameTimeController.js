/**
 * Hysteresis controller behind the dynamic resolution scaler.
 *
 * Fed with wall-clock frame times (milliseconds between rendered frames), it
 * keeps an exponentially smoothed average and decides when the render scale
 * should step down (sustained over budget) or back up (sustained comfortably
 * under budget). The dead band between the two thresholds is what stops the
 * scale from bouncing every second: a step up multiplies the fill work by
 * roughly (1 / 0.9)^2 ≈ 1.23, so only a reading under ~70 % of the budget can
 * absorb it without immediately tripping the step-down rule again.
 *
 * Pure JS (no Three.js / DOM) so it can be unit-tested under Node.
 */

/** Frames longer than this are tab switches / shader compiles, not render load. */
export const IGNORED_FRAME_MS = 100;

export class FrameTimeController {
  /**
   * @param {object} [options]
   * @param {number} [options.targetFps]      frame rate the budget is derived from
   * @param {number} [options.budgetSlack]    budget = 1000 / targetFps * budgetSlack (1.05 → 17.5 ms at 60 fps)
   * @param {number} [options.lowerAfterMs]   continuous time over budget before stepping down
   * @param {number} [options.raiseAfterMs]   continuous time under `raiseBelow` × budget before stepping up
   * @param {number} [options.raiseBelow]     fraction of the budget that counts as "comfortably under"
   * @param {number} [options.step]           scale change per decision
   * @param {number} [options.minScale]
   * @param {number} [options.maxScale]
   * @param {number} [options.warmupFrames]   frames ignored after construction / reset (shader compiles)
   * @param {number} [options.settleFrames]   frames ignored right after a scale change (target reallocation)
   * @param {number} [options.smoothing]      weight of the newest sample in the moving average
   */
  constructor({
    targetFps = 60,
    budgetSlack = 1.05,
    lowerAfterMs = 750,
    raiseAfterMs = 3000,
    raiseBelow = 0.7,
    step = 0.1,
    minScale = 0.6,
    maxScale = 1.0,
    warmupFrames = 60,
    settleFrames = 10,
    smoothing = 0.1,
  } = {}) {
    this.targetFps = targetFps;
    this.budgetSlack = budgetSlack;
    this.lowerAfterMs = lowerAfterMs;
    this.raiseAfterMs = raiseAfterMs;
    this.raiseBelow = raiseBelow;
    this.step = step;
    this.minScale = minScale;
    this.maxScale = maxScale;
    this.warmupFrames = warmupFrames;
    this.settleFrames = settleFrames;
    this.smoothing = smoothing;

    this._scale = maxScale;
    this._averageMs = 0;
    this._overMs = 0;
    this._underMs = 0;
    this._skip = warmupFrames;
    this._reseed = false;
  }

  /** Current render scale in [minScale, maxScale]. */
  get scale() {
    return this._scale;
  }

  /** Smoothed wall-clock frame time in ms; 0 until the warm-up has passed and a sample arrived. */
  get averageMs() {
    return this._averageMs;
  }

  /** Frame-time budget derived from `targetFps`. */
  get budgetMs() {
    return (1000 / Math.max(1, this.targetFps)) * this.budgetSlack;
  }

  /** True while samples are still being discarded (warm-up or post-change settle). */
  get warmingUp() {
    return this._skip > 0;
  }

  /**
   * Forget the history and restart the warm-up, e.g. after a quality change
   * recompiled every shader. Also puts the scale back to `scale` (default: max).
   * @param {number} [scale]
   */
  reset(scale = this.maxScale) {
    this._scale = this._clamp(scale);
    this._averageMs = 0;
    this._overMs = 0;
    this._underMs = 0;
    this._skip = this.warmupFrames;
    this._reseed = false;
  }

  /**
   * Manual override: clamp and adopt the scale without touching the timing
   * history, so an automatic decision can still follow later.
   * @param {number} scale
   * @returns {number} the scale actually adopted
   */
  setScale(scale) {
    this._scale = this._clamp(scale);
    this._overMs = 0;
    this._underMs = 0;
    return this._scale;
  }

  /**
   * Feed one frame. Returns the new scale when a step was taken, `null` otherwise.
   * @param {number} deltaMs wall-clock time since the previous rendered frame
   * @returns {number | null}
   */
  update(deltaMs) {
    if (!(deltaMs > 0) || deltaMs > IGNORED_FRAME_MS) return null;
    if (this._skip > 0) {
      this._skip--;
      return null;
    }

    if (this._averageMs === 0 || this._reseed) {
      this._averageMs = deltaMs;
      this._reseed = false;
    } else {
      this._averageMs += (deltaMs - this._averageMs) * this.smoothing;
    }

    const budget = this.budgetMs;
    if (this._averageMs > budget) {
      this._overMs += deltaMs;
      this._underMs = 0;
    } else if (this._averageMs < budget * this.raiseBelow) {
      this._underMs += deltaMs;
      this._overMs = 0;
    } else {
      // Dead band: neither rule accumulates, both restart from zero.
      this._overMs = 0;
      this._underMs = 0;
    }

    if (this._overMs >= this.lowerAfterMs && this._scale > this.minScale) {
      return this._stepTo(this._scale - this.step);
    }
    if (this._underMs >= this.raiseAfterMs && this._scale < this.maxScale) {
      return this._stepTo(this._scale + this.step);
    }
    return null;
  }

  /** @param {number} scale */
  _stepTo(scale) {
    this._scale = this._clamp(scale);
    // The average that triggered the step stays readable (log line, debug overlay) but describes
    // the old resolution, so a fresh one is seeded once the resize has settled.
    this._overMs = 0;
    this._underMs = 0;
    this._skip = this.settleFrames;
    this._reseed = true;
    return this._scale;
  }

  /** @param {number} scale */
  _clamp(scale) {
    const clamped = Math.min(this.maxScale, Math.max(this.minScale, scale));
    // Keep the scale on a two-decimal grid so repeated ±0.1 steps stay at 0.8, not 0.7999999.
    return Math.round(clamped * 100) / 100;
  }
}

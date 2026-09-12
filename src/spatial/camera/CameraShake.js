/**
 * Procedural camera micro-shake for stone placement and the victory stamp slam
 * (DIEGETIC_UI_SPEC §5.1: amplitude 0.25, 200 ms decay).
 *
 * The shake is an additive positional offset. CameraDirector rewrites the
 * camera pose every frame, so applying the offset afterwards never accumulates:
 *
 *   director.update(dt);
 *   shake.update(dt);
 *   shake.apply(camera);
 *
 * Node-safe: only THREE.Vector3 is used.
 */
import { Vector3 } from 'three';

const TWO_PI = Math.PI * 2;

/** Tolerance (seconds) so float accumulation of dt cannot leave the decay 1 ulp short. */
const END_EPSILON_S = 1e-6;

/** Envelope: smooth exponential fall-off scaled so it reaches exactly 0 at u = 1. */
function decayEnvelope(u) {
  if (u >= 1) return 0;
  return (1 - u) * Math.exp(-3 * u);
}

/** Per-axis weights: strongest sideways, softer vertically, subtle depth. */
const AXIS_WEIGHT = Object.freeze([1.0, 0.6, 0.4]);

export class CameraShake {
  constructor() {
    /** Offset to add to the camera position this frame (world units). */
    this.offset = new Vector3();

    this._amplitude = 0;
    this._decaySeconds = 0.2;
    this._frequencyHz = 30;
    this._elapsed = 0;
    this._active = false;
    /** @type {number[]} per-axis phases, re-rolled on every trigger */
    this._phase = [0, TWO_PI / 3, (TWO_PI * 2) / 3];
  }

  get active() {
    return this._active;
  }

  /** Peak amplitude of the current shake, 0 when idle. */
  get amplitude() {
    return this._active ? this._amplitude : 0;
  }

  /**
   * Start (or re-energise) a shake. If one is already running the larger of
   * the two amplitudes wins and the decay restarts from full.
   *
   * @param {{ amplitude?: number, decayMs?: number, frequency?: number }} [options]
   *   amplitude in world units, decay in milliseconds, frequency in Hz.
   */
  trigger({ amplitude = 0.25, decayMs = 200, frequency = 30 } = {}) {
    this._amplitude = this._active ? Math.max(this._amplitude, amplitude) : amplitude;
    this._decaySeconds = Math.max(decayMs, 1) / 1000;
    this._frequencyHz = frequency;
    this._elapsed = 0;
    this._active = true;

    const base = Math.random() * TWO_PI;
    this._phase = [base, base + TWO_PI / 3, base + (TWO_PI * 2) / 3];
  }

  /** Cut the shake immediately and clear the offset. */
  stop() {
    this._active = false;
    this._amplitude = 0;
    this._elapsed = 0;
    this.offset.set(0, 0, 0);
  }

  /**
   * Advance the oscillator. The offset is exactly zero once `decayMs` has
   * elapsed and `active` flips back to false on the same frame.
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    if (!this._active) {
      this.offset.set(0, 0, 0);
      return;
    }

    this._elapsed += dt;
    if (this._elapsed + END_EPSILON_S >= this._decaySeconds) {
      this.stop();
      return;
    }

    const u = this._elapsed / this._decaySeconds;
    const env = this._amplitude * decayEnvelope(u);
    const w = TWO_PI * this._frequencyHz * this._elapsed;
    this.offset.set(
      env * AXIS_WEIGHT[0] * Math.sin(w + this._phase[0]),
      env * AXIS_WEIGHT[1] * Math.sin(w + this._phase[1]),
      env * AXIS_WEIGHT[2] * Math.sin(w + this._phase[2]),
    );
  }

  /**
   * Add the current offset to the camera. Call once per frame after the
   * director has written the base pose.
   * @param {import('three').Object3D} camera
   */
  apply(camera) {
    if (this._active) camera.position.add(this.offset);
  }
}

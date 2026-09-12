/**
 * Spatial camera director: a small viewpoint state machine that flies a
 * THREE.PerspectiveCamera between named poses using the "Hermite-Slerp" pose
 * interpolation from utils/Easing.js (linear look-at target, spherical eye
 * offset, cubic ease-in-out).
 *
 * Only the math side of Three.js is used, so the class runs under plain Node
 * for the vitest suite.
 *
 * Frame contract: `update(dt)` writes position / orientation / fov to the
 * camera on EVERY frame, even while idle. CameraShake therefore has to be
 * applied after the director each frame and its offset never accumulates.
 *
 * User orbit: pointer drags / wheel feed `orbitBy()` / `zoomBy()`, which
 * rotate and dolly the eye around the *current* look-at target on top of the
 * directed base pose (with damping and an elevation clamp so the camera can
 * never dive under the table). Every `goTo` / `snapTo` starts from the visible
 * pose and clears the offset, so flights stay seamless.
 */
import {
  addVec3,
  clamp,
  cubicEaseInOut,
  damp,
  interpolatePose,
  lengthVec3,
  subVec3,
} from '../../utils/Easing.js';

const DEG2RAD = Math.PI / 180;

/** Bounds for the user orbit offset (elevation is the eye's angle above the target plane). */
export const USER_ORBIT_LIMITS = Object.freeze({
  minElevationDeg: 8,
  maxElevationDeg: 85,
  minZoom: 0.55,
  maxZoom: 2.0,
  /** Exponential smoothing speed (1/s) for drag input. */
  damping: 14,
  /**
   * Optional axis-aligned box the eye must stay inside (world units), e.g. the
   * room shell so the camera never pokes through a wall or the ceiling.
   * @type {null | { min: number[], max: number[], margin?: number }}
   */
  bounds: null,
});

/**
 * @typedef {import('../../utils/Easing.js').CameraPose} CameraPose
 *
 * @typedef {object} OrbitSpec
 * @property {number} radius     horizontal distance from the target
 * @property {number} height     eye height above the target
 * @property {number} degPerSec  angular speed once the viewpoint is reached
 *
 * @typedef {object} Viewpoint
 * @property {number[]} position
 * @property {number[]} target
 * @property {number} fov
 * @property {OrbitSpec} [orbit]
 */

/** Viewpoint table from DEVELOPMENT_PLAN §3.1, plus the cinematic TITLE sweep behind the start screen. */
export const VIEWPOINTS = Object.freeze({
  TITLE: Object.freeze({
    position: [0.0, 9.0, 26.0],
    target: [0.0, 1.2, 0.0],
    fov: 40,
    orbit: Object.freeze({ radius: 26.0, height: 9.0, degPerSec: 2.5 }),
  }),
  // The seated player's own eyes (head centre of LAYOUT.SEAT_NEAR): low enough that the opponent's
  // head and shoulders sit in the top of the frame, wide enough that the near board edge stays clickable.
  MAIN_PLAY: Object.freeze({ position: [0.0, 13.0, 16.2], target: [0.0, 5.0, -4.0], fov: 56 }),
  CLOCK_FOCUS: Object.freeze({ position: [10.2, 7.8, 6.5], target: [8.5, 2.0, 1.0], fov: 35 }),
  MANUAL_STUDY: Object.freeze({ position: [-7.8, 10.5, 3.2], target: [-6.5, 0.5, -2.0], fov: 32 }),
  LEDGER_REVIEW: Object.freeze({ position: [7.5, 9.2, 8.5], target: [6.0, 0.5, 4.5], fov: 34 }),
  // Plan §3.1 lists [0, 22, 4.5]; lowered to 20 so the eye stays under the room's ceiling beams.
  VICTORY_DRAMA: Object.freeze({
    position: [0.0, 20.0, 4.5],
    target: [0.0, 0.0, 0.0],
    fov: 38,
    orbit: Object.freeze({ radius: 4.5, height: 20.0, degPerSec: 8 }),
  }),
});

export const DEFAULT_VIEWPOINT = 'MAIN_PLAY';
export const DEFAULT_DURATION_MS = 700;
export const RETURN_DURATION_MS = 500;
export const MIN_DURATION_MS = 250;
export const MAX_DURATION_MS = 1500;

/** Tolerance (seconds) so float accumulation of dt cannot leave a flight 1 ulp short. */
const ARRIVAL_EPSILON_S = 1e-6;
const POSE_EPSILON = 1e-9;

/** @param {CameraPose} pose */
function clonePose(pose) {
  return {
    position: [pose.position[0], pose.position[1], pose.position[2]],
    target: [pose.target[0], pose.target[1], pose.target[2]],
    fov: pose.fov,
  };
}

/** @param {CameraPose} a @param {CameraPose} b */
function posesEqual(a, b) {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.position[i] - b.position[i]) > POSE_EPSILON) return false;
    if (Math.abs(a.target[i] - b.target[i]) > POSE_EPSILON) return false;
  }
  return Math.abs(a.fov - b.fov) <= POSE_EPSILON;
}

/**
 * @typedef {object} Transition
 * @property {string} name
 * @property {CameraPose} from
 * @property {CameraPose} to
 * @property {number} elapsed    seconds
 * @property {number} duration   seconds
 * @property {(t: number) => number} ease
 * @property {(arrived: boolean) => void} resolve
 */

/**
 * @typedef {object} OrbitState
 * @property {number[]} center
 * @property {number} radius
 * @property {number} height
 * @property {number} degPerSec
 * @property {number} angle   radians
 */

export class CameraDirector {
  /**
   * @param {import('three').PerspectiveCamera} camera
   * @param {{ viewpoints?: Record<string, Viewpoint> }} [options]
   */
  constructor(camera, { viewpoints = VIEWPOINTS, orbitLimits = USER_ORBIT_LIMITS } = {}) {
    this.camera = camera;
    this.viewpoints = viewpoints;
    this.orbitLimits = orbitLimits;

    /** @type {string} */
    this._current = DEFAULT_VIEWPOINT;
    /** Directed base pose (viewpoint / flight / auto-orbit), before the user offset. @type {CameraPose} */
    this._pose = this._resolvePose(DEFAULT_VIEWPOINT, null);
    /** What the camera actually shows: base pose + smoothed user offset. @type {CameraPose} */
    this._view = clonePose(this._pose);
    /** @type {Transition | null} */
    this._transition = null;
    /** @type {OrbitState | null} */
    this._orbit = null;

    /** @type {UserOrbit} */
    this._user = { yaw: 0, pitch: 0, zoom: 1 };
    /** @type {UserOrbit} */
    this._userGoal = { yaw: 0, pitch: 0, zoom: 1 };

    this.snapTo(DEFAULT_VIEWPOINT);
  }

  /** Name of the destination viewpoint (already set while still in flight). */
  get current() {
    return this._current;
  }

  get isTransitioning() {
    return this._transition !== null;
  }

  /** Visible pose (base + user offset), possibly mid-transition. Returns a fresh copy. */
  getPose() {
    return clonePose(this._view);
  }

  /** Directed pose without the user offset. Returns a fresh copy. */
  getBasePose() {
    return clonePose(this._pose);
  }

  /** Smoothed user orbit offset currently applied (radians / scale factor). */
  get userOrbit() {
    return { ...this._user };
  }

  /** True while the eye is displaced from the directed pose by user input. */
  get hasUserOrbit() {
    const g = this._userGoal;
    const u = this._user;
    return g.yaw !== 0 || g.pitch !== 0 || g.zoom !== 1 || u.yaw !== 0 || u.pitch !== 0 || u.zoom !== 1;
  }

  /**
   * Drag input: swing the eye around the current look-at target.
   * @param {number} dYaw    radians around the up axis (positive = eye moves toward +X when viewed from +Z)
   * @param {number} dPitch  radians of elevation change (positive = higher)
   */
  orbitBy(dYaw, dPitch) {
    const goal = this._userGoal;
    goal.yaw += dYaw;
    const baseElevation = elevationOf(this._pose);
    const { minElevationDeg, maxElevationDeg } = this.orbitLimits;
    goal.pitch = clamp(
      goal.pitch + dPitch,
      minElevationDeg * DEG2RAD - baseElevation,
      maxElevationDeg * DEG2RAD - baseElevation,
    );
  }

  /**
   * Wheel / pinch input: scale the eye distance (< 1 moves closer).
   * @param {number} factor
   */
  zoomBy(factor) {
    if (!(factor > 0)) return;
    const { minZoom, maxZoom } = this.orbitLimits;
    this._userGoal.zoom = clamp(this._userGoal.zoom * factor, minZoom, maxZoom);
  }

  /**
   * Return to the directed pose. Smooth by default (damped over a few frames);
   * `immediate` snaps.
   * @param {{ immediate?: boolean }} [options]
   */
  resetUserOrbit({ immediate = false } = {}) {
    this._userGoal = { yaw: 0, pitch: 0, zoom: 1 };
    if (immediate) this._user = { yaw: 0, pitch: 0, zoom: 1 };
  }

  /**
   * Jump to a viewpoint without animation. Any flight in progress is
   * superseded (its promise resolves `false`).
   * @param {string} name
   * @param {{ target?: number[] | null }} [options]
   */
  snapTo(name, { target = null } = {}) {
    const to = this._resolvePose(name, target);
    this._cancelTransition();
    this._current = name;
    this._pose = to;
    this._orbit = this._makeOrbit(name, to);
    this.resetUserOrbit({ immediate: true });
    this._applyPose();
  }

  /**
   * Fly to a viewpoint. The flight starts from the live pose, so re-targeting
   * mid-flight is seamless (position is continuous, only velocity restarts).
   *
   * @param {string} name
   * @param {{ duration?: number, target?: number[] | null, ease?: (t: number) => number }} [options]
   *   `target` overrides the viewpoint's look-at point. For orbit viewpoints the
   *   eye is re-derived as target + [0, height, radius]; for fixed viewpoints the
   *   eye stays put and only the gaze changes.
   * @returns {Promise<boolean>} `true` on arrival, `false` if superseded by a
   *   later `goTo` / `snapTo`.
   */
  goTo(name, { duration = DEFAULT_DURATION_MS, target = null, ease = cubicEaseInOut } = {}) {
    const to = this._resolvePose(name, target);
    // Depart from what the viewer actually sees; the user offset is folded into
    // `from` and cleared so it is not applied twice during the flight.
    const from = this.getPose();
    this.resetUserOrbit({ immediate: true });

    this._cancelTransition();
    this._current = name;

    if (posesEqual(from, to)) {
      this._pose = to;
      this._orbit = this._makeOrbit(name, to);
      this._applyPose();
      return Promise.resolve(true);
    }

    // Orbiting stops while in flight and resumes from angle 0 on arrival.
    this._orbit = null;
    const seconds = clamp(duration, MIN_DURATION_MS, MAX_DURATION_MS) / 1000;

    return new Promise((resolve) => {
      this._transition = { name, from, to, elapsed: 0, duration: seconds, ease, resolve };
    });
  }

  /**
   * Escape hatch from any close-up back to the play view (plan §3.2: 500 ms).
   * @param {{ duration?: number }} [options]
   * @returns {Promise<boolean>}
   */
  returnToMain({ duration = RETURN_DURATION_MS } = {}) {
    return this.goTo(DEFAULT_VIEWPOINT, { duration });
  }

  /**
   * Advance the flight / orbit and write the pose to the camera.
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    const tr = this._transition;
    if (tr) {
      tr.elapsed += dt;
      if (tr.elapsed + ARRIVAL_EPSILON_S >= tr.duration) {
        this._pose = clonePose(tr.to);
        this._transition = null;
        this._orbit = this._makeOrbit(tr.name, tr.to);
        tr.resolve(true);
      } else {
        this._pose = interpolatePose(tr.from, tr.to, tr.elapsed / tr.duration, tr.ease);
      }
    } else if (this._orbit) {
      this._advanceOrbit(dt);
    }
    this._smoothUserOrbit(dt);
    this._applyPose();
  }

  /** Cancel any flight and hold the current pose (promise resolves `false`). */
  stop() {
    this._cancelTransition();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * @param {string} name
   * @param {number[] | null} targetOverride
   * @returns {CameraPose}
   */
  _resolvePose(name, targetOverride) {
    const vp = this.viewpoints[name];
    if (!vp) throw new Error(`CameraDirector: unknown viewpoint "${name}"`);

    const target = targetOverride
      ? [targetOverride[0], targetOverride[1], targetOverride[2]]
      : [vp.target[0], vp.target[1], vp.target[2]];

    let position;
    if (vp.orbit) {
      position = addVec3(target, [0, vp.orbit.height, vp.orbit.radius]);
    } else {
      position = [vp.position[0], vp.position[1], vp.position[2]];
    }
    return { position, target, fov: vp.fov };
  }

  /**
   * @param {string} name
   * @param {CameraPose} pose
   * @returns {OrbitState | null}
   */
  _makeOrbit(name, pose) {
    const orbit = this.viewpoints[name]?.orbit;
    if (!orbit) return null;
    const offset = subVec3(pose.position, pose.target);
    return {
      center: [pose.target[0], pose.target[1], pose.target[2]],
      radius: orbit.radius,
      height: orbit.height,
      degPerSec: orbit.degPerSec,
      angle: Math.atan2(offset[0], offset[2]),
    };
  }

  /** @param {number} dt */
  _advanceOrbit(dt) {
    const o = /** @type {OrbitState} */ (this._orbit);
    o.angle += o.degPerSec * DEG2RAD * dt;
    if (o.angle > Math.PI * 2) o.angle -= Math.PI * 2;
    const c = o.center;
    this._pose.position = [
      c[0] + Math.sin(o.angle) * o.radius,
      c[1] + o.height,
      c[2] + Math.cos(o.angle) * o.radius,
    ];
  }

  _cancelTransition() {
    const tr = this._transition;
    if (!tr) return;
    this._transition = null;
    tr.resolve(false);
  }

  /** Ease the applied user offset toward the input goal; snap when negligible. */
  _smoothUserOrbit(dt) {
    const u = this._user;
    const g = this._userGoal;
    const k = this.orbitLimits.damping;
    u.yaw = damp(u.yaw, g.yaw, k, dt);
    u.pitch = damp(u.pitch, g.pitch, k, dt);
    u.zoom = damp(u.zoom, g.zoom, k, dt);
    if (Math.abs(u.yaw - g.yaw) < 1e-5) u.yaw = g.yaw;
    if (Math.abs(u.pitch - g.pitch) < 1e-5) u.pitch = g.pitch;
    if (Math.abs(u.zoom - g.zoom) < 1e-5) u.zoom = g.zoom;
  }

  /** Compose base pose + user offset into `_view` and push it into the camera. */
  _applyPose() {
    const base = this._pose;
    const u = this._user;
    const position = u.yaw === 0 && u.pitch === 0 && u.zoom === 1
      ? [base.position[0], base.position[1], base.position[2]]
      : orbitedEye(base, u, this.orbitLimits);
    this._view = { position, target: [base.target[0], base.target[1], base.target[2]], fov: base.fov };

    const cam = this.camera;
    cam.position.set(position[0], position[1], position[2]);
    cam.lookAt(this._view.target[0], this._view.target[1], this._view.target[2]);
    if (cam.fov !== base.fov) {
      cam.fov = base.fov;
      cam.updateProjectionMatrix();
    }
  }
}

/**
 * @typedef {object} UserOrbit
 * @property {number} yaw    radians around +Y
 * @property {number} pitch  radians of elevation change
 * @property {number} zoom   eye-distance scale (1 = directed distance)
 */

/** Elevation (radians above the target plane) of a pose's eye. */
function elevationOf(pose) {
  const off = subVec3(pose.position, pose.target);
  const r = lengthVec3(off);
  return r < 1e-9 ? 0 : Math.asin(clamp(off[1] / r, -1, 1));
}

/**
 * Eye position after swinging the base offset by the user orbit, keeping the
 * look-at target fixed and the elevation inside the configured band.
 * @param {CameraPose} base
 * @param {UserOrbit} u
 * @param {typeof USER_ORBIT_LIMITS} limits
 * @returns {number[]}
 */
function orbitedEye(base, u, limits) {
  const off = subVec3(base.position, base.target);
  const r = lengthVec3(off);
  if (r < 1e-9) return [base.position[0], base.position[1], base.position[2]];
  const elevation = clamp(
    Math.asin(clamp(off[1] / r, -1, 1)) + u.pitch,
    limits.minElevationDeg * DEG2RAD,
    limits.maxElevationDeg * DEG2RAD,
  );
  const azimuth = Math.atan2(off[0], off[2]) + u.yaw;
  const dir = [Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation)];
  let radius = r * u.zoom;
  if (limits.bounds) radius = clampRadiusToBounds(base.target, dir, radius, limits.bounds);
  return addVec3(base.target, [dir[0] * radius, dir[1] * radius, dir[2] * radius]);
}

/**
 * Largest distance along `dir` from `target` that keeps the eye inside the box
 * (minus `margin`), never below one unit so the camera cannot collapse onto the subject.
 * @param {number[]} target
 * @param {number[]} dir unit vector
 * @param {number} radius requested distance
 * @param {{ min: number[], max: number[], margin?: number }} bounds
 */
function clampRadiusToBounds(target, dir, radius, bounds) {
  const margin = bounds.margin ?? 0.5;
  let tMax = radius;
  for (let axis = 0; axis < 3; axis++) {
    const d = dir[axis];
    if (Math.abs(d) < 1e-9) continue;
    const limit = d > 0 ? bounds.max[axis] - margin : bounds.min[axis] + margin;
    const t = (limit - target[axis]) / d;
    if (t > 0 && t < tMax) tMax = t;
  }
  return Math.max(1, tMax);
}

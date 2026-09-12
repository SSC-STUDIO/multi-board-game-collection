/**
 * Pure interpolation & easing helpers shared by the camera director, entity
 * animations and the Node test-suite.
 *
 * Constraint: NO Three.js and NO DOM imports in this file. Vectors are plain
 * `[x, y, z]` arrays so everything here can run in `vitest` under Node.
 */

export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function inverseLerp(a, b, v) {
  return a === b ? 0 : (v - a) / (b - a);
}

export function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Easing curves (all take t in [0, 1] and return a value in [0, 1])
// ---------------------------------------------------------------------------

export function linear(t) {
  return clamp01(t);
}

export function cubicEaseIn(t) {
  t = clamp01(t);
  return t * t * t;
}

export function cubicEaseOut(t) {
  t = clamp01(t);
  return 1 - Math.pow(1 - t, 3);
}

/**
 * The canonical camera curve from the development plan:
 *   t' = t < 0.5 ? 4t^3 : 1 - ((-2t + 2)^3) / 2
 */
export function cubicEaseInOut(t) {
  t = clamp01(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function quadEaseIn(t) {
  t = clamp01(t);
  return t * t;
}

export function quadEaseOut(t) {
  t = clamp01(t);
  return 1 - (1 - t) * (1 - t);
}

export function quartEaseOut(t) {
  t = clamp01(t);
  return 1 - Math.pow(1 - t, 4);
}

export function sineEaseInOut(t) {
  t = clamp01(t);
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export function backEaseOut(t, overshoot = 1.70158) {
  t = clamp01(t);
  const c3 = overshoot + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + overshoot * Math.pow(t - 1, 2);
}

export function bounceEaseOut(t) {
  t = clamp01(t);
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

export function elasticEaseOut(t) {
  t = clamp01(t);
  if (t === 0 || t === 1) return t;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the approach speed (≈ 1/seconds to cover 63% of the distance).
 */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Cubic Hermite spline for scalars (p = positions, m = tangents). */
export function hermite(p0, p1, m0, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * p0 +
    (t3 - 2 * t2 + t) * m0 +
    (-2 * t3 + 3 * t2) * p1 +
    (t3 - t2) * m1
  );
}

// ---------------------------------------------------------------------------
// Plain-array vector helpers
// ---------------------------------------------------------------------------

export function vec3(x = 0, y = 0, z = 0) {
  return [x, y, z];
}

export function addVec3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subVec3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVec3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dotVec3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVec3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function lengthVec3(a) {
  return Math.sqrt(dotVec3(a, a));
}

export function distanceVec3(a, b) {
  return lengthVec3(subVec3(a, b));
}

export function normalizeVec3(a) {
  const l = lengthVec3(a);
  return l > 1e-12 ? scaleVec3(a, 1 / l) : [0, 0, 0];
}

export function lerpVec3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function hermiteVec3(p0, p1, m0, m1, t) {
  return [
    hermite(p0[0], p1[0], m0[0], m1[0], t),
    hermite(p0[1], p1[1], m0[1], m1[1], t),
    hermite(p0[2], p1[2], m0[2], m1[2], t),
  ];
}

export function quadraticBezierVec3(p0, p1, p2, t) {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  return [
    a * p0[0] + b * p1[0] + c * p2[0],
    a * p0[1] + b * p1[1] + c * p2[1],
    a * p0[2] + b * p1[2] + c * p2[2],
  ];
}

/**
 * Spherical interpolation between two vectors: the direction travels along the
 * great circle while the magnitude is lerped. (Anti)parallel inputs fall back
 * to a normalised lerp so there is never a NaN singularity.
 */
export function slerpVec3(a, b, t) {
  const la = lengthVec3(a);
  const lb = lengthVec3(b);
  if (la < 1e-9 || lb < 1e-9) return lerpVec3(a, b, t);

  const na = scaleVec3(a, 1 / la);
  const nb = scaleVec3(b, 1 / lb);
  const cos = clamp(dotVec3(na, nb), -1, 1);
  const len = lerp(la, lb, t);

  if (cos > 0.9995 || cos < -0.9995) {
    const dir = normalizeVec3(lerpVec3(na, nb, t));
    if (lengthVec3(dir) < 1e-9) return lerpVec3(a, b, t);
    return scaleVec3(dir, len);
  }

  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return scaleVec3(addVec3(scaleVec3(na, wa), scaleVec3(nb, wb)), len);
}

/**
 * @typedef {{ position: number[], target: number[], fov: number }} CameraPose
 */

/**
 * "Hermite-Slerp" camera pose interpolation from the plan: the look-at target
 * glides linearly while the eye offset (position − target) is slerped so the
 * camera sweeps around the subject on a smooth arc instead of cutting through
 * the table. `t` is raw progress; `ease` shapes it (cubic in-out by default).
 *
 * @param {CameraPose} from
 * @param {CameraPose} to
 * @param {number} t
 * @param {(t: number) => number} [ease]
 * @returns {CameraPose}
 */
export function interpolatePose(from, to, t, ease = cubicEaseInOut) {
  const k = ease(clamp01(t));
  const target = lerpVec3(from.target, to.target, k);
  const offset = slerpVec3(
    subVec3(from.position, from.target),
    subVec3(to.position, to.target),
    k,
  );
  return {
    position: addVec3(target, offset),
    target,
    fov: lerp(from.fov, to.fov, k),
  };
}

/**
 * Semi-implicit spring integrator for snappy physical motion (lever presses,
 * lid pops, stamp hover). Mutates and returns `state`.
 */
export function springStep(state, target, { stiffness = 120, damping = 14, dt = 1 / 60 } = {}) {
  const accel = (target - state.position) * stiffness - state.velocity * damping;
  state.velocity += accel * dt;
  state.position += state.velocity * dt;
  return state;
}

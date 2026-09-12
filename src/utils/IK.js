/**
 * Two-bone analytic inverse kinematics (shoulder → elbow → wrist).
 *
 * Constraint: NO Three.js and NO DOM imports in this file. Vectors are plain
 * `[x, y, z]` arrays so the solver can run in `vitest` under Node, exactly like
 * Easing.js.
 */

/** Below this distance two points are treated as coincident. */
const EPSILON = 1e-9;
/** Squared length under which the pole's off-axis component is treated as degenerate. */
const POLE_EPSILON_SQ = 1e-12;

/**
 * Unit vector perpendicular to the unit vector `n`, chosen deterministically
 * (cross with the world axis `n` is least aligned with) so degenerate inputs
 * always yield the same, finite bend plane.
 * @param {number[]} n unit vector
 * @param {number[]} out
 */
function stablePerpendicular(n, out) {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  // Cross product of n with the axis it is least aligned with.
  if (ax <= ay && ax <= az) {
    out[0] = 0;
    out[1] = n[2];
    out[2] = -n[1];
  } else if (ay <= az) {
    out[0] = -n[2];
    out[1] = 0;
    out[2] = n[0];
  } else {
    out[0] = n[1];
    out[1] = -n[0];
    out[2] = 0;
  }
  const len = Math.hypot(out[0], out[1], out[2]);
  out[0] /= len;
  out[1] /= len;
  out[2] /= len;
  return out;
}

/**
 * Solve a two-bone chain so the wrist lands on `target` with the elbow bent
 * toward `pole`.
 *
 * Reach handling:
 *  - target farther than `upperLen + lowerLen`: the arm is fully extended
 *    toward the target and the wrist stops at maximum reach;
 *  - target closer than `|upperLen − lowerLen|`: the wrist is pushed out to the
 *    minimum reach (arm fully folded), still on the shoulder→target ray;
 *  - target on the shoulder itself: the arm folds along the direction of the
 *    pole (or straight down when the pole is on the shoulder too).
 * When the pole lies on the shoulder→target line the bend plane falls back to
 * a stable perpendicular so the result is always finite and deterministic.
 *
 * @param {number[]} shoulder  world position
 * @param {number[]} target    desired wrist position
 * @param {number} upperLen    shoulder→elbow
 * @param {number} lowerLen    elbow→wrist
 * @param {number[]} pole      a point the elbow should lean toward (defines the bend plane)
 * @param {{ elbow: number[], wrist: number[], reachable: boolean }} [out]  reused result object (avoids per-frame allocation)
 * @returns {{ elbow: number[], wrist: number[], reachable: boolean }}  wrist == clamped target when out of reach
 */
export function solveTwoBoneIK(shoulder, target, upperLen, lowerLen, pole, out = { elbow: [0, 0, 0], wrist: [0, 0, 0], reachable: false }) {
  const { elbow, wrist } = out;
  const dx = target[0] - shoulder[0];
  const dy = target[1] - shoulder[1];
  const dz = target[2] - shoulder[2];
  const dist = Math.hypot(dx, dy, dz);
  const maxReach = upperLen + lowerLen;
  const minReach = Math.abs(upperLen - lowerLen);
  out.reachable = dist >= minReach - EPSILON && dist <= maxReach + EPSILON;

  if (dist < EPSILON) {
    // Target on the shoulder: fold the arm toward the pole.
    let nx = pole[0] - shoulder[0];
    let ny = pole[1] - shoulder[1];
    let nz = pole[2] - shoulder[2];
    const len = Math.hypot(nx, ny, nz);
    if (len < EPSILON) {
      nx = 0;
      ny = -1;
      nz = 0;
    } else {
      nx /= len;
      ny /= len;
      nz /= len;
    }
    elbow[0] = shoulder[0] + nx * upperLen;
    elbow[1] = shoulder[1] + ny * upperLen;
    elbow[2] = shoulder[2] + nz * upperLen;
    const fold = upperLen - lowerLen;
    wrist[0] = shoulder[0] + nx * fold;
    wrist[1] = shoulder[1] + ny * fold;
    wrist[2] = shoulder[2] + nz * fold;
    return out;
  }

  // Unit aim direction and the reach-clamped wrist distance.
  const nx = dx / dist;
  const ny = dy / dist;
  const nz = dz / dist;
  const reach = dist > maxReach ? maxReach : dist < minReach ? minReach : dist;
  wrist[0] = shoulder[0] + nx * reach;
  wrist[1] = shoulder[1] + ny * reach;
  wrist[2] = shoulder[2] + nz * reach;

  // Law of cosines: distance of the elbow along the aim axis and its height off it.
  const along = (upperLen * upperLen - lowerLen * lowerLen + reach * reach) / (2 * reach);
  const heightSq = upperLen * upperLen - along * along;
  const height = heightSq > 0 ? Math.sqrt(heightSq) : 0;

  // Bend direction: the pole's component perpendicular to the aim axis.
  const px = pole[0] - shoulder[0];
  const py = pole[1] - shoulder[1];
  const pz = pole[2] - shoulder[2];
  const dot = px * nx + py * ny + pz * nz;
  let bx = px - nx * dot;
  let by = py - ny * dot;
  let bz = pz - nz * dot;
  const bLenSq = bx * bx + by * by + bz * bz;
  if (bLenSq < POLE_EPSILON_SQ) {
    // Pole on the aim axis (or on the shoulder): the bend plane is undefined, pick a stable one.
    const b = stablePerpendicular([nx, ny, nz], [0, 0, 0]);
    bx = b[0];
    by = b[1];
    bz = b[2];
  } else {
    const inv = 1 / Math.sqrt(bLenSq);
    bx *= inv;
    by *= inv;
    bz *= inv;
  }

  elbow[0] = shoulder[0] + nx * along + bx * height;
  elbow[1] = shoulder[1] + ny * along + by * height;
  elbow[2] = shoulder[2] + nz * along + bz * height;
  return out;
}

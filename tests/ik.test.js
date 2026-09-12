import { describe, expect, it } from 'vitest';
import { solveTwoBoneIK } from '../src/utils/IK.js';
import { crossVec3, distanceVec3, dotVec3, lengthVec3, normalizeVec3, subVec3 } from '../src/utils/Easing.js';

const UPPER = 8.2;
const LOWER = 7.6;
const SHOULDER = [-4.3, 8.5, -15.7];
const POLE = [-8.0, -1.0, -18.0]; // outward, down and back of the shoulder

function expectArrayClose(actual, expected, tolerance = 1e-9) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
  }
}

function expectFinite(v) {
  for (const x of v) expect(Number.isFinite(x)).toBe(true);
}

/** Bone lengths must survive every solve, reachable or not. */
function expectBoneLengths({ elbow, wrist }, shoulder = SHOULDER) {
  expect(distanceVec3(elbow, shoulder)).toBeCloseTo(UPPER, 9);
  expect(distanceVec3(wrist, elbow)).toBeCloseTo(LOWER, 9);
}

/** Signed distance of the elbow from the shoulder→wrist axis, measured toward the pole. */
function elbowPoleSide({ elbow, wrist }, shoulder, pole) {
  const axis = normalizeVec3(subVec3(wrist, shoulder));
  const toPole = subVec3(pole, shoulder);
  const polePerp = subVec3(toPole, axis.map((c) => c * dotVec3(toPole, axis)));
  const toElbow = subVec3(elbow, shoulder);
  const elbowPerp = subVec3(toElbow, axis.map((c) => c * dotVec3(toElbow, axis)));
  return dotVec3(elbowPerp, normalizeVec3(polePerp));
}

describe('solveTwoBoneIK – reachable targets', () => {
  const targets = [
    [-6.2, 0.6, -9.0], // tray at the opponent's right hand
    [-1.5, 2.0, -3.0], // above the far rows of the board
    [-1.0, 0.0, -14.5], // hand resting on the thigh
    [-3.8, 10.0, -12.0], // hand raised near the chin
    [3.5, 2.5, -11.0], // across the body
  ];

  it('places the wrist exactly on the target and preserves both bone lengths', () => {
    for (const target of targets) {
      const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
      expect(result.reachable).toBe(true);
      expectArrayClose(result.wrist, target);
      expectBoneLengths(result);
    }
  });

  it('bends the elbow toward the pole side of the shoulder→target line', () => {
    for (const target of targets) {
      const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
      expect(elbowPoleSide(result, SHOULDER, POLE)).toBeGreaterThan(0.5);
    }
  });

  it('mirrors the elbow when the pole flips to the other side', () => {
    const target = [-1.5, 2.0, -3.0];
    const a = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
    const mirroredPole = subVec3(SHOULDER, subVec3(POLE, SHOULDER));
    const b = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, mirroredPole);
    expect(elbowPoleSide(a, SHOULDER, POLE)).toBeGreaterThan(0);
    expect(elbowPoleSide(b, SHOULDER, mirroredPole)).toBeGreaterThan(0);
    // Both elbows are the same distance off the axis but on opposite sides: they reflect through it.
    const axis = normalizeVec3(subVec3(target, SHOULDER));
    const mid = subVec3(a.elbow, SHOULDER).map((c, i) => (c + b.elbow[i] - SHOULDER[i]) / 2);
    expectArrayClose(normalizeVec3(mid), axis, 1e-9);
  });

  it('lies flat (elbow on the axis) when the target is exactly at full reach', () => {
    const dir = normalizeVec3([1, -1, 2]);
    const target = SHOULDER.map((c, i) => c + dir[i] * (UPPER + LOWER));
    const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
    expect(result.reachable).toBe(true);
    expectArrayClose(result.wrist, target, 1e-9);
    expectArrayClose(result.elbow, SHOULDER.map((c, i) => c + dir[i] * UPPER), 1e-7);
    expectBoneLengths(result);
  });

  it('works with the optional reusable output object and unequal bone lengths', () => {
    const out = { elbow: [0, 0, 0], wrist: [0, 0, 0], reachable: false };
    const target = [2, 3, 4];
    const returned = solveTwoBoneIK([0, 0, 0], target, 3, 5, [0, 10, 0], out);
    expect(returned).toBe(out);
    expect(out.reachable).toBe(true);
    expectArrayClose(out.wrist, target);
    expect(lengthVec3(out.elbow)).toBeCloseTo(3, 9);
    expect(distanceVec3(out.wrist, out.elbow)).toBeCloseTo(5, 9);
  });
});

describe('solveTwoBoneIK – out of reach', () => {
  it('points a straight arm at a target beyond maximum reach', () => {
    const target = [12.0, 0.6, 6.0]; // far corner of the board, ~29 units away
    const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
    expect(result.reachable).toBe(false);
    expectBoneLengths(result);

    const dir = normalizeVec3(subVec3(target, SHOULDER));
    expectArrayClose(result.wrist, SHOULDER.map((c, i) => c + dir[i] * (UPPER + LOWER)), 1e-9);
    expectArrayClose(result.elbow, SHOULDER.map((c, i) => c + dir[i] * UPPER), 1e-7);
    // Straight: shoulder→elbow and elbow→wrist are parallel.
    const a = normalizeVec3(subVec3(result.elbow, SHOULDER));
    const b = normalizeVec3(subVec3(result.wrist, result.elbow));
    expect(dotVec3(a, b)).toBeCloseTo(1, 9);
    expect(distanceVec3(result.wrist, SHOULDER)).toBeCloseTo(UPPER + LOWER, 9);
  });

  it('keeps the clamped wrist on the shoulder→target ray', () => {
    const target = [-30, 40, 10];
    const { wrist } = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
    const dir = normalizeVec3(subVec3(target, SHOULDER));
    const wristDir = normalizeVec3(subVec3(wrist, SHOULDER));
    expect(lengthVec3(crossVec3(dir, wristDir))).toBeLessThan(1e-9);
    expect(dotVec3(dir, wristDir)).toBeCloseTo(1, 9);
  });
});

describe('solveTwoBoneIK – too close', () => {
  it('pushes a target inside the minimum reach out to |upper − lower|, fully folded', () => {
    const dir = normalizeVec3([0.2, -1, 0.3]);
    const target = SHOULDER.map((c, i) => c + dir[i] * 0.1); // 0.1 away, min reach is 0.6
    const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
    expect(result.reachable).toBe(false);
    expectBoneLengths(result);
    expect(distanceVec3(result.wrist, SHOULDER)).toBeCloseTo(UPPER - LOWER, 9);
    expectArrayClose(result.wrist, SHOULDER.map((c, i) => c + dir[i] * (UPPER - LOWER)), 1e-9);
    // Folded flat: the forearm runs straight back along the upper arm.
    const a = normalizeVec3(subVec3(result.elbow, SHOULDER));
    const b = normalizeVec3(subVec3(result.wrist, result.elbow));
    expect(dotVec3(a, b)).toBeCloseTo(-1, 7);
  });

  it('reports a target exactly at minimum reach as reachable', () => {
    const dir = normalizeVec3([1, 0, 0]);
    const target = SHOULDER.map((c, i) => c + dir[i] * (UPPER - LOWER));
    const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, POLE);
    expect(result.reachable).toBe(true);
    expectArrayClose(result.wrist, target, 1e-9);
    expectBoneLengths(result);
  });

  it('folds toward the pole when the target sits on the shoulder', () => {
    const result = solveTwoBoneIK(SHOULDER, [...SHOULDER], UPPER, LOWER, POLE);
    expect(result.reachable).toBe(false);
    expectFinite(result.elbow);
    expectFinite(result.wrist);
    expectBoneLengths(result);
    const poleDir = normalizeVec3(subVec3(POLE, SHOULDER));
    expectArrayClose(normalizeVec3(subVec3(result.elbow, SHOULDER)), poleDir, 1e-9);
    expect(distanceVec3(result.wrist, SHOULDER)).toBeCloseTo(UPPER - LOWER, 9);
  });

  it('is finite with equal bones, target and pole all on the shoulder', () => {
    const result = solveTwoBoneIK([1, 2, 3], [1, 2, 3], 5, 5, [1, 2, 3]);
    expectFinite(result.elbow);
    expectFinite(result.wrist);
    expect(result.reachable).toBe(true);
    expectArrayClose(result.wrist, [1, 2, 3]);
    expect(distanceVec3(result.elbow, [1, 2, 3])).toBeCloseTo(5, 9);
  });
});

describe('solveTwoBoneIK – degenerate pole', () => {
  const target = [-4.3, -5.0, -15.7]; // straight below the shoulder, 13.5 away

  it('falls back to a stable perpendicular when the pole is on the shoulder→target line', () => {
    const collinear = [-4.3, -30.0, -15.7];
    const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, collinear);
    expectFinite(result.elbow);
    expect(result.reachable).toBe(true);
    expectArrayClose(result.wrist, target);
    expectBoneLengths(result);
    // The elbow must still be bent (off the axis) by the law-of-cosines height.
    const axis = normalizeVec3(subVec3(target, SHOULDER));
    const toElbow = subVec3(result.elbow, SHOULDER);
    const along = dotVec3(toElbow, axis);
    const height = Math.sqrt(UPPER * UPPER - along * along);
    expect(height).toBeGreaterThan(1);
    expect(Math.abs(toElbow[1] - along * axis[1])).toBeLessThan(1e-9); // perpendicular has no vertical part
  });

  it('gives the same answer for a pole behind the shoulder on the same line and for a pole on the shoulder', () => {
    const behind = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, [-4.3, 50.0, -15.7]);
    const onShoulder = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, [...SHOULDER]);
    const collinear = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, [-4.3, -30.0, -15.7]);
    expectArrayClose(behind.elbow, onShoulder.elbow, 1e-9);
    expectArrayClose(behind.elbow, collinear.elbow, 1e-9);
    expectBoneLengths(onShoulder);
  });

  it('never produces NaN for axis-aligned aims with a collinear pole', () => {
    const shoulder = [0, 0, 0];
    for (const axis of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const t = axis.map((c) => c * 10);
      const result = solveTwoBoneIK(shoulder, t, UPPER, LOWER, axis.map((c) => c * 3));
      expectFinite(result.elbow);
      expectFinite(result.wrist);
      expectArrayClose(result.wrist, t);
      expectBoneLengths(result, shoulder);
    }
  });

  it('uses the pole as soon as it leaves the axis, on the correct side', () => {
    const slightlyOff = [-4.3 + 0.01, -30.0, -15.7];
    const result = solveTwoBoneIK(SHOULDER, target, UPPER, LOWER, slightlyOff);
    expect(elbowPoleSide(result, SHOULDER, slightlyOff)).toBeGreaterThan(1);
    expect(result.elbow[0]).toBeGreaterThan(SHOULDER[0]);
  });
});

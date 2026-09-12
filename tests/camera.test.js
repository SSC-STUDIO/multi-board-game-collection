import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  cubicEaseInOut,
  interpolatePose,
  lengthVec3,
  slerpVec3,
} from '../src/utils/Easing.js';
import {
  CameraDirector,
  DEFAULT_DURATION_MS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  RETURN_DURATION_MS,
  USER_ORBIT_LIMITS,
  VIEWPOINTS,
} from '../src/spatial/camera/CameraDirector.js';
import { CameraShake } from '../src/spatial/camera/CameraShake.js';

const DT = 1 / 60;

function makeCamera() {
  return new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 200);
}

/** Step the director `n` frames, returning the largest per-frame displacement. */
function stepFrames(director, n, dt = DT) {
  const prev = director.camera.position.clone();
  let maxStep = 0;
  for (let i = 0; i < n; i++) {
    director.update(dt);
    maxStep = Math.max(maxStep, director.camera.position.distanceTo(prev));
    prev.copy(director.camera.position);
  }
  return maxStep;
}

function expectVec3Close(actual, expected, tolerance = 1e-6) {
  expect(Math.abs(actual.x - expected[0])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected[1])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.z - expected[2])).toBeLessThanOrEqual(tolerance);
}

function expectArrayClose(actual, expected, tolerance = 1e-9) {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
  }
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

describe('Easing.cubicEaseInOut', () => {
  it('hits the anchor points 0, 0.5 and 1 exactly', () => {
    expect(cubicEaseInOut(0)).toBe(0);
    expect(cubicEaseInOut(1)).toBe(1);
    expect(cubicEaseInOut(0.5)).toBeCloseTo(0.5, 12);
  });

  it('is monotonically increasing over 100 samples', () => {
    let prev = cubicEaseInOut(0);
    for (let i = 1; i <= 100; i++) {
      const v = cubicEaseInOut(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('is point-symmetric: f(t) + f(1 - t) = 1', () => {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      expect(cubicEaseInOut(t) + cubicEaseInOut(1 - t)).toBeCloseTo(1, 10);
    }
  });

  it('clamps out-of-range input', () => {
    expect(cubicEaseInOut(-3)).toBe(0);
    expect(cubicEaseInOut(7)).toBe(1);
  });
});

describe('Easing.slerpVec3', () => {
  const a = [0, 18.5, 14.2];
  const b = [1.7, 5.8, 5.5];

  it('returns the exact endpoints at t = 0 and t = 1', () => {
    expectArrayClose(slerpVec3(a, b, 0), a);
    expectArrayClose(slerpVec3(a, b, 1), b);
  });

  it('interpolates the magnitude linearly', () => {
    const mid = slerpVec3(a, b, 0.5);
    const expected = (lengthVec3(a) + lengthVec3(b)) / 2;
    expect(lengthVec3(mid)).toBeCloseTo(expected, 9);
  });

  it('never produces NaN for (anti)parallel inputs', () => {
    const anti = slerpVec3([0, 0, 5], [0, 0, -5], 0.5);
    const antiQuarter = slerpVec3([0, 0, 5], [0, 0, -5], 0.25);
    const para = slerpVec3([1, 2, 3], [2, 4, 6], 0.25);
    for (const v of [...anti, ...antiQuarter, ...para]) expect(Number.isFinite(v)).toBe(true);
    expectArrayClose(para, [1.25, 2.5, 3.75]);
  });

  it('falls back to lerp when one input is the zero vector', () => {
    expectArrayClose(slerpVec3([0, 0, 0], [2, 4, 6], 0.5), [1, 2, 3]);
  });
});

describe('Easing.interpolatePose', () => {
  const from = VIEWPOINTS.MAIN_PLAY;
  const to = VIEWPOINTS.CLOCK_FOCUS;

  it('returns the exact endpoints', () => {
    const p0 = interpolatePose(from, to, 0);
    expectArrayClose(p0.position, from.position);
    expectArrayClose(p0.target, from.target);
    expect(p0.fov).toBe(from.fov);

    const p1 = interpolatePose(from, to, 1);
    expectArrayClose(p1.position, to.position);
    expectArrayClose(p1.target, to.target);
    expect(p1.fov).toBe(to.fov);
  });

  it('averages the fov and the target at the midpoint', () => {
    const mid = interpolatePose(from, to, 0.5);
    expect(mid.fov).toBeCloseTo((from.fov + to.fov) / 2, 9);
    expectArrayClose(mid.target, from.target.map((v, i) => (v + to.target[i]) / 2));
  });

  it('honours a custom ease function', () => {
    const linear = (t) => t;
    const quarter = interpolatePose(from, to, 0.25, linear);
    expect(quarter.fov).toBeCloseTo(from.fov + (to.fov - from.fov) * 0.25, 9);
  });
});

// ---------------------------------------------------------------------------
// CameraDirector
// ---------------------------------------------------------------------------

describe('CameraDirector', () => {
  it('snaps to MAIN_PLAY on construction', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    expectVec3Close(camera.position, VIEWPOINTS.MAIN_PLAY.position, 0);
    expect(camera.fov).toBe(VIEWPOINTS.MAIN_PLAY.fov);
    expect(director.current).toBe('MAIN_PLAY');
    expect(director.isTransitioning).toBe(false);
    expect(director.getPose()).toEqual({
      position: [0, 13, 16.2],
      target: [0, 5, -4],
      fov: 56,
    });
  });

  it('exposes the documented duration constants', () => {
    expect(DEFAULT_DURATION_MS).toBe(700);
    expect(RETURN_DURATION_MS).toBe(500);
    expect(MIN_DURATION_MS).toBe(250);
    expect(MAX_DURATION_MS).toBe(1500);
  });

  it('flies to CLOCK_FOCUS in exactly 700 ms and resolves true', async () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);

    const promise = director.goTo('CLOCK_FOCUS', { duration: 700 });
    expect(director.isTransitioning).toBe(true);
    expect(director.current).toBe('CLOCK_FOCUS');

    stepFrames(director, 41);
    expect(director.isTransitioning).toBe(true);

    stepFrames(director, 1);
    expect(director.isTransitioning).toBe(false);
    expectVec3Close(camera.position, VIEWPOINTS.CLOCK_FOCUS.position, 1e-6);
    expect(Math.abs(camera.fov - VIEWPOINTS.CLOCK_FOCUS.fov)).toBeLessThanOrEqual(1e-6);
    await expect(promise).resolves.toBe(true);

    const pose = director.getPose();
    expectArrayClose(pose.target, VIEWPOINTS.CLOCK_FOCUS.target);
  });

  it('keeps the camera aimed at the target while in flight', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.goTo('MANUAL_STUDY');
    stepFrames(director, 20);

    const pose = director.getPose();
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const toTarget = new THREE.Vector3(...pose.target).sub(camera.position).normalize();
    expect(forward.dot(toTarget)).toBeCloseTo(1, 6);
  });

  it('supersedes a flight without a visual jump and resolves the old promise false', async () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);

    const first = director.goTo('CLOCK_FOCUS', { duration: 700 });
    stepFrames(director, 20);
    const midPose = director.getPose();

    const second = director.returnToMain();
    await expect(first).resolves.toBe(false);
    expect(director.current).toBe('MAIN_PLAY');
    expect(director.isTransitioning).toBe(true);

    // Retargeting starts from the live pose, so the first frame is continuous.
    expectArrayClose(director.getPose().position, midPose.position);

    const maxStep = stepFrames(director, 30);
    expect(maxStep).toBeLessThan(1.5);
    expect(director.isTransitioning).toBe(false);
    expectVec3Close(camera.position, VIEWPOINTS.MAIN_PLAY.position, 1e-6);
    await expect(second).resolves.toBe(true);
  });

  it('applies a target override', async () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    const override = [2.1, 0.6, -1.4];

    const promise = director.goTo('LEDGER_REVIEW', { duration: 300, target: override });
    stepFrames(director, 18);
    await expect(promise).resolves.toBe(true);

    const pose = director.getPose();
    expectArrayClose(pose.target, override);
    expectArrayClose(pose.position, VIEWPOINTS.LEDGER_REVIEW.position);
    expect(pose.fov).toBe(VIEWPOINTS.LEDGER_REVIEW.fov);
  });

  it('orbits VICTORY_DRAMA around the (overridden) target after arrival', async () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    const target = [1.4, 0.6, -0.7];
    const { radius, height } = VIEWPOINTS.VICTORY_DRAMA.orbit;
    const expectedDistance = Math.sqrt(radius * radius + height * height);

    const promise = director.goTo('VICTORY_DRAMA', { duration: 600, target });
    stepFrames(director, 36);
    await expect(promise).resolves.toBe(true);

    const arrival = camera.position.clone();
    expectVec3Close(arrival, [target[0], target[1] + height, target[2] + radius], 1e-6);

    const targetVec = new THREE.Vector3(...target);
    for (let i = 0; i < 120; i++) {
      director.update(DT);
      expect(camera.position.distanceTo(targetVec)).toBeCloseTo(expectedDistance, 9);
      expect(director.isTransitioning).toBe(false);
    }
    expect(camera.position.distanceTo(arrival)).toBeGreaterThan(0.5);
    expect(camera.position.y).toBeCloseTo(target[1] + height, 9);

    // 8°/s → two seconds of orbit is 16° of arc.
    const arrivalDir = arrival.clone().sub(targetVec).setY(0).normalize();
    const nowDir = camera.position.clone().sub(targetVec).setY(0).normalize();
    expect(THREE.MathUtils.radToDeg(arrivalDir.angleTo(nowDir))).toBeCloseTo(16, 3);
  });

  it('clamps the duration into [250, 1500] ms', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);

    director.goTo('CLOCK_FOCUS', { duration: 10 });
    stepFrames(director, 14); // 233 ms
    expect(director.isTransitioning).toBe(true);
    stepFrames(director, 1); // 250 ms
    expect(director.isTransitioning).toBe(false);

    director.goTo('MAIN_PLAY', { duration: 10_000 });
    stepFrames(director, 89); // 1483 ms
    expect(director.isTransitioning).toBe(true);
    stepFrames(director, 1); // 1500 ms
    expect(director.isTransitioning).toBe(false);
    expectVec3Close(camera.position, VIEWPOINTS.MAIN_PLAY.position, 1e-6);
  });

  it('resolves immediately when already resting at the requested viewpoint', async () => {
    const director = new CameraDirector(makeCamera());
    await expect(director.returnToMain()).resolves.toBe(true);
    expect(director.isTransitioning).toBe(false);
  });

  it('snapTo cancels a flight and lands instantly', async () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    const flight = director.goTo('MANUAL_STUDY');
    stepFrames(director, 5);

    director.snapTo('LEDGER_REVIEW');
    await expect(flight).resolves.toBe(false);
    expect(director.isTransitioning).toBe(false);
    expect(director.current).toBe('LEDGER_REVIEW');
    expectVec3Close(camera.position, VIEWPOINTS.LEDGER_REVIEW.position, 0);
    expect(camera.fov).toBe(VIEWPOINTS.LEDGER_REVIEW.fov);
  });

  it('rejects unknown viewpoint names', () => {
    const director = new CameraDirector(makeCamera());
    expect(() => director.goTo('NOPE')).toThrow(/unknown viewpoint/);
  });

  it('rewrites the pose every idle frame so external offsets do not accumulate', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    camera.position.x += 5;
    director.update(DT);
    expectVec3Close(camera.position, VIEWPOINTS.MAIN_PLAY.position, 0);
  });
});

// ---------------------------------------------------------------------------
// CameraDirector – user free-look on top of the directed pose
// ---------------------------------------------------------------------------

describe('CameraDirector user orbit', () => {
  const target = new THREE.Vector3(...VIEWPOINTS.MAIN_PLAY.target);
  const baseDistance = new THREE.Vector3(...VIEWPOINTS.MAIN_PLAY.position).distanceTo(target);

  function settle(director, frames = 240) {
    for (let i = 0; i < frames; i++) director.update(DT);
  }

  it('orbitBy swings the eye around the look-at target without changing the distance', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.orbitBy(Math.PI / 2, 0);
    settle(director);

    expect(camera.position.distanceTo(target)).toBeCloseTo(baseDistance, 6);
    // Eye swung a quarter turn round the target: the +Z offset now points along +X; height unchanged.
    const offsetZ = VIEWPOINTS.MAIN_PLAY.position[2] - target.z;
    expect(camera.position.x).toBeCloseTo(target.x + offsetZ, 4);
    expect(camera.position.y).toBeCloseTo(VIEWPOINTS.MAIN_PLAY.position[1], 6);
    expect(Math.abs(camera.position.z - target.z)).toBeLessThan(1e-3);
    expect(director.hasUserOrbit).toBe(true);
    expectArrayClose(director.getBasePose().position, VIEWPOINTS.MAIN_PLAY.position, 0);
  });

  it('clamps elevation so the camera never dives below the table or flips over the top', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.orbitBy(0, -Math.PI); // way below the horizon
    settle(director);
    const low = Math.asin((camera.position.y - target.y) / camera.position.distanceTo(target));
    expect(low).toBeCloseTo((8 * Math.PI) / 180, 5);

    director.orbitBy(0, Math.PI); // way over the top
    settle(director);
    const high = Math.asin((camera.position.y - target.y) / camera.position.distanceTo(target));
    expect(high).toBeCloseTo((85 * Math.PI) / 180, 5);
  });

  it('zoomBy scales the eye distance within limits', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.zoomBy(0.5);
    settle(director);
    expect(camera.position.distanceTo(target)).toBeCloseTo(baseDistance * 0.55, 6);

    director.zoomBy(100);
    settle(director);
    expect(camera.position.distanceTo(target)).toBeCloseTo(baseDistance * 2.0, 6);
  });

  it('input is smoothed rather than applied instantly', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.orbitBy(1, 0);
    director.update(DT);
    const first = director.userOrbit.yaw;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    settle(director);
    expect(director.userOrbit.yaw).toBeCloseTo(1, 6);
  });

  it('goTo departs from the orbited view and lands exactly on the viewpoint with the offset cleared', async () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.orbitBy(0.8, 0.2);
    director.zoomBy(0.8);
    settle(director);
    const departure = camera.position.clone();

    const flight = director.returnToMain({ duration: 500 });
    expect(director.hasUserOrbit).toBe(false);
    const maxStep = stepFrames(director, 30);
    expect(maxStep).toBeLessThan(1.5);
    expect(camera.position.distanceTo(departure)).toBeGreaterThan(0.1);
    await expect(flight).resolves.toBe(true);
    expectVec3Close(camera.position, VIEWPOINTS.MAIN_PLAY.position, 1e-6);
  });

  it('resetUserOrbit({ immediate }) snaps straight back to the directed pose', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.orbitBy(2, 0.3);
    settle(director);
    director.resetUserOrbit({ immediate: true });
    director.update(DT);
    expectVec3Close(camera.position, VIEWPOINTS.MAIN_PLAY.position, 1e-9);
    expect(director.hasUserOrbit).toBe(false);
  });

  it('keeps the eye inside the configured room bounds while zooming out and pitching up', () => {
    const camera = makeCamera();
    const bounds = { min: [-30, -5.5, -24], max: [30, 21.4, 30], margin: 1 };
    const director = new CameraDirector(camera, { orbitLimits: { ...USER_ORBIT_LIMITS, bounds } });
    director.zoomBy(2.0); // clamps to maxZoom 2 → 46 units away along the MAIN_PLAY offset
    director.orbitBy(0, Math.PI / 2); // pitch to the 85° ceiling of the elevation band
    settle(director);
    expect(camera.position.y).toBeLessThanOrEqual(bounds.max[1] - bounds.margin + 1e-6);
    expect(Math.abs(camera.position.x)).toBeLessThanOrEqual(bounds.max[0] - bounds.margin + 1e-6);
    expect(camera.position.z).toBeLessThanOrEqual(bounds.max[2] - bounds.margin + 1e-6);
    expect(camera.position.z).toBeGreaterThanOrEqual(bounds.min[2] + bounds.margin - 1e-6);
    // Still looking at the table: distance to the target stays above the 1-unit floor.
    expect(camera.position.distanceTo(target)).toBeGreaterThan(1);

    // Without bounds the same input would leave the room through the ceiling.
    const free = new CameraDirector(makeCamera());
    free.zoomBy(2.0);
    free.orbitBy(0, Math.PI / 2);
    settle(free);
    expect(free.camera.position.y).toBeGreaterThan(bounds.max[1]);
  });

  it('TITLE viewpoint orbits slowly around the table at constant distance', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    director.snapTo('TITLE');
    const centre = new THREE.Vector3(...VIEWPOINTS.TITLE.target);
    const d0 = camera.position.distanceTo(centre);
    const p0 = camera.position.clone();
    settle(director, 120);
    expect(camera.position.distanceTo(centre)).toBeCloseTo(d0, 6);
    expect(camera.position.distanceTo(p0)).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// CameraShake
// ---------------------------------------------------------------------------

describe('CameraShake', () => {
  it('is idle with a zero offset until triggered', () => {
    const shake = new CameraShake();
    expect(shake.active).toBe(false);
    shake.update(DT);
    expect(shake.offset.lengthSq()).toBe(0);
  });

  it('produces a non-zero offset after trigger and decays to exactly zero', () => {
    const shake = new CameraShake();
    shake.trigger({ amplitude: 0.25, decayMs: 200 });
    expect(shake.active).toBe(true);

    shake.update(DT);
    expect(shake.offset.length()).toBeGreaterThan(0);
    expect(shake.offset.length()).toBeLessThanOrEqual(0.25 * Math.sqrt(1 + 0.36 + 0.16));

    // 11 more frames → 200 ms total.
    for (let i = 0; i < 11; i++) shake.update(DT);
    expect(shake.active).toBe(false);
    expect(shake.offset.x).toBe(0);
    expect(shake.offset.y).toBe(0);
    expect(shake.offset.z).toBe(0);
  });

  it('applies the offset additively on top of the director pose', () => {
    const camera = makeCamera();
    const director = new CameraDirector(camera);
    const shake = new CameraShake();
    shake.trigger({ amplitude: 0.3, decayMs: 300 });

    for (let i = 0; i < 5; i++) {
      director.update(DT);
      shake.update(DT);
      shake.apply(camera);
      const base = new THREE.Vector3(...VIEWPOINTS.MAIN_PLAY.position);
      expect(camera.position.clone().sub(base).distanceTo(shake.offset)).toBeLessThan(1e-9);
    }
  });

  it('retrigger keeps the larger amplitude and restarts the decay', () => {
    const shake = new CameraShake();
    shake.trigger({ amplitude: 0.4, decayMs: 100 });
    for (let i = 0; i < 4; i++) shake.update(DT);
    shake.trigger({ amplitude: 0.1, decayMs: 100 });
    expect(shake.amplitude).toBe(0.4);

    for (let i = 0; i < 5; i++) shake.update(DT);
    expect(shake.active).toBe(true);
    shake.update(DT);
    expect(shake.active).toBe(false);
  });
});

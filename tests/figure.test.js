import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Figure } from '../src/spatial/entities/Figure.js';
import { LAYOUT } from '../src/spatial/Layout.js';

const DT = 1 / 60;
const DEG = Math.PI / 180;
const FAR_REST_RIGHT_WRIST = [-3.0, -0.4, -14.5];

/** Advance `n` frames, yielding to the event loop between them so tween promises can settle. */
async function runFrames(fig, clock, n) {
  for (let i = 0; i < n; i++) {
    clock.t += DT;
    fig.update(DT, clock.t);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Synchronous stepping for tests that do not await promises. */
function step(fig, clock, n) {
  for (let i = 0; i < n; i++) {
    clock.t += DT;
    fig.update(DT, clock.t);
  }
}

function meshes(fig) {
  const out = [];
  fig.group.traverse((o) => {
    if (o.isMesh) out.push(o);
  });
  return out;
}

function expectVec3Close(actual, expected, tolerance = 1e-6) {
  expect(Math.abs(actual.x - expected[0])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.y - expected[1])).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.z - expected[2])).toBeLessThanOrEqual(tolerance);
}

function wristWorld(fig, hand) {
  return fig.arms[hand].hand.getWorldPosition(new THREE.Vector3());
}

describe('Figure – construction', () => {
  it('builds for both seats without a DOM and within the draw-call budget', () => {
    for (const seat of [LAYOUT.SEAT_FAR, LAYOUT.SEAT_NEAR]) {
      const fig = new Figure({ seat });
      const all = meshes(fig);
      const drawn = all.filter((m) => m.visible);
      expect(drawn).toHaveLength(10);
      expect(all).toHaveLength(12); // 10 body parts (neck separate so it hides with the head) + one hidden stone per hand
      expect(fig.interactives).toHaveLength(0);
      expect(fig.head.isObject3D).toBe(true);
      for (const m of all) expect(m.castShadow).toBe(true);
      fig.dispose();
      expect(fig.group.parent).toBeNull();
    }
  });

  it('owns its materials (nothing shared between figures) and honours palette overrides', () => {
    const a = new Figure({ seat: LAYOUT.SEAT_FAR });
    const b = new Figure({ seat: LAYOUT.SEAT_NEAR, palette: { robe: 0x224422 } });
    expect(a.bodyMaterial).not.toBe(b.bodyMaterial);
    expect(a.faceMaterial).not.toBe(b.faceMaterial);
    expect(a.stoneMaterials[1]).not.toBe(b.stoneMaterials[1]);
    expect(b.palette.robe).toBe(0x224422);
    expect(b.palette.sash).toBe(a.palette.sash);
  });

  it('requires a seat', () => {
    expect(() => new Figure({})).toThrow(/seat/);
  });

  it('sits at the seat and places the head about 3.2 above the shoulders', () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR, name: 'opponent' });
    expect(fig.group.name).toBe('opponent');
    expectVec3Close(fig.group.position, LAYOUT.SEAT_FAR.position, 0);
    const head = fig.getHeadWorldPosition();
    const seat = LAYOUT.SEAT_FAR;
    // Within the breathing lift (the head rides on the shoulders).
    expect(Math.abs(head.y - (seat.position[1] + seat.shoulderY + 3.2))).toBeLessThan(0.1);
    expect(head.z).toBeCloseTo(-16.5 + 0.9, 5);
    expect(Math.abs(head.x)).toBeLessThan(1e-9);

    const near = new Figure({ seat: LAYOUT.SEAT_NEAR });
    const nearHead = near.getHeadWorldPosition();
    expect(nearHead.z).toBeCloseTo(16.5 - 0.9, 5);
  });
});

describe('Figure – rest pose', () => {
  it('rests the wrists on the thighs just beyond the table edge, mirrored per seat', () => {
    const far = new Figure({ seat: LAYOUT.SEAT_FAR });
    expectVec3Close(wristWorld(far, 'right'), FAR_REST_RIGHT_WRIST, 1e-6);
    expectVec3Close(wristWorld(far, 'left'), [3.0, -0.4, -14.5], 1e-6);
    // Fingertips point at the table but stop short of its edge (z = -12).
    const pinch = far.getHandWorldPosition('right');
    expect(pinch.z).toBeGreaterThan(-14.5);
    expect(pinch.z).toBeLessThan(-12.3);
    expect(pinch.y).toBeLessThan(0.2);

    const near = new Figure({ seat: LAYOUT.SEAT_NEAR });
    // The near player faces -Z, so their right hand is at +X.
    expectVec3Close(wristWorld(near, 'right'), [3.0, -0.4, 14.5], 1e-6);
    expectVec3Close(wristWorld(near, 'left'), [-3.0, -0.4, 14.5], 1e-6);
  });

  it('keeps bone lengths, finite transforms and elbows out/down/back while idling', () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    step(fig, clock, 90);
    for (const arm of [fig.arms.left, fig.arms.right]) {
      expect(arm.upper.position.distanceTo(arm.fore.position)).toBeCloseTo(8.2, 6);
      expect(arm.fore.position.distanceTo(arm.hand.position)).toBeCloseTo(7.6, 6);
      // Elbow (forearm origin) sits outward of the shoulder and below it.
      expect(Math.abs(arm.fore.position.x)).toBeGreaterThan(Math.abs(arm.upper.position.x));
      expect(arm.fore.position.y).toBeLessThan(arm.upper.position.y);
    }
    fig.group.traverse((o) => {
      for (const c of ['x', 'y', 'z']) {
        expect(Number.isFinite(o.position[c])).toBe(true);
        expect(Number.isFinite(o.quaternion[c])).toBe(true);
        expect(Number.isFinite(o.scale[c])).toBe(true);
      }
    });
    // Breathing is subtle.
    expect(Math.abs(fig.body.scale.y - 1)).toBeLessThan(0.01);
    expect(Math.abs(fig.body.scale.z - 1)).toBeLessThan(0.02);
  });
});

describe('Figure – playStone', () => {
  const from = new THREE.Vector3(...LAYOUT.TRAY.position).setY(0.6);
  const to = new THREE.Vector3(-0.7, 0.6, -2.1);

  it('shows the stone in hand, fires onRelease once above the target and returns to rest', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    let releases = 0;
    let releasePinch = null;
    let sawStone = false;
    let done = false;
    fig.playStone({
      hand: 'right', from, to, player: 2,
      onRelease: () => {
        releases++;
        releasePinch = fig.getHandWorldPosition('right');
        expect(fig.arms.right.stone.visible).toBe(false);
      },
    }).then(() => {
      done = true;
    });

    for (let i = 0; i < 240 && !done; i++) {
      await runFrames(fig, clock, 1);
      if (fig.arms.right.stone.visible) {
        sawStone = true;
        expect(fig.arms.right.stone.material).toBe(fig.stoneMaterials[2]);
        expect(fig.arms.right.mode).toBe('gesture');
      }
    }
    expect(done).toBe(true);
    expect(releases).toBe(1);
    expect(sawStone).toBe(true);
    expect(fig.arms.right.stone.visible).toBe(false);
    expect(releasePinch.distanceTo(to.clone().setY(to.y + 1.2))).toBeLessThan(0.75);
    // ~1.5 s of gesture at speed 1.
    expect(clock.t).toBeGreaterThan(1.3);
    expect(clock.t).toBeLessThan(2.2);

    await runFrames(fig, clock, 40);
    expect(fig.arms.right.mode).toBe('rest');
    expectVec3Close(wristWorld(fig, 'right'), FAR_REST_RIGHT_WRIST, 0.05);
    expect(fig.tweens.busy).toBe(false);
  });

  it('honours liftHeight and speed', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    let releasePinch = null;
    let done = false;
    fig.playStone({
      hand: 'right', from, to, liftHeight: 2.0, speed: 2,
      onRelease: () => {
        releasePinch = fig.getHandWorldPosition('right');
      },
    }).then(() => {
      done = true;
    });
    for (let i = 0; i < 240 && !done; i++) await runFrames(fig, clock, 1);
    expect(done).toBe(true);
    expect(releasePinch.distanceTo(to.clone().setY(to.y + 2.0))).toBeLessThan(0.9);
    expect(clock.t).toBeLessThan(1.1);
  });

  it('cancels a running gesture when a new one starts on the same arm (old onRelease never fires)', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    let firstReleases = 0;
    let secondReleases = 0;
    let firstDone = false;
    let secondDone = false;
    fig.playStone({ hand: 'right', from, to, onRelease: () => firstReleases++ }).then(() => {
      firstDone = true;
    });
    await runFrames(fig, clock, 36); // mid-way through the reach/close
    fig.playStone({ hand: 'right', from, to, onRelease: () => secondReleases++ }).then(() => {
      secondDone = true;
    });
    await runFrames(fig, clock, 3);
    expect(firstDone).toBe(true);
    for (let i = 0; i < 240 && !secondDone; i++) await runFrames(fig, clock, 1);
    expect(secondDone).toBe(true);
    expect(firstReleases).toBe(0);
    expect(secondReleases).toBe(1);
    expect(fig.arms.right.stone.visible).toBe(false);
  });

  it('cancelGestures hides the stone, skips onRelease and lets the hand glide back to rest', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    let releases = 0;
    let done = false;
    fig.playStone({ hand: 'left', from: [8.2, 0.6, 1.6], to, onRelease: () => releases++ }).then(() => {
      done = true;
    });
    await runFrames(fig, clock, 40);
    expect(fig.arms.left.stone.visible).toBe(true);
    fig.cancelGestures();
    expect(fig.arms.left.stone.visible).toBe(false);
    expect(fig.arms.left.gesture).toBeNull();
    await runFrames(fig, clock, 3);
    expect(done).toBe(true);
    await runFrames(fig, clock, 90);
    expect(releases).toBe(0);
    expect(fig.arms.left.mode).toBe('rest');
    expectVec3Close(wristWorld(fig, 'left'), [3.0, -0.4, -14.5], 0.05);
  });

  it('accepts plain arrays and both hands at once', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_NEAR });
    const clock = { t: 0 };
    let releases = 0;
    const done = Promise.all([
      fig.playStone({ hand: 'right', from: LAYOUT.BOWL_WHITE.position, to: [0, 0.6, 0], player: 2, onRelease: () => releases++ }),
      fig.playStone({ hand: 'left', from: LAYOUT.BOWL_BLACK.position, to: [0.7, 0.6, 0.7], player: 1, onRelease: () => releases++ }),
    ]);
    let settled = false;
    done.then(() => {
      settled = true;
    });
    for (let i = 0; i < 240 && !settled; i++) await runFrames(fig, clock, 1);
    expect(settled).toBe(true);
    expect(releases).toBe(2);
  });
});

describe('Figure – holdAt / setThinking / lookAt', () => {
  it('holdAt puts the pinch point on the grip every frame and a null grip releases', () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_NEAR });
    const clock = { t: 0 };
    const grip = new THREE.Vector3(7.3, 0.3, 6.0);
    const dir = new THREE.Vector3(0.35, 0.8, 0.5).normalize();
    for (let i = 0; i < 90; i++) {
      fig.holdAt('right', grip, dir);
      step(fig, clock, 1);
    }
    expect(fig.arms.right.mode).toBe('hold');
    expect(fig.getHandWorldPosition('right').distanceTo(grip)).toBeLessThan(0.05);
    // The wrist sits above the grip and the fingers run down toward the nib.
    expect(wristWorld(fig, 'right').y).toBeGreaterThan(grip.y + 0.5);

    fig.holdAt('right', null);
    step(fig, clock, 90);
    expect(fig.arms.right.mode).toBe('rest');
    expectVec3Close(wristWorld(fig, 'right'), [3.0, -0.4, 14.5], 0.05);
  });

  it('a gesture overrides holdAt and the arm returns to the held object afterwards', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_NEAR });
    const clock = { t: 0 };
    const grip = new THREE.Vector3(7.3, 0.3, 6.0);
    fig.holdAt('right', grip, [0.35, 0.8, 0.5]);
    step(fig, clock, 60);
    let done = false;
    fig.playStone({ hand: 'right', from: LAYOUT.BOWL_WHITE.position, to: [0, 0.6, 0], player: 2 }).then(() => {
      done = true;
    });
    await runFrames(fig, clock, 40);
    expect(fig.arms.right.mode).toBe('gesture');
    for (let i = 0; i < 240 && !done; i++) await runFrames(fig, clock, 1);
    step(fig, clock, 40);
    expect(fig.arms.right.mode).toBe('hold');
    expect(fig.getHandWorldPosition('right').distanceTo(grip)).toBeLessThan(0.05);
  });

  it('setThinking hovers 1.6 above a point or raises the hand to the chin', () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    const tray = new THREE.Vector3(...LAYOUT.TRAY.position).setY(0.6);
    fig.setThinking(true, { hand: 'right', hoverAt: tray });
    step(fig, clock, 120);
    expect(fig.arms.right.mode).toBe('think');
    expect(fig.arms.left.mode).toBe('rest');
    expect(fig.getHandWorldPosition('right').distanceTo(tray.clone().setY(tray.y + 1.6))).toBeLessThan(0.05);

    fig.setThinking(true, { hand: 'left' });
    step(fig, clock, 120);
    expect(fig.arms.right.mode).toBe('rest');
    expect(fig.arms.left.mode).toBe('think');
    const chin = fig.getHandWorldPosition('left');
    const head = fig.getHeadWorldPosition();
    expect(chin.y).toBeGreaterThan(head.y - 2.6);
    expect(chin.y).toBeLessThan(head.y - 0.8);
    expect(chin.z).toBeGreaterThan(head.z); // in front of the face (the far figure faces +Z)

    fig.setThinking(false);
    step(fig, clock, 120);
    expect(fig.arms.left.mode).toBe('rest');
  });

  it('lookAt turns the head toward a point within the yaw/pitch limits and null recentres it', () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    fig.lookAt(new THREE.Vector3(6.0, 0.5, 4.5)); // the ledger, front-left of the opponent
    step(fig, clock, 240);
    const yaw = fig.head.rotation.y;
    expect(yaw).toBeGreaterThan(5 * DEG);
    expect(yaw).toBeLessThan(60 * DEG + 0.05);
    expect(fig.head.rotation.x).toBeGreaterThan(0); // looking down at the table
    expect(fig.head.rotation.x).toBeLessThan(40 * DEG + 0.05);

    fig.lookAt([40, 5, -16]); // far off to the side: clamped to 60 degrees plus a little idle drift
    step(fig, clock, 240);
    expect(fig.head.rotation.y).toBeLessThan(60 * DEG + 0.05);
    expect(fig.head.rotation.y).toBeGreaterThan(55 * DEG);

    fig.lookAt(null);
    step(fig, clock, 240);
    expect(Math.abs(fig.head.rotation.y)).toBeLessThan(0.05);
  });

  it('leans in when a target is beyond arm reach, and only up to the seat cap', () => {
    const far = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    far.setThinking(true, { hand: 'right', hoverAt: [0, 0.6, 3.0] }); // near rows of the board
    step(far, clock, 240);
    expect(far.torso.rotation.x).toBeGreaterThan(10 * DEG);
    expect(far.torso.rotation.x).toBeLessThanOrEqual(22 * DEG + 1e-6);

    const near = new Figure({ seat: LAYOUT.SEAT_NEAR });
    near.setThinking(true, { hand: 'left', hoverAt: LAYOUT.BOWL_BLACK.position });
    step(near, clock, 240);
    expect(near.torso.rotation.x).toBeGreaterThan(2 * DEG);
    expect(near.torso.rotation.x).toBeLessThanOrEqual(8 * DEG + 1e-6);

    const stiff = new Figure({ seat: LAYOUT.SEAT_NEAR, maxLeanDeg: 0 });
    stiff.setThinking(true, { hand: 'left', hoverAt: LAYOUT.BOWL_BLACK.position });
    step(stiff, clock, 120);
    expect(stiff.torso.rotation.x).toBe(0);

    far.setThinking(false);
    step(far, clock, 240);
    expect(far.torso.rotation.x).toBeLessThan(0.5 * DEG);
  });
});

describe('Figure – bow / nod', () => {
  it('bow pitches the torso to ~18 degrees, holds, and comes back', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    let done = false;
    fig.bow().then(() => {
      done = true;
    });
    await runFrames(fig, clock, 31); // 0.5 s: fully forward
    expect(fig.torso.rotation.x).toBeCloseTo(18 * DEG, 2);
    await runFrames(fig, clock, 20); // still holding at 0.85 s
    expect(fig.torso.rotation.x).toBeCloseTo(18 * DEG, 2);
    expect(done).toBe(false);
    await runFrames(fig, clock, 45); // 1.6 s: back
    expect(done).toBe(true);
    expect(Math.abs(fig.torso.rotation.x)).toBeLessThan(1e-6);
    // Shoulders (and so the arms) pitched with the torso and are back where they started.
    expectVec3Close(wristWorld(fig, 'right'), FAR_REST_RIGHT_WRIST, 0.05);
  });

  it('nod tips the head down and returns it within ~700 ms', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const clock = { t: 0 };
    let done = false;
    fig.nod().then(() => {
      done = true;
    });
    await runFrames(fig, clock, 21); // 0.35 s: the deepest point
    expect(fig.head.rotation.x).toBeGreaterThan(12 * DEG);
    await runFrames(fig, clock, 24);
    expect(done).toBe(true);
    expect(Math.abs(fig.head.rotation.x)).toBeLessThan(2 * DEG);
  });
});

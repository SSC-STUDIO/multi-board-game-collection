import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, INTERACTIVE } from '../Layout.js';
import { DynamicTexture, drawClockDial } from '../../utils/DynamicTexture.js';
import { woodTexture, createBrushedMetalTexture } from '../../utils/ProceduralTextures.js';
import { cubicEaseOut, backEaseOut, lerp } from '../../utils/Easing.js';

const DIAL_RADIUS = 0.6;
const DIAL_SPACING = 1.4;
const DIAL_TEX = 512;
const LEVER_TILT = THREE.MathUtils.degToRad(8);
const PLUNGER_LENGTH = 0.4;
const PLUNGER_TRAVEL = 0.15;
const BEVEL = 0.06;

/** One mesh (one draw call) from several pre-placed geometries; the sources are disposed. */
function mergedMesh(geometries, material, { cast = false, receive = false } = {}) {
  const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
  for (const g of geometries) g.dispose();
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

/**
 * Dual mechanical chess clock: rosewood case tilted 15° toward the viewer, two
 * brass-rimmed dials driven by DynamicTexture, a see-saw lever on top marking
 * whose clock is running and a brass plunger on the +X side for pause/resume.
 * Left dial = black (player 1), right dial = white (player 2).
 */
export class ChessClock extends Entity {
  /** @param {{ audio?: object }} [opts] */
  constructor({ audio } = {}) {
    super('ChessClock', { audio });
    const [w, h, d] = LAYOUT.CLOCK.size;
    this.size = { w, h, d };
    this.group.position.set(...LAYOUT.CLOCK.position);

    this._wood = new THREE.MeshStandardMaterial({ map: woodTexture('rosewood'), roughness: 0.35, metalness: 0.05 });
    /** Exposed so a scanned rosewood texture set can replace the procedural veneer. */
    this.woodMaterial = this._wood;
    this._brass = new THREE.MeshStandardMaterial({ map: createBrushedMetalTexture(), roughness: 0.25, metalness: 0.95 });

    // The tilt pivot sits on the front-bottom edge so that edge stays on the table
    // while the dial face leans back to look toward the +Z camera.
    const tiltRad = THREE.MathUtils.degToRad(LAYOUT.CLOCK.tiltDeg);
    this._tilt = new THREE.Group();
    this._tilt.position.set(0, 0, d / 2);
    this._tilt.rotation.x = -tiltRad;
    this.group.add(this._tilt);

    this._body = new THREE.Group();
    this._body.position.set(0, h / 2, -d / 2);
    this._tilt.add(this._body);

    // Fixed brass parts (dial rims, lever post and axle) are collected in body space and drawn as one mesh.
    const brass = [];
    this._buildCase(tiltRad);
    this._dials = [this._buildDial(-DIAL_SPACING / 2, '黑', 1, brass), this._buildDial(DIAL_SPACING / 2, '白', 2, brass)];
    this._buildLever(brass);
    this._buildPlunger();
    this._body.add(mergedMesh(brass, this._brass, { cast: true }));

    this.registerInteractive(this._body, INTERACTIVE.CLOCK_BODY, { glow: false, cursor: 'pointer' });
    this.registerInteractive(this._plunger, INTERACTIVE.CLOCK_PLUNGER, { glow: true, cursor: 'pointer' });

    /** @type {1|2|null} */
    this._activePlayer = null;
    this._paused = false;
    this._running = false;
    this._tickAccum = 0;
    this._leverTween = null;
    this._plungerTween = null;
    this._worldPos = new THREE.Vector3();
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  _buildCase(tiltRad) {
    const { w, h, d } = this.size;
    const b = BEVEL;
    // Three overlapping boxes, each shrunk on two axes, read as a chamfered block.
    // The wedge is a non-indexed ExtrudeGeometry, so the boxes are flattened to match before merging.
    const parts = [
      new THREE.BoxGeometry(w, h - 2 * b, d - 2 * b),
      new THREE.BoxGeometry(w - 2 * b, h, d - 2 * b),
      new THREE.BoxGeometry(w - 2 * b, h - 2 * b, d),
    ].map((box) => box.toNonIndexed());
    parts.push(this._wedgeGeometry(tiltRad));
    this._body.add(mergedMesh(parts, this._wood, { cast: true, receive: true }));

    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(w - 0.3, h - 0.3, 0.04),
      new THREE.MeshStandardMaterial({ color: 0x1d120a, roughness: 0.55, metalness: 0.1 }),
    );
    panel.position.z = d / 2 + 0.02;
    panel.receiveShadow = true;
    this._body.add(panel);
  }

  /**
   * Right-angle wedge under the tilted case (shape XY → world ZY, extruded along X).
   * It stands untilted on the table, so it is brought from group space into the
   * tilted `_body` frame to share the case mesh.
   */
  _wedgeGeometry(tiltRad) {
    const { w, d } = this.size;
    const lift = d * Math.sin(tiltRad);
    const run = d * Math.cos(tiltRad);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(-run, 0);
    shape.lineTo(-run, lift);
    shape.closePath();
    const depth = w - 0.2;
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateY(-Math.PI / 2);
    geo.translate(depth / 2, 0, d / 2);
    this._tilt.updateMatrix();
    this._body.updateMatrix();
    const groupToBody = new THREE.Matrix4().multiplyMatrices(this._tilt.matrix, this._body.matrix).invert();
    return geo.applyMatrix4(groupToBody);
  }

  _buildDial(x, label, player, brass) {
    const zFront = this.size.d / 2 + 0.04;
    const dyn = new DynamicTexture({ width: DIAL_TEX, height: DIAL_TEX });

    const face = new THREE.Mesh(
      new THREE.CircleGeometry(DIAL_RADIUS - 0.02, 64),
      new THREE.MeshStandardMaterial({ map: dyn.texture, roughness: 0.55, metalness: 0 }),
    );
    face.position.set(x, 0, zFront + 0.005);
    this._body.add(face);

    const glass = new THREE.Mesh(
      new THREE.CircleGeometry(DIAL_RADIUS - 0.02, 64),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff, transparent: true, opacity: 0.08, roughness: 0.05, metalness: 0,
        clearcoat: 1, depthWrite: false,
      }),
    );
    glass.position.set(x, 0, zFront + 0.02);
    this._body.add(glass);

    brass.push(new THREE.TorusGeometry(DIAL_RADIUS + 0.02, 0.05, 16, 72).translate(x, 0, zFront + 0.03));

    const dial = { player, label, dyn, remainingMs: 0, lastSecond: -1, dirty: true };
    this._drawDial(dial);
    return dial;
  }

  _buildLever(brass) {
    const { w, h } = this.size;
    this._lever = new THREE.Group();
    this._lever.position.set(0, h / 2 + 0.16, 0);
    this._body.add(this._lever);

    // Bar and both pads swing together, so they form one mesh inside the lever group.
    const bar = new THREE.CylinderGeometry(0.045, 0.045, w * 0.78, 16).rotateZ(Math.PI / 2);
    const pads = [-1, 1].map((sx) => new THREE.CylinderGeometry(0.16, 0.18, 0.08, 24).translate(sx * w * 0.36, 0.03, 0));
    this._lever.add(mergedMesh([bar, ...pads], this._brass, { cast: true }));

    // The axle lies on the lever's Z rotation axis so it never visibly moves; it and
    // the post are fixed brass, placed directly in body space.
    brass.push(
      new THREE.CylinderGeometry(0.06, 0.06, 0.3, 16).rotateX(Math.PI / 2).translate(0, h / 2 + 0.16, 0),
      new THREE.BoxGeometry(0.22, 0.2, 0.22).translate(0, h / 2 + 0.08, 0),
    );
  }

  _buildPlunger() {
    const { w, h, d } = this.size;
    this._plungerRestY = h * 0.62;
    this._plunger = new THREE.Group();
    this._plunger.position.set(w / 2, this._plungerRestY - PLUNGER_TRAVEL, -d / 2);
    this._tilt.add(this._plunger);

    // Own material instance so the hover glow lights up only the crank, not every brass part.
    const crankBrass = this._brass.clone();
    const rod = new THREE.CylinderGeometry(0.045, 0.045, PLUNGER_LENGTH, 16).rotateZ(Math.PI / 2).translate(PLUNGER_LENGTH / 2, 0, 0);
    const knob = new THREE.SphereGeometry(0.1, 24, 16).translate(PLUNGER_LENGTH, 0, 0);
    this._plunger.add(mergedMesh([rod, knob], crankBrass, { cast: true }));

    // Vertical slot on the case side that the crank travels in.
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, PLUNGER_TRAVEL + 0.2, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x120c06, roughness: 0.7 }),
    );
    slot.position.set(w / 2 + 0.005, this._plungerRestY - h / 2 - PLUNGER_TRAVEL / 2, 0);
    this._body.add(slot);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Remaining time per player in milliseconds. */
  setTimes(blackMs, whiteMs) {
    this._dials[0].remainingMs = blackMs;
    this._dials[1].remainingMs = whiteMs;
  }

  /** @param {1|2|null} player */
  setActivePlayer(player) {
    if (player === this._activePlayer) return;
    this._activePlayer = player;
    this._markDialsDirty();
    const target = player === 1 ? LEVER_TILT : player === 2 ? -LEVER_TILT : 0;
    this._leverTween?.cancel();
    const from = this._lever.rotation.z;
    this._leverTween = this.tweens.add({
      duration: 80,
      ease: cubicEaseOut,
      onUpdate: (k) => {
        this._lever.rotation.z = lerp(from, target, k);
      },
    });
    this.playSound('clock_lever', this._lever.getWorldPosition(this._worldPos));
  }

  /** Paused = plunger sprung up and second hand frozen; running = plunger pressed. */
  setPaused(paused) {
    paused = Boolean(paused);
    if (paused === this._paused) return;
    this._paused = paused;
    this._markDialsDirty();
    this._plungerTween?.cancel();
    const from = this._plunger.position.y;
    const to = this._plungerRestY - (paused ? 0 : PLUNGER_TRAVEL);
    this._plungerTween = this.tweens.add({
      duration: 60,
      ease: paused ? backEaseOut : cubicEaseOut,
      onUpdate: (k) => {
        this._plunger.position.y = lerp(from, to, k);
      },
    });
    this.playSound('clock_latch', this._plunger.getWorldPosition(this._worldPos));
  }

  setRunning(running) {
    running = Boolean(running);
    if (running === this._running) return;
    this._running = running;
    this._tickAccum = 0;
    this._markDialsDirty();
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    const ticking = this._running && !this._paused;
    // The sweeping second hand is repainted at ~24 Hz: each repaint also re-uploads a
    // 512² texture, and the eye cannot tell 24 from 60 on a hand this small.
    this._sweepAccum = (this._sweepAccum ?? 0) + dt;
    const sweepFrame = this._sweepAccum >= 1 / 24;
    if (sweepFrame) this._sweepAccum = 0;
    for (const dial of this._dials) {
      const live = ticking && this._activePlayer === dial.player && sweepFrame;
      const second = Math.floor(Math.max(0, dial.remainingMs) / 1000);
      if (live || dial.dirty || second !== dial.lastSecond) this._drawDial(dial);
    }
    if (ticking) {
      this._tickAccum += dt;
      if (this._tickAccum >= 1) {
        this._tickAccum %= 1;
        this.playSound('clock_tick', this._body.getWorldPosition(this._worldPos));
      }
    } else {
      this._tickAccum = 0;
    }
  }

  dispose() {
    for (const dial of this._dials) dial.dyn.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _markDialsDirty() {
    for (const dial of this._dials) dial.dirty = true;
  }

  _drawDial(dial) {
    const active = this._running && !this._paused && this._activePlayer === dial.player;
    drawClockDial(dial.dyn.ctx, {
      size: DIAL_TEX,
      remainingMs: dial.remainingMs,
      active,
      paused: this._paused,
      label: dial.label,
    });
    dial.dyn.markDirty();
    dial.lastSecond = Math.floor(Math.max(0, dial.remainingMs) / 1000);
    dial.dirty = false;
  }
}

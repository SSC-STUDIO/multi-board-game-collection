import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, INTERACTIVE } from '../Layout.js';
import { createBrushedMetalTexture, createRadialGlowTexture } from '../../utils/ProceduralTextures.js';
import { cubicEaseInOut, cubicEaseOut, lerp, clamp01 } from '../../utils/Easing.js';

const CAP_H = 0.12;
const NECK_R = 0.07;
const FLOW_CYCLE_S = 60;
const STREAM_COUNT = 40;
const UPPER_SAND_H = 0.6;
const LOWER_SAND_H = 0.5;
const SAND_COLOR = 0xd8b45a;
const SAND_DIM = 0x8a7440;
const FLIP_MS = 450;
const BURST_AT_MS = 150;
const BURST_MS = 400;
const SETTLE_MS = 200;

/**
 * Brass double-pillar sandglass used for undo. Glass and frame live inside
 * `pivot` (centred on the glass mid-point) which spins 180° about Z on flip.
 * Sand is a shrinking apex-down cone in the upper bulb, a growing pile in the
 * lower bulb and a Points stream between them.
 */
export class Sandglass extends Entity {
  /** @param {{ audio?: object }} [opts] */
  constructor({ audio } = {}) {
    super('Sandglass', { audio });
    const { position, height, radius } = LAYOUT.SANDGLASS;
    this.group.position.set(...position);
    this.height = height;
    this.radius = radius;
    this.glassH = height - 2 * CAP_H;

    this.pivot = new THREE.Group();
    this.pivot.position.y = height / 2;
    this.group.add(this.pivot);

    this._brass = new THREE.MeshStandardMaterial({ map: createBrushedMetalTexture(), roughness: 0.25, metalness: 0.95 });
    this._sandMat = new THREE.MeshStandardMaterial({ color: SAND_COLOR, roughness: 0.9, metalness: 0.05 });

    this._flow = 0;
    this._flowing = false;
    this._busy = false;
    this._burst = 0;
    this._settle = null;
    this._worldPos = new THREE.Vector3();

    this._buildFrame();
    this._buildGlass();
    this._buildSand();
    this._buildStream();
    this._applySand();

    this.registerInteractive(this.pivot, INTERACTIVE.SANDGLASS, { glow: true, cursor: 'pointer' });
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  /** The whole frame flips with the pivot and shares one material, so it is built as a single mesh. */
  _buildFrame() {
    const { height, radius, glassH } = this;
    const capR = radius + 0.18;
    const parts = [];
    for (const sy of [-1, 1]) {
      parts.push(new THREE.CylinderGeometry(capR, capR, CAP_H, 48).translate(0, sy * (height / 2 - CAP_H / 2), 0));
      parts.push(new THREE.TorusGeometry(capR - 0.02, 0.035, 12, 64).rotateX(Math.PI / 2).translate(0, sy * (height / 2 - CAP_H), 0));
    }
    // Pillars on ±X so neither occludes the glass from the +Z camera. Ring
    // ornaments are mirrored in Y so the frame is symmetric under a half-turn.
    const pillarX = radius + 0.1;
    for (const sx of [-1, 1]) {
      parts.push(new THREE.CylinderGeometry(0.045, 0.045, glassH, 16).translate(sx * pillarX, 0, 0));
      for (const fy of [-0.7, -0.35, 0, 0.35, 0.7]) {
        parts.push(new THREE.TorusGeometry(0.075, 0.022, 10, 24).rotateX(Math.PI / 2).translate(sx * pillarX, fy * (glassH / 2), 0));
      }
    }
    const frame = new THREE.Mesh(mergeGeometries(parts, false), this._brass);
    for (const g of parts) g.dispose();
    frame.castShadow = true;
    frame.receiveShadow = true;
    this.pivot.add(frame);
  }

  /**
   * Glass radius at pivot-space height `y`. Each bulb widens from the cap on a
   * sine curve, peaks 30% of the way in and narrows (concave) to the neck, so a
   * straight cone from the neck always stays inside the glass.
   */
  glassRadiusAt(y) {
    const half = this.glassH / 2;
    const fromCap = clamp01((half - Math.abs(y)) / half);
    const R = this.radius;
    const capR = R * 0.62;
    if (fromCap < 0.3) return capR + (R - capR) * Math.sin((Math.PI / 2) * (fromCap / 0.3));
    return NECK_R + (R - NECK_R) * Math.sin((Math.PI / 2) * ((1 - fromCap) / 0.7));
  }

  _buildGlass() {
    const pts = [];
    const N = 48;
    for (let i = 0; i <= N; i++) {
      const y = -this.glassH / 2 + (i / N) * this.glassH;
      pts.push(new THREE.Vector2(this.glassRadiusAt(y), y));
    }
    // Cheap glass by default: real transmission re-renders the whole scene every
    // frame (≈ +18 ms on an iGPU); opt back in with setTransmission(true).
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xe6f0f4,
      transmission: 0,
      roughness: 0.05,
      ior: 1.52,
      thickness: 0.3,
      transparent: true,
      opacity: 0.3,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.6,
      metalness: 0,
      // Without this the stream Points inside would be depth-culled by the front surface.
      depthWrite: false,
    });
    this.glass = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), mat);
    this.glass.castShadow = false;
    this.glass.receiveShadow = false;
    this.pivot.add(this.glass);
    this._transmission = false;
  }

  /**
   * Real refraction costs a full extra scene pass per frame in three.js; the
   * cheap alternative is a clear-coated translucent shell that still picks up
   * the environment reflections.
   * @param {boolean} enabled
   */
  setTransmission(enabled) {
    enabled = Boolean(enabled);
    if (enabled === this._transmission) return;
    this._transmission = enabled;
    const mat = /** @type {THREE.MeshPhysicalMaterial} */ (this.glass.material);
    if (enabled) {
      mat.transmission = 0.95;
      mat.opacity = 1;
      mat.clearcoat = 0;
      mat.envMapIntensity = 1;
    } else {
      mat.transmission = 0;
      mat.opacity = 0.3;
      mat.clearcoat = 1;
      mat.clearcoatRoughness = 0.05;
      mat.envMapIntensity = 1.6;
    }
    mat.needsUpdate = true;
  }

  _buildSand() {
    // Upper cone: apex at local y=0 (the neck), flat surface at y=1 before scaling.
    const upperGeo = new THREE.ConeGeometry(1, 1, 40);
    upperGeo.rotateX(Math.PI);
    upperGeo.translate(0, 0.5, 0);
    this.upperSand = new THREE.Mesh(upperGeo, this._sandMat);
    // Lower pile: base at local y=0, apex at y=1 before scaling.
    const lowerGeo = new THREE.ConeGeometry(1, 1, 40);
    lowerGeo.translate(0, 0.5, 0);
    this.lowerSand = new THREE.Mesh(lowerGeo, this._sandMat);
    this.pivot.add(this.upperSand, this.lowerSand);
  }

  _buildStream() {
    this._streamPhase = new Float32Array(STREAM_COUNT);
    this._streamJitter = new Float32Array(STREAM_COUNT * 2);
    for (let i = 0; i < STREAM_COUNT; i++) {
      this._streamPhase[i] = i / STREAM_COUNT;
      this._streamJitter[i * 2] = (Math.random() - 0.5) * 0.05;
      this._streamJitter[i * 2 + 1] = (Math.random() - 0.5) * 0.05;
    }
    const geo = new THREE.BufferGeometry();
    this._streamAttr = new THREE.BufferAttribute(new Float32Array(STREAM_COUNT * 3), 3);
    this._streamAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this._streamAttr);
    const mat = new THREE.PointsMaterial({
      map: createRadialGlowTexture(),
      color: SAND_COLOR,
      size: 0.07,
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
      sizeAttenuation: true,
    });
    this.stream = new THREE.Points(geo, mat);
    this.stream.frustumCulled = false;
    this.stream.visible = false;
    this.pivot.add(this.stream);
    this._updateStream(0);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get busy() {
    return this._busy;
  }

  /**
   * Undo gesture: 'wood_brass_swivel' at 0ms, 180° spin over 450ms, reverse
   * sand burst + 'sand_trickle' from 150ms. Resolves when the spin completes.
   */
  flip() {
    if (this._busy) return Promise.resolve();
    this._busy = true;
    this._settle?.cancel();
    this._settle = null;
    const startFlow = this._flow;
    this.group.getWorldPosition(this._worldPos);
    this.playSound('wood_brass_swivel', this._worldPos);

    this.tweens.wait(BURST_AT_MS).then(() => {
      if (!this._busy) return;
      this._burst = BURST_MS / 1000;
      this.playSound('sand_trickle', this._worldPos);
    });

    return this.tweens
      .add({
        duration: FLIP_MS,
        ease: cubicEaseInOut,
        onUpdate: (k) => {
          this.pivot.rotation.z = Math.PI * k;
        },
      })
      .then(() => {
        // The frame is symmetric under a half-turn, so snapping back is invisible.
        // Swap chamber contents, then let the sand rush back to a full top bulb
        // while the reverse burst is still in the air.
        this.pivot.rotation.z = 0;
        const swapped = 1 - startFlow;
        this._flow = swapped;
        this._applySand();
        this._busy = false;
        this._settle = this.tweens.add({
          duration: SETTLE_MS,
          ease: cubicEaseOut,
          onUpdate: (k) => {
            this._flow = lerp(swapped, 0, k);
            this._applySand();
          },
          onComplete: () => {
            this._settle = null;
          },
        });
      });
  }

  /** Dim brass and sand when there is nothing to undo. */
  setEnabled(enabled) {
    enabled = Boolean(enabled);
    this._brass.color.setHex(enabled ? 0xffffff : 0x8a8a8a);
    this._sandMat.color.setHex(enabled ? SAND_COLOR : SAND_DIM);
    this.stream.material.color.setHex(enabled ? SAND_COLOR : SAND_DIM);
  }

  /** Sand trickles (≈60 s per cycle) while the game is running; frozen otherwise. */
  setFlowing(flowing) {
    this._flowing = Boolean(flowing);
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    if (this._burst > 0) this._burst = Math.max(0, this._burst - dt);
    if (this._flowing && !this._busy && !this._settle) {
      this._flow += dt / FLOW_CYCLE_S;
      if (this._flow >= 1) this._flow -= 1;
      this._applySand();
    }
    const streaming = (this._flowing && !this._busy) || this._burst > 0;
    this.stream.visible = streaming;
    if (streaming) this._updateStream(dt);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  _applySand() {
    const f = clamp01(this._flow);
    const bottomY = -this.glassH / 2 + 0.02;
    const upH = UPPER_SAND_H * (1 - f);
    const upR = this.glassRadiusAt(0.03 + upH) * 0.9;
    this.upperSand.visible = upH > 0.01;
    this.upperSand.scale.set(upR, Math.max(upH, 0.001), upR);
    this.upperSand.position.y = 0.03;

    const lowH = LOWER_SAND_H * f;
    const lowR = this.glassRadiusAt(bottomY + 0.02) * 0.92;
    this.lowerSand.visible = lowH > 0.005;
    this.lowerSand.scale.set(lowR, Math.max(lowH, 0.001), lowR);
    this.lowerSand.position.y = bottomY;
  }

  /** Stream runs from just below the neck down to the pile apex (phase 0 → 1); a burst runs it backwards past the neck. */
  _updateStream(dt) {
    const bursting = this._burst > 0;
    const top = 0.02;
    const bottom = -this.glassH / 2 + 0.02 + LOWER_SAND_H * clamp01(this._flow);
    const span = Math.max(0.05, top - bottom);
    const step = (dt * (bursting ? 2.6 : 1.4)) / span;
    const spread = bursting ? 3 : 1;
    const arr = this._streamAttr.array;
    for (let i = 0; i < STREAM_COUNT; i++) {
      let p = this._streamPhase[i];
      if (bursting) {
        p -= step;
        if (p < -0.6) p += 1.6;
      } else {
        p += step;
        if (p >= 1) p -= 1;
      }
      this._streamPhase[i] = p;
      const widen = spread * (0.4 + Math.abs(p));
      arr[i * 3] = this._streamJitter[i * 2] * widen;
      arr[i * 3 + 1] = top - p * span;
      arr[i * 3 + 2] = this._streamJitter[i * 2 + 1] * widen;
    }
    this._streamAttr.needsUpdate = true;
  }
}

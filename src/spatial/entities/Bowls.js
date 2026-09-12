import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, INTERACTIVE, STONE_HEIGHT } from '../Layout.js';
import { cubicEaseInOut, cubicEaseOut } from '../../utils/Easing.js';
import { woodTexture } from '../../utils/ProceduralTextures.js';
import { createStoneGeometry, createStoneMaterial } from './Board.js';

// Normalised lathe profile (x = radius / R, y = height / H): bottom → outer wall → rim → inner wall → floor.
const BOWL_PROFILE = [
  [0, 0], [0.42, 0], [0.6, 0.04], [0.82, 0.16], [0.96, 0.32], [1.0, 0.48], [0.96, 0.66],
  [0.86, 0.84], [0.74, 0.96], [0.7, 1.0],
  [0.62, 1.0], [0.6, 0.96], [0.72, 0.8], [0.82, 0.6], [0.84, 0.45], [0.7, 0.32], [0.45, 0.27], [0, 0.26],
];
const INNER_FLOOR = 0.27; // fraction of H
// Domed lid (x = radius / R, y in world units).
const LID_PROFILE = [[0, 0], [0.76, 0], [0.8, 0.05], [0.78, 0.12], [0.6, 0.18], [0.3, 0.22], [0, 0.24]];
const LID_LIFT = 0.6;

// Where an opened lid parks (offset from the bowl), chosen to clear the board and neighbouring props.
const LID_PARK_OFFSET = { 1: [2.0, 0, -0.4], 2: [-2.0, 0, -1.1] };

// Stone pile layout: [ring radius / R, count, layer height in stone heights]. Jittered per bowl with a seeded PRNG.
const PILE_LAYERS = [[0.4, 5, 0], [0, 1, 0.5], [0.24, 3, 1.15], [0.06, 1, 1.9]];

/** Deterministic PRNG so the stone pile is identical on every load. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Two turned-wood go bowls: black walnut (player 1, left) and ash (player 2,
 * right). Opening a lid is the colour-selection gesture; the lid then parks on
 * the table beside the bowl as a capture tray.
 */
export class Bowls extends Entity {
  constructor({ audio } = {}) {
    super('bowls', { audio });
    this.stoneGeometry = createStoneGeometry();
    this.selectable = false;
    this.bowls = {
      1: this._buildBowl(1, LAYOUT.BOWL_BLACK, 'blackWalnut', INTERACTIVE.BOWL_BLACK, 11),
      2: this._buildBowl(2, LAYOUT.BOWL_WHITE, 'ash', INTERACTIVE.BOWL_WHITE, 23),
    };
  }

  _buildBowl(color, layout, wood, interactiveId, seed) {
    const R = layout.radius;
    const H = layout.height;
    const root = new THREE.Group();
    root.name = `bowl_${color}`;
    root.position.fromArray(layout.position);
    this.group.add(root);

    const material = new THREE.MeshPhysicalMaterial({
      map: woodTexture(wood), roughness: 0.35, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.35,
      emissive: 0xffa860, emissiveIntensity: 0,
    });

    const body = new THREE.Mesh(
      new THREE.LatheGeometry(BOWL_PROFILE.map(([x, y]) => new THREE.Vector2(x * R, y * H)), 48),
      material,
    );
    body.castShadow = true;
    body.receiveShadow = true;
    root.add(body);

    const lid = new THREE.Mesh(
      new THREE.LatheGeometry(LID_PROFILE.map(([x, y]) => new THREE.Vector2(x * R, y)), 48),
      material,
    );
    lid.castShadow = true;
    lid.receiveShadow = true;
    root.add(lid);

    // Loosely resting: shifted a little and tilted so one edge sits on the rim.
    const rest = { position: new THREE.Vector3(0.1 * R, H + 0.06, 0.05 * R), rotation: new THREE.Euler(0.04, 0, 0.1) };
    const park = { position: new THREE.Vector3().fromArray(LID_PARK_OFFSET[color]), rotation: new THREE.Euler(0, 0, 0) };
    lid.position.copy(rest.position);
    lid.rotation.copy(rest.rotation);

    const pileTop = this._fillStones(root, color, R, H, seed);

    this.registerInteractive(root, interactiveId, { glow: true, cursor: 'pointer' });
    return { root, body, lid, material, rest, park, open: false, pileTop, layout, seq: 0, anims: [] };
  }

  /**
   * Jittered layers of stones inside the bowl, baked into a single mesh (the pile
   * never moves, so one draw call instead of one per stone). Returns the pile's
   * top height (local Y).
   */
  _fillStones(root, color, R, H, seed) {
    const rnd = mulberry32(seed);
    const floorY = H * INNER_FLOOR;
    const placement = new THREE.Matrix4();
    const tilt = new THREE.Euler();
    const parts = [];
    let top = 0;
    for (const [ring, count, layer] of PILE_LAYERS) {
      const phase = rnd() * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        const angle = phase + (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
        const radius = R * (ring + (rnd() - 0.5) * 0.06);
        // Neighbours in a ring alternate height so they shingle instead of intersecting.
        const y = floorY + (layer + (i % 2) * 0.35) * STONE_HEIGHT * 0.9;
        // Same PRNG draw order as the per-stone version, so existing piles look identical.
        tilt.set((rnd() - 0.5) * 0.4 * layer, rnd() * Math.PI, (rnd() - 0.5) * 0.4 * layer);
        placement.makeRotationFromEuler(tilt).setPosition(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        parts.push(this.stoneGeometry.clone().applyMatrix4(placement));
        top = Math.max(top, y + STONE_HEIGHT);
      }
    }
    const pile = new THREE.Mesh(mergeGeometries(parts, false), createStoneMaterial(color));
    for (const g of parts) g.dispose();
    pile.name = 'stonePile';
    pile.castShadow = true;
    root.add(pile);
    return top;
  }

  _beginLidAnim(bowl) {
    for (const a of bowl.anims) a.cancel();
    bowl.anims = [];
    return ++bowl.seq;
  }

  _track(bowl, tween) {
    bowl.anims.push(tween);
    return tween;
  }

  /**
   * Lift the lid, then glide it to its parking spot beside the bowl (toward the
   * board). Resolves when the lid has landed.
   */
  async openLid(color) {
    const bowl = this.bowls[color];
    if (!bowl || bowl.open) return;
    bowl.open = true;
    const seq = this._beginLidAnim(bowl);
    const { lid, rest, park } = bowl;

    const from = lid.position.clone();
    const fromRot = lid.rotation.clone();
    const lifted = rest.position.clone().setY(rest.position.y + LID_LIFT);
    await this._track(bowl, this.tweens.add({
      duration: 200,
      ease: cubicEaseOut,
      onUpdate: (k) => {
        lid.position.lerpVectors(from, lifted, k);
        lid.rotation.set(fromRot.x * (1 - k), 0, fromRot.z * (1 - k));
      },
    }));
    if (bowl.seq !== seq) return;

    await this._track(bowl, this.tweens.add({
      duration: 600,
      ease: cubicEaseInOut,
      onUpdate: (k) => {
        lid.position.lerpVectors(lifted, park.position, k);
        lid.position.y += Math.sin(k * Math.PI) * 0.4;
      },
      onComplete: () => {
        lid.position.copy(park.position);
        lid.rotation.copy(park.rotation);
        this.playSound('bowl_lid', lid.getWorldPosition(new THREE.Vector3()));
      },
    }));
    if (bowl.seq === seq) bowl.anims = [];
  }

  /** Return every opened lid to its loosely-resting pose on the bowl mouth (~500ms). */
  closeLids() {
    const pending = [];
    for (const bowl of Object.values(this.bowls)) {
      if (!bowl.open) continue;
      bowl.open = false;
      const seq = this._beginLidAnim(bowl);
      const { lid, rest } = bowl;
      const from = lid.position.clone();
      const fromRot = lid.rotation.clone();
      const tween = this._track(bowl, this.tweens.add({
        duration: 500,
        ease: cubicEaseInOut,
        onUpdate: (k) => {
          lid.position.lerpVectors(from, rest.position, k);
          lid.position.y += Math.sin(k * Math.PI) * LID_LIFT;
          lid.rotation.set(
            fromRot.x + (rest.rotation.x - fromRot.x) * k,
            0,
            fromRot.z + (rest.rotation.z - fromRot.z) * k,
          );
        },
        onComplete: () => {
          lid.position.copy(rest.position);
          lid.rotation.copy(rest.rotation);
          this.playSound('bowl_lid', lid.getWorldPosition(new THREE.Vector3()));
        },
      }));
      pending.push(tween.then(() => {
        if (bowl.seq === seq) bowl.anims = [];
      }));
    }
    return Promise.all(pending).then(() => undefined);
  }

  /** Colour-selection phase: both bowls breathe (scale 1↔1.03) with a warm inner glow. */
  setSelectable(enabled) {
    this.selectable = enabled;
    if (!enabled) {
      for (const bowl of Object.values(this.bowls)) {
        bowl.root.scale.setScalar(1);
        bowl.material.emissiveIntensity = 0;
      }
    }
  }

  isOpen(color) {
    return Boolean(this.bowls[color]?.open);
  }

  /** World point 0.3 above the bowl mouth (flight target for returning stones). */
  getBowlPosition(color) {
    const bowl = this.bowls[color];
    return new THREE.Vector3().fromArray(bowl.layout.position).setY(bowl.layout.height + 0.3);
  }

  /** World point on the surface of the stone pile inside the bowl. */
  getStoneRestPosition(color) {
    const bowl = this.bowls[color];
    return new THREE.Vector3().fromArray(bowl.layout.position).setY(bowl.pileTop);
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    if (!this.selectable) return;
    const wave = 0.5 + 0.5 * Math.sin(elapsed * 2.2);
    const scale = 1 + 0.03 * wave;
    for (const bowl of Object.values(this.bowls)) {
      bowl.root.scale.setScalar(scale);
      bowl.material.emissiveIntensity = 0.04 + 0.14 * wave;
    }
  }
}

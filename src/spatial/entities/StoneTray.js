import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, STONE_HEIGHT } from '../Layout.js';
import { createStoneGeometry, createStoneMaterial } from './Board.js';

// Shallow lacquer dish: bottom → foot → flared wall → rim → inner wall → floor (x = r / R, y = h / H).
const DISH_PROFILE = [
  [0, 0], [0.55, 0], [0.62, 0.08], [0.9, 0.55], [1.0, 0.94], [0.98, 1.0],
  [0.9, 1.0], [0.84, 0.88], [0.6, 0.5], [0.3, 0.42], [0, 0.4],
];
const INNER_FLOOR = 0.4;
// Loose ring of stones plus a couple on top (ring radius / R, count, layer in stone heights).
const PILE_LAYERS = [[0.48, 6, 0], [0.16, 2, 0.6], [0, 1, 1.25]];

/**
 * The AI opponent's own dish of stones, sitting at its right hand on the far
 * side of the table. Filled with the AI's colour once the human has chosen a
 * bowl; empty (dish only) while nobody has sat down. Purely decorative: the
 * bowls remain the colour selectors.
 */
export class StoneTray extends Entity {
  constructor({ audio } = {}) {
    super('stoneTray', { audio });
    const { position, radius, height } = LAYOUT.TRAY;
    this.radius = radius;
    this.height = height;
    this.group.position.fromArray(position);

    const lacquer = new THREE.MeshPhysicalMaterial({
      color: 0x2a1410, roughness: 0.22, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.2,
      emissive: 0x000000, emissiveIntensity: 0,
    });
    const dish = new THREE.Mesh(
      new THREE.LatheGeometry(DISH_PROFILE.map(([x, y]) => new THREE.Vector2(x * radius, y * height)), 40),
      lacquer,
    );
    dish.castShadow = true;
    dish.receiveShadow = true;
    dish.name = 'dish';
    this.group.add(dish);

    this.stoneGeometry = createStoneGeometry();
    /** @type {THREE.Mesh | null} */
    this.pile = null;
    /** @type {1 | 2 | null} */
    this.color = null;
    this.pileTop = height * INNER_FLOOR;
  }

  /** Fill the dish with stones of `color` (1 black, 2 white) or empty it with null. */
  setColor(color) {
    if (color === this.color) return;
    this.color = color;
    if (this.pile) {
      this.group.remove(this.pile);
      this.pile.geometry.dispose();
      /** @type {THREE.Material} */ (this.pile.material).dispose();
      this.pile = null;
    }
    this.pileTop = this.height * INNER_FLOOR;
    if (color !== 1 && color !== 2) return;

    const placement = new THREE.Matrix4();
    const tilt = new THREE.Euler();
    const parts = [];
    const floorY = this.height * INNER_FLOOR;
    let seed = 0.37;
    const rnd = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (const [ring, count, layer] of PILE_LAYERS) {
      const phase = rnd() * Math.PI * 2;
      for (let i = 0; i < count; i++) {
        const angle = phase + (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.25;
        const r = this.radius * (ring + (rnd() - 0.5) * 0.05);
        const y = floorY + (layer + (i % 2) * 0.3) * STONE_HEIGHT * 0.9;
        tilt.set((rnd() - 0.5) * 0.3 * layer, rnd() * Math.PI, (rnd() - 0.5) * 0.3 * layer);
        placement.makeRotationFromEuler(tilt).setPosition(Math.cos(angle) * r, y, Math.sin(angle) * r);
        parts.push(this.stoneGeometry.clone().applyMatrix4(placement));
        this.pileTop = Math.max(this.pileTop, y + STONE_HEIGHT);
      }
    }
    this.pile = new THREE.Mesh(mergeGeometries(parts, false), createStoneMaterial(color));
    for (const g of parts) g.dispose();
    this.pile.castShadow = true;
    this.pile.name = 'trayStones';
    this.group.add(this.pile);
  }

  /** World point just above the stones, where a hand reaches in. */
  getPickPosition() {
    return new THREE.Vector3(0, this.pileTop + 0.15, 0).add(this.group.position);
  }
}

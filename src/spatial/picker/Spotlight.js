/**
 * Pulsing emissive highlight on whole props, used by the tutorial to point at
 * the object being explained. Same trick as the InteractionManager hover glow
 * (tint every emissive-capable material under the roots) but with its own
 * backup map, so it never fights with hover restoration.
 */
import * as THREE from 'three';

const SPOT_EMISSIVE = 0xc98a2e;
const BASE_INTENSITY = 0.22;
const PULSE_AMPLITUDE = 0.22;

function materialsOf(object) {
  const m = /** @type {any} */ (object).material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

export class Spotlight {
  constructor() {
    /** @type {Map<THREE.Material, { emissive: THREE.Color, intensity: number }>} */
    this._backup = new Map();
    this._tint = new THREE.Color(SPOT_EMISSIVE);
  }

  get active() {
    return this._backup.size > 0;
  }

  /**
   * Replace the highlighted set. Materials shared between the roots and other
   * meshes would glow too, so callers pass prop groups that own their materials.
   * @param {THREE.Object3D[]} roots
   */
  set(roots) {
    this.clear();
    for (const root of roots) {
      root.traverse((object) => {
        for (const material of materialsOf(object)) {
          const m = /** @type {any} */ (material);
          if (!m.emissive || !m.emissive.isColor || this._backup.has(material)) continue;
          this._backup.set(material, { emissive: m.emissive.clone(), intensity: m.emissiveIntensity });
          m.emissive.copy(this._tint);
          m.emissiveIntensity = BASE_INTENSITY;
        }
      });
    }
  }

  /** @param {number} elapsed seconds */
  update(elapsed) {
    if (this._backup.size === 0) return;
    const intensity = BASE_INTENSITY + PULSE_AMPLITUDE * (0.5 + 0.5 * Math.sin(elapsed * 3.2));
    for (const material of this._backup.keys()) /** @type {any} */ (material).emissiveIntensity = intensity;
  }

  clear() {
    for (const [material, backup] of this._backup) {
      const m = /** @type {any} */ (material);
      m.emissive.copy(backup.emissive);
      m.emissiveIntensity = backup.intensity;
    }
    this._backup.clear();
  }
}

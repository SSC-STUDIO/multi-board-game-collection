import * as THREE from 'three';
import { Tweens } from '../../utils/Tween.js';

/**
 * Base class for every diegetic prop on the table.
 *
 * Contract:
 *  - `group`         the THREE.Group that World adds to the scene
 *  - `interactives`  meshes the InteractionManager should raycast against,
 *                    tagged with an id from `INTERACTIVE` (see Layout.js)
 *  - `tweens`        per-entity tween scheduler; subclasses MUST call
 *                    `super.update(dt, elapsed)` so tweens advance
 *  - `audio`         optional duck-typed `{ play(name, { position, volume }) }`
 *                    injected through the constructor options; never required
 */
export class Entity {
  /**
   * @param {string} name
   * @param {{ audio?: { play: (name: string, opts?: object) => void } }} [options]
   */
  constructor(name, options = {}) {
    this.name = name;
    this.group = new THREE.Group();
    this.group.name = name;
    this.audio = options.audio ?? null;
    this.tweens = new Tweens();
    /** @type {Array<{ object: THREE.Object3D, id: string, glow: boolean, cursor: string }>} */
    this.interactives = [];
  }

  /**
   * Mark a mesh as clickable/hoverable. `id` should come from `INTERACTIVE`.
   * @template {THREE.Object3D} T
   * @param {T} object
   * @param {string} id
   * @param {{ glow?: boolean, cursor?: string }} [opts]
   * @returns {T}
   */
  registerInteractive(object, id, { glow = true, cursor = 'pointer' } = {}) {
    object.userData.interactiveId = id;
    this.interactives.push({ object, id, glow, cursor });
    return object;
  }

  /** Fire a positional sound if an audio service was injected. */
  playSound(name, position = null, extra = {}) {
    if (!this.audio) return;
    let pos = position;
    if (position && position.isVector3) pos = [position.x, position.y, position.z];
    this.audio.play(name, { position: pos, ...extra });
  }

  /**
   * @param {number} dt       seconds since last frame
   * @param {number} elapsed  seconds since the world started
   */
  update(dt, elapsed) {
    this.tweens.update(dt);
  }

  dispose() {
    this.tweens.cancelAll();
    this.group.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mat = obj.material;
      if (Array.isArray(mat)) mat.forEach((m) => m?.dispose?.());
      else mat?.dispose?.();
    });
    this.group.removeFromParent();
  }
}

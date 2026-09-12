/**
 * Lighting rig for the study: a warm key light with soft shadows, a focal
 * spot pooled over the board, a faint cool fill from the window side, a low
 * hemisphere bounce and a *warm, dim* image-based environment for reflections.
 *
 * The environment is built here instead of using RoomEnvironment: that studio
 * preset is bright and neutral, which lifted every shadow and desaturated the
 * wood into the washed-out grey the scene used to have. Ours is a dark room
 * with one warm ceiling panel, a cool window and two lantern glows, applied at
 * reduced `scene.environmentIntensity`.
 *
 * `setMood()` cross-fades colour temperature, intensities and exposure
 * (DIEGETIC_UI_SPEC §1.3: pause drops ≈4500K → ≈3000K, "frozen morning mist").
 *
 * Importable under Node; the constructor needs a real WebGLRenderer when
 * `ibl` is enabled.
 */
import * as THREE from 'three';
import { clamp01, lerp, smoothstep } from '../utils/Easing.js';

/**
 * @typedef {object} MoodPreset
 * @property {string} key          key light colour (hex string)
 * @property {number} keyIntensity
 * @property {number} spot         focal spot intensity (candela)
 * @property {number} fill         fill light intensity
 * @property {number} hemi         hemisphere light intensity
 * @property {number} env          scene.environmentIntensity
 * @property {number} exposure     renderer.toneMappingExposure
 */

/** @type {Readonly<Record<string, Readonly<MoodPreset>>>} */
export const MOODS = Object.freeze({
  play: Object.freeze({ key: '#ffdcb0', keyIntensity: 2.1, spot: 70, fill: 0.28, hemi: 0.18, env: 0.55, exposure: 0.95 }),
  paused: Object.freeze({ key: '#ffb072', keyIntensity: 1.3, spot: 40, fill: 0.12, hemi: 0.1, env: 0.35, exposure: 0.82 }),
  study: Object.freeze({ key: '#ffe6c4', keyIntensity: 1.9, spot: 60, fill: 0.36, hemi: 0.2, env: 0.55, exposure: 0.93 }),
  victory: Object.freeze({ key: '#ffcf86', keyIntensity: 2.5, spot: 95, fill: 0.2, hemi: 0.22, env: 0.6, exposure: 1.02 }),
});

export const DEFAULT_MOOD = 'play';
export const DEFAULT_MOOD_DURATION_MS = 600;

/** Half-extent of the key light's orthographic shadow frustum (covers the 34×24 table). */
const SHADOW_HALF_EXTENT = 18;

/**
 * @typedef {object} LightingState
 * @property {THREE.Color} keyColor
 * @property {number} keyIntensity
 * @property {number} spot
 * @property {number} fill
 * @property {number} hemi
 * @property {number} env
 * @property {number} exposure
 */

export class Lighting {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {{ ibl?: boolean, shadowMapSize?: number }} [options]
   */
  constructor(scene, renderer, { ibl = true, shadowMapSize = 2048 } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    const play = MOODS[DEFAULT_MOOD];

    // Key: high, front-right, the only shadow caster.
    this.key = new THREE.DirectionalLight(new THREE.Color(play.key), play.keyIntensity);
    this.key.name = 'keyLight';
    this.key.position.set(8, 16, 6);
    this.key.target.position.set(0, 0, 0);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    const shadowCam = this.key.shadow.camera;
    shadowCam.left = -SHADOW_HALF_EXTENT;
    shadowCam.right = SHADOW_HALF_EXTENT;
    shadowCam.top = SHADOW_HALF_EXTENT;
    shadowCam.bottom = -SHADOW_HALF_EXTENT;
    shadowCam.near = 1;
    shadowCam.far = 60;
    shadowCam.updateProjectionMatrix();

    // Focal spot: a reading-lamp pool on the board so the periphery can fall darker.
    this.spot = new THREE.SpotLight(0xffe2be, play.spot, 42, 0.62, 0.7, 1.6);
    this.spot.name = 'boardSpot';
    this.spot.position.set(0, 15, 3.5);
    this.spot.target.position.set(0, 0, 0);
    this.spot.castShadow = false;

    // Fill: faint, cool, from the lattice-window side.
    this.fill = new THREE.DirectionalLight(0xb9c8ff, play.fill);
    this.fill.name = 'fillLight';
    this.fill.position.set(-10, 9, -6);
    this.fill.castShadow = false;

    // Hemisphere: a whisper of warm bounce, dark wood floor below.
    this.hemi = new THREE.HemisphereLight(0xffe3c8, 0x2a1c12, play.hemi);
    this.hemi.name = 'hemisphereLight';
    this.hemi.position.set(0, 20, 0);

    scene.add(this.key, this.key.target, this.spot, this.spot.target, this.fill, this.fill.target, this.hemi);

    /** @type {THREE.WebGLRenderTarget | null} */
    this._envTarget = null;
    /** Multiplier on the preset env intensity (HDRIs differ in brightness from the built-in room). */
    this._envScale = 1;
    if (ibl) this._buildEnvironment();
    scene.environmentIntensity = ibl ? play.env : 0;
    this._ibl = ibl;

    /** @type {Map<string, THREE.Color>} */
    this._presetColors = new Map();
    for (const [name, preset] of Object.entries(MOODS)) this._presetColors.set(name, new THREE.Color(preset.key));

    this.renderer.toneMappingExposure = play.exposure;

    this._mood = DEFAULT_MOOD;
    /** @type {LightingState} */
    this._from = this._snapshot();
    /** @type {LightingState} */
    this._to = this._snapshot();
    this._elapsed = 0;
    this._duration = 0;
  }

  /** Name of the mood currently targeted (set immediately by `setMood`). */
  get mood() {
    return this._mood;
  }

  /** True while a mood cross-fade is still in progress. */
  get isTransitioning() {
    return this._elapsed < this._duration;
  }

  /**
   * Cross-fade the rig toward a mood preset over `duration` milliseconds
   * (0 applies instantly). Re-targeting mid-fade starts from the live values.
   * @param {'play' | 'paused' | 'victory' | 'study'} mood
   * @param {{ duration?: number }} [options]
   */
  setMood(mood, { duration = DEFAULT_MOOD_DURATION_MS } = {}) {
    const preset = MOODS[mood];
    if (!preset) throw new Error(`Lighting: unknown mood "${mood}"`);
    if (mood === this._mood && !this.isTransitioning) return;

    this._mood = mood;
    this._from = this._snapshot();
    this._to = {
      keyColor: /** @type {THREE.Color} */ (this._presetColors.get(mood)).clone(),
      keyIntensity: preset.keyIntensity,
      spot: preset.spot,
      fill: preset.fill,
      hemi: preset.hemi,
      env: this._ibl ? preset.env * this._envScale : 0,
      exposure: preset.exposure,
    };
    this._elapsed = 0;
    this._duration = Math.max(duration, 0) / 1000;

    if (this._duration === 0) this._apply(this._to);
  }

  /**
   * Advance the mood cross-fade.
   * @param {number} dt seconds since last frame
   */
  update(dt) {
    if (!this.isTransitioning) return;

    this._elapsed = Math.min(this._elapsed + dt, this._duration);
    const k = smoothstep(clamp01(this._elapsed / this._duration));
    const a = this._from;
    const b = this._to;

    this.key.color.lerpColors(a.keyColor, b.keyColor, k);
    this.key.intensity = lerp(a.keyIntensity, b.keyIntensity, k);
    this.spot.intensity = lerp(a.spot, b.spot, k);
    this.fill.intensity = lerp(a.fill, b.fill, k);
    this.hemi.intensity = lerp(a.hemi, b.hemi, k);
    this.scene.environmentIntensity = lerp(a.env, b.env, k);
    this.renderer.toneMappingExposure = lerp(a.exposure, b.exposure, k);
  }

  /**
   * Set the world-space point the key light aims at (default origin), e.g. to
   * tighten shadows on the board.
   * @param {number} x @param {number} y @param {number} z
   */
  setKeyTarget(x, y, z) {
    this.key.target.position.set(x, y, z);
    this.key.target.updateMatrixWorld();
  }

  /**
   * Replace the environment with a photographed HDRI (equirectangular texture,
   * e.g. from RGBELoader). The PMREM pre-filter runs here; the source texture
   * is disposed afterwards. `intensityScale` compensates for HDRIs that are
   * brighter or dimmer than the built-in study environment.
   * @param {THREE.Texture} equirect
   * @param {{ intensityScale?: number }} [options]
   */
  setEnvironmentTexture(equirect, { intensityScale = 1 } = {}) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    let target;
    try {
      target = pmrem.fromEquirectangular(equirect);
    } finally {
      pmrem.dispose();
      equirect.dispose();
    }
    if (this._envTarget) this._envTarget.dispose();
    this._envTarget = target;
    this.scene.environment = target.texture;
    this._envScale = intensityScale;
    this._ibl = true;
    const preset = MOODS[this._mood];
    if (!this.isTransitioning) this.scene.environmentIntensity = preset.env * intensityScale;
  }

  /**
   * Re-allocate the key light's shadow map (e.g. 2048 for "high", 1024 for "low").
   * @param {number} size
   */
  setShadowMapSize(size) {
    const shadow = this.key.shadow;
    if (shadow.mapSize.x === size && shadow.mapSize.y === size) return;
    shadow.mapSize.set(size, size);
    shadow.map?.dispose();
    shadow.map = null;
  }

  dispose() {
    for (const light of [this.key, this.spot, this.fill, this.hemi]) {
      light.removeFromParent();
      light.target?.removeFromParent?.();
      light.dispose();
    }
    if (this._envTarget) {
      if (this.scene.environment === this._envTarget.texture) this.scene.environment = null;
      this._envTarget.dispose();
      this._envTarget = null;
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Pre-filter the warm study environment into a PMREM cube map for reflections. */
  _buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = buildStudyEnvironment();
    try {
      this._envTarget = pmrem.fromScene(room, 0.04);
      this.scene.environment = this._envTarget.texture;
    } finally {
      room.traverse((o) => {
        /** @type {any} */ (o).geometry?.dispose?.();
        /** @type {any} */ (o).material?.dispose?.();
      });
      pmrem.dispose();
    }
  }

  /** @returns {LightingState} */
  _snapshot() {
    return {
      keyColor: this.key.color.clone(),
      keyIntensity: this.key.intensity,
      spot: this.spot.intensity,
      fill: this.fill.intensity,
      hemi: this.hemi.intensity,
      env: this.scene.environmentIntensity,
      exposure: this.renderer.toneMappingExposure,
    };
  }

  /** @param {LightingState} state */
  _apply(state) {
    this.key.color.copy(state.keyColor);
    this.key.intensity = state.keyIntensity;
    this.spot.intensity = state.spot;
    this.fill.intensity = state.fill;
    this.hemi.intensity = state.hemi;
    this.scene.environmentIntensity = state.env;
    this.renderer.toneMappingExposure = state.exposure;
  }
}

/**
 * Small emissive-only scene for PMREM: a dark wood-toned box, a warm soft
 * ceiling panel, a cooler paper window on the left and two lantern glows, so
 * brass and lacquer reflect candle-light rather than a white studio.
 */
export function buildStudyEnvironment() {
  const scene = new THREE.Scene();
  const emissive = (color, intensity) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) });

  const shell = new THREE.Mesh(new THREE.BoxGeometry(60, 30, 54), emissive('#3a2a1e', 0.35));
  shell.material.side = THREE.BackSide;
  shell.position.y = 7;
  scene.add(shell);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 54), emissive('#4a3320', 0.5));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -7.9;
  scene.add(floor);

  const ceilingPanel = new THREE.Mesh(new THREE.PlaneGeometry(22, 14), emissive('#ffd9a8', 4.5));
  ceilingPanel.rotation.x = Math.PI / 2;
  ceilingPanel.position.set(2, 21.5, 2);
  scene.add(ceilingPanel);

  const window = new THREE.Mesh(new THREE.PlaneGeometry(7, 8), emissive('#c9d8ff', 1.6));
  window.rotation.y = Math.PI / 2;
  window.position.set(-29.5, 6, -6);
  scene.add(window);

  for (const x of [-14, 14]) {
    const lantern = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 12), emissive('#ff9a48', 6));
    lantern.position.set(x, 9.5, -12);
    scene.add(lantern);
  }
  return scene;
}

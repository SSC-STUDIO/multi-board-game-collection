/**
 * Scene owner: renderer, scene graph, main camera, clock and the frame loop.
 *
 * Frame order (see `render()`):
 *   1. `onBeforeRender` callbacks   – game engine tick, input polling
 *   2. tracked entity `update(dt, elapsed)`
 *   3. `onAfterUpdate` callbacks    – camera director, camera shake, audio listener
 *   4. `renderer.render(scene, camera)`
 *
 * The rAF loop (`_tick`) additionally runs two wall-clock governors that the
 * manual `render()` path deliberately knows nothing about: a dynamic
 * resolution scaler (`adaptiveResolution`, `resolutionScale`, `targetFps`) and
 * an idle frame cap (`idleFpsCap`, `idle`) that halves the rate after a few
 * seconds without pointer / wheel / key / touch input.
 *
 * Browser-only at runtime, but importable under Node: nothing at module top
 * level touches `window` / `document`.
 */
import * as THREE from 'three';
import { PostFX } from './PostFX.js';
import { FrameTimeController } from '../utils/FrameTimeController.js';

/** Longest simulated step per frame; hides tab-switch / debugger stalls. */
const MAX_DT_SECONDS = 0.1;

/** While nothing tweens, the shadow map is still refreshed every N frames (slow drift, breathing). */
const SHADOW_HEARTBEAT_FRAMES = 8;

/** No input on `window` for this long counts as idle (frame cap kicks in). */
const IDLE_AFTER_MS = 8000;

/**
 * rAF timestamps jitter by a fraction of a refresh interval, so the cap accepts
 * a tick slightly earlier than the nominal spacing (30 fps → ticks ≥ 30 ms apart)
 * instead of skipping to the one after and landing at 20 fps.
 */
const IDLE_CAP_TOLERANCE = 0.9;

/** Events that prove someone is at the table. Passive: they are only timestamps. */
const INPUT_EVENTS = Object.freeze(['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove']);

/** Shadow filter by quality name: PCFSoft samples the map 17×, PCF 9× (roughly 2× cheaper). */
const SHADOW_TYPES = Object.freeze({
  pcfsoft: THREE.PCFSoftShadowMap,
  pcf: THREE.PCFShadowMap,
  basic: THREE.BasicShadowMap,
});

/**
 * @typedef {{ update?: (dt: number, elapsed: number) => void, dispose?: () => void }} Updatable
 * @typedef {THREE.Object3D & Updatable} SceneObject
 * @typedef {{ group: THREE.Object3D } & Updatable} EntityLike
 * @typedef {(dt: number, elapsed: number) => void} FrameCallback
 */

/**
 * @param {SceneObject | EntityLike} item
 * @returns {THREE.Object3D}
 */
function resolveObject(item) {
  if (item && item.isObject3D) return /** @type {THREE.Object3D} */ (item);
  if (item && item.group && item.group.isObject3D) return item.group;
  throw new TypeError('World.add/remove expects a THREE.Object3D or an entity exposing `.group`');
}

export class World {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ antialias?: boolean, shadows?: boolean, maxPixelRatio?: number, background?: number }} [options]
   */
  constructor(canvas, {
    antialias = true,
    shadows = true,
    shadowType = 'pcfsoft',
    maxPixelRatio = 2,
    maxPixels = Infinity,
    background = 0x14100c,
    fog = [60, 130],
  } = {}) {
    this.canvas = canvas;
    this.maxPixelRatio = maxPixelRatio;
    /** Upper bound on drawing-buffer pixels; caps the device pixel ratio on 2K/4K screens. */
    this.maxPixels = maxPixels;
    /** Render-scale governor; owns `resolutionScale`, which `_pixelRatio()` multiplies in. */
    this._scaler = new FrameTimeController({ targetFps: 60 });

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.Fog(background, fog[0], fog[1]);

    const { width, height } = this._measure();
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 200);
    this.camera.position.set(0, 18.5, 14.2);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = SHADOW_TYPES[shadowType] ?? THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(this._pixelRatio());
    this.renderer.setSize(width, height, false);

    this.clock = new THREE.Clock(false);

    /** @type {Set<SceneObject | EntityLike>} */
    this._items = new Set();
    /** @type {Array<Updatable>} */
    this._updatables = [];
    /** @type {Set<FrameCallback>} */
    this._beforeRender = new Set();
    /** @type {Set<FrameCallback>} */
    this._afterUpdate = new Set();

    this._running = false;
    this._rafId = 0;
    this._elapsed = 0;
    this._frame = 0;
    this._shadowDirty = true;
    /** @type {PostFX | null} */
    this.postfx = null;

    /** Lower the render scale while frames run over budget, raise it again when there is headroom. */
    this.adaptiveResolution = true;
    /** Frame rate while idle (no input for 8 s); 0 disables the cap. */
    this.idleFpsCap = 30;
    /** rAF timestamp of the previous rendered frame; 0 = no valid frame-time sample available. */
    this._prevTickMs = 0;
    /** rAF timestamp of the last rendered frame (idle cap spacing). */
    this._lastRenderMs = 0;
    this._lastInputMs = typeof performance !== 'undefined' ? performance.now() : 0;

    this._tick = this._tick.bind(this);
    this._onResize = () => this.resize();
    this._onVisibility = () => {
      if (document.hidden) this._unschedule();
      else if (this._running) this._schedule();
    };
    this._onInput = () => {
      this._lastInputMs = performance.now();
    };

    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
    for (const type of INPUT_EVENTS) window.addEventListener(type, this._onInput, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(canvas);
    } else {
      this._resizeObserver = null;
    }
  }

  /** Seconds of simulated time (sum of clamped frame deltas). */
  get elapsed() {
    return this._elapsed;
  }

  /** Frames rendered since construction. */
  get frame() {
    return this._frame;
  }

  /** True between `start()` and `stop()`, even while the tab is hidden. */
  get running() {
    return this._running;
  }

  /** Frame rate the resolution scaler budgets for (default 60; budget ≈ 1.05 × 1000 / fps ms). */
  get targetFps() {
    return this._scaler.targetFps;
  }

  set targetFps(fps) {
    this._scaler.targetFps = fps;
  }

  /** Render scale in [0.6, 1] applied on top of the pixel ratio (see `_pixelRatio()`). */
  get resolutionScale() {
    return this._scaler.scale;
  }

  /** Smoothed wall-clock frame time in ms measured by the loop; 0 while warming up. */
  get frameTimeMs() {
    return this._scaler.averageMs;
  }

  /** True when there has been no pointer / wheel / key / touch input for 8 s. */
  get idle() {
    return this._isIdle(performance.now());
  }

  // -------------------------------------------------------------------------
  // scene graph
  // -------------------------------------------------------------------------

  /**
   * Add an entity (anything with `.group`) or a bare Object3D. Items exposing
   * `update(dt, elapsed)` are ticked every frame.
   * @template {SceneObject | EntityLike} T
   * @param {T} item
   * @returns {T}
   */
  add(item) {
    const object = resolveObject(item);
    this.scene.add(object);
    this._items.add(item);
    if (typeof item.update === 'function' && !this._updatables.includes(item)) {
      this._updatables.push(item);
    }
    return item;
  }

  /**
   * @template {SceneObject | EntityLike} T
   * @param {T} item
   * @returns {T}
   */
  remove(item) {
    const object = resolveObject(item);
    this.scene.remove(object);
    this._items.delete(item);
    const index = this._updatables.indexOf(item);
    if (index >= 0) this._updatables.splice(index, 1);
    return item;
  }

  // -------------------------------------------------------------------------
  // frame hooks
  // -------------------------------------------------------------------------

  /**
   * Stage 1: runs before entity updates (engine tick, input).
   * @param {FrameCallback} cb
   * @returns {() => void} unsubscribe
   */
  onBeforeRender(cb) {
    this._beforeRender.add(cb);
    return () => {
      this._beforeRender.delete(cb);
    };
  }

  /**
   * Stage 3: runs after entity updates and right before the draw call
   * (camera director, shake, audio listener sync).
   * @param {FrameCallback} cb
   * @returns {() => void} unsubscribe
   */
  onAfterUpdate(cb) {
    this._afterUpdate.add(cb);
    return () => {
      this._afterUpdate.delete(cb);
    };
  }

  // -------------------------------------------------------------------------
  // loop
  // -------------------------------------------------------------------------

  start() {
    this._running = true;
    this.resize();
    if (!document.hidden) this._schedule();
  }

  stop() {
    this._running = false;
    this._unschedule();
  }

  /**
   * Run exactly one frame. Used by the loop, but also callable manually (e.g.
   * to refresh after a resize while stopped; dt is then 0).
   */
  render() {
    const dt = Math.min(this.clock.getDelta(), MAX_DT_SECONDS);
    this._elapsed += dt;
    this._frame++;
    const elapsed = this._elapsed;

    for (const cb of this._beforeRender) cb(dt, elapsed);
    for (const item of this._updatables.slice()) item.update(dt, elapsed);
    for (const cb of this._afterUpdate) cb(dt, elapsed);

    this._scheduleShadowMap();
    if (this.postfx) {
      // Reset the stats once per frame ourselves so draw calls from every pass are counted.
      this.renderer.info.autoReset = false;
      this.renderer.info.reset();
      this.postfx.render(dt);
    } else {
      this.renderer.info.autoReset = true;
      this.renderer.render(this.scene, this.camera);
    }
  }

  /**
   * Enable the post-processing chain (MSAA target, bloom, vignette, SMAA) or
   * pass `null` to render straight to the canvas again.
   * @param {import('./PostFX.js').PostFXOptions | null} options
   */
  setPostFX(options) {
    this.postfx?.dispose();
    this.postfx = null;
    // A different chain has a different cost: the scaler starts over at full resolution.
    this._scaler.reset();
    if (options) this.postfx = new PostFX(this.renderer, this.scene, this.camera, options);
    this.resize();
  }

  /**
   * Manual render-scale override in [0.6, 1]; the scaler keeps stepping from
   * there unless `adaptiveResolution` is false. Resizes renderer and post chain.
   * @param {number} scale
   */
  setResolutionScale(scale) {
    const previous = this._scaler.scale;
    const next = this._scaler.setScale(scale);
    if (next !== previous) console.info(`[zenith] resolution scale → ${next} (manual)`);
    this.resize();
  }

  /** Force the shadow map to be re-rendered on the next frame (e.g. after moving a static prop). */
  invalidateShadows() {
    this._shadowDirty = true;
  }

  /**
   * The key light never moves and the camera does not affect a directional
   * shadow map, so the shadow pass only needs to run while an entity animates
   * (any tween active), plus a slow heartbeat for drift-style motion.
   */
  _scheduleShadowMap() {
    const shadowMap = this.renderer.shadowMap;
    if (!shadowMap.enabled) return;
    shadowMap.autoUpdate = false;
    const animating = this._updatables.some((item) => /** @type {any} */ (item).tweens?.busy);
    if (animating || this._shadowDirty || this._frame < 5 || this._frame % SHADOW_HEARTBEAT_FRAMES === 0) {
      shadowMap.needsUpdate = true;
      this._shadowDirty = false;
    }
  }

  /** Re-read the canvas CSS size and device pixel ratio. */
  resize() {
    const { width, height } = this._measure();
    const pixelRatio = this._pixelRatio();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.postfx?.setSize(width, height, pixelRatio);
  }

  /**
   * Runtime quality switch. Toggling shadow maps or their filter changes shader
   * defines, so every material in the scene is flagged for recompilation.
   * @param {{ shadows?: boolean, shadowType?: 'pcfsoft'|'pcf'|'basic', maxPixelRatio?: number, maxPixels?: number }} options
   */
  setQuality({ shadows, shadowType, maxPixelRatio, maxPixels } = {}) {
    if (typeof maxPixelRatio === 'number') this.maxPixelRatio = maxPixelRatio;
    if (typeof maxPixels === 'number') this.maxPixels = maxPixels;

    const shadowMap = this.renderer.shadowMap;
    let recompile = false;
    if (typeof shadows === 'boolean' && shadowMap.enabled !== shadows) {
      shadowMap.enabled = shadows;
      recompile = true;
    }
    const type = SHADOW_TYPES[shadowType];
    if (type !== undefined && shadowMap.type !== type) {
      shadowMap.type = type;
      recompile = true;
    }
    if (recompile) {
      shadowMap.needsUpdate = true;
      this._shadowDirty = true;
      this.scene.traverse((obj) => {
        const m = /** @type {any} */ (obj).material;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }
    // Back to full resolution with a fresh warm-up so the recompile stalls do not count.
    this._scaler.reset();
    this.resize();
  }

  /** Current drawing-buffer size and the pixel ratio actually in use (for diagnostics). */
  get renderInfo() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { width: size.x, height: size.y, pixelRatio: this.renderer.getPixelRatio(), ...this.renderer.info.render };
  }

  /** GPU name as reported by the driver (helps spot a laptop running on the integrated GPU). */
  get gpuName() {
    const gl = this.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    for (const type of INPUT_EVENTS) window.removeEventListener(type, this._onInput);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;

    this._beforeRender.clear();
    this._afterUpdate.clear();

    for (const item of this._items) {
      if (typeof item.dispose === 'function') item.dispose();
      const object = resolveObject(item);
      if (object.parent === this.scene) this.scene.remove(object);
    }
    this._items.clear();
    this._updatables.length = 0;

    this.postfx?.dispose();
    this.postfx = null;
    this.renderer.dispose();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  _schedule() {
    if (this._rafId) return;
    this.clock.start();
    this._rafId = requestAnimationFrame(this._tick);
  }

  _unschedule() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = 0;
    }
    if (this.clock.running) this.clock.stop();
  }

  /** @param {number} now rAF timestamp (ms) */
  _tick(now) {
    this._rafId = 0;
    if (!this._running) return;

    // Idle cap: skip ticks until the wall-clock spacing since the last rendered frame is long
    // enough. Nothing else happens on a skipped tick, so `clock.getDelta()` simply accumulates.
    const capped = this.idleFpsCap > 0 && this._isIdle(now);
    if (capped && now - this._lastRenderMs < (1000 / this.idleFpsCap) * IDLE_CAP_TOLERANCE) {
      this._rafId = requestAnimationFrame(this._tick);
      return;
    }

    // Frame-time sample = spacing between two consecutive, uncapped rendered frames. Capped
    // spacing reflects the cap rather than the GPU, so it is never fed to the scaler.
    if (this._prevTickMs > 0 && this.adaptiveResolution) {
      const next = this._scaler.update(now - this._prevTickMs);
      if (next !== null) {
        console.info(`[zenith] resolution scale → ${next} (avg ${this._scaler.averageMs.toFixed(1)} ms)`);
        this.resize();
      }
    }
    this._prevTickMs = capped ? 0 : now;
    this._lastRenderMs = now;

    this.render();
    if (this._running && !this._rafId) this._rafId = requestAnimationFrame(this._tick);
  }

  /** @param {number} now ms on the `performance.now()` timeline */
  _isIdle(now) {
    return now - this._lastInputMs >= IDLE_AFTER_MS;
  }

  /** Device pixel ratio clamped by both the ratio cap and the total pixel budget, times the render scale. */
  _pixelRatio() {
    const { width, height } = this._measure();
    const budgetRatio = Number.isFinite(this.maxPixels) ? Math.sqrt(this.maxPixels / Math.max(1, width * height)) : Infinity;
    return Math.max(0.5, Math.min(window.devicePixelRatio || 1, this.maxPixelRatio, budgetRatio)) * this._scaler.scale;
  }

  /** Canvas CSS size, falling back to the viewport when not laid out yet. */
  _measure() {
    const width = this.canvas.clientWidth || window.innerWidth || 1;
    const height = this.canvas.clientHeight || window.innerHeight || 1;
    return { width, height };
  }
}

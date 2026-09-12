/**
 * Raycast-based pointer interaction for the diegetic props: click detection
 * (pointerdown → pointerup within a small distance/time window), throttled hover
 * with an emissive "edge glow" and cursor feedback.
 *
 * Registered objects are raycast recursively, so registering an entity's Group
 * covers every descendant mesh; a hit on a descendant resolves to the nearest
 * registered ancestor. Pointer events are used throughout so mouse, pen and
 * touch behave identically.
 *
 * Browser-only at runtime; nothing at module top level touches the DOM.
 */
import * as THREE from 'three';

/**
 * @typedef {object} Hit
 * @property {string} id                     registration id (see Layout.INTERACTIVE)
 * @property {THREE.Object3D} object         the registered root
 * @property {THREE.Vector3} point           world-space hit point
 * @property {THREE.Intersection} intersection raw Three.js intersection (descendant mesh, face, uv…)
 * @property {PointerEvent} event
 *
 * @typedef {object} Handlers
 * @property {(hit: Hit) => void} [onClick]
 * @property {(hit: Hit) => void} [onHoverEnter]
 * @property {(hit: Hit) => void} [onHoverMove]   fired on every hover tick while hovering
 * @property {(hit: Hit) => void} [onHoverExit]   receives the last hit seen on the object
 *
 * @typedef {Handlers & { object: THREE.Object3D, id: string, glow: boolean, cursor: string }} Registration
 */

/** Warm brass emissive tint used for the hover glow. */
export const HOVER_EMISSIVE = 0x8a6a2a;
export const HOVER_EMISSIVE_INTENSITY = 0.45;

/**
 * @param {THREE.Object3D} object
 * @returns {boolean} false when the object or any ancestor is hidden
 */
function isVisibleChain(object) {
  for (let o = object; o; o = o.parent) {
    if (o.visible === false) return false;
  }
  return true;
}

/**
 * @param {THREE.Object3D} object
 * @returns {THREE.Material[]}
 */
function materialsOf(object) {
  const m = /** @type {any} */ (object).material;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

export class InteractionManager {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} domElement   the WebGL canvas
   * @param {{ hoverIntervalMs?: number, clickMaxDistancePx?: number, clickMaxMs?: number }} [options]
   */
  constructor(camera, domElement, { hoverIntervalMs = 33, clickMaxDistancePx = 6, clickMaxMs = 500 } = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.hoverIntervalMs = hoverIntervalMs;
    this.clickMaxDistancePx = clickMaxDistancePx;
    this.clickMaxMs = clickMaxMs;

    this.raycaster = new THREE.Raycaster();

    /** @type {Map<THREE.Object3D, Registration>} */
    this._registrations = new Map();
    /** @type {THREE.Object3D[]} */
    this._roots = [];

    this._enabled = true;
    this._pointer = new THREE.Vector2();
    this._pointerInside = false;
    /** @type {PointerEvent | null} */
    this._lastPointerEvent = null;
    this._lastHoverTime = -Infinity;

    /** @type {Registration | null} */
    this._hovered = null;
    /** @type {Hit | null} */
    this._hoverHit = null;
    /** @type {Map<THREE.Material, { emissive: THREE.Color, intensity: number }>} */
    this._glowBackup = new Map();
    this._baseCursor = domElement.style.cursor || '';

    /** @type {{ x: number, y: number, time: number, pointerId: number } | null} */
    this._press = null;
    /** @type {((event: PointerEvent) => void) | null} */
    this._backgroundHandler = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);

    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('pointerup', this._onPointerUp);
    domElement.addEventListener('pointerleave', this._onPointerLeave);
    domElement.addEventListener('pointercancel', this._onPointerCancel);
  }

  get enabled() {
    return this._enabled;
  }

  /** Id of the object currently under the pointer, or null. */
  get hoveredId() {
    return this._hovered ? this._hovered.id : null;
  }

  // -------------------------------------------------------------------------
  // registration
  // -------------------------------------------------------------------------

  /**
   * Make an object (and all its descendants) clickable / hoverable.
   * @param {THREE.Object3D} object
   * @param {Handlers & { id: string, glow?: boolean, cursor?: string }} options
   * @returns {() => void} unregister function
   */
  register(object, { id, glow = true, cursor = 'pointer', onClick, onHoverEnter, onHoverMove, onHoverExit } = /** @type {any} */ ({})) {
    if (!object || !object.isObject3D) throw new TypeError('InteractionManager.register expects a THREE.Object3D');
    if (!id) throw new Error('InteractionManager.register requires an id');

    this._registrations.set(object, { object, id, glow, cursor, onClick, onHoverEnter, onHoverMove, onHoverExit });
    this._roots = Array.from(this._registrations.keys());
    return () => this.unregister(object);
  }

  /**
   * Register every `entity.interactives` entry, merging per-id handlers.
   * @param {{ interactives: Array<{ object: THREE.Object3D, id: string, glow?: boolean, cursor?: string }> }} entity
   * @param {Record<string, Handlers>} [handlers]
   * @returns {() => void} unregister all
   */
  registerEntity(entity, handlers = {}) {
    const unregisters = entity.interactives.map(({ object, id, glow = true, cursor = 'pointer' }) =>
      this.register(object, { id, glow, cursor, ...(handlers[id] ?? {}) }),
    );
    return () => {
      for (const fn of unregisters) fn();
    };
  }

  /** @param {THREE.Object3D} object */
  unregister(object) {
    const reg = this._registrations.get(object);
    if (!reg) return;
    if (this._hovered === reg) this._exitHover();
    this._registrations.delete(object);
    this._roots = Array.from(this._registrations.keys());
  }

  /**
   * Disable clicks and hover (e.g. during camera flights or the victory
   * ceremony). Disabling clears any active hover glow and cursor.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    if (this._enabled === enabled) return;
    this._enabled = enabled;
    if (!enabled) {
      this._press = null;
      this._exitHover();
    }
  }

  /**
   * Called for clicks that hit none of the registered objects (the plan's
   * "escape" gesture that returns the camera to MAIN_PLAY).
   * @param {((event: PointerEvent) => void) | null} cb
   */
  setBackgroundHandler(cb) {
    this._backgroundHandler = cb;
  }

  // -------------------------------------------------------------------------
  // per frame
  // -------------------------------------------------------------------------

  /** Re-evaluate hover at most every `hoverIntervalMs` (also picks up camera motion). */
  update() {
    if (!this._enabled) return;

    if (!this._pointerInside) {
      if (this._hovered) this._exitHover();
      return;
    }

    const now = performance.now();
    if (now - this._lastHoverTime < this.hoverIntervalMs) return;
    this._lastHoverTime = now;

    const result = this._pick(this._pointer);
    const reg = result ? result.reg : null;
    const event = /** @type {PointerEvent} */ (this._lastPointerEvent);

    if (reg !== this._hovered) {
      if (this._hovered) this._exitHover();
      if (reg && result) this._enterHover(reg, this._makeHit(reg, result.intersection, event));
    } else if (reg && result) {
      this._hoverHit = this._makeHit(reg, result.intersection, event);
      reg.onHoverMove?.(this._hoverHit);
    }
  }

  /**
   * Raycast from a pointer event against the registered objects.
   * @param {PointerEvent | MouseEvent} event
   * @returns {Hit | null}
   */
  pick(event) {
    this._updatePointer(event);
    const result = this._pick(this._pointer);
    return result ? this._makeHit(result.reg, result.intersection, /** @type {PointerEvent} */ (event)) : null;
  }

  dispose() {
    const el = this.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointerleave', this._onPointerLeave);
    el.removeEventListener('pointercancel', this._onPointerCancel);
    this._exitHover();
    this._registrations.clear();
    this._roots = [];
    this._backgroundHandler = null;
    this._press = null;
  }

  // -------------------------------------------------------------------------
  // pointer events
  // -------------------------------------------------------------------------

  /** @param {PointerEvent} event */
  _onPointerDown(event) {
    if (!this._enabled || event.button !== 0 || !event.isPrimary) return;
    this._press = { x: event.clientX, y: event.clientY, time: performance.now(), pointerId: event.pointerId };
    this._trackPointer(event);
  }

  /** @param {PointerEvent} event */
  _onPointerMove(event) {
    if (!event.isPrimary) return;
    this._trackPointer(event);
  }

  /** @param {PointerEvent} event */
  _onPointerUp(event) {
    const press = this._press;
    this._press = null;
    if (!this._enabled || !press || press.pointerId !== event.pointerId || event.button !== 0) return;

    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    const maxDist = this.clickMaxDistancePx;
    if (dx * dx + dy * dy > maxDist * maxDist) return;
    if (performance.now() - press.time > this.clickMaxMs) return;

    this._trackPointer(event);
    const result = this._pick(this._pointer);
    if (result) {
      result.reg.onClick?.(this._makeHit(result.reg, result.intersection, event));
    } else {
      this._backgroundHandler?.(event);
    }
  }

  /** @param {PointerEvent} event */
  _onPointerLeave(event) {
    if (!event.isPrimary) return;
    this._pointerInside = false;
  }

  _onPointerCancel() {
    this._press = null;
    this._pointerInside = false;
  }

  /** @param {PointerEvent} event */
  _trackPointer(event) {
    this._pointerInside = true;
    this._lastPointerEvent = event;
    this._updatePointer(event);
  }

  /** @param {{ clientX: number, clientY: number }} event */
  _updatePointer(event) {
    const rect = this.domElement.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    this._pointer.set(
      ((event.clientX - rect.left) / w) * 2 - 1,
      -((event.clientY - rect.top) / h) * 2 + 1,
    );
  }

  // -------------------------------------------------------------------------
  // raycasting
  // -------------------------------------------------------------------------

  /**
   * Closest visible intersection resolved to its registered root.
   * @param {THREE.Vector2} ndc
   * @returns {{ reg: Registration, intersection: THREE.Intersection } | null}
   */
  _pick(ndc) {
    if (this._roots.length === 0) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const intersections = this.raycaster.intersectObjects(this._roots, true);
    for (const intersection of intersections) {
      if (!isVisibleChain(intersection.object)) continue;
      const reg = this._resolveRegistration(intersection.object);
      if (reg) return { reg, intersection };
    }
    return null;
  }

  /**
   * Walk up from a hit mesh to the nearest registered ancestor.
   * @param {THREE.Object3D} object
   * @returns {Registration | null}
   */
  _resolveRegistration(object) {
    for (let o = object; o; o = o.parent) {
      const reg = this._registrations.get(o);
      if (reg) return reg;
    }
    return null;
  }

  /**
   * @param {Registration} reg
   * @param {THREE.Intersection} intersection
   * @param {PointerEvent} event
   * @returns {Hit}
   */
  _makeHit(reg, intersection, event) {
    return { id: reg.id, object: reg.object, point: intersection.point.clone(), intersection, event };
  }

  // -------------------------------------------------------------------------
  // hover feedback
  // -------------------------------------------------------------------------

  /**
   * @param {Registration} reg
   * @param {Hit} hit
   */
  _enterHover(reg, hit) {
    this._hovered = reg;
    this._hoverHit = hit;
    if (reg.glow) this._applyGlow(reg.object);
    this._setCursor(reg.cursor);
    reg.onHoverEnter?.(hit);
  }

  _exitHover() {
    const reg = this._hovered;
    const hit = this._hoverHit;
    this._hovered = null;
    this._hoverHit = null;
    this._restoreGlow();
    this._setCursor(this._baseCursor);
    if (reg && hit) reg.onHoverExit?.(hit);
  }

  /**
   * Tint every emissive-capable material under the root. Materials shared with
   * unregistered meshes will glow too; entities should not share them.
   * @param {THREE.Object3D} root
   */
  _applyGlow(root) {
    root.traverse((object) => {
      for (const material of materialsOf(object)) {
        const m = /** @type {any} */ (material);
        if (!m.emissive || !m.emissive.isColor || this._glowBackup.has(material)) continue;
        this._glowBackup.set(material, { emissive: m.emissive.clone(), intensity: m.emissiveIntensity });
        m.emissive.setHex(HOVER_EMISSIVE);
        m.emissiveIntensity = HOVER_EMISSIVE_INTENSITY;
      }
    });
  }

  _restoreGlow() {
    for (const [material, backup] of this._glowBackup) {
      const m = /** @type {any} */ (material);
      m.emissive.copy(backup.emissive);
      m.emissiveIntensity = backup.intensity;
    }
    this._glowBackup.clear();
  }

  /** @param {string} cursor */
  _setCursor(cursor) {
    if (this.domElement.style.cursor !== cursor) this.domElement.style.cursor = cursor;
  }
}

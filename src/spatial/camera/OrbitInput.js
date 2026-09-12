/**
 * Free-look input for the directed camera: drag to swing around the current
 * look-at target, wheel / pinch to dolly. Feeds CameraDirector.orbitBy() and
 * zoomBy(); the director keeps the offset damped and inside its elevation band.
 *
 * Coexists with InteractionManager on the same canvas: a press only becomes a
 * drag after `dragThresholdPx`, which is the same distance InteractionManager
 * uses to reject a click, so a tap never rotates and a drag never clicks.
 *
 * Browser-only at runtime; nothing at module top level touches the DOM.
 */

/** Full-height drag ≈ this many degrees of yaw (OrbitControls uses 360). */
const DEG_PER_FULL_HEIGHT = 300;
const DEG2RAD = Math.PI / 180;

export class OrbitInput {
  /**
   * @param {HTMLElement} domElement                    the WebGL canvas
   * @param {import('./CameraDirector.js').CameraDirector} director
   * @param {{ dragThresholdPx?: number, rotateSpeed?: number, zoomSpeed?: number, enabled?: boolean }} [options]
   */
  constructor(domElement, director, { dragThresholdPx = 6, rotateSpeed = 1, zoomSpeed = 1, enabled = true } = {}) {
    this.domElement = domElement;
    this.director = director;
    this.dragThresholdPx = dragThresholdPx;
    this.rotateSpeed = rotateSpeed;
    this.zoomSpeed = zoomSpeed;
    this._enabled = enabled;

    /** @type {Map<number, { x: number, y: number, startX: number, startY: number }>} */
    this._pointers = new Map();
    this._dragging = false;
    this._pinchDistance = 0;
    /** True while a drag gesture is in progress (for consumers that want to suppress hover). */
    this.isDragging = false;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (e) => e.preventDefault();

    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('pointerup', this._onPointerUp);
    domElement.addEventListener('pointercancel', this._onPointerUp);
    domElement.addEventListener('pointerleave', this._onPointerUp);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this._onContextMenu);
  }

  get enabled() {
    return this._enabled;
  }

  /** @param {boolean} enabled */
  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (!this._enabled) this._endGesture();
  }

  dispose() {
    const el = this.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointercancel', this._onPointerUp);
    el.removeEventListener('pointerleave', this._onPointerUp);
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('contextmenu', this._onContextMenu);
    this._endGesture();
  }

  // ---------------------------------------------------------------------------

  /** @param {PointerEvent} e */
  _onPointerDown(e) {
    if (!this._enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
    if (this._pointers.size === 2) {
      this._pinchDistance = this._currentPinchDistance();
      this._dragging = true;
      this.isDragging = true;
    }
  }

  /** @param {PointerEvent} e */
  _onPointerMove(e) {
    const p = this._pointers.get(e.pointerId);
    if (!p || !this._enabled) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this._pointers.size >= 2) {
      const dist = this._currentPinchDistance();
      if (this._pinchDistance > 0 && dist > 0) this.director.zoomBy(this._pinchDistance / dist);
      this._pinchDistance = dist;
      return;
    }

    if (!this._dragging) {
      const mx = e.clientX - p.startX;
      const my = e.clientY - p.startY;
      if (mx * mx + my * my < this.dragThresholdPx * this.dragThresholdPx) return;
      this._dragging = true;
      this.isDragging = true;
      this.domElement.setPointerCapture?.(e.pointerId);
    }

    const height = this.domElement.clientHeight || 1;
    const k = (DEG_PER_FULL_HEIGHT * DEG2RAD * this.rotateSpeed) / height;
    // Drag right → scene turns right (eye moves left); drag down → eye rises.
    this.director.orbitBy(-dx * k, dy * k);
  }

  /** @param {PointerEvent} e */
  _onPointerUp(e) {
    if (!this._pointers.has(e.pointerId)) return;
    this._pointers.delete(e.pointerId);
    if (this._pointers.size === 0) this._endGesture();
    else this._pinchDistance = this._pointers.size === 2 ? this._currentPinchDistance() : 0;
  }

  /** @param {WheelEvent} e */
  _onWheel(e) {
    if (!this._enabled) return;
    e.preventDefault();
    // deltaMode 1 = lines (Firefox); normalise to roughly pixel-ish magnitudes.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.director.zoomBy(Math.pow(1.0015, delta * this.zoomSpeed));
  }

  _currentPinchDistance() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  _endGesture() {
    this._pointers.clear();
    this._dragging = false;
    this.isDragging = false;
    this._pinchDistance = 0;
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, INTERACTIVE } from '../Layout.js';
import { DynamicTexture, drawHandwriting, LATIN_HAND_FONT_STACK } from '../../utils/DynamicTexture.js';
import { createLeatherTexture, createBrushedMetalTexture } from '../../utils/ProceduralTextures.js';
import { cubicEaseInOut } from '../../utils/Easing.js';

const TEX_W = 512;
const TEX_H = 768;
const ROWS = 14;
const MOVES_PER_PAGE = ROWS * 2;
const ROW_TOP = 96;
const ROW_H = 42;
const COLS = [{ x0: 34, x1: 238 }, { x0: 274, x1: 478 }];
const TEXT_INDENT = 30;
const TEXT_SIZE = 24;
const INK_BLACK = '#1d2a6b';
const INK_WHITE = '#3d4f8f';
const PAPER = '#f6f1e3';
const PAGE_W = 2.0;
const PAGE_D = 3.0;
const UP = new THREE.Vector3(0, 1, 0);
const REST_DIR = new THREE.Vector3(-0.45, 0.08, -0.89).normalize();
const WRITE_DIR = new THREE.Vector3(0.35, 0.8, 0.5).normalize();

/** One mesh (one draw call) from several pre-placed geometries; the sources are disposed. */
function mergedMesh(geometries, material, { cast = false, receive = false } = {}) {
  const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
  for (const g of geometries) g.dispose();
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

/**
 * Leather-bound score ledger: an open spread of ruled cream paper (one
 * DynamicTexture, 2 columns × 14 rows per page) with a brass fountain pen that
 * writes each move, plus page-corner tabs for browsing history.
 */
export class ScoreLedger extends Entity {
  static ROWS_PER_PAGE = ROWS;

  /** @param {{ audio?: object }} [opts] */
  constructor({ audio } = {}) {
    super('ScoreLedger', { audio });
    const [w, h, d] = LAYOUT.LEDGER.size;
    this.size = { w, h, d };
    this.group.position.set(...LAYOUT.LEDGER.position);

    /** @type {Array<{ index: number, notation: string, player: 1|2 } | undefined>} */
    this._moves = [];
    this._page = 0;
    this._writing = null;
    this._pending = 0;
    this._queue = Promise.resolve();
    this._flipping = null;
    this._penMode = 'rest';
    this._worldPos = new THREE.Vector3();

    this._buildBinding();
    this._buildPage();
    this._buildTabs();
    this._buildPen();
    this._drawPage();
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  /** Both covers and the spine share the leather, both page blocks share their paper: one mesh each. */
  _buildBinding() {
    const { w, h, d } = this.size;
    const leather = new THREE.MeshStandardMaterial({ map: createLeatherTexture(), roughness: 0.75, metalness: 0 });
    /** Exposed so a scanned leather texture set can replace the procedural hide. */
    this.leatherMaterial = leather;
    const paper = new THREE.MeshStandardMaterial({ color: 0xefe8d6, roughness: 0.9 });
    const halfW = w / 2 - 0.05;
    const covers = [new THREE.BoxGeometry(0.14, 0.04, d).translate(0, 0.02, 0)];
    const blocks = [];
    for (const sx of [-1, 1]) {
      covers.push(new THREE.BoxGeometry(halfW, 0.06, d).translate(sx * (halfW / 2 + 0.05), 0.03, 0));
      blocks.push(new THREE.BoxGeometry(halfW - 0.12, h - 0.07, d - 0.16).translate(sx * (halfW / 2 + 0.02), 0.06 + (h - 0.07) / 2, 0));
    }
    this.group.add(mergedMesh(covers, leather, { cast: true, receive: true }), mergedMesh(blocks, paper, { cast: true, receive: true }));
  }

  _buildPage() {
    const { h } = this.size;
    this.dyn = new DynamicTexture({ width: TEX_W, height: TEX_H, background: PAPER });
    this.pagePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(PAGE_W, PAGE_D),
      new THREE.MeshStandardMaterial({ map: this.dyn.texture, roughness: 0.9, metalness: 0 }),
    );
    this.pagePlane.rotation.x = -Math.PI / 2;
    this.pagePlane.position.y = h;
    this.pagePlane.receiveShadow = true;
    this.group.add(this.pagePlane);
    this.registerInteractive(this.pagePlane, INTERACTIVE.LEDGER_PAGE, { glow: false, cursor: 'pointer' });

    this.flipPivot = new THREE.Group();
    this.flipPivot.position.y = h + 0.006;
    this.flipPivot.visible = false;
    this.group.add(this.flipPivot);
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(PAGE_W / 2 - 0.02, PAGE_D),
      new THREE.MeshStandardMaterial({ color: 0xf3ecd9, roughness: 0.9, side: THREE.DoubleSide }),
    );
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.x = PAGE_W / 4;
    sheet.castShadow = true;
    this.flipPivot.add(sheet);
  }

  /** Slightly curled triangular corner tabs: right = next page, left = previous. */
  _buildTabs() {
    const { h } = this.size;
    const mat = new THREE.MeshStandardMaterial({ color: 0xe6dcc2, roughness: 0.9, side: THREE.DoubleSide });
    for (const [sx, id] of [[1, INTERACTIVE.LEDGER_NEXT], [-1, INTERACTIVE.LEDGER_PREV]]) {
      const shape = new THREE.Shape();
      shape.moveTo(-sx * 0.16, 0);
      shape.lineTo(sx * 0.16, 0);
      shape.lineTo(sx * 0.16, -0.32);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false });
      const tab = new THREE.Mesh(geo, mat);
      // Pivot on the back edge so only the front corner lifts off the page.
      tab.rotation.x = -Math.PI / 2 - 0.45;
      tab.position.set(sx * (PAGE_W / 2 - 0.16), h + 0.004, PAGE_D / 2 - 0.3);
      tab.castShadow = true;
      this.group.add(tab);
      this.registerInteractive(tab, id, { glow: true, cursor: 'pointer' });
    }
  }

  /** Pen group origin is the nib tip; the barrel extends along +Y. */
  _buildPen() {
    const brass = new THREE.MeshStandardMaterial({ map: createBrushedMetalTexture(), roughness: 0.25, metalness: 0.95 });
    const lacquer = new THREE.MeshPhysicalMaterial({ color: 0x1b1a24, roughness: 0.25, metalness: 0.1, clearcoat: 0.6 });
    this.pen = new THREE.Group();
    // The pen moves as one rigid body, so its parts collapse to one mesh per material.
    const fittings = [
      new THREE.ConeGeometry(0.03, 0.14, 12).rotateX(Math.PI).translate(0, 0.07, 0), // nib
      new THREE.CylinderGeometry(0.04, 0.04, 0.05, 14).translate(0, 0.465, 0), // band
      new THREE.SphereGeometry(0.04, 12, 8).translate(0, 0.99, 0), // cap
      new THREE.BoxGeometry(0.02, 0.3, 0.012).translate(0, 0.8, 0.045), // clip
    ];
    const body = [
      new THREE.CylinderGeometry(0.036, 0.03, 0.3, 14).translate(0, 0.29, 0), // grip
      new THREE.CylinderGeometry(0.04, 0.04, 0.5, 14).translate(0, 0.74, 0), // barrel
    ];
    this.pen.add(mergedMesh(fittings, brass, { cast: true }), mergedMesh(body, lacquer, { cast: true }));
    this.group.add(this.pen);

    this._penRestPos = new THREE.Vector3(0.62, this.size.h + 0.045, 1.05);
    this.pen.position.copy(this._penRestPos);
    this.pen.quaternion.setFromUnitVectors(UP, REST_DIR);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get page() {
    return this._page;
  }

  get pageCount() {
    return Math.max(1, Math.ceil(this._moves.length / MOVES_PER_PAGE));
  }

  /** True while the pen is in the air or writing (a hand should be holding it). */
  get penInHand() {
    return this._penMode !== 'rest';
  }

  /**
   * World position of the pen's grip (0.3 above the nib) and the barrel
   * direction (nib → cap), for a hand that follows the pen.
   * @param {THREE.Vector3} grip
   * @param {THREE.Vector3} dir
   */
  getPenGrip(grip, dir) {
    this.pen.updateWorldMatrix(true, false);
    grip.set(0, 0.3, 0);
    this.pen.localToWorld(grip);
    dir.set(0, 1, 0).transformDirection(this.pen.matrixWorld);
    return grip;
  }

  /**
   * Record a move and write it with the pen (queued so rapid calls each animate).
   * @param {number} moveIndex zero-based
   * @param {string} notation e.g. 'H8'
   * @param {1|2} player
   * @returns {Promise<void>}
   */
  writeMove(moveIndex, notation, player) {
    this._pending++;
    const run = () => this._writeMove(moveIndex, notation, player);
    this._queue = this._queue.then(run, run);
    return this._queue;
  }

  /** Replace the whole record without animation and jump to the last page. */
  setMoves(moves) {
    this._moves = [];
    for (const m of moves ?? []) {
      if (m && Number.isInteger(m.index)) this._moves[m.index] = { index: m.index, notation: m.notation, player: m.player };
    }
    this._writing = null;
    this._page = this.pageCount - 1;
    this._drawPage();
  }

  nextPage() {
    return this._page + 1 < this.pageCount ? this._flipTo(this._page + 1) : Promise.resolve();
  }

  prevPage() {
    return this._page > 0 ? this._flipTo(this._page - 1) : Promise.resolve();
  }

  /**
   * Map a raycast hit on the page plane to the global move index under it.
   * @param {{ uv?: THREE.Vector2 }} intersection
   * @returns {number | null}
   */
  hitToMoveIndex(intersection) {
    const uv = intersection?.uv;
    if (!uv) return null;
    const px = uv.x * TEX_W;
    const py = (1 - uv.y) * TEX_H;
    const row = Math.floor((py - ROW_TOP) / ROW_H);
    if (row < 0 || row >= ROWS) return null;
    const col = COLS.findIndex((c) => px >= c.x0 && px <= c.x1);
    if (col < 0) return null;
    const idx = this._page * MOVES_PER_PAGE + col * ROWS + row;
    return this._moves[idx] ? idx : null;
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    const w = this._writing;
    if (this._penMode === 'write' && w) {
      const px = w.startPx + w.width * w.progress;
      const nib = this._canvasToLocal(px, w.baselinePy - 4, 0.015);
      this.pen.position.set(nib.x, nib.y, nib.z + Math.sin(elapsed * 60) * 0.004);
    }
  }

  dispose() {
    this.dyn.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  async _writeMove(moveIndex, notation, player) {
    // Anything recorded after this index is stale (an undo happened).
    if (this._moves.length > moveIndex) this._moves.length = moveIndex;
    this._moves[moveIndex] = { index: moveIndex, notation, player };

    const page = Math.floor(moveIndex / MOVES_PER_PAGE);
    if (page !== this._page) await this._flipTo(page);
    else this._drawPage();

    const slot = moveIndex % MOVES_PER_PAGE;
    const col = COLS[Math.floor(slot / ROWS)];
    const row = slot % ROWS;
    const text = `${moveIndex + 1}. ${notation}`;
    const { ctx } = this.dyn;
    ctx.font = `${TEXT_SIZE}px ${LATIN_HAND_FONT_STACK}`;
    const writing = {
      index: moveIndex,
      progress: 0,
      startPx: col.x0 + TEXT_INDENT,
      baselinePy: ROW_TOP + row * ROW_H + ROW_H - 12,
      width: ctx.measureText(text).width,
    };

    this._penMode = 'fly';
    await this._flyPen(this._canvasToLocal(writing.startPx, writing.baselinePy - 4, 0.015), WRITE_DIR, 200);
    this.group.getWorldPosition(this._worldPos);
    this.playSound('pen_scribble', this._worldPos);

    this._writing = writing;
    this._penMode = 'write';
    let lastPaint = 0;
    await this.tweens.add({
      duration: 450,
      ease: (t) => t,
      onUpdate: (k) => {
        writing.progress = k;
        // Repaint (and re-upload the page texture) at ~20 Hz; the final frame below is exact.
        const t = performance.now();
        if (t - lastPaint < 48) return;
        lastPaint = t;
        this._drawPage();
      },
    });
    if (this._writing === writing) this._writing = null;
    this._drawPage();

    this._pending--;
    if (this._pending <= 0) {
      this._pending = 0;
      this._penMode = 'fly';
      await this._flyPen(this._penRestPos, REST_DIR, 300);
      this._penMode = 'rest';
    }
  }

  _flyPen(toPos, toDir, duration) {
    const fromPos = this.pen.position.clone();
    const fromQ = this.pen.quaternion.clone();
    const toQ = new THREE.Quaternion().setFromUnitVectors(UP, toDir);
    return this.tweens.add({
      duration,
      ease: cubicEaseInOut,
      onUpdate: (k) => {
        this.pen.position.lerpVectors(fromPos, toPos, k);
        this.pen.position.y += Math.sin(Math.PI * k) * 0.25;
        this.pen.quaternion.slerpQuaternions(fromQ, toQ, k);
      },
    });
  }

  /** Simplified page turn: one sheet rotates about the spine; content swaps at the midpoint. */
  _flipTo(target) {
    if (this._flipping) return this._flipping.then(() => this._flipTo(target));
    const forward = target > this._page;
    this.flipPivot.rotation.z = forward ? 0 : Math.PI;
    this.flipPivot.visible = true;
    this.group.getWorldPosition(this._worldPos);
    this.playSound('parchment_flip', this._worldPos);
    let swapped = false;
    const swap = () => {
      swapped = true;
      this._page = target;
      this._drawPage();
    };
    this._flipping = this.tweens
      .add({
        duration: 400,
        ease: cubicEaseInOut,
        onUpdate: (k) => {
          this.flipPivot.rotation.z = forward ? Math.PI * k : Math.PI * (1 - k);
          if (!swapped && k >= 0.5) swap();
        },
      })
      .then(() => {
        if (!swapped) swap();
        this.flipPivot.visible = false;
        this._flipping = null;
      });
    return this._flipping;
  }

  /** Canvas pixel → group-space point on the page (`lift` above the page plane). */
  _canvasToLocal(px, py, lift = 0) {
    return new THREE.Vector3((px / TEX_W - 0.5) * PAGE_W, this.size.h + lift, (py / TEX_H - 0.5) * PAGE_D);
  }

  _drawPage() {
    const { ctx } = this.dyn;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, TEX_W, TEX_H);

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(90,130,190,0.35)';
    for (const col of COLS) {
      for (let r = 0; r <= ROWS; r++) {
        const y = ROW_TOP + r * ROW_H + 0.5;
        ctx.beginPath();
        ctx.moveTo(col.x0, y);
        ctx.lineTo(col.x1, y);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(190,80,70,0.35)';
    for (const col of COLS) {
      ctx.beginPath();
      ctx.moveTo(col.x0 + 24.5, ROW_TOP - 10);
      ctx.lineTo(col.x0 + 24.5, ROW_TOP + ROWS * ROW_H + 10);
      ctx.stroke();
    }
    const gutter = ctx.createLinearGradient(236, 0, 276, 0);
    gutter.addColorStop(0, 'rgba(0,0,0,0)');
    gutter.addColorStop(0.5, 'rgba(0,0,0,0.12)');
    gutter.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gutter;
    ctx.fillRect(236, 0, 40, TEX_H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#5a4a3a';
    ctx.font = '600 20px Georgia, "Times New Roman", serif';
    ctx.fillText(`— ${this._page + 1} —`, TEX_W / 2, 48);
    const first = this._page * MOVES_PER_PAGE + 1;
    ctx.fillStyle = '#8a7a66';
    ctx.font = 'italic 15px Georgia, "Times New Roman", serif';
    ctx.fillText(`Moves ${first} – ${first + MOVES_PER_PAGE - 1}`, TEX_W / 2, 70);

    for (let slot = 0; slot < MOVES_PER_PAGE; slot++) {
      const idx = this._page * MOVES_PER_PAGE + slot;
      const m = this._moves[idx];
      if (!m) continue;
      const col = COLS[Math.floor(slot / ROWS)];
      const row = slot % ROWS;
      const baseline = ROW_TOP + row * ROW_H + ROW_H - 12;
      const progress = this._writing && this._writing.index === idx ? this._writing.progress : 1;
      const color = m.player === 2 ? INK_WHITE : INK_BLACK;

      ctx.globalAlpha = Math.min(1, progress * 3);
      ctx.beginPath();
      ctx.arc(col.x0 + 12, baseline - 8, 5, 0, Math.PI * 2);
      if (m.player === 2) {
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = color;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      drawHandwriting(ctx, `${idx + 1}. ${m.notation}`, col.x0 + TEXT_INDENT, baseline, { size: TEXT_SIZE, color, progress });
    }
    this.dyn.markDirty();
  }
}

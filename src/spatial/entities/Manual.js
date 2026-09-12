import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, INTERACTIVE } from '../Layout.js';
import { DynamicTexture, drawInkText, drawInkChart } from '../../utils/DynamicTexture.js';
import { woodTexture, createPaperTexture } from '../../utils/ProceduralTextures.js';
import { cubicEaseInOut, cubicEaseOut, lerp, damp, clamp01 } from '../../utils/Easing.js';

// The ink layer covers most of the right page (plane aspect = TEX_W : TEX_H).
const TEX_W = 768;
const TEX_H = 2048;
const TITLE_SIZE = 88;
const TITLE_X = 680;
const TITLE_Y = 90;
const TITLE_GAP = 8;
const COMMENT_SIZE = 50;
const COMMENT_X0 = 540;
const COMMENT_STEP = 78;
const COMMENT_Y = 110;
const COMMENT_GAP = 6;
const COLUMN_CHARS = 12;
const CHART = { x: 70, y: 1700, width: 620, height: 200 };
const BRUSH_HOVER = 0.6;
const BRUSH_WRITE = 0.1;
const DIP_HIGH = 0.75;
const DIP_LOW = 0.28;

/** Split text into vertical columns of at most COLUMN_CHARS glyphs. */
function splitColumns(text) {
  const chars = Array.from(text ?? '');
  const columns = [];
  for (let i = 0; i < chars.length; i += COLUMN_CHARS) {
    columns.push({ text: chars.slice(i, i + COLUMN_CHARS).join(''), start: i, length: Math.min(COLUMN_CHARS, chars.length - i) });
  }
  return columns;
}

/** 8–12 deterministic samples wobbling around `momentum`; the last one is exact. */
function momentumSamples(momentum, seedText) {
  let seed = 7;
  for (const ch of seedText) seed = (seed * 31 + ch.codePointAt(0)) >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = 8 + Math.floor(rnd() * 5);
  const m = clamp01(momentum);
  const values = [];
  for (let i = 0; i < n - 1; i++) {
    const damping = 0.4 + 0.6 * (1 - i / (n - 1));
    values.push(Math.min(0.95, Math.max(0.05, m + (rnd() - 0.5) * 0.28 * damping)));
  }
  values.push(m);
  return values;
}

/** One mesh (one draw call) from several pre-placed geometries; the sources are disposed. */
function mergedMesh(geometries, material, { cast = false, receive = false } = {}) {
  const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
  for (const g of geometries) g.dispose();
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

/**
 * Stitched xuan-paper strategy manual lying open, with a celadon water bowl and
 * a floating bamboo brush that writes AI advice in ink on the right page.
 */
export class Manual extends Entity {
  /** @param {{ audio?: object }} [opts] */
  constructor({ audio } = {}) {
    super('Manual', { audio });
    const [w, h, d] = LAYOUT.MANUAL.size;
    this.size = { w, h, d };
    this.group.position.set(...LAYOUT.MANUAL.position);

    this.book = new THREE.Group();
    this.group.add(this.book);
    this._paper = new THREE.MeshStandardMaterial({ map: createPaperTexture(), roughness: 0.92, metalness: 0 });

    this._buildBook();
    this._buildWritingLayer();
    this._buildFlipPage();
    this._buildBowl();
    this._buildBrush();
    this.registerInteractive(this.book, INTERACTIVE.MANUAL, { glow: false, cursor: 'pointer' });

    this._gen = 0;
    this._busy = false;
    this._thinking = false;
    this._advice = null;
    this._phase = { title: 0, comment: 0, chart: 0 };
    this._brushMode = 'rest';
    this._brushRest = new THREE.Vector3(w / 4, h + BRUSH_HOVER, 0.6);
    this._brushTarget = this._brushRest.clone();
    this.brush.position.copy(this._brushRest);
    this._worldPos = new THREE.Vector3();
  }

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  _buildBook() {
    const { w, h, d } = this.size;
    const cover = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.12, 0.05, d + 0.12),
      new THREE.MeshStandardMaterial({ color: 0x2b3550, roughness: 0.85 }),
    );
    cover.position.y = 0.025;
    cover.castShadow = true;
    cover.receiveShadow = true;
    this.book.add(cover);

    // Both page blocks are static and share the paper material: one mesh.
    const pageW = w / 2 - 0.04;
    const pages = [-1, 1].map((sx) => new THREE.BoxGeometry(pageW, h - 0.05, d).translate(sx * (pageW / 2 + 0.04), 0.05 + (h - 0.05) / 2, 0));
    this.book.add(mergedMesh(pages, this._paper, { cast: true, receive: true }));

    // Seven stitches along the spine, likewise one mesh.
    const thread = new THREE.MeshStandardMaterial({ color: 0x2a1e14, roughness: 0.7 });
    const stitches = [];
    for (let i = 0; i < 7; i++) {
      stitches.push(new THREE.CylinderGeometry(0.014, 0.014, 0.32, 8).rotateZ(Math.PI / 2).translate(0, h + 0.004, -d / 2 + 0.35 + i * ((d - 0.7) / 6)));
    }
    this.book.add(mergedMesh(stitches, thread));
  }

  _buildWritingLayer() {
    const { w, h, d } = this.size;
    this.ink = new DynamicTexture({ width: TEX_W, height: TEX_H });
    const planeW = w / 2 - 0.16;
    const planeH = planeW * (TEX_H / TEX_W);
    const mat = new THREE.MeshStandardMaterial({
      map: this.ink.texture,
      transparent: true,
      roughness: 0.95,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.inkPlane = new THREE.Mesh(new THREE.PlaneGeometry(planeW, planeH), mat);
    this.inkPlane.rotation.x = -Math.PI / 2;
    this.inkPlane.position.set(w / 4 + 0.02, h + 0.005, -d / 2 + 0.2 + planeH / 2);
    this.inkPlane.receiveShadow = true;
    this.book.add(this.inkPlane);
    this._plane = { x: this.inkPlane.position.x, z: this.inkPlane.position.z, w: planeW, h: planeH };
  }

  _buildFlipPage() {
    const { w, h, d } = this.size;
    this.flipPivot = new THREE.Group();
    this.flipPivot.position.set(0, h + 0.012, 0);
    this.flipPivot.visible = false;
    this.book.add(this.flipPivot);
    const pageW = w / 2 - 0.08;
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(pageW, d - 0.1),
      new THREE.MeshStandardMaterial({ map: createPaperTexture(), roughness: 0.92, side: THREE.DoubleSide }),
    );
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.x = pageW / 2 + 0.04;
    sheet.castShadow = true;
    this.flipPivot.add(sheet);
  }

  _buildBowl() {
    const { d } = this.size;
    const profile = [
      [0, 0], [0.17, 0], [0.27, 0.05], [0.31, 0.14], [0.29, 0.22], [0.24, 0.26],
      [0.21, 0.24], [0.24, 0.16], [0.17, 0.07], [0, 0.06],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const glaze = new THREE.MeshPhysicalMaterial({
      color: 0x7fa89a, roughness: 0.15, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.15, side: THREE.DoubleSide,
    });
    this.bowl = new THREE.Mesh(new THREE.LatheGeometry(profile, 48), glaze);
    this.bowl.position.set(0.9, 0, -d / 2 - 0.55);
    this.bowl.castShadow = true;
    this.bowl.receiveShadow = true;
    this.group.add(this.bowl);

    const water = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 32),
      new THREE.MeshPhysicalMaterial({ color: 0xa9c8bf, transparent: true, opacity: 0.6, roughness: 0.02, metalness: 0 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.19;
    this.bowl.add(water);
  }

  /** Brush group origin is the tip apex; the shaft extends along +Y. */
  _buildBrush() {
    this.brush = new THREE.Group();
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.036, 0.24, 14),
      new THREE.MeshStandardMaterial({ color: 0x1a1512, roughness: 0.8 }),
    );
    tip.rotation.x = Math.PI;
    tip.position.y = 0.12;
    const ferrule = new THREE.Mesh(
      new THREE.CylinderGeometry(0.038, 0.034, 0.06, 14),
      new THREE.MeshStandardMaterial({ color: 0xb8923f, roughness: 0.3, metalness: 0.9 }),
    );
    ferrule.position.y = 0.27;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.036, 1.3, 14),
      new THREE.MeshStandardMaterial({ map: woodTexture('bamboo'), roughness: 0.5 }),
    );
    shaft.position.y = 0.89;
    for (const part of [tip, ferrule, shaft]) part.castShadow = true;
    this.brush.add(tip, ferrule, shaft);
    this.brush.rotation.set(-0.12, 0, 0.22);
    this.group.add(this.brush);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get busy() {
    return this._busy;
  }

  /** While the coach is thinking the brush hovers over the water bowl, dipping rhythmically. */
  setThinking(thinking) {
    thinking = Boolean(thinking);
    if (thinking === this._thinking) return;
    this._thinking = thinking;
    if (this._busy) return;
    if (thinking) this._runDipLoop();
    else this._restBrush();
  }

  /**
   * Flip a page, then brush the title (vertical, right), the comment (columns
   * right→left) and the momentum landscape. Calling again while busy restarts.
   * @returns {Promise<void>}
   */
  showAdvice({ title = '', comment = '', momentum = 0.5, notation = '' } = {}) {
    // Also stops a running dip loop so it cannot keep steering the brush target.
    this.tweens.cancelAll();
    const gen = ++this._gen;
    this._busy = true;
    this._thinking = false;
    this._advice = {
      title,
      comment,
      columns: splitColumns(comment),
      commentLength: Array.from(comment ?? '').length,
      notation,
      chart: momentumSamples(momentum, `${title}|${comment}`),
    };
    this._phase = { title: 0, comment: 0, chart: 0 };
    return this._runAdvice(gen);
  }

  /** Blank the page; also aborts any advice still being written so no tween outlives its data. */
  clear() {
    this._gen++;
    this.tweens.cancelAll();
    this._advice = null;
    this._phase = { title: 0, comment: 0, chart: 0 };
    this.flipPivot.visible = false;
    this.ink.clear();
    this._busy = false;
    if (this._thinking) this._runDipLoop();
    else this._restBrush();
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    const p = this.brush.position;
    const t = this._brushTarget;
    const writing = this._brushMode === 'write';
    const lateral = writing ? 18 : 9;
    p.x = damp(p.x, t.x, lateral, dt);
    p.z = damp(p.z, t.z, lateral, dt);
    let yTarget = t.y;
    if (this._brushMode === 'rest') yTarget += Math.sin(elapsed * 1.7) * 0.04;
    else if (writing) yTarget += Math.abs(Math.sin(elapsed * 22)) * 0.03;
    p.y = damp(p.y, yTarget, writing ? 24 : 8, dt);
    this.brush.rotation.z = 0.22 + Math.sin(elapsed * 1.1) * 0.03;
  }

  dispose() {
    this.ink.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  async _runAdvice(gen) {
    this.ink.clear();
    this.flipPivot.rotation.z = 0;
    this.flipPivot.visible = true;
    this.group.getWorldPosition(this._worldPos);
    this.playSound('parchment_flip', this._worldPos);
    this._brushMode = 'write';
    this._brushToCanvas(TITLE_X, TITLE_Y + TITLE_SIZE / 2, 0.45);
    await this.tweens.add({
      duration: 600,
      ease: cubicEaseInOut,
      onUpdate: (k) => {
        this.flipPivot.rotation.z = Math.PI * k;
      },
    });
    if (gen !== this._gen) return;
    this.flipPivot.visible = false;

    await this._writePhase(gen, 'title', 1200, (k) => this._followTitle(k));
    if (gen !== this._gen) return;
    await this._writePhase(gen, 'comment', 1500, (k) => this._followComment(k));
    if (gen !== this._gen) return;
    await this._writePhase(gen, 'chart', 600, (k) => this._brushToCanvas(CHART.x + CHART.width * k, CHART.y + CHART.height * (1 - this._chartValueAt(k)), BRUSH_WRITE));
    if (gen !== this._gen) return;

    this._busy = false;
    if (this._thinking) this._runDipLoop();
    else this._restBrush();
  }

  _writePhase(gen, key, duration, follow) {
    return this.tweens.add({
      duration,
      ease: (t) => t,
      onUpdate: (k) => {
        if (gen !== this._gen) return;
        this._phase[key] = k;
        follow(k);
        this._redrawThrottled(k >= 1);
      },
    });
  }

  /**
   * Ink strokes use shadowBlur on a 768×2048 canvas and every repaint re-uploads
   * ~6 MB to the GPU, so the progressive reveal is capped at ~20 repaints/s.
   */
  _redrawThrottled(force = false) {
    const t = performance.now();
    if (!force && t - (this._lastRedraw ?? 0) < 48) return;
    this._lastRedraw = t;
    this._redraw();
  }

  _redraw() {
    const a = this._advice;
    if (!a) return;
    const { ctx } = this.ink;
    const ph = this._phase;
    this.ink.clear();

    if (ph.title > 0) {
      const { height } = drawInkText(ctx, a.title, TITLE_X, TITLE_Y, {
        size: TITLE_SIZE, vertical: true, align: 'center', progress: ph.title, bleed: 4, letterSpacing: TITLE_GAP,
      });
      if (a.notation && ph.title >= 1) this._drawSeal(ctx, a.notation, TITLE_X, TITLE_Y + height + 26);
    }
    if (ph.comment > 0) {
      const revealed = ph.comment * a.commentLength;
      a.columns.forEach((col, i) => {
        const progress = clamp01((revealed - col.start) / col.length);
        if (progress <= 0) return;
        drawInkText(ctx, col.text, COMMENT_X0 - i * COMMENT_STEP, COMMENT_Y, {
          size: COMMENT_SIZE, vertical: true, align: 'center', progress, bleed: 3, letterSpacing: COMMENT_GAP, weight: 'normal',
        });
      });
    }
    if (ph.chart > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(CHART.x - 12, CHART.y - 24, (CHART.width + 24) * ph.chart, CHART.height + 48);
      ctx.clip();
      drawInkChart(ctx, a.chart, CHART);
      ctx.restore();
    }
    this.ink.markDirty();
  }

  /** Small vermilion seal carrying the coordinate, stamped under the title column. */
  _drawSeal(ctx, notation, cx, top) {
    const s = 64;
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = '#b02c22';
    ctx.shadowColor = 'rgba(176,44,34,0.6)';
    ctx.shadowBlur = 3;
    ctx.fillRect(cx - s / 2, top, s, s);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(240,220,200,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - s / 2 + 5, top + 5, s - 10, s - 10);
    ctx.fillStyle = '#f4e6d2';
    ctx.font = 'bold 26px "Times New Roman", Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(notation, cx, top + s / 2);
    ctx.restore();
  }

  _chartValueAt(k) {
    const v = this._advice?.chart;
    if (!v || v.length === 0) return 0.5;
    const f = clamp01(k) * (v.length - 1);
    const i = Math.min(v.length - 2, Math.floor(f));
    return lerp(v[i], v[i + 1], f - i);
  }

  _followTitle(k) {
    const n = Array.from(this._advice.title).length;
    if (n === 0) return;
    const idx = Math.min(n - 1, Math.floor(k * n));
    this._brushToCanvas(TITLE_X, TITLE_Y + idx * (TITLE_SIZE * 1.05 + TITLE_GAP) + TITLE_SIZE / 2, BRUSH_WRITE);
  }

  _followComment(k) {
    const a = this._advice;
    if (a.commentLength === 0) return;
    const pos = Math.min(a.commentLength - 1, Math.floor(k * a.commentLength));
    const i = Math.floor(pos / COLUMN_CHARS);
    const j = pos % COLUMN_CHARS;
    this._brushToCanvas(COMMENT_X0 - i * COMMENT_STEP, COMMENT_Y + j * (COMMENT_SIZE * 1.05 + COMMENT_GAP) + COMMENT_SIZE / 2, BRUSH_WRITE);
  }

  /** Canvas pixel → brush target above the writing plane (group space). */
  _brushToCanvas(px, py, hover) {
    const pl = this._plane;
    this._brushTarget.set(
      pl.x + (px / TEX_W - 0.5) * pl.w,
      this.size.h + hover,
      pl.z + (py / TEX_H - 0.5) * pl.h,
    );
  }

  _restBrush() {
    this._brushMode = 'rest';
    this._brushTarget.copy(this._brushRest);
  }

  _tweenTargetY(to, duration, ease) {
    const from = this._brushTarget.y;
    return this.tweens.add({
      duration,
      ease,
      onUpdate: (k) => {
        this._brushTarget.y = lerp(from, to, k);
      },
    });
  }

  async _runDipLoop() {
    const gen = ++this._gen;
    this._brushMode = 'dip';
    this._brushTarget.set(this.bowl.position.x, DIP_HIGH, this.bowl.position.z);
    await this.tweens.wait(350);
    while (this._thinking && gen === this._gen) {
      await this._tweenTargetY(DIP_LOW, 420, cubicEaseInOut);
      if (gen !== this._gen) return;
      await this.tweens.wait(250);
      if (gen !== this._gen) return;
      await this._tweenTargetY(DIP_HIGH, 500, cubicEaseOut);
      if (gen !== this._gen) return;
      await this.tweens.wait(400);
    }
    if (gen === this._gen && !this._busy) this._restBrush();
  }
}

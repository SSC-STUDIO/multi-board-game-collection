import * as THREE from 'three';
import { Entity } from './Entity.js';
import {
  LAYOUT,
  INTERACTIVE,
  BOARD_CELLS,
  CELL_SIZE,
  GRID_SPAN,
  BOARD_FRAME,
  BOARD_THICKNESS,
  BOARD_TOP_Y,
  BOARD_FULL_SIZE,
  STONE_RADIUS,
  STONE_HEIGHT,
  boardToWorld,
  worldToBoard,
} from '../Layout.js';
import { quadEaseIn, cubicEaseOut, elasticEaseOut, quadraticBezierVec3 } from '../../utils/Easing.js';
import { woodTexture, makeCanvas, canvasToTexture, createRadialGlowTexture } from '../../utils/ProceduralTextures.js';

const STAR_POINTS = [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]];
const LINE_COLOR = '#3a2410';
const HIGHLIGHT_GOLD = 0xd4a017;

const rand = (min, max) => min + Math.random() * (max - min);
const cellKey = (row, col) => `${row},${col}`;
const toVec3 = (v) => (v.isVector3 ? v.clone() : new THREE.Vector3().fromArray(v));

// ---------------------------------------------------------------------------
// Shared helpers (also used by Bowls.js / VictoryStamp.js)
// ---------------------------------------------------------------------------

/** Flattened ellipsoid stone. Origin sits at the base so Y-scaling squashes against the board. */
export function createStoneGeometry() {
  const geo = new THREE.SphereGeometry(STONE_RADIUS, 40, 20);
  geo.scale(1, STONE_HEIGHT / (STONE_RADIUS * 2), 1);
  geo.translate(0, STONE_HEIGHT / 2, 0);
  return geo;
}

/** Polished jade stone material. @param {1|2} player 1 = black, 2 = white */
export function createStoneMaterial(player) {
  if (player === 1) {
    return new THREE.MeshPhysicalMaterial({ color: 0x141414, roughness: 0.25, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15 });
  }
  return new THREE.MeshPhysicalMaterial({
    color: 0xf3efe4, roughness: 0.3, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.25,
    sheen: 0.3, sheenColor: 0xfff3dc, sheenRoughness: 0.6,
  });
}

/**
 * BoxGeometry with two material slots: 0 = top (+Y) face, 1 = the other five faces.
 * A stock BoxGeometry has one index group per face and every group is a draw call
 * even when faces share a material; moving the +Y indices to the front lets the
 * remaining faces form one contiguous group (2 draw calls instead of 6). Vertex
 * data is untouched, so the +Y UV layout is exactly that of BoxGeometry.
 */
function topAndSidesBox(width, height, depth) {
  const geo = new THREE.BoxGeometry(width, height, depth);
  const index = Array.from(geo.index.array);
  const { start, count } = geo.groups.find((g) => g.materialIndex === 2); // +Y face
  const topIndex = index.slice(start, start + count);
  const sideIndex = [...index.slice(0, start), ...index.slice(start + count)];
  geo.setIndex([...topIndex, ...sideIndex]);
  geo.clearGroups();
  geo.addGroup(0, topIndex.length, 0);
  geo.addGroup(topIndex.length, sideIndex.length, 1);
  return geo;
}

/**
 * Small CPU-driven point-cloud emitter (one draw call). Per-particle fade is
 * done through vertex colours, which works because every emitter is additive.
 *
 * `spawn(i, initial)` returns `{ pos:[x,y,z], vel:[x,y,z], life, age? , ...extra }`;
 * `behave(p, dt, t)` integrates a particle (t = normalised age). Positions are
 * in the parent's local space.
 */
export class Particles {
  constructor({ count, texture, color = 0xffffff, size = 0.25, spawn, behave = null, loops = 1 }) {
    this.count = count;
    this.spawn = spawn;
    this.behave = behave;
    this.loops = loops;
    this.base = new THREE.Color(color);
    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.material = new THREE.PointsMaterial({
      size, map: texture, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.items = Array.from({ length: count }, (_, i) => this._spawn(i, true));
    this.done = false;
    this._write();
  }

  _spawn(i, initial) {
    const p = this.spawn(i, initial);
    if (p.age == null) p.age = 0;
    p.cycles = 0;
    p.dead = false;
    return p;
  }

  update(dt) {
    if (this.done) return;
    let alive = 0;
    for (let i = 0; i < this.count; i++) {
      let p = this.items[i];
      if (p.dead) continue;
      p.age += dt;
      if (p.age >= p.life) {
        if (p.cycles + 1 >= this.loops) {
          p.dead = true;
          continue;
        }
        const cycles = p.cycles + 1;
        p = this.items[i] = this._spawn(i, false);
        p.cycles = cycles;
      }
      const t = p.age / p.life;
      if (this.behave) this.behave(p, dt, t);
      else {
        p.pos[0] += p.vel[0] * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += p.vel[2] * dt;
      }
      alive++;
    }
    this.done = alive === 0;
    this._write();
  }

  _write() {
    for (let i = 0; i < this.count; i++) {
      const p = this.items[i];
      const t = p.age / p.life;
      const a = p.dead ? 0 : Math.min(1, t / 0.12) * (1 - t);
      const o = i * 3;
      this.positions[o] = p.pos[0];
      this.positions[o + 1] = p.pos[1];
      this.positions[o + 2] = p.pos[2];
      this.colors[o] = this.base.r * a;
      this.colors[o + 1] = this.base.g * a;
      this.colors[o + 2] = this.base.b * a;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/**
 * 15×15 kaya go board with jade stones. The group stays at the world origin so
 * `boardToWorld`/`worldToBoard` can be used directly in world space.
 */
export class Board extends Entity {
  constructor({ audio } = {}) {
    super('board', { audio });

    /** @type {Map<string, { mesh: THREE.Mesh, player: 1|2, ghost: boolean, highlighted: boolean }>} */
    this.stones = new Map();
    /** @type {Particles[]} */
    this.effects = [];
    this.runes = null;
    this.hintSmoke = null;
    this.highlightActive = false;
    this.interactiveEnabled = true;

    this.stoneLayer = new THREE.Group();
    this.stoneLayer.name = 'stones';
    this.fxLayer = new THREE.Group();
    this.fxLayer.name = 'boardFx';
    this.group.add(this.stoneLayer, this.fxLayer);

    this.glowTexture = createRadialGlowTexture();
    this._buildBody();
    this._buildStoneAssets();
    this._buildHint();
  }

  _buildBody() {
    const kaya = woodTexture('kaya');
    // Sides: rotate the grain so growth rings run along the edge, a few rings tall.
    const sideTex = kaya.clone();
    sideTex.center.set(0.5, 0.5);
    sideTex.rotation = Math.PI / 2;
    sideTex.repeat.set(0.25, 1);
    const side = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.55, metalness: 0 });
    const top = new THREE.MeshStandardMaterial({ map: this._drawGridTexture(kaya.image), roughness: 0.5, metalness: 0 });

    // Material slots: [top (+Y), the other five faces] — see topAndSidesBox.
    this.surface = new THREE.Mesh(topAndSidesBox(BOARD_FULL_SIZE, BOARD_THICKNESS, BOARD_FULL_SIZE), [top, side]);
    /** Playing-surface material (grid painted into its map); exposed for scanned-wood upgrades. */
    this.topMaterial = top;
    /** Edge material shared by the other faces. */
    this.sideMaterial = side;
    const [bx, by, bz] = LAYOUT.BOARD.position;
    this.surface.position.set(bx, by + BOARD_THICKNESS / 2, bz);
    this.surface.receiveShadow = true;
    this.surface.castShadow = true;
    this.surface.name = 'boardSurface';
    this.group.add(this.surface);
    this.registerInteractive(this.surface, INTERACTIVE.BOARD, { glow: false, cursor: 'crosshair' });
  }

  /**
   * Repaint the playing surface over a different wood image (e.g. a scanned
   * hinoki photo). The grid, star points and coordinates are drawn again on top.
   * @param {CanvasImageSource} image
   * @param {number} [size] canvas resolution (defaults to the image's width, capped at 2048)
   */
  setWoodImage(image, size = Math.min(2048, /** @type {any} */ (image).naturalWidth ?? /** @type {any} */ (image).width ?? 1024)) {
    const previous = this.topMaterial.map;
    this.topMaterial.map = this._drawGridTexture(image, size);
    this.topMaterial.needsUpdate = true;
    previous?.dispose();
  }

  /** Copies the wood image and paints grid, star points and edge coordinates on top. */
  _drawGridTexture(woodCanvas, size = 1024) {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(woodCanvas, 0, 0, size, size);

    const px = size / BOARD_FULL_SIZE;
    // Canvas top ↔ −Z (row 0), canvas left ↔ −X (col 0); matches BoxGeometry +Y UVs.
    const g = (units) => (BOARD_FRAME + units) * px;
    const g0 = g(0);
    const g1 = g(GRID_SPAN);

    const line = (x1, y1, x2, y2) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    const k = size / 1024; // stroke widths were tuned at 1024 px
    ctx.strokeStyle = LINE_COLOR;
    ctx.lineCap = 'round';
    for (let i = 0; i < BOARD_CELLS; i++) {
      const p = g(i * CELL_SIZE);
      ctx.lineWidth = (i === 0 || i === BOARD_CELLS - 1 ? 3.2 : 2) * k;
      line(p, g0, p, g1);
      line(g0, p, g1, p);
    }

    ctx.fillStyle = LINE_COLOR;
    for (const [row, col] of STAR_POINTS) {
      ctx.beginPath();
      ctx.arc(g(col * CELL_SIZE), g(row * CELL_SIZE), 5.5 * k, 0, Math.PI * 2);
      ctx.fill();
    }

    // Letters A–O along the near (+Z) edge, numbers on the left with 15 at the far edge.
    const frame = BOARD_FRAME * px;
    ctx.fillStyle = 'rgba(58,36,16,0.8)';
    ctx.font = `bold ${Math.round(frame * 0.42)}px Georgia, "Times New Roman", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < BOARD_CELLS; i++) {
      const p = g(i * CELL_SIZE);
      ctx.fillText(String.fromCharCode(65 + i), p, size - frame / 2);
      ctx.fillText(String(BOARD_CELLS - i), frame / 2, p);
    }
    return canvasToTexture(canvas);
  }

  _buildStoneAssets() {
    this.stoneGeometry = createStoneGeometry();
    const base = { 1: createStoneMaterial(1), 2: createStoneMaterial(2) };
    const variant = (player, patch) => Object.assign(base[player].clone(), patch);
    const pair = (patch) => ({ 1: variant(1, patch), 2: variant(2, patch) });
    this.materials = {
      base,
      ghost: pair({ transparent: true, opacity: 0.3 }),
      hover: pair({ transparent: true, opacity: 0.35, depthWrite: false }),
      highlight: { 1: variant(1, {}), 2: variant(2, {}) },
    };
    for (const m of Object.values(this.materials.highlight)) {
      m.emissive.setHex(HIGHLIGHT_GOLD);
      m.emissiveIntensity = 0.5;
    }

    this.hover = new THREE.Mesh(this.stoneGeometry, this.materials.hover[1]);
    this.hover.visible = false;
    this.hover.name = 'hoverStone';
    this.group.add(this.hover);

    // Settled stones are drawn through one InstancedMesh per colour (one draw
    // call in every pass instead of one per stone). Stones only exist as
    // individual meshes while they animate, are ghosted or highlighted.
    /** @type {Record<1|2, THREE.InstancedMesh>} */
    this.instanced = {};
    /** @type {Record<1|2, Array<object>>} entries in instance-slot order */
    this.slots = { 1: [], 2: [] };
    for (const player of /** @type {const} */ ([1, 2])) {
      const im = new THREE.InstancedMesh(this.stoneGeometry, base[player], BOARD_CELLS * BOARD_CELLS);
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.name = `stones-${player}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.stoneLayer.add(im);
      this.instanced[player] = im;
    }
    this._m4 = new THREE.Matrix4();
  }

  _buildHint() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x5fd8cc, emissive: 0x2fb9ad, emissiveIntensity: 0.9, roughness: 0.6,
      transparent: true, opacity: 0.45, depthWrite: false,
    });
    this.hintDisc = new THREE.Mesh(new THREE.CircleGeometry(CELL_SIZE * 0.46, 40), mat);
    this.hintDisc.rotation.x = -Math.PI / 2;
    this.hintDisc.visible = false;
    this.group.add(this.hintDisc);
  }

  // ----- queries -----------------------------------------------------------

  /** @param {THREE.Vector3} point world-space hit point → `{row, col}` or null */
  pointToCell(point) {
    return worldToBoard(point.x, point.z);
  }

  /** World-space centre of a stone resting on (row, col). */
  getStoneWorldPosition(row, col) {
    const p = boardToWorld(row, col, BOARD_TOP_Y + STONE_HEIGHT / 2);
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  hasStone(row, col) {
    return this.stones.has(cellKey(row, col));
  }

  // ----- stone lifecycle ---------------------------------------------------

  _spawnStone(row, col, player) {
    const key = cellKey(row, col);
    if (this.stones.has(key)) this._destroyStone(key);
    const mesh = new THREE.Mesh(this.stoneGeometry, this.materials.base[player]);
    const p = boardToWorld(row, col, BOARD_TOP_Y);
    mesh.position.set(p.x, p.y, p.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.stoneLayer.add(mesh);
    const entry = { mesh, player, ghost: false, highlighted: false, animating: false, slot: null };
    this.stones.set(key, entry);
    if (this.hoverKey === key) this.hover.visible = false;
    return entry;
  }

  _destroyStone(key) {
    const entry = this.stones.get(key);
    if (!entry) return;
    this.stones.delete(key);
    this._releaseSlot(entry);
    entry.mesh.userData.detached = true;
    entry.mesh.removeFromParent();
  }

  /** Special looks need a real mesh; the plain look goes back into the instanced batch. */
  _applyMaterial(entry) {
    if (entry.highlighted || entry.ghost) {
      this._unbakeStone(entry);
      entry.mesh.material = (entry.highlighted ? this.materials.highlight : this.materials.ghost)[entry.player];
    } else {
      entry.mesh.material = this.materials.base[entry.player];
      this._bakeStone(entry);
    }
  }

  /** Move a settled, plain-looking stone from its own mesh into the instanced batch. */
  _bakeStone(entry) {
    if (entry.slot !== null || entry.animating || entry.ghost || entry.highlighted) return;
    const im = this.instanced[entry.player];
    const slot = im.count;
    entry.mesh.rotation.set(0, 0, 0);
    entry.mesh.scale.set(1, 1, 1);
    entry.mesh.updateMatrix();
    im.setMatrixAt(slot, entry.mesh.matrix);
    im.count = slot + 1;
    im.instanceMatrix.needsUpdate = true;
    this.slots[entry.player][slot] = entry;
    entry.slot = slot;
    entry.mesh.removeFromParent();
  }

  /** Give a batched stone its own mesh back (for animation or a special material). */
  _unbakeStone(entry) {
    if (entry.slot === null) return;
    this._releaseSlot(entry);
    this.stoneLayer.add(entry.mesh);
  }

  /** Swap-remove an instance slot; keeps the batch dense so `count` stays exact. */
  _releaseSlot(entry) {
    if (entry.slot === null) return;
    const im = this.instanced[entry.player];
    const slots = this.slots[entry.player];
    const last = im.count - 1;
    const slot = entry.slot;
    if (slot !== last) {
      const moved = slots[last];
      im.getMatrixAt(last, this._m4);
      im.setMatrixAt(slot, this._m4);
      slots[slot] = moved;
      moved.slot = slot;
    }
    slots.length = last;
    im.count = last;
    im.instanceMatrix.needsUpdate = true;
    entry.slot = null;
  }

  /**
   * Drop a stone onto the board: quadratic fall, impact sound, dust puff and a
   * squash-and-rebound. Resolves once the stone has settled.
   */
  async placeStone(row, col, player, { animate = true, dropHeight = 2.2 } = {}) {
    const entry = this._spawnStone(row, col, player);
    const { mesh } = entry;
    if (!animate) {
      this._bakeStone(entry);
      return;
    }

    entry.animating = true;
    const restY = mesh.position.y;
    mesh.position.y = restY + dropHeight;
    await this.tweens.add({
      duration: 180,
      ease: quadEaseIn,
      onUpdate: (k) => {
        if (!mesh.userData.detached) mesh.position.y = restY + dropHeight * (1 - k);
      },
    });
    if (mesh.userData.detached) return;

    mesh.position.y = restY;
    mesh.scale.set(1.1, 0.8, 1.1);
    this.playSound('stone_place', mesh.position);
    this._dustBurst(mesh.position);
    await this.tweens.add({
      duration: 170,
      ease: elasticEaseOut,
      onUpdate: (k) => {
        if (mesh.userData.detached) return;
        const sy = 0.8 + 0.2 * k;
        const sxz = 1 + (1 - sy) * 0.5;
        mesh.scale.set(sxz, sy, sxz);
      },
    });
    if (mesh.userData.detached) return;
    mesh.scale.set(1, 1, 1);
    entry.animating = false;
    this._bakeStone(entry);
  }

  _dustBurst(at) {
    const origin = [at.x, at.y + 0.03, at.z];
    this._addEffect(new Particles({
      count: 10, texture: this.glowTexture, color: 0x8c7f68, size: 0.24,
      spawn: () => {
        const a = rand(0, Math.PI * 2);
        const s = rand(1.0, 2.2);
        return {
          pos: [origin[0] + Math.cos(a) * 0.12, origin[1], origin[2] + Math.sin(a) * 0.12],
          vel: [Math.cos(a) * s, rand(0.3, 0.9), Math.sin(a) * s],
          life: rand(0.3, 0.45),
        };
      },
      behave: (p, dt) => {
        const drag = Math.max(0, 1 - 3.5 * dt);
        p.vel[0] *= drag;
        p.vel[2] *= drag;
        p.pos[0] += p.vel[0] * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += p.vel[2] * dt;
      },
    }));
  }

  /**
   * Undo animation (SPEC 2.2): golden dust halo, 3.5-unit vertical lift over
   * 200ms, then a 350ms quadratic-bezier flight into `flyTo` (bowl mouth).
   * Without `flyTo` the stone shrinks and fades in 200ms.
   */
  async removeStone(row, col, { flyTo = null, animate = true } = {}) {
    const key = cellKey(row, col);
    const entry = this.stones.get(key);
    if (!entry) return;
    this.stones.delete(key);
    const { mesh } = entry;
    mesh.userData.detached = true;
    if (!animate) {
      this._releaseSlot(entry);
      mesh.removeFromParent();
      return;
    }
    this._unbakeStone(entry);
    entry.animating = true;

    if (!flyTo) {
      const mat = mesh.material.clone();
      mat.transparent = true;
      mesh.material = mat;
      await this.tweens.add({
        duration: 200,
        ease: cubicEaseOut,
        onUpdate: (k) => {
          mesh.scale.setScalar(Math.max(0.001, 1 - k));
          mat.opacity = 1 - k;
        },
      });
      mat.dispose();
      mesh.removeFromParent();
      return;
    }

    const dest = toVec3(flyTo);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture, color: 0xffd58a, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    glow.scale.setScalar(1.5);
    this.fxLayer.add(glow);
    const follow = () => glow.position.copy(mesh.position).setY(mesh.position.y + STONE_HEIGHT / 2);

    const start = mesh.position.clone();
    const lifted = start.clone().setY(start.y + 3.5);
    await this.tweens.add({
      duration: 200,
      ease: cubicEaseOut,
      onUpdate: (k) => {
        mesh.position.lerpVectors(start, lifted, k);
        glow.material.opacity = 0.85 * k;
        follow();
      },
    });

    const p0 = lifted.toArray();
    const p2 = dest.toArray();
    const ctrl = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2 + 2.5, (p0[2] + p2[2]) / 2];
    await this.tweens.add({
      duration: 350,
      ease: (t) => t,
      onUpdate: (k) => {
        mesh.position.fromArray(quadraticBezierVec3(p0, ctrl, p2, k));
        mesh.rotation.x = k * Math.PI * 2;
        glow.material.opacity = 0.85 * (1 - k);
        follow();
      },
    });

    this.playSound('stone_bowl_clink', dest);
    glow.material.dispose();
    glow.removeFromParent();
    mesh.removeFromParent();
  }

  /** Sync with a 0/1/2 state grid without animation (only differences are touched). */
  setStones(board) {
    for (let r = 0; r < BOARD_CELLS; r++) {
      for (let c = 0; c < BOARD_CELLS; c++) {
        const want = board?.[r]?.[c] ?? 0;
        const key = cellKey(r, c);
        const have = this.stones.get(key);
        if (have && have.player === want) continue;
        if (have) this._destroyStone(key);
        if (want === 1 || want === 2) this._bakeStone(this._spawnStone(r, c, want));
      }
    }
  }

  clearStones() {
    for (const key of [...this.stones.keys()]) this._destroyStone(key);
  }

  // ----- visual states -----------------------------------------------------

  /** Translucent preview stone on an empty intersection; null hides it. */
  setHover(cell, player = 1) {
    if (!cell || !this.interactiveEnabled || this.hasStone(cell.row, cell.col)) {
      this.hover.visible = false;
      this.hoverKey = null;
      return;
    }
    const p = boardToWorld(cell.row, cell.col, BOARD_TOP_Y + 0.004);
    this.hover.position.set(p.x, p.y, p.z);
    this.hover.material = this.materials.hover[player === 2 ? 2 : 1];
    this.hover.visible = true;
    this.hoverKey = cellKey(cell.row, cell.col);
  }

  /** Stones from move `fromMoveIndex` onwards become 30% ghosts; null restores all. */
  setGhostStones(fromMoveIndex, moves = []) {
    const ghosts = new Set();
    if (fromMoveIndex != null) {
      for (const m of moves) if (m.index >= fromMoveIndex) ghosts.add(cellKey(m.row, m.col));
    }
    for (const [key, entry] of this.stones) {
      const ghost = ghosts.has(key);
      if (entry.ghost !== ghost) {
        entry.ghost = ghost;
        this._applyMaterial(entry);
      }
    }
  }

  /** Gold emissive pulse on the winning stones plus rising golden runes (SPEC 5.1 step 5). */
  highlightWinLine(cells) {
    this.clearHighlight();
    const anchors = [];
    for (const c of cells) {
      const entry = this.stones.get(cellKey(c.row, c.col));
      if (entry) {
        entry.highlighted = true;
        this._applyMaterial(entry);
      }
      anchors.push(boardToWorld(c.row, c.col, BOARD_TOP_Y + STONE_HEIGHT));
    }
    this.highlightActive = anchors.length > 0;
    if (!this.highlightActive) return;

    this.runes = this._addEffect(new Particles({
      count: 40, texture: this.glowTexture, color: 0xffcf5e, size: 0.32, loops: 3,
      spawn: (i, initial) => {
        const a = anchors[i % anchors.length];
        const life = rand(1.6, 2.2);
        const vy = rand(0.5, 1.0);
        const age = initial ? rand(0, life * 0.5) : 0;
        return {
          pos: [a.x + rand(-0.25, 0.25), a.y + rand(0, 0.2) + vy * age, a.z + rand(-0.25, 0.25)],
          vel: [0, vy, 0], life, age, phase: rand(0, Math.PI * 2), swirl: rand(0.2, 0.5),
        };
      },
      behave: (p, dt, t) => {
        const w = p.phase + t * 6;
        p.pos[0] += Math.cos(w) * p.swirl * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += Math.sin(w) * p.swirl * dt;
      },
    }));
  }

  clearHighlight() {
    for (const entry of this.stones.values()) {
      if (entry.highlighted) {
        entry.highlighted = false;
        this._applyMaterial(entry);
      }
    }
    this.highlightActive = false;
    if (this.runes) {
      this._removeEffect(this.runes);
      this.runes = null;
    }
  }

  /** Recommended move: soft teal disc plus a looping wisp of incense smoke. */
  showHint(row, col) {
    this.clearHint();
    const p = boardToWorld(row, col, BOARD_TOP_Y + 0.006);
    this.hintDisc.position.set(p.x, p.y, p.z);
    this.hintDisc.visible = true;
    this.hintSmoke = this._addEffect(new Particles({
      count: 14, texture: this.glowTexture, color: 0x3fb8ad, size: 0.55, loops: Infinity,
      spawn: (i, initial) => {
        const life = rand(1.8, 2.8);
        const vy = rand(0.35, 0.7);
        const age = initial ? rand(0, life) : 0;
        return {
          pos: [p.x + rand(-0.08, 0.08), p.y + 0.02 + vy * age, p.z + rand(-0.08, 0.08)],
          vel: [0, vy, 0], life, age, phase: rand(0, Math.PI * 2),
        };
      },
      behave: (p, dt, t) => {
        p.pos[0] += Math.sin(p.phase + t * 4) * 0.22 * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += Math.cos(p.phase * 1.3 + t * 3) * 0.18 * dt;
      },
    }));
  }

  clearHint() {
    this.hintDisc.visible = false;
    if (this.hintSmoke) {
      this._removeEffect(this.hintSmoke);
      this.hintSmoke = null;
    }
  }

  /** Visual only: disabling hides the hover preview until re-enabled. */
  setInteractive(enabled) {
    this.interactiveEnabled = enabled;
    if (!enabled) this.hover.visible = false;
  }

  // ----- effects & frame update -------------------------------------------

  _addEffect(fx) {
    this.fxLayer.add(fx.points);
    this.effects.push(fx);
    return fx;
  }

  _removeEffect(fx) {
    const i = this.effects.indexOf(fx);
    if (i >= 0) this.effects.splice(i, 1);
    fx.dispose();
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.update(dt);
      if (fx.done) {
        this.effects.splice(i, 1);
        fx.dispose();
        if (fx === this.runes) this.runes = null;
      }
    }
    if (this.highlightActive) {
      const pulse = 0.45 + 0.4 * Math.sin(elapsed * 5);
      this.materials.highlight[1].emissiveIntensity = pulse;
      this.materials.highlight[2].emissiveIntensity = pulse;
    }
    if (this.hover.visible) this.hover.material.opacity = 0.3 + 0.08 * Math.sin(elapsed * 3.5);
    if (this.hintDisc.visible) {
      const s = 1 + 0.08 * Math.sin(elapsed * 3);
      this.hintDisc.scale.set(s, s, 1);
      this.hintDisc.material.opacity = 0.35 + 0.15 * Math.sin(elapsed * 3);
    }
  }
}

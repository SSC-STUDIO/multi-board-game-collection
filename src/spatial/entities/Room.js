/**
 * Room: the study that surrounds the go table. Plaster walls over a walnut
 * wainscot, a plank floor with a woven mat under the table, a hanging landscape
 * scroll flanked by a couplet pair, lattice windows lit from outside, a
 * four-panel bamboo screen, two flickering paper lanterns and drifting dust.
 * Purely decorative: nothing here is interactive.
 *
 * Browser only at runtime (canvas textures), but the module has no top-level
 * DOM access so it can be imported under Node.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT } from '../Layout.js';
import { ValueNoise, makeCanvas, canvasToTexture, woodTexture, createPaperTexture, createRadialGlowTexture } from '../../utils/ProceduralTextures.js';
import { drawInkText, CJK_CURSIVE_FONT_STACK } from '../../utils/DynamicTexture.js';

/**
 * Room envelope. The ceiling sits well above every camera pose (MAIN_PLAY is at
 * y = 18.5) so free-look can never poke through it; CameraDirector clamps the
 * eye inside these bounds.
 */
export const ROOM = Object.freeze({ halfWidth: 30, backZ: -24, frontZ: 30, ceilingY: 23 });

// Placement constants (world units; table top is y = 0, floor is LAYOUT.FLOOR_Y).
const FLOOR_Y = LAYOUT.FLOOR_Y;
const WAINSCOT_TOP_Y = -3;
const WALL_RGB = [118, 98, 78]; // #76624e aged umber plaster (reads warm, not grey, under the key light)
const CEILING_COLOR = 0x1e150f;
const BEAM_ZS = [-17, -5, 7, 19];
const BEAM_SIZE = [0.9, 0.7]; // height, depth
const FLOOR_PLANKS = { size: [60, 54], repeat: [8, 7], tint: 0x86745f };
const FLOOR_MAT = { size: [26, 20], color: '#6b5541', repeat: [4, 3] };
const SCROLL = { x: 0, z: ROOM.backZ + 0.1, topY: 12.5, bottomY: 1, width: 4.2, rollerRadius: 0.16, rollerLength: 4.6, hookY: 14.2, swayDeg: 0.4 };
const COUPLET = { xOffset: 5.4, z: ROOM.backZ + 0.1, width: 1.1, topY: 11, bottomY: 3, upper: '棋盘方寸藏天地', lower: '黑白纵横见乾坤' };
const WINDOW = { z: -6, y: 6, width: 6, height: 7, thickness: 0.15, frameBar: 0.32, latticeBar: 0.08, cols: 4, rows: 5 };
const SCREEN = { center: [18, FLOOR_Y, -17], panels: 4, panelWidth: 3.2, panelHeight: 8, frameThickness: 0.14, stile: 0.16, railY: 1.8, zigzagDeg: 22 };
const LANTERNS = [{ position: [-14, 9.5, -12], phase: 0 }, { position: [14, 9.5, -12], phase: 2.7 }];
const LANTERN = { radius: 1.2, neck: 0.45, height: 1.8, intensity: 22, distance: 40, decay: 2, swayDeg: 1.5 };
const DUST = { count: 110, x: [-14, 14], y: [0.5, 10], z: [-10, 8], size: 0.085, rise: 0.12, opacity: 0.2 };

// --- Geometry helpers -------------------------------------------------------

/** Deterministic PRNG (Park–Miller) so the room looks identical on every load. */
function seededRandom(seed) {
  let s = seed % 2147483647;
  const next = () => (s = (s * 16807) % 2147483647) / 2147483647;
  next(); // discard the first, seed-correlated value
  return next;
}

function box(w, h, d, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** Yaw about Y, then translate: bakes a placement into the geometry so it can be merged. */
function place(geometry, [x, y, z], yaw = 0) {
  if (yaw) geometry.rotateY(yaw);
  return geometry.translate(x, y, z);
}

function mapUV(geometry, fn) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, ...fn(uv.getX(i), uv.getY(i)));
  return geometry;
}

/** One mesh (one draw call) from many pre-placed geometries; the sources are disposed. */
function mergedMesh(geometries, material, { cast = false, receive = false, name = '' } = {}) {
  const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
  for (const g of geometries) g.dispose();
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.name = name;
  return mesh;
}

/** Thin cylinder spanning two points. */
function cordGeometry(from, to, radius) {
  const dir = to.clone().sub(from);
  const geometry = new THREE.CylinderGeometry(radius, radius, dir.length(), 6);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  return geometry.translate((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
}

// --- Canvas textures --------------------------------------------------------

/** fbm blended across the four tile corners so the result wraps seamlessly (u, v in [0, 1)). */
function tileableFbm(noise, u, v, freq, octaves) {
  const s = (du, dv) => noise.fbm((u + du) * freq, (v + dv) * freq, octaves);
  return s(0, 0) * (1 - u) * (1 - v) + s(-1, 0) * u * (1 - v) + s(0, -1) * (1 - u) * v + s(-1, -1) * u * v;
}

/** Canvas of the given size filled with the centre strip of the shared xuan-paper sheet. */
function paperCanvas(paperImage, w, h) {
  const canvas = makeCanvas(w, h);
  const sw = (paperImage.height * w) / h;
  canvas.getContext('2d').drawImage(paperImage, (paperImage.width - sw) / 2, 0, sw, paperImage.height, 0, 0, w, h);
  return canvas;
}

/** Pointed ink leaf from (x, y) toward `angle`. */
function inkLeaf(ctx, x, y, angle, length, width) {
  const tx = x + Math.cos(angle) * length;
  const ty = y + Math.sin(angle) * length;
  const px = -Math.sin(angle) * width;
  const py = Math.cos(angle) * width;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo((x + tx) / 2 + px, (y + ty) / 2 + py, tx, ty);
  ctx.quadraticCurveTo((x + tx) / 2 - px, (y + ty) / 2 - py, x, y);
  ctx.fill();
}

/** Warm grey lime plaster with soft mottling and fine grit; tiles seamlessly. */
function plasterTexture() {
  const size = 512;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const noise = new ValueNoise(101);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const k = 1 + (tileableFbm(noise, u, v, 5, 3) - 0.5) * 0.26 + (tileableFbm(noise, u, v, 48, 1) - 0.5) * 0.1;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) img.data[i + c] = WALL_RGB[c] * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasToTexture(canvas);
}

/**
 * Plank floor from strips of the walnut sheet. Each row is one board with a staggered end
 * joint; it wraps around the tile edge so the grain is continuous and every seam is a real joint.
 */
function plankTexture(woodImage) {
  const size = 1024;
  const rows = 8;
  const rowH = size / rows;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(2024);
  const srcScale = woodImage.width / size;
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    const joint = Math.floor(((r * 0.37 + 0.13) % 1) * size);
    const sx = rnd() * (woodImage.width - rowH * srcScale);
    for (const dx of [joint, joint - size]) {
      ctx.save();
      ctx.translate(dx, y + rowH);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(woodImage, sx, 0, rowH * srcScale, woodImage.height, 0, 0, rowH, size);
      ctx.restore();
    }
    ctx.fillStyle = rnd() > 0.5 ? `rgba(255,225,190,${(rnd() * 0.1).toFixed(3)})` : `rgba(0,0,0,${(rnd() * 0.16).toFixed(3)})`;
    ctx.fillRect(0, y, size, rowH);
    ctx.fillStyle = 'rgba(18,10,5,0.85)';
    ctx.fillRect(0, y, size, 3);
    ctx.fillRect(joint - 1, y, 3, rowH);
    ctx.fillStyle = 'rgba(255,225,190,0.12)';
    ctx.fillRect(0, y + 3, size, 1.5);
  }
  return canvasToTexture(canvas, { repeat: FLOOR_PLANKS.repeat });
}

/** Woven rush mat: two crossed sets of fibres, an over/under checker and speckle. */
function matTexture() {
  const size = 512;
  const step = 16;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(77);
  ctx.fillStyle = FLOOR_MAT.color;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size; i += step) {
    ctx.fillStyle = `rgba(0,0,0,${(0.18 + rnd() * 0.1).toFixed(3)})`;
    ctx.fillRect(i, 0, 2, size);
    ctx.fillRect(0, i, size, 2);
    ctx.fillStyle = `rgba(255,240,210,${(0.05 + rnd() * 0.06).toFixed(3)})`;
    ctx.fillRect(i + 3, 0, 1.5, size);
    ctx.fillRect(0, i + 3, size, 1.5);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  for (let y = 0; y < size; y += step) {
    for (let x = (y / step) % 2 ? step : 0; x < size; x += step * 2) ctx.fillRect(x, y, step, step);
  }
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,235,200,0.08)';
    ctx.fillRect(rnd() * size, rnd() * size, 2, 2);
  }
  return canvasToTexture(canvas, { repeat: FLOOR_MAT.repeat });
}

/** Hanging scroll: layered ink mountains fading into mist, brocade mount, inscription and seal. */
function scrollPainting(paperImage) {
  const w = 512;
  const h = 1024;
  const pad = 26;
  const top = 64;
  const bottom = 960;
  const canvas = paperCanvas(paperImage, w, h);
  const ctx = canvas.getContext('2d');
  const noise = new ValueNoise(303);
  // [ridge base y, amplitude, frequency, ink] from the far pale range to the near dark one.
  const ranges = [
    [500, 130, 2.2, 'rgba(40,40,52,0.22)'], [610, 150, 3.0, 'rgba(36,36,48,0.4)'],
    [715, 130, 3.8, 'rgba(30,30,42,0.6)'], [820, 100, 4.6, 'rgba(24,24,34,0.82)'],
  ];
  ranges.forEach(([base, amp, freq, ink], k) => {
    ctx.beginPath();
    ctx.moveTo(pad, h);
    for (let x = pad; x <= w - pad; x += 3) {
      const u = x / w;
      const massif = noise.fbm(u * freq + k * 10, k * 3.7, 3);
      const crest = 1 - Math.abs(2 * noise.fbm(u * freq * 5 + k * 10, k * 3.7 + 50, 2) - 1);
      ctx.lineTo(x, base - amp * (Math.pow(massif, 1.5) * 1.3 + crest * 0.25));
    }
    ctx.lineTo(w - pad, h);
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill();
    const mist = ctx.createLinearGradient(0, base + 10, 0, base + 140);
    mist.addColorStop(0, 'rgba(238,228,205,0)');
    mist.addColorStop(1, 'rgba(238,228,205,0.88)');
    ctx.fillStyle = mist;
    ctx.fillRect(pad, base + 10, w - 2 * pad, h - base - 10);
  });
  ctx.fillStyle = '#5d4a33';
  for (const r of [[0, 0, w, top], [0, bottom, w, h - bottom], [0, 0, pad, h], [w - pad, 0, pad, h]]) ctx.fillRect(...r);
  ctx.strokeStyle = 'rgba(214,180,110,0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(pad - 4, top - 4, w - 2 * pad + 8, bottom - top + 8);
  drawInkText(ctx, '观棋不语真君子', w - pad - 46, top + 30, { font: CJK_CURSIVE_FONT_STACK, size: 34, vertical: true, align: 'center', weight: 'normal', color: '#26262e', bleed: 2 });
  drawInkText(ctx, '山斋主人写意', w - pad - 92, top + 46, { font: CJK_CURSIVE_FONT_STACK, size: 20, vertical: true, align: 'center', weight: 'normal', color: '#3a3a42', bleed: 1.5 });
  const sx = pad + 18;
  const sy = bottom - 46;
  ctx.fillStyle = '#b8312a';
  ctx.fillRect(sx, sy, 22, 22);
  ctx.strokeStyle = 'rgba(255,240,230,0.9)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(sx + 3, sy + 3, 16, 16);
  ctx.fillStyle = 'rgba(255,240,230,0.9)';
  ctx.fillRect(sx + 10, sy + 5, 2, 12);
  ctx.fillRect(sx + 5, sy + 10, 12, 2);
  return canvasToTexture(canvas);
}

/** Couplet strip: warm-tinted paper, thin border, one column of bold calligraphy. */
function coupletTexture(paperImage, text) {
  const w = 256;
  const h = 1024;
  const size = 88;
  const canvas = paperCanvas(paperImage, w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(214,150,110,0.32)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(120,70,40,0.5)';
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  const column = Array.from(text).length * size * 1.05;
  drawInkText(ctx, text, w / 2, (h - column) / 2, { font: CJK_CURSIVE_FONT_STACK, size, vertical: true, align: 'center', color: '#1c1a1a', bleed: 3 });
  return canvasToTexture(canvas);
}

/** Screen panel: pale ink bamboo, two stalks behind, two in front. */
function bambooTexture(paperImage) {
  const w = 512;
  const h = 1024;
  const canvas = paperCanvas(paperImage, w, h);
  const ctx = canvas.getContext('2d');
  const rnd = seededRandom(909);
  ctx.lineCap = 'round';
  for (let s = 0; s < 4; s++) {
    const near = s >= 2;
    ctx.strokeStyle = ctx.fillStyle = `rgba(30,45,35,${near ? 0.8 : 0.4})`;
    const width = near ? 11 + rnd() * 3 : 7 + rnd() * 2;
    const tilt = (rnd() - 0.5) * 0.3;
    const dx = Math.sin(tilt);
    const dy = -Math.cos(tilt);
    let x = 60 + rnd() * (w - 120);
    let y = h + 20;
    const nodes = [];
    while (y > -40) {
      const seg = 95 + rnd() * 50;
      const lw = width * (0.7 + 0.3 * (y / h));
      const e = lw / 2 + 1.5; // shortened at both ends so a 3px gap marks each node
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x + dx * e, y + dy * e);
      ctx.lineTo(x + dx * (seg - e), y + dy * (seg - e));
      ctx.stroke();
      x += dx * seg;
      y += dy * seg;
      nodes.push([x, y]);
    }
    const leaves = 6 + Math.floor(rnd() * 5);
    for (let i = 0; i < leaves; i++) {
      const [nx, ny] = nodes[Math.floor(rnd() * (nodes.length - 1))];
      const right = rnd() > 0.5;
      const angle = right ? 0.3 + rnd() : Math.PI - 0.3 - rnd();
      inkLeaf(ctx, nx + (right ? 4 : -4), ny + 8, angle, 60 + rnd() * 50, 10 + rnd() * 5);
    }
  }
  return canvasToTexture(canvas);
}

// --- Entity -----------------------------------------------------------------

export class Room extends Entity {
  /** @param {{ audio?: object }} [opts] */
  constructor({ audio } = {}) {
    super('room', { audio });
    /** @type {THREE.Texture[]} textures owned by this entity (shared procedural ones are not listed) */
    this._textures = [];
    this._noise = new ValueNoise(5);
    this._lacquer = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.5, metalness: 0.05 });
    this._darkWood = new THREE.MeshStandardMaterial({ map: woodTexture('blackWalnut'), color: 0xb8a898, roughness: 0.65 });
    this._cord = new THREE.MeshStandardMaterial({ color: 0x4a3a28, roughness: 0.9 });
    /** @type {Array<{ mesh: THREE.Mesh, pbr: THREE.Material, lambert: THREE.Material }>} */
    this._shell = [];
    const paperImage = createPaperTexture().image;

    this._buildShell();
    this._buildFloor();
    this._buildScroll(paperImage);
    this._buildCouplets(paperImage);
    this._buildWindows();
    this._buildScreen(paperImage);
    this._buildLanterns();
    this._buildDust();
  }

  _track(texture) {
    this._textures.push(texture);
    return texture;
  }

  /** Four plaster walls, walnut wainscot with skirting and cap rail, dark ceiling with beams. */
  _buildShell() {
    const { halfWidth: hw, backZ, frontZ, ceilingY } = ROOM;
    const height = ceilingY - FLOOR_Y;
    const midY = (ceilingY + FLOOR_Y) / 2;
    const depth = frontZ - backZ;
    const midZ = (frontZ + backZ) / 2;
    // [length, centre, yaw]; the yaw turns the plane normal (+Z) to face into the room.
    const walls = [
      [hw * 2, [0, midY, backZ], 0], [hw * 2, [0, midY, frontZ], Math.PI],
      [depth, [-hw, midY, midZ], Math.PI / 2], [depth, [hw, midY, midZ], -Math.PI / 2],
    ];
    const plaster = new THREE.MeshStandardMaterial({ map: this._track(plasterTexture()), roughness: 0.95 });
    this._shellMesh(mergedMesh(
      walls.map(([len, at, yaw]) => place(mapUV(new THREE.PlaneGeometry(len, height), (u, v) => [u * len / 10, v * height / 10]), at, yaw)),
      plaster, { receive: true, name: 'walls' },
    ));

    const panelH = WAINSCOT_TOP_Y - FLOOR_Y;
    const wainscot = new THREE.MeshStandardMaterial({ map: woodTexture('walnut'), color: 0x9a8272, roughness: 0.7 });
    const panels = [];
    const trims = [];
    for (const [len, [x, , z], yaw] of walls) {
      const inward = (d, y) => [x + Math.sin(yaw) * d, y, z + Math.cos(yaw) * d];
      panels.push(place(mapUV(box(len, panelH, 0.12), (u, v) => [u * len / 6, v]), inward(0.06, FLOOR_Y + panelH / 2), yaw));
      trims.push(place(box(len, 0.4, 0.2), inward(0.1, FLOOR_Y + 0.2), yaw));
      trims.push(place(box(len, 0.14, 0.24), inward(0.12, WAINSCOT_TOP_Y + 0.07), yaw));
    }
    this._shellMesh(mergedMesh(panels, wainscot, { receive: true, name: 'wainscot' }));
    this._shellMesh(mergedMesh(trims, this._darkWood, { receive: true, name: 'trims' }));

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, depth), new THREE.MeshStandardMaterial({ color: CEILING_COLOR, roughness: 1 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, ceilingY, midZ);
    ceiling.name = 'ceiling';
    this._shellMesh(ceiling);
    const [beamH, beamD] = BEAM_SIZE;
    const beams = BEAM_ZS.map((z) => mapUV(box(hw * 2, beamH, beamD, 0, ceilingY - beamH / 2, z), (u, v) => [u * 8, v]));
    this._shellMesh(mergedMesh(beams, this._darkWood, { receive: true, name: 'beams' }));
  }

  /** Plank floor just above the Tabletop's matte floor, and the woven mat under the table. */
  _buildFloor() {
    const [fw, fd] = FLOOR_PLANKS.size;
    const plankMap = this._track(plankTexture(woodTexture('walnut').image));
    const planks = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), new THREE.MeshStandardMaterial({ map: plankMap, color: FLOOR_PLANKS.tint, roughness: 0.8 }));
    planks.rotation.x = -Math.PI / 2;
    planks.position.set(0, FLOOR_Y + 0.01, (ROOM.frontZ + ROOM.backZ) / 2);
    planks.receiveShadow = true;
    planks.name = 'plankFloor';

    const [mw, md] = FLOOR_MAT.size;
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(mw, md), new THREE.MeshStandardMaterial({ map: this._track(matTexture()), roughness: 1 }));
    mat.rotation.x = -Math.PI / 2;
    mat.position.y = FLOOR_Y + 0.02;
    mat.receiveShadow = true;
    mat.name = 'floorMat';
    this._shellMesh(planks);
    this._shellMesh(mat);
  }

  /**
   * Add a large matte surface to the scene and prepare a Lambert twin of its
   * material. Walls, floor and ceiling cover most pixels, so skipping PBR +
   * image-based lighting on them is the cheapest big win for weak GPUs.
   */
  _shellMesh(mesh) {
    const pbr = /** @type {THREE.MeshStandardMaterial} */ (mesh.material);
    const lambert = new THREE.MeshLambertMaterial({ map: pbr.map ?? null, color: pbr.color.clone() });
    this._shell.push({ mesh, pbr, lambert });
    this.group.add(mesh);
    return mesh;
  }

  /**
   * 'pbr' (default) keeps MeshStandardMaterial with environment reflections on
   * the shell; 'lambert' swaps in the plain diffuse twins.
   * @param {'pbr' | 'lambert'} mode
   */
  setShellShading(mode) {
    for (const { mesh, pbr, lambert } of this._shell) mesh.material = mode === 'lambert' ? lambert : pbr;
  }

  /**
   * PBR + Lambert material pair of a shell mesh ('walls' | 'wainscot' | 'plankFloor' | 'floorMat' | …),
   * so scanned texture sets can be applied to both variants.
   * @returns {THREE.Material[]}
   */
  shellMaterials(name) {
    const entry = this._shell.find((s) => s.mesh.name === name);
    return entry ? [entry.pbr, entry.lambert] : [];
  }

  /** Landscape scroll on the back wall, hung from a hook so the whole thing can sway. */
  _buildScroll(paperImage) {
    const { x, z, topY, bottomY, width, rollerRadius, rollerLength, hookY } = SCROLL;
    const pivot = new THREE.Group();
    pivot.name = 'scroll';
    pivot.position.set(x, hookY, z);
    const painting = new THREE.MeshStandardMaterial({ map: this._track(scrollPainting(paperImage)), roughness: 0.95 });
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(width, topY - bottomY), painting);
    paper.position.y = (topY + bottomY) / 2 - hookY;
    paper.receiveShadow = true;
    const rollers = [topY, bottomY].map((y) =>
      new THREE.CylinderGeometry(rollerRadius, rollerRadius, rollerLength, 18).rotateZ(Math.PI / 2).translate(0, y - hookY, 0.1));
    const hook = new THREE.Vector3();
    const cords = [-1, 1].map((s) => cordGeometry(new THREE.Vector3((s * width) / 2, topY - hookY, 0.1), hook, 0.02));
    cords.push(new THREE.SphereGeometry(0.09, 10, 8));
    pivot.add(paper, mergedMesh(rollers, this._lacquer, { cast: true }), mergedMesh(cords, this._cord));
    this.group.add(pivot);
    this.scroll = pivot;
  }

  /** Upper line on the viewer's right, lower line on the left, each with short end rollers. */
  _buildCouplets(paperImage) {
    const { xOffset, z, width, topY, bottomY } = COUPLET;
    const rollers = [];
    for (const [sign, text] of [[1, COUPLET.upper], [-1, COUPLET.lower]]) {
      const material = new THREE.MeshStandardMaterial({ map: this._track(coupletTexture(paperImage, text)), roughness: 0.95 });
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(width, topY - bottomY), material);
      strip.position.set(sign * xOffset, (topY + bottomY) / 2, z);
      strip.receiveShadow = true;
      strip.name = sign > 0 ? 'coupletUpper' : 'coupletLower';
      this.group.add(strip);
      for (const y of [topY, bottomY]) {
        rollers.push(new THREE.CylinderGeometry(0.09, 0.09, width + 0.3, 14).rotateZ(Math.PI / 2).translate(sign * xOffset, y, z + 0.08));
      }
    }
    this.group.add(mergedMesh(rollers, this._lacquer, { cast: true, name: 'coupletRollers' }));
  }

  /** One lattice window per side wall; the paper glows faintly as if lit by daylight outside. */
  _buildWindows() {
    const { z, y, width: w, height: h, thickness: t, frameBar: fb, latticeBar: lb, cols, rows } = WINDOW;
    const iw = w - 2 * fb;
    const ih = h - 2 * fb;
    const frames = [];
    const papers = [];
    for (const side of [-1, 1]) {
      const at = [side * (ROOM.halfWidth - t / 2), y, z];
      const yaw = (-side * Math.PI) / 2;
      const parts = [
        box(w, fb, t, 0, h / 2 - fb / 2), box(w, fb, t, 0, -h / 2 + fb / 2),
        box(fb, ih, t, -w / 2 + fb / 2), box(fb, ih, t, w / 2 - fb / 2),
      ];
      for (let c = 1; c < cols; c++) parts.push(box(lb, ih, 0.1, -iw / 2 + (iw / cols) * c));
      for (let r = 1; r < rows; r++) parts.push(box(iw, lb, 0.1, 0, -ih / 2 + (ih / rows) * r));
      frames.push(...parts.map((g) => place(g, at, yaw)));
      papers.push(place(new THREE.PlaneGeometry(iw, ih).translate(0, 0, -0.06), at, yaw));
    }
    this.group.add(mergedMesh(frames, this._darkWood, { name: 'windowLattice' }));
    const daylight = new THREE.MeshStandardMaterial({ color: 0xfff1dc, emissive: 0xffe2b8, emissiveIntensity: 0.55, roughness: 1 });
    this.group.add(mergedMesh(papers, daylight, { name: 'windowPaper' }));
  }

  /** Four-panel zigzag screen in the right-back corner, turned toward the table. */
  _buildScreen(paperImage) {
    const { center, panels: n, panelWidth: w, panelHeight: h, frameThickness: t, stile, railY, zigzagDeg } = SCREEN;
    const fold = THREE.MathUtils.degToRad(zigzagDeg);
    const facing = Math.atan2(-center[0], -center[2]);
    const iw = w - 2 * stile;
    const boardH = railY - stile * 1.5;
    const paperH = h - railY - stile * 1.5;
    const frames = [];
    const papers = [];
    for (let i = 0; i < n; i++) {
      const px = (i - (n - 1) / 2) * w * Math.cos(fold);
      const yaw = (i % 2 ? -1 : 1) * fold;
      const local = (g) => place(place(g, [px, 0, 0], yaw), center, facing);
      frames.push(
        local(box(stile, h, t, -w / 2 + stile / 2, h / 2)), local(box(stile, h, t, w / 2 - stile / 2, h / 2)),
        local(box(iw, stile, t, 0, stile / 2)), local(box(iw, stile, t, 0, railY)), local(box(iw, stile, t, 0, h - stile / 2)),
        local(box(iw, boardH, 0.06, 0, stile + boardH / 2)),
      );
      const paper = new THREE.PlaneGeometry(iw, paperH).translate(0, railY + stile / 2 + paperH / 2, 0);
      papers.push(local(i % 2 ? mapUV(paper, (u, v) => [1 - u, v]) : paper));
    }
    this.group.add(mergedMesh(frames, this._darkWood, { cast: true, receive: true, name: 'screenFrames' }));
    const bamboo = new THREE.MeshStandardMaterial({ map: this._track(bambooTexture(paperImage)), roughness: 0.95, side: THREE.DoubleSide });
    this.group.add(mergedMesh(papers, bamboo, { cast: true, name: 'screenPanels' }));
  }

  /** Two red paper lanterns on cords from the ceiling, each with its own warm point light. */
  _buildLanterns() {
    const { radius: R, neck, height: H, intensity, distance, decay } = LANTERN;
    const radiusAt = (t) => neck + (R - neck) * Math.pow(Math.sin(Math.PI * t), 0.6);
    const profile = Array.from({ length: 13 }, (_, i) => new THREE.Vector2(radiusAt(i / 12), -H / 2 + (H * i) / 12));
    const bodyGeometry = new THREE.LatheGeometry(profile, 28);
    const silk = new THREE.MeshStandardMaterial({ color: 0xa8202a, roughness: 0.85 });

    this.lanterns = LANTERNS.map(({ position: [x, y, z], phase }, index) => {
      const pivot = new THREE.Group();
      pivot.name = `lantern${index}`;
      pivot.position.set(x, ROOM.ceilingY, z);
      const drop = ROOM.ceilingY - y;
      const material = new THREE.MeshStandardMaterial({
        color: 0xe8542a, emissive: 0xff8a3c, emissiveIntensity: 1.1, roughness: 0.9, side: THREE.DoubleSide, transparent: true, opacity: 0.95,
      });
      const body = new THREE.Mesh(bodyGeometry, material);
      body.position.y = -drop;

      const cordLength = drop - H / 2 - 0.12;
      const dark = [
        new THREE.CylinderGeometry(0.025, 0.025, cordLength, 6).translate(0, -cordLength / 2, 0),
        new THREE.CylinderGeometry(0.5, 0.55, 0.16, 20).translate(0, -drop + H / 2 + 0.04, 0),
        new THREE.CylinderGeometry(0.55, 0.5, 0.16, 20).translate(0, -drop - H / 2 - 0.04, 0),
        ...[0.2, 0.4, 0.6, 0.8].map((t) =>
          new THREE.TorusGeometry(radiusAt(t) + 0.01, 0.02, 6, 36).rotateX(Math.PI / 2).translate(0, -drop - H / 2 + H * t, 0)),
      ];
      const tassel = [
        new THREE.CylinderGeometry(0.05, 0.05, 0.35, 8).translate(0, -drop - H / 2 - 0.3, 0),
        new THREE.CylinderGeometry(0.06, 0.16, 0.7, 12).translate(0, -drop - H / 2 - 0.82, 0),
      ];
      const light = new THREE.PointLight(0xffb070, intensity, distance, decay);
      light.position.y = -drop;
      light.castShadow = false;
      pivot.add(body, mergedMesh(dark, this._lacquer), mergedMesh(tassel, silk), light);
      this.group.add(pivot);
      return { pivot, light, material, phase };
    });
  }

  /** Additive motes drifting through the lantern light above the table. */
  _buildDust() {
    const { count, x: [x0, x1], y: [y0, y1], z: [z0, z1], size, opacity } = DUST;
    const rnd = seededRandom(4242);
    this._dustBase = new Float32Array(count * 3);
    this._dustPhase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this._dustBase.set([x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0), z0 + rnd() * (z1 - z0)], i * 3);
      this._dustPhase[i] = rnd() * Math.PI * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this._dustBase.slice(), 3));
    const material = new THREE.PointsMaterial({
      map: createRadialGlowTexture(), size, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe9c8,
    });
    this.dust = new THREE.Points(geometry, material);
    this.dust.frustumCulled = false;
    this.dust.name = 'dust';
    this.group.add(this.dust);
  }

  /**
   * The two lantern point lights are the most expensive lights in the scene
   * (every PBR fragment evaluates them); low-quality tiers switch them off and
   * keep only the glowing paper.
   * @param {boolean} enabled
   */
  setLanternLights(enabled) {
    this._lanternLights = Boolean(enabled);
    for (const { light } of this.lanterns) light.visible = this._lanternLights;
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    this.scroll.rotation.z = THREE.MathUtils.degToRad(SCROLL.swayDeg) * Math.sin(elapsed * 0.6);

    const sway = THREE.MathUtils.degToRad(LANTERN.swayDeg);
    for (const { pivot, light, material, phase } of this.lanterns) {
      const flicker = this._noise.noise(elapsed * 1.6 + phase * 10, phase * 7);
      if (light.visible) light.intensity = LANTERN.intensity * (0.88 + 0.12 * flicker);
      material.emissiveIntensity = 1.1 * (0.92 + 0.08 * flicker);
      pivot.rotation.z = sway * Math.sin(elapsed * 0.31 + phase);
      pivot.rotation.x = sway * 0.6 * Math.sin(elapsed * 0.23 + phase * 1.7);
    }

    const { count, y: [y0, y1], rise } = DUST;
    const attribute = this.dust.geometry.attributes.position;
    const out = attribute.array;
    const base = this._dustBase;
    for (let i = 0; i < count; i++) {
      const p = this._dustPhase[i];
      const j = i * 3;
      base[j + 1] += dt * rise * (0.6 + 0.4 * Math.sin(p));
      if (base[j + 1] > y1) base[j + 1] = y0;
      out[j] = base[j] + Math.sin(elapsed * 0.35 + p) * 0.5;
      out[j + 1] = base[j + 1] + Math.sin(elapsed * 0.5 + p * 1.7) * 0.15;
      out[j + 2] = base[j + 2] + Math.cos(elapsed * 0.28 + p * 1.3) * 0.5;
    }
    attribute.needsUpdate = true;
  }

  dispose() {
    super.dispose();
    for (const { pbr, lambert } of this._shell) {
      pbr.dispose();
      lambert.dispose();
    }
    this._shell.length = 0;
    for (const texture of this._textures) texture.dispose();
    this._textures.length = 0;
  }
}

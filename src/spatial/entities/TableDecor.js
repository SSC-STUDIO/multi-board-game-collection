import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT } from '../Layout.js';
import {
  woodTexture,
  createPaperTexture,
  createBrushedMetalTexture,
  createRadialGlowTexture,
  makeCanvas,
  canvasToTexture,
  ValueNoise,
} from '../../utils/ProceduralTextures.js';
import { Particles } from './Board.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Placement (world units; table top is y = 0, +Z faces the viewer)
// ---------------------------------------------------------------------------

/** Lacquer tea tray centre, right-back corner. */
const TEA_TRAY_POS = [12.6, 0, -7.0];
/** Teapot, cups and towel as [x, z] offsets from the tray centre; the spout is yawed toward the cups. */
const TEAPOT_OFFSET = [-0.6, -0.4];
const TEAPOT_YAW = -0.6;
const CUP_OFFSETS = [[0.75, 0.55], [0.05, 1.15]];
const TOWEL_OFFSET = [1.9, 2.3];

/** Bronze censer centre, left-back corner; the bamboo stick holder is an [x, z] offset from it. */
const INCENSE_POS = [-12.6, 0, -7.0];
const INCENSE_TUBE_OFFSET = [2.0, -1.6];

/** Pine bonsai, right-back, well behind the clock. */
const BONSAI_POS = [9.4, 0, -9.8];

/** Thread-bound book stack, left-front. Per book (bottom → top): [yaw, dx, dz]. */
const BOOKS_POS = [-12.6, 0, 3.4];
const BOOKS = [[-6 * DEG, 0, 0], [4 * DEG, 0.06, -0.05], [-2 * DEG, -0.04, 0.04]];

/** Stool feet on the floor at both ends of the table; seat top in world Y. */
const STOOL_POSITIONS = [[0, LAYOUT.FLOOR_Y, 16.5], [0, LAYOUT.FLOOR_Y, -16.5]];
const STOOL_SEAT_TOP_Y = -2.3;

// ---------------------------------------------------------------------------
// Shapes. Lathe profiles are [radius, height] pairs traced bottom-centre →
// outer wall → rim → inner wall → floor, like Bowls.js.
// ---------------------------------------------------------------------------

const TRAY_PROFILE = [[0, 0], [2.0, 0], [2.1, 0.03], [2.1, 0.2], [2.04, 0.22], [1.96, 0.12], [0, 0.12]];
const TRAY_FLOOR = 0.12;
const POT_BODY_PROFILE = [
  [0, 0], [0.45, 0], [0.62, 0.03], [0.76, 0.12], [0.84, 0.28], [0.85, 0.45], [0.8, 0.62],
  [0.7, 0.78], [0.56, 0.9], [0.42, 0.97], [0.36, 1.0], [0, 1.0],
];
const POT_HEIGHT = 1.0;
const POT_LID_PROFILE = [
  [0, 0], [0.44, 0], [0.46, 0.03], [0.42, 0.07], [0.3, 0.13], [0.16, 0.17], [0.08, 0.19],
  [0.1, 0.24], [0.12, 0.3], [0.09, 0.35], [0, 0.37],
];
const POT_KNOB_TOP = POT_HEIGHT + 0.37;
const CUP_PROFILE = [
  [0, 0], [0.24, 0], [0.3, 0.02], [0.35, 0.12], [0.38, 0.3], [0.38, 0.4],
  [0.35, 0.4], [0.34, 0.38], [0.33, 0.14], [0.28, 0.08], [0, 0.07],
];
const CUP_TEA_Y = 0.3;
const CUP_RIM_Y = 0.4;

const BURNER_PROFILE = [
  [0, 0], [0.42, 0], [0.66, 0.05], [0.86, 0.18], [0.95, 0.4], [0.9, 0.6], [0.8, 0.76], [0.74, 0.86], [0.76, 0.9],
  [0.5, 0.9], [0.5, 0.86], [0.58, 0.72], [0.66, 0.55], [0.6, 0.44], [0, 0.42],
];
const BURNER_BASE_Y = 0.28; // body rests on three feet
const BURNER_ASH_Y = 0.52; // ash surface, relative to the body base
const BURNER_RIM_Y = 0.9;
const TUBE_PROFILE = [
  [0, 0], [0.2, 0], [0.22, 0.04], [0.22, 0.6], [0.24, 0.66], [0.22, 0.72], [0.22, 1.3], [0.18, 1.3], [0.18, 1.1], [0, 1.1],
];

const BONSAI_POT_PROFILE = [
  [0, 0], [0.62, 0], [0.8, 0.04], [0.95, 0.2], [1.0, 0.42], [0.96, 0.6], [0.9, 0.68], [0.92, 0.7],
  [0.8, 0.7], [0.78, 0.66], [0.84, 0.5], [0.8, 0.3], [0, 0.28],
];
const BONSAI_SOIL_Y = 0.6;
/** Trunk and branches: [parent segment (-1 = soil), length, base radius, tip radius, rotation xyz]. */
const BONSAI_SEGMENTS = [
  [-1, 0.5, 0.16, 0.13, [0.1, 0, 0.28]],
  [0, 0.5, 0.13, 0.11, [-0.15, 0.4, -0.45]],
  [1, 0.45, 0.11, 0.085, [0.2, 0, 0.35]],
  [2, 0.4, 0.085, 0.05, [-0.1, 0, -0.3]],
  [1, 0.7, 0.075, 0.04, [0.35, 0, 1.15]], // low branch, sweeping left
  [2, 0.6, 0.065, 0.035, [-0.4, 0, -1.2]], // upper branch, right
  [0, 0.5, 0.06, 0.035, [-0.5, 0, -1.0]], // short branch, low right
];
/** Foliage pads: [segment, position along it (0–1), radius, offset xyz]. */
const BONSAI_PADS = [
  [3, 1, 0.5, [0, 0.05, 0]],
  [4, 1, 0.62, [-0.1, 0.05, 0.05]],
  [4, 0.55, 0.48, [0.05, 0.12, -0.1]],
  [5, 1, 0.55, [0.05, 0.05, 0]],
  [6, 1, 0.5, [0.05, 0.04, 0]],
  [2, 1, 0.45, [0.25, 0.1, -0.2]],
];
/** Rocks on the soil: [x, z, radius, yaw]. */
const BONSAI_STONES = [[0.5, 0.35, 0.22, 0.6], [-0.45, -0.4, 0.17, 2.1]];

const BOOK_SIZE = [2.2, 0.26, 3.0];
const BOOK_COVERS = ['#2b3550', '#4a2b1b', '#2f4a3a']; // bottom → top
const BOOK_ATLAS = 512;
const BOOK_TITLE = '棋經十三篇';
const BOOK_FONT = '"STKaiti","KaiTi","Noto Serif CJK SC","SimSun",serif';

const STOOL_SEAT_RADIUS = 1.35;
const STOOL_SEAT_THICKNESS = 0.22;
const STOOL_LEG_TOP_R = 1.0; // leg centre radius under the seat
const STOOL_LEG_FOOT_R = 1.25; // leg centre radius on the floor (slight splay)
const STOOL_RING_Y = 1.4;
const CUSHION_PROFILE = [
  [0, 0], [1.16, 0], [1.2, 0.06], [1.2, 0.2], [1.16, 0.27], [1.05, 0.31], [0.85, 0.33], [0.4, 0.35], [0, 0.35],
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const rand = (min, max) => min + Math.random() * (max - min);

/** LatheGeometry from [radius, height] pairs. */
function lathe(profile, segments = 48) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** Merge same-material parts into one geometry (one draw call); the inputs are disposed. */
function merged(geometries) {
  const out = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  return out;
}

/** Cylinder whose axis runs from point `a` (radius `ra`) to point `b` (radius `rb`). */
function strut(a, b, ra, rb, segments = 12) {
  const from = new THREE.Vector3().fromArray(a);
  const to = new THREE.Vector3().fromArray(b);
  const axis = to.clone().sub(from);
  const geo = new THREE.CylinderGeometry(rb, ra, axis.length(), segments);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
  return geo.applyMatrix4(new THREE.Matrix4().compose(from.add(to).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
}

/** Upward-facing disc (liquid, ash, soil) at height `y`. */
function disc(radius, y, segments = 40) {
  return new THREE.CircleGeometry(radius, segments).rotateX(-Math.PI / 2).translate(0, y, 0);
}

function solid(geometry, material, { cast = true, receive = true } = {}) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

/**
 * Point each BoxGeometry face at its own atlas rectangle. `rects` holds six
 * [x0, y0, x1, y1] pixel rectangles in face order +X, -X, +Y, -Y, +Z, -Z.
 */
function remapBoxUVs(geometry, rects, size) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const [x0, y0, x1, y1] = rects[Math.floor(i / 4)];
    uv.setXY(i, (x0 + uv.getX(i) * (x1 - x0)) / size, 1 - (y1 - uv.getY(i) * (y1 - y0)) / size);
  }
  uv.needsUpdate = true;
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Non-interactive dressing for the table: a lacquer tea tray with a steaming
 * zisha pot and two celadon cups, a bronze tripod censer with a smouldering
 * incense stick, a pine bonsai, a stack of thread-bound books and a pair of
 * walnut stools with velvet cushions.
 *
 * Everything is built synchronously in the constructor. Same-material parts
 * are merged into single meshes, so the whole set costs 23 draw calls
 * (21 meshes + 2 particle systems).
 */
export class TableDecor extends Entity {
  /**
   * @param {{ audio?: { play: (name: string, opts?: object) => void },
   *           features?: { teaSet?: boolean, bonsai?: boolean, stools?: boolean, incense?: boolean, books?: boolean } }} [options]
   *   `features` lets main.js drop a procedural prop when a scanned glTF model takes its place.
   */
  constructor({ audio, features = {} } = {}) {
    super('tableDecor', { audio });
    /** @type {Particles[]} */
    this.effects = [];
    this.glowTexture = createRadialGlowTexture();
    this.walnut = woodTexture('walnut', { size: 512 });
    const on = (name) => features[name] !== false;

    if (on('teaSet')) this._buildTeaSet();
    if (on('incense')) this._buildIncense();
    if (on('bonsai')) this._buildBonsai();
    if (on('books')) this._buildBooks();
    if (on('stools')) for (const position of STOOL_POSITIONS) this._buildStool(position);
  }

  /** Attach a looping emitter to `parent`; particle positions are parent-local. */
  _addEffect(parent, fx, opacity) {
    fx.material.opacity = opacity;
    parent.add(fx.points);
    this.effects.push(fx);
    return fx;
  }

  // ----- tea set -----------------------------------------------------------

  _buildTeaSet() {
    const root = new THREE.Group();
    root.name = 'teaSet';
    root.position.fromArray(TEA_TRAY_POS);
    this.group.add(root);

    const lacquer = new THREE.MeshPhysicalMaterial({ color: 0x4a1210, roughness: 0.35, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    const zisha = new THREE.MeshStandardMaterial({ color: 0x6b3a2a, roughness: 0.55, metalness: 0 });
    const celadon = new THREE.MeshPhysicalMaterial({ color: 0x8fb8a8, roughness: 0.15, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.1 });
    const tea = new THREE.MeshPhysicalMaterial({ color: 0x5a3a16, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05 });
    const linen = new THREE.MeshStandardMaterial({ color: 0xd8cfc0, roughness: 0.95, metalness: 0 });

    root.add(solid(lathe(TRAY_PROFILE, 64), lacquer));

    // Teapot: body, domed lid with knob, curved spout and looped handle → one mesh.
    const spout = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.55, 0.3, 0), new THREE.Vector3(0.92, 0.42, 0),
      new THREE.Vector3(1.14, 0.72, 0), new THREE.Vector3(1.24, 1.02, 0),
    ]), 20, 0.09, 10, false);
    // Loop a little longer than a half ring so both ends bury themselves in the body wall.
    const handleArc = Math.PI * 1.35;
    const handle = new THREE.TorusGeometry(0.42, 0.07, 10, 28, handleArc)
      .rotateZ(Math.PI - handleArc / 2)
      .translate(-0.78, 0.55, 0);
    const pot = merged([lathe(POT_BODY_PROFILE), lathe(POT_LID_PROFILE).translate(0, POT_HEIGHT, 0), spout, handle]);
    const potMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3(TEAPOT_OFFSET[0], TRAY_FLOOR, TEAPOT_OFFSET[1]),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), TEAPOT_YAW),
      new THREE.Vector3(1, 1, 1),
    );
    root.add(solid(pot.applyMatrix4(potMatrix), zisha));

    root.add(solid(merged(CUP_OFFSETS.map(([x, z]) => lathe(CUP_PROFILE, 40).translate(x, TRAY_FLOOR, z))), celadon));
    root.add(solid(merged(CUP_OFFSETS.map(([x, z]) => disc(0.34, TRAY_FLOOR + CUP_TEA_Y).translate(x, 0, z))), tea, { cast: false }));

    // Folded tea towel on the table beside the tray.
    const towel = merged([
      new THREE.BoxGeometry(1.1, 0.06, 0.75).translate(0, 0.03, 0),
      new THREE.BoxGeometry(0.9, 0.05, 0.6).rotateY(0.12).translate(0.05, 0.085, 0.03),
    ]);
    root.add(solid(towel.rotateY(0.35).translate(TOWEL_OFFSET[0], 0, TOWEL_OFFSET[1]), linen));

    // Steam rises from the lid knob and both cups.
    const vents = [
      new THREE.Vector3(0, POT_KNOB_TOP, 0).applyMatrix4(potMatrix),
      ...CUP_OFFSETS.map(([x, z]) => new THREE.Vector3(x, TRAY_FLOOR + CUP_RIM_Y, z)),
    ];
    this._addEffect(root, new Particles({
      count: 12, texture: this.glowTexture, color: 0xffffff, size: 0.45, loops: Infinity,
      spawn: (i, initial) => {
        const v = vents[i % vents.length];
        const life = rand(1.6, 2.4);
        const vy = rand(0.35, 0.6);
        const age = initial ? rand(0, life) : 0;
        return {
          pos: [v.x + rand(-0.06, 0.06), v.y + vy * age, v.z + rand(-0.06, 0.06)],
          vel: [0, vy, 0], life, age, phase: rand(0, Math.PI * 2),
        };
      },
      behave: (p, dt, t) => {
        p.pos[0] += Math.sin(p.phase + t * 5) * 0.12 * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += Math.cos(p.phase * 1.3 + t * 4) * 0.1 * dt;
      },
    }), 0.22);
  }

  // ----- incense burner ----------------------------------------------------

  _buildIncense() {
    const root = new THREE.Group();
    root.name = 'incense';
    root.position.fromArray(INCENSE_POS);
    this.group.add(root);

    const bronze = new THREE.MeshStandardMaterial({ map: createBrushedMetalTexture({ baseColor: '#6a5a3a' }), roughness: 0.4, metalness: 0.85 });
    const ash = new THREE.MeshStandardMaterial({ color: 0xb9b3a8, roughness: 1, metalness: 0 });
    const incense = new THREE.MeshStandardMaterial({ color: 0x7b3a26, roughness: 0.9, metalness: 0 });
    const bamboo = new THREE.MeshStandardMaterial({ map: woodTexture('bamboo', { size: 256 }), roughness: 0.6, metalness: 0 });
    this.emberMaterial = new THREE.MeshStandardMaterial({ color: 0xff5a1a, emissive: 0xff5a1a, emissiveIntensity: 1.5, roughness: 0.6, metalness: 0 });

    // Censer: bulging body on three splayed feet, two upright loop ears on the lip.
    const parts = [lathe(BURNER_PROFILE, 56).translate(0, BURNER_BASE_Y, 0)];
    for (let i = 0; i < 3; i++) {
      const a = Math.PI / 2 + (i / 3) * Math.PI * 2;
      const [cx, cz] = [Math.cos(a) * 0.62, Math.sin(a) * 0.62];
      parts.push(strut([cx * 0.9, BURNER_BASE_Y + 0.08, cz * 0.9], [cx, 0, cz], 0.1, 0.13));
    }
    for (const sx of [-1, 1]) {
      parts.push(new THREE.TorusGeometry(0.13, 0.04, 8, 20, Math.PI).translate(sx * 0.63, BURNER_BASE_Y + BURNER_RIM_Y, 0));
    }
    root.add(solid(merged(parts), bronze));
    const ashTop = BURNER_BASE_Y + BURNER_ASH_Y;
    root.add(solid(disc(0.65, ashTop), ash, { cast: false }));

    // Lit stick leans 6° in the ash; three spares stand in the bamboo tube.
    const lean = 6 * DEG;
    const tip = new THREE.Vector3(0.05 - Math.sin(lean) * 1.2, ashTop - 0.08 + Math.cos(lean) * 1.2, 0);
    const sticks = [strut([0.05, ashTop - 0.08, 0], tip.toArray(), 0.02, 0.02, 6)];
    const [tx, tz] = INCENSE_TUBE_OFFSET;
    for (const [dx, dz, ex, ez] of [[0.03, -0.04, 0.09, -0.1], [-0.05, 0.02, -0.12, 0.06], [0.02, 0.05, 0.05, 0.13]]) {
      sticks.push(strut([tx + dx, 0.15, tz + dz], [tx + ex, 1.65, tz + ez], 0.018, 0.018, 6));
    }
    root.add(solid(merged(sticks), incense));
    root.add(solid(lathe(TUBE_PROFILE, 24).translate(tx, 0, tz), bamboo));

    this.ember = solid(new THREE.SphereGeometry(0.035, 10, 8), this.emberMaterial, { cast: false, receive: false });
    this.ember.position.copy(tip);
    root.add(this.ember);

    // Smoke: a slow spiral that widens with age, plus a per-particle drift.
    this._addEffect(root, new Particles({
      count: 26, texture: this.glowTexture, color: 0xcfd8dc, size: 0.5, loops: Infinity,
      spawn: (i, initial) => {
        const life = rand(2.6, 3.4);
        const vy = rand(0.45, 0.7);
        const age = initial ? rand(0, life) : 0;
        return {
          pos: [tip.x, tip.y + vy * age, tip.z], vel: [0, vy, 0], life, age,
          phase: rand(0, Math.PI * 2), spin: rand(2.5, 4.5), drift: [rand(-0.25, 0.25), rand(-0.25, 0.25)],
        };
      },
      behave: (p, dt, t) => {
        const w = p.phase + t * p.spin;
        const r = 0.04 + t * 0.32;
        p.pos[0] = tip.x + Math.cos(w) * r + p.drift[0] * t;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] = tip.z + Math.sin(w) * r + p.drift[1] * t;
      },
    }), 0.3);
  }

  // ----- bonsai ------------------------------------------------------------

  _buildBonsai() {
    const root = new THREE.Group();
    root.name = 'bonsai';
    root.position.fromArray(BONSAI_POS);
    this.group.add(root);

    const glaze = new THREE.MeshPhysicalMaterial({ color: 0x2f4f4f, roughness: 0.35, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.2 });
    const soil = new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 1, metalness: 0 });
    const bark = new THREE.MeshStandardMaterial({ map: this.walnut, color: 0x8a7565, roughness: 0.95, metalness: 0 });
    const needles = new THREE.MeshStandardMaterial({ color: 0x2f5a3a, roughness: 0.95, metalness: 0, flatShading: true });
    const rock = new THREE.MeshStandardMaterial({ color: 0x7a7368, roughness: 0.9, metalness: 0, flatShading: true });

    root.add(solid(lathe(BONSAI_POT_PROFILE, 56), glaze));
    root.add(solid(disc(0.81, BONSAI_SOIL_Y), soil, { cast: false }));
    root.add(solid(merged(BONSAI_STONES.map(([x, z, r, yaw]) =>
      new THREE.DodecahedronGeometry(r, 0).scale(1.25, 0.7, 1).rotateY(yaw).translate(x, BONSAI_SOIL_Y + r * 0.45, z))), rock));

    // Trunk and branches form a chain of pivots; each segment is baked with its
    // accumulated matrix so the whole tree becomes one mesh.
    const pivot = new THREE.Object3D();
    pivot.position.set(-0.12, BONSAI_SOIL_Y - 0.05, 0.08);
    const nodes = [];
    for (const [parent, length, r0, r1, rot] of BONSAI_SEGMENTS) {
      const seg = new THREE.Object3D();
      seg.rotation.set(rot[0], rot[1], rot[2]);
      (parent < 0 ? pivot : nodes[parent].tip).add(seg);
      const tip = new THREE.Object3D();
      tip.position.y = length;
      seg.add(tip);
      nodes.push({ seg, tip, length, r0, r1 });
    }
    pivot.updateMatrixWorld(true);
    const wood = [];
    for (const { seg, length, r0, r1 } of nodes) {
      wood.push(new THREE.CylinderGeometry(r1, r0, length, 10).translate(0, length / 2, 0).applyMatrix4(seg.matrixWorld));
      wood.push(new THREE.SphereGeometry(r0, 10, 8).applyMatrix4(seg.matrixWorld)); // rounds the joint
    }
    root.add(solid(merged(wood), bark));

    const pads = BONSAI_PADS.map(([index, along, radius, offset], k) => {
      const { seg, length } = nodes[index];
      const at = new THREE.Vector3(0, length * along, 0).applyMatrix4(seg.matrixWorld).add(new THREE.Vector3().fromArray(offset));
      return new THREE.IcosahedronGeometry(radius, 1).scale(1, 0.35, 1).rotateY(k * 1.7).translate(at.x, at.y, at.z);
    });
    root.add(solid(merged(pads), needles));
  }

  // ----- books -------------------------------------------------------------

  _buildBooks() {
    const root = new THREE.Group();
    root.name = 'books';
    root.position.fromArray(BOOKS_POS);
    this.group.add(root);

    const { texture, rects, pages } = this._drawBookAtlas();
    const [w, h, d] = BOOK_SIZE;
    const boxes = BOOKS.map(([yaw, dx, dz], i) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const { cover, spine } = rects[i];
      // Stitched spine on +X, cloth covers on ±Y, page edges on the other three sides.
      remapBoxUVs(geo, [spine, pages, cover, cover, pages, pages], BOOK_ATLAS);
      return geo.rotateY(yaw).translate(dx, h * (i + 0.5), dz);
    });
    root.add(solid(merged(boxes), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 })));

    // Vermilion title slip on the top cover, in the corner away from the spine.
    const [yaw, dx, dz] = BOOKS[BOOKS.length - 1];
    const slip = new THREE.PlaneGeometry(0.5, 1.6)
      .rotateX(-Math.PI / 2)
      .translate(-0.6, 0, -0.45)
      .rotateY(yaw)
      .translate(dx, h * BOOKS.length + 0.003, dz);
    root.add(solid(slip, new THREE.MeshStandardMaterial({ map: this._drawTitleSlip(), roughness: 0.8, metalness: 0 }), { cast: false }));
  }

  /** 512² atlas: page edges along the top, then per book a mottled cloth cover strip and a stitched spine strip. */
  _drawBookAtlas() {
    const S = BOOK_ATLAS;
    const canvas = makeCanvas(S);
    const ctx = canvas.getContext('2d');
    const inset = ([x0, y0, x1, y1]) => [x0 + 3, y0 + 3, x1 - 3, y1 - 3];

    ctx.drawImage(createPaperTexture({ size: 256 }).image, 0, 0, S, 120);
    ctx.strokeStyle = 'rgba(110, 90, 60, 0.28)';
    ctx.lineWidth = 1;
    for (let y = 3; y < 120; y += 3) line(ctx, 0, y + 0.5, S, y + 0.5);

    const noise = new ValueNoise(9);
    const rects = BOOK_COVERS.map((hex, i) => {
      const y0 = 130 + i * 124;
      ctx.fillStyle = hex;
      ctx.fillRect(0, y0, S, 120);

      const img = ctx.getImageData(0, y0, S, 96);
      const px = img.data;
      for (let y = 0; y < 96; y++) {
        for (let x = 0; x < S; x++) {
          const k = 0.82 + 0.36 * noise.fbm(x / 36, (y0 + y) / 36, 2);
          const o = (y * S + x) * 4;
          px[o] *= k;
          px[o + 1] *= k;
          px[o + 2] *= k;
        }
      }
      ctx.putImageData(img, 0, y0);

      // Four-hole stitching: thread runs down the spine edge (right) and wraps over the spine strip.
      ctx.strokeStyle = '#e9dcc2';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 2;
      const xThread = S - 30;
      line(ctx, xThread, y0 + 12, xThread, y0 + 84);
      for (let k = 0; k < 4; k++) {
        const y = y0 + 12 + k * 24;
        line(ctx, xThread, y, S, y);
        ctx.beginPath();
        ctx.arc(xThread, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        const xs = ((k + 0.5) / 4) * S;
        line(ctx, xs, y0 + 96, xs, y0 + 120);
      }
      return { cover: inset([0, y0, S, y0 + 96]), spine: inset([0, y0 + 96, S, y0 + 120]) };
    });

    return { texture: canvasToTexture(canvas), rects, pages: inset([0, 0, S, 120]) };
  }

  _drawTitleSlip() {
    const w = 96;
    const h = 320;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#b3141c';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(40, 0, 0, 0.45)';
    ctx.lineWidth = 3;
    ctx.strokeRect(7.5, 7.5, w - 15, h - 15);
    ctx.fillStyle = '#1a120e';
    ctx.font = `bold 46px ${BOOK_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    Array.from(BOOK_TITLE).forEach((ch, i) => ctx.fillText(ch, w / 2, 44 + i * 58));
    return canvasToTexture(canvas);
  }

  // ----- stools ------------------------------------------------------------

  _buildStool(position) {
    const root = new THREE.Group();
    root.name = 'stool';
    root.position.fromArray(position);
    this.group.add(root);

    const wood = new THREE.MeshStandardMaterial({ map: this.walnut, roughness: 0.55, metalness: 0 });
    const velvet = new THREE.MeshPhysicalMaterial({
      color: 0x7a2f24, roughness: 0.9, metalness: 0, sheen: 0.6, sheenColor: 0xa0503f, sheenRoughness: 0.7,
    });
    /** Cushion materials, exposed so a scanned velvet texture set can be applied. @type {THREE.Material[]} */
    (this.cushionMaterials ??= []).push(velvet);

    const seatTop = STOOL_SEAT_TOP_Y - position[1];
    const legTop = seatTop - STOOL_SEAT_THICKNESS + 0.05;
    const parts = [
      new THREE.CylinderGeometry(STOOL_SEAT_RADIUS, STOOL_SEAT_RADIUS - 0.06, STOOL_SEAT_THICKNESS, 40)
        .translate(0, seatTop - STOOL_SEAT_THICKNESS / 2, 0),
    ];
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      parts.push(strut(
        [Math.cos(a) * STOOL_LEG_TOP_R, legTop, Math.sin(a) * STOOL_LEG_TOP_R],
        [Math.cos(a) * STOOL_LEG_FOOT_R, 0, Math.sin(a) * STOOL_LEG_FOOT_R],
        0.12, 0.09,
      ));
    }
    // Stretcher ring threaded through the legs at the radius they have splayed to.
    const ringR = STOOL_LEG_FOOT_R - (STOOL_LEG_FOOT_R - STOOL_LEG_TOP_R) * (STOOL_RING_Y / legTop);
    parts.push(new THREE.TorusGeometry(ringR, 0.055, 8, 48).rotateX(Math.PI / 2).translate(0, STOOL_RING_Y, 0));
    root.add(solid(merged(parts), wood));
    root.add(solid(lathe(CUSHION_PROFILE, 48).translate(0, seatTop, 0), velvet));
  }

  // ----- frame update ------------------------------------------------------

  update(dt, elapsed) {
    super.update(dt, elapsed);
    for (const fx of this.effects) fx.update(dt);
    // Smouldering ember: slow breathing plus a faster flicker.
    if (this.emberMaterial) this.emberMaterial.emissiveIntensity = 1.1 + 0.55 * Math.sin(elapsed * 1.7) + 0.2 * Math.sin(elapsed * 9.3);
  }

  dispose() {
    for (const fx of this.effects) fx.dispose();
    this.effects = [];
    super.dispose();
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { AvatarRig } from './AvatarRig.js';
import { LAYOUT, STONE_HEIGHT } from '../Layout.js';
import { createStoneGeometry, createStoneMaterial } from './Board.js';
import { makeCanvas, canvasToTexture } from '../../utils/ProceduralTextures.js';
import { cubicEaseInOut, clamp, damp, smoothstep } from '../../utils/Easing.js';
import { solveTwoBoneIK } from '../../utils/IK.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);

// ---------------------------------------------------------------------------
// Proportions. Figure-local frame: origin at the seat (hip) point, Y up, the
// figure faces +Z and its own right hand is at -X (the group is yawed so that
// +Z points at the table for either seat). Units are world units.
// ---------------------------------------------------------------------------

const UPPER = 8.2;
const LOWER = 7.6;
/** Reference shoulder height the torso profile below was drawn for; other seats scale it. */
const PROFILE_SHOULDER_Y = 10.8;
const SHOULDER_Z = 0.8;
/** Torso pivot (hip) above the seat point; the bow and the reach lean rotate about it. */
const HIP_Y = 0.6;
/** The torso lathe axis sits slightly forward of the hips. */
const TORSO_Z = 0.4;
const TORSO_DEPTH = 0.62; // front-to-back squash of the round lathe
const HEAD_ABOVE_SHOULDER = 3.2;
/** ≈ 16 cm across at 4 cm per unit: adult proportions next to the 4.3 shoulder half-width. */
const HEAD_R = 2.0;
const HEAD_Z = 0.9;
/** The head turns about a point this far below its centre (roughly the atlas joint). */
const HEAD_PIVOT_DROP = 1.1;

/** Robe lathe profile [radius, y] for a 10.8 shoulder height; bands below are painted by height. */
const TORSO_PROFILE = [
  [0, 0.3], [3.9, 0.3], [3.85, 1.2], [3.6, 2.6], [3.25, 4.0],
  [3.0, 5.08], [3.1, 5.12], [3.1, 6.28], [3.0, 6.32],
  [3.2, 7.3], [3.55, 8.6], [3.75, 9.8], [3.8, 10.4], [3.4, 10.95],
  [2.85, 11.13], [2.8, 11.17], [1.6, 11.42], [0.95, 11.5], [0, 11.5],
];
const SASH_BAND = [5.1, 6.3];
const COLLAR_FROM = 11.15;

/** Fingers: [x across the palm (index nearest the thumb), proximal length, distal length, radius, curl1 deg, curl2 deg]. */
const FINGERS = [
  [0.36, 0.6, 0.5, 0.115, 24, 58],
  [0.12, 0.64, 0.54, 0.12, 27, 62],
  [-0.12, 0.6, 0.5, 0.115, 30, 66],
  [-0.36, 0.48, 0.4, 0.105, 34, 70],
];
/** Where a pinched stone sits, in hand space (x is multiplied by the hand's side). */
const PINCH_LOCAL = [0.58, 1.38, -0.58];
/** Stone axis in hand space: mostly the palm normal so a carried stone hangs flat under the fingertips. */
const STONE_AXIS = [-0.3, 0.45, -0.85];

// Poses (figure-local; x is multiplied by the arm's side).
const REST_WRIST = [3.0, 1.9, 2.0];
const REST_FINGERS = [-0.3, -0.12, 1.0];
const HOVER_HEIGHT = 1.6;
const CHIN_FINGERS = [-0.25, 0.85, -0.45];
const CHIN_PALM = [-0.75, 0.25, -0.6];
/** Elbows lean outward, down and back, as a seated person's do. */
const POLE_DIR = [0.4, -0.5, -0.75];
/** With the hand at the chin the elbow hangs down and a little out instead, in front of the ribs. */
const CHIN_POLE_DIR = [0.3, -1.0, 0.1];
const POLE_DISTANCE = 10;
/** How much the fingers tip toward the floor when reaching for a point (0 = along the arm, 1 = straight down). */
const GRAB_DROOP = 0.45;

// Motion.
const WRIST_LAMBDA = 18;
const HAND_LAMBDA = 14;
const HEAD_LAMBDA = 5;
const LEAN_LAMBDA = 5;
const BREATH_HZ = 0.25;
const BREATH_SCALE_Y = 0.006; // 0.06 at the shoulders
const BREATH_SCALE_Z = 0.015;
const YAW_LIMIT = 60 * DEG;
const PITCH_MIN = -40 * DEG;
const PITCH_MAX = 25 * DEG;
const BOW_ANGLE = 18 * DEG;
const NOD_ANGLE = 15 * DEG;
/** Wrist distance from the resting shoulder at which the torso starts / fully leans in to extend the reach. */
const LEAN_START = 12.5;
const LEAN_FULL = 17.0;

// Gesture timings in ms at speed 1, and arc heights.
const T_REACH = 380;
const T_CLOSE = 90;
const T_CARRY = 420;
const T_SETTLE = 70;
const T_PAUSE = 80;
const T_RETRACT = 450;
const REACH_LIFT = 2.4;
const CARRY_LIFT = 1.5;
const RETRACT_LIFT = 2.4;

const DEFAULT_PALETTE = Object.freeze({ robe: 0x3c4a6b, sash: 0x8a2b2b, skin: 0xe6c3a2, hair: 0x1a1410, trim: 0xd8cfbf });
const PIN_COLOR = 0xc9a45a;

// Face atlas: 2:1 for the head sphere. The top strips are solid colours the
// merged hair and hairpin geometry point their UVs at; on the sphere itself
// they land under the 3D hair cap.
const ATLAS_W = 512;
const ATLAS_H = 256;
const HAIR_UV = [0.5, 1 - 14 / ATLAS_H];
const PIN_UV = [0.5, 1 - 42 / ATLAS_H];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Tag every vertex with one colour so parts of any colour can share the vertex-coloured material. */
function paint(geometry, hex) {
  const c = new THREE.Color(hex);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Colour a lathe by height bands: `bands` = [[yMin, yMax, hex], ...], anything else gets `fallback`. */
function paintByHeight(geometry, bands, fallback) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const band = bands.find(([y0, y1]) => y >= y0 && y <= y1);
    c.setHex(band ? band[2] : fallback);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Point every UV of `geometry` at one texel of the face atlas. */
function setUV(geometry, [u, v]) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  return geometry;
}

/** Capsule whose cylinder runs from `a` to `b`; the caps round both joints. */
function capsule(a, b, radius, radial = 10) {
  const from = new THREE.Vector3().fromArray(a);
  const to = new THREE.Vector3().fromArray(b);
  const axis = to.clone().sub(from);
  const geo = new THREE.CapsuleGeometry(radius, axis.length(), 4, radial);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, axis.normalize());
  return geo.applyMatrix4(new THREE.Matrix4().compose(from.add(to).multiplyScalar(0.5), q, ONE));
}

/** One geometry from several pre-placed, pre-painted parts; the inputs are disposed. */
function merged(geometries) {
  const out = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  return out;
}

function solid(geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
}

/** Quadratic bezier into `out` without allocating. */
function bezier(out, p0, p1, p2, t) {
  const u = 1 - t;
  return out.copy(p0).multiplyScalar(u * u).addScaledVector(p1, 2 * u * t).addScaledVector(p2, t * t);
}

function hexCss(hex) {
  return `#${new THREE.Color(hex).getHexString()}`;
}

/**
 * Skin-toned atlas with painted hair, brows, eyes, nose and mouth. The face
 * centre is at u = 0.25 (the sphere's +Z). Returns null without a DOM.
 */
function createFaceTexture(palette) {
  if (typeof document === 'undefined') return null;
  const canvas = makeCanvas(ATLAS_W, ATLAS_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const skin = hexCss(palette.skin);
  const hair = hexCss(palette.hair);
  const ink = '#2b1d16';

  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);

  // Hairline: temples at the sides, a soft peak over the forehead, down to the nape at the back.
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 118);
  ctx.quadraticCurveTo(64, 112, 100, 84);
  ctx.quadraticCurveTo(128, 70, 156, 84);
  ctx.quadraticCurveTo(192, 112, 256, 118);
  ctx.quadraticCurveTo(320, 150, 384, 152);
  ctx.quadraticCurveTo(448, 150, 512, 118);
  ctx.lineTo(512, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(0, 0, ATLAS_W, 28);
  ctx.fillStyle = hexCss(PIN_COLOR);
  ctx.fillRect(0, 28, ATLAS_W, 28);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const sx of [-1, 1]) {
    const x = 128 + sx * 31;
    // Brow.
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(x - sx * 17, 100);
    ctx.quadraticCurveTo(x, 90, x + sx * 16, 98);
    ctx.stroke();
    // Eye: almond white, iris, highlight, upper lid.
    ctx.fillStyle = '#f5efe6';
    ctx.beginPath();
    ctx.moveTo(x - 14, 113);
    ctx.quadraticCurveTo(x, 103, x + 14, 113);
    ctx.quadraticCurveTo(x, 121, x - 14, 113);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(x, 113.5, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(x - 1.8, 111.5, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(x - 14, 113);
    ctx.quadraticCurveTo(x, 103, x + 14, 113);
    ctx.stroke();
    // Blush.
    const blush = ctx.createRadialGradient(128 + sx * 40, 132, 0, 128 + sx * 40, 132, 22);
    blush.addColorStop(0, 'rgba(225,130,115,0.22)');
    blush.addColorStop(1, 'rgba(225,130,115,0)');
    ctx.fillStyle = blush;
    ctx.fillRect(128 + sx * 40 - 22, 110, 44, 44);
  }
  // Nose: a single soft stroke.
  ctx.strokeStyle = 'rgba(140,90,70,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(126, 120);
  ctx.lineTo(124, 138);
  ctx.quadraticCurveTo(128, 143, 133, 138);
  ctx.stroke();
  // Mouth: a slight smile with a lighter lower lip.
  ctx.strokeStyle = '#9a4a44';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(115, 154);
  ctx.quadraticCurveTo(128, 162, 141, 154);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(210,120,110,0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(119, 158);
  ctx.quadraticCurveTo(128, 163, 137, 158);
  ctx.stroke();

  const texture = canvasToTexture(canvas, { anisotropy: 4 });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

// ---------------------------------------------------------------------------
// Figure
// ---------------------------------------------------------------------------

/**
 * Procedural seated player in a robe: one merged body mesh, one merged legs
 * mesh, one head mesh (face atlas, hair and hairpin merged in) and two
 * three-segment arms driven by analytic IK. Nothing here is interactive.
 *
 * Every world-space input (`from`, `to`, `grip`, `hoverAt`, `lookAt`) is
 * converted into the figure's frame when it is given, so the group is expected
 * to stay where the seat puts it.
 */
export class Figure extends Entity {
  /**
   * @param {{ audio?: object, seat: object, name?: string,
   *           palette?: { robe?: number, sash?: number, skin?: number, hair?: number, trim?: number },
   *           maxLeanDeg?: number }} options
   *   `seat` is a LAYOUT.SEAT_* entry. `maxLeanDeg` caps the automatic forward lean used to
   *   extend the reach (default 22 for the far seat, 8 for the near seat whose head hosts the
   *   MAIN_PLAY camera; pass 0 to disable).
   */
  constructor({ audio, seat, name = 'figure', palette = {}, maxLeanDeg } = {}) {
    super(name, { audio });
    if (!seat || !Array.isArray(seat.position)) throw new TypeError('Figure requires a seat (LAYOUT.SEAT_FAR or LAYOUT.SEAT_NEAR)');
    this.seat = seat;
    this.palette = { ...DEFAULT_PALETTE, ...palette };
    this.facing = seat.facing >= 0 ? 1 : -1;
    this.shoulderY = seat.shoulderY ?? PROFILE_SHOULDER_Y;
    this.shoulderHalf = seat.shoulderHalfWidth ?? 4.3;
    this.headY = this.shoulderY + HEAD_ABOVE_SHOULDER;
    this.floorLocal = LAYOUT.FLOOR_Y - seat.position[1];
    this.maxLean = (maxLeanDeg ?? (this.facing > 0 ? 22 : 8)) * DEG;

    this.group.position.fromArray(seat.position);
    this.group.rotation.y = this.facing > 0 ? 0 : Math.PI;
    this._invWorld = new THREE.Matrix4();
    this._refreshInverse();

    /** Cloth, skin and shoes share one vertex-coloured material; the face has its own textured one. */
    this.bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 });
    this.faceTexture = createFaceTexture(this.palette);
    this.faceMaterial = new THREE.MeshStandardMaterial(
      this.faceTexture ? { map: this.faceTexture, roughness: 0.65, metalness: 0 } : { color: this.palette.skin, roughness: 0.65, metalness: 0 },
    );
    this.stoneGeometry = createStoneGeometry();
    this.stoneMaterials = { 1: createStoneMaterial(1), 2: createStoneMaterial(2) };

    /** Upper body pivot at the hips: the bow and the reach lean rotate it about X. */
    this.torso = new THREE.Group();
    this.torso.name = 'torso';
    this.torso.position.set(0, HIP_Y, 0);
    this.group.add(this.torso);

    this._buildBody();
    this._buildLegs();
    this._buildHead();
    this._buildNeck();
    this.arms = { left: this._buildArm('left', 1), right: this._buildArm('right', -1) };
    this._armList = [this.arms.left, this.arms.right];

    this._bow = 0;
    this._bowGen = 0;
    this._nod = 0;
    this._nodGen = 0;
    this._lean = 0;
    this._look = { active: false, target: new THREE.Vector3(), yaw: 0, pitch: 0 };
    this._phase = this.facing > 0 ? 0.4 : 2.7;

    this._ik = { elbow: [0, 0, 0], wrist: [0, 0, 0], reachable: false };
    this._ikShoulder = [0, 0, 0];
    this._ikTarget = [0, 0, 0];
    this._ikPole = [0, 0, 0];
    this._v = new THREE.Vector3();
    this._f = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._bx = new THREE.Vector3();
    this._by = new THREE.Vector3();
    this._bz = new THREE.Vector3();
    this._m = new THREE.Matrix4();

    // Start in the rest pose instead of gliding there from the origin.
    for (const arm of this._armList) {
      this._resolvePose(arm);
      arm.wrist.copy(arm.wristGoal);
      arm.handQuat.copy(arm.handQuatGoal);
    }
    this.update(0, 0);
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /** Robe torso with sash and collar bands, shoulder caps, crossed collar, sash ribbons and the neck: one mesh. */
  _buildBody() {
    const P = this.palette;
    const k = this.shoulderY / PROFILE_SHOULDER_Y;
    const lathe = new THREE.LatheGeometry(TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 40);
    paintByHeight(lathe, [[SASH_BAND[0], SASH_BAND[1], P.sash], [COLLAR_FROM, Infinity, P.trim]], P.robe);
    lathe.scale(1, k, TORSO_DEPTH).translate(0, 0, TORSO_Z);
    const parts = [lathe];
    for (const sx of [-1, 1]) {
      parts.push(paint(new THREE.SphereGeometry(1.05, 16, 12).translate(sx * this.shoulderHalf, this.shoulderY, SHOULDER_Z), P.robe));
      // Crossed collar: two bands from the neck down to the ribs, yawed a little to hug the chest.
      parts.push(paint(
        new THREE.BoxGeometry(0.36, 3.6 * k, 0.22).rotateZ(sx * 22 * DEG).rotateY(sx * 9 * DEG).translate(sx * 0.85, 9.55 * k, 2.6),
        P.trim,
      ));
      parts.push(paint(new THREE.BoxGeometry(0.28, 2.4 * k, 0.08).rotateX(-0.15).translate(sx * 0.42, 3.95 * k, 2.5), P.sash));
    }
    this.body = solid(merged(parts).translate(0, -HIP_Y, 0), this.bodyMaterial, 'body');
    this.torso.add(this.body);
  }

  /**
   * The neck lives in the head group rather than the body mesh: the near figure's
   * head hosts the camera and is hidden while the camera is inside it, and a neck
   * left behind would fill the bottom of the first-person view.
   */
  _buildNeck() {
    const neckBottom = this.shoulderY + 0.25;
    const neckTop = this.headY - HEAD_R * 0.45;
    const pivotY = this.headY - HEAD_PIVOT_DROP;
    const geometry = paint(
      new THREE.CylinderGeometry(0.62, 0.7, neckTop - neckBottom, 14).translate(0, (neckTop + neckBottom) / 2 - pivotY, -0.05),
      this.palette.skin,
    );
    this.neck = solid(geometry, this.bodyMaterial, 'neck');
    this.head.add(this.neck);
  }

  /** Thighs under the table edge, shins down to the floor and shoes: one static mesh. */
  _buildLegs() {
    const P = this.palette;
    const floor = this.floorLocal;
    const parts = [];
    for (const sx of [-1, 1]) {
      parts.push(paint(capsule([sx * 1.55, 0.55, 0.3], [sx * 1.7, 0.4, 6.2], 0.8, 12), P.robe));
      parts.push(paint(capsule([sx * 1.7, 0.4, 6.2], [sx * 1.75, floor + 0.5, 5.4], 0.58, 10), P.robe));
      parts.push(paint(new THREE.BoxGeometry(0.72, 0.4, 1.7).translate(sx * 1.78, floor + 0.2, 5.95), P.hair));
    }
    this.legs = solid(merged(parts), this.bodyMaterial, 'legs');
    this.group.add(this.legs);
  }

  /** Head sphere with the painted face; hair cap, back hair, topknot and hairpin merged in via atlas UVs. */
  _buildHead() {
    const pivotY = this.headY - HEAD_PIVOT_DROP;
    /** Head + hair pivot at the top of the neck; hide it when the camera sits inside the head. */
    this.head = new THREE.Group();
    this.head.name = 'head';
    this.head.rotation.order = 'YXZ';
    this.head.position.set(0, pivotY - HIP_Y, HEAD_Z);
    this.torso.add(this.head);
    this._headRest = this.head.position.clone();

    const oval = [1, 1.06, 0.98];
    const parts = [new THREE.SphereGeometry(HEAD_R, 28, 20).scale(...oval)];
    const hairR = HEAD_R + 0.07;
    const crown = HEAD_R * oval[1];
    const hair = [
      new THREE.SphereGeometry(hairR, 28, 12, 0, Math.PI * 2, 0, 60 * DEG).scale(...oval),
      // Back half only (phi from PI to 2PI is -Z), from the cap's rim down to the nape.
      new THREE.SphereGeometry(hairR, 18, 8, Math.PI, Math.PI, 60 * DEG, 42 * DEG).scale(...oval),
      new THREE.SphereGeometry(0.46, 14, 10).scale(1, 0.85, 1).translate(0, crown + 0.2, -0.15),
      new THREE.TorusGeometry(0.34, 0.1, 8, 18).rotateX(Math.PI / 2).translate(0, crown + 0.03, -0.15),
    ];
    for (const g of hair) parts.push(setUV(g, HAIR_UV));
    const pin = [
      new THREE.CylinderGeometry(0.045, 0.045, 2.3, 8).rotateZ(Math.PI / 2).translate(0, crown + 0.26, -0.15),
      new THREE.SphereGeometry(0.1, 8, 6).translate(1.2, crown + 0.26, -0.15),
    ];
    for (const g of pin) parts.push(setUV(g, PIN_UV));
    this.headMesh = solid(merged(parts), this.faceMaterial, 'headMesh');
    this.headMesh.position.y = HEAD_PIVOT_DROP;
    this.head.add(this.headMesh);
  }

  /**
   * Sleeve (upper arm), forearm with cuff, and a hand with a relaxed half-pinch,
   * plus a hidden stone parented to the hand. Segment geometry runs along +Y
   * from the joint at the origin. Hand space: +Y wrist→fingertips, the palm
   * faces -Z, the thumb is on the side*X side.
   */
  _buildArm(name, side) {
    const P = this.palette;
    const upper = solid(merged([
      paint(new THREE.CylinderGeometry(1.3, 1.0, UPPER, 14).translate(0, UPPER / 2, 0), P.robe),
      paint(new THREE.SphereGeometry(1.25, 14, 10).translate(0, UPPER, 0), P.robe),
    ]), this.bodyMaterial, `${name}UpperArm`);

    const cuffLen = 2.4;
    const fore = solid(merged([
      paint(new THREE.CylinderGeometry(1.05, 1.28, cuffLen, 14).translate(0, cuffLen / 2, 0), P.robe),
      paint(new THREE.CylinderGeometry(1.09, 1.09, 0.3, 14).translate(0, cuffLen, 0), P.trim),
      paint(new THREE.CylinderGeometry(0.46, 0.55, LOWER - 1.6, 12).translate(0, 1.6 + (LOWER - 1.6) / 2, 0), P.skin),
      paint(new THREE.SphereGeometry(0.46, 12, 8).translate(0, LOWER, 0), P.skin),
    ]), this.bodyMaterial, `${name}Forearm`);

    const hand = solid(paint(this._handGeometry(side), P.skin), this.bodyMaterial, `${name}Hand`);
    const pinchLocal = new THREE.Vector3(side * PINCH_LOCAL[0], PINCH_LOCAL[1], PINCH_LOCAL[2]);

    const stone = new THREE.Mesh(this.stoneGeometry, this.stoneMaterials[1]);
    stone.name = `${name}Stone`;
    stone.castShadow = true;
    stone.visible = false;
    const axis = new THREE.Vector3(side * STONE_AXIS[0], STONE_AXIS[1], STONE_AXIS[2]).normalize();
    stone.quaternion.setFromUnitVectors(UP, axis);
    stone.position.copy(pinchLocal).addScaledVector(axis, -STONE_HEIGHT / 2);
    hand.add(stone);

    this.group.add(upper, fore, hand);
    return {
      name,
      side,
      upper,
      fore,
      hand,
      stone,
      pinchLocal,
      shoulderRest: new THREE.Vector3(side * this.shoulderHalf, this.shoulderY, SHOULDER_Z),
      shoulder: new THREE.Vector3(),
      poleDir: new THREE.Vector3(side * POLE_DIR[0], POLE_DIR[1], POLE_DIR[2]).normalize(),
      pole: new THREE.Vector3(),
      wrist: new THREE.Vector3(),
      wristGoal: new THREE.Vector3(),
      handQuat: new THREE.Quaternion(),
      handQuatGoal: new THREE.Quaternion(),
      mode: 'rest',
      gesture: null,
      hold: null,
      think: null,
      tween: null,
      gen: 0,
    };
  }

  /** Palm, four gently curled fingers and a thumb, all merged. `side` mirrors the thumb. */
  _handGeometry(side) {
    const parts = [new THREE.BoxGeometry(0.95, 1.0, 0.3).translate(0, 0.55, 0)];
    for (const [x, l1, l2, r, c1, c2] of FINGERS) {
      const kx = side * x;
      const knuckle = [kx, 1.02, 0];
      const joint = [kx, knuckle[1] + Math.cos(c1 * DEG) * l1, knuckle[2] - Math.sin(c1 * DEG) * l1];
      const tip = [kx, joint[1] + Math.cos(c2 * DEG) * l2, joint[2] - Math.sin(c2 * DEG) * l2];
      parts.push(capsule(knuckle, joint, r, 8), capsule(joint, tip, r * 0.92, 8));
    }
    const root = new THREE.Vector3(side * 0.5, 0.3, 0);
    const mid = root.clone().addScaledVector(new THREE.Vector3(side * 0.65, 0.7, -0.3).normalize(), 0.5);
    const tip = mid.clone().addScaledVector(new THREE.Vector3(0, 0.8, -0.6).normalize(), 0.45);
    parts.push(capsule(root.toArray(), mid.toArray(), 0.15, 8), capsule(mid.toArray(), tip.toArray(), 0.13, 8));
    return merged(parts);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** World-space centre of the head. */
  getHeadWorldPosition(target = new THREE.Vector3()) {
    return this.headMesh.getWorldPosition(target);
  }

  /** World-space pinch point (between thumb and index) of `hand`, where a carried stone sits. */
  getHandWorldPosition(hand, target = new THREE.Vector3()) {
    const arm = this._arm(hand);
    arm.hand.updateWorldMatrix(true, false);
    return target.copy(arm.pinchLocal).applyMatrix4(arm.hand.matrixWorld);
  }

  /**
   * Reach into a bowl/tray at `from`, close the hand around a stone (a Figure-owned stone mesh of colour
   * `player` appears between thumb and index), carry it to ~`liftHeight` above `to`, call `onRelease()`
   * (the caller drops the real stone from there), then return the hand to rest. Starting a new gesture on the
   * same arm cancels the previous one (its stone mesh disappears, onRelease is NOT called again). Resolves when
   * the hand is back at rest. `speed` scales all durations (1 = the opponent's unhurried pace).
   * @param {{ hand?: 'left'|'right', from: THREE.Vector3|number[], to: THREE.Vector3|number[], player?: 1|2,
   *           onRelease?: () => void, liftHeight?: number, speed?: number }} options
   */
  async playStone({ hand = 'right', from, to, player = 1, onRelease = null, liftHeight = 1.2, speed = 1 } = {}) {
    const arm = this._arm(hand);
    const gen = this._cancelArm(arm);
    const scale = 1 / Math.max(0.05, speed || 1);
    const pick = this._toLocal(from, new THREE.Vector3());
    const drop = this._toLocal(to, new THREE.Vector3());
    drop.y += liftHeight;
    const gesture = { pinch: new THREE.Vector3(), p0: new THREE.Vector3(), p1: new THREE.Vector3(), p2: new THREE.Vector3() };
    this._currentPinch(arm, gesture.pinch);
    arm.gesture = gesture;

    await this._arc(arm, gesture, pick, REACH_LIFT, T_REACH * scale);
    if (arm.gen !== gen) return;
    // Closing the hand: a small dip of the wrist sells the pinch.
    await this._track(arm, this.tweens.add({
      duration: T_CLOSE * scale,
      ease: (t) => t,
      onUpdate: (k) => {
        gesture.pinch.copy(pick);
        gesture.pinch.y -= 0.12 * Math.sin(Math.PI * k);
      },
    }));
    if (arm.gen !== gen) return;
    arm.stone.material = this.stoneMaterials[player === 2 ? 2 : 1];
    arm.stone.visible = true;
    this.playSound('stone_bowl_clink', this._v.copy(pick).applyMatrix4(this.group.matrixWorld), { volume: 0.35 });

    await this._arc(arm, gesture, drop, CARRY_LIFT, T_CARRY * scale);
    if (arm.gen !== gen) return;
    await this._track(arm, this.tweens.wait(T_SETTLE * scale));
    if (arm.gen !== gen) return;
    arm.stone.visible = false;
    onRelease?.();
    await this._track(arm, this.tweens.wait(T_PAUSE * scale));
    if (arm.gen !== gen) return;

    // Retract to wherever the arm goes next: the held object, the thinking pose or the thigh.
    const home = this._homePinch(arm, new THREE.Vector3());
    await this._arc(arm, gesture, home, RETRACT_LIFT, T_RETRACT * scale);
    if (arm.gen !== gen) return;
    arm.gesture = null;
    arm.tween = null;
  }

  /**
   * Hand pinches an external object (the ledger's pen) every frame: `grip` is the world point of the grip,
   * `dir` the barrel direction (unit, pointing from nib to cap). A null `grip` releases: the hand returns to rest.
   * @param {'left'|'right'} hand
   * @param {THREE.Vector3|number[]|null} grip
   * @param {THREE.Vector3|number[]|null} [dir]
   */
  holdAt(hand, grip, dir = null) {
    const arm = this._arm(hand);
    if (!grip) {
      arm.hold = null;
      return;
    }
    const hold = arm.hold ?? (arm.hold = { pinch: new THREE.Vector3(), dir: new THREE.Vector3(), hasDir: false });
    this._toLocal(grip, hold.pinch);
    hold.hasDir = Boolean(dir);
    if (dir) this._toLocalDir(dir, hold.dir);
  }

  /**
   * Contemplative pose. With `hoverAt` the given hand hovers ~1.6 above that world point (about to pick a
   * stone); without it the hand rises toward the chin. `false` returns to rest.
   * @param {boolean} active
   * @param {{ hand?: 'left'|'right', hoverAt?: THREE.Vector3|number[]|null }} [options]
   */
  setThinking(active, { hand = 'right', hoverAt = null } = {}) {
    for (const arm of this._armList) arm.think = null;
    if (!active) return;
    const arm = this._arm(hand);
    arm.think = { hover: hoverAt ? this._toLocal(hoverAt, new THREE.Vector3()) : null };
  }

  /** Head turns (damped, yaw ±60°, pitch −40°..+25°) toward a world point; null looks straight ahead. */
  lookAt(worldPos) {
    if (!worldPos) {
      this._look.active = false;
      return;
    }
    this._toLocal(worldPos, this._look.target);
    this._look.active = true;
  }

  /** Whole upper body pitches forward ~18° over ~500 ms, holds ~400 ms and returns over ~600 ms. */
  async bow() {
    const gen = ++this._bowGen;
    const from = this._bow;
    await this.tweens.add({ duration: 500, ease: cubicEaseInOut, onUpdate: (k) => { this._bow = from + (BOW_ANGLE - from) * k; } });
    if (this._bowGen !== gen) return;
    await this.tweens.wait(400);
    if (this._bowGen !== gen) return;
    const top = this._bow;
    await this.tweens.add({ duration: 600, ease: cubicEaseInOut, onUpdate: (k) => { this._bow = top * (1 - k); } });
  }

  /** Small head nod (~15°, ~700 ms total). */
  async nod() {
    const gen = ++this._nodGen;
    await this.tweens.add({
      duration: 700,
      ease: (t) => t,
      onUpdate: (k) => {
        if (this._nodGen === gen) this._nod = NOD_ANGLE * Math.sin(Math.PI * k);
      },
    });
    if (this._nodGen === gen) this._nod = 0;
  }

  /** Cancel gestures on both arms, remove any carried stone; hands return to rest (or to what `holdAt` says). */
  cancelGestures() {
    for (const arm of this._armList) this._cancelArm(arm);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  setCharacterModel(model) {
    if (!model || this.avatar) return;
    this.avatar = new AvatarRig(this, model);
    this.avatar.setFirstPerson(this._firstPerson ?? false);
  }

  setFirstPerson(near) {
    this._firstPerson = near;
    this.head.visible = !near;
    this.body.visible = !near;
    this.legs.visible = !near;
    this.avatar?.setFirstPerson(near);
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    this._refreshInverse();

    const breath = Math.sin(elapsed * BREATH_HZ * Math.PI * 2 + this._phase);
    const lift = (this.shoulderY - HIP_Y) * BREATH_SCALE_Y * breath;
    this.body.scale.set(1, 1 + BREATH_SCALE_Y * breath, 1 + BREATH_SCALE_Z * breath);

    // Pose goals first: the lean that extends a long reach depends on them.
    let leanGoal = 0;
    for (const arm of this._armList) {
      this._resolvePose(arm);
      leanGoal = Math.max(leanGoal, this._leanFor(arm));
    }
    this._lean = damp(this._lean, leanGoal, LEAN_LAMBDA, dt);
    this.torso.rotation.x = this._bow + this._lean;

    this._updateHead(dt, elapsed, lift);
    for (const arm of this._armList) this._updateArm(arm, dt, lift);
    this.avatar?.update();
  }

  dispose() {
    this.cancelGestures();
    this.avatar?.dispose();
    this.faceTexture?.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------------------
  // Per-frame internals
  // ---------------------------------------------------------------------------

  _updateHead(dt, elapsed, lift) {
    const look = this._look;
    let yawGoal = 0;
    let pitchGoal = 0;
    if (look.active) {
      // Head pivot in figure space, following the torso pitch.
      const v = this._v.copy(this._headRest).applyAxisAngle(X_AXIS, this.torso.rotation.x).add(this.torso.position);
      v.subVectors(look.target, v);
      const horizontal = Math.hypot(v.x, v.z);
      yawGoal = clamp(Math.atan2(v.x, v.z), -YAW_LIMIT, YAW_LIMIT);
      // The eyes stay on the target while the torso leans in, but a bow lowers the gaze with the body.
      pitchGoal = clamp(Math.atan2(v.y, horizontal) + this._lean, PITCH_MIN, PITCH_MAX);
    }
    yawGoal += 0.035 * Math.sin(elapsed * 0.37 + this._phase);
    pitchGoal += 0.02 * Math.sin(elapsed * 0.53 + this._phase * 1.7);
    look.yaw = damp(look.yaw, yawGoal, HEAD_LAMBDA, dt);
    look.pitch = damp(look.pitch, pitchGoal, HEAD_LAMBDA, dt);
    this.head.rotation.set(-look.pitch + this._nod, look.yaw, 0);
    this.head.position.y = this._headRest.y + lift;
  }

  _updateArm(arm, dt, lift) {
    // Shoulder pivot follows the torso (breathing lift, bow/lean pitch about the hips).
    arm.shoulder.copy(arm.shoulderRest);
    arm.shoulder.y += lift;
    const pitch = this.torso.rotation.x;
    if (pitch !== 0) arm.shoulder.sub(this.torso.position).applyAxisAngle(X_AXIS, pitch).add(this.torso.position);
    arm.pole.copy(arm.shoulder).addScaledVector(arm.poleDir, POLE_DISTANCE);

    arm.wrist.lerp(arm.wristGoal, 1 - Math.exp(-WRIST_LAMBDA * dt));
    arm.handQuat.slerp(arm.handQuatGoal, 1 - Math.exp(-HAND_LAMBDA * dt));

    arm.shoulder.toArray(this._ikShoulder);
    arm.wrist.toArray(this._ikTarget);
    arm.pole.toArray(this._ikPole);
    const { elbow, wrist } = solveTwoBoneIK(this._ikShoulder, this._ikTarget, UPPER, LOWER, this._ikPole, this._ik);

    const v = this._v;
    arm.upper.position.copy(arm.shoulder);
    v.fromArray(elbow).sub(arm.shoulder).normalize();
    arm.upper.quaternion.setFromUnitVectors(UP, v);
    arm.fore.position.fromArray(elbow);
    v.fromArray(wrist).sub(arm.fore.position).normalize();
    arm.fore.quaternion.setFromUnitVectors(UP, v);
    arm.hand.position.fromArray(wrist);
    arm.hand.quaternion.copy(arm.handQuat);
  }

  /** Forward lean (radians) an arm asks for, from how far its wrist goal is from the resting shoulder. */
  _leanFor(arm) {
    if (arm.mode === 'rest') return 0;
    const d = arm.wristGoal.distanceTo(arm.shoulderRest);
    return this.maxLean * smoothstep((d - LEAN_START) / (LEAN_FULL - LEAN_START));
  }

  /** Pick the pose source by priority (gesture > held object > thinking > rest) and write the arm's goals. */
  _resolvePose(arm, ignoreGesture = false) {
    const { gesture, hold, think } = arm;
    if (gesture && !ignoreGesture) {
      arm.mode = 'gesture';
      this._grabPose(arm, gesture.pinch);
    } else if (hold) {
      arm.mode = 'hold';
      if (hold.hasDir) this._penPose(arm, hold.pinch, hold.dir);
      else this._grabPose(arm, hold.pinch);
    } else if (think) {
      arm.mode = 'think';
      if (think.hover) {
        this._v.copy(think.hover);
        this._v.y += HOVER_HEIGHT;
        this._grabPose(arm, this._v);
      } else {
        this._chinPose(arm);
      }
    } else {
      arm.mode = 'rest';
      this._restPose(arm);
    }
  }

  /** Fingers along the arm but drooping toward the floor, palm down: reaching for / carrying a stone. */
  _grabPose(arm, pinch) {
    const f = this._f.copy(pinch).sub(arm.shoulder).normalize().multiplyScalar(1 - GRAB_DROOP).addScaledVector(DOWN, GRAB_DROOP);
    if (f.lengthSq() < 1e-6) f.copy(DOWN);
    this._setHandGoal(arm, pinch, f, this._n.set(0, -1, 0.3));
  }

  /** Fingers run down the barrel toward the nib, palm turned inward: writing grip. */
  _penPose(arm, pinch, dir) {
    const f = this._f.copy(dir).negate().addScaledVector(DOWN, 0.4);
    if (f.lengthSq() < 1e-6) f.copy(DOWN);
    this._setHandGoal(arm, pinch, f, this._n.set(-arm.side * 0.8, -0.6, 0));
  }

  /** Curled fingers just under the chin, palm toward the face. */
  _chinPose(arm) {
    const s = arm.side;
    this._v.set(s * 0.55, this.headY - HEAD_R - 0.3, HEAD_Z + 1.35);
    this._f.set(s * CHIN_FINGERS[0], CHIN_FINGERS[1], CHIN_FINGERS[2]);
    this._n.set(s * CHIN_PALM[0], CHIN_PALM[1], CHIN_PALM[2]);
    this._setHandGoal(arm, this._v, this._f, this._n);
  }

  /** Hands on the thighs just short of the table edge, palms down, fingers a little inward. */
  _restPose(arm) {
    const s = arm.side;
    arm.wristGoal.set(s * REST_WRIST[0], REST_WRIST[1], REST_WRIST[2]);
    this._f.set(s * REST_FINGERS[0], REST_FINGERS[1], REST_FINGERS[2]);
    this._basisQuat(this._f, DOWN, arm.handQuatGoal);
  }

  /** Hand orientation from finger direction + palm hint, then the wrist that puts the pinch point on `pinch`. */
  _setHandGoal(arm, pinch, fingers, palmHint) {
    this._basisQuat(fingers, palmHint, arm.handQuatGoal);
    arm.wristGoal.copy(arm.pinchLocal).applyQuaternion(arm.handQuatGoal).negate().add(pinch);
  }

  /**
   * Rotation whose +Y is `fingers` and whose -Z (the palm) faces as close to `palmHint` as
   * orthogonality allows. Falls back to world axes when the hint is parallel to the fingers.
   */
  _basisQuat(fingers, palmHint, out) {
    const y = this._by.copy(fingers).normalize();
    const z = this._bz.copy(palmHint).addScaledVector(y, -y.dot(palmHint));
    if (z.lengthSq() < 1e-8) {
      z.set(0, 0, 1).addScaledVector(y, -y.z);
      if (z.lengthSq() < 1e-8) z.set(1, 0, 0).addScaledVector(y, -y.x);
    }
    z.normalize().negate();
    const x = this._bx.crossVectors(y, z);
    this._m.makeBasis(x, y, z);
    return out.setFromRotationMatrix(this._m);
  }

  // ---------------------------------------------------------------------------
  // Gesture plumbing
  // ---------------------------------------------------------------------------

  _arm(hand) {
    return this.arms[hand] ?? this.arms.right;
  }

  /** Invalidate the arm's running gesture: hides its stone, cancels its tween, bumps the generation. */
  _cancelArm(arm) {
    arm.gen++;
    if (arm.tween) {
      arm.tween.cancel();
      arm.tween = null;
    }
    arm.gesture = null;
    arm.stone.visible = false;
    return arm.gen;
  }

  _track(arm, tween) {
    arm.tween = tween;
    return tween;
  }

  /** Glide the gesture's pinch point to `to` along an arc raised by `lift` at its midpoint. */
  _arc(arm, gesture, to, lift, duration) {
    gesture.p0.copy(gesture.pinch);
    gesture.p2.copy(to);
    gesture.p1.lerpVectors(gesture.p0, gesture.p2, 0.5);
    gesture.p1.y += lift;
    return this._track(arm, this.tweens.add({
      duration,
      ease: cubicEaseInOut,
      onUpdate: (k) => bezier(gesture.pinch, gesture.p0, gesture.p1, gesture.p2, k),
    }));
  }

  /** Where the hand's pinch point is right now (figure space). */
  _currentPinch(arm, out) {
    return out.copy(arm.pinchLocal).applyQuaternion(arm.handQuat).add(arm.wrist);
  }

  /** Pinch point of the pose the arm falls back to once its gesture ends. */
  _homePinch(arm, out) {
    this._resolvePose(arm, true);
    return out.copy(arm.pinchLocal).applyQuaternion(arm.handQuatGoal).add(arm.wristGoal);
  }

  _refreshInverse() {
    this.group.updateWorldMatrix(true, false);
    this._invWorld.copy(this.group.matrixWorld).invert();
  }

  /** World point (Vector3 or [x, y, z]) → figure space. */
  _toLocal(v, out) {
    if (v.isVector3) out.copy(v);
    else if (Array.isArray(v)) out.fromArray(v);
    else out.set(v.x, v.y, v.z);
    return out.applyMatrix4(this._invWorld);
  }

  /** World direction → unit direction in figure space. */
  _toLocalDir(v, out) {
    if (v.isVector3) out.copy(v);
    else if (Array.isArray(v)) out.fromArray(v);
    else out.set(v.x, v.y, v.z);
    return out.transformDirection(this._invWorld);
  }
}

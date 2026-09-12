import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, INTERACTIVE, BOARD_TOP_Y } from '../Layout.js';
import { cubicEaseInOut, cubicEaseOut, quadEaseIn } from '../../utils/Easing.js';
import { createStoneTexture, makeCanvas, canvasToTexture, createRadialGlowTexture } from '../../utils/ProceduralTextures.js';
import { Particles } from './Board.js';

const SEAL_RED = '#b3141c';
const SEAL_FONT = '"STXingkai","STKaiti","KaiTi","Noto Serif CJK SC","SimSun",serif';
const COBALT = '#1f4e9c';
const DECAL_SIZE = 1.6;
const HOVER_HEIGHT = 4.0;
const INK_HOVER = 1.3;

const rand = (min, max) => min + Math.random() * (max - min);
const toVec3 = (v) => (v.isVector3 ? v.clone() : new THREE.Vector3().fromArray(v));

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** One mesh (one draw call) from same-material, pre-placed parts; the parts are disposed. */
function mergedMesh(parts, material) {
  // mergeGeometries rejects a mix of indexed and non-indexed input, so flatten when needed.
  const uniform = parts.every((g) => Boolean(g.index) === Boolean(parts[0].index));
  const input = uniform ? parts : parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const mesh = new THREE.Mesh(mergeGeometries(input, false), material);
  for (const g of new Set([...parts, ...input])) g.dispose();
  return mesh;
}

/**
 * Splits an indexed multi-material geometry into one non-indexed geometry per
 * material group (in group order), so faces can be re-batched by material. The
 * source geometry is disposed.
 */
function splitGroups(geometry) {
  const flat = geometry.toNonIndexed();
  const parts = flat.groups.map(({ start, count }) => {
    const part = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(flat.attributes)) {
      const n = attr.itemSize;
      part.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(start * n, (start + count) * n), n));
    }
    return part;
  });
  flat.dispose();
  geometry.dispose();
  return parts;
}

/**
 * Qingtian-stone victory seal with a carved beast knob, plus a blue-and-white
 * porcelain ink box. `ceremony()` performs the end-of-game stamping ritual and
 * leaves a vermilion seal impression on the board.
 */
export class VictoryStamp extends Entity {
  constructor({ audio } = {}) {
    super('victoryStamp', { audio });
    this.group.position.fromArray(LAYOUT.STAMP.position);
    this._busy = false;
    this._run = 0;
    this._pending = Promise.resolve();
    /** @type {Particles[]} */
    this.effects = [];
    this.glowTexture = createRadialGlowTexture();

    this.stamp = this._buildStamp();
    this.group.add(this.stamp);
    this.registerInteractive(this.stamp, INTERACTIVE.STAMP, { glow: false, cursor: 'default' });

    this.inkLocal = this._buildInkBox();
    this._buildDecal();
  }

  get busy() {
    return this._busy;
  }

  // ----- construction ------------------------------------------------------

  /** Stamp body group; origin is the centre of the seal face (y = 0 rests on the table). */
  _buildStamp() {
    const s = LAYOUT.STAMP.size;
    const total = LAYOUT.STAMP.height;
    const faceH = 0.03;
    const bodyH = total * 0.62;
    const plinthH = 0.06;

    const root = new THREE.Group();
    root.name = 'stamp';
    // Waxy soapstone: clearcoat + a pale sheen stands in for sub-surface glow.
    // (No `transmission`: a translucent stamp is not worth an extra scene pass every frame.)
    const stoneMap = createStoneTexture();
    const stone = new THREE.MeshPhysicalMaterial({
      map: stoneMap, roughness: 0.3, metalness: 0,
      clearcoat: 0.35, clearcoatRoughness: 0.3, sheen: 0.6, sheenColor: 0xe9e4c6, sheenRoughness: 0.6,
    });
    const darkStone = new THREE.MeshPhysicalMaterial({
      map: stoneMap, color: 0xb4b89a, roughness: 0.35, metalness: 0,
      clearcoat: 0.2, clearcoatRoughness: 0.4, sheen: 0.4, sheenColor: 0xd8d4b6, sheenRoughness: 0.7,
    });

    const face = new THREE.Mesh(new THREE.BoxGeometry(s * 0.98, faceH, s * 0.98), new THREE.MeshStandardMaterial({ color: 0xb3141c, roughness: 0.55 }));
    face.position.y = faceH / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(s, bodyH, s), stone);
    body.position.y = faceH + bodyH / 2;
    // Plinth and beast share one material and move as one, so they are baked into a single mesh.
    const plinth = new THREE.BoxGeometry(s * 0.86, plinthH, s * 0.86).translate(0, faceH + bodyH + plinthH / 2, 0);
    const knob = mergedMesh([plinth, ...this._beastParts(faceH + bodyH + plinthH, s)], darkStone);
    knob.name = 'knob';
    root.add(face, body, knob);

    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return root;
  }

  /** Stylised crouching beast (pixiu) as pre-placed primitives standing on `baseY`; ~0.5·s tall. */
  _beastParts(baseY, s) {
    const parts = [];
    const add = (geometry, x, y, z, rotation = null) => {
      // Same XYZ Euler as Object3D.rotation, so the pose matches the old per-primitive meshes.
      if (rotation) geometry.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rotation)));
      parts.push(geometry.translate(x, baseY + y, z));
    };
    add(new THREE.SphereGeometry(1, 24, 16).scale(0.3 * s, 0.2 * s, 0.4 * s), 0, 0.2 * s, 0);
    add(new THREE.CapsuleGeometry(0.13 * s, 0.14 * s, 4, 12), 0, 0.33 * s, 0.36 * s, [Math.PI / 2, 0, 0]);
    add(new THREE.SphereGeometry(0.06 * s, 12, 8), 0, 0.3 * s, 0.5 * s);
    for (const side of [-1, 1]) {
      add(new THREE.ConeGeometry(0.05 * s, 0.11 * s, 8), side * 0.07 * s, 0.45 * s, 0.32 * s, [0.3, 0, side * -0.35]);
    }
    add(new THREE.TorusGeometry(0.09 * s, 0.028 * s, 8, 20), 0, 0.22 * s, -0.4 * s, [0, Math.PI / 2, 0]);
    const leg = new THREE.CylinderGeometry(0.045 * s, 0.05 * s, 0.12 * s, 10);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) add(leg.clone(), sx * 0.17 * s, 0.06 * s, sz * 0.16 * s);
    }
    leg.dispose();
    return parts;
  }

  /** Porcelain ink box beside the stamp. Returns the group-local point on the ink surface. */
  _buildInkBox() {
    const { position, radius: r, height: h } = LAYOUT.INK_BOX;
    const box = new THREE.Group();
    box.name = 'inkBox';
    box.position.fromArray(position).sub(this.group.position);

    const porcelain = new THREE.MeshPhysicalMaterial({ color: 0xf4f4f0, roughness: 0.15, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15 });
    const banded = new THREE.MeshPhysicalMaterial({ map: this._drawWaveBand(), roughness: 0.15, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15 });
    const lidTop = new THREE.MeshPhysicalMaterial({ map: this._drawLidMotif(), roughness: 0.15, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.15 });

    const wallH = h * 0.75;
    const lidH = h * 0.25;
    // Each cylinder face group would be its own draw call, so the cylinders are split by material
    // group (order: side, top cap, bottom cap) and every plain-porcelain face is re-batched into one
    // mesh; the textured faces keep their exact cylinder UVs. Placement is baked into the geometry.
    const [wallSide, wallTopCap, wallBottomCap] = splitGroups(
      new THREE.CylinderGeometry(r, r * 0.96, wallH, 48).translate(0, wallH / 2, 0),
    );
    const [lidSide, lidFace, lidBottomCap] = splitGroups(
      new THREE.CylinderGeometry(r * 1.02, r * 1.02, lidH, 48).translate(r * 0.4, lidH / 2, r * 1.9),
    );
    const rimRing = new THREE.TorusGeometry(r * 0.93, r * 0.07, 10, 48).rotateX(Math.PI / 2).translate(0, wallH, 0);

    const wall = new THREE.Mesh(wallSide, banded);
    wall.name = 'inkWall';
    const trim = mergedMesh([wallTopCap, wallBottomCap, rimRing, lidSide, lidBottomCap], porcelain);
    trim.name = 'inkPorcelain';
    const lid = new THREE.Mesh(lidFace, lidTop);
    lid.name = 'inkLid';
    const paste = new THREE.Mesh(new THREE.CircleGeometry(r * 0.86, 40), new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.75, metalness: 0 }));
    paste.rotation.x = -Math.PI / 2;
    paste.position.y = wallH + 0.004;
    box.add(wall, trim, paste, lid);
    box.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.group.add(box);
    return box.position.clone().setY(box.position.y + wallH + 0.01);
  }

  /** Seamless cobalt wave band for the ink-box wall (u wraps around the cylinder). */
  _drawWaveBand() {
    const w = 512;
    const h = 128;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f4f0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = COBALT;
    ctx.lineWidth = 4;
    for (const y of [12, h - 12]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.lineWidth = 3;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const y = h / 2 + Math.sin((x / w) * Math.PI * 8 + k * 0.9) * 22 + (k - 1) * 10;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = COBALT;
    for (let i = 0; i < 16; i++) {
      ctx.beginPath();
      ctx.arc(16 + i * 32, h / 2 + Math.cos(i) * 30, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    return canvasToTexture(canvas);
  }

  _drawLidMotif() {
    const size = 256;
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f4f0';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = COBALT;
    ctx.lineWidth = 3;
    for (const r of [30, 78, 112]) {
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(size / 2 + Math.cos(a) * 54, size / 2 + Math.sin(a) * 54, 16, 8, a, 0, Math.PI * 2);
      ctx.stroke();
    }
    return canvasToTexture(canvas);
  }

  _buildDecal() {
    this.decalCanvas = makeCanvas(512);
    this.decalTexture = canvasToTexture(this.decalCanvas);
    this.decalMaterial = new THREE.MeshStandardMaterial({
      map: this.decalTexture, transparent: true, opacity: 0, roughness: 0.85, metalness: 0,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.decal = new THREE.Mesh(new THREE.PlaneGeometry(DECAL_SIZE, DECAL_SIZE), this.decalMaterial);
    this.decal.rotation.x = -Math.PI / 2;
    this.decal.renderOrder = 2;
    this.decal.visible = false;
    this.group.add(this.decal);
  }

  /** Paints the seal impression: rounded frame + glyphs, then mottles the ink. */
  _drawSeal(text) {
    const size = 512;
    const ctx = this.decalCanvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, size, size);

    ctx.strokeStyle = SEAL_RED;
    ctx.lineWidth = 30;
    ctx.lineJoin = 'round';
    roundedRectPath(ctx, 36, 36, size - 72, size - 72, 40);
    ctx.stroke();

    ctx.fillStyle = SEAL_RED;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const chars = Array.from(text || '大捷').slice(0, 4);
    if (chars.length <= 2) {
      ctx.font = `bold ${chars.length === 1 ? 300 : 180}px ${SEAL_FONT}`;
      chars.forEach((ch, i) => ctx.fillText(ch, size / 2, chars.length === 1 ? size / 2 : size / 2 + (i - 0.5) * 200));
    } else {
      // Seal reading order: right column top→bottom, then left column.
      ctx.font = `bold 165px ${SEAL_FONT}`;
      const cols = [size * 0.7, size * 0.3];
      const rows = [size * 0.3, size * 0.7];
      chars.forEach((ch, i) => ctx.fillText(ch, cols[Math.floor(i / 2)], rows[i % 2]));
    }

    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 320; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rand(0.2, 0.6).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(rand(0, size), rand(0, size), rand(2, 12), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      ctx.arc(rand(0, size), rand(0, size), rand(14, 30), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    this.decalTexture.needsUpdate = true;
  }

  // ----- ceremony ----------------------------------------------------------

  /**
   * End-of-game ritual (~2.6s): float up with a half turn and touch the ink,
   * hover 4.0 above `target`, gravity-slam onto it (impact → `onImpact`, sound,
   * seal decal, golden confetti), rebound, then glide home.
   * @param {{ text?: string, target?: THREE.Vector3 | number[], onImpact?: () => void, chime?: string | null }} [opts]
   *   `chime` is the sound played shortly after impact ('chime_win' | 'chime_lose' | null).
   */
  ceremony({ text = '大捷', target = null, onImpact = null, chime = 'chime_win' } = {}) {
    if (this._busy) return this._pending;
    const run = ++this._run;
    this._busy = true;
    const [bx, , bz] = LAYOUT.BOARD.position;
    const targetWorld = target ? toVec3(target) : new THREE.Vector3(bx, BOARD_TOP_Y + 0.25, bz);
    this._pending = this._runCeremony(run, text, targetWorld, onImpact, chime).then(() => {
      if (this._run === run) this._busy = false;
    });
    return this._pending;
  }

  async _runCeremony(run, text, targetWorld, onImpact, chime) {
    this._clearVisuals();
    const stamp = this.stamp;
    const rest = new THREE.Vector3(0, 0, 0);
    const target = targetWorld.clone().sub(this.group.position);
    const hover = target.clone().setY(target.y + HOVER_HEIGHT);
    const ink = this.inkLocal.clone();
    const inkHover = ink.clone().setY(ink.y + INK_HOVER);

    const move = (from, to, duration, delay, ease, { arc = 0, spin = null } = {}) =>
      this.tweens.add({
        duration,
        delay,
        ease,
        onUpdate: (k) => {
          stamp.position.lerpVectors(from, to, k);
          stamp.position.y += Math.sin(k * Math.PI) * arc;
          if (spin) stamp.rotation.y = spin[0] + (spin[1] - spin[0]) * k;
        },
      });

    await Promise.all([
      move(rest, inkHover, 500, 0, cubicEaseInOut, { arc: 0.5, spin: [0, Math.PI] }),
      move(inkHover, ink, 150, 500, quadEaseIn),
      move(ink, inkHover, 150, 650, cubicEaseOut),
      move(inkHover, hover, 350, 800, cubicEaseInOut),
      this.tweens.add({
        duration: 180,
        delay: 1150,
        ease: quadEaseIn,
        onUpdate: (k) => stamp.position.lerpVectors(hover, target, k),
        onComplete: () => this._impact(target, targetWorld, text, onImpact, chime),
      }),
      this.tweens.add({
        duration: 270,
        delay: 1330,
        ease: cubicEaseOut,
        onUpdate: (k) => {
          stamp.position.copy(target);
          stamp.position.y += Math.sin(k * Math.PI) * 0.08;
        },
      }),
      move(target, rest, 1000, 1600, cubicEaseInOut, { arc: 2.5, spin: [Math.PI, Math.PI * 2] }),
    ]);

    if (run !== this._run) return;
    stamp.position.copy(rest);
    stamp.rotation.set(0, 0, 0);
  }

  _impact(targetLocal, targetWorld, text, onImpact, chime) {
    onImpact?.();
    this.playSound('stamp_impact_heavy', targetWorld);
    this._drawSeal(text);
    this.decal.position.copy(targetLocal).setY(targetLocal.y + 0.02);
    this.decal.visible = true;
    this.decalMaterial.opacity = 0;
    this.tweens.add({ duration: 120, ease: (t) => t, onUpdate: (k) => { this.decalMaterial.opacity = k; } });
    this._confetti(targetLocal);
    if (chime) this.tweens.add({ duration: 1, delay: 250, onComplete: () => this.playSound(chime, targetWorld) });
  }

  /** 40 golden flecks burst outward and up from the seal's edge, fall back and fade (~1.5s). */
  _confetti(origin) {
    const floorY = origin.y + 0.03;
    const fx = new Particles({
      count: 40, texture: this.glowTexture, color: 0xffcf5a, size: 0.3,
      spawn: () => {
        const a = rand(0, Math.PI * 2);
        const r = rand(0.5, 0.85);
        const s = rand(1.5, 3.5);
        return {
          pos: [origin.x + Math.cos(a) * r, floorY, origin.z + Math.sin(a) * r],
          vel: [Math.cos(a) * s, rand(2.0, 4.5), Math.sin(a) * s],
          life: rand(1.2, 1.5),
        };
      },
      behave: (p, dt) => {
        const drag = Math.max(0, 1 - 1.2 * dt);
        p.vel[0] *= drag;
        p.vel[2] *= drag;
        p.vel[1] -= 9 * dt;
        p.pos[0] += p.vel[0] * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += p.vel[2] * dt;
        if (p.pos[1] < floorY) {
          p.pos[1] = floorY;
          p.vel[1] *= -0.3;
        }
      },
    });
    this.group.add(fx.points);
    this.effects.push(fx);
  }

  _clearVisuals() {
    this.decal.visible = false;
    this.decalMaterial.opacity = 0;
    for (const fx of this.effects) fx.dispose();
    this.effects = [];
  }

  /** Abort any running ceremony: hide the seal, drop particles, snap the stamp home. */
  reset() {
    this._run++;
    this.tweens.cancelAll();
    this._clearVisuals();
    this.stamp.position.set(0, 0, 0);
    this.stamp.rotation.set(0, 0, 0);
    this._busy = false;
  }

  update(dt, elapsed) {
    super.update(dt, elapsed);
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const fx = this.effects[i];
      fx.update(dt);
      if (fx.done) {
        this.effects.splice(i, 1);
        fx.dispose();
      }
    }
  }
}

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Figure } from '../src/spatial/entities/Figure.js';
import { LAYOUT } from '../src/spatial/Layout.js';

/** Parse the actual vendored skin/geometry in Node; only browser image decoding is omitted. */
async function character(name) {
  const file = readFileSync(new URL(`../public/assets/models/kaykit/${name}.glb`, import.meta.url));
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + jsonLength));
  delete json.images; delete json.textures; delete json.samplers; delete json.materials;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) delete primitive.material;
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(padded);
  const bin = file.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + bin.length, 8);
  header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const buffer = Buffer.concat([header, padded, bin]);
  return (await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length), '')).scene;
}

function expectWrist(fig, hand, suffix) {
  const actual = fig.avatar.bones.get(`wrist${suffix}`).getWorldPosition(new THREE.Vector3());
  const expected = fig.arms[hand].hand.getWorldPosition(new THREE.Vector3());
  expect(actual.distanceTo(expected)).toBeLessThan(1e-6);
}

// Measure the visible skin itself, not a proxy joint or a cached rest-pose box.
function skinPoints(mesh) {
  mesh.updateWorldMatrix(true, false);
  const points = [];
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    points.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
  }
  return points;
}

describe('downloaded KayKit characters', () => {
  it.each([['Mage', LAYOUT.SEAT_FAR], ['Rogue', LAYOUT.SEAT_NEAR]])('retargets %s at its seat, holds stones and releases once', async (name, seat) => {
    const fig = new Figure({ seat });
    fig.setCharacterModel(await character(name));
    fig.update(0, 0);
    expect(fig.bodyMaterial.visible).toBe(false);
    const skin = fig.avatar.meshes.filter(({ mesh }) => mesh.isSkinnedMesh);
    expect(skin).toHaveLength(6);
    for (const { mesh } of skin) {
      expect(mesh.visible).toBe(true);
      const box = new THREE.Box3().setFromPoints(skinPoints(mesh));
      expect(box.min.y).toBeGreaterThan(LAYOUT.FLOOR_Y - 0.15);
      expect(box.max.y).toBeLessThan(17);
      expect(box.getSize(new THREE.Vector3()).length()).toBeLessThan(25);
    }
    const armMesh = skin.find(({ mesh }) => mesh.name.endsWith('_ArmRight')).mesh;
    const from = seat.facing > 0 ? LAYOUT.TRAY.position : LAYOUT.BOWL_WHITE.position;
    const to = new THREE.Vector3(0, 0.6, 0);
    let releases = 0, carryingFrames = 0;
    const gesture = fig.playStone({ hand: 'right', from, to, player: 2, onRelease: () => releases++ });
    for (let i = 0; i < 100; i++) {
      fig.update(1 / 30, i / 30);
      await Promise.resolve();
      expectWrist(fig, 'right', 'r');
      expectWrist(fig, 'left', 'l');
      if (fig.arms.right.stone.visible) {
        carryingFrames++;
        const stone = fig.arms.right.stone.getWorldPosition(new THREE.Vector3());
        const distance = Math.min(...skinPoints(armMesh).map(p => p.distanceTo(stone)));
        expect(distance).toBeLessThan(0.65);
      }
    }
    await gesture;
    expect(carryingFrames).toBeGreaterThan(5);
    expect(releases).toBe(1);
    expect(fig.arms.right.stone.visible).toBe(false);
    fig.dispose();
  });

  it('keeps only arms in first person, including a model that arrives after camera entry', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_NEAR });
    fig.setFirstPerson(true);
    fig.setCharacterModel(await character('Rogue'));
    expect(fig.avatar.meshes.filter(({ mesh }) => mesh.visible).map(({ mesh }) => mesh.name).sort())
      .toEqual(['Rogue_ArmLeft', 'Rogue_ArmRight']);
    fig.setFirstPerson(false);
    expect(fig.avatar.meshes.filter(({ mesh }) => mesh.visible)).toHaveLength(7);
    expect(fig.avatar.meshes.filter(({ enabled, mesh }) => !enabled && mesh.visible)).toHaveLength(0);
    fig.dispose();
  });

  it('preserves fallback rendering when the model has an incompatible skeleton', () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    const model = new THREE.Group();
    expect(() => fig.setCharacterModel(model)).toThrow(/missing bone/);
    expect(model.parent).toBeNull();
    expect(fig.bodyMaterial.visible).toBe(true);
    expect(fig.faceMaterial.visible).toBe(true);
    fig.dispose();
  });

  it('cancels a carried move and releases downloaded GPU resources on disposal', async () => {
    const fig = new Figure({ seat: LAYOUT.SEAT_FAR });
    fig.setCharacterModel(await character('Mage'));
    const skin = fig.avatar.meshes.find(({ mesh }) => mesh.isSkinnedMesh).mesh;
    const texture = new THREE.Texture();
    skin.material.map = texture;
    const disposeTexture = vi.spyOn(texture, 'dispose');
    const disposeSkeleton = vi.spyOn(skin.skeleton, 'dispose');
    let releases = 0;
    const gesture = fig.playStone({ hand: 'right', from: LAYOUT.TRAY.position, to: [0, 0.6, 0], onRelease: () => releases++ });
    for (let i = 0; i < 16; i++) { fig.update(1 / 30, i / 30); await Promise.resolve(); }
    expect(fig.arms.right.stone.visible).toBe(true);
    fig.dispose();
    await gesture;
    expect(releases).toBe(0);
    expect(fig.arms.right.stone.visible).toBe(false);
    expect(disposeTexture).toHaveBeenCalledTimes(1);
    expect(disposeSkeleton).toHaveBeenCalledTimes(1);
  });
});

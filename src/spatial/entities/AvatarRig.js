import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const LIMBS = [['left', 'l', 1], ['right', 'r', -1]];
const normalize = name => name.toLowerCase().replace(/[._ -]/g, '');

/** Retarget the downloaded KayKit skeleton to the tabletop's hand and gaze goals. */
export class AvatarRig {
  constructor(figure, model) {
    this.figure = figure;
    this.model = model;
    this.bones = new Map();
    this.meshes = [];
    this._v = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._matrix = new THREE.Matrix4();
    this._dir = new THREE.Vector3();
    this._segmentQ = new THREE.Quaternion();
    this._headQ = new THREE.Quaternion();
    this._torsoPoint = new THREE.Vector3();
    this._hip = new THREE.Vector3();
    this._knee = new THREE.Vector3();
    this._ankle = new THREE.Vector3();
    model.traverse(obj => {
      if (obj.isBone) this.bones.set(normalize(obj.name), obj);
      if (obj.isMesh) {
        // Keep the everyday outfit; the original pack's weapons and tall wizard hat stay hidden.
        const enabled = obj.isSkinnedMesh || /_Cape$/.test(obj.name);
        this.meshes.push({ mesh: obj, enabled, arm: /_Arm/.test(obj.name) });
      }
    });
    const required = ['hips', 'spine', 'chest', 'head'];
    for (const [, suffix] of LIMBS) {
      for (const joint of ['upperarm', 'lowerarm', 'wrist', 'hand', 'upperleg', 'lowerleg', 'foot', 'toes']) {
        required.push(joint + suffix);
      }
    }
    // Validate before touching the working fallback or attaching the downloaded scene.
    for (const name of required) {
      if (!this.bones.has(name)) throw new Error(`Avatar is missing bone ${name}`);
    }
    this.lengths = new Map(required.map(name => [name, this.bones.get(name).position.length()]));
    // The downloaded torso is narrower than the fallback robe; anchor sleeves inside its shoulders.
    for (const [hand, , side] of LIMBS) figure.arms[hand].shoulderRest.x = side * 3.1;
    for (const { mesh, enabled } of this.meshes) {
      mesh.visible = enabled;
      mesh.frustumCulled = false;
      mesh.castShadow = mesh.receiveShadow = true;
    }
    figure.group.add(model);
    this.update();
    this._fitGeometry();
    // Retain the original transform drivers and carried-stone children without drawing the primitives.
    figure.bodyMaterial.visible = false;
    figure.faceMaterial.visible = false;
  }

  /**
   * Fit the short adventure sleeves to the longer seated reach once, then rebind.
   * Stretch between joints only: stretching a whole bone also pulls the shoulder
   * cap backwards and turns cuffs into spikes. Preserve the shape beyond each joint.
   */
  _fitGeometry() {
    const fittings = new Map();
    const start = new THREE.Vector3(), end = new THREE.Vector3();
    for (const [, suffix] of LIMBS) {
      for (const [joint, child, width] of [['upperarm', 'lowerarm', 9], ['lowerarm', 'wrist', 7]]) {
        const bone = this.bones.get(joint + suffix);
        bone.getWorldPosition(start);
        this.bones.get(child + suffix).getWorldPosition(end);
        fittings.set(bone, { length: this.lengths.get(child + suffix), target: start.distanceTo(end) / width });
      }
    }
    const skinned = this.meshes.filter(({ mesh }) => mesh.isSkinnedMesh).map(({ mesh }) => mesh);
    const vertex = new THREE.Vector3(), local = new THREE.Vector3(), fitted = new THREE.Vector3();
    const inverseMesh = new THREE.Matrix4();
    // Bake every mesh before changing any shared bind inverse.
    for (const mesh of skinned) {
      mesh.updateWorldMatrix(true, false);
      inverseMesh.copy(mesh.matrixWorld).invert();
      const { position, skinIndex, skinWeight } = mesh.geometry.attributes;
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(mesh.bindMatrix);
        fitted.set(0, 0, 0);
        for (let j = 0; j < 4; j++) {
          const weight = skinWeight.getComponent(i, j);
          if (!weight) continue;
          const index = skinIndex.getComponent(i, j);
          const bone = mesh.skeleton.bones[index];
          local.copy(vertex).applyMatrix4(mesh.skeleton.boneInverses[index]);
          const fit = fittings.get(bone);
          if (fit && local.y > 0) {
            local.y = Math.min(local.y, fit.length) * fit.target / fit.length + Math.max(0, local.y - fit.length);
          }
          fitted.addScaledVector(local.applyMatrix4(bone.matrixWorld), weight);
        }
        fitted.applyMatrix4(inverseMesh);
        position.setXYZ(i, fitted.x, fitted.y, fitted.z);
      }
      position.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    }
    for (const mesh of skinned) {
      mesh.bind(mesh.skeleton, mesh.matrixWorld);
      mesh.skeleton.calculateInverses();
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    }
  }

  /** Compose in figure space, then remove the parent transform (including nonuniform limb scaling). */
  _pose(name, position, rotation, width, length = width, depth = width) {
    const bone = this.bones.get(name);
    bone.parent.updateWorldMatrix(true, false);
    this._scale.set(width, length, depth);
    this._matrix.compose(position, rotation, this._scale).premultiply(this.figure.group.matrixWorld);
    bone.matrixAutoUpdate = false;
    bone.matrix.copy(bone.parent.matrixWorld).invert().multiply(this._matrix);
    bone.matrixWorldNeedsUpdate = true;
    bone.updateWorldMatrix(false, false);
  }

  _segment(name, child, start, end, width) {
    this._dir.subVectors(end, start);
    const length = this._dir.length() / this.lengths.get(child);
    this._segmentQ.setFromUnitVectors(UP, this._dir.normalize());
    this._pose(name, start, this._segmentQ, width, length);
  }

  _torso(name, y, width, length, depth = width, z = 0.4, rotation = this.figure.torso.quaternion) {
    this._torsoPoint.set(0, y - 0.6, z).applyQuaternion(this.figure.torso.quaternion);
    this._torsoPoint.y += 0.6;
    this._pose(name, this._torsoPoint, rotation, width, length, depth);
  }

  update() {
    const f = this.figure;
    f.group.updateWorldMatrix(true, false);
    this._torso('hips', 0.6, 9, 3.1 / this.lengths.get('spine'), 7.5);
    this._torso('spine', 3.7, 9, 5.6 / this.lengths.get('chest'), 7.5);
    this._torso('chest', 9.3, 9, 3.1 / this.lengths.get('head'), 7.5);
    this._headQ.copy(f.torso.quaternion).multiply(f.head.quaternion);
    this._torso('head', 12.0, 4.1, 4.1, 4.1, 0.9, this._headQ);

    for (const [hand, suffix, side] of LIMBS) {
      const a = f.arms[hand];
      this._pose(`upperarm${suffix}`, a.upper.position, a.upper.quaternion, 9);
      this._pose(`lowerarm${suffix}`, a.fore.position, a.fore.quaternion, 7);
      this._pose(`wrist${suffix}`, a.hand.position, a.hand.quaternion, 5.5);
      this._v.set(0, 0.8, 0).applyQuaternion(a.hand.quaternion).add(a.hand.position);
      this._pose(`hand${suffix}`, this._v, a.hand.quaternion, 5.5);

      // Thighs project towards the table; calves descend onto the floor beside the stool.
      this._hip.set(side * 1.6, 0.5, 0.4);
      this._knee.set(side * 1.8, -0.1, 4.8);
      this._ankle.set(side * 1.8, f.floorLocal + 1.7, 4.8);
      this._segment(`upperleg${suffix}`, `lowerleg${suffix}`, this._hip, this._knee, 7);
      this._segment(`lowerleg${suffix}`, `foot${suffix}`, this._knee, this._ankle, 7);
      this._v.set(side * 1.8, f.floorLocal + 1.5, 6.0);
      this._segment(`foot${suffix}`, `toes${suffix}`, this._ankle, this._v, 5);
    }
    this.model.updateMatrixWorld(true);
  }

  setFirstPerson(near) {
    for (const { mesh, enabled, arm } of this.meshes) mesh.visible = enabled && (!near || arm);
  }

  /** Mesh geometry/materials are owned by Figure; release the extra GPU skin and texture resources. */
  dispose() {
    const textures = new Set();
    const skeletons = new Set();
    for (const { mesh } of this.meshes) {
      if (mesh.skeleton) skeletons.add(mesh.skeleton);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    }
    for (const texture of textures) texture.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
  }
}

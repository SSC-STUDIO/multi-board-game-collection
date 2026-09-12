import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Entity } from './Entity.js';
import { LAYOUT, INTERACTIVE, BOARD_FULL_SIZE } from '../Layout.js';
import { woodTexture } from '../../utils/ProceduralTextures.js';

const FLOOR_SIZE = 120;
const FLOOR_COLOR = 0x1b140f;
const RUNNER_THICKNESS = 0.02;
const LEG_SIZE = 1.2;
const APRON_HEIGHT = 0.9;
const APRON_THICKNESS = 0.22;
const APRON_INSET = 0.6;

/** One mesh (one draw call) from same-material, pre-placed parts; the parts are disposed. */
function mergedMesh(parts, material, name) {
  const mesh = new THREE.Mesh(mergeGeometries(parts, false), material);
  for (const g of parts) g.dispose();
  mesh.name = name;
  return mesh;
}

/**
 * Walnut tabletop (top surface at y = 0), apron, four legs down to the floor,
 * a velvet runner under the board and the dark matte floor plane.
 * Static geometry; registered as INTERACTIVE.TABLE so "click outside" works.
 */
export class Tabletop extends Entity {
  constructor({ audio } = {}) {
    super('tabletop', { audio });

    const { size, thickness, legHeight } = LAYOUT.TABLE;
    const [width, depth] = size;
    // One un-tiled sheet: the procedural grain is not seamless, so tiling would show joins.
    // Deep, low-contrast figure — high contrast at this scale reads as marble, not walnut.
    const walnut = woodTexture('walnut', {
      size: 1536, rings: 34, waviness: 3.5, fiber: 0.09, fiberScale: 3, contrast: 0.42,
      baseColor: '#4a3020', grainColor: '#2a190d', highlightColor: '#63432c',
    });

    this._buildTop(width, depth, thickness, walnut);
    this._buildFrame(width, depth, thickness, legHeight, walnut);
    this._buildRunner();
    this._buildFloor();
  }

  _buildTop(width, depth, thickness, walnut) {
    // Waxed rather than lacquered: the old clearcoat mirrored the environment into a milky
    // sheen, and as the largest surface on screen it is also the cheapest place to save shading.
    const material = new THREE.MeshStandardMaterial({ map: walnut, roughness: 0.58, metalness: 0 });
    /** Exposed so a scanned walnut texture set can replace the procedural grain. */
    this.topMaterial = material;
    this.surface = new THREE.Mesh(new THREE.BoxGeometry(width, thickness, depth), material);
    this.surface.position.y = LAYOUT.TABLE.topY - thickness / 2;
    this.surface.receiveShadow = true;
    this.surface.castShadow = true;
    this.surface.name = 'tableSurface';
    this.group.add(this.surface);
    this.registerInteractive(this.surface, INTERACTIVE.TABLE, { glow: false, cursor: 'default' });
  }

  _buildFrame(width, depth, thickness, legHeight, walnut) {
    // Apron boards: grain rotated to run along their length.
    const apronTex = walnut.clone();
    apronTex.center.set(0.5, 0.5);
    apronTex.rotation = Math.PI / 2;
    apronTex.repeat.set(0.3, 3);
    const apronMat = new THREE.MeshStandardMaterial({ map: apronTex, color: 0xcfb9a3, roughness: 0.6, metalness: 0 });

    // Legs: narrow slice of the grain so rings run vertically.
    const legTex = walnut.clone();
    legTex.repeat.set(0.3, 1);
    const legMat = new THREE.MeshStandardMaterial({ map: legTex, color: 0xcfb9a3, roughness: 0.6, metalness: 0 });
    this.apronMaterial = apronMat;
    this.legMaterial = legMat;

    // The frame never moves, so the four apron boards become one mesh and the four legs another.
    const apronY = -thickness - APRON_HEIGHT / 2;
    const apronParts = [];
    for (const sign of [-1, 1]) {
      apronParts.push(
        new THREE.BoxGeometry(width - APRON_INSET * 2, APRON_HEIGHT, APRON_THICKNESS)
          .translate(0, apronY, sign * (depth / 2 - APRON_INSET)),
        new THREE.BoxGeometry(APRON_THICKNESS, APRON_HEIGHT, depth - APRON_INSET * 2)
          .translate(sign * (width / 2 - APRON_INSET), apronY, 0),
      );
    }
    const apron = mergedMesh(apronParts, apronMat, 'tableApron');
    apron.castShadow = true;

    const legY = -thickness - legHeight / 2;
    const lx = width / 2 - APRON_INSET - LEG_SIZE / 2;
    const lz = depth / 2 - APRON_INSET - LEG_SIZE / 2;
    const legParts = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        legParts.push(new THREE.BoxGeometry(LEG_SIZE, legHeight, LEG_SIZE).translate(sx * lx, legY, sz * lz));
      }
    }
    const legs = mergedMesh(legParts, legMat, 'tableLegs');
    legs.castShadow = true;
    legs.receiveShadow = true;
    this.group.add(apron, legs);
  }

  /** Pale-brown velvet runner slightly larger than the board; the board sits on it. */
  _buildRunner() {
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x8c6a4a, roughness: 0.92, metalness: 0,
      sheen: 0.6, sheenColor: 0xb08968, sheenRoughness: 0.8,
    });
    this.runner = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_FULL_SIZE + 2.4, RUNNER_THICKNESS, BOARD_FULL_SIZE + 1.6),
      material,
    );
    const [bx, , bz] = LAYOUT.BOARD.position;
    this.runner.position.set(bx, RUNNER_THICKNESS / 2, bz);
    this.runner.receiveShadow = true;
    this.runner.name = 'tableRunner';
    this.group.add(this.runner);
    this.registerInteractive(this.runner, INTERACTIVE.TABLE, { glow: false, cursor: 'default' });
  }

  _buildFloor() {
    const material = new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, roughness: 0.95, metalness: 0 });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE), material);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = LAYOUT.FLOOR_Y;
    this.floor.receiveShadow = true;
    this.floor.name = 'floor';
    this.group.add(this.floor);
    this.registerInteractive(this.floor, INTERACTIVE.TABLE, { glow: false, cursor: 'default' });
  }
}

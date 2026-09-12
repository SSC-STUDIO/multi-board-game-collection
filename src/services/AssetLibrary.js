/**
 * Downloaded-asset layer over the procedural look.
 *
 * `tools/fetch-assets.mjs` writes public/assets/manifest.json describing the
 * CC0 texture sets (diffuse / GL-normal / ARM), glTF models, HDRIs and OFL
 * fonts it fetched. This service reads that manifest and upgrades materials in
 * place as files stream in; when the manifest (or any file) is missing the
 * procedural materials simply stay, so the project still runs offline.
 *
 * Browser only at runtime; no DOM access at module top level.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { setCjkFonts } from '../utils/DynamicTexture.js';
import { publicUrl } from '../utils/PublicUrl.js';

/**
 * @typedef {{ id: string, res: string, diff?: string, nor_gl?: string, arm?: string }} TextureSet
 * @typedef {{ family: string, role: 'kai' | 'xing', url: string }} FontEntry
 * @typedef {{ textures: Record<string, TextureSet>, models: Record<string, string>, hdris: Record<string, string>, fonts: FontEntry[], credits: object[] }} Manifest
 */

export class AssetLibrary {
  /**
   * @param {{ manifestUrl?: string, anisotropy?: number }} [options]
   */
  constructor({ manifestUrl = '/assets/manifest.json', anisotropy = 8 } = {}) {
    this.manifestUrl = manifestUrl;
    this.anisotropy = anisotropy;
    /** @type {Manifest | null} */
    this.manifest = null;
    /** @type {Record<string, string>} loaded web-font families by role */
    this.fonts = {};
    this._textureLoader = new THREE.TextureLoader();
    this._gltfLoader = new GLTFLoader();
    this._rgbeLoader = new RGBELoader();
    /** @type {Map<string, Promise<THREE.Texture | null>>} */
    this._textureCache = new Map();
  }

  /** True once a manifest was found; false means "procedural only". */
  get available() {
    return this.manifest !== null;
  }

  /**
   * Fetch the manifest and register the calligraphy fonts. Never throws;
   * resolves (possibly with nothing available) within `timeoutMs`.
   * @param {{ timeoutMs?: number, fonts?: boolean }} [options]
   */
  async init({ timeoutMs = 4000, fonts = true } = {}) {
    try {
      const res = await fetch(publicUrl(this.manifestUrl), { cache: 'no-cache', signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) this.manifest = await res.json();
    } catch {
      this.manifest = null;
    }
    if (!this.manifest) {
      console.info('[zenith] no downloaded assets (run `npm run assets`); using procedural materials');
      return;
    }
    if (fonts && this.manifest.fonts?.length) {
      await Promise.race([this._loadFonts(), new Promise((r) => setTimeout(r, timeoutMs))]);
    }
  }

  hasTexture(key) {
    return Boolean(this.manifest?.textures?.[key]?.diff);
  }

  hasModel(id) {
    return Boolean(this.manifest?.models?.[id]);
  }

  hasHdri(id) {
    return Boolean(this.manifest?.hdris?.[id]);
  }

  /** @returns {object[]} attribution list from the manifest */
  get credits() {
    return this.manifest?.credits ?? [];
  }

  // ---------------------------------------------------------------------------
  // textures
  // ---------------------------------------------------------------------------

  /**
   * Apply a scanned PBR set to one or more materials, swapping each map in as
   * it finishes loading. Materials keep their procedural look until then and
   * stay untouched when the set is not available.
   *
   * @param {THREE.Material | THREE.Material[]} materials
   * @param {string} key                    manifest texture key, e.g. 'table_walnut'
   * @param {object} [opts]
   * @param {number[]} [opts.repeat]        texture repeat (default [1, 1])
   * @param {number} [opts.rotation]        UV rotation in radians (about the texture centre)
   * @param {number | string} [opts.color]  material tint applied together with the diffuse
   * @param {number} [opts.normalScale]     normal-map strength (default 1)
   * @param {number} [opts.roughness]       multiplier for the roughness map (default 1)
   * @param {string[]} [opts.maps]          subset of ['diff', 'nor_gl', 'arm'] to apply
   * @returns {Promise<boolean>} true when at least the diffuse map was applied
   */
  async applyPbr(materials, key, { repeat = [1, 1], rotation = 0, color = null, normalScale = 1, roughness = 1, maps = ['diff', 'nor_gl', 'arm'] } = {}) {
    const set = this.manifest?.textures?.[key];
    if (!set) return false;
    const list = Array.isArray(materials) ? materials : [materials];
    const configure = (tex, srgb) => {
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
      if (rotation) {
        tex.center.set(0.5, 0.5);
        tex.rotation = rotation;
      }
      tex.anisotropy = this.anisotropy;
      tex.needsUpdate = true;
    };

    const jobs = [];
    if (maps.includes('diff') && set.diff) {
      jobs.push(this._texture(set.diff, `${key}|diff|${repeat}|${rotation}`, (t) => configure(t, true)).then((tex) => {
        if (!tex) return false;
        for (const m of list) {
          if (!('map' in m)) continue;
          m.map = tex;
          if (color !== null) m.color.set(color);
          m.needsUpdate = true;
        }
        return true;
      }));
    }
    if (maps.includes('nor_gl') && set.nor_gl) {
      jobs.push(this._texture(set.nor_gl, `${key}|nor|${repeat}|${rotation}`, (t) => configure(t, false)).then((tex) => {
        if (!tex) return;
        for (const m of list) {
          if (!('normalMap' in m)) continue;
          m.normalMap = tex;
          m.normalScale?.set(normalScale, normalScale);
          m.needsUpdate = true;
        }
      }));
    }
    if (maps.includes('arm') && set.arm) {
      // Poly Haven ARM packs AO (R), roughness (G) and metalness (B): exactly
      // the channels three.js reads for roughnessMap / metalnessMap.
      jobs.push(this._texture(set.arm, `${key}|arm|${repeat}|${rotation}`, (t) => configure(t, false)).then((tex) => {
        if (!tex) return;
        for (const m of list) {
          if (!('roughnessMap' in m)) continue;
          m.roughnessMap = tex;
          m.roughness = roughness;
          m.metalnessMap = tex;
          m.metalness = 1;
          m.needsUpdate = true;
        }
      }));
    }
    const results = await Promise.all(jobs);
    return results[0] === true;
  }

  /**
   * Load the diffuse image of a set as a plain image (for canvas compositing,
   * e.g. painting the board grid over the wood photo).
   * @returns {Promise<HTMLImageElement | null>}
   */
  async loadImage(key) {
    const url = this.manifest?.textures?.[key]?.diff;
    if (!url) return null;
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = publicUrl(url);
    });
  }

  _texture(url, cacheKey, configure) {
    if (!this._textureCache.has(cacheKey)) {
      const promise = this._textureLoader.loadAsync(publicUrl(url)).then((tex) => {
        configure(tex);
        return tex;
      }).catch((err) => {
        console.warn(`[zenith] texture failed: ${url}`, err?.message ?? err);
        return null;
      });
      this._textureCache.set(cacheKey, promise);
    }
    return this._textureCache.get(cacheKey);
  }

  // ---------------------------------------------------------------------------
  // models
  // ---------------------------------------------------------------------------

  /**
   * Load a glTF model, scale it so its bounding box reaches `height` (or
   * `width`) world units and rest its base on y = 0 of the returned group.
   *
   * @param {string} id
   * @param {{ height?: number, width?: number, castShadow?: boolean, receiveShadow?: boolean, yaw?: number }} [opts]
   * @returns {Promise<THREE.Group | null>} pivot group (base centred at its origin), or null when unavailable
   */
  async loadModel(id, { height, width, castShadow = true, receiveShadow = true, yaw = 0, roll = 0, nodes = null } = {}) {
    const url = this.manifest?.models?.[id];
    if (!url) return null;
    let gltf;
    try {
      gltf = await this._gltfLoader.loadAsync(publicUrl(url));
    } catch (err) {
      console.warn(`[zenith] model failed: ${url}`, err?.message ?? err);
      return null;
    }
    const model = gltf.scene;
    if (nodes) {
      for (const child of [...model.children]) if (!nodes.includes(child.name)) model.remove(child);
    }
    model.rotation.y = yaw;
    model.rotation.z = roll;
    model.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    let scale = 1;
    if (height && size.y > 0) scale = height / size.y;
    else if (width && Math.max(size.x, size.z) > 0) scale = width / Math.max(size.x, size.z);
    model.scale.setScalar(scale);
    model.updateMatrixWorld(true);
    box.setFromObject(model);
    const centre = box.getCenter(new THREE.Vector3());
    model.position.set(-centre.x, -box.min.y, -centre.z);

    model.traverse((obj) => {
      if (!/** @type {any} */ (obj).isMesh) return;
      obj.castShadow = castShadow;
      obj.receiveShadow = receiveShadow;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
          const tex = m[slot];
          if (tex) tex.anisotropy = this.anisotropy;
        }
      }
    });

    const pivot = new THREE.Group();
    pivot.name = id;
    pivot.add(model);
    pivot.userData.size = size.multiplyScalar(scale);
    return pivot;
  }

  // ---------------------------------------------------------------------------
  // environment
  // ---------------------------------------------------------------------------

  /**
   * Load an equirectangular HDR as a reflection-mapped texture (feed it to
   * Lighting.setEnvironmentTexture, which runs the PMREM pre-filter).
   * @returns {Promise<THREE.DataTexture | null>}
   */
  async loadHdri(id) {
    const url = this.manifest?.hdris?.[id];
    if (!url) return null;
    try {
      const tex = await this._rgbeLoader.loadAsync(publicUrl(url));
      tex.mapping = THREE.EquirectangularReflectionMapping;
      return tex;
    } catch (err) {
      console.warn(`[zenith] HDRI failed: ${url}`, err?.message ?? err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // fonts
  // ---------------------------------------------------------------------------

  async _loadFonts() {
    if (typeof FontFace === 'undefined' || !document.fonts) return;
    const loaded = await Promise.all((this.manifest?.fonts ?? []).map(async (font) => {
      try {
        const face = new FontFace(font.family, `url(${publicUrl(font.url)})`, { display: 'swap' });
        await face.load();
        document.fonts.add(face);
        this.fonts[font.role] = font.family;
        return font.family;
      } catch (err) {
        console.warn(`[zenith] font failed: ${font.family}`, err?.message ?? err);
        return null;
      }
    }));
    if (loaded.some(Boolean)) setCjkFonts({ kai: this.fonts.kai, xing: this.fonts.xing });
  }
}

/**
 * Procedural PBR-ish textures generated on a 2D canvas at start-up so the
 * project has zero binary asset dependencies. Every generator returns a
 * THREE.CanvasTexture (sRGB, repeat wrapping). Textures are cached by their
 * option signature so entities can request the same material freely.
 *
 * Browser only (needs `document`). Never import this from `src/core/`.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ValueNoise {
  constructor(seed = 1) {
    const rnd = mulberry32(seed);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    this.values = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.values[i] = rnd();
  }

  hash(x, y) {
    return this.values[this.perm[(this.perm[x & 255] + y) & 255]];
  }

  /** Smooth value noise in [0, 1]. */
  noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = this.hash(xi, yi);
    const b = this.hash(xi + 1, yi);
    const c = this.hash(xi, yi + 1);
    const d = this.hash(xi + 1, yi + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }

  /** Fractional Brownian motion in [0, 1]. */
  fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 0.5;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

export function makeCanvas(width, height = width) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function canvasToTexture(canvas, { repeat = [1, 1], anisotropy = 8, colorSpace = THREE.SRGBColorSpace } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = anisotropy;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

const cache = new Map();

function cached(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

export const WOOD_PRESETS = Object.freeze({
  /** Table top */
  walnut: { baseColor: '#5b3a22', grainColor: '#2e1a0e', highlightColor: '#7d5535', rings: 18, waviness: 5 },
  /** Kaya (榧木) go board – warm honey yellow */
  kaya: { baseColor: '#d7a56a', grainColor: '#b57d44', highlightColor: '#ecc892', rings: 12, waviness: 2.5, fiber: 0.1 },
  /** Rosewood (老红木) clock case */
  rosewood: { baseColor: '#5c2418', grainColor: '#2b0e08', highlightColor: '#84402c', rings: 22, waviness: 4 },
  /** Ash (白蜡木) white-stone bowl */
  ash: { baseColor: '#d9c4a1', grainColor: '#a88c66', highlightColor: '#efe2c9', rings: 16, waviness: 4 },
  /** Black walnut (黑胡桃) black-stone bowl */
  blackWalnut: { baseColor: '#3a2416', grainColor: '#170b06', highlightColor: '#563a2a', rings: 20, waviness: 5 },
  /** Bamboo brush handle */
  bamboo: { baseColor: '#c9a86a', grainColor: '#9a7a44', highlightColor: '#e0c48c', rings: 3, waviness: 0.5, fiber: 0.08 },
});

/**
 * @param {object} [opts]
 * @param {number} [opts.size]
 * @param {string} [opts.baseColor]
 * @param {string} [opts.grainColor]
 * @param {string} [opts.highlightColor]
 * @param {number} [opts.rings]      number of growth-ring bands across the texture
 * @param {number} [opts.waviness]   how much the rings meander
 * @param {number} [opts.fiber]      strength of fine fibre speckle
 * @param {number} [opts.fiberScale] frequency multiplier of the fibre detail (raise it for large
 *                                   un-tiled sheets so the grain stays fine)
 * @param {number} [opts.contrast]   how dark the growth rings get (0 = flat colour, 1 = full grain colour)
 * @param {number} [opts.seed]
 * @param {number[]} [opts.repeat]
 */
export function createWoodTexture(opts = {}) {
  const {
    size = 1024,
    baseColor = '#7a4a2a',
    grainColor = '#3e2312',
    highlightColor = '#a06a3c',
    rings = 18,
    waviness = 5,
    fiber = 0.16,
    fiberScale = 1,
    contrast = 0.72,
    seed = 7,
    repeat = [1, 1],
  } = opts;
  const key = `wood|${size}|${baseColor}|${grainColor}|${highlightColor}|${rings}|${waviness}|${fiber}|${fiberScale}|${contrast}|${seed}|${repeat}`;
  return cached(key, () => {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const noise = new ValueNoise(seed);
    const base = hexToRgb(baseColor);
    const grain = hexToRgb(grainColor);
    const hi = hexToRgb(highlightColor);

    for (let y = 0; y < size; y++) {
      const ny = y / size;
      for (let x = 0; x < size; x++) {
        const nx = x / size;
        const warp = noise.fbm(nx * 2.0 * fiberScale, ny * 0.7 * fiberScale, 3) * waviness;
        const ring = 0.5 + 0.5 * Math.sin((nx * rings + warp) * Math.PI * 2);
        const ringSharp = Math.pow(ring, 2.4);
        const fib = noise.fbm(nx * 70 * fiberScale, ny * 5 * fiberScale, 3);
        let rgb = mix(base, grain, ringSharp * contrast);
        rgb = mix(rgb, hi, Math.max(0, fib - 0.58) * 1.4);
        const speck = (fib - 0.5) * fiber * 255;
        const i = (y * size + x) * 4;
        data[i] = clamp255(rgb[0] + speck);
        data[i + 1] = clamp255(rgb[1] + speck);
        data[i + 2] = clamp255(rgb[2] + speck);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvasToTexture(canvas, { repeat });
  });
}

/** Shortcut: `createWoodTexture({ ...WOOD_PRESETS[name], ...overrides })`. */
export function woodTexture(presetName, overrides = {}) {
  const preset = WOOD_PRESETS[presetName];
  if (!preset) throw new Error(`Unknown wood preset: ${presetName}`);
  return createWoodTexture({ ...preset, ...overrides });
}

// ---------------------------------------------------------------------------
// Paper (宣纸) – cream fibrous sheet
// ---------------------------------------------------------------------------

export function createPaperTexture({ size = 1024, baseColor = '#f2e7d0', fiberColor = '#d9c7a3', seed = 21, vignette = 0.18, repeat = [1, 1] } = {}) {
  const key = `paper|${size}|${baseColor}|${fiberColor}|${seed}|${vignette}|${repeat}`;
  return cached(key, () => {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const noise = new ValueNoise(seed);
    const base = hexToRgb(baseColor);
    const fib = hexToRgb(fiberColor);
    const cx = size / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size;
        const ny = y / size;
        const cloud = noise.fbm(nx * 6, ny * 6, 4);
        const fibres = noise.fbm(nx * 90, ny * 14, 2) * noise.fbm(nx * 12, ny * 120, 2);
        let rgb = mix(base, fib, cloud * 0.35 + fibres * 0.45);
        const dx = (x - cx) / cx;
        const dy = (y - cx) / cx;
        const v = 1 - vignette * Math.pow(Math.min(1, dx * dx + dy * dy), 1.5);
        const i = (y * size + x) * 4;
        data[i] = clamp255(rgb[0] * v);
        data[i + 1] = clamp255(rgb[1] * v);
        data[i + 2] = clamp255(rgb[2] * v);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvasToTexture(canvas, { repeat });
  });
}

// ---------------------------------------------------------------------------
// Leather – pebbled dark-brown hide
// ---------------------------------------------------------------------------

export function createLeatherTexture({ size = 1024, baseColor = '#4a2b1b', creaseColor = '#22110a', sheenColor = '#6b4530', seed = 33, repeat = [1, 1] } = {}) {
  const key = `leather|${size}|${baseColor}|${creaseColor}|${sheenColor}|${seed}|${repeat}`;
  return cached(key, () => {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const noise = new ValueNoise(seed);
    const base = hexToRgb(baseColor);
    const crease = hexToRgb(creaseColor);
    const sheen = hexToRgb(sheenColor);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size;
        const ny = y / size;
        const pebble = noise.fbm(nx * 40, ny * 40, 3);
        const ridge = 1 - Math.abs(2 * noise.fbm(nx * 18, ny * 18, 3) - 1);
        let rgb = mix(base, crease, Math.pow(ridge, 6) * 0.9);
        rgb = mix(rgb, sheen, Math.max(0, pebble - 0.55) * 1.1);
        const i = (y * size + x) * 4;
        data[i] = clamp255(rgb[0]);
        data[i + 1] = clamp255(rgb[1]);
        data[i + 2] = clamp255(rgb[2]);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvasToTexture(canvas, { repeat });
  });
}

// ---------------------------------------------------------------------------
// Brushed metal (brass by default)
// ---------------------------------------------------------------------------

export function createBrushedMetalTexture({ size = 512, baseColor = '#b8923f', streak = 0.22, seed = 44, repeat = [1, 1] } = {}) {
  const key = `metal|${size}|${baseColor}|${streak}|${seed}|${repeat}`;
  return cached(key, () => {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const rnd = mulberry32(seed);
    const noise = new ValueNoise(seed);
    const base = hexToRgb(baseColor);
    for (let y = 0; y < size; y++) {
      const rowJitter = (rnd() - 0.5) * streak;
      for (let x = 0; x < size; x++) {
        const fine = (noise.noise(x * 0.9, y * 8) - 0.5) * streak * 0.6;
        const k = 1 + rowJitter + fine;
        const i = (y * size + x) * 4;
        data[i] = clamp255(base[0] * k);
        data[i + 1] = clamp255(base[1] * k);
        data[i + 2] = clamp255(base[2] * k);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvasToTexture(canvas, { repeat });
  });
}

// ---------------------------------------------------------------------------
// Qingtian stone (青田石) – pale celadon with darker veins
// ---------------------------------------------------------------------------

export function createStoneTexture({ size = 512, baseColor = '#d4d7b4', veinColor = '#7d8460', warmColor = '#e2d9a8', seed = 55, repeat = [1, 1] } = {}) {
  const key = `stone|${size}|${baseColor}|${veinColor}|${warmColor}|${seed}|${repeat}`;
  return cached(key, () => {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const noise = new ValueNoise(seed);
    const base = hexToRgb(baseColor);
    const vein = hexToRgb(veinColor);
    const warm = hexToRgb(warmColor);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = x / size;
        const ny = y / size;
        const cloud = noise.fbm(nx * 4, ny * 4, 4);
        const ridged = 1 - Math.abs(2 * noise.fbm(nx * 7 + 3, ny * 7, 4) - 1);
        let rgb = mix(base, warm, cloud * 0.6);
        rgb = mix(rgb, vein, Math.pow(ridged, 9) * 0.85);
        const i = (y * size + x) * 4;
        data[i] = clamp255(rgb[0]);
        data[i + 1] = clamp255(rgb[1]);
        data[i + 2] = clamp255(rgb[2]);
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvasToTexture(canvas, { repeat });
  });
}

// ---------------------------------------------------------------------------
// Soft radial sprite for particles (dust, sand, incense smoke, golden runes)
// ---------------------------------------------------------------------------

export function createRadialGlowTexture({ size = 128, innerColor = 'rgba(255,255,255,1)', outerColor = 'rgba(255,255,255,0)' } = {}) {
  const key = `glow|${size}|${innerColor}|${outerColor}`;
  return cached(key, () => {
    const canvas = makeCanvas(size);
    const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, innerColor);
    g.addColorStop(0.35, innerColor);
    g.addColorStop(1, outerColor);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  });
}

/** Release every cached texture (call on full scene teardown). */
export function disposeProceduralTextures() {
  for (const tex of cache.values()) tex.dispose();
  cache.clear();
}

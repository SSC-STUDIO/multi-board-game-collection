/**
 * Player-facing settings shown on the start screen. Persisted in localStorage;
 * URL parameters (?mode=renju&time=300&depth=4&quality=low) override the saved
 * values for the current visit so links stay shareable and the smoke test can
 * pin its configuration.
 *
 * Pure data + storage access; no Three.js.
 */

export const SETTINGS_STORAGE_KEY = 'zenith.settings.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  /** 'STANDARD' (five or more wins) | 'RENJU' (black bound by forbidden moves). */
  mode: 'STANDARD',
  /** Minutes per side; 0 = untimed. */
  timeMinutes: 10,
  /** Alpha-beta search depth for the AI opponent (2 = beginner … 5 = master). */
  aiDepth: 4,
  /** 'auto' | 'high' | 'low' */
  quality: 'auto',
  sound: true,
});

/** Option lists rendered as segmented controls, in display order. */
export const SETTING_OPTIONS = Object.freeze({
  mode: [
    { value: 'STANDARD', label: '标准五子', hint: '任意一方连成五子（含长连）即胜' },
    { value: 'RENJU', label: '连珠禁手', hint: '黑方三三 / 四四 / 长连判负，黑须恰五' },
  ],
  timeMinutes: [
    { value: 0, label: '不计时' },
    { value: 5, label: '5 分' },
    { value: 10, label: '10 分' },
    { value: 20, label: '20 分' },
  ],
  aiDepth: [
    { value: 2, label: '入门' },
    { value: 3, label: '进阶' },
    { value: 4, label: '高手' },
    { value: 5, label: '宗师' },
  ],
  quality: [
    { value: 'auto', label: '自动' },
    { value: 'high', label: '精致' },
    { value: 'low', label: '流畅' },
  ],
  sound: [
    { value: true, label: '开' },
    { value: false, label: '关' },
  ],
});

export const SETTING_LABELS = Object.freeze({
  mode: '规则',
  timeMinutes: '每方用时',
  aiDepth: '对手棋力',
  quality: '画质',
  sound: '音效',
});

function isAllowed(key, value) {
  return SETTING_OPTIONS[key].some((opt) => opt.value === value);
}

/** Drop unknown keys and out-of-range values, falling back to the defaults. */
export function sanitizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in raw && isAllowed(key, raw[key])) out[key] = raw[key];
  }
  return out;
}

function readStorage() {
  try {
    const text = globalThis.localStorage?.getItem(SETTINGS_STORAGE_KEY);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** URL overrides for this visit only (never persisted). */
export function readUrlOverrides(search = globalThis.location?.search ?? '') {
  const params = new URLSearchParams(search);
  const out = {};
  const mode = params.get('mode');
  if (mode) out.mode = mode.toLowerCase() === 'renju' ? 'RENJU' : 'STANDARD';
  if (params.has('time')) {
    const seconds = Number(params.get('time'));
    if (Number.isFinite(seconds) && seconds >= 0) out.timeMinutes = Math.round(seconds / 60);
  }
  if (params.has('depth')) {
    const depth = Number(params.get('depth'));
    if (Number.isFinite(depth)) out.aiDepth = Math.min(5, Math.max(2, Math.round(depth)));
  }
  const quality = params.get('quality');
  if (quality) out.quality = quality.toLowerCase();
  return out;
}

/** Defaults ← saved ← URL, then sanitised. */
export function loadSettings() {
  const merged = { ...DEFAULT_SETTINGS, ...(readStorage() ?? {}), ...readUrlOverrides() };
  // A URL time that is not one of the presets still has to land on a preset.
  if (!isAllowed('timeMinutes', merged.timeMinutes)) {
    const presets = SETTING_OPTIONS.timeMinutes.map((o) => o.value);
    merged.timeMinutes = presets.reduce((best, v) => (Math.abs(v - merged.timeMinutes) < Math.abs(best - merged.timeMinutes) ? v : best), presets[0]);
  }
  return sanitizeSettings(merged);
}

export function saveSettings(settings) {
  try {
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
  } catch {
    /* private mode / quota – settings simply won't persist */
  }
}

export const STATS_STORAGE_KEY = 'zenith.stats.v1';

/** @typedef {{ wins: number, losses: number, draws: number }} Stats */

/** Lifetime human-vs-AI record. @returns {Stats} */
export function loadStats() {
  const clean = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(STATS_STORAGE_KEY) ?? 'null');
    return { wins: clean(raw?.wins), losses: clean(raw?.losses), draws: clean(raw?.draws) };
  } catch {
    return { wins: 0, losses: 0, draws: 0 };
  }
}

/** @param {Stats} stats */
export function saveStats(stats) {
  try {
    globalThis.localStorage?.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
  } catch {
    /* not persisted */
  }
}

/**
 * Renderer settings per quality tier. `maxPixels` caps the drawing buffer so a
 * 4K / high-DPI screen does not silently quadruple the fragment work; real
 * refraction (`transmission`) costs an extra full scene pass per frame, so it
 * is reserved for the high tier.
 */
export const QUALITY_PROFILES = Object.freeze({
  /**
   * "精致": soft shadows, IBL, lantern point lights, 4K-class pixel budget, and the
   * post chain — 8× MSAA HDR target + SMAA for edges and shading alike, bloom, vignette.
   */
  high: Object.freeze({
    shadows: true,
    shadowType: 'pcfsoft',
    shadowMapSize: 2048,
    maxPixelRatio: 2,
    // ≈3000×1750: enough for a 1440p monitor at native DPR; a 4K panel renders at ~0.8× and
    // is upscaled, which keeps the 4× MSAA + SMAA + bloom chain inside a 60 fps budget on a 4060.
    maxPixels: 5_200_000,
    // Real refraction re-renders the whole scene every frame (~+18 ms even on an
    // iGPU at 1600×900); the clear-coated glass looks close enough, so it stays off.
    transmission: false,
    ibl: true,
    lanternLights: true,
    roomShading: 'pbr',
    /** Canvas MSAA is redundant when the post chain renders through its own multisampled target. */
    antialias: false,
    postfx: Object.freeze({ samples: 4, bloom: true, smaa: true, vignette: 0.28 }),
  }),
  /**
   * What "自动" picks on a discrete GPU: same look, 1440p-class pixel budget, SMAA-only
   * anti-aliasing (a multisampled HDR target is the single most expensive part of the chain).
   */
  medium: Object.freeze({
    shadows: true,
    shadowType: 'pcfsoft',
    shadowMapSize: 2048,
    maxPixelRatio: 2,
    maxPixels: 3_700_000,
    transmission: false,
    ibl: true,
    lanternLights: true,
    roomShading: 'pbr',
    antialias: false,
    postfx: Object.freeze({ samples: 0, bloom: true, smaa: true, vignette: 0.25 }),
  }),
  /**
   * "流畅" / weak devices: cheaper shadow filter, no lantern point lights, plain
   * diffuse shading on the room shell (no IBL sampling on the biggest surfaces),
   * 1080p-class budget, plain 4× canvas MSAA and no post chain.
   */
  low: Object.freeze({
    shadows: true,
    shadowType: 'pcf',
    shadowMapSize: 1024,
    maxPixelRatio: 1,
    maxPixels: 2_100_000,
    transmission: false,
    ibl: true,
    lanternLights: false,
    roomShading: 'lambert',
    /** MSAA is a context-creation flag: this one only applies at page load. */
    antialias: true,
    postfx: null,
  }),
});

/** Renderer strings that mean "integrated / software GPU": the post chain is fill-rate bound there. */
const WEAK_GPU = /intel|uhd|iris|hd graphics|mali|adreno|powervr|swiftshader|llvmpipe|softpipe|mesa/i;

let cachedGpuName = null;

/**
 * Unmasked GPU name from a throw-away WebGL context (cached). Empty string
 * when unavailable (Node, blocked WebGL).
 */
export function probeGpuName() {
  if (cachedGpuName !== null) return cachedGpuName;
  cachedGpuName = '';
  try {
    const canvas = globalThis.document?.createElement('canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      cachedGpuName = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    /* keep '' */
  }
  return cachedGpuName;
}

/**
 * Collapse the setting to a concrete tier using cheap device hints: touch
 * devices, few cores / little memory and integrated GPUs get 'low'.
 * @param {string} quality 'auto' | 'high' | 'low'
 * @returns {'high' | 'medium' | 'low'}
 */
export function resolveQuality(quality) {
  if (quality === 'high' || quality === 'low') return quality;
  const nav = globalThis.navigator;
  const coarse = globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const cores = nav?.hardwareConcurrency ?? 8;
  const memory = /** @type {any} */ (nav)?.deviceMemory ?? 8;
  if (coarse || cores <= 4 || memory <= 4) return 'low';
  const gpu = probeGpuName();
  // "Intel ... / NVIDIA ..." dual-GPU strings name the adapter actually in use, so a plain match works.
  return gpu && WEAK_GPU.test(gpu) && !/nvidia|geforce|radeon|rx |arc/i.test(gpu) ? 'low' : 'medium';
}

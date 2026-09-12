/**
 * Web Audio positional sound service (DEVELOPMENT_PLAN §5).
 *
 * Every sound is synthesised procedurally into an AudioBuffer on unlock, so the
 * game is fully playable without any asset download. When `sampleBaseUrl` is
 * given, `<base>/<name>.wav` is fetched and preferred, silently falling back to
 * the synthesised buffer.
 *
 * Positional sounds run through an HRTF PannerNode placed at world coordinates;
 * the listener follows the camera via `update()` every frame. Three.js and Web
 * Audio share the same right-handed, Y-up, −Z-forward convention, so no axis
 * conversion is needed.
 *
 * Browser-only at runtime; nothing at module top level touches window/AudioContext.
 */
import { Vector3 } from 'three';

export const SOUND_NAMES = Object.freeze([
  'stone_place',
  'stone_bowl_clink',
  'clock_tick',
  'clock_latch',
  'clock_lever',
  'sand_trickle',
  'wood_brass_swivel',
  'parchment_flip',
  'pen_scribble',
  'stamp_impact_heavy',
  'bowl_lid',
  'chime_win',
  'chime_lose',
]);

export const MAX_VOICES_PER_SOUND = 6;

const PANNER_SETTINGS = Object.freeze({
  panningModel: 'HRTF',
  distanceModel: 'inverse',
  refDistance: 6,
  rolloffFactor: 0.8,
  maxDistance: 80,
});

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// DSP helpers (pure; operate on Float32Array so they can run under Node)
// ---------------------------------------------------------------------------

/** Deterministic mulberry32 PRNG so every load produces identical samples. */
function createRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function zeros(sr, seconds) {
  return new Float32Array(Math.max(1, Math.round(sr * seconds)));
}

/** Attack/exponential-decay envelope. `decay` is the time constant in seconds. */
function envelope(t, attack, decay) {
  return Math.min(1, t / attack) * Math.exp(-t / decay);
}

/**
 * Add a (optionally sweeping) decaying sine partial.
 * @param {Float32Array} out
 * @param {number} sr
 * @param {{ start?: number, duration: number, freq: number, freqEnd?: number, amp: number, decay?: number, attack?: number }} p
 */
function addTone(out, sr, { start = 0, duration, freq, freqEnd = freq, amp, decay = duration / 3, attack = 0.001 }) {
  const i0 = Math.floor(start * sr);
  const n = Math.min(Math.floor(duration * sr), out.length - i0);
  const dt = 1 / sr;
  const decayStep = Math.exp(-dt / decay);
  const attackSamples = Math.max(1, attack * sr);
  const sweep = (freqEnd - freq) / (duration * sr);
  let phase = 0;
  let env = 1;
  let f = freq;
  for (let i = 0; i < n; i++) {
    phase += TWO_PI * f * dt;
    f += sweep;
    const a = i < attackSamples ? i / attackSamples : 1;
    out[i0 + i] += amp * a * env * Math.sin(phase);
    env *= decayStep;
  }
}

/**
 * Add white noise shaped by an envelope. `shape(k)` (k = 0..1) replaces the
 * default attack/decay curve when provided.
 * @param {Float32Array} out
 * @param {number} sr
 * @param {() => number} rng
 * @param {{ start?: number, duration: number, amp: number, decay?: number, attack?: number, shape?: (k: number) => number }} p
 */
function addNoise(out, sr, rng, { start = 0, duration, amp, decay = duration / 3, attack = 0.0005, shape = null }) {
  const i0 = Math.floor(start * sr);
  const n = Math.floor(duration * sr);
  for (let i = 0; i < n && i0 + i < out.length; i++) {
    const t = i / sr;
    const env = shape ? shape(i / n) : envelope(t, attack, decay);
    out[i0 + i] += amp * env * (rng() * 2 - 1);
  }
}

/** First-difference high-pass: keeps the crisp transient, drops the rumble. */
function highpass(data) {
  for (let i = data.length - 1; i > 0; i--) data[i] -= data[i - 1];
  data[0] = 0;
  return data;
}

/** Moving-average low-pass (band-limits noise into a soft hiss). */
function lowpass(data, window) {
  const out = new Float32Array(data.length);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= window) sum -= data[i - window];
    out[i] = sum / Math.min(i + 1, window);
  }
  return out;
}

function mixInto(out, layer, gain = 1) {
  const n = Math.min(out.length, layer.length);
  for (let i = 0; i < n; i++) out[i] += layer[i] * gain;
  return out;
}

/** Peak-normalise and apply a short linear fade-out to avoid end clicks. */
function finish(data, sr, peak = 0.9, fadeOutMs = 8) {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
  if (max > 0) {
    const g = peak / max;
    for (let i = 0; i < data.length; i++) data[i] *= g;
  }
  const fade = Math.min(data.length, Math.floor((fadeOutMs / 1000) * sr));
  for (let i = 0; i < fade; i++) data[data.length - 1 - i] *= i / fade;
  return data;
}

/** Bell-like tone: fundamental plus inharmonic partials that die faster. */
function addBell(out, sr, { start, duration, freq, amp, decay }) {
  addTone(out, sr, { start, duration, freq, amp, decay, attack: 0.002 });
  addTone(out, sr, { start, duration, freq: freq * 2.0, amp: amp * 0.35, decay: decay * 0.6, attack: 0.002 });
  addTone(out, sr, { start, duration, freq: freq * 3.01, amp: amp * 0.15, decay: decay * 0.4, attack: 0.002 });
  addTone(out, sr, { start, duration, freq: freq * 4.2, amp: amp * 0.1, decay: decay * 0.25, attack: 0.001 });
}

// ---------------------------------------------------------------------------
// Sound recipes (DEVELOPMENT_PLAN §5.2 "material-level" samples)
// ---------------------------------------------------------------------------

/** @type {Record<string, (sr: number, rng: () => number) => Float32Array>} */
const RECIPES = {
  stone_place(sr, rng) {
    const out = zeros(sr, 0.2);
    const click = zeros(sr, 0.2);
    addNoise(click, sr, rng, { duration: 0.012, amp: 1, decay: 0.004 });
    mixInto(out, highpass(click), 0.9);
    addTone(out, sr, { duration: 0.18, freq: 1150, amp: 0.7, decay: 0.045 });
    addTone(out, sr, { duration: 0.18, freq: 2400, amp: 0.45, decay: 0.03 });
    addTone(out, sr, { duration: 0.18, freq: 3600, amp: 0.25, decay: 0.02 });
    return finish(out, sr, 0.9);
  },

  stone_bowl_clink(sr, rng) {
    const out = zeros(sr, 0.12);
    const click = zeros(sr, 0.12);
    addNoise(click, sr, rng, { duration: 0.006, amp: 1, decay: 0.002 });
    mixInto(out, highpass(click), 0.6);
    addTone(out, sr, { duration: 0.12, freq: 4200, amp: 0.6, decay: 0.03 });
    addTone(out, sr, { duration: 0.12, freq: 5300, amp: 0.45, decay: 0.022 });
    addTone(out, sr, { duration: 0.12, freq: 6100, amp: 0.3, decay: 0.018 });
    addTone(out, sr, { duration: 0.12, freq: 2800, amp: 0.2, decay: 0.035 });
    return finish(out, sr, 0.85);
  },

  clock_tick(sr, rng) {
    const out = zeros(sr, 0.05);
    const click = zeros(sr, 0.05);
    addNoise(click, sr, rng, { duration: 0.008, amp: 1, decay: 0.0025 });
    mixInto(out, highpass(click), 0.8);
    addTone(out, sr, { duration: 0.04, freq: 3000, amp: 0.5, decay: 0.01 });
    return finish(out, sr, 0.35, 4);
  },

  clock_latch(sr, rng) {
    const out = zeros(sr, 0.25);
    const snap = zeros(sr, 0.25);
    addNoise(snap, sr, rng, { duration: 0.015, amp: 1, decay: 0.005 });
    mixInto(out, highpass(snap), 1.0);
    addTone(out, sr, { duration: 0.06, freq: 620, amp: 0.35, decay: 0.015 });
    addTone(out, sr, { start: 0.01, duration: 0.24, freq: 1800, amp: 0.4, decay: 0.08 });
    addTone(out, sr, { start: 0.01, duration: 0.24, freq: 1900, amp: 0.4, decay: 0.08 });
    return finish(out, sr, 0.9);
  },

  clock_lever(sr, rng) {
    const out = zeros(sr, 0.09);
    addTone(out, sr, { duration: 0.09, freq: 180, amp: 0.8, decay: 0.03 });
    addTone(out, sr, { duration: 0.05, freq: 950, amp: 0.2, decay: 0.01 });
    const thud = zeros(sr, 0.09);
    addNoise(thud, sr, rng, { duration: 0.01, amp: 1, decay: 0.003 });
    mixInto(out, lowpass(thud, 6), 0.5);
    return finish(out, sr, 0.8);
  },

  sand_trickle(sr, rng) {
    const raw = zeros(sr, 0.6);
    addNoise(raw, sr, rng, { duration: 0.6, amp: 1, shape: (k) => Math.pow(Math.sin(Math.PI * k), 0.7) });
    const soft = lowpass(raw, 5);
    const grain = zeros(sr, 0.6);
    addNoise(grain, sr, rng, {
      duration: 0.6,
      amp: 0.5,
      shape: (k) => Math.pow(Math.sin(Math.PI * k), 0.9) * (0.6 + 0.4 * Math.sin(k * 190 + Math.sin(k * 37) * 3)),
    });
    mixInto(soft, lowpass(grain, 2), 0.6);
    return finish(soft, sr, 0.7, 30);
  },

  wood_brass_swivel(sr, rng) {
    const out = zeros(sr, 0.4);
    addTone(out, sr, { duration: 0.4, freq: 80, freqEnd: 140, amp: 0.8, decay: 0.22, attack: 0.05 });
    addTone(out, sr, { duration: 0.4, freq: 161, freqEnd: 283, amp: 0.25, decay: 0.15, attack: 0.05 });
    const creak = zeros(sr, 0.4);
    addNoise(creak, sr, rng, { duration: 0.4, amp: 1, shape: (k) => Math.sin(Math.PI * k) * (0.5 + 0.5 * Math.sin(k * 260)) });
    mixInto(out, lowpass(creak, 12), 0.25);
    const whoosh = zeros(sr, 0.4);
    addNoise(whoosh, sr, rng, { duration: 0.4, amp: 1, shape: (k) => Math.pow(Math.sin(Math.PI * k), 2) });
    mixInto(out, lowpass(whoosh, 8), 0.35);
    return finish(out, sr, 0.85, 20);
  },

  parchment_flip(sr, rng) {
    const out = zeros(sr, 0.26);
    const rise = (k) => (k < 0.4 ? Math.pow(k / 0.4, 1.6) : Math.pow(1 - (k - 0.4) / 0.6, 1.3));
    const hiss = zeros(sr, 0.26);
    addNoise(hiss, sr, rng, { duration: 0.26, amp: 1, shape: rise });
    mixInto(out, highpass(hiss), 1.0);
    const body = zeros(sr, 0.26);
    addNoise(body, sr, rng, { duration: 0.26, amp: 1, shape: rise });
    mixInto(out, lowpass(body, 4), 0.35);
    return finish(out, sr, 0.8, 15);
  },

  pen_scribble(sr, rng) {
    const out = zeros(sr, 0.45);
    const bursts = 5 + Math.floor(rng() * 3);
    for (let b = 0; b < bursts; b++) {
      const start = (b / bursts) * 0.4 + rng() * 0.02;
      const duration = 0.03 + rng() * 0.025;
      const layer = zeros(sr, 0.45);
      addNoise(layer, sr, rng, { start, duration, amp: 0.6 + rng() * 0.4, shape: (k) => Math.sin(Math.PI * k) });
      mixInto(out, highpass(layer), 1);
    }
    return finish(out, sr, 0.7, 10);
  },

  stamp_impact_heavy(sr, rng) {
    const out = zeros(sr, 0.7);
    addTone(out, sr, { duration: 0.3, freq: 70, freqEnd: 28, amp: 1.0, decay: 0.16, attack: 0.002 });
    addTone(out, sr, { duration: 0.45, freq: 220, amp: 0.4, decay: 0.05 });
    addTone(out, sr, { duration: 0.7, freq: 55, amp: 0.35, decay: 0.25, attack: 0.01 });
    const burst = zeros(sr, 0.7);
    addNoise(burst, sr, rng, { duration: 0.02, amp: 1, decay: 0.006 });
    mixInto(out, lowpass(burst, 3), 0.6);
    return finish(out, sr, 0.95, 40);
  },

  bowl_lid(sr, rng) {
    const out = zeros(sr, 0.15);
    addTone(out, sr, { duration: 0.15, freq: 200, amp: 0.8, decay: 0.04 });
    addTone(out, sr, { duration: 0.08, freq: 620, amp: 0.3, decay: 0.015 });
    const knock = zeros(sr, 0.15);
    addNoise(knock, sr, rng, { duration: 0.005, amp: 1, decay: 0.0015 });
    mixInto(out, highpass(knock), 0.6);
    return finish(out, sr, 0.85);
  },

  chime_win(sr) {
    const out = zeros(sr, 1.6);
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const start = i * 0.22;
      addBell(out, sr, { start, duration: 1.6 - start, freq, amp: 0.8 - i * 0.08, decay: 0.38 });
    });
    return finish(out, sr, 0.9, 60);
  },

  chime_lose(sr) {
    const out = zeros(sr, 1.2);
    addTone(out, sr, { start: 0, duration: 1.2, freq: 440, amp: 0.7, decay: 0.32, attack: 0.02 });
    addTone(out, sr, { start: 0, duration: 1.2, freq: 880, amp: 0.15, decay: 0.2, attack: 0.02 });
    addTone(out, sr, { start: 0.35, duration: 0.85, freq: 330, amp: 0.75, decay: 0.3, attack: 0.02 });
    addTone(out, sr, { start: 0.35, duration: 0.85, freq: 660, amp: 0.15, decay: 0.18, attack: 0.02 });
    return finish(out, sr, 0.8, 60);
  },
};

/**
 * Render one sound to mono PCM (exported for tests / offline inspection).
 * @param {string} name
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
export function synthesize(name, sampleRate) {
  const recipe = RECIPES[name];
  if (!recipe) throw new Error(`Audio3D: unknown sound "${name}"`);
  return recipe(sampleRate, createRng(hashName(name)));
}

function hashName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Accepts [x, y, z], THREE.Vector3 or {x, y, z}. */
function toXYZ(position) {
  if (Array.isArray(position)) return position;
  return [position.x, position.y, position.z];
}

function setParams(node, names, values) {
  if (node[names[0]] && typeof node[names[0]].value === 'number') {
    for (let i = 0; i < names.length; i++) node[names[i]].value = values[i];
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Audio3D {
  /**
   * @param {import('three').Camera} camera   listener follows this camera
   * @param {{ sampleBaseUrl?: string | null, masterVolume?: number }} [options]
   */
  constructor(camera, { sampleBaseUrl = null, masterVolume = 0.8 } = {}) {
    this.camera = camera;
    this.sampleBaseUrl = sampleBaseUrl;

    /** @type {AudioContext | null} */
    this._ctx = null;
    /** @type {GainNode | null} */
    this._master = null;
    /** @type {Map<string, AudioBuffer>} */
    this._buffers = new Map();
    /** @type {Map<string, number>} */
    this._voices = new Map();
    /** @type {Promise<void> | null} */
    this._unlocking = null;
    this._ready = false;
    this._muted = false;
    this._masterVolume = Math.min(1, Math.max(0, masterVolume));

    this._listenerPos = new Vector3(Infinity, Infinity, Infinity);
    this._listenerFwd = new Vector3();
    this._listenerUp = new Vector3();
    this._tmpPos = new Vector3();
    this._tmpFwd = new Vector3();
    this._tmpUp = new Vector3();
  }

  /** True once buffers exist and `play()` will produce sound. */
  get ready() {
    return this._ready;
  }

  get muted() {
    return this._muted;
  }

  get context() {
    return this._ctx;
  }

  /**
   * Create the AudioContext and build every buffer. Call from a user gesture
   * (pointerdown/keydown); safe to call repeatedly — later calls only retry
   * `resume()` on a still-suspended context.
   * @returns {Promise<void>}
   */
  unlock() {
    if (!this._unlocking) this._unlocking = this._init();
    if (this._ctx && this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
    return this._unlocking;
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this._muted = Boolean(muted);
    this._applyMasterGain();
  }

  /** @param {number} volume 0..1 */
  setMasterVolume(volume) {
    this._masterVolume = Math.min(1, Math.max(0, Number(volume) || 0));
    this._applyMasterGain();
  }

  /**
   * Fire a one-shot sound. No-op until `ready` or for unknown names.
   * @param {string} name
   * @param {{ position?: number[] | import('three').Vector3 | null, volume?: number, playbackRate?: number, detune?: number }} [options]
   *   `position` in world units routes through an HRTF panner; omit for 2D UI sounds.
   */
  play(name, { position = null, volume = 1, playbackRate = 1, detune = 0 } = {}) {
    const ctx = this._ctx;
    const master = this._master;
    if (!this._ready || !ctx || !master) return;
    const buffer = this._ensureBuffer(name);
    if (!buffer) return;

    const active = this._voices.get(name) ?? 0;
    if (active >= MAX_VOICES_PER_SOUND) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    if (source.detune) source.detune.value = detune;

    const gain = ctx.createGain();
    gain.gain.value = Math.max(0, volume);
    source.connect(gain);

    /** @type {AudioNode} */
    let tail = gain;
    /** @type {PannerNode | null} */
    let panner = null;
    if (position) {
      panner = ctx.createPanner();
      panner.panningModel = PANNER_SETTINGS.panningModel;
      panner.distanceModel = PANNER_SETTINGS.distanceModel;
      panner.refDistance = PANNER_SETTINGS.refDistance;
      panner.rolloffFactor = PANNER_SETTINGS.rolloffFactor;
      panner.maxDistance = PANNER_SETTINGS.maxDistance;
      const [x, y, z] = toXYZ(position);
      if (!setParams(panner, ['positionX', 'positionY', 'positionZ'], [x, y, z])) panner.setPosition(x, y, z);
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(master);

    this._voices.set(name, active + 1);
    source.onended = () => {
      this._voices.set(name, Math.max(0, (this._voices.get(name) ?? 1) - 1));
      source.disconnect();
      gain.disconnect();
      panner?.disconnect();
    };
    source.start();
  }

  /** Sync the listener to the camera's world transform; call once per frame. */
  update() {
    const ctx = this._ctx;
    if (!ctx) return;

    const cam = this.camera;
    cam.updateMatrixWorld();
    const pos = this._tmpPos.setFromMatrixPosition(cam.matrixWorld);
    const fwd = this._tmpFwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
    const up = this._tmpUp.set(0, 1, 0).transformDirection(cam.matrixWorld);

    if (pos.equals(this._listenerPos) && fwd.equals(this._listenerFwd) && up.equals(this._listenerUp)) return;
    this._listenerPos.copy(pos);
    this._listenerFwd.copy(fwd);
    this._listenerUp.copy(up);

    const listener = ctx.listener;
    const hasParams = setParams(listener, ['positionX', 'positionY', 'positionZ'], [pos.x, pos.y, pos.z]);
    if (hasParams) {
      setParams(listener, ['forwardX', 'forwardY', 'forwardZ'], [fwd.x, fwd.y, fwd.z]);
      setParams(listener, ['upX', 'upY', 'upZ'], [up.x, up.y, up.z]);
    } else {
      listener.setPosition(pos.x, pos.y, pos.z);
      listener.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    }
  }

  dispose() {
    this._ready = false;
    this._buffers.clear();
    this._voices.clear();
    const ctx = this._ctx;
    this._ctx = null;
    this._master = null;
    this._unlocking = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  async _init() {
    const Ctor = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : this._masterVolume;
    master.connect(ctx.destination);
    this._ctx = ctx;
    this._master = master;
    this._ready = true;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    // Buffers are synthesised on first play; pre-build the rest in the
    // background, one per task, so the unlocking gesture never stalls a frame.
    for (const name of SOUND_NAMES) {
      if (this._ctx !== ctx) return;
      this._ensureBuffer(name);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (this.sampleBaseUrl && this._ctx === ctx) {
      await Promise.all(SOUND_NAMES.map((name) => this._loadSample(name)));
    }
  }

  /**
   * Synthesised buffer for `name`, built on demand. Null for unknown names.
   * @param {string} name
   * @returns {AudioBuffer | null}
   */
  _ensureBuffer(name) {
    const existing = this._buffers.get(name);
    if (existing) return existing;
    const ctx = this._ctx;
    if (!ctx || !RECIPES[name]) return null;

    const data = synthesize(name, ctx.sampleRate);
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate);
    if (buffer.copyToChannel) buffer.copyToChannel(data, 0);
    else buffer.getChannelData(0).set(data);
    this._buffers.set(name, buffer);
    return buffer;
  }

  /** Fetch + decode `<base>/<name>.wav`; keeps the synthesised buffer on any failure. */
  async _loadSample(name) {
    const ctx = this._ctx;
    if (!ctx) return;
    try {
      const base = String(this.sampleBaseUrl).replace(/\/+$/, '');
      const response = await fetch(`${base}/${name}.wav`);
      if (!response.ok) return;
      const bytes = await response.arrayBuffer();
      const decoded = await new Promise((resolve, reject) => {
        ctx.decodeAudioData(bytes, resolve, reject);
      });
      if (this._ctx === ctx && decoded) this._buffers.set(name, decoded);
    } catch {
      /* synthesized fallback stays in place */
    }
  }

  _applyMasterGain() {
    const ctx = this._ctx;
    const master = this._master;
    if (!ctx || !master) return;
    const target = this._muted ? 0 : this._masterVolume;
    // Short ramp avoids zipper clicks when toggling mute.
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
  }
}

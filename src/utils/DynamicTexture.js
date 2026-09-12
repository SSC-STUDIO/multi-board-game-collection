/**
 * Off-screen canvas tooling for the diegetic props: a CanvasTexture wrapper plus
 * the 2D drawing routines shared by the clock dials, the ink-brushed manual and
 * the fountain-pen score ledger.
 *
 * Browser only at runtime (needs `document`), but the module has no top-level
 * DOM access so it can be imported under Node.
 */
import * as THREE from 'three';

const SYSTEM_CJK_FONTS = '"STXingkai","STKaiti","KaiTi","Noto Serif CJK SC","Songti SC","SimSun",serif';

/**
 * Brush-script font stack used for all ink text. Live binding: importers that
 * read it at call time (all `drawInkText` defaults do) pick up web fonts
 * registered later through `setCjkFonts()`.
 */
export let CJK_FONT_STACK = SYSTEM_CJK_FONTS;
/** Cursive running-script stack for scrolls and couplets (falls back to the main stack). */
export let CJK_CURSIVE_FONT_STACK = SYSTEM_CJK_FONTS;
export const LATIN_HAND_FONT_STACK = '"Segoe Script","Brush Script MT","Bradley Hand","Snell Roundhand",cursive';

/**
 * Put downloaded calligraphy families in front of the system fallbacks.
 * @param {{ kai?: string, xing?: string }} families  e.g. { kai: 'Ma Shan Zheng', xing: 'Zhi Mang Xing' }
 */
export function setCjkFonts({ kai, xing } = {}) {
  if (kai) CJK_FONT_STACK = `"${kai}",${SYSTEM_CJK_FONTS}`;
  if (xing) CJK_CURSIVE_FONT_STACK = `"${xing}",${kai ? `"${kai}",` : ''}${SYSTEM_CJK_FONTS}`;
  else if (kai) CJK_CURSIVE_FONT_STACK = CJK_FONT_STACK;
}

const ROMAN = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Deterministic pseudo-random in [0, 1) so redraws never flicker. */
function hash01(i) {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Re-emit a CSS colour ('#rgb', '#rrggbb', 'rgb()', 'rgba()') with a new alpha. */
function colorWithAlpha(color, alpha) {
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex.slice(0, 6), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').slice(0, 3).map((p) => p.trim());
    return `rgba(${parts.join(',')},${alpha})`;
  }
  return color;
}

/** Split reveal progress into fully drawn characters + alpha of the one being brushed. */
function revealState(progress, count) {
  const reveal = clamp01(progress) * count;
  const full = Math.floor(reveal);
  return { full, partial: reveal - full };
}

// ---------------------------------------------------------------------------
// DynamicTexture
// ---------------------------------------------------------------------------

export class DynamicTexture {
  /**
   * @param {{ width?: number, height?: number, anisotropy?: number, background?: string|null }} [opts]
   */
  constructor({ width = 512, height = 512, anisotropy = 8, background = null } = {}) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    this.clear(background);
  }

  /** Reset to transparent, or fill with `color` when given. */
  clear(color = null) {
    const { ctx, width, height } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.clearRect(0, 0, width, height);
    if (color) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
    }
    this.markDirty();
  }

  markDirty() {
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}

// ---------------------------------------------------------------------------
// Calligraphy ink
// ---------------------------------------------------------------------------

/**
 * Brush-calligraphy text with soft ink bleed and character-by-character reveal.
 * `(x, y)` is the top-left of the text box for `align: 'left'`; `align` decides
 * what `x` anchors to (left edge / centre / right edge) in both orientations.
 * `vertical: true` stacks glyphs top→bottom in one column.
 * @returns {{ width: number, height: number }}
 */
export function drawInkText(ctx, text, x, y, {
  font = CJK_FONT_STACK,
  size = 48,
  color = '#1a1a1a',
  bleed = 3,
  progress = 1,
  letterSpacing = 0,
  vertical = false,
  align = 'left',
  weight = 'bold',
} = {}) {
  const chars = Array.from(text ?? '');
  const n = chars.length;
  if (n === 0) return { width: 0, height: 0 };

  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = vertical ? 'center' : 'left';
  ctx.lineJoin = 'round';

  const advance = vertical
    ? chars.map(() => size * 1.05 + letterSpacing)
    : chars.map((c) => ctx.measureText(c).width + letterSpacing);
  const total = advance.reduce((a, b) => a + b, 0) - letterSpacing;
  const width = vertical ? size : total;
  const height = vertical ? total : size;

  let ox = x;
  if (vertical) {
    if (align === 'left') ox = x + size / 2;
    else if (align === 'right') ox = x - size / 2;
  } else if (align === 'center') ox = x - total / 2;
  else if (align === 'right') ox = x - total;

  const { full, partial } = revealState(progress, n);
  const halo = colorWithAlpha(color, 0.6);
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const alpha = i < full ? 1 : i === full ? partial : 0;
    if (alpha <= 0.001) break;
    const jx = (hash01(i * 3 + 1) - 0.5) * 1.5;
    const jy = (hash01(i * 3 + 2) - 0.5) * 1.5;
    const cx = vertical ? ox + jx : ox + cursor + jx;
    const cy = vertical ? y + size / 2 + cursor + jy : y + size / 2 + jy;
    cursor += advance[i];

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((hash01(i * 3) - 0.5) * 0.05);
    // The glyph currently being brushed settles from slightly enlarged onto the paper.
    const landing = 1 + (1 - alpha) * 0.12;
    ctx.scale(landing, landing);
    ctx.globalAlpha = alpha * 0.22;
    ctx.lineWidth = Math.max(0.5, bleed * 0.7);
    ctx.strokeStyle = color;
    ctx.strokeText(chars[i], 0, 0);
    ctx.globalAlpha = alpha;
    ctx.shadowColor = halo;
    ctx.shadowBlur = bleed;
    ctx.fillStyle = color;
    ctx.fillText(chars[i], 0, 0);
    ctx.restore();
  }
  ctx.restore();
  return { width, height };
}

// ---------------------------------------------------------------------------
// Fountain-pen handwriting
// ---------------------------------------------------------------------------

/**
 * Slanted fountain-pen script with character-by-character reveal.
 * `(x, y)` is the baseline start. Negative `slant` leans the glyphs to the right.
 * @returns {{ width: number }}
 */
export function drawHandwriting(ctx, text, x, y, {
  font = LATIN_HAND_FONT_STACK,
  size = 28,
  color = '#1d2a6b',
  progress = 1,
  slant = -0.12,
} = {}) {
  const chars = Array.from(text ?? '');
  const n = chars.length;
  if (n === 0) return { width: 0 };

  ctx.save();
  ctx.font = `${size}px ${font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0);
  const { full, partial } = revealState(progress, n);

  ctx.translate(x, y);
  ctx.transform(1, 0, slant, 1, 0, 0);
  ctx.fillStyle = color;
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const alpha = i < full ? 1 : i === full ? partial : 0;
    if (alpha <= 0.001) break;
    const wobble = (hash01(i + 17) - 0.5) * size * 0.06;
    ctx.globalAlpha = alpha;
    ctx.fillText(chars[i], cursor, wobble);
    cursor += widths[i];
  }
  ctx.restore();
  return { width: total };
}

// ---------------------------------------------------------------------------
// Vintage clock dial
// ---------------------------------------------------------------------------

function drawHand(ctx, c, angle, length, baseWidth, tipWidth, color, tail = 0) {
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(-baseWidth / 2, tail);
  ctx.lineTo(baseWidth / 2, tail);
  ctx.lineTo(tipWidth / 2, -length);
  ctx.lineTo(-tipWidth / 2, -length);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/**
 * Static part of a dial (rim, face, glow ring, ticks, numerals, label, centre
 * cap) rendered once per distinct look and cached. Everything that involves
 * gradients or shadowBlur lives here so the per-frame path stays cheap.
 * @type {Map<string, HTMLCanvasElement>}
 */
const dialFaceCache = new Map();
const DIAL_FACE_CACHE_LIMIT = 12;

function dialFace(size, active, paused, label) {
  const key = `${size}|${active ? 1 : 0}|${paused ? 1 : 0}|${label}`;
  const cached = dialFaceCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  const s = size / 512;

  ctx.fillStyle = '#2a1c10';
  ctx.fillRect(0, 0, size, size);

  // Brass rim
  const rimR = c - 10 * s;
  const rim = ctx.createLinearGradient(0, 0, size, size);
  rim.addColorStop(0, '#e6c97e');
  rim.addColorStop(0.5, '#9b7430');
  rim.addColorStop(1, '#dcbb6c');
  ctx.beginPath();
  ctx.arc(c, c, rimR, 0, Math.PI * 2);
  ctx.lineWidth = 18 * s;
  ctx.strokeStyle = rim;
  ctx.stroke();

  // Cream face
  const faceR = rimR - 9 * s;
  const face = ctx.createRadialGradient(c, c - faceR * 0.3, faceR * 0.1, c, c, faceR);
  face.addColorStop(0, '#f9f1dd');
  face.addColorStop(0.7, '#efe2c4');
  face.addColorStop(1, '#d6c29a');
  ctx.beginPath();
  ctx.arc(c, c, faceR, 0, Math.PI * 2);
  ctx.fillStyle = face;
  ctx.fill();

  if (active) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, faceR - 7 * s, 0, Math.PI * 2);
    ctx.lineWidth = 10 * s;
    ctx.strokeStyle = 'rgba(255,170,60,0.32)';
    ctx.shadowColor = 'rgba(255,160,40,0.7)';
    ctx.shadowBlur = 16 * s;
    ctx.stroke();
    ctx.restore();
  }

  // Minute ticks
  for (let i = 0; i < 60; i++) {
    const a = (i * Math.PI) / 30;
    const major = i % 5 === 0;
    const r0 = faceR - (major ? 26 : 16) * s;
    const r1 = faceR - 6 * s;
    ctx.beginPath();
    ctx.moveTo(c + Math.sin(a) * r0, c - Math.cos(a) * r0);
    ctx.lineTo(c + Math.sin(a) * r1, c - Math.cos(a) * r1);
    ctx.lineWidth = (major ? 4 : 1.6) * s;
    ctx.strokeStyle = major ? '#2b2116' : '#6b5a3e';
    ctx.stroke();
  }

  // Roman numerals
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#2b2116';
  ctx.font = `bold ${34 * s}px "Times New Roman", Georgia, serif`;
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6;
    const r = faceR - 52 * s;
    ctx.fillText(ROMAN[i], c + Math.sin(a) * r, c - Math.cos(a) * r);
  }

  if (label) {
    ctx.font = `bold ${30 * s}px ${CJK_FONT_STACK}`;
    ctx.fillStyle = '#7a3324';
    ctx.fillText(label, c, c + 64 * s);
  }

  if (dialFaceCache.size >= DIAL_FACE_CACHE_LIMIT) dialFaceCache.delete(dialFaceCache.keys().next().value);
  dialFaceCache.set(key, canvas);
  return canvas;
}

/**
 * Redraw a countdown dial: cached static face + digital readout + hands. The
 * minute hand maps 60 remaining minutes to one revolution; the second hand
 * sweeps smoothly with the fractional second (angle = (remainingSeconds % 60)
 * · π/30). Fills the whole canvas. Cheap enough to run every frame (no
 * gradients or blur on this path).
 */
export function drawClockDial(ctx, { size = 512, remainingMs = 0, active = false, paused = false, label = '' } = {}) {
  const c = size / 2;
  const s = size / 512;
  const ms = Math.max(0, remainingMs || 0);
  const faceR = c - 19 * s;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.drawImage(dialFace(size, active, paused, label), 0, 0);

  // Digital readout below the centre
  const mm = Math.floor(ms / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${24 * s}px "Courier New", Consolas, monospace`;
  ctx.fillStyle = '#3b3020';
  ctx.fillText(`${pad2(mm)}:${pad2(ss)}`, c, c + 100 * s);

  // Hands: a translucent offset copy stands in for the (expensive) blurred drop shadow.
  const minuteAngle = ((ms / 3600000) % 1) * Math.PI * 2;
  const secondAngle = ((ms / 1000) % 60) * (Math.PI / 30);
  ctx.save();
  ctx.translate(2 * s, 3 * s);
  drawHand(ctx, c, minuteAngle, faceR * 0.62, 9 * s, 3 * s, 'rgba(0,0,0,0.22)');
  drawHand(ctx, c, secondAngle, faceR * 0.86, 2.6 * s, 1.2 * s, 'rgba(0,0,0,0.22)', 36 * s);
  ctx.restore();
  drawHand(ctx, c, minuteAngle, faceR * 0.62, 9 * s, 3 * s, '#1a1a1a');
  drawHand(ctx, c, secondAngle, faceR * 0.86, 2.6 * s, 1.2 * s, paused ? '#7a2a1c' : '#b8372a', 36 * s);

  // Centre cap
  ctx.beginPath();
  ctx.arc(c, c, 10 * s, 0, Math.PI * 2);
  ctx.fillStyle = '#b8903c';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c - 2 * s, c - 2 * s, 5 * s, 0, Math.PI * 2);
  ctx.fillStyle = '#f0d68a';
  ctx.fill();
  if (paused) {
    ctx.beginPath();
    ctx.arc(c, c, 6 * s, 0, Math.PI * 2);
    ctx.fillStyle = '#c0392b';
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Light-ink momentum chart
// ---------------------------------------------------------------------------

/**
 * Smoothed "ink landscape" polyline for values in [0, 1] (1 = top of the box),
 * with a soft wash under the curve and a vermilion dot on the final sample.
 */
export function drawInkChart(ctx, values, { x, y, width, height, color = 'rgba(30,30,30,0.45)' } = {}) {
  if (!values || values.length < 2) return;
  const n = values.length;
  const pts = values.map((v, i) => [x + (i / (n - 1)) * width, y + height - clamp01(v) * height]);

  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
  };

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Under-curve wash
  trace();
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x, y + height);
  ctx.closePath();
  const wash = ctx.createLinearGradient(0, y, 0, y + height);
  wash.addColorStop(0, colorWithAlpha(color, 0.28));
  wash.addColorStop(1, colorWithAlpha(color, 0));
  ctx.fillStyle = wash;
  ctx.fill();

  // Mist stroke beneath the crisp line
  trace();
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 7;
  ctx.strokeStyle = color;
  ctx.stroke();

  trace();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Baseline
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + height + 0.5);
  ctx.lineTo(x + width, y + height + 0.5);
  ctx.stroke();

  // Current momentum marker
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(pts[n - 1][0], pts[n - 1][1], 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(170,40,30,0.9)';
  ctx.fill();
  ctx.restore();
}

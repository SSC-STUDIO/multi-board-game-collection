/**
 * Board recognition for the "restore a game from a picture" flow.
 *
 * Local pipeline (no network, runs on raw RGBA pixels so it is testable in Node):
 *   1. grayscale → "dark line" maps (a pixel darker than its local maximum
 *      along one axis) → column / row darkness profiles;
 *   2. the grid period from the profile autocorrelation, then the best
 *      15-line comb (period + offset) per axis → four corner points;
 *   3. per intersection, the median colour of a small disk compared with the
 *      median colour of the neighbouring cell centres (always bare board):
 *      a clearly different, darker sample is a black stone, a brighter one is white.
 *
 * Perspective photos cannot be auto-detected, but `sampleBoard` accepts any
 * four corners (a homography is fitted), so the UI lets the player drag them.
 *
 * Optional cloud pipeline: `recognizeWithVisionModel` sends the image to an
 * OpenAI-compatible vision model and parses the text board it answers with.
 */
import { BOARD_SIZE, EMPTY, BLACK, WHITE } from '../core/rules/Gomoku.js';
import { countStones, parseBoardText } from '../core/rules/Setup.js';

/**
 * @typedef {{ data: Uint8ClampedArray | Uint8Array, width: number, height: number }} RgbaImage
 * @typedef {[number, number]} Point  image pixel coordinates
 * @typedef {{ tl: Point, tr: Point, br: Point, bl: Point }} Corners  outermost grid intersections
 *
 * @typedef {object} GridDetection
 * @property {Corners} corners
 * @property {number} confidence   0..1, product of both axes' comb scores
 * @property {{ x: number, y: number }} period   pixels per cell along each axis
 * @property {boolean} reliable
 *
 * @typedef {object} Recognition
 * @property {number[][]} board
 * @property {Corners} corners
 * @property {number} gridConfidence
 * @property {boolean} gridReliable
 * @property {Float32Array} cellConfidence   per intersection, row-major
 * @property {import('../core/rules/Setup.js').StoneCounts} counts
 * @property {'local'|'llm'} method
 */

const CELLS = BOARD_SIZE;
const LINES = CELLS - 1;
/** A pixel counts as "line" when darker than its local maximum by this much (0..255). */
const LINE_DELTA = 14;
/** Half-width of the local-maximum window: lines up to ~2× this thick register. */
const LOCAL_MAX_RADIUS = 8;
/** Comb fits below this score on either axis are treated as failed detections. */
const MIN_AXIS_CONFIDENCE = 0.16;
/** RGB distance from the local board colour above which an intersection holds a stone. */
const STONE_DISTANCE = 32;
/** Sample disk radius in cells: well inside a stone (~0.45), yet large enough that grid-line pixels stay a minority. */
const SAMPLE_RADIUS = 0.34;
/**
 * Percentile taken per channel over the intersection disk. Above the median so
 * the dark grid cross (up to ~40% of the disk for thick lines) never wins; a
 * black stone is dark everywhere, so it still reads as dark.
 */
const SAMPLE_PERCENTILE = 0.62;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @param {RgbaImage} image @returns {Float32Array} */
export function toGray({ data, width, height }) {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return gray;
}

/**
 * Darkness profiles: colProfile[x] counts pixels in column x that are darker
 * than their horizontal neighbourhood (vertical grid lines); rowProfile[y]
 * likewise for horizontal lines.
 * @param {Float32Array} gray
 */
export function darknessProfiles(gray, width, height) {
  const colProfile = new Float32Array(width);
  const rowProfile = new Float32Array(height);
  const r = LOCAL_MAX_RADIUS;
  const rowMax = new Float32Array(width);
  // Horizontal pass: local max along x.
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      let m = 0;
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(width - 1, x + r);
      for (let k = x0; k <= x1; k++) if (gray[base + k] > m) m = gray[base + k];
      rowMax[x] = m;
    }
    for (let x = 0; x < width; x++) if (gray[base + x] < rowMax[x] - LINE_DELTA) colProfile[x]++;
  }
  // Vertical pass: local max along y.
  const colMax = new Float32Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let m = 0;
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(height - 1, y + r);
      for (let k = y0; k <= y1; k++) if (gray[k * width + x] > m) m = gray[k * width + x];
      colMax[y] = m;
    }
    for (let y = 0; y < height; y++) if (gray[y * width + x] < colMax[y] - LINE_DELTA) rowProfile[y]++;
  }
  return { colProfile, rowProfile };
}

/** 3-tap box smoothing so a comb tooth half a pixel off still scores. */
function smooth3(profile) {
  const n = profile.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (profile[Math.max(0, i - 1)] + profile[i] + profile[Math.min(n - 1, i + 1)]) / 3;
  }
  return out;
}

/**
 * Fundamental period of a quasi-periodic profile: the smallest autocorrelation
 * peak within 60% of the strongest one (so a 2× harmonic never wins).
 * @param {Float32Array} profile
 * @returns {number|null} lag in pixels
 */
export function estimatePeriod(profile, { minLag, maxLag }) {
  const n = profile.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += profile[i];
  mean /= n;
  const ac = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += (profile[i] - mean) * (profile[i + lag] - mean);
    ac[lag] = sum / (n - lag);
  }
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > best) best = ac[lag];
  if (!(best > 0)) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const isPeak = ac[lag] >= (ac[lag - 1] ?? -Infinity) && ac[lag] >= (ac[lag + 1] ?? -Infinity);
    if (isPeak && ac[lag] >= 0.6 * best) return lag;
  }
  return null;
}

/**
 * Sub-pixel refinement: the centroid of the profile mass above half-peak in a
 * window around every interior tooth, then a least-squares line through the
 * centroids. The two outermost lines are skipped because a board edge or frame
 * right next to them produces its own darkness response and drags the centroid
 * outward. Positions are continuous image coordinates (pixel i spans [i, i + 1)).
 */
function refineComb(smoothed, comb) {
  const n = smoothed.length;
  const halfWin = Math.max(2, Math.floor(comb.period * 0.3));
  const ks = [];
  const xs = [];
  for (let k = 1; k < LINES; k++) {
    const centre = comb.offset + k * comb.period;
    const lo = Math.max(0, Math.round(centre - halfWin));
    const hi = Math.min(n - 1, Math.round(centre + halfWin));
    let peak = 0;
    for (let i = lo; i <= hi; i++) if (smoothed[i] > peak) peak = smoothed[i];
    if (peak <= 0) continue;
    let weight = 0;
    let moment = 0;
    for (let i = lo; i <= hi; i++) {
      const w = smoothed[i] - peak * 0.5;
      if (w > 0) {
        weight += w;
        moment += w * (i + 0.5);
      }
    }
    if (weight > 0) {
      ks.push(k);
      xs.push(moment / weight);
    }
  }
  if (ks.length < 8) return comb;
  const m = ks.length;
  let sk = 0;
  let sx = 0;
  let skk = 0;
  let skx = 0;
  for (let i = 0; i < m; i++) {
    sk += ks[i];
    sx += xs[i];
    skk += ks[i] * ks[i];
    skx += ks[i] * xs[i];
  }
  const denom = m * skk - sk * sk;
  if (Math.abs(denom) < 1e-9) return comb;
  const period = (m * skx - sk * sx) / denom;
  const offset = (sx - period * sk) / m;
  return { offset, period, score: comb.score };
}

/**
 * Best 15-tooth comb (offset + period) over a smoothed profile, refined to
 * sub-pixel line centres.
 * @returns {{ offset: number, period: number, score: number } | null}
 */
export function fitComb(profile, approxPeriod) {
  const smoothed = smooth3(profile);
  const n = smoothed.length;
  let peak = 0;
  for (let i = 0; i < n; i++) if (smoothed[i] > peak) peak = smoothed[i];
  if (peak <= 0) return null;
  let best = null;
  for (let period = approxPeriod - 2.5; period <= approxPeriod + 2.5; period += 0.1) {
    const span = period * LINES;
    if (span >= n) continue;
    for (let offset = 0; offset + span < n; offset += 0.5) {
      let sum = 0;
      for (let k = 0; k <= LINES; k++) sum += smoothed[Math.round(offset + k * period)];
      if (!best || sum > best.sum) best = { offset, period, sum };
    }
  }
  if (!best) return null;
  return refineComb(smoothed, { offset: best.offset, period: best.period, score: best.sum / ((LINES + 1) * peak) });
}

// ---------------------------------------------------------------------------
// grid detection
// ---------------------------------------------------------------------------

/** Corners of a grid that fills the image with a small margin (fallback when detection fails). */
export function defaultCorners(width, height) {
  const side = Math.min(width, height) * 0.92;
  const x0 = (width - side) / 2;
  const y0 = (height - side) / 2;
  return { tl: [x0, y0], tr: [x0 + side, y0], br: [x0 + side, y0 + side], bl: [x0, y0 + side] };
}

/**
 * @param {RgbaImage} image
 * @returns {GridDetection}
 */
export function detectGrid(image) {
  const { width, height } = image;
  const gray = toGray(image);
  const { colProfile, rowProfile } = darknessProfiles(gray, width, height);
  const axis = (profile, length) => {
    const minLag = Math.max(4, Math.floor(length / 60));
    const maxLag = Math.floor(length / LINES);
    if (maxLag <= minLag) return null;
    const period = estimatePeriod(profile, { minLag, maxLag });
    if (period == null) return null;
    return fitComb(profile, period);
  };
  const fx = axis(colProfile, width);
  const fy = axis(rowProfile, height);
  const fallback = { corners: defaultCorners(width, height), confidence: 0, period: { x: 0, y: 0 }, reliable: false };
  if (!fx || !fy) return fallback;

  const ratio = fx.period / fy.period;
  const consistent = ratio > 0.8 && ratio < 1.25;
  const confidence = Math.sqrt(fx.score * fy.score);
  const reliable = consistent && fx.score >= MIN_AXIS_CONFIDENCE && fy.score >= MIN_AXIS_CONFIDENCE;
  if (!reliable) return { ...fallback, confidence };

  const x0 = fx.offset;
  const x1 = fx.offset + fx.period * LINES;
  const y0 = fy.offset;
  const y1 = fy.offset + fy.period * LINES;
  return {
    corners: { tl: [x0, y0], tr: [x1, y0], br: [x1, y1], bl: [x0, y1] },
    confidence,
    period: { x: fx.period, y: fy.period },
    reliable: true,
  };
}

// ---------------------------------------------------------------------------
// homography + sampling
// ---------------------------------------------------------------------------

/** Solve A·x = b (n×n) by Gaussian elimination with partial pivoting. */
function solveLinear(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * Planar homography through four point pairs; returns `(x, y) => [x', y']`.
 * Falls back to bilinear interpolation of the destination quad when the
 * points are degenerate (e.g. three corners on a line).
 * @param {Point[]} src  four points
 * @param {Point[]} dst  four points, same order
 */
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  const h = solveLinear(A, b);
  if (!h) {
    const [tl, tr, br, bl] = dst;
    const [s0] = src;
    const su = src[1][0] - s0[0] || 1;
    const sv = src[3][1] - s0[1] || 1;
    return (x, y) => {
      const u = (x - s0[0]) / su;
      const v = (y - s0[1]) / sv;
      const top = [tl[0] + (tr[0] - tl[0]) * u, tl[1] + (tr[1] - tl[1]) * u];
      const bottom = [bl[0] + (br[0] - bl[0]) * u, bl[1] + (br[1] - bl[1]) * u];
      return [top[0] + (bottom[0] - top[0]) * v, top[1] + (bottom[1] - top[1]) * v];
    };
  }
  return (x, y) => {
    const w = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  };
}

const UNIT_SQUARE = /** @type {Point[]} */ ([[0, 0], [1, 0], [1, 1], [0, 1]]);

/** @param {Corners} corners @returns {Point[]} tl, tr, br, bl */
export function cornersToQuad(corners) {
  return [corners.tl, corners.tr, corners.br, corners.bl];
}

/**
 * Maps unit-grid coordinates (u = col / 14, v = row / 14) to the image quad.
 * @param {Corners} corners
 */
export function gridToImageMapper(corners) {
  return homography(UNIT_SQUARE, cornersToQuad(corners));
}

/** Inverse of `gridToImageMapper`: image pixel → unit-grid coordinates. */
export function imageToGridMapper(corners) {
  return homography(cornersToQuad(corners), UNIT_SQUARE);
}

/**
 * Per-channel percentile colour of the pixels inside a disk (optionally
 * filtered by `accept(x, y)`); null when fewer than three pixels qualify.
 */
function percentileDisk(image, cx, cy, radius, scratch, { percentile = 0.5, accept = null } = {}) {
  const { data, width, height } = image;
  const r = Math.max(1, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  let n = 0;
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      if (accept && !accept(x, y)) continue;
      const p = (y * width + x) * 4;
      scratch.r[n] = data[p];
      scratch.g[n] = data[p + 1];
      scratch.b[n] = data[p + 2];
      n++;
    }
  }
  if (n < 3) return null;
  const rank = Math.min(n - 1, Math.floor(n * percentile));
  const pick = (arr) => {
    const view = arr.subarray(0, n);
    view.sort();
    return view[rank];
  };
  return [pick(scratch.r), pick(scratch.g), pick(scratch.b)];
}

const luma = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const chroma = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Classify every intersection of the quad `corners` on `image`.
 * @param {RgbaImage} image
 * @param {Corners} corners
 * @returns {{ board: number[][], cellConfidence: Float32Array }}
 */
export function sampleBoard(image, corners) {
  const map = gridToImageMapper(corners);
  const unmap = imageToGridMapper(corners);
  const board = [];
  const cellConfidence = new Float32Array(CELLS * CELLS);
  const scratchSize = 64 * 64;
  const scratch = { r: new Uint8Array(scratchSize), g: new Uint8Array(scratchSize), b: new Uint8Array(scratchSize) };
  const step = 1 / LINES;
  // Edge intersections: half the disk would lie on the board frame / table, so only pixels inside the grid
  // (a hair inward of the outermost line) count.
  const inset = 0.03 * step;
  const insideGrid = (x, y) => {
    const [u, v] = unmap(x + 0.5, y + 0.5);
    return u >= inset && u <= 1 - inset && v >= inset && v <= 1 - inset;
  };

  for (let row = 0; row < CELLS; row++) {
    const cells = [];
    for (let col = 0; col < CELLS; col++) {
      const u = col * step;
      const v = row * step;
      const [cx, cy] = map(u, v);
      // Local cell size from the neighbouring intersections (handles perspective foreshortening).
      const [nx, ny] = map(col < LINES ? u + step : u - step, v);
      const [mx, my] = map(u, row < LINES ? v + step : v - step);
      const cell = Math.min(Math.hypot(nx - cx, ny - cy), Math.hypot(mx - cx, my - cy));
      const stoneRadius = Math.min(31, cell * SAMPLE_RADIUS);
      const onEdge = row === 0 || col === 0 || row === LINES || col === LINES;
      const sample = percentileDisk(image, cx, cy, stoneRadius, scratch, { percentile: SAMPLE_PERCENTILE, accept: onEdge ? insideGrid : null });

      // Background reference: the centres of the (up to four) adjacent cells are never covered by a stone.
      const bgSamples = [];
      for (const du of [-0.5, 0.5]) {
        for (const dv of [-0.5, 0.5]) {
          const uu = u + du * step;
          const vv = v + dv * step;
          if (uu < 0 || uu > 1 || vv < 0 || vv > 1) continue;
          const [bx, by] = map(uu, vv);
          const s = percentileDisk(image, bx, by, Math.min(15, cell * 0.14), scratch);
          if (s) bgSamples.push(s);
        }
      }
      let value = EMPTY;
      let confidence = 0;
      if (sample && bgSamples.length) {
        const bg = [0, 1, 2].map((ch) => {
          const vals = bgSamples.map((s) => s[ch]).sort((a, b) => a - b);
          return vals[vals.length >> 1];
        });
        // Presence: colour distance, or loss of saturation (stones are grey, wood is not);
        // a shaded white stone on a pale board is barely brighter than the wood, so
        // brightness only decides the colour.
        const d = Math.max(dist(sample, bg), Math.abs(chroma(sample) - chroma(bg)));
        if (d > STONE_DISTANCE) {
          const ls = luma(sample);
          const dl = ls - luma(bg);
          // Near board brightness the sign is noise (shaded white on pale wood, black on a dark theme):
          // then a bright stone can only be white and a dark one black.
          value = Math.abs(dl) >= 20 ? (dl < 0 ? BLACK : WHITE) : (ls >= 128 ? WHITE : BLACK);
          confidence = Math.min(1, d / (STONE_DISTANCE * 2.5));
        } else {
          confidence = Math.min(1, Math.max(0, 1 - d / STONE_DISTANCE));
        }
      }
      cells.push(value);
      cellConfidence[row * CELLS + col] = confidence;
    }
    board.push(cells);
  }
  return { board, cellConfidence };
}

/**
 * Full local pipeline.
 * @param {RgbaImage} image
 * @param {{ corners?: Corners }} [options]  skip detection and sample the given quad
 * @returns {Recognition}
 */
export function recognizeBoard(image, { corners = null } = {}) {
  const detection = corners ? null : detectGrid(image);
  const quad = corners ?? /** @type {GridDetection} */ (detection).corners;
  const { board, cellConfidence } = sampleBoard(image, quad);
  return {
    board,
    corners: quad,
    gridConfidence: detection ? detection.confidence : 1,
    gridReliable: detection ? detection.reliable : true,
    cellConfidence,
    counts: countStones(board),
    method: 'local',
  };
}

// ---------------------------------------------------------------------------
// vision model (optional)
// ---------------------------------------------------------------------------

const VISION_PROMPT =
  '这张图片是一盘 15×15 五子棋（或五子棋截图）。请把棋盘上的局面转写为 15 行文本，每行 15 个字符：' +
  '黑子写 X，白子写 O，空点写 .，从棋盘最上面一行到最下面一行，从左到右。只输出这 15 行，不要输出其他内容。';

/**
 * Ask an OpenAI-compatible vision model for the position.
 * @param {string} imageDataUrl  data:image/...;base64,...
 * @param {{ endpoint: string, apiKey?: string|null, model?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ board: number[][], raw: string }>}  rejects on network / parse failure
 */
export async function recognizeWithVisionModel(imageDataUrl, { endpoint, apiKey = null, model = 'gpt-4o-mini', timeoutMs = 25_000, fetchImpl = globalThis.fetch } = /** @type {any} */ ({})) {
  if (!endpoint) throw new Error('No vision endpoint configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new Error(`Vision model responded ${response.status}`);
    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content;
    const raw = typeof text === 'string' ? text : '';
    const board = parseBoardText(raw.replace(/```[a-zA-Z]*/g, ''));
    if (!board) throw new Error('Vision model reply did not contain a 15×15 board');
    return { board, raw };
  } finally {
    clearTimeout(timer);
  }
}

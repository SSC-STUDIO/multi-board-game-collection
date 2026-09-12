import { describe, it, expect } from 'vitest';
import { BLACK, WHITE, createEmptyBoard, boardToText } from '../src/core/index.js';
import {
  detectGrid, sampleBoard, recognizeBoard, estimatePeriod, fitComb, homography, gridToImageMapper, imageToGridMapper,
  defaultCorners, recognizeWithVisionModel,
} from '../src/services/BoardVision.js';

// ---------------------------------------------------------------------------
// Synthetic board renderer (pure pixel pushing, no canvas)
// ---------------------------------------------------------------------------

/** Deterministic LCG so noisy renders are reproducible. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DEFAULT_COLORS = {
  outside: [28, 22, 18],
  frame: [150, 105, 60],
  bg: [221, 179, 112],
  line: [58, 36, 16],
  black: [24, 24, 26],
  white: [243, 240, 232],
};

/**
 * Colour of the ideal board at grid coordinates (u, v) in cells (0..14), or
 * null when outside the board (frame included).
 */
function boardColorAt(board, u, v, { lineHalf, stoneRadius, colors, frame }) {
  if (u < -frame || u > 14 + frame || v < -frame || v > 14 + frame) return colors.outside;
  if (u < 0 || u > 14 || v < 0 || v > 14) return colors.frame;
  const col = Math.round(u);
  const row = Math.round(v);
  const du = u - col;
  const dv = v - row;
  const d = Math.hypot(du, dv);
  if (d <= stoneRadius) {
    const stone = board[row][col];
    if (stone === BLACK || stone === WHITE) {
      // Simple sphere shading: brighter toward the upper-left, darker rim.
      const shade = 1 - 0.35 * (d / stoneRadius) ** 2 + 0.12 * (-du - dv);
      const base = stone === BLACK ? colors.black : colors.white;
      return base.map((c) => Math.max(0, Math.min(255, c * shade + (stone === BLACK ? 30 * (1 - d / stoneRadius) : 0))));
    }
  }
  const onLine = Math.abs(du) <= lineHalf || Math.abs(dv) <= lineHalf;
  return onLine ? colors.line : colors.bg;
}

/**
 * Render `board` into an RGBA buffer. `imageToGrid(x, y)` maps pixel → grid
 * coordinates in cells, which lets the same renderer produce axis-aligned and
 * perspective-warped pictures.
 */
function render({ board, width, height, imageToGrid, lineHalf = 0.04, stoneRadius = 0.44, colors = DEFAULT_COLORS, frame = 0.6, noise = 0, seed = 7 }) {
  const data = new Uint8ClampedArray(width * height * 4);
  const random = rng(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = imageToGrid(x + 0.5, y + 0.5);
      const c = boardColorAt(board, u, v, { lineHalf, stoneRadius, colors, frame });
      const p = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const n = noise ? (random() - 0.5) * 2 * noise : 0;
        data[p + ch] = Math.max(0, Math.min(255, Math.round(c[ch] + n)));
      }
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Axis-aligned board with cells of `cell` px and the top-left intersection at (ox, oy). */
function renderFlat(board, { cell, ox, oy, width, height, ...rest }) {
  return render({ board, width, height, imageToGrid: (x, y) => [(x - ox) / cell, (y - oy) / cell], ...rest });
}

function positionWith(stones) {
  const board = createEmptyBoard();
  for (const [row, col, player] of stones) board[row][col] = player;
  return board;
}

const MIDGAME = positionWith([
  [7, 7, BLACK], [7, 8, WHITE], [8, 7, BLACK], [6, 8, WHITE], [8, 8, BLACK], [9, 9, WHITE],
  [6, 6, BLACK], [5, 5, WHITE], [8, 6, BLACK], [9, 6, WHITE], [10, 10, BLACK], [4, 4, WHITE],
  [0, 0, BLACK], [14, 14, WHITE], [0, 14, BLACK], [14, 0, WHITE], [7, 0, BLACK], [0, 7, WHITE],
]);

const diffCells = (a, b) => {
  const out = [];
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) if (a[r][c] !== b[r][c]) out.push(`${r},${c}:${a[r][c]}→${b[r][c]}`);
  return out;
};

// ---------------------------------------------------------------------------

describe('BoardVision: signal helpers', () => {
  it('recovers the fundamental period of a comb, not a harmonic', () => {
    const profile = new Float32Array(600);
    for (let k = 0; k < 15; k++) profile[40 + k * 36] = 100;
    expect(estimatePeriod(profile, { minLag: 8, maxLag: 60 })).toBe(36);
    const comb = fitComb(profile, 36);
    expect(comb.period).toBeCloseTo(36, 0);
    // Continuous coordinates: an impulse in pixel 40 is centred at 40.5.
    expect(comb.offset).toBeCloseTo(40.5, 0);
    expect(comb.score).toBeGreaterThan(0.3);
  });

  it('returns null for flat profiles', () => {
    expect(estimatePeriod(new Float32Array(300), { minLag: 8, maxLag: 40 })).toBeNull();
    expect(fitComb(new Float32Array(300), 20)).toBeNull();
  });

  it('fits an exact homography and its inverse', () => {
    const corners = { tl: [80, 60], tr: [520, 90], br: [560, 540], bl: [40, 500] };
    const fwd = gridToImageMapper(corners);
    const inv = imageToGridMapper(corners);
    expect(fwd(0, 0).map(Math.round)).toEqual([80, 60]);
    expect(fwd(1, 1).map(Math.round)).toEqual([560, 540]);
    const [x, y] = fwd(0.25, 0.75);
    const [u, v] = inv(x, y);
    expect(u).toBeCloseTo(0.25, 6);
    expect(v).toBeCloseTo(0.75, 6);
    const affine = homography([[0, 0], [1, 0], [1, 1], [0, 1]], [[10, 10], [20, 10], [20, 20], [10, 20]]);
    expect(affine(0.5, 0.5).map((n) => Math.round(n * 1000) / 1000)).toEqual([15, 15]);
  });
});

describe('BoardVision: local recognition', () => {
  it('reads a clean screenshot-like board exactly', () => {
    const image = renderFlat(MIDGAME, { cell: 36, ox: 30, oy: 30, width: 564, height: 564 });
    const grid = detectGrid(image);
    expect(grid.reliable).toBe(true);
    expect(grid.corners.tl[0]).toBeCloseTo(30, -0.5);
    expect(grid.corners.tl[1]).toBeCloseTo(30, -0.5);
    expect(grid.corners.br[0]).toBeCloseTo(30 + 14 * 36, -0.5);
    expect(grid.period.x).toBeCloseTo(36, 0);

    const result = recognizeBoard(image);
    expect(diffCells(MIDGAME, result.board)).toEqual([]);
    expect(result.counts).toMatchObject({ black: 9, white: 9 });
    expect(result.method).toBe('local');
  });

  it('handles an off-centre board with a frame, thick lines and sensor noise', () => {
    const image = renderFlat(MIDGAME, { cell: 41, ox: 133, oy: 71, width: 900, height: 720, lineHalf: 0.06, noise: 7, seed: 3 });
    const result = recognizeBoard(image);
    expect(result.gridReliable).toBe(true);
    expect(result.corners.tl[0]).toBeCloseTo(133, -0.5);
    expect(result.corners.tl[1]).toBeCloseTo(71, -0.5);
    expect(diffCells(MIDGAME, result.board)).toEqual([]);
  });

  it('separates white stones from a pale board and black stones from a dark one', () => {
    const pale = { ...DEFAULT_COLORS, bg: [238, 226, 196], line: [90, 70, 40], white: [252, 252, 250] };
    const onPale = recognizeBoard(renderFlat(MIDGAME, { cell: 30, ox: 22, oy: 22, width: 470, height: 470, colors: pale }));
    expect(onPale.gridReliable).toBe(true);
    expect(diffCells(MIDGAME, onPale.board)).toEqual([]);

    const dark = { ...DEFAULT_COLORS, bg: [70, 60, 50], line: [20, 15, 10], black: [8, 8, 8], frame: [40, 35, 30] };
    const onDark = recognizeBoard(renderFlat(MIDGAME, { cell: 30, ox: 22, oy: 22, width: 470, height: 470, colors: dark }));
    expect(onDark.gridReliable).toBe(true);
    expect(diffCells(MIDGAME, onDark.board)).toEqual([]);
  });

  it('reads an empty board as empty', () => {
    const result = recognizeBoard(renderFlat(createEmptyBoard(), { cell: 30, ox: 22, oy: 22, width: 470, height: 470 }));
    expect(result.gridReliable).toBe(true);
    expect(result.counts.total).toBe(0);
  });

  it('samples a perspective photo correctly once the corners are given', () => {
    const corners = { tl: [95, 70], tr: [540, 105], br: [575, 560], bl: [50, 505] };
    const toGrid = imageToGridMapper(corners);
    const image = render({
      board: MIDGAME, width: 640, height: 640, noise: 4,
      imageToGrid: (x, y) => {
        const [u, v] = toGrid(x, y);
        return [u * 14, v * 14];
      },
    });
    const { board } = sampleBoard(image, corners);
    expect(diffCells(MIDGAME, board)).toEqual([]);
    const withCorners = recognizeBoard(image, { corners });
    expect(withCorners.gridReliable).toBe(true);
    expect(withCorners.gridConfidence).toBe(1);
  });

  it('reports an unreliable grid for a picture without a board and falls back to default corners', () => {
    const width = 400;
    const height = 300;
    const data = new Uint8ClampedArray(width * height * 4);
    const random = rng(11);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 120 + random() * 40;
      data[i + 1] = 100 + random() * 40;
      data[i + 2] = 80 + random() * 40;
      data[i + 3] = 255;
    }
    const grid = detectGrid({ data, width, height });
    expect(grid.reliable).toBe(false);
    expect(grid.corners).toEqual(defaultCorners(width, height));
  });
});

describe('BoardVision: vision model client', () => {
  const reply = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

  it('parses a text board from the model reply (tolerating code fences)', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return reply('```\n' + boardToText(MIDGAME) + '\n```');
    };
    const result = await recognizeWithVisionModel('data:image/png;base64,AAAA', { endpoint: 'https://example.test/v1/chat/completions', apiKey: 'k', model: 'vision-x', fetchImpl });
    expect(result.board).toEqual(MIDGAME);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.test/v1/chat/completions');
    expect(calls[0].auth).toBe('Bearer k');
    expect(calls[0].body.model).toBe('vision-x');
    expect(calls[0].body.messages[0].content[1].image_url.url).toBe('data:image/png;base64,AAAA');
  });

  it('rejects on HTTP errors, unusable replies and a missing endpoint', async () => {
    await expect(recognizeWithVisionModel('data:', { endpoint: 'x', fetchImpl: async () => ({ ok: false, status: 500 }) })).rejects.toThrow(/500/);
    await expect(recognizeWithVisionModel('data:', { endpoint: 'x', fetchImpl: async () => reply('I cannot see a board.') })).rejects.toThrow(/15×15/);
    await expect(recognizeWithVisionModel('data:', { endpoint: null })).rejects.toThrow(/endpoint/);
  });
});

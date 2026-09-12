/**
 * Renju forbidden-move engine (black only): double-three, double-four, overline.
 * Analysis runs on an 11-cell window centred on the candidate point per axis, so
 * input boards are never mutated. Flat-board variants are exposed for the AI.
 * @module core/rules/Renju
 */
import { BLACK, EMPTY, DIRECTIONS, toFlatBoard } from './Gomoku.js';

export const FORBIDDEN = Object.freeze({
  DOUBLE_THREE: 'DOUBLE_THREE',
  DOUBLE_FOUR: 'DOUBLE_FOUR',
  OVERLINE: 'OVERLINE',
});

/** @typedef {{ forbidden: boolean, reason: 'DOUBLE_THREE'|'DOUBLE_FOUR'|'OVERLINE'|null }} Verdict */
/** @typedef {{ fives: number, fours: number, openThrees: number, overline: boolean }} PointAnalysis */

const WALL = -1;
const HALF = 5;
const WIN = 2 * HALF + 1;
/** Recursion limit for "is the extension point of a three itself forbidden". */
const MAX_DEPTH = 2;

const NOT_FORBIDDEN = Object.freeze({ forbidden: false, reason: null });
const VERDICTS = Object.freeze({
  DOUBLE_THREE: Object.freeze({ forbidden: true, reason: FORBIDDEN.DOUBLE_THREE }),
  DOUBLE_FOUR: Object.freeze({ forbidden: true, reason: FORBIDDEN.DOUBLE_FOUR }),
  OVERLINE: Object.freeze({ forbidden: true, reason: FORBIDDEN.OVERLINE }),
});

/** Copies the 11 cells centred on (row, col) along an axis into `out`; off-board cells become WALL. */
function extractLine(flat, size, row, col, dRow, dCol, out) {
  for (let k = -HALF; k <= HALF; k++) {
    const r = row + k * dRow;
    const c = col + k * dCol;
    out[k + HALF] = r < 0 || r >= size || c < 0 || c >= size ? WALL : flat[r * size + c];
  }
  return out;
}

function runStart(line, player) {
  let s = HALF;
  while (s > 0 && line[s - 1] === player) s--;
  return s;
}

function runEnd(line, player) {
  let e = HALF;
  while (e < WIN - 1 && line[e + 1] === player) e++;
  return e;
}

/**
 * Fours created on this axis: completion points that turn the shape into a five
 * containing the centre. A straight four `_XXXX_` has two completions but is one four.
 */
function countFoursInLine(line, player, exact) {
  let count = 0;
  for (let p = 1; p < WIN - 1; p++) {
    if (line[p] !== EMPTY) continue;
    line[p] = player;
    const s = runStart(line, player);
    const e = runEnd(line, player);
    line[p] = EMPTY;
    const len = e - s + 1;
    if (p >= s && p <= e && (exact ? len === 5 : len >= 5)) count++;
  }
  if (count === 2 && runEnd(line, player) - runStart(line, player) === 3) return 1;
  return count;
}

/**
 * True when some empty point on this axis turns the centre's shape into a straight
 * four (both ends empty, both completions exact when `exact`). `isForbiddenAt`
 * (offset from centre → boolean) rejects extension points that are themselves forbidden.
 */
function hasOpenThreeInLine(line, player, exact, isForbiddenAt) {
  for (let p = 1; p < WIN - 1; p++) {
    if (line[p] !== EMPTY) continue;
    line[p] = player;
    const s = runStart(line, player);
    const e = runEnd(line, player);
    line[p] = EMPTY;
    if (e - s !== 3 || p < s || p > e) continue;
    if (line[s - 1] !== EMPTY || line[e + 1] !== EMPTY) continue;
    if (exact && (line[s - 2] === player || line[e + 2] === player)) continue;
    if (isForbiddenAt && isForbiddenAt(p - HALF)) continue;
    return true;
  }
  return false;
}

/**
 * Full point analysis on a flat board. The point is treated as occupied by `player`
 * regardless of its current content; the board is restored before returning.
 * @returns {PointAnalysis}
 */
function analyzeFlat(flat, size, row, col, player, exact, depth) {
  const idx = row * size + col;
  const saved = flat[idx];
  flat[idx] = player;
  const line = new Int8Array(WIN);
  let fives = 0;
  let fours = 0;
  let openThrees = 0;
  let overline = false;
  for (const [dRow, dCol] of DIRECTIONS) {
    extractLine(flat, size, row, col, dRow, dCol, line);
    const len = runEnd(line, player) - runStart(line, player) + 1;
    if (len >= 6) overline = true;
    if (exact ? len === 5 : len >= 5) fives++;
    fours += countFoursInLine(line, player, exact);
    const check = exact && depth < MAX_DEPTH
      ? (offset) => isForbiddenFlat(flat, size, row + offset * dRow, col + offset * dCol, depth + 1).forbidden
      : null;
    if (hasOpenThreeInLine(line, player, exact, check)) openThrees++;
  }
  flat[idx] = saved;
  return { fives, fours, openThrees, overline };
}

/**
 * Forbidden-move verdict for black playing (row, col) on a flat Int8Array board.
 * Five takes precedence over every prohibition; then overline, double-four, double-three.
 * @param {Int8Array} flat
 * @param {number} size
 * @returns {Verdict}
 */
export function isForbiddenFlat(flat, size, row, col, depth = 0) {
  const idx = row * size + col;
  const saved = flat[idx];
  flat[idx] = BLACK;
  const line = new Int8Array(WIN);
  let overline = false;
  let fours = 0;
  for (const [dRow, dCol] of DIRECTIONS) {
    extractLine(flat, size, row, col, dRow, dCol, line);
    const len = runEnd(line, BLACK) - runStart(line, BLACK) + 1;
    if (len === 5) {
      flat[idx] = saved;
      return NOT_FORBIDDEN;
    }
    if (len >= 6) {
      overline = true;
      continue;
    }
    fours += countFoursInLine(line, BLACK, true);
  }
  let verdict = NOT_FORBIDDEN;
  if (overline) {
    verdict = VERDICTS.OVERLINE;
  } else if (fours >= 2) {
    verdict = VERDICTS.DOUBLE_FOUR;
  } else {
    let threes = 0;
    for (const [dRow, dCol] of DIRECTIONS) {
      extractLine(flat, size, row, col, dRow, dCol, line);
      const check = depth < MAX_DEPTH
        ? (offset) => isForbiddenFlat(flat, size, row + offset * dRow, col + offset * dCol, depth + 1).forbidden
        : null;
      if (hasOpenThreeInLine(line, BLACK, true, check) && ++threes >= 2) {
        verdict = VERDICTS.DOUBLE_THREE;
        break;
      }
    }
  }
  flat[idx] = saved;
  return verdict;
}

/** Placing `player` at (row, col) makes exactly five in some direction. */
export function makesExactFive(board, row, col, player) {
  return analyzeFlat(toFlatBoard(board), board.length, row, col, player, true, MAX_DEPTH).fives > 0;
}

/** Placing `player` at (row, col) makes six or more in some direction. */
export function makesOverline(board, row, col, player) {
  return analyzeFlat(toFlatBoard(board), board.length, row, col, player, true, MAX_DEPTH).overline;
}

/**
 * Number of fours black would create by playing (row, col). Per axis: completion
 * points yielding an exact five through the point; a straight four counts once.
 * @returns {number}
 */
export function countFours(board, row, col) {
  return analyzeFlat(toFlatBoard(board), board.length, row, col, BLACK, true, MAX_DEPTH).fours;
}

/**
 * Number of open threes black would create by playing (row, col). A three only
 * counts when some non-forbidden extension point turns it into a straight four.
 * At most one three per axis.
 * @returns {number}
 */
export function countOpenThrees(board, row, col, depth = 0) {
  return analyzeFlat(toFlatBoard(board), board.length, row, col, BLACK, true, depth).openThrees;
}

/**
 * Forbidden-move verdict for black playing (row, col).
 * @param {number[][]} board
 * @returns {Verdict}
 */
export function isForbidden(board, row, col, depth = 0) {
  return isForbiddenFlat(toFlatBoard(board), board.length, row, col, depth);
}

/**
 * Shape summary of a hypothetical move, for AI heuristics. Black uses exact-five
 * (Renju) semantics; white uses loose semantics where five or more wins.
 * @returns {PointAnalysis}
 */
export function analyzePoint(board, row, col, player) {
  return analyzeFlat(toFlatBoard(board), board.length, row, col, player, player === BLACK, 0);
}

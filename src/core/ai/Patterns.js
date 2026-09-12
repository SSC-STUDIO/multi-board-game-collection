/**
 * Line-pattern scoring and flat-board shape helpers shared by the evaluator,
 * the search position and the move picker.
 * @module core/ai/Patterns
 */
import { BLACK, EMPTY, DIRECTIONS } from '../rules/Gomoku.js';
import { RuleMode } from '../state/GameState.js';

export const SCORE = Object.freeze({
  FIVE: 10_000_000,
  OPEN_FOUR: 1_000_000,
  FOUR: 100_000,
  OPEN_THREE: 10_000,
  THREE: 1_000,
  OPEN_TWO: 100,
  TWO: 10,
  ONE: 1,
});

/** Opponent material is weighted slightly higher so the engine prefers blocking. */
export const DEFENSE_WEIGHT = 1.1;
const WALL = -1;

/**
 * Scores one shape: `k` stones spanning [s, e] with `g` single-cell gaps inside.
 * Off-line cells count as blocked. `exact` applies Renju black semantics
 * (overline is worthless, a completion must yield exactly five).
 */
function shapeScore(cells, s, e, k, g, player, exact) {
  const n = cells.length;
  const l1 = s - 1 >= 0 ? cells[s - 1] : WALL;
  const l2 = s - 2 >= 0 ? cells[s - 2] : WALL;
  const r1 = e + 1 < n ? cells[e + 1] : WALL;
  const r2 = e + 2 < n ? cells[e + 2] : WALL;
  const leftE = l1 === EMPTY;
  const rightE = r1 === EMPTY;
  const leftRoom = leftE && l2 === EMPTY;
  const rightRoom = rightE && r2 === EMPTY;

  if (g === 0) {
    if (k >= 5) return exact && k !== 5 ? 0 : SCORE.FIVE;
    if (k === 4) {
      const lOk = leftE && !(exact && l2 === player);
      const rOk = rightE && !(exact && r2 === player);
      if (lOk && rOk) return SCORE.OPEN_FOUR;
      return lOk || rOk ? SCORE.FOUR : 0;
    }
    if (k === 3) {
      if (leftE && rightE) return leftRoom || rightRoom ? SCORE.OPEN_THREE : SCORE.THREE;
      return leftRoom || rightRoom ? SCORE.THREE : 0;
    }
    if (k === 2) {
      if (leftE && rightE) return leftRoom || rightRoom ? SCORE.OPEN_TWO : SCORE.TWO;
      return leftRoom || rightRoom ? SCORE.TWO : 0;
    }
    return leftE || rightE ? SCORE.ONE : 0;
  }
  if (g === 1) {
    if (k === 4) return SCORE.FOUR;
    if (k === 3) {
      if (leftE && rightE) return exact && (l2 === player || r2 === player) ? SCORE.THREE : SCORE.OPEN_THREE;
      return leftE || rightE ? SCORE.THREE : 0;
    }
    if (leftE && rightE) return SCORE.OPEN_TWO;
    return leftE || rightE ? SCORE.TWO : 0;
  }
  return SCORE.THREE; // X_X_X: two single gaps inside a five-window
}

/**
 * Pattern score of one line (values 0/1/2) for `player`. Runs separated by a
 * single empty cell are merged while the shape still fits a five-window.
 * @param {ArrayLike<number>} cells
 * @param {number} player
 * @param {string} [mode] RuleMode; RENJU applies exact-five semantics for black.
 * @returns {number}
 */
export function evaluateLine(cells, player, mode = RuleMode.STANDARD) {
  const exact = mode === RuleMode.RENJU && player === BLACK;
  const n = cells.length;
  let score = 0;
  let i = 0;
  while (i < n) {
    if (cells[i] !== player) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && cells[i] === player) i++;
    let end = i - 1;
    let stones = end - start + 1;
    let gaps = 0;
    let consumed = false;
    while (i + 1 < n && cells[i] === EMPTY && cells[i + 1] === player) {
      let j = i + 1;
      while (j < n && cells[j] === player) j++;
      const nextStones = j - i - 1;
      if (stones >= 5 || nextStones >= 5) break; // a five scores on its own
      if (stones + nextStones >= 5) {
        // Filling the gap makes 5+: an overline under exact rules, otherwise a winning
        // completion; a second completion at an outer end of a four makes it unstoppable.
        if (exact) break;
        let completions = 1;
        if (stones >= 4 && start > 0 && cells[start - 1] === EMPTY) completions++;
        if (nextStones >= 4 && j < n && cells[j] === EMPTY) completions++;
        score += completions >= 2 ? SCORE.OPEN_FOUR : SCORE.FOUR;
        i = j;
        consumed = true;
        break;
      }
      if (j - start > 5) break;
      stones += nextStones;
      gaps++;
      end = j - 1;
      i = j;
    }
    if (!consumed) score += shapeScore(cells, start, end, stones, gaps, player, exact);
  }
  return score;
}

/** Contiguous run through (row, col) along one axis, assuming `player` sits there. */
export function runLengthFlat(flat, size, row, col, dRow, dCol, player) {
  let len = 1;
  let r = row + dRow;
  let c = col + dCol;
  while (r >= 0 && r < size && c >= 0 && c < size && flat[r * size + c] === player) {
    len++;
    r += dRow;
    c += dCol;
  }
  r = row - dRow;
  c = col - dCol;
  while (r >= 0 && r < size && c >= 0 && c < size && flat[r * size + c] === player) {
    len++;
    r -= dRow;
    c -= dCol;
  }
  return len;
}

/** Placing `player` at (row, col) completes a five (exactly five when `exact`). */
export function makesFiveFlat(flat, size, row, col, player, exact) {
  for (const [dRow, dCol] of DIRECTIONS) {
    const len = runLengthFlat(flat, size, row, col, dRow, dCol, player);
    if (exact ? len === 5 : len >= 5) return true;
  }
  return false;
}

/** Placing `player` at (row, col) creates a straight four `_XXXX_` (both completions valid). */
export function makesOpenFourFlat(flat, size, row, col, player, exact) {
  const cell = (r, c) => (r < 0 || r >= size || c < 0 || c >= size ? WALL : flat[r * size + c]);
  for (const [dRow, dCol] of DIRECTIONS) {
    let back = 0;
    while (cell(row - (back + 1) * dRow, col - (back + 1) * dCol) === player) back++;
    let fwd = 0;
    while (cell(row + (fwd + 1) * dRow, col + (fwd + 1) * dCol) === player) fwd++;
    if (back + fwd !== 3) continue;
    if (cell(row - (back + 1) * dRow, col - (back + 1) * dCol) !== EMPTY) continue;
    if (cell(row + (fwd + 1) * dRow, col + (fwd + 1) * dCol) !== EMPTY) continue;
    if (exact && (cell(row - (back + 2) * dRow, col - (back + 2) * dCol) === player
      || cell(row + (fwd + 2) * dRow, col + (fwd + 2) * dCol) === player)) continue;
    return true;
  }
  return false;
}

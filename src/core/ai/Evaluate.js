/**
 * Public evaluation API over `number[][]` boards: whole-board score, point
 * heuristics, candidate generation and the 0..1 momentum gauge.
 * @module core/ai/Evaluate
 */
import { BLACK, WHITE, EMPTY, inBounds } from '../rules/Gomoku.js';
import { RuleMode } from '../state/GameState.js';
import { DEFENSE_WEIGHT, SCORE } from './Patterns.js';
import { Position } from './Position.js';

export { SCORE, DEFENSE_WEIGHT, evaluateLine, runLengthFlat, makesFiveFlat, makesOpenFourFlat } from './Patterns.js';
export { Position } from './Position.js';

/** @typedef {{ row: number, col: number, score: number }} ScoredMove */

const MOMENTUM_SCALE = Math.sqrt((1 + DEFENSE_WEIGHT) * SCORE.OPEN_THREE) / Math.log(0.65 / 0.35);

/**
 * Whole-board score for `player`: own patterns minus 1.1 x opponent patterns
 * over every row, column and diagonal.
 * @param {number[][]} board
 * @returns {number}
 */
export function evaluateBoard(board, player, mode = RuleMode.STANDARD) {
  return new Position(board, mode).evaluate(player);
}

/**
 * Heuristic value of `player` playing (row, col): attack gain plus the
 * opponent's gain on the same cell. -Infinity for occupied, off-board or
 * (RENJU, black) forbidden points.
 * @param {number[][]} board
 * @returns {number}
 */
export function evaluatePoint(board, row, col, player, mode = RuleMode.STANDARD) {
  const size = board.length;
  if (!inBounds(row, col, size) || board[row][col] !== EMPTY) return -Infinity;
  const position = new Position(board, mode);
  const idx = row * size + col;
  if (position.isForbiddenFor(idx, player)) return -Infinity;
  return position.scorePoint(idx, player);
}

/**
 * Best-first candidate moves near existing stones (centre on an empty board).
 * @param {number[][]} board
 * @param {{ radius?: number, limit?: number }} [options]
 * @returns {ScoredMove[]}
 */
export function getCandidateMoves(board, player, mode = RuleMode.STANDARD, { radius = 2, limit = 16 } = {}) {
  return new Position(board, mode, radius).candidates(player, limit).map(({ row, col, score }) => ({ row, col, score }));
}

/**
 * Black's advantage in 0..1 (0.5 = balanced). Sigmoid of the square-root
 * compressed evaluation gap, scaled so one lone open three reads 0.65.
 * @param {number[][]} board
 * @returns {number}
 */
export function momentum(board, mode = RuleMode.STANDARD) {
  const position = new Position(board, mode);
  const gap = position.evaluate(BLACK) - position.evaluate(WHITE);
  const compressed = Math.sign(gap) * Math.sqrt(Math.abs(gap));
  return 1 / (1 + Math.exp(-compressed / MOMENTUM_SCALE));
}

/**
 * Move selection: forced win/block detection followed by iterative-deepening
 * alpha-beta (negamax) over the incremental `Position`.
 * @module core/ai/Search
 */
import { BLACK, EMPTY, opponentOf, toFlatBoard } from '../rules/Gomoku.js';
import { isForbiddenFlat } from '../rules/Renju.js';
import { RuleMode } from '../state/GameState.js';
import { evaluatePoint } from './Evaluate.js';
import { SCORE, makesFiveFlat } from './Patterns.js';
import { Position } from './Position.js';

const WIN_SCORE = 1_000_000_000;
/** Root moves whose values differ by less than this are considered equal when randomizing. */
const TIE_EPSILON = SCORE.TWO;
/** Extra plies allowed past the nominal depth while a side is forced to block a five. */
const FORCED_EXTENSION = 8;

/**
 * @typedef {Object} SearchResult
 * @property {number} row
 * @property {number} col
 * @property {number} score Value from the mover's point of view.
 * @property {number} depth Deepest fully completed search depth (0 for forced/opening moves).
 * @property {number} nodes
 * @property {number} elapsedMs
 * @property {'OPENING'|'WIN'|'BLOCK'|'ATTACK'|'DEFEND'|'SEARCH'} reason
 */

/**
 * Point where `player` completes a five (exactly five for black in RENJU), or null.
 * @param {number[][]} board
 * @returns {{ row: number, col: number }|null}
 */
export function findImmediateWin(board, player, mode = RuleMode.STANDARD) {
  const size = board.length;
  const flat = toFlatBoard(board);
  const exact = mode === RuleMode.RENJU && player === BLACK;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (flat[row * size + col] === EMPTY && makesFiveFlat(flat, size, row, col, player, exact)) return { row, col };
    }
  }
  return null;
}

/**
 * Best point to stop the opponent's immediate five, or null when there is none
 * (or, for black in RENJU, when every such point is forbidden).
 * @param {number[][]} board
 * @returns {{ row: number, col: number }|null}
 */
export function findMustBlock(board, player, mode = RuleMode.STANDARD) {
  const size = board.length;
  const flat = toFlatBoard(board);
  const opp = opponentOf(player);
  const renju = mode === RuleMode.RENJU;
  const points = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (flat[row * size + col] !== EMPTY || !makesFiveFlat(flat, size, row, col, opp, renju && opp === BLACK)) continue;
      if (renju && player === BLACK && isForbiddenFlat(flat, size, row, col).forbidden) continue;
      points.push({ row, col });
    }
  }
  if (points.length === 0) return null;
  if (points.length === 1) return points[0];
  const position = new Position(board, mode);
  let best = points[0];
  let bestScore = -Infinity;
  for (const point of points) {
    const score = position.scorePoint(point.row * size + point.col, player);
    if (score > bestScore) {
      bestScore = score;
      best = point;
    }
  }
  return best;
}

/** Alias of evaluatePoint for coaching/explanation code. */
export function scoreMove(board, row, col, player, mode = RuleMode.STANDARD) {
  return evaluatePoint(board, row, col, player, mode);
}

function negamax(position, player, depth, alpha, beta, ply, ctx) {
  ctx.nodes++;
  if ((ctx.nodes & 127) === 0 && Date.now() >= ctx.deadline) {
    ctx.aborted = true;
    return 0;
  }
  if (position.hasImmediateWin(player)) return WIN_SCORE - ply;
  const opp = opponentOf(player);
  let moves = position.winningCells(opp);
  if (moves.length > 0) {
    // Forced reply: keep searching blocking moves even past the nominal depth.
    if (depth <= 0 && ply >= ctx.maxPly) return position.evaluate(player);
    if (position.renju && player === BLACK) moves = moves.filter((move) => !position.isForbiddenFor(move.idx, player));
    if (moves.length === 0) return -(WIN_SCORE - ply - 1);
  } else {
    if (depth <= 0) return position.evaluate(player);
    moves = position.candidates(player, ctx.limit);
    if (moves.length === 0) return 0;
  }
  let best = -Infinity;
  for (const move of moves) {
    position.place(move.idx, player);
    const value = -negamax(position, opp, depth - 1, -beta, -alpha, ply + 1, ctx);
    position.remove(move.idx);
    if (ctx.aborted) return 0;
    if (value > best) best = value;
    if (value > alpha) alpha = value;
    if (alpha >= beta) break;
  }
  return best;
}

/** Iterative deepening at the root; keeps the last fully completed iteration when time runs out. */
function searchRoot(position, player, rootMoves, maxDepth, deadline, limit) {
  const ctx = { nodes: 0, deadline, aborted: false, limit, maxPly: 0 };
  const opp = opponentOf(player);
  let order = rootMoves.map((move) => ({ ...move, value: move.score }));
  let completedDepth = 0;
  for (let depth = Math.min(2, maxDepth); depth <= maxDepth; depth++) {
    ctx.maxPly = depth + FORCED_EXTENSION;
    let alpha = -Infinity;
    const scored = [];
    for (const move of order) {
      position.place(move.idx, player);
      const value = -negamax(position, opp, depth - 1, -Infinity, -alpha, 1, ctx);
      position.remove(move.idx);
      if (ctx.aborted) break;
      scored.push({ ...move, value });
      if (value > alpha) alpha = value;
    }
    if (ctx.aborted) break;
    scored.sort((a, b) => b.value - a.value);
    order = scored;
    completedDepth = depth;
    if (order[0].value >= WIN_SCORE - 1000 || Date.now() >= deadline) break;
  }
  return { order, completedDepth, nodes: ctx.nodes };
}

/**
 * Chooses a move for `state.currentPlayer`. Decision order: opening book
 * (centre / diagonal neighbour), immediate win, forced block, straight-four
 * attack, then time-limited iterative-deepening alpha-beta. Black never
 * receives a forbidden point in RENJU. Returns null only when no move exists.
 * @param {{ board: number[][], currentPlayer: number, rules?: { mode?: string } }} state
 * @param {{ depth?: number, timeLimitMs?: number, candidateLimit?: number, randomize?: boolean }} [options]
 * @returns {SearchResult|null}
 */
export function findBestMove(state, { depth = 4, timeLimitMs = 1200, candidateLimit = 14, randomize = false } = {}) {
  const start = Date.now();
  const { board, currentPlayer: player } = state;
  const mode = state.rules?.mode ?? RuleMode.STANDARD;
  const size = board.length;
  const position = new Position(board, mode);
  const done = (row, col, reason, extra = {}) => ({
    row, col, score: 0, depth: 0, nodes: 0, reason, ...extra, elapsedMs: Date.now() - start,
  });

  if (position.stones === 0) {
    const centre = size >> 1;
    return done(centre, centre, 'OPENING');
  }
  if (position.stones === 1) {
    // Diagonal neighbour of the lone stone, leaning towards the centre.
    const idx = position.flat.findIndex((cell) => cell !== EMPTY);
    const row = (idx / size) | 0;
    const col = idx % size;
    const centre = size >> 1;
    return done(row + (row > centre ? -1 : 1), col + (col > centre ? -1 : 1), 'OPENING');
  }

  const win = findImmediateWin(board, player, mode);
  if (win) return done(win.row, win.col, 'WIN', { score: WIN_SCORE });

  const block = findMustBlock(board, player, mode);
  if (block) return done(block.row, block.col, 'BLOCK', { score: position.scorePoint(block.row * size + block.col, player) });

  const rootMoves = position.candidates(player, Math.max(1, candidateLimit));
  if (rootMoves.length === 0) {
    for (let idx = 0; idx < position.flat.length; idx++) {
      if (position.flat[idx] === EMPTY && !position.isForbiddenFor(idx, player)) return done((idx / size) | 0, idx % size, 'SEARCH');
    }
    return null;
  }

  const attack = rootMoves.find((move) => position.makesOpenFour(move.idx, player));
  if (attack) return done(attack.row, attack.col, 'ATTACK', { score: SCORE.OPEN_FOUR });

  const deadline = start + Math.max(1, timeLimitMs);
  const { order, completedDepth, nodes } = searchRoot(position, player, rootMoves, Math.max(1, depth), deadline, Math.max(1, candidateLimit));
  let chosen = order[0];
  if (randomize) {
    const ties = order.filter((move) => move.value >= order[0].value - TIE_EPSILON);
    chosen = ties[Math.floor(Math.random() * ties.length)];
  }
  const defensive = position.gain(chosen.idx, opponentOf(player)) >= SCORE.FOUR;
  return done(chosen.row, chosen.col, defensive ? 'DEFEND' : 'SEARCH', { score: chosen.value, depth: completedDepth, nodes });
}

/**
 * Position setup and diagnosis for restored games (photo / record import):
 * validate a 0/1/2 grid, count stones, infer whose turn it is, find lines that
 * already decide the game and say whether play can continue. Also parses and
 * prints the plain-text board notation used by records and vision models.
 *
 * Pure functions, no DOM. Must not import GameState.js (it imports this file).
 * @module core/rules/Setup
 */
import { BOARD_SIZE, EMPTY, BLACK, WHITE, DIRECTIONS, createEmptyBoard } from './Gomoku.js';

/** Mirrors RuleMode.RENJU without importing the state module. */
const RENJU = 'RENJU';

export const PositionVerdict = Object.freeze({
  /** Legal-looking position, nobody has five: play can continue. */
  PLAYABLE: 'PLAYABLE',
  /** No stones at all (still playable, but nothing was really restored). */
  EMPTY: 'EMPTY',
  BLACK_WON: 'BLACK_WON',
  WHITE_WON: 'WHITE_WON',
  /** Both colours have a five: not a position that can arise from play. */
  BOTH_WON: 'BOTH_WON',
  FULL: 'FULL',
  INVALID: 'INVALID',
});

/**
 * @typedef {{ row: number, col: number }} Cell
 * @typedef {{ black: number, white: number, empty: number, total: number }} StoneCounts
 * @typedef {{ player: number, consistent: boolean }} TurnGuess
 * @typedef {{ player: number, count: number, cells: Cell[] }} Line
 * @typedef {object} PositionAnalysis
 * @property {boolean} ok            grid is well formed
 * @property {string|null} error     why the grid is malformed
 * @property {string} verdict        PositionVerdict
 * @property {boolean} playable
 * @property {StoneCounts} counts
 * @property {TurnGuess} turn
 * @property {{ black: Line[], white: Line[] }} lines   runs of five or more per colour
 * @property {number|null} winner
 * @property {Cell[]|null} winLine
 */

/**
 * @param {unknown} board
 * @param {number} [size]
 * @returns {string|null} null when `board` is a size×size grid of 0/1/2
 */
export function validateGrid(board, size = BOARD_SIZE) {
  if (!Array.isArray(board) || board.length !== size) return `Board must have ${size} rows`;
  for (let r = 0; r < size; r++) {
    const row = board[r];
    if (!Array.isArray(row) || row.length !== size) return `Row ${r} must have ${size} cells`;
    for (let c = 0; c < size; c++) {
      const v = row[c];
      if (v !== EMPTY && v !== BLACK && v !== WHITE) return `Cell (${r}, ${c}) must be 0, 1 or 2`;
    }
  }
  return null;
}

/** @param {number[][]} board @returns {StoneCounts} */
export function countStones(board) {
  let black = 0;
  let white = 0;
  let empty = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === BLACK) black++;
      else if (cell === WHITE) white++;
      else empty++;
    }
  }
  return { black, white, empty, total: black + white };
}

/**
 * Black moves first, so black has either as many stones as white (black to
 * move) or one more (white to move). Anything else is flagged inconsistent and
 * the side with fewer stones is assumed to move.
 * @param {StoneCounts} counts
 * @returns {TurnGuess}
 */
export function inferTurn(counts) {
  const diff = counts.black - counts.white;
  if (diff === 0) return { player: BLACK, consistent: true };
  if (diff === 1) return { player: WHITE, consistent: true };
  return { player: diff > 0 ? WHITE : BLACK, consistent: false };
}

/**
 * Maximal runs of `player` stones with at least `min` cells, each reported once.
 * @param {number[][]} board
 * @param {number} player
 * @returns {Line[]}
 */
export function findLines(board, player, { min = 5 } = {}) {
  const size = board.length;
  const lines = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (board[row][col] !== player) continue;
      for (const [dRow, dCol] of DIRECTIONS) {
        const pr = row - dRow;
        const pc = col - dCol;
        // Only start a run from its first stone.
        if (pr >= 0 && pc >= 0 && pr < size && pc < size && board[pr][pc] === player) continue;
        const cells = [];
        let r = row;
        let c = col;
        while (r >= 0 && c >= 0 && r < size && c < size && board[r][c] === player) {
          cells.push({ row: r, col: c });
          r += dRow;
          c += dCol;
        }
        if (cells.length >= min) lines.push({ player, count: cells.length, cells });
      }
    }
  }
  return lines;
}

/**
 * Decide whether a static position can still be played. In RENJU black only
 * wins with exactly five; a black overline is a forbidden move, so it counts
 * as a win for white.
 * @param {unknown} board
 * @param {{ mode?: string, size?: number }} [options]
 * @returns {PositionAnalysis}
 */
export function analyzePosition(board, { mode = 'STANDARD', size = BOARD_SIZE } = {}) {
  const error = validateGrid(board, size);
  const empty = { black: 0, white: 0, empty: size * size, total: 0 };
  if (error) {
    return {
      ok: false, error, verdict: PositionVerdict.INVALID, playable: false,
      counts: empty, turn: { player: BLACK, consistent: true }, lines: { black: [], white: [] }, winner: null, winLine: null,
    };
  }
  const grid = /** @type {number[][]} */ (board);
  const counts = countStones(grid);
  const turn = inferTurn(counts);
  const lines = { black: findLines(grid, BLACK), white: findLines(grid, WHITE) };
  const renju = mode === RENJU;

  const blackWins = renju ? lines.black.filter((l) => l.count === 5) : lines.black;
  const blackOverlines = renju ? lines.black.filter((l) => l.count > 5) : [];
  const whiteWins = lines.white;

  let verdict = PositionVerdict.PLAYABLE;
  let winner = null;
  let winLine = null;
  const blackDecides = blackWins.length > 0;
  const whiteDecides = whiteWins.length > 0 || blackOverlines.length > 0;
  if (blackDecides && whiteDecides) {
    verdict = PositionVerdict.BOTH_WON;
  } else if (blackDecides) {
    verdict = PositionVerdict.BLACK_WON;
    winner = BLACK;
    winLine = blackWins[0].cells;
  } else if (whiteDecides) {
    verdict = PositionVerdict.WHITE_WON;
    winner = WHITE;
    winLine = (whiteWins[0] ?? blackOverlines[0]).cells;
  } else if (counts.empty === 0) {
    verdict = PositionVerdict.FULL;
  } else if (counts.total === 0) {
    verdict = PositionVerdict.EMPTY;
  }

  const playable = verdict === PositionVerdict.PLAYABLE || verdict === PositionVerdict.EMPTY;
  return { ok: true, error: null, verdict, playable, counts, turn, lines, winner, winLine };
}

// ---------------------------------------------------------------------------
// Text notation
// ---------------------------------------------------------------------------

const BLACK_CHARS = new Set(['X', 'x', 'B', 'b', '●', '1', '#', '黑']);
const WHITE_CHARS = new Set(['O', 'o', 'W', 'w', '○', '2', '@', '白']);
const EMPTY_CHARS = new Set(['.', '·', '-', '_', '+', '0', '*', '。', '．']);

/**
 * Board as `size` lines of `.`, `X` (black) and `O` (white), rank 15 first.
 * @param {number[][]} board
 * @returns {string}
 */
export function boardToText(board) {
  return board.map((row) => row.map((v) => (v === BLACK ? 'X' : v === WHITE ? 'O' : '.')).join('')).join('\n');
}

/**
 * Parse a text board: exactly `size` lines that each contain `size` cell
 * tokens after optional rank labels are stripped. Tolerates spaces between
 * cells, `X/O/.`, `●/○/·`, `B/W`, `1/2/0` and coordinate header lines (which
 * are skipped because they do not parse as cells).
 * @param {string} text
 * @param {number} [size]
 * @returns {number[][]|null}
 */
export function parseBoardText(text, size = BOARD_SIZE) {
  if (typeof text !== 'string') return null;
  const toCells = (line) => {
    const cells = [];
    for (const ch of Array.from(line.replace(/[\s,|]/g, ''))) {
      if (BLACK_CHARS.has(ch)) cells.push(BLACK);
      else if (WHITE_CHARS.has(ch)) cells.push(WHITE);
      else if (EMPTY_CHARS.has(ch)) cells.push(EMPTY);
      else return null;
    }
    return cells.length === size ? cells : null;
  };
  const rows = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Digit boards ("0 0 1 2 …") must parse as-is; rank labels ("15 . . X … 15") are only stripped as a fallback.
    const cells = toCells(line) ?? toCells(line.replace(/^\d{1,2}\s+/, '').replace(/\s+\d{1,2}$/, ''));
    if (cells) rows.push(cells);
  }
  if (rows.length !== size) return null;
  return rows;
}

/**
 * Deep-copy a grid into a fresh mutable board (used before placing stones).
 * @param {number[][]} board
 * @returns {number[][]}
 */
export function copyGrid(board) {
  const size = board.length;
  const out = createEmptyBoard(size);
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) out[r][c] = board[r][c];
  return out;
}

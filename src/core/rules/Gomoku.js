/**
 * Gomoku board primitives: board creation, bounds, run counting, win detection
 * and algebraic notation. Pure functions; a board is `number[][]` (rows of cols).
 * @module core/rules/Gomoku
 */

export const BOARD_SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

/** Scan axes as `[dRow, dCol]`: horizontal, vertical, diagonal, anti-diagonal. */
export const DIRECTIONS = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 0]),
  Object.freeze([1, 1]),
  Object.freeze([1, -1]),
]);

/** @typedef {{ row: number, col: number }} Cell */

/**
 * @param {number} [size]
 * @returns {number[][]} Mutable board filled with EMPTY.
 */
export function createEmptyBoard(size = BOARD_SIZE) {
  const board = new Array(size);
  for (let r = 0; r < size; r++) board[r] = new Array(size).fill(EMPTY);
  return board;
}

/**
 * @param {number} row
 * @param {number} col
 * @param {number} [size]
 * @returns {boolean}
 */
export function inBounds(row, col, size = BOARD_SIZE) {
  return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < size && col < size;
}

/**
 * @param {number} player BLACK or WHITE
 * @returns {number} The other colour (EMPTY for invalid input).
 */
export function opponentOf(player) {
  if (player === BLACK) return WHITE;
  if (player === WHITE) return BLACK;
  return EMPTY;
}

/** @param {number[][]} board */
export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

/** @param {number[][]} board */
export function isBoardFull(board) {
  for (const row of board) {
    for (const cell of row) if (cell === EMPTY) return false;
  }
  return true;
}

/**
 * Flattens a board into an Int8Array indexed by `row * size + col`.
 * @param {number[][]} board
 * @returns {Int8Array}
 */
export function toFlatBoard(board) {
  const size = board.length;
  const flat = new Int8Array(size * size);
  for (let r = 0; r < size; r++) {
    const row = board[r];
    const base = r * size;
    for (let c = 0; c < size; c++) flat[base + c] = row[c];
  }
  return flat;
}

/**
 * Number of consecutive `player` stones starting at (row + dRow, col + dCol).
 * The origin cell itself is not counted.
 * @returns {number}
 */
export function countRun(board, row, col, dRow, dCol, player) {
  const size = board.length;
  let count = 0;
  let r = row + dRow;
  let c = col + dCol;
  while (r >= 0 && c >= 0 && r < size && c < size && board[r][c] === player) {
    count++;
    r += dRow;
    c += dCol;
  }
  return count;
}

/**
 * Contiguous run of `player` stones through (row, col) along one axis, assuming
 * `player` occupies (row, col). Cells are ordered from the backward end forward.
 * @returns {{ count: number, cells: Cell[] }}
 */
export function lineThrough(board, row, col, dRow, dCol, player) {
  const back = countRun(board, row, col, -dRow, -dCol, player);
  const forward = countRun(board, row, col, dRow, dCol, player);
  const cells = [];
  for (let k = -back; k <= forward; k++) cells.push({ row: row + k * dRow, col: col + k * dCol });
  return { count: back + forward + 1, cells };
}

/**
 * Winning line through (row, col) for `player`, or null. Five or more wins
 * unless `exactFive` is set (Renju black), in which case only exactly five counts.
 * @param {number[][]} board
 * @param {{ exactFive?: boolean }} [options]
 * @returns {Cell[]|null}
 */
export function findWinLine(board, row, col, player, { exactFive = false } = {}) {
  for (const [dRow, dCol] of DIRECTIONS) {
    const back = countRun(board, row, col, -dRow, -dCol, player);
    const forward = countRun(board, row, col, dRow, dCol, player);
    const count = back + forward + 1;
    if (exactFive ? count !== 5 : count < 5) continue;
    const cells = [];
    for (let k = -back; k <= forward; k++) cells.push({ row: row + k * dRow, col: col + k * dCol });
    return cells;
  }
  return null;
}

/**
 * Algebraic notation: columns 'A'.. from the left, rows numbered from the bottom
 * (row 0 is the top rank). Centre (7, 7) of a 15x15 board is 'H8'.
 * @returns {string}
 */
export function toNotation(row, col, size = BOARD_SIZE) {
  return `${String.fromCharCode(65 + col)}${size - row}`;
}

/**
 * Parses notation such as 'H8' (case-insensitive). Returns null when invalid.
 * @param {string} text
 * @returns {Cell|null}
 */
export function fromNotation(text, size = BOARD_SIZE) {
  if (typeof text !== 'string') return null;
  const match = /^\s*([A-Za-z])\s*(\d{1,2})\s*$/.exec(text);
  if (!match) return null;
  const col = match[1].toUpperCase().charCodeAt(0) - 65;
  const row = size - Number(match[2]);
  return inBounds(row, col, size) ? { row, col } : null;
}

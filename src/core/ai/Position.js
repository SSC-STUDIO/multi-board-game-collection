/**
 * Mutable search position over a flat Int8Array board with incrementally
 * maintained per-line pattern scores and a stone-proximity mask.
 * @module core/ai/Position
 */
import { BLACK, WHITE, EMPTY, opponentOf, toFlatBoard } from '../rules/Gomoku.js';
import { isForbiddenFlat } from '../rules/Renju.js';
import { RuleMode } from '../state/GameState.js';
import { DEFENSE_WEIGHT, evaluateLine, makesFiveFlat, makesOpenFourFlat } from './Patterns.js';

/** @typedef {{ idx: number, row: number, col: number, score: number }} Candidate */

const lineTables = new Map();

/** All rows, columns and diagonals of length >= 5 as flat index arrays, plus the lines through each cell. */
function getLineTable(size) {
  let table = lineTables.get(size);
  if (table) return table;
  const lines = [];
  const perCell = Array.from({ length: size * size }, () => []);
  const addLine = (r, c, dRow, dCol) => {
    const cells = [];
    while (r >= 0 && r < size && c >= 0 && c < size) {
      cells.push(r * size + c);
      r += dRow;
      c += dCol;
    }
    if (cells.length < 5) return;
    const id = lines.length;
    lines.push(Int16Array.from(cells));
    for (const idx of cells) perCell[idx].push(id);
  };
  for (let r = 0; r < size; r++) addLine(r, 0, 0, 1);
  for (let c = 0; c < size; c++) addLine(0, c, 1, 0);
  for (let c = 0; c < size; c++) addLine(0, c, 1, 1);
  for (let r = 1; r < size; r++) addLine(r, 0, 1, 1);
  for (let c = 0; c < size; c++) addLine(0, c, 1, -1);
  for (let r = 1; r < size; r++) addLine(r, size - 1, 1, -1);
  table = { lines, cellLines: perCell.map((ids) => Int16Array.from(ids)) };
  lineTables.set(size, table);
  return table;
}

export class Position {
  /**
   * @param {number[][]} board
   * @param {string} [mode] RuleMode
   * @param {number} [radius] Candidate distance from existing stones.
   */
  constructor(board, mode = RuleMode.STANDARD, radius = 2) {
    this.size = board.length;
    this.mode = mode;
    this.renju = mode === RuleMode.RENJU;
    this.radius = radius;
    this.flat = toFlatBoard(board);
    this.table = getLineTable(this.size);
    this.lineScore = new Float64Array(this.table.lines.length * 2);
    this.totals = new Float64Array(3);
    this.near = new Uint8Array(this.size * this.size);
    this.stones = 0;
    this.buffers = [];
    for (let idx = 0; idx < this.flat.length; idx++) {
      if (this.flat[idx] === EMPTY) continue;
      this.stones++;
      this.#bumpNear(idx, 1);
    }
    for (let id = 0; id < this.table.lines.length; id++) this.#rescoreLine(id);
  }

  #buffer(length) {
    return this.buffers[length] ?? (this.buffers[length] = new Int8Array(length));
  }

  #bumpNear(idx, delta) {
    const { size, radius, near } = this;
    const row = (idx / size) | 0;
    const col = idx % size;
    const r0 = Math.max(0, row - radius);
    const r1 = Math.min(size - 1, row + radius);
    const c0 = Math.max(0, col - radius);
    const c1 = Math.min(size - 1, col + radius);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) near[r * size + c] += delta;
    }
  }

  #fill(cells) {
    const buf = this.#buffer(cells.length);
    const { flat } = this;
    for (let k = 0; k < cells.length; k++) buf[k] = flat[cells[k]];
    return buf;
  }

  #rescoreLine(id) {
    const buf = this.#fill(this.table.lines[id]);
    const black = evaluateLine(buf, BLACK, this.mode);
    const white = evaluateLine(buf, WHITE, this.mode);
    this.totals[BLACK] += black - this.lineScore[id * 2];
    this.totals[WHITE] += white - this.lineScore[id * 2 + 1];
    this.lineScore[id * 2] = black;
    this.lineScore[id * 2 + 1] = white;
  }

  place(idx, player) {
    this.flat[idx] = player;
    this.stones++;
    this.#bumpNear(idx, 1);
    for (const id of this.table.cellLines[idx]) this.#rescoreLine(id);
  }

  remove(idx) {
    this.flat[idx] = EMPTY;
    this.stones--;
    this.#bumpNear(idx, -1);
    for (const id of this.table.cellLines[idx]) this.#rescoreLine(id);
  }

  /** Static evaluation from `player`'s point of view. */
  evaluate(player) {
    return this.totals[player] - DEFENSE_WEIGHT * this.totals[opponentOf(player)];
  }

  /** Increase of `player`'s material if they occupy the (empty) cell. */
  gain(idx, player) {
    const { flat, lineScore, table } = this;
    const saved = flat[idx];
    flat[idx] = player;
    let delta = 0;
    for (const id of table.cellLines[idx]) {
      delta += evaluateLine(this.#fill(table.lines[id]), player, this.mode) - lineScore[id * 2 + player - 1];
    }
    flat[idx] = saved;
    return delta;
  }

  /** Attack gain for `player` plus what the opponent would gain on the same cell. */
  scorePoint(idx, player) {
    const opp = opponentOf(player);
    const { flat, lineScore, table } = this;
    const saved = flat[idx];
    let score = 0;
    for (const id of table.cellLines[idx]) {
      const cells = table.lines[id];
      flat[idx] = player;
      const buf = this.#fill(cells);
      score += evaluateLine(buf, player, this.mode) - lineScore[id * 2 + player - 1];
      for (let k = 0; k < cells.length; k++) {
        if (cells[k] === idx) {
          buf[k] = opp;
          break;
        }
      }
      score += evaluateLine(buf, opp, this.mode) - lineScore[id * 2 + opp - 1];
    }
    flat[idx] = saved;
    return score;
  }

  makesFive(idx, player) {
    const { size } = this;
    return makesFiveFlat(this.flat, size, (idx / size) | 0, idx % size, player, this.renju && player === BLACK);
  }

  makesOpenFour(idx, player) {
    const { size } = this;
    return makesOpenFourFlat(this.flat, size, (idx / size) | 0, idx % size, player, this.renju && player === BLACK);
  }

  isForbiddenFor(idx, player) {
    if (!this.renju || player !== BLACK) return false;
    const { size } = this;
    return isForbiddenFlat(this.flat, size, (idx / size) | 0, idx % size).forbidden;
  }

  /** Some empty cell near the stones completes a five for `player`. */
  hasImmediateWin(player) {
    const { flat, near } = this;
    for (let idx = 0; idx < flat.length; idx++) {
      if (flat[idx] === EMPTY && near[idx] > 0 && this.makesFive(idx, player)) return true;
    }
    return false;
  }

  /**
   * Every empty cell where `player` would complete a five.
   * @returns {Candidate[]}
   */
  winningCells(player) {
    const { flat, near, size } = this;
    const cells = [];
    for (let idx = 0; idx < flat.length; idx++) {
      if (flat[idx] === EMPTY && near[idx] > 0 && this.makesFive(idx, player)) {
        cells.push({ idx, row: (idx / size) | 0, col: idx % size, score: 0 });
      }
    }
    return cells;
  }

  /**
   * Empty cells within `radius` of a stone, scored and sorted best-first,
   * truncated to `limit`. Forbidden points are dropped for black in RENJU.
   * @returns {Candidate[]}
   */
  candidates(player, limit = 16) {
    const { flat, near, size } = this;
    if (this.stones === 0) {
      const centre = size >> 1;
      const idx = centre * size + centre;
      return [{ idx, row: centre, col: centre, score: this.scorePoint(idx, player) }];
    }
    const list = [];
    for (let idx = 0; idx < flat.length; idx++) {
      if (flat[idx] !== EMPTY || near[idx] === 0) continue;
      list.push({ idx, row: (idx / size) | 0, col: idx % size, score: this.scorePoint(idx, player) });
    }
    list.sort((a, b) => b.score - a.score);
    if (!this.renju || player !== BLACK) return list.length > limit ? list.slice(0, limit) : list;
    const legal = [];
    for (const move of list) {
      if (legal.length >= limit) break;
      if (!this.isForbiddenFor(move.idx, player)) legal.push(move);
    }
    return legal;
  }
}

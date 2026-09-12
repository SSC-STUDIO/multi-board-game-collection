/**
 * Portable game record: the setup grid a game was restored from (if any), the
 * moves played since, rules and colours. Small JSON so it can be downloaded,
 * shared and dropped back onto the start screen. Pure JS.
 * @module core/state/Record
 */
import { BLACK, WHITE, fromNotation } from '../rules/Gomoku.js';
import { boardToText, parseBoardText } from '../rules/Setup.js';

export const RECORD_APP = 'zenith-tabletop-3d';
export const RECORD_VERSION = 1;

/**
 * @typedef {object} GameRecord
 * @property {string} app
 * @property {number} version
 * @property {string} savedAt        ISO-8601
 * @property {string} mode           RuleMode
 * @property {number} boardSize
 * @property {string[]|null} setup   text rows (rank 15 first), null when the game began empty
 * @property {string[]} moves        algebraic notation in play order
 * @property {number|null} humanColor
 * @property {number} currentPlayer  side to move after the last recorded move
 * @property {string} status
 * @property {number|'DRAW'|null} winner
 */

/**
 * @param {import('./GameState.js').GameState} state
 * @param {{ now?: number }} [options]
 * @returns {GameRecord}
 */
export function toRecord(state, { now = Date.now() } = {}) {
  return {
    app: RECORD_APP,
    version: RECORD_VERSION,
    savedAt: new Date(now).toISOString(),
    mode: state.rules.mode,
    boardSize: state.boardSize,
    setup: state.setupBoard ? boardToText(state.setupBoard).split('\n') : null,
    moves: state.moves.map((m) => m.notation),
    humanColor: state.humanColor,
    currentPlayer: state.currentPlayer,
    firstPlayer: state.moves[0]?.player ?? state.currentPlayer,
    status: state.status,
    winner: state.winner,
  };
}

/**
 * @typedef {object} ParsedRecord
 * @property {number[][]|null} board   setup grid
 * @property {string[]} moves           notation
 * @property {string|null} mode
 * @property {number|null} humanColor
 * @property {number|null} currentPlayer  only meaningful when there are no moves
 * @property {'record'|'text'} source
 */

/**
 * Accepts a record object, its JSON text, or a plain text board (15 lines).
 * @param {string|object} input
 * @param {number} [size]
 * @returns {{ ok: true, record: ParsedRecord } | { ok: false, error: string }}
 */
export function parseRecord(input, size = 15) {
  let data = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) return { ok: false, error: 'Empty input' };
    if (text.startsWith('{')) {
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, error: 'Malformed JSON' };
      }
    } else {
      const board = parseBoardText(text, size);
      if (!board) return { ok: false, error: `Text board must have ${size} rows of ${size} cells` };
      return { ok: true, record: { board, moves: [], mode: null, humanColor: null, currentPlayer: null, source: 'text' } };
    }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'Record must be an object' };
  const rec = /** @type {any} */ (data);
  if (rec.app !== RECORD_APP) return { ok: false, error: 'Not a Zenith record' };
  if (rec.boardSize != null && rec.boardSize !== size) return { ok: false, error: `Record uses a ${rec.boardSize}-line board` };

  let board = null;
  if (Array.isArray(rec.setup)) {
    board = parseBoardText(rec.setup.join('\n'), size);
    if (!board) return { ok: false, error: 'Record setup grid is malformed' };
  }
  const moves = Array.isArray(rec.moves) ? rec.moves : [];
  for (const m of moves) {
    if (typeof m !== 'string' || !fromNotation(m, size)) return { ok: false, error: `Bad move in record: ${String(m)}` };
  }
  const colour = (v) => (v === BLACK || v === WHITE ? v : null);
  return {
    ok: true,
    record: {
      board,
      moves,
      mode: typeof rec.mode === 'string' ? rec.mode : null,
      humanColor: colour(rec.humanColor),
      currentPlayer: moves.length === 0 ? colour(rec.currentPlayer) : colour(rec.firstPlayer),
      source: 'record',
    },
  };
}

/**
 * Immutable game state and the pure `transition` reducer.
 * Every successful transition returns a new deep-frozen state that shares all
 * untouched rows/objects with its predecessor; failures return the same state.
 * @module core/state/GameState
 */
import {
  BOARD_SIZE, EMPTY, BLACK, WHITE,
  createEmptyBoard, inBounds, opponentOf, isBoardFull, findWinLine, toNotation, fromNotation, toFlatBoard,
} from '../rules/Gomoku.js';
import { isForbidden, isForbiddenFlat } from '../rules/Renju.js';
import { analyzePosition, copyGrid, countStones, inferTurn, validateGrid } from '../rules/Setup.js';

export const GameStatus = Object.freeze({ SELECTING: 'SELECTING', PLAYING: 'PLAYING', PAUSED: 'PAUSED', FINISHED: 'FINISHED' });
/** STANDARD: five or more wins for both sides. RENJU: black needs exactly five and is bound by forbidden moves. */
export const RuleMode = Object.freeze({ STANDARD: 'STANDARD', RENJU: 'RENJU' });
export const FinishReason = Object.freeze({ FIVE: 'FIVE', FORBIDDEN: 'FORBIDDEN', RESIGN: 'RESIGN', TIMEOUT: 'TIMEOUT', DRAW: 'DRAW' });
export const ActionType = Object.freeze({
  SELECT_COLOR: 'SELECT_COLOR', MAKE_MOVE: 'MAKE_MOVE', UNDO_MOVE: 'UNDO_MOVE', TOGGLE_PAUSE: 'TOGGLE_PAUSE',
  TICK: 'TICK', RESIGN: 'RESIGN', RESET: 'RESET', LOAD_POSITION: 'LOAD_POSITION',
});
export const GameEvent = Object.freeze({
  MOVE_COMMITTED: 'onMoveCommitted', TURN_SWITCHED: 'onTurnSwitched', STATE_REVERTED: 'onStateReverted',
  GAME_FINISHED: 'onGameFinished', PAUSE_TOGGLED: 'onPauseToggled', COLOR_SELECTED: 'onColorSelected',
  CLOCK_TICKED: 'onClockTicked', GAME_RESET: 'onGameReset', INVALID_ACTION: 'onInvalidAction', STATE_CHANGED: 'onStateChanged',
  POSITION_LOADED: 'onPositionLoaded',
});

export const DEFAULT_INITIAL_MS = 600_000;
const CLOCK_KEY = Object.freeze({ [BLACK]: 'black', [WHITE]: 'white' });

/**
 * @typedef {Object} Move
 * @property {number} row
 * @property {number} col
 * @property {number} player
 * @property {number} timestamp
 * @property {string} notation
 * @property {number} index Zero-based move number.
 */
/**
 * @typedef {Object} Clock
 * @property {number} initialMs Per-side budget; `<= 0` disables timing.
 * @property {number} black Remaining ms.
 * @property {number} white Remaining ms.
 * @property {number|null} lastTickTimestamp
 * @property {boolean} running
 */
/**
 * @typedef {Object} GameState
 * @property {number} boardSize
 * @property {number[][]} board
 * @property {number} currentPlayer
 * @property {Move[]} moves
 * @property {string} status GameStatus
 * @property {number|null} humanColor
 * @property {number|null} aiColor
 * @property {number|'DRAW'|null} winner
 * @property {{row:number,col:number}[]|null} winLine
 * @property {string|null} finishReason FinishReason
 * @property {{ mode: string }} rules
 * @property {Clock} clock
 * @property {number[][]|null} setupBoard Stones that were on the board before move 1 (restored games); null for a normal game.
 * @property {Object|null} lastAction
 * @property {number} revision Incremented on every successful transition.
 */
/** @typedef {{ type: string, payload: Object }} GameEventRecord */
/** @typedef {{ state: GameState, events: GameEventRecord[], error: string|null }} TransitionResult */
/** @typedef {{ mode?: string, initialMs?: number, boardSize?: number }} GameConfig */

/**
 * @param {GameConfig} [config]
 * @returns {GameState}
 */
export function createInitialState(config = {}) {
  const boardSize = Number.isInteger(config.boardSize) && config.boardSize >= 5 ? config.boardSize : BOARD_SIZE;
  const initialMs = Number.isFinite(config.initialMs) ? config.initialMs : DEFAULT_INITIAL_MS;
  const mode = config.mode === RuleMode.RENJU ? RuleMode.RENJU : RuleMode.STANDARD;
  return freezeState({
    boardSize,
    board: createEmptyBoard(boardSize),
    currentPlayer: BLACK,
    moves: [],
    status: GameStatus.SELECTING,
    humanColor: null,
    aiColor: null,
    winner: null,
    winLine: null,
    finishReason: null,
    rules: { mode },
    clock: { initialMs, black: initialMs, white: initialMs, lastTickTimestamp: null, running: false },
    setupBoard: null,
    lastAction: null,
    revision: 0,
  });
}

function freezeGrid(grid) {
  for (const row of grid) Object.freeze(row);
  return Object.freeze(grid);
}

function freezeState(draft) {
  freezeGrid(draft.board);
  Object.freeze(draft.moves);
  Object.freeze(draft.clock);
  Object.freeze(draft.rules);
  if (draft.winLine) Object.freeze(draft.winLine);
  if (draft.setupBoard) freezeGrid(draft.setupBoard);
  return Object.freeze(draft);
}

/**
 * Shared by LOAD_POSITION's validate and apply: copy the setup grid, replay the
 * recorded moves on top of it and make sure the result can still be played.
 * @returns {{ error: string } | { error: null, board: number[][], setupBoard: number[][]|null, moves: Move[], currentPlayer: number }}
 */
function prepareLoadedPosition(config, action, timestamp) {
  const size = Number.isInteger(config.boardSize) && config.boardSize >= 5 ? config.boardSize : BOARD_SIZE;
  const mode = config.mode === RuleMode.RENJU ? RuleMode.RENJU : RuleMode.STANDARD;
  if (action.board != null) {
    const error = validateGrid(action.board, size);
    if (error) return { error };
  }
  if (action.moves != null && !Array.isArray(action.moves)) return { error: 'Moves must be an array' };
  if (action.currentPlayer != null && action.currentPlayer !== BLACK && action.currentPlayer !== WHITE) {
    return { error: 'currentPlayer must be BLACK (1) or WHITE (2)' };
  }

  const setupBoard = action.board ? copyGrid(action.board) : null;
  const board = setupBoard ? copyGrid(setupBoard) : createEmptyBoard(size);
  let player = action.currentPlayer ?? inferTurn(countStones(board)).player;
  const moves = [];
  for (const raw of action.moves ?? []) {
    const cell = typeof raw === 'string' ? fromNotation(raw, size) : raw;
    const label = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!cell || !inBounds(cell.row, cell.col, size)) return { error: `Move ${moves.length + 1} (${label}) is not a board cell` };
    if (board[cell.row][cell.col] !== EMPTY) return { error: `Move ${moves.length + 1} (${label}) lands on an occupied cell` };
    board[cell.row][cell.col] = player;
    moves.push(Object.freeze({ row: cell.row, col: cell.col, player, timestamp, notation: toNotation(cell.row, cell.col, size), index: moves.length }));
    player = opponentOf(player);
  }

  const analysis = analyzePosition(board, { mode, size });
  if (!analysis.playable) {
    const why = {
      BLACK_WON: 'black already has five', WHITE_WON: 'white already has five', BOTH_WON: 'both sides have five', FULL: 'the board is full',
    }[analysis.verdict] ?? analysis.error;
    return { error: `Position cannot be continued: ${why}` };
  }
  return { error: null, board, setupBoard, moves, currentPlayer: player };
}

function configOf(state) {
  return { mode: state.rules.mode, initialMs: state.clock.initialMs, boardSize: state.boardSize };
}

function placeStone(board, row, col, player) {
  const rows = board.slice();
  const cells = board[row].slice();
  cells[col] = player;
  rows[row] = Object.freeze(cells);
  return Object.freeze(rows);
}

function clearCells(board, cells) {
  const rows = board.slice();
  const copied = new Set();
  for (const { row, col } of cells) {
    if (!copied.has(row)) {
      rows[row] = board[row].slice();
      copied.add(row);
    }
    rows[row][col] = EMPTY;
  }
  for (const row of copied) Object.freeze(rows[row]);
  return Object.freeze(rows);
}

/** Deducts the time elapsed since the last tick from `player`; no-op while stopped. */
function settleClock(clock, player, timestamp) {
  if (!clock.running || clock.lastTickTimestamp === null) return clock;
  const key = CLOCK_KEY[player];
  const elapsed = clock.initialMs > 0 ? Math.max(0, timestamp - clock.lastTickTimestamp) : 0;
  return { ...clock, [key]: Math.max(0, clock[key] - elapsed), lastTickTimestamp: timestamp };
}

function isOutOfTime(clock, player) {
  return clock.initialMs > 0 && clock[CLOCK_KEY[player]] <= 0;
}

function clockEvent(clock, currentPlayer) {
  return { type: GameEvent.CLOCK_TICKED, payload: { black: clock.black, white: clock.white, currentPlayer } };
}

/** Marks the draft finished and returns the GAME_FINISHED event. */
function finish(draft, winner, winLine, reason, forbidden = null) {
  draft.status = GameStatus.FINISHED;
  draft.winner = winner;
  draft.winLine = winLine ? winLine.map((cell) => Object.freeze({ row: cell.row, col: cell.col })) : null;
  draft.finishReason = reason;
  draft.clock = { ...draft.clock, running: false };
  return { type: GameEvent.GAME_FINISHED, payload: { winner, winLine: draft.winLine, reason, forbidden } };
}

const HANDLERS = {
  [ActionType.SELECT_COLOR]: {
    validate(state, action) {
      if (action.color !== BLACK && action.color !== WHITE) return 'Color must be BLACK (1) or WHITE (2)';
      if (state.status !== GameStatus.SELECTING && state.status !== GameStatus.FINISHED) return `Cannot select a color while ${state.status}`;
      return null;
    },
    apply(state, action, timestamp) {
      const events = [];
      let base = state;
      if (state.status === GameStatus.FINISHED) {
        base = createInitialState(configOf(state));
        events.push({ type: GameEvent.GAME_RESET, payload: { config: configOf(state) } });
      }
      const draft = {
        ...base,
        humanColor: action.color,
        aiColor: opponentOf(action.color),
        status: GameStatus.PLAYING,
        clock: { ...base.clock, running: true, lastTickTimestamp: timestamp },
      };
      events.push({ type: GameEvent.COLOR_SELECTED, payload: { humanColor: draft.humanColor, aiColor: draft.aiColor } });
      return { draft, events };
    },
  },

  [ActionType.MAKE_MOVE]: {
    validate(state, action) {
      if (state.status === GameStatus.SELECTING) return 'Select a color before moving';
      if (state.status === GameStatus.PAUSED) return 'Game is paused';
      if (state.status === GameStatus.FINISHED) return 'Game is finished';
      if (!inBounds(action.row, action.col, state.boardSize)) return 'Move is out of bounds';
      if (state.board[action.row][action.col] !== EMPTY) return 'Cell is already occupied';
      return null;
    },
    apply(state, action, timestamp) {
      const { row, col } = action;
      const player = state.currentPlayer;
      const clock = settleClock(state.clock, player, timestamp);
      const draft = { ...state, clock };
      if (isOutOfTime(clock, player)) {
        return { draft, events: [clockEvent(clock, player), finish(draft, opponentOf(player), null, FinishReason.TIMEOUT)] };
      }
      const board = placeStone(state.board, row, col, player);
      const move = Object.freeze({ row, col, player, timestamp, notation: toNotation(row, col, state.boardSize), index: state.moves.length });
      draft.board = board;
      draft.moves = [...state.moves, move];
      const events = [{ type: GameEvent.MOVE_COMMITTED, payload: { move } }];
      const renju = state.rules.mode === RuleMode.RENJU;
      const winLine = findWinLine(board, row, col, player, { exactFive: renju && player === BLACK });
      if (winLine) {
        events.push(finish(draft, player, winLine, FinishReason.FIVE));
        return { draft, events };
      }
      if (renju && player === BLACK) {
        const verdict = isForbidden(board, row, col);
        if (verdict.forbidden) {
          events.push(finish(draft, WHITE, null, FinishReason.FORBIDDEN, verdict.reason));
          return { draft, events };
        }
      }
      if (isBoardFull(board)) {
        events.push(finish(draft, 'DRAW', null, FinishReason.DRAW));
        return { draft, events };
      }
      draft.currentPlayer = opponentOf(player);
      events.push({ type: GameEvent.TURN_SWITCHED, payload: { currentPlayer: draft.currentPlayer, previousPlayer: player } });
      return { draft, events };
    },
  },

  [ActionType.UNDO_MOVE]: {
    validate(state) {
      if (state.status === GameStatus.SELECTING || state.moves.length === 0) return 'No moves to undo';
      return null;
    },
    apply(state, action, timestamp) {
      const requested = Number.isInteger(action.count) && action.count > 0 ? action.count : 1;
      const count = Math.min(requested, state.moves.length);
      const keep = state.moves.length - count;
      const undoneMoves = state.moves.slice(keep).reverse();
      const status = state.status === GameStatus.FINISHED ? GameStatus.PLAYING : state.status;
      const settled = settleClock(state.clock, state.currentPlayer, timestamp);
      const draft = {
        ...state,
        board: clearCells(state.board, undoneMoves),
        moves: state.moves.slice(0, keep),
        currentPlayer: state.moves[keep].player,
        status,
        winner: null,
        winLine: null,
        finishReason: null,
        clock: { ...settled, running: status === GameStatus.PLAYING, lastTickTimestamp: timestamp },
      };
      return { draft, events: [{ type: GameEvent.STATE_REVERTED, payload: { undoneMoves, currentPlayer: draft.currentPlayer } }] };
    },
  },

  [ActionType.TOGGLE_PAUSE]: {
    validate(state) {
      if (state.status !== GameStatus.PLAYING && state.status !== GameStatus.PAUSED) return `Cannot toggle pause while ${state.status}`;
      return null;
    },
    apply(state, action, timestamp) {
      const paused = state.status === GameStatus.PLAYING;
      const settled = paused ? settleClock(state.clock, state.currentPlayer, timestamp) : state.clock;
      const draft = {
        ...state,
        status: paused ? GameStatus.PAUSED : GameStatus.PLAYING,
        clock: { ...settled, running: !paused, lastTickTimestamp: timestamp },
      };
      return { draft, events: [{ type: GameEvent.PAUSE_TOGGLED, payload: { paused } }] };
    },
  },

  [ActionType.TICK]: {
    validate() {
      return null;
    },
    apply(state, action, timestamp) {
      if (state.status !== GameStatus.PLAYING || !state.clock.running) return null;
      const player = state.currentPlayer;
      const clock = settleClock(state.clock, player, timestamp);
      const draft = { ...state, clock };
      const events = [clockEvent(clock, player)];
      if (isOutOfTime(clock, player)) events.push(finish(draft, opponentOf(player), null, FinishReason.TIMEOUT));
      return { draft, events };
    },
  },

  [ActionType.RESIGN]: {
    validate(state, action) {
      if (state.status !== GameStatus.PLAYING && state.status !== GameStatus.PAUSED) return `Cannot resign while ${state.status}`;
      if (action.player != null && action.player !== BLACK && action.player !== WHITE) return 'Resigning player must be BLACK (1) or WHITE (2)';
      return null;
    },
    apply(state, action, timestamp) {
      const player = action.player ?? state.humanColor ?? state.currentPlayer;
      const draft = { ...state, clock: settleClock(state.clock, state.currentPlayer, timestamp) };
      const finished = finish(draft, opponentOf(player), null, FinishReason.RESIGN);
      finished.payload.resigned = player;
      return { draft, events: [finished] };
    },
  },

  [ActionType.RESET]: {
    validate(state, action) {
      if (action.config != null && typeof action.config !== 'object') return 'Reset config must be an object';
      return null;
    },
    apply(state, action) {
      const config = { ...configOf(state), ...(action.config ?? {}) };
      return { draft: { ...createInitialState(config) }, events: [{ type: GameEvent.GAME_RESET, payload: { config } }] };
    },
  },

  /**
   * Restore a game from a photographed / saved position: optional setup grid
   * plus optional moves played on top of it. Behaves like RESET followed by a
   * setup, so the game goes back to colour selection with the stones in place.
   * `{ board?: number[][], moves?: (string|{row,col})[], currentPlayer?: 1|2, config?: GameConfig }`
   */
  [ActionType.LOAD_POSITION]: {
    validate(state, action) {
      if (action.config != null && typeof action.config !== 'object') return 'Load config must be an object';
      const config = { ...configOf(state), ...(action.config ?? {}) };
      return prepareLoadedPosition(config, action, 0).error;
    },
    apply(state, action, timestamp) {
      const config = { ...configOf(state), ...(action.config ?? {}) };
      const loaded = /** @type {Exclude<ReturnType<typeof prepareLoadedPosition>, { error: string }>} */ (prepareLoadedPosition(config, action, timestamp));
      const draft = {
        ...createInitialState(config),
        board: loaded.board,
        setupBoard: loaded.setupBoard,
        moves: loaded.moves,
        currentPlayer: loaded.currentPlayer,
      };
      const counts = countStones(draft.board);
      return {
        draft,
        events: [
          { type: GameEvent.GAME_RESET, payload: { config } },
          { type: GameEvent.POSITION_LOADED, payload: { board: draft.board, moves: draft.moves, currentPlayer: draft.currentPlayer, counts, setupStones: loaded.setupBoard ? countStones(loaded.setupBoard).total : 0 } },
        ],
      };
    },
  },
};

function fail(state, action, error) {
  return { state, events: [{ type: GameEvent.INVALID_ACTION, payload: { error, action } }], error };
}

/**
 * Pure reducer. Never mutates `state`; on error the same state object is returned
 * together with a single INVALID_ACTION event. Successful transitions bump
 * `revision` and end with a STATE_CHANGED event. A TICK while the clock is
 * stopped is a silent no-op (same state, no events, no error).
 * @param {GameState} state
 * @param {Object} action `{ type, ...fields, timestamp? }`; timestamp defaults to Date.now().
 * @returns {TransitionResult}
 */
export function transition(state, action) {
  if (!action || typeof action.type !== 'string') return fail(state, action, 'Invalid action');
  const handler = HANDLERS[action.type];
  if (!handler) return fail(state, action, `Unknown action type: ${action.type}`);
  const error = handler.validate(state, action);
  if (error) return fail(state, action, error);
  const timestamp = Number.isFinite(action.timestamp) ? action.timestamp : Date.now();
  const outcome = handler.apply(state, action, timestamp);
  if (outcome === null) return { state, events: [], error: null };
  const { draft, events } = outcome;
  draft.lastAction = Object.freeze({ ...action, timestamp });
  draft.revision = state.revision + 1;
  const next = freezeState(draft);
  events.push({ type: GameEvent.STATE_CHANGED, payload: { revision: next.revision, status: next.status, action: next.lastAction } });
  return { state: next, events, error: null };
}

/**
 * Runs the same checks as `transition` without applying the action.
 * @returns {{ ok: boolean, error: string|null }}
 */
export function validateAction(state, action) {
  if (!action || typeof action.type !== 'string') return { ok: false, error: 'Invalid action' };
  const handler = HANDLERS[action.type];
  if (!handler) return { ok: false, error: `Unknown action type: ${action.type}` };
  const error = handler.validate(state, action);
  return { ok: error === null, error };
}

/** PLAYING, in bounds and empty. Does not consider Renju forbidden points. */
export function isLegalMove(state, row, col) {
  return state.status === GameStatus.PLAYING && inBounds(row, col, state.boardSize) && state.board[row][col] === EMPTY;
}

/**
 * All currently forbidden empty points when it is black's turn in RENJU mode
 * (for board markers); empty array otherwise.
 * @returns {{ row: number, col: number, reason: string }[]}
 */
export function getForbiddenPoints(state) {
  if (state.rules.mode !== RuleMode.RENJU || state.currentPlayer !== BLACK || state.status === GameStatus.FINISHED) return [];
  const size = state.boardSize;
  const flat = toFlatBoard(state.board);
  const points = [];
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (flat[row * size + col] !== EMPTY) continue;
      const verdict = isForbiddenFlat(flat, size, row, col);
      if (verdict.forbidden) points.push({ row, col, reason: verdict.reason });
    }
  }
  return points;
}

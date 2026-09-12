import { describe, it, expect } from 'vitest';
import {
  BOARD_SIZE, EMPTY, BLACK, WHITE,
  createEmptyBoard, inBounds, opponentOf, countRun, lineThrough, findWinLine, toNotation, fromNotation,
  FORBIDDEN, makesExactFive, makesOverline, countFours, countOpenThrees, isForbidden, analyzePoint,
  GameStatus, RuleMode, FinishReason, ActionType, GameEvent,
  createInitialState, transition, validateAction, isLegalMove, getForbiddenPoints,
  GameEngine,
} from '../src/core/index.js';

function boardWith(stones) {
  const board = createEmptyBoard();
  for (const [row, col, player] of stones) board[row][col] = player;
  return board;
}

function eventTypes(result) {
  return result.events.map((event) => event.type);
}

function eventOf(result, type) {
  return result.events.find((event) => event.type === type);
}

function startGame(config = {}, color = BLACK, timestamp = 1000) {
  const result = transition(createInitialState(config), { type: ActionType.SELECT_COLOR, color, timestamp });
  expect(result.error).toBeNull();
  return result.state;
}

/** Plays moves one second apart; throws on the first rejected move. */
function play(state, moves, startTimestamp = 1000) {
  let current = state;
  let timestamp = startTimestamp;
  const results = [];
  for (const [row, col] of moves) {
    timestamp += 1000;
    const result = transition(current, { type: ActionType.MAKE_MOVE, row, col, timestamp });
    if (result.error) throw new Error(`${row},${col}: ${result.error}`);
    results.push(result);
    current = result.state;
  }
  return { state: current, results, timestamp };
}

// Black builds a horizontal five on row 7 while white plays harmlessly on row 0.
const BLACK_FIVE_SEQUENCE = [[7, 3], [0, 0], [7, 4], [0, 1], [7, 5], [0, 2], [7, 6], [0, 3], [7, 7]];

describe('Gomoku primitives', () => {
  it('creates an empty board of the requested size', () => {
    const board = createEmptyBoard();
    expect(board).toHaveLength(BOARD_SIZE);
    expect(board.every((row) => row.length === BOARD_SIZE && row.every((cell) => cell === EMPTY))).toBe(true);
    expect(createEmptyBoard(9)).toHaveLength(9);
  });

  it('checks bounds and opponents', () => {
    expect(inBounds(0, 0)).toBe(true);
    expect(inBounds(14, 14)).toBe(true);
    expect(inBounds(15, 0)).toBe(false);
    expect(inBounds(-1, 3)).toBe(false);
    expect(inBounds(1.5, 3)).toBe(false);
    expect(opponentOf(BLACK)).toBe(WHITE);
    expect(opponentOf(WHITE)).toBe(BLACK);
  });

  it('counts runs and lines through a cell', () => {
    const board = boardWith([[7, 5, BLACK], [7, 6, BLACK], [7, 8, BLACK]]);
    expect(countRun(board, 7, 7, 0, -1, BLACK)).toBe(2);
    expect(countRun(board, 7, 7, 0, 1, BLACK)).toBe(1);
    const line = lineThrough(board, 7, 7, 0, 1, BLACK);
    expect(line.count).toBe(4);
    expect(line.cells[0]).toEqual({ row: 7, col: 5 });
    expect(line.cells[3]).toEqual({ row: 7, col: 8 });
  });

  it('finds horizontal, vertical and both diagonal fives', () => {
    const horizontal = boardWith([3, 4, 5, 6, 7].map((col) => [7, col, BLACK]));
    expect(findWinLine(horizontal, 7, 5, BLACK)).toHaveLength(5);
    expect(findWinLine(horizontal, 7, 5, BLACK)[0]).toEqual({ row: 7, col: 3 });

    const vertical = boardWith([2, 3, 4, 5, 6].map((row) => [row, 9, WHITE]));
    expect(findWinLine(vertical, 6, 9, WHITE)).toHaveLength(5);

    const diagonal = boardWith([0, 1, 2, 3, 4].map((k) => [5 + k, 5 + k, BLACK]));
    expect(findWinLine(diagonal, 7, 7, BLACK)).toHaveLength(5);

    const antiDiagonal = boardWith([0, 1, 2, 3, 4].map((k) => [5 + k, 9 - k, WHITE]));
    expect(findWinLine(antiDiagonal, 5, 9, WHITE)).toHaveLength(5);

    expect(findWinLine(boardWith([3, 4, 5, 6].map((col) => [7, col, BLACK])), 7, 5, BLACK)).toBeNull();
  });

  it('treats an overline as a win only when exactFive is off', () => {
    const board = boardWith([2, 3, 4, 5, 6, 7].map((col) => [7, col, BLACK]));
    expect(findWinLine(board, 7, 4, BLACK)).toHaveLength(6);
    expect(findWinLine(board, 7, 4, BLACK, { exactFive: true })).toBeNull();
  });

  it('converts notation both ways', () => {
    expect(toNotation(7, 7)).toBe('H8');
    expect(toNotation(14, 0)).toBe('A1');
    expect(toNotation(0, 14)).toBe('O15');
    expect(fromNotation('H8')).toEqual({ row: 7, col: 7 });
    expect(fromNotation('a1')).toEqual({ row: 14, col: 0 });
    expect(fromNotation('O15')).toEqual({ row: 0, col: 14 });
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) expect(fromNotation(toNotation(row, col))).toEqual({ row, col });
    }
    for (const bad of ['P1', 'H16', 'H0', '', 'HH', '88', null, undefined, 42]) expect(fromNotation(bad)).toBeNull();
  });
});

describe('Renju forbidden moves', () => {
  it('flags a double three', () => {
    const board = boardWith([[7, 6, BLACK], [7, 8, BLACK], [8, 7, BLACK], [9, 7, BLACK]]);
    expect(countOpenThrees(board, 7, 7)).toBe(2);
    expect(isForbidden(board, 7, 7)).toEqual({ forbidden: true, reason: FORBIDDEN.DOUBLE_THREE });
  });

  it('ignores a fake three whose extension points are forbidden', () => {
    // Both ends of the horizontal three (7,5)/(7,9) would create a vertical straight four
    // on top of the horizontal one: a 4-4, so the three can never become a straight four.
    const stones = [
      [7, 6, BLACK], [7, 8, BLACK], [8, 7, BLACK], [9, 7, BLACK],
      [4, 5, BLACK], [5, 5, BLACK], [6, 5, BLACK],
      [4, 9, BLACK], [5, 9, BLACK], [6, 9, BLACK],
    ];
    const afterMove = boardWith([...stones, [7, 7, BLACK]]);
    expect(isForbidden(afterMove, 7, 5).reason).toBe(FORBIDDEN.DOUBLE_FOUR);
    expect(isForbidden(afterMove, 7, 9).reason).toBe(FORBIDDEN.DOUBLE_FOUR);
    const board = boardWith(stones);
    expect(countOpenThrees(board, 7, 7)).toBe(1);
    expect(isForbidden(board, 7, 7).forbidden).toBe(false);
  });

  it('flags a double four on one line (XX_XX_XX)', () => {
    const board = boardWith([[7, 3, BLACK], [7, 4, BLACK], [7, 7, BLACK], [7, 9, BLACK], [7, 10, BLACK]]);
    expect(countFours(board, 7, 6)).toBe(2);
    expect(isForbidden(board, 7, 6)).toEqual({ forbidden: true, reason: FORBIDDEN.DOUBLE_FOUR });
  });

  it('flags a double four across two lines', () => {
    const board = boardWith([[7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK]]);
    expect(countFours(board, 7, 7)).toBe(2);
    expect(isForbidden(board, 7, 7).reason).toBe(FORBIDDEN.DOUBLE_FOUR);
  });

  it('flags an overline', () => {
    const board = boardWith([[7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [7, 8, BLACK], [7, 9, BLACK]]);
    expect(makesOverline(board, 7, 7, BLACK)).toBe(true);
    expect(makesExactFive(board, 7, 7, BLACK)).toBe(false);
    expect(isForbidden(board, 7, 7)).toEqual({ forbidden: true, reason: FORBIDDEN.OVERLINE });
  });

  it('lets a five override any forbidden pattern', () => {
    const board = boardWith([
      [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK],
      [4, 7, BLACK], [5, 7, BLACK], [6, 7, BLACK],
      [4, 4, BLACK], [5, 5, BLACK], [6, 6, BLACK],
    ]);
    expect(makesExactFive(board, 7, 7, BLACK)).toBe(true);
    expect(countFours(board, 7, 7)).toBeGreaterThanOrEqual(2);
    expect(isForbidden(board, 7, 7).forbidden).toBe(false);
  });

  it('counts a straight four as a single four', () => {
    const board = boardWith([[7, 5, BLACK], [7, 6, BLACK], [7, 7, BLACK]]);
    expect(countFours(board, 7, 8)).toBe(1);
    expect(isForbidden(board, 7, 8).forbidden).toBe(false);
    expect(analyzePoint(board, 7, 8, BLACK)).toEqual({ fives: 0, fours: 1, openThrees: 0, overline: false });
  });

  it('never restricts white', () => {
    const board = boardWith([[7, 6, WHITE], [7, 8, WHITE], [8, 7, WHITE], [9, 7, WHITE]]);
    expect(analyzePoint(board, 7, 7, WHITE).openThrees).toBe(2);
    const overline = boardWith([[7, 4, WHITE], [7, 5, WHITE], [7, 6, WHITE], [7, 8, WHITE], [7, 9, WHITE]]);
    expect(analyzePoint(overline, 7, 7, WHITE)).toMatchObject({ fives: 1, overline: true });
    // isForbidden only ever judges black: white stones on the board do not create black prohibitions.
    expect(isForbidden(board, 7, 7).forbidden).toBe(false);
  });
});

describe('GameState: initial state and immutability', () => {
  it('creates a frozen initial state with defaults', () => {
    const state = createInitialState();
    expect(state.status).toBe(GameStatus.SELECTING);
    expect(state.boardSize).toBe(15);
    expect(state.currentPlayer).toBe(BLACK);
    expect(state.moves).toEqual([]);
    expect(state.humanColor).toBeNull();
    expect(state.rules.mode).toBe(RuleMode.STANDARD);
    expect(state.clock).toEqual({ initialMs: 600000, black: 600000, white: 600000, lastTickTimestamp: null, running: false });
    expect(state.revision).toBe(0);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.board)).toBe(true);
    expect(state.board.every((row) => Object.isFrozen(row))).toBe(true);
    expect(Object.isFrozen(state.clock)).toBe(true);
    expect(Object.isFrozen(state.rules)).toBe(true);
    expect(Object.isFrozen(state.moves)).toBe(true);
  });

  it('honours config', () => {
    const state = createInitialState({ mode: RuleMode.RENJU, initialMs: 5000, boardSize: 9 });
    expect(state.rules.mode).toBe(RuleMode.RENJU);
    expect(state.clock.black).toBe(5000);
    expect(state.board).toHaveLength(9);
  });

  it('never mutates the previous state and shares untouched rows', () => {
    const before = startGame();
    const snapshot = JSON.stringify(before);
    const result = transition(before, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 2000 });
    expect(result.error).toBeNull();
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(result.state).not.toBe(before);
    expect(Object.isFrozen(result.state)).toBe(true);
    expect(result.state.board[7]).not.toBe(before.board[7]);
    expect(result.state.board[7][7]).toBe(BLACK);
    expect(before.board[7][7]).toBe(EMPTY);
    for (let row = 0; row < 15; row++) {
      if (row !== 7) expect(result.state.board[row]).toBe(before.board[row]);
    }
    expect(Object.isFrozen(result.state.board[7])).toBe(true);
    expect(Object.isFrozen(result.state.moves)).toBe(true);
    expect(Object.isFrozen(result.state.moves[0])).toBe(true);
    expect(result.state.rules).toBe(before.rules);
    expect(result.state.revision).toBe(before.revision + 1);
  });
});

describe('GameState: full flow', () => {
  it('selects a colour, plays and finishes with a five', () => {
    const initial = createInitialState();
    const selected = transition(initial, { type: ActionType.SELECT_COLOR, color: WHITE, timestamp: 1000 });
    expect(eventTypes(selected)).toEqual([GameEvent.COLOR_SELECTED, GameEvent.STATE_CHANGED]);
    expect(eventOf(selected, GameEvent.COLOR_SELECTED).payload).toEqual({ humanColor: WHITE, aiColor: BLACK });
    expect(selected.state.status).toBe(GameStatus.PLAYING);
    expect(selected.state.clock.running).toBe(true);
    expect(selected.state.clock.lastTickTimestamp).toBe(1000);

    const { state, results } = play(selected.state, BLACK_FIVE_SEQUENCE);
    const first = results[0];
    expect(eventTypes(first)).toEqual([GameEvent.MOVE_COMMITTED, GameEvent.TURN_SWITCHED, GameEvent.STATE_CHANGED]);
    expect(eventOf(first, GameEvent.MOVE_COMMITTED).payload.move).toMatchObject({ row: 7, col: 3, player: BLACK, notation: 'D8', index: 0 });
    expect(eventOf(first, GameEvent.TURN_SWITCHED).payload).toEqual({ currentPlayer: WHITE, previousPlayer: BLACK });

    const last = results[results.length - 1];
    expect(eventTypes(last)).toEqual([GameEvent.MOVE_COMMITTED, GameEvent.GAME_FINISHED, GameEvent.STATE_CHANGED]);
    const finished = eventOf(last, GameEvent.GAME_FINISHED).payload;
    expect(finished.winner).toBe(BLACK);
    expect(finished.reason).toBe(FinishReason.FIVE);
    expect(finished.winLine).toHaveLength(5);
    expect(state.status).toBe(GameStatus.FINISHED);
    expect(state.winner).toBe(BLACK);
    expect(state.finishReason).toBe(FinishReason.FIVE);
    expect(state.winLine.map((cell) => cell.col)).toEqual([3, 4, 5, 6, 7]);
    expect(state.clock.running).toBe(false);
    expect(state.moves).toHaveLength(9);
    expect(state.moves[8].notation).toBe('H8');
    expect(state.revision).toBe(10);
  });

  it('settles the mover clock on each move', () => {
    const { state } = play(startGame(), [[7, 7], [7, 8]]);
    expect(state.clock.black).toBe(600000 - 1000);
    expect(state.clock.white).toBe(600000 - 1000);
    expect(state.clock.lastTickTimestamp).toBe(3000);
  });
});

describe('GameState: invalid actions', () => {
  const rejected = (state, action) => {
    const result = transition(state, action);
    expect(result.state).toBe(state);
    expect(result.error).toEqual(expect.any(String));
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe(GameEvent.INVALID_ACTION);
    expect(result.events[0].payload).toEqual({ error: result.error, action });
    expect(validateAction(state, action)).toEqual({ ok: false, error: result.error });
    return result;
  };

  it('rejects moves on occupied or off-board cells', () => {
    const { state } = play(startGame(), [[7, 7]]);
    rejected(state, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 5000 });
    rejected(state, { type: ActionType.MAKE_MOVE, row: 15, col: 0, timestamp: 5000 });
    rejected(state, { type: ActionType.MAKE_MOVE, row: -1, col: 0, timestamp: 5000 });
    rejected(state, { type: ActionType.MAKE_MOVE, row: 1.5, col: 0, timestamp: 5000 });
    expect(validateAction(state, { type: ActionType.MAKE_MOVE, row: 8, col: 8 })).toEqual({ ok: true, error: null });
    expect(isLegalMove(state, 8, 8)).toBe(true);
    expect(isLegalMove(state, 7, 7)).toBe(false);
    expect(isLegalMove(state, 20, 20)).toBe(false);
  });

  it('rejects moving before a colour is selected and while paused', () => {
    const initial = createInitialState();
    rejected(initial, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 1000 });
    expect(isLegalMove(initial, 7, 7)).toBe(false);
    const paused = transition(startGame(), { type: ActionType.TOGGLE_PAUSE, timestamp: 2000 }).state;
    rejected(paused, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 3000 });
  });

  it('rejects out-of-phase and malformed actions', () => {
    const playing = startGame();
    rejected(playing, { type: ActionType.SELECT_COLOR, color: BLACK, timestamp: 2000 });
    rejected(createInitialState(), { type: ActionType.SELECT_COLOR, color: 3, timestamp: 2000 });
    rejected(playing, { type: ActionType.UNDO_MOVE, timestamp: 2000 });
    rejected(createInitialState(), { type: ActionType.TOGGLE_PAUSE, timestamp: 2000 });
    rejected(createInitialState(), { type: ActionType.RESIGN, timestamp: 2000 });
    rejected(playing, { type: 'FLY_TO_MOON' });
    const nothing = transition(playing, null);
    expect(nothing.state).toBe(playing);
    expect(nothing.error).toBe('Invalid action');
  });
});

describe('GameState: undo', () => {
  it('undoes several moves, restoring board and turn', () => {
    const { state } = play(startGame(), [[7, 7], [7, 8], [8, 8]]);
    const result = transition(state, { type: ActionType.UNDO_MOVE, count: 2, timestamp: 9000 });
    expect(result.error).toBeNull();
    expect(eventTypes(result)).toEqual([GameEvent.STATE_REVERTED, GameEvent.STATE_CHANGED]);
    const payload = eventOf(result, GameEvent.STATE_REVERTED).payload;
    expect(payload.undoneMoves.map((move) => move.index)).toEqual([2, 1]);
    expect(payload.currentPlayer).toBe(WHITE);
    expect(result.state.moves).toHaveLength(1);
    expect(result.state.board[7][8]).toBe(EMPTY);
    expect(result.state.board[8][8]).toBe(EMPTY);
    expect(result.state.board[7][7]).toBe(BLACK);
    expect(result.state.currentPlayer).toBe(WHITE);
    expect(result.state.status).toBe(GameStatus.PLAYING);
    expect(result.state.clock.running).toBe(true);
    expect(result.state.clock.lastTickTimestamp).toBe(9000);
    expect(result.state.board[0]).toBe(state.board[0]);
  });

  it('clamps the count and defaults to one', () => {
    const { state } = play(startGame(), [[7, 7], [7, 8]]);
    expect(transition(state, { type: ActionType.UNDO_MOVE, count: 10, timestamp: 5000 }).state.moves).toHaveLength(0);
    const single = transition(state, { type: ActionType.UNDO_MOVE, timestamp: 5000 }).state;
    expect(single.moves).toHaveLength(1);
    expect(single.currentPlayer).toBe(WHITE);
  });

  it('reopens a finished game', () => {
    const { state } = play(startGame(), BLACK_FIVE_SEQUENCE);
    expect(state.status).toBe(GameStatus.FINISHED);
    const result = transition(state, { type: ActionType.UNDO_MOVE, timestamp: 20000 });
    expect(result.error).toBeNull();
    expect(result.state.status).toBe(GameStatus.PLAYING);
    expect(result.state.winner).toBeNull();
    expect(result.state.winLine).toBeNull();
    expect(result.state.finishReason).toBeNull();
    expect(result.state.currentPlayer).toBe(BLACK);
    expect(result.state.board[7][7]).toBe(EMPTY);
    expect(result.state.clock.running).toBe(true);
  });

  it('keeps a paused game paused', () => {
    const { state } = play(startGame(), [[7, 7]]);
    const paused = transition(state, { type: ActionType.TOGGLE_PAUSE, timestamp: 3000 }).state;
    const undone = transition(paused, { type: ActionType.UNDO_MOVE, timestamp: 4000 }).state;
    expect(undone.status).toBe(GameStatus.PAUSED);
    expect(undone.clock.running).toBe(false);
    expect(undone.moves).toHaveLength(0);
  });
});

describe('GameState: pause and clock', () => {
  it('toggles pause and stops the clock', () => {
    const playing = startGame();
    const paused = transition(playing, { type: ActionType.TOGGLE_PAUSE, timestamp: 4000 });
    expect(eventOf(paused, GameEvent.PAUSE_TOGGLED).payload).toEqual({ paused: true });
    expect(paused.state.status).toBe(GameStatus.PAUSED);
    expect(paused.state.clock.running).toBe(false);
    expect(paused.state.clock.black).toBe(600000 - 3000);

    const ticked = transition(paused.state, { type: ActionType.TICK, timestamp: 60000 });
    expect(ticked.state).toBe(paused.state);
    expect(ticked.events).toEqual([]);
    expect(ticked.error).toBeNull();

    const resumed = transition(paused.state, { type: ActionType.TOGGLE_PAUSE, timestamp: 90000 });
    expect(eventOf(resumed, GameEvent.PAUSE_TOGGLED).payload).toEqual({ paused: false });
    expect(resumed.state.status).toBe(GameStatus.PLAYING);
    expect(resumed.state.clock.running).toBe(true);
    expect(resumed.state.clock.lastTickTimestamp).toBe(90000);
    expect(resumed.state.clock.black).toBe(600000 - 3000);

    const afterTick = transition(resumed.state, { type: ActionType.TICK, timestamp: 91000 }).state;
    expect(afterTick.clock.black).toBe(600000 - 4000);
  });

  it('ticks the current player down and finishes on timeout', () => {
    const playing = startGame({ initialMs: 5000 });
    const ticked = transition(playing, { type: ActionType.TICK, timestamp: 3000 });
    expect(eventTypes(ticked)).toEqual([GameEvent.CLOCK_TICKED, GameEvent.STATE_CHANGED]);
    expect(eventOf(ticked, GameEvent.CLOCK_TICKED).payload).toEqual({ black: 3000, white: 5000, currentPlayer: BLACK });
    expect(ticked.state.clock.black).toBe(3000);
    expect(ticked.state.clock.white).toBe(5000);

    const expired = transition(ticked.state, { type: ActionType.TICK, timestamp: 7000 });
    expect(eventTypes(expired)).toEqual([GameEvent.CLOCK_TICKED, GameEvent.GAME_FINISHED, GameEvent.STATE_CHANGED]);
    expect(expired.state.status).toBe(GameStatus.FINISHED);
    expect(expired.state.winner).toBe(WHITE);
    expect(expired.state.finishReason).toBe(FinishReason.TIMEOUT);
    expect(expired.state.clock.black).toBe(0);
    expect(expired.state.clock.running).toBe(false);
    expect(eventOf(expired, GameEvent.GAME_FINISHED).payload).toMatchObject({ winner: WHITE, reason: FinishReason.TIMEOUT, winLine: null });
  });

  it('ignores ticks before the game starts', () => {
    const initial = createInitialState();
    const result = transition(initial, { type: ActionType.TICK, timestamp: 5000 });
    expect(result.state).toBe(initial);
    expect(result.events).toEqual([]);
  });

  it('turns a late move into a timeout instead of placing the stone', () => {
    const playing = startGame({ initialMs: 2000 });
    const result = transition(playing, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 4000 });
    expect(result.error).toBeNull();
    expect(result.state.status).toBe(GameStatus.FINISHED);
    expect(result.state.finishReason).toBe(FinishReason.TIMEOUT);
    expect(result.state.winner).toBe(WHITE);
    expect(result.state.board[7][7]).toBe(EMPTY);
    expect(result.state.moves).toHaveLength(0);
    expect(eventTypes(result)).toEqual([GameEvent.CLOCK_TICKED, GameEvent.GAME_FINISHED, GameEvent.STATE_CHANGED]);
  });
});

describe('GameState: resign, reset and reselect', () => {
  it('resigns for the human by default', () => {
    const playing = startGame({}, BLACK);
    const result = transition(playing, { type: ActionType.RESIGN, timestamp: 2000 });
    expect(eventTypes(result)).toEqual([GameEvent.GAME_FINISHED, GameEvent.STATE_CHANGED]);
    expect(result.state.status).toBe(GameStatus.FINISHED);
    expect(result.state.winner).toBe(WHITE);
    expect(result.state.finishReason).toBe(FinishReason.RESIGN);
    expect(eventOf(result, GameEvent.GAME_FINISHED).payload).toMatchObject({ winner: WHITE, reason: FinishReason.RESIGN, resigned: BLACK });
    const explicit = transition(playing, { type: ActionType.RESIGN, player: WHITE, timestamp: 2000 });
    expect(explicit.state.winner).toBe(BLACK);
  });

  it('resets to a fresh state that keeps the rule config', () => {
    const { state } = play(startGame({ mode: RuleMode.RENJU, initialMs: 42000 }), [[7, 7]]);
    const result = transition(state, { type: ActionType.RESET, timestamp: 9000 });
    expect(eventTypes(result)).toEqual([GameEvent.GAME_RESET, GameEvent.STATE_CHANGED]);
    expect(result.state.status).toBe(GameStatus.SELECTING);
    expect(result.state.moves).toHaveLength(0);
    expect(result.state.board[7][7]).toBe(EMPTY);
    expect(result.state.rules.mode).toBe(RuleMode.RENJU);
    expect(result.state.clock.black).toBe(42000);
    expect(result.state.revision).toBe(state.revision + 1);
    const overridden = transition(state, { type: ActionType.RESET, config: { mode: RuleMode.STANDARD } });
    expect(overridden.state.rules.mode).toBe(RuleMode.STANDARD);
  });

  it('starts a new game when selecting a colour after a finish', () => {
    const { state } = play(startGame(), BLACK_FIVE_SEQUENCE);
    const result = transition(state, { type: ActionType.SELECT_COLOR, color: WHITE, timestamp: 50000 });
    expect(eventTypes(result)).toEqual([GameEvent.GAME_RESET, GameEvent.COLOR_SELECTED, GameEvent.STATE_CHANGED]);
    expect(result.state.status).toBe(GameStatus.PLAYING);
    expect(result.state.humanColor).toBe(WHITE);
    expect(result.state.moves).toHaveLength(0);
    expect(result.state.board[7][7]).toBe(EMPTY);
    expect(result.state.winner).toBeNull();
    expect(result.state.clock.black).toBe(600000);
    expect(result.state.clock.lastTickTimestamp).toBe(50000);
  });
});

describe('GameState: Renju mode', () => {
  it('loses immediately on a forbidden move', () => {
    const start = startGame({ mode: RuleMode.RENJU });
    const { state } = play(start, [[7, 6], [0, 0], [7, 8], [0, 1], [8, 7], [0, 2], [9, 7], [0, 3]]);
    expect(getForbiddenPoints(state)).toContainEqual({ row: 7, col: 7, reason: FORBIDDEN.DOUBLE_THREE });
    const result = transition(state, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 20000 });
    expect(result.error).toBeNull();
    expect(eventTypes(result)).toEqual([GameEvent.MOVE_COMMITTED, GameEvent.GAME_FINISHED, GameEvent.STATE_CHANGED]);
    expect(eventOf(result, GameEvent.GAME_FINISHED).payload).toEqual({
      winner: WHITE, winLine: null, reason: FinishReason.FORBIDDEN, forbidden: FORBIDDEN.DOUBLE_THREE,
    });
    expect(result.state.status).toBe(GameStatus.FINISHED);
    expect(result.state.winner).toBe(WHITE);
    expect(result.state.finishReason).toBe(FinishReason.FORBIDDEN);
    expect(result.state.board[7][7]).toBe(BLACK);
  });

  it('does not let black win with an overline', () => {
    const start = startGame({ mode: RuleMode.RENJU });
    const { state } = play(start, [[7, 4], [0, 0], [7, 5], [0, 2], [7, 6], [0, 4], [7, 8], [0, 6], [7, 9], [0, 8]]);
    const result = transition(state, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 30000 });
    expect(result.state.winner).toBe(WHITE);
    expect(result.state.finishReason).toBe(FinishReason.FORBIDDEN);
    expect(eventOf(result, GameEvent.GAME_FINISHED).payload.forbidden).toBe(FORBIDDEN.OVERLINE);
  });

  it('lets white win with an overline and black with an exact five', () => {
    const start = startGame({ mode: RuleMode.RENJU }, WHITE);
    const whiteOverline = play(start, [[0, 0], [7, 4], [0, 2], [7, 5], [0, 4], [7, 6], [0, 6], [7, 8], [0, 8], [7, 9], [0, 10], [7, 7]]).state;
    expect(whiteOverline.status).toBe(GameStatus.FINISHED);
    expect(whiteOverline.winner).toBe(WHITE);
    expect(whiteOverline.finishReason).toBe(FinishReason.FIVE);
    expect(whiteOverline.winLine).toHaveLength(6);

    const blackFive = play(startGame({ mode: RuleMode.RENJU }), BLACK_FIVE_SEQUENCE).state;
    expect(blackFive.winner).toBe(BLACK);
    expect(blackFive.finishReason).toBe(FinishReason.FIVE);
  });

  it('white is never judged for forbidden shapes', () => {
    const start = startGame({ mode: RuleMode.RENJU }, WHITE);
    const { state } = play(start, [[0, 0], [7, 6], [0, 2], [7, 8], [0, 4], [8, 7], [0, 6], [9, 7], [0, 8]]);
    const result = transition(state, { type: ActionType.MAKE_MOVE, row: 7, col: 7, timestamp: 30000 });
    expect(result.error).toBeNull();
    expect(result.state.status).toBe(GameStatus.PLAYING);
    expect(result.state.currentPlayer).toBe(BLACK);
  });

  it('lists forbidden points only for black to move in RENJU', () => {
    const renju = play(startGame({ mode: RuleMode.RENJU }), [[7, 6], [0, 0], [7, 8], [0, 1], [8, 7], [0, 2], [9, 7], [0, 3]]).state;
    const points = getForbiddenPoints(renju);
    expect(points.some((point) => point.row === 7 && point.col === 7)).toBe(true);
    expect(points.every((point) => renju.board[point.row][point.col] === EMPTY)).toBe(true);
    const whiteToMove = play(renju, [[3, 3]]).state;
    expect(getForbiddenPoints(whiteToMove)).toEqual([]);
    const standard = play(startGame(), [[7, 6], [0, 0], [7, 8], [0, 1], [8, 7], [0, 2], [9, 7], [0, 3]]).state;
    expect(getForbiddenPoints(standard)).toEqual([]);
  });
});

describe('GameEngine', () => {
  it('dispatches actions and notifies typed and wildcard listeners', () => {
    const engine = new GameEngine();
    const moves = [];
    const everything = [];
    const offMove = engine.on(GameEvent.MOVE_COMMITTED, (payload, event, state) => {
      moves.push(payload.move.notation);
      expect(event.type).toBe(GameEvent.MOVE_COMMITTED);
      expect(state).toBe(engine.getState());
    });
    engine.on('*', (payload, event) => everything.push(event.type));

    expect(engine.selectColor(BLACK, 1000).error).toBeNull();
    expect(engine.isHumanTurn()).toBe(true);
    expect(engine.isAiTurn()).toBe(false);
    engine.makeMove(7, 7, 2000);
    expect(engine.isAiTurn()).toBe(true);
    expect(engine.currentPlayer).toBe(WHITE);
    expect(engine.status).toBe(GameStatus.PLAYING);
    expect(engine.moves).toHaveLength(1);
    expect(moves).toEqual(['H8']);

    offMove();
    engine.makeMove(7, 8, 3000);
    expect(moves).toEqual(['H8']);
    expect(everything).toContain(GameEvent.COLOR_SELECTED);
    expect(everything.filter((type) => type === GameEvent.MOVE_COMMITTED)).toHaveLength(2);

    const invalid = engine.makeMove(7, 8, 4000);
    expect(invalid.error).toEqual(expect.any(String));
    expect(everything.at(-1)).toBe(GameEvent.INVALID_ACTION);

    const handler = () => everything.push('never');
    engine.on(GameEvent.STATE_CHANGED, handler);
    engine.off(GameEvent.STATE_CHANGED, handler);
    engine.undo(1, 5000);
    expect(everything).not.toContain('never');
    expect(engine.moves).toHaveLength(1);

    engine.togglePause(6000);
    expect(engine.status).toBe(GameStatus.PAUSED);
    expect(engine.tick(7000).events).toEqual([]);
    engine.togglePause(8000);
    engine.resign(undefined, 9000);
    expect(engine.getState().winner).toBe(WHITE);
    engine.reset();
    expect(engine.status).toBe(GameStatus.SELECTING);
    expect(Object.isFrozen(engine.getState())).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import {
  EMPTY, BLACK, WHITE, createEmptyBoard,
  GameStatus, RuleMode, ActionType, GameEvent, createInitialState, transition, validateAction, GameEngine,
  PositionVerdict, validateGrid, countStones, inferTurn, findLines, analyzePosition, boardToText, parseBoardText,
  toRecord, parseRecord, RECORD_APP,
} from '../src/core/index.js';

function boardWith(stones) {
  const board = createEmptyBoard();
  for (const [row, col, player] of stones) board[row][col] = player;
  return board;
}

const eventTypes = (result) => result.events.map((e) => e.type);

// A quiet middle-game position: black to move (6 v 6), nobody near five.
const MIDGAME = boardWith([
  [7, 7, BLACK], [7, 8, WHITE], [8, 7, BLACK], [6, 8, WHITE], [8, 8, BLACK], [9, 9, WHITE],
  [6, 6, BLACK], [5, 5, WHITE], [8, 6, BLACK], [9, 6, WHITE], [10, 10, BLACK], [4, 4, WHITE],
]);

describe('Setup: grid validation and counting', () => {
  it('validates the grid shape and cell values', () => {
    expect(validateGrid(createEmptyBoard())).toBeNull();
    expect(validateGrid(createEmptyBoard(9), 9)).toBeNull();
    expect(validateGrid(createEmptyBoard(9))).toMatch(/15 rows/);
    expect(validateGrid(null)).toMatch(/rows/);
    const bad = createEmptyBoard();
    bad[3][4] = 7;
    expect(validateGrid(bad)).toMatch(/\(3, 4\)/);
    const ragged = createEmptyBoard();
    ragged[2] = [0, 1];
    expect(validateGrid(ragged)).toMatch(/Row 2/);
  });

  it('counts stones and infers the side to move', () => {
    expect(countStones(MIDGAME)).toEqual({ black: 6, white: 6, empty: 213, total: 12 });
    expect(inferTurn({ black: 6, white: 6 })).toEqual({ player: BLACK, consistent: true });
    expect(inferTurn({ black: 7, white: 6 })).toEqual({ player: WHITE, consistent: true });
    expect(inferTurn({ black: 9, white: 6 })).toEqual({ player: WHITE, consistent: false });
    expect(inferTurn({ black: 2, white: 6 })).toEqual({ player: BLACK, consistent: false });
  });
});

describe('Setup: line detection and verdicts', () => {
  it('reports each maximal run once, in every direction', () => {
    const board = boardWith([
      ...[3, 4, 5, 6, 7].map((c) => [2, c, BLACK]),
      ...[0, 1, 2, 3, 4, 5].map((k) => [5 + k, 5 + k, WHITE]),
      ...[0, 1, 2, 3, 4].map((k) => [14 - k, k, BLACK]),
    ]);
    const black = findLines(board, BLACK);
    expect(black).toHaveLength(2);
    expect(black.map((l) => l.count)).toEqual([5, 5]);
    expect(black[0].cells[0]).toEqual({ row: 2, col: 3 });
    const white = findLines(board, WHITE);
    expect(white).toHaveLength(1);
    expect(white[0].count).toBe(6);
    expect(findLines(board, WHITE, { min: 7 })).toHaveLength(0);
    expect(findLines(MIDGAME, BLACK)).toHaveLength(0);
  });

  it('classifies playable, empty, decided and full positions', () => {
    expect(analyzePosition(MIDGAME)).toMatchObject({ ok: true, verdict: PositionVerdict.PLAYABLE, playable: true, winner: null });
    expect(analyzePosition(createEmptyBoard())).toMatchObject({ verdict: PositionVerdict.EMPTY, playable: true });

    const blackFive = boardWith([...[3, 4, 5, 6, 7].map((c) => [7, c, BLACK]), [0, 0, WHITE], [0, 1, WHITE], [0, 2, WHITE], [0, 3, WHITE]]);
    const won = analyzePosition(blackFive);
    expect(won.verdict).toBe(PositionVerdict.BLACK_WON);
    expect(won.playable).toBe(false);
    expect(won.winner).toBe(BLACK);
    expect(won.winLine).toHaveLength(5);

    const whiteFive = boardWith([...[3, 4, 5, 6, 7].map((r) => [r, 9, WHITE]), [0, 0, BLACK], [0, 1, BLACK], [0, 2, BLACK], [0, 3, BLACK], [1, 5, BLACK]]);
    expect(analyzePosition(whiteFive)).toMatchObject({ verdict: PositionVerdict.WHITE_WON, winner: WHITE });

    const both = boardWith([...[3, 4, 5, 6, 7].map((c) => [7, c, BLACK]), ...[3, 4, 5, 6, 7].map((c) => [9, c, WHITE])]);
    expect(analyzePosition(both)).toMatchObject({ verdict: PositionVerdict.BOTH_WON, playable: false, winner: null });

    const full = createEmptyBoard();
    // Checkerboard-ish fill without any five: alternate colours per cell with a row shift every two rows.
    for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) full[r][c] = ((c + (r >> 1)) % 2 === 0) ? BLACK : WHITE;
    const fullAnalysis = analyzePosition(full);
    expect(fullAnalysis.counts.empty).toBe(0);
    expect([PositionVerdict.FULL, PositionVerdict.BLACK_WON, PositionVerdict.WHITE_WON, PositionVerdict.BOTH_WON]).toContain(fullAnalysis.verdict);
    expect(fullAnalysis.playable).toBe(false);

    expect(analyzePosition(createEmptyBoard(9))).toMatchObject({ ok: false, verdict: PositionVerdict.INVALID, playable: false });
  });

  it('applies Renju rules to black: exactly five wins, an overline loses', () => {
    const overline = boardWith([2, 3, 4, 5, 6, 7].map((c) => [7, c, BLACK]));
    expect(analyzePosition(overline, { mode: RuleMode.RENJU })).toMatchObject({ verdict: PositionVerdict.WHITE_WON, winner: WHITE });
    expect(analyzePosition(overline, { mode: RuleMode.STANDARD })).toMatchObject({ verdict: PositionVerdict.BLACK_WON, winner: BLACK });
    const five = boardWith([3, 4, 5, 6, 7].map((c) => [7, c, BLACK]));
    expect(analyzePosition(five, { mode: RuleMode.RENJU })).toMatchObject({ verdict: PositionVerdict.BLACK_WON });
  });
});

describe('Setup: text notation', () => {
  it('round-trips through boardToText / parseBoardText', () => {
    const text = boardToText(MIDGAME);
    expect(text.split('\n')).toHaveLength(15);
    expect(text.split('\n')[7]).toBe('.......XO......');
    expect(parseBoardText(text)).toEqual(MIDGAME);
  });

  it('tolerates spacing, rank labels, coordinate headers and alternative glyphs', () => {
    const rows = boardToText(MIDGAME).split('\n');
    const decorated = ['    A B C D E F G H I J K L M N O', ...rows.map((r, i) => `${String(15 - i).padStart(2, ' ')} ${r.split('').join(' ')} ${15 - i}`), '    A B C D E F G H I J K L M N O'].join('\n');
    expect(parseBoardText(decorated)).toEqual(MIDGAME);

    const glyphs = rows.map((r) => r.replace(/X/g, '●').replace(/O/g, '○').replace(/\./g, '·')).join('\n');
    expect(parseBoardText(glyphs)).toEqual(MIDGAME);
    const digits = rows.map((r) => r.replace(/X/g, '1').replace(/O/g, '2').replace(/\./g, '0')).join('\n');
    expect(parseBoardText(digits)).toEqual(MIDGAME);
  });

  it('rejects boards with the wrong number of rows or cells', () => {
    expect(parseBoardText(boardToText(MIDGAME).split('\n').slice(1).join('\n'))).toBeNull();
    expect(parseBoardText('...............\n'.repeat(15).replace('...............', '..............'))).toBeNull();
    expect(parseBoardText('hello')).toBeNull();
    expect(parseBoardText(42)).toBeNull();
  });
});

describe('GameState: LOAD_POSITION', () => {
  it('restores a setup grid and returns to colour selection', () => {
    const result = transition(createInitialState(), { type: ActionType.LOAD_POSITION, board: MIDGAME, timestamp: 5000 });
    expect(result.error).toBeNull();
    expect(eventTypes(result)).toEqual([GameEvent.GAME_RESET, GameEvent.POSITION_LOADED, GameEvent.STATE_CHANGED]);
    const loaded = result.events[1].payload;
    expect(loaded.counts).toEqual({ black: 6, white: 6, empty: 213, total: 12 });
    expect(loaded.setupStones).toBe(12);
    expect(loaded.currentPlayer).toBe(BLACK);

    const { state } = result;
    expect(state.status).toBe(GameStatus.SELECTING);
    expect(state.board).toEqual(MIDGAME);
    expect(state.setupBoard).toEqual(MIDGAME);
    expect(state.moves).toHaveLength(0);
    expect(state.currentPlayer).toBe(BLACK);
    expect(Object.isFrozen(state.board[7])).toBe(true);
    expect(Object.isFrozen(state.setupBoard)).toBe(true);
    expect(Object.isFrozen(state.setupBoard[0])).toBe(true);
    // The caller's grid is never aliased.
    expect(state.board).not.toBe(MIDGAME);
    expect(state.setupBoard).not.toBe(state.board);
  });

  it('infers white to move when black has one stone more, and accepts an explicit override', () => {
    const board = boardWith([[7, 7, BLACK], [7, 8, WHITE], [8, 8, BLACK]]);
    expect(transition(createInitialState(), { type: ActionType.LOAD_POSITION, board }).state.currentPlayer).toBe(WHITE);
    const odd = boardWith([[7, 7, BLACK], [8, 8, BLACK], [9, 9, BLACK]]);
    expect(transition(createInitialState(), { type: ActionType.LOAD_POSITION, board: odd }).state.currentPlayer).toBe(WHITE);
    expect(transition(createInitialState(), { type: ActionType.LOAD_POSITION, board: odd, currentPlayer: BLACK }).state.currentPlayer).toBe(BLACK);
  });

  it('replays recorded moves on top of the setup with alternating colours', () => {
    const result = transition(createInitialState(), {
      type: ActionType.LOAD_POSITION, board: MIDGAME, moves: ['A1', { row: 0, col: 14 }, 'B2'], timestamp: 7000,
    });
    expect(result.error).toBeNull();
    const { state } = result;
    expect(state.moves.map((m) => [m.notation, m.player, m.index])).toEqual([['A1', BLACK, 0], ['O15', WHITE, 1], ['B2', BLACK, 2]]);
    expect(state.moves[0].timestamp).toBe(7000);
    expect(state.board[14][0]).toBe(BLACK);
    expect(state.board[0][14]).toBe(WHITE);
    expect(state.board[13][1]).toBe(BLACK);
    expect(state.currentPlayer).toBe(WHITE);
    expect(state.setupBoard[14][0]).toBe(EMPTY);
  });

  it('replays a plain move list onto an empty board (normal game record)', () => {
    const { state } = transition(createInitialState(), { type: ActionType.LOAD_POSITION, moves: ['H8', 'I9', 'G7'] });
    expect(state.setupBoard).toBeNull();
    expect(state.moves.map((m) => m.player)).toEqual([BLACK, WHITE, BLACK]);
    expect(state.currentPlayer).toBe(WHITE);
  });

  it('rejects malformed, decided or unplayable input without touching the state', () => {
    const initial = createInitialState();
    const rejected = (action) => {
      const result = transition(initial, action);
      expect(result.state).toBe(initial);
      expect(result.error).toEqual(expect.any(String));
      expect(validateAction(initial, action)).toEqual({ ok: false, error: result.error });
      return result.error;
    };
    expect(rejected({ type: ActionType.LOAD_POSITION, board: createEmptyBoard(9) })).toMatch(/15 rows/);
    expect(rejected({ type: ActionType.LOAD_POSITION, board: boardWith([3, 4, 5, 6, 7].map((c) => [7, c, BLACK])) })).toMatch(/black already has five/);
    expect(rejected({ type: ActionType.LOAD_POSITION, board: MIDGAME, moves: ['H8'] })).toMatch(/occupied/);
    expect(rejected({ type: ActionType.LOAD_POSITION, moves: ['Z9'] })).toMatch(/not a board cell/);
    expect(rejected({ type: ActionType.LOAD_POSITION, moves: 'H8' })).toMatch(/array/);
    expect(rejected({ type: ActionType.LOAD_POSITION, board: MIDGAME, currentPlayer: 3 })).toMatch(/currentPlayer/);
    expect(rejected({ type: ActionType.LOAD_POSITION, config: 5 })).toMatch(/config/);
    // Moves that complete a five make the position decided.
    expect(rejected({ type: ActionType.LOAD_POSITION, moves: ['A1', 'O15', 'B1', 'O14', 'C1', 'O13', 'D1', 'O12', 'E1'] })).toMatch(/black already has five/);
  });

  it('flows into a normal game: select colour, move, undo only new moves, reset clears the setup', () => {
    const engine = new GameEngine({ mode: RuleMode.STANDARD, initialMs: 0 });
    const seen = [];
    engine.on(GameEvent.POSITION_LOADED, (p) => seen.push(p.counts.total));
    expect(engine.loadPosition({ board: MIDGAME }, 1000).error).toBeNull();
    expect(seen).toEqual([12]);
    expect(engine.status).toBe(GameStatus.SELECTING);

    // Nothing to undo: the setup stones are not moves.
    expect(engine.undo(1, 1500).error).toMatch(/No moves/);

    expect(engine.selectColor(WHITE, 2000).error).toBeNull();
    const afterSelect = engine.getState();
    expect(afterSelect.status).toBe(GameStatus.PLAYING);
    expect(afterSelect.board).toEqual(MIDGAME);
    expect(afterSelect.currentPlayer).toBe(BLACK);
    expect(engine.isAiTurn()).toBe(true);

    expect(engine.makeMove(0, 0, 3000).error).toBeNull();
    expect(engine.makeMove(7, 7, 3500).error).toMatch(/occupied/);
    expect(engine.makeMove(0, 1, 4000).error).toBeNull();
    expect(engine.getState().moves).toHaveLength(2);

    expect(engine.undo(5, 5000).error).toBeNull();
    const undone = engine.getState();
    expect(undone.moves).toHaveLength(0);
    expect(undone.board).toEqual(MIDGAME);
    expect(undone.currentPlayer).toBe(BLACK);
    expect(undone.setupBoard).toEqual(MIDGAME);

    engine.reset();
    expect(engine.getState().setupBoard).toBeNull();
    expect(countStones(engine.getState().board).total).toBe(0);
  });

  it('keeps the loaded position in play across an in-game Renju setup', () => {
    const board = boardWith([[7, 7, BLACK], [7, 8, WHITE]]);
    const { state, error } = transition(createInitialState({ mode: RuleMode.STANDARD }), { type: ActionType.LOAD_POSITION, board, config: { mode: RuleMode.RENJU } });
    expect(error).toBeNull();
    expect(state.rules.mode).toBe(RuleMode.RENJU);
    expect(state.board[7][7]).toBe(BLACK);
  });
});

describe('Record: save and parse', () => {
  it('round-trips a restored game through toRecord / parseRecord / LOAD_POSITION', () => {
    const engine = new GameEngine();
    engine.loadPosition({ board: MIDGAME }, 1000);
    engine.selectColor(BLACK, 2000);
    engine.makeMove(0, 0, 3000);
    engine.makeMove(14, 14, 4000);
    const record = toRecord(engine.getState(), { now: Date.UTC(2026, 8, 6) });
    expect(record).toMatchObject({ app: RECORD_APP, version: 1, mode: 'STANDARD', boardSize: 15, moves: ['A15', 'O1'], humanColor: BLACK, currentPlayer: BLACK, savedAt: '2026-09-06T00:00:00.000Z' });
    expect(record.setup).toHaveLength(15);
    expect(record.setup[7]).toBe('.......XO......');

    const parsed = parseRecord(JSON.stringify(record));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.board).toEqual(MIDGAME);
    expect(parsed.record.moves).toEqual(['A15', 'O1']);
    expect(parsed.record.humanColor).toBe(BLACK);
    expect(parsed.record.source).toBe('record');

    const restored = transition(createInitialState(), { type: ActionType.LOAD_POSITION, board: parsed.record.board, moves: parsed.record.moves });
    expect(restored.error).toBeNull();
    expect(restored.state.board).toEqual(engine.getState().board);
    expect(restored.state.currentPlayer).toBe(BLACK);
  });

  it('records a normal game with a null setup', () => {
    const engine = new GameEngine();
    engine.selectColor(BLACK, 1000);
    engine.makeMove(7, 7, 2000);
    const record = toRecord(engine.getState());
    expect(record.setup).toBeNull();
    expect(record.moves).toEqual(['H8']);
  });

  it('accepts plain text boards and rejects foreign or broken input', () => {
    const text = parseRecord(boardToText(MIDGAME));
    expect(text.ok).toBe(true);
    if (text.ok) {
      expect(text.record.board).toEqual(MIDGAME);
      expect(text.record.source).toBe('text');
    }
    expect(parseRecord('')).toMatchObject({ ok: false });
    expect(parseRecord('{ not json')).toMatchObject({ ok: false, error: 'Malformed JSON' });
    expect(parseRecord({ app: 'other' })).toMatchObject({ ok: false, error: 'Not a Zenith record' });
    expect(parseRecord({ app: RECORD_APP, moves: ['H8', 'Q99'] })).toMatchObject({ ok: false });
    expect(parseRecord({ app: RECORD_APP, setup: ['bad'] })).toMatchObject({ ok: false });
    expect(parseRecord({ app: RECORD_APP, boardSize: 19 })).toMatchObject({ ok: false });
    expect(parseRecord(JSON.stringify({ app: RECORD_APP, moves: ['H8'] }))).toMatchObject({ ok: true, record: { board: null, moves: ['H8'] } });
  });
});

import { describe, it, expect } from 'vitest';
import { GameEngine } from '../src/core/state/GameEngine.js';
import { SessionStore, SESSION_KEY } from '../src/services/SessionStore.js';
import { createEmptyBoard } from '../src/core/rules/Gomoku.js';

function fixture(initialMs = 300_000) {
  const data = new Map();
  const storage = { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
  const store = new SessionStore(storage);
  const engine = new GameEngine({ initialMs });
  engine.selectColor(1, 0);
  engine.makeMove(7, 7, 1_000);
  engine.makeMove(7, 8, 3_000);
  store.save(engine.getState(), { 1:1000, 2:2000 }, 3_000);
  return { store, engine, data };
}

describe('saved sessions', () => {
  it('restores immutable moves, colours, rules and exact clocks without charging offline time', () => {
    const { store, engine } = fixture();
    const saved = store.load();
    const restored = new GameEngine();
    expect(restored.restoreSession(saved.game, 9_000_000).error).toBeNull();
    const state = restored.getState();
    expect(state.status).toBe('PAUSED');
    expect(state.board).toEqual(engine.getState().board);
    expect(state.humanColor).toBe(1);
    expect(state.clock).toMatchObject({ black:299_000, white:298_000, running:false });
    expect(Object.isFrozen(state.board[7])).toBe(true);
    restored.tick(10_000_000);
    expect(restored.getState()).toBe(state);
    restored.togglePause(10_000_000);
    restored.tick(10_000_100);
    expect(restored.getState().clock.black).toBe(298_900);
    expect(restored.undo(2, 10_000_100).error).toBeNull();
    expect(restored.moves).toHaveLength(0);
  });

  it('preserves an explicitly chosen setup turn and the immutable setup stones', () => {
    const { engine, store } = fixture(0);
    const board = createEmptyBoard();
    board[0][0] = 1;
    engine.loadPosition({ board, currentPlayer:1, config:{mode:'RENJU',initialMs:0} }, 0);
    engine.selectColor(2, 0);
    engine.makeMove(7,7,100);
    store.save(engine.getState(), {1:500,2:300});
    const saved = store.load();
    const restored = new GameEngine();
    expect(restored.restoreSession(saved.game,1000).error).toBeNull();
    expect(restored.currentPlayer).toBe(2);
    expect(restored.getState().rules.mode).toBe('RENJU');
    expect(restored.getState().humanColor).toBe(2);
    expect(saved.elapsedMs).toEqual({1:500,2:300});
    restored.undo(1,1001);
    expect(restored.getState().board[0][0]).toBe(1);
    expect(restored.getState().board[7][7]).toBe(0);
  });

  it.each([
    game => { game.version = 9; },
    game => { game.moves = ['H8','H8']; },
    game => { game.currentPlayer = 2; },
    game => { game.humanColor = 7; },
    game => { game.clock.black = -1; },
    game => { game.clock.white = 0; },
    game => { game.clock.initialMs = '300000'; },
    game => { game.setupBoard = [[1]]; },
  ])('rejects a corrupt saved game without changing live state', mutate => {
    const { store, engine, data } = fixture();
    const saved = store.load();
    mutate(saved.game);
    const before = engine.getState();
    expect(engine.restoreSession(saved.game).error).toBeTruthy();
    expect(engine.getState()).toBe(before);
    data.set(SESSION_KEY,JSON.stringify(saved));
    expect(store.load()).toBeNull();
  });

  it('removes completed or deliberately reset games', () => {
    const { store, engine } = fixture();
    engine.resign(1, 4000);
    store.save(engine.getState(),{});
    expect(store.load()).toBeNull();
    engine.reset();
    store.save(engine.getState(),{});
    expect(store.load()).toBeNull();
  });

  it('tolerates malformed JSON and denied storage', () => {
    const { store, engine, data } = fixture();
    data.set(SESSION_KEY,'{oops');
    expect(store.load()).toBeNull();
    const denied = new SessionStore({ getItem() { throw Error('denied'); }, setItem() { throw Error('full'); } });
    expect(denied.load()).toBeNull();
    expect(denied.save(engine.getState(),{})).toBe(false);
  });
});

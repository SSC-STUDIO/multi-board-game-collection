import { ActionType, GameStatus, createInitialState, transition } from '../core/state/GameState.js';

export const SESSION_KEY = 'zenith.session.v1';

/** Local-only, resumable game storage. Browser storage failures must never stop play. */
export class SessionStore {
  constructor(storage) { this.storage = storage; }

  _storage() { return this.storage === undefined ? globalThis.localStorage : this.storage; }

  save(state, elapsedMs, savedAt = Date.now()) {
    try {
      if (![GameStatus.PLAYING, GameStatus.PAUSED].includes(state.status)) {
        this._storage()?.removeItem(SESSION_KEY);
        return false;
      }
      const game = {
        version: 1, mode: state.rules.mode, boardSize: state.boardSize,
        setupBoard: state.setupBoard, moves: state.moves.map(m => m.notation),
        firstPlayer: state.moves[0]?.player ?? state.currentPlayer,
        currentPlayer: state.currentPlayer, humanColor: state.humanColor,
        clock: { initialMs: state.clock.initialMs, black: state.clock.black, white: state.clock.white },
      };
      this._storage()?.setItem(SESSION_KEY, JSON.stringify({ game, elapsedMs, savedAt }));
      return true;
    } catch { return false; }
  }

  load() {
    try {
      const raw = this._storage()?.getItem(SESSION_KEY);
      if (!raw || raw.length > 100_000) return null;
      const saved = JSON.parse(raw);
      const restored = transition(createInitialState(), { type: ActionType.RESTORE_SESSION, session: saved.game, timestamp: 0 });
      if (restored.error) return null;
      const elapsedMs = {};
      for (const side of [1, 2]) {
        const ms = saved.elapsedMs?.[side];
        elapsedMs[side] = Number.isFinite(ms) && ms >= 0 ? ms : 0;
      }
      return { game: saved.game, elapsedMs, savedAt: saved.savedAt };
    } catch { return null; }
  }
}

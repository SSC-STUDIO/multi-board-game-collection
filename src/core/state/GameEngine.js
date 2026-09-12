/**
 * Stateful convenience wrapper around the pure `transition` reducer with a tiny
 * event bus. Listeners receive `(payload, event, state)`.
 * @module core/state/GameEngine
 */
import { ActionType, GameStatus, createInitialState, transition } from './GameState.js';

/** @typedef {import('./GameState.js').GameState} GameState */
/** @typedef {import('./GameState.js').TransitionResult} TransitionResult */
/** @typedef {(payload: Object, event: { type: string, payload: Object }, state: GameState) => void} EventHandler */

export class GameEngine {
  /** @type {GameState} */
  #state;
  /** @type {Map<string, Set<EventHandler>>} */
  #listeners = new Map();

  /** @param {import('./GameState.js').GameConfig} [config] */
  constructor(config = {}) {
    this.#state = createInitialState(config);
  }

  /** @returns {GameState} */
  getState() {
    return this.#state;
  }

  /**
   * Applies an action, stores the resulting state and emits every event to its
   * type listeners and to '*' listeners.
   * @returns {TransitionResult}
   */
  dispatch(action) {
    const result = transition(this.#state, action);
    this.#state = result.state;
    for (const event of result.events) this.#emit(event, result.state);
    return result;
  }

  /**
   * @param {string} eventType A GameEvent value or '*'.
   * @param {EventHandler} handler
   * @returns {() => void} Unsubscribe function.
   */
  on(eventType, handler) {
    let handlers = this.#listeners.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.#listeners.set(eventType, handlers);
    }
    handlers.add(handler);
    return () => this.off(eventType, handler);
  }

  off(eventType, handler) {
    const handlers = this.#listeners.get(eventType);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.#listeners.delete(eventType);
  }

  #emit(event, state) {
    const targeted = this.#listeners.get(event.type);
    const wildcard = this.#listeners.get('*');
    if (targeted) for (const handler of [...targeted]) handler(event.payload, event, state);
    if (wildcard) for (const handler of [...wildcard]) handler(event.payload, event, state);
  }

  selectColor(color, timestamp) {
    return this.dispatch({ type: ActionType.SELECT_COLOR, color, timestamp });
  }

  makeMove(row, col, timestamp) {
    return this.dispatch({ type: ActionType.MAKE_MOVE, row, col, timestamp });
  }

  undo(count = 1, timestamp) {
    return this.dispatch({ type: ActionType.UNDO_MOVE, count, timestamp });
  }

  togglePause(timestamp) {
    return this.dispatch({ type: ActionType.TOGGLE_PAUSE, timestamp });
  }

  tick(timestamp) {
    return this.dispatch({ type: ActionType.TICK, timestamp });
  }

  resign(player, timestamp) {
    return this.dispatch({ type: ActionType.RESIGN, player, timestamp });
  }

  reset(config) {
    return this.dispatch({ type: ActionType.RESET, config });
  }

  /**
   * Restore a position (setup grid and/or recorded moves) and return to colour selection.
   * @param {{ board?: number[][], moves?: (string|{row:number,col:number})[], currentPlayer?: number, config?: object }} position
   */
  loadPosition(position, timestamp) {
    return this.dispatch({ type: ActionType.LOAD_POSITION, ...position, timestamp });
  }

  get status() {
    return this.#state.status;
  }

  get currentPlayer() {
    return this.#state.currentPlayer;
  }

  get moves() {
    return this.#state.moves;
  }

  isHumanTurn() {
    return this.#state.status === GameStatus.PLAYING && this.#state.currentPlayer === this.#state.humanColor;
  }

  isAiTurn() {
    return this.#state.status === GameStatus.PLAYING && this.#state.currentPlayer === this.#state.aiColor;
  }
}

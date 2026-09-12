/**
 * Public surface of the DOM-free business core: rules, immutable state machine and AI.
 * @module core
 */
export * from './rules/Gomoku.js';
export * from './rules/Renju.js';
export * from './rules/Setup.js';
export * from './state/GameState.js';
export * from './state/GameEngine.js';
export * from './state/Record.js';
export * from './ai/Evaluate.js';
export * from './ai/Search.js';

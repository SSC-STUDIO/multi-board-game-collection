import { describe, it, expect } from 'vitest';
import {
  BLACK, WHITE, createEmptyBoard, isForbidden, RuleMode,
  SCORE, evaluateLine, evaluateBoard, evaluatePoint, getCandidateMoves, momentum,
  findImmediateWin, findMustBlock, findBestMove, scoreMove,
} from '../src/core/index.js';

function boardWith(stones) {
  const board = createEmptyBoard();
  for (const [row, col, player] of stones) board[row][col] = player;
  return board;
}

/** 'X' = black, 'O' = white, '_' = empty. */
function line(text) {
  return text.split('').map((ch) => (ch === 'X' ? BLACK : ch === 'O' ? WHITE : 0));
}

function stateFor(board, currentPlayer, mode = RuleMode.STANDARD) {
  return { board, currentPlayer, rules: { mode } };
}

// A 16-stone middlegame used for candidate generation.
const MIDGAME = boardWith([
  [7, 7, BLACK], [7, 8, WHITE], [8, 8, BLACK], [6, 6, WHITE], [8, 6, BLACK], [6, 8, WHITE],
  [9, 5, BLACK], [8, 7, WHITE], [6, 7, BLACK], [5, 7, WHITE], [9, 9, BLACK], [10, 10, WHITE],
  [8, 9, BLACK], [7, 9, WHITE], [9, 7, BLACK], [10, 7, WHITE],
]);

// An 18-stone middlegame, black to move, with no three or four on the board for either side.
const QUIET = boardWith([
  [8, 6, BLACK], [5, 9, WHITE], [7, 8, BLACK], [8, 5, WHITE], [4, 4, BLACK], [6, 10, WHITE],
  [4, 10, BLACK], [7, 6, WHITE], [4, 7, BLACK], [4, 6, WHITE], [8, 10, BLACK], [9, 5, WHITE],
  [8, 4, BLACK], [7, 9, WHITE], [7, 5, BLACK], [5, 5, WHITE], [6, 8, BLACK], [10, 6, WHITE],
]);

describe('evaluateLine', () => {
  it('orders the patterns FIVE > OPEN_FOUR > FOUR > OPEN_THREE > THREE > TWO', () => {
    const five = evaluateLine(line('_XXXXX_'), BLACK);
    const openFour = evaluateLine(line('_XXXX_'), BLACK);
    const four = evaluateLine(line('OXXXX_'), BLACK);
    const brokenFour = evaluateLine(line('XXX_X'), BLACK);
    const openThree = evaluateLine(line('__XXX__'), BLACK);
    const brokenThree = evaluateLine(line('_XX_X_'), BLACK);
    const three = evaluateLine(line('OXXX__'), BLACK);
    const two = evaluateLine(line('OXX___'), BLACK);
    expect(five).toBe(SCORE.FIVE);
    expect(openFour).toBe(SCORE.OPEN_FOUR);
    expect(four).toBe(SCORE.FOUR);
    expect(brokenFour).toBe(SCORE.FOUR);
    expect(openThree).toBe(SCORE.OPEN_THREE);
    expect(brokenThree).toBe(SCORE.OPEN_THREE);
    expect(three).toBe(SCORE.THREE);
    expect(two).toBe(SCORE.TWO);
    expect(five).toBeGreaterThan(openFour);
    expect(openFour).toBeGreaterThan(four);
    expect(four).toBeGreaterThan(openThree);
    expect(openThree).toBeGreaterThan(three);
    expect(three).toBeGreaterThan(two);
    expect(evaluateLine(line('OXXXXO'), BLACK)).toBe(0);
    expect(evaluateLine(line('_______'), BLACK)).toBe(0);
    expect(evaluateLine(line('_OOOO_'), WHITE)).toBe(SCORE.OPEN_FOUR);
    expect(evaluateLine(line('_OOOO_'), BLACK)).toBe(0);
  });

  it('applies exact-five semantics for black in RENJU', () => {
    expect(evaluateLine(line('XXXXXX'), BLACK, RuleMode.RENJU)).toBe(0);
    expect(evaluateLine(line('XXXXXX'), BLACK, RuleMode.STANDARD)).toBe(SCORE.FIVE);
    // Exact rules: the gap would make an overline, so only the right end completes; the lone stone is a ONE.
    expect(evaluateLine(line('X_XXXX_'), BLACK, RuleMode.RENJU)).toBe(SCORE.FOUR + SCORE.ONE);
    // Loose rules: both the gap (six) and the right end (five) win, so the shape is unstoppable.
    expect(evaluateLine(line('X_XXXX_'), BLACK, RuleMode.STANDARD)).toBe(SCORE.OPEN_FOUR);
    expect(evaluateLine(line('XXX_XX'), BLACK, RuleMode.STANDARD)).toBe(SCORE.FOUR);
    expect(evaluateLine(line('XXX_XX'), BLACK, RuleMode.RENJU)).toBeLessThan(SCORE.FOUR);
    expect(evaluateLine(line('XXXXX_X'), BLACK, RuleMode.STANDARD)).toBe(SCORE.FIVE + SCORE.ONE);
    expect(evaluateLine(line('X_XXXXX'), BLACK, RuleMode.RENJU)).toBe(SCORE.FIVE + SCORE.ONE);
  });
});

describe('evaluateBoard / evaluatePoint / getCandidateMoves', () => {
  it('favours the side with more material', () => {
    const board = boardWith([[7, 5, BLACK], [7, 6, BLACK], [7, 7, BLACK], [0, 0, WHITE]]);
    expect(evaluateBoard(board, BLACK)).toBeGreaterThan(0);
    expect(evaluateBoard(board, WHITE)).toBeLessThan(0);
    expect(evaluateBoard(createEmptyBoard(), BLACK)).toBe(0);
  });

  it('rates completing a four above extending a two', () => {
    const board = boardWith([[7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [7, 7, BLACK], [2, 2, BLACK], [2, 3, BLACK]]);
    expect(evaluatePoint(board, 7, 8, BLACK)).toBeGreaterThan(evaluatePoint(board, 2, 4, BLACK));
    expect(evaluatePoint(board, 7, 7, BLACK)).toBe(-Infinity);
    expect(evaluatePoint(board, 99, 0, BLACK)).toBe(-Infinity);
    expect(scoreMove(board, 7, 8, BLACK)).toBe(evaluatePoint(board, 7, 8, BLACK));
  });

  it('returns -Infinity for forbidden points in RENJU', () => {
    const board = boardWith([[7, 6, BLACK], [7, 8, BLACK], [8, 7, BLACK], [9, 7, BLACK]]);
    expect(evaluatePoint(board, 7, 7, BLACK, RuleMode.RENJU)).toBe(-Infinity);
    expect(evaluatePoint(board, 7, 7, BLACK, RuleMode.STANDARD)).toBeGreaterThan(0);
    expect(evaluatePoint(board, 7, 7, WHITE, RuleMode.RENJU)).toBeGreaterThan(0);
  });

  it('produces sorted, empty-only candidates within the limit', () => {
    const candidates = getCandidateMoves(MIDGAME, BLACK, RuleMode.STANDARD, { limit: 10 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(10);
    expect(candidates.every(({ row, col }) => MIDGAME[row][col] === 0)).toBe(true);
    for (let i = 1; i < candidates.length; i++) expect(candidates[i - 1].score).toBeGreaterThanOrEqual(candidates[i].score);
    expect(getCandidateMoves(createEmptyBoard(), BLACK)).toEqual([expect.objectContaining({ row: 7, col: 7 })]);
    const nearOnly = getCandidateMoves(boardWith([[7, 7, BLACK]]), WHITE, RuleMode.STANDARD, { radius: 1, limit: 100 });
    expect(nearOnly).toHaveLength(8);
  });

  it('drops forbidden points for black in RENJU', () => {
    const board = boardWith([[7, 6, BLACK], [7, 8, BLACK], [8, 7, BLACK], [9, 7, BLACK], [0, 0, WHITE], [0, 1, WHITE]]);
    const standard = getCandidateMoves(board, BLACK, RuleMode.STANDARD, { limit: 5 });
    expect(standard[0]).toMatchObject({ row: 7, col: 7 });
    const renju = getCandidateMoves(board, BLACK, RuleMode.RENJU, { limit: 30 });
    expect(renju.some(({ row, col }) => row === 7 && col === 7)).toBe(false);
    expect(renju.every(({ row, col }) => !isForbidden(board, row, col).forbidden)).toBe(true);
  });
});

describe('momentum', () => {
  it('is balanced on an empty board and leans towards the side with an open three', () => {
    expect(momentum(createEmptyBoard())).toBe(0.5);
    const blackThree = momentum(boardWith([[7, 6, BLACK], [7, 7, BLACK], [7, 8, BLACK]]));
    expect(blackThree).toBeGreaterThan(0.5);
    expect(blackThree).toBeGreaterThan(0.6);
    expect(blackThree).toBeLessThan(0.7);
    const whiteThree = momentum(boardWith([[7, 6, WHITE], [7, 7, WHITE], [7, 8, WHITE]]));
    expect(whiteThree).toBeLessThan(0.5);
    expect(momentum(boardWith([[7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [7, 7, BLACK]]))).toBeGreaterThan(0.99);
  });
});

describe('findImmediateWin / findMustBlock', () => {
  it('finds the point that completes five', () => {
    const board = boardWith([[7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [0, 0, WHITE]]);
    expect(findImmediateWin(board, BLACK)).toEqual({ row: 7, col: 2 });
    expect(findImmediateWin(board, WHITE)).toBeNull();
    const broken = boardWith([[4, 4, WHITE], [5, 5, WHITE], [7, 7, WHITE], [8, 8, WHITE]]);
    expect(findImmediateWin(broken, WHITE)).toEqual({ row: 6, col: 6 });
  });

  it('refuses an overline as a win for black in RENJU', () => {
    const board = boardWith([[7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [7, 8, BLACK]]);
    expect(findImmediateWin(board, BLACK, RuleMode.RENJU)).toEqual({ row: 7, col: 2 });
    const onlyOverline = boardWith([[7, 2, WHITE], [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [7, 8, BLACK]]);
    expect(findImmediateWin(onlyOverline, BLACK, RuleMode.RENJU)).toBeNull();
    expect(findImmediateWin(onlyOverline, BLACK, RuleMode.STANDARD)).toEqual({ row: 7, col: 7 });
  });

  it('blocks the opponent four', () => {
    const closedFour = boardWith([[7, 2, WHITE], [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]]);
    expect(findMustBlock(closedFour, WHITE)).toEqual({ row: 7, col: 7 });
    const openFour = boardWith([[7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK]]);
    const block = findMustBlock(openFour, WHITE);
    expect([[7, 2], [7, 7]]).toContainEqual([block.row, block.col]);
    expect(findMustBlock(boardWith([[7, 7, BLACK]]), WHITE)).toBeNull();
  });
});

describe('findBestMove', () => {
  it('opens at the centre and then next to the lone stone', () => {
    const first = findBestMove(stateFor(createEmptyBoard(), BLACK));
    expect(first).toMatchObject({ row: 7, col: 7, reason: 'OPENING' });
    const second = findBestMove(stateFor(boardWith([[7, 7, BLACK]]), WHITE));
    expect(second.reason).toBe('OPENING');
    expect(Math.abs(second.row - 7)).toBe(1);
    expect(Math.abs(second.col - 7)).toBe(1);
    const corner = findBestMove(stateFor(boardWith([[0, 14, BLACK]]), WHITE));
    expect(corner).toMatchObject({ row: 1, col: 13 });
  });

  it('takes an immediate win', () => {
    const board = boardWith([[7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [5, 5, WHITE], [5, 6, WHITE], [5, 7, WHITE], [5, 8, WHITE]]);
    const result = findBestMove(stateFor(board, BLACK));
    expect(result.reason).toBe('WIN');
    expect([[7, 2], [7, 7]]).toContainEqual([result.row, result.col]);
  });

  it('blocks an opponent four when it cannot win', () => {
    const board = boardWith([[7, 2, WHITE], [7, 3, BLACK], [7, 4, BLACK], [7, 5, BLACK], [7, 6, BLACK], [0, 0, WHITE]]);
    expect(findBestMove(stateFor(board, WHITE))).toMatchObject({ row: 7, col: 7, reason: 'BLOCK' });
  });

  it('extends an open three into a straight four', () => {
    const board = boardWith([[7, 6, BLACK], [7, 7, BLACK], [7, 8, BLACK], [0, 0, WHITE], [0, 2, WHITE]]);
    const result = findBestMove(stateFor(board, BLACK));
    expect(result.reason).toBe('ATTACK');
    expect([[7, 5], [7, 9]]).toContainEqual([result.row, result.col]);
  });

  it('defends against an open three', () => {
    const board = boardWith([[7, 6, BLACK], [7, 7, BLACK], [7, 8, BLACK], [0, 0, WHITE], [0, 2, WHITE]]);
    const result = findBestMove(stateFor(board, WHITE), { depth: 4, timeLimitMs: 2000 });
    expect(result.row).toBe(7);
    expect([5, 9]).toContain(result.col);
    expect(result.reason).toBe('DEFEND');
    expect(result.depth).toBeGreaterThanOrEqual(2);
  });

  it('never plays a forbidden point as black in RENJU', () => {
    const board = boardWith([[7, 6, BLACK], [7, 8, BLACK], [8, 7, BLACK], [9, 7, BLACK], [0, 0, WHITE], [0, 2, WHITE], [0, 4, WHITE]]);
    const standard = findBestMove(stateFor(board, BLACK, RuleMode.STANDARD), { depth: 2 });
    expect(standard).toMatchObject({ row: 7, col: 7 });
    for (let i = 0; i < 3; i++) {
      const renju = findBestMove(stateFor(board, BLACK, RuleMode.RENJU), { depth: 4, randomize: i > 0 });
      expect(isForbidden(board, renju.row, renju.col).forbidden).toBe(false);
      expect(board[renju.row][renju.col]).toBe(0);
    }
  });

  it('searches a middlegame position to depth 4 well within the time budget', () => {
    for (const mode of [RuleMode.STANDARD, RuleMode.RENJU]) {
      const started = Date.now();
      const result = findBestMove(stateFor(QUIET, BLACK, mode), { depth: 4, timeLimitMs: 1200 });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(1500);
      expect(result.elapsedMs).toBeLessThan(1500);
      expect(result.depth).toBe(4);
      expect(result.nodes).toBeGreaterThan(0);
      expect(QUIET[result.row][result.col]).toBe(0);
      expect(['SEARCH', 'DEFEND']).toContain(result.reason);
    }
  });

  it('finds a forced win through a double three and stops deepening', () => {
    // White at (3,7) creates two threes along both diagonals; black cannot stop both.
    const result = findBestMove(stateFor(QUIET, WHITE), { depth: 6, timeLimitMs: 5000 });
    expect(result).toMatchObject({ row: 3, col: 7 });
    expect(result.score).toBeGreaterThan(SCORE.FIVE);
    expect(result.depth).toBeLessThanOrEqual(6);
  });

  it('honours the time limit by keeping the last completed depth', () => {
    const result = findBestMove(stateFor(QUIET, BLACK), { depth: 12, timeLimitMs: 150 });
    expect(result.elapsedMs).toBeLessThan(600);
    expect(result.depth).toBeGreaterThanOrEqual(2);
    expect(QUIET[result.row][result.col]).toBe(0);
  });
});

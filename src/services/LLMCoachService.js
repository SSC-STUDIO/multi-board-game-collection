/**
 * Gomoku "qi-dao" coach behind the strategy manual (DEVELOPMENT_PLAN §2.3,
 * DIEGETIC_UI_SPEC §3.2).
 *
 * The recommended move always comes from the injected local analyser (the core
 * AI), so advice is instant and deterministic. The classical commentary is
 * generated locally from phrase tables; when an OpenAI-compatible endpoint is
 * configured the comment is upgraded by the LLM, falling back silently to the
 * local text on any error or timeout.
 *
 * Pure JS: no Three.js, no DOM (fetch/AbortController only inside methods).
 */

export const BOARD_SIZE = 15;
const COLUMN_LETTERS = 'ABCDEFGHIJKLMNO';
const CENTRE = Math.floor(BOARD_SIZE / 2);
const MAX_LLM_COMMENT_CHARS = 30;

/**
 * @typedef {'OPENING' | 'WIN' | 'BLOCK' | 'ATTACK' | 'DEFEND' | 'SEARCH'} Reason
 *
 * @typedef {object} Analysis
 * @property {number} row
 * @property {number} col
 * @property {number} [score]
 * @property {Reason} reason
 * @property {number} momentum   0..1, 1 = black fully dominant
 *
 * @typedef {object} GameStateLike
 * @property {number[][]} board             0 empty, 1 black, 2 white
 * @property {1 | 2} currentPlayer
 * @property {Array<{ row: number, col: number, player: number, notation?: string }>} [moves]
 * @property {{ mode?: string }} [rules]
 * @property {number} [humanColor]
 *
 * @typedef {object} Advice
 * @property {{ row: number, col: number } | null} move
 * @property {string} notation
 * @property {string} title
 * @property {string} comment
 * @property {number} momentum
 * @property {'local' | 'llm'} source
 */

/** Title verb per reason; the centre point gets its own honorific. */
const TITLE_VERBS = Object.freeze({
  WIN: '一着定乾坤',
  BLOCK: '急堵要害',
  ATTACK: '乘势进击',
  DEFEND: '固守要津',
  OPENING: '开局布势',
  SEARCH: '宜着',
});
const CENTRE_TITLE = '宜着天元';

/** First clause: what the move does. */
const TACTIC_CLAUSES = Object.freeze({
  OPENING: ['先据中腹', '布子疏朗', '开局布势', '据中而立', '先手占要'],
  WIN: ['一着连珠', '此处成五', '五星连珠', '收官定局'],
  BLOCK: ['断其活三', '急堵冲四', '截其要路', '封其锋芒', '断其二路连珠'],
  ATTACK: ['乘势成四', '连三迫敌', '双三攻杀', '进逼中路', '顺势进击'],
  DEFEND: ['固守要津', '先安己阵', '回补薄弱', '稳守待机', '厚势自固'],
  SEARCH: ['此着可取', '权衡诸路', '择善而着', '静观其变'],
});

/** Second clause: outlook, coloured by the mover's stance and the game phase. */
const OUTLOOK_CLAUSES = Object.freeze({
  advantage: Object.freeze({
    opening: ['大势初成', '先手在握', '气象已开'],
    middle: ['彼退我进', '胜势渐明', '大势已成'],
    late: ['收官在望', '胜局已定', '乘胜可收'],
  }),
  balanced: Object.freeze({
    opening: ['静观其变', '各据一方', '未分伯仲'],
    middle: ['两军相持', '胜负未分', '寸土必争'],
    late: ['终局将至', '一着定势', '慎防疏漏'],
  }),
  behind: Object.freeze({
    opening: ['宜缓宜稳', '莫急争先', '徐图后计'],
    middle: ['退守待机', '化解锋芒', '伺机反击'],
    late: ['困中求变', '力挽危局', '败中求生'],
  }),
});

const NO_MOVE_ADVICE = Object.freeze({
  move: null,
  notation: '',
  title: '局终·无着可推',
  comment: '棋局已定，静待终章。',
});

const SYSTEM_PROMPT =
  '你是一位精通古谱的五子棋棋道导师。用文言短句点评当前局面与推荐着法，' +
  '不超过30字、两句。只输出严格的 JSON，格式为 {"comment": "..."}，不要输出其他内容。';

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** @param {Reason | string | undefined} reason */
function normaliseReason(reason) {
  return reason && Object.hasOwn(TITLE_VERBS, reason) ? /** @type {Reason} */ (reason) : 'SEARCH';
}

/** @param {number} moveCount */
function phaseOf(moveCount) {
  if (moveCount < 6) return 'opening';
  if (moveCount < 30) return 'middle';
  return 'late';
}

/**
 * Stance of the side to move: `momentum` is black's advantage, so flip for white.
 * @param {number} momentum
 * @param {number} currentPlayer
 */
function stanceOf(momentum, currentPlayer) {
  const own = currentPlayer === 2 ? 1 - momentum : momentum;
  if (own > 0.6) return 'advantage';
  if (own < 0.4) return 'behind';
  return 'balanced';
}

/**
 * Pull `{"comment": ...}` out of an LLM reply, tolerating code fences and
 * surrounding prose. Short plain-text replies are accepted as-is.
 * @param {string} text
 * @returns {string | null}
 */
function extractComment(text) {
  if (typeof text !== 'string') return null;
  const stripped = text.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let comment = null;

  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(stripped.slice(start, end + 1));
      if (parsed && typeof parsed.comment === 'string') comment = parsed.comment;
    } catch {
      comment = null;
    }
  } else if (stripped.length > 0 && stripped.length <= MAX_LLM_COMMENT_CHARS * 2) {
    comment = stripped;
  }

  if (!comment) return null;
  comment = comment.replace(/\s+/g, ' ').trim();
  if (comment.length === 0) return null;
  return comment.length > MAX_LLM_COMMENT_CHARS ? `${comment.slice(0, MAX_LLM_COMMENT_CHARS - 1)}…` : comment;
}

export class LLMCoachService {
  /**
   * @param {object} options
   * @param {(state: GameStateLike) => Analysis | null | Promise<Analysis | null>} options.analyze  local analyser wrapping the core AI
   * @param {string | null} [options.endpoint]   OpenAI-compatible chat completions URL
   * @param {string | null} [options.apiKey]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   */
  constructor({ analyze, endpoint = null, apiKey = null, model = 'gpt-4o-mini', timeoutMs = 8000 } = /** @type {any} */ ({})) {
    if (typeof analyze !== 'function') {
      throw new TypeError('LLMCoachService requires an `analyze(state)` function');
    }
    this.analyze = analyze;
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Algebraic notation: columns A..O left→right, ranks 15..1 far→near, so the
   * centre (7, 7) is H8.
   * @param {number} row
   * @param {number} col
   */
  static toNotation(row, col) {
    return `${COLUMN_LETTERS[col]}${BOARD_SIZE - row}`;
  }

  /**
   * Inverse of `toNotation`; null for malformed input.
   * @param {string} notation
   * @returns {{ row: number, col: number } | null}
   */
  static fromNotation(notation) {
    const m = /^([A-Oa-o])(\d{1,2})$/.exec(String(notation).trim());
    if (!m) return null;
    const col = COLUMN_LETTERS.indexOf(m[1].toUpperCase());
    const row = BOARD_SIZE - Number(m[2]);
    if (row < 0 || row >= BOARD_SIZE) return null;
    return { row, col };
  }

  /**
   * Recommended move plus classical commentary for the side to move.
   * @param {GameStateLike} state
   * @returns {Promise<Advice>}
   */
  async getAdvice(state) {
    // `analyze` may be synchronous or return a promise (e.g. a Web Worker search).
    const analysis = await this.analyze(state);
    const local = this.localAdvice(state, analysis);
    if (!this.endpoint || !local.move) return local;

    try {
      const comment = await this._requestComment(state, local, /** @type {Analysis} */ (analysis));
      if (comment) return { ...local, comment, source: 'llm' };
    } catch {
      /* network / timeout / parse failure → local commentary */
    }
    return local;
  }

  /**
   * Deterministic offline advice; the same position always yields the same text.
   * @param {GameStateLike} state
   * @param {Analysis | null} analysis
   * @returns {Advice}
   */
  localAdvice(state, analysis) {
    const momentum = clamp01(Number.isFinite(analysis?.momentum) ? /** @type {number} */ (analysis.momentum) : 0.5);
    if (!analysis || !Number.isInteger(analysis.row) || !Number.isInteger(analysis.col)) {
      return { ...NO_MOVE_ADVICE, momentum, source: 'local' };
    }

    const { row, col } = analysis;
    const reason = normaliseReason(analysis.reason);
    const moveCount = Array.isArray(state.moves) ? state.moves.length : 0;
    const notation = LLMCoachService.toNotation(row, col);
    const verb = row === CENTRE && col === CENTRE ? CENTRE_TITLE : TITLE_VERBS[reason];

    const seed = moveCount + row * BOARD_SIZE + col;
    const tactics = TACTIC_CLAUSES[reason];
    const outlooks = OUTLOOK_CLAUSES[stanceOf(momentum, state.currentPlayer)][phaseOf(moveCount)];
    const comment = `${tactics[seed % tactics.length]}，${outlooks[seed % outlooks.length]}。`;

    return {
      move: { row, col },
      notation,
      title: `${verb}·${notation}`,
      comment,
      momentum,
      source: 'local',
    };
  }

  /**
   * Board as text for prompts/logs: ranks 15..1, files A..O, X = black, O = white.
   * @param {number[][]} board
   */
  boardToAscii(board) {
    const lines = [];
    for (let row = 0; row < BOARD_SIZE; row++) {
      const cells = [];
      for (let col = 0; col < BOARD_SIZE; col++) {
        const v = board[row]?.[col] ?? 0;
        cells.push(v === 1 ? 'X' : v === 2 ? 'O' : '.');
      }
      lines.push(`${String(BOARD_SIZE - row).padStart(2, ' ')} ${cells.join(' ')}`);
    }
    lines.push(`   ${COLUMN_LETTERS.split('').join(' ')}`);
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * @param {GameStateLike} state
   * @param {Advice} local
   * @param {Analysis} analysis
   * @returns {Promise<string | null>}
   */
  async _requestComment(state, local, analysis) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const player = state.currentPlayer === 1 ? '黑(X)' : '白(O)';
    const moveCount = Array.isArray(state.moves) ? state.moves.length : 0;
    const userPrompt = [
      '当前棋盘（行号15在远端，列A在左）：',
      this.boardToAscii(state.board),
      `当前执子：${player}，已行 ${moveCount} 手。`,
      `推荐着法：${local.notation}（理由：${normaliseReason(analysis.reason)}）。`,
      `黑方气势：${Math.round(local.momentum * 100)}%。`,
      '请以文言短评两句点评此着，输出 JSON。',
    ].join('\n');

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    try {
      const response = await fetch(/** @type {string} */ (this.endpoint), {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0.7,
          max_tokens: 120,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      return extractComment(typeof text === 'string' ? text : '');
    } finally {
      clearTimeout(timer);
    }
  }
}

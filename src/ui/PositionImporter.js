/**
 * "复原棋局" panel, mounted inside the start screen card.
 *
 * Pick a picture (file, drag-drop or Ctrl+V), a saved record (.json) or a text
 * board (.txt); the local recogniser draws the detected 15×15 grid and stones
 * over the image. The four corner handles can be dragged when the grid is off
 * (perspective photos), any intersection can be clicked to cycle
 * empty → black → white, and an optional vision model can be asked instead.
 * The verdict says whose turn it is and whether play can continue; confirming
 * hands the position to the 3D table.
 *
 * DOM + canvas only; all rules live in core/, all pixel work in BoardVision.
 */
import { BLACK, WHITE, EMPTY, BOARD_SIZE, createEmptyBoard } from '../core/rules/Gomoku.js';
import { PositionVerdict, analyzePosition, copyGrid } from '../core/rules/Setup.js';
import { parseRecord } from '../core/state/Record.js';
import { ActionType, createInitialState, transition } from '../core/state/GameState.js';
import { recognizeBoard, sampleBoard, recognizeWithVisionModel, gridToImageMapper } from '../services/BoardVision.js';

const MAX_ANALYSIS_SIDE = 1000;
const MAX_DISPLAY_WIDTH = 560;
const MAX_DISPLAY_HEIGHT = 400;
const HANDLE_HIT_CSS_PX = 18;
const LINES = BOARD_SIZE - 1;
/** Pixel size of the schematic board drawn for records / text positions. */
const SCHEMATIC_SIZE = BOARD_SIZE * 40;
const SCHEMATIC_CORNERS = Object.freeze({
  tl: [30, 30], tr: [SCHEMATIC_SIZE - 30, 30], br: [SCHEMATIC_SIZE - 30, SCHEMATIC_SIZE - 30], bl: [30, SCHEMATIC_SIZE - 30],
});
const SIDE_NAME = { [BLACK]: '黑', [WHITE]: '白' };
const CYCLE = { [EMPTY]: BLACK, [BLACK]: WHITE, [WHITE]: EMPTY };

/**
 * @typedef {object} ImportedPosition
 * @property {number[][]|null} board       setup grid (null = empty board)
 * @property {string[]} moves               replayed on top of the setup
 * @property {number|null} currentPlayer    explicit side to move (only without moves)
 * @property {number|null} humanColor       suggestion from a record
 * @property {'image'|'record'|'text'|'llm'} source
 * @property {import('../core/rules/Setup.js').StoneCounts} counts
 */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

async function fileToBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older engines: fall back to an <img> (no EXIF orientation).
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片无法解码'));
        img.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

export class PositionImporter {
  /**
   * @param {object} options
   * @param {{ endpoint: string, apiKey?: string|null, model?: string } | null} [options.vision]  vision-model config
   * @param {(position: ImportedPosition) => void} options.onConfirm
   * @param {() => void} options.onCancel
   */
  constructor({ vision = null, onConfirm, onCancel }) {
    this.vision = vision?.endpoint ? vision : null;
    this._onConfirm = onConfirm;
    this._onCancel = onCancel;
    this._mode = 'STANDARD';

    /** @type {null | { kind: 'image', canvas: HTMLCanvasElement, imageData: ImageData } | { kind: 'record', record: import('../core/state/Record.js').ParsedRecord }} */
    this._source = null;
    /** @type {import('../services/BoardVision.js').Corners | null} */
    this._corners = null;
    /** @type {number[][] | null} */
    this._board = null;
    /** @type {Float32Array | null} */
    this._cellConfidence = null;
    /** @type {Map<string, number>} manual corrections keyed "row,col" */
    this._overrides = new Map();
    this._gridReliable = true;
    this._boardSource = 'image';
    /** @type {number | null} */
    this._turnOverride = null;
    /** @type {null | { corner: keyof import('../services/BoardVision.js').Corners, pointerId: number }} */
    this._drag = null;
    this._fit = 1;
    this._busy = false;
    this._evaluation = null;

    this.root = document.createElement('div');
    this.root.className = 'zt-import';
    this.root.innerHTML = this._template();
    this.canvas = /** @type {HTMLCanvasElement} */ (this.root.querySelector('.zt-import__canvas'));
    this.fileInput = /** @type {HTMLInputElement} */ (this.root.querySelector('input[type=file]'));

    this._onClick = this._onClick.bind(this);
    this._onFile = this._onFile.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onDragOver = (e) => { e.preventDefault(); this.root.classList.add('is-dragover'); };
    this._onDragLeave = () => this.root.classList.remove('is-dragover');
    this._onDrop = this._onDrop.bind(this);
    this._onPaste = this._onPaste.bind(this);

    this.root.addEventListener('click', this._onClick);
    this.fileInput.addEventListener('change', this._onFile);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointercancel', this._onPointerUp);
    this.root.addEventListener('dragover', this._onDragOver);
    this.root.addEventListener('dragleave', this._onDragLeave);
    this.root.addEventListener('drop', this._onDrop);
    this._renderSummary();
  }

  /** Rule mode used for the verdict (Renju changes what counts as a win). */
  setMode(mode) {
    this._mode = mode;
    if (this._board) this._evaluate();
  }

  /** Called by the start screen when the panel becomes visible / hidden. */
  setActive(active) {
    if (active) document.addEventListener('paste', this._onPaste);
    else document.removeEventListener('paste', this._onPaste);
  }

  reset() {
    this._source = null;
    this._corners = null;
    this._board = null;
    this._cellConfidence = null;
    this._overrides.clear();
    this._gridReliable = true;
    this._turnOverride = null;
    this._evaluation = null;
    this._busy = false;
    this.fileInput.value = '';
    this.root.classList.remove('has-source');
    this._setStatus('');
    this._renderSummary();
  }

  dispose() {
    this.setActive(false);
    this.root.removeEventListener('click', this._onClick);
    this.fileInput.removeEventListener('change', this._onFile);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointermove', this._onPointerMove);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('pointercancel', this._onPointerUp);
    this.root.removeEventListener('dragover', this._onDragOver);
    this.root.removeEventListener('dragleave', this._onDragLeave);
    this.root.removeEventListener('drop', this._onDrop);
    this.root.remove();
  }

  // ---------------------------------------------------------------------------
  // input
  // ---------------------------------------------------------------------------

  /** @param {File | Blob} file */
  async loadFile(file) {
    if (!file) return;
    const name = 'name' in file ? String(file.name) : '';
    const isText = /\.(json|txt|md)$/i.test(name) || /^(text\/|application\/json)/.test(file.type);
    this._setStatus('读取中…');
    try {
      if (isText) this.loadText(await file.text());
      else await this.loadImage(await fileToBitmap(file));
    } catch (err) {
      this._setStatus(`读取失败：${err?.message ?? err}`, 'error');
    }
  }

  /** @param {ImageBitmap | HTMLImageElement} bitmap */
  async loadImage(bitmap) {
    const w0 = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
    const h0 = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
    const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    /** @type {any} */ (bitmap).close?.();
    this._setImageSource(canvas);
  }

  /** Saved record or a plain text board. */
  loadText(text) {
    const parsed = parseRecord(text, BOARD_SIZE);
    if (!parsed.ok) {
      this._setStatus(`无法解析：${parsed.error}`, 'error');
      return;
    }
    this._source = { kind: 'record', record: parsed.record };
    this._overrides.clear();
    this._turnOverride = null;
    this._corners = { tl: [...SCHEMATIC_CORNERS.tl], tr: [...SCHEMATIC_CORNERS.tr], br: [...SCHEMATIC_CORNERS.br], bl: [...SCHEMATIC_CORNERS.bl] };
    this._cellConfidence = null;
    this._gridReliable = true;
    this._board = parsed.record.board ? copyGrid(parsed.record.board) : createEmptyBoard(BOARD_SIZE);
    this._boardSource = parsed.record.source;
    this.root.classList.add('has-source');
    this._setStatus(parsed.record.moves.length ? `已读取棋谱：${parsed.record.moves.length} 手` : '已读取文本局面');
    this._layoutCanvas(SCHEMATIC_SIZE, SCHEMATIC_SIZE);
    this._evaluate();
    this._draw();
  }

  _setImageSource(canvas) {
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    this._source = { kind: 'image', canvas, imageData };
    this._overrides.clear();
    this._turnOverride = null;
    this._boardSource = 'image';
    this.root.classList.add('has-source');
    this._layoutCanvas(canvas.width, canvas.height);
    this._detect();
  }

  _detect() {
    if (this._source?.kind !== 'image') return;
    this._setStatus('识别中…');
    const result = recognizeBoard(this._source.imageData);
    this._corners = result.corners;
    this._board = result.board;
    this._cellConfidence = result.cellConfidence;
    this._gridReliable = result.gridReliable;
    this._overrides.clear();
    this._boardSource = 'image';
    this._setStatus(result.gridReliable
      ? `已定位棋盘网格（置信度 ${Math.round(result.gridConfidence * 100)}%）`
      : '未能自动定位棋盘：请拖动四个橙色角点，对准棋盘最外侧的四个交点', result.gridReliable ? '' : 'warn');
    this._evaluate();
    this._draw();
  }

  /** Re-classify every intersection for the current corners, keeping manual corrections. */
  _resample() {
    if (this._source?.kind !== 'image' || !this._corners) return;
    const { board, cellConfidence } = sampleBoard(this._source.imageData, this._corners);
    for (const [key, value] of this._overrides) {
      const [r, c] = key.split(',').map(Number);
      board[r][c] = value;
    }
    this._board = board;
    this._cellConfidence = cellConfidence;
    this._boardSource = 'image';
    this._evaluate();
    this._draw();
  }

  async _recognizeCloud() {
    if (!this.vision || this._source?.kind !== 'image' || this._busy) return;
    this._busy = true;
    this._setStatus('已发送给云端视觉模型，识别中…');
    this.root.classList.add('is-busy');
    try {
      const dataUrl = this._source.canvas.toDataURL('image/jpeg', 0.85);
      const { board } = await recognizeWithVisionModel(dataUrl, this.vision);
      this._board = board;
      this._cellConfidence = null;
      this._overrides.clear();
      this._boardSource = 'llm';
      this._setStatus('云端识别完成 · 请核对图中标记，点击交点可修正');
      this._evaluate();
      this._draw();
    } catch (err) {
      this._setStatus(`云端识别失败：${err?.message ?? err}`, 'error');
    } finally {
      this._busy = false;
      this.root.classList.remove('is-busy');
    }
  }

  _rotate() {
    if (this._source?.kind !== 'image') return;
    const src = this._source.canvas;
    const out = document.createElement('canvas');
    out.width = src.height;
    out.height = src.width;
    const ctx = /** @type {CanvasRenderingContext2D} */ (out.getContext('2d', { willReadFrequently: true }));
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(src, 0, 0);
    this._setImageSource(out);
  }

  _clearStones() {
    if (!this._board) return;
    this._board = createEmptyBoard(BOARD_SIZE);
    this._overrides.clear();
    for (let r = 0; r < BOARD_SIZE; r++) for (let c = 0; c < BOARD_SIZE; c++) this._overrides.set(`${r},${c}`, EMPTY);
    this._evaluate();
    this._draw();
  }

  // ---------------------------------------------------------------------------
  // evaluation
  // ---------------------------------------------------------------------------

  get _moves() {
    return this._source?.kind === 'record' ? this._source.record.moves : [];
  }

  get _editable() {
    return this._source != null && this._moves.length === 0;
  }

  /** Run the same reducer the table will use, so the verdict can never disagree with the engine. */
  _evaluate() {
    if (!this._board) {
      this._evaluation = null;
      this._renderSummary();
      return;
    }
    const board = this._board;
    const moves = this._moves;
    const setupAnalysis = analyzePosition(board, { mode: this._mode });
    const currentPlayer = moves.length === 0 ? (this._turnOverride ?? this._source?.record?.currentPlayer ?? null) : null;
    const result = transition(createInitialState({ mode: this._mode }), {
      type: ActionType.LOAD_POSITION, board, moves, currentPlayer: currentPlayer ?? undefined, timestamp: 0,
    });
    const finalBoard = result.error ? board : result.state.board;
    const analysis = analyzePosition(finalBoard, { mode: this._mode });
    this._evaluation = {
      ok: !result.error,
      error: result.error,
      analysis,
      setupAnalysis,
      currentPlayer: result.error ? analysis.turn.player : result.state.currentPlayer,
      moves: moves.length,
    };
    this._renderSummary();
  }

  _confirm() {
    if (!this._evaluation?.ok || !this._board) return;
    const moves = this._moves;
    const record = this._source?.kind === 'record' ? this._source.record : null;
    this._onConfirm?.({
      board: this._board,
      moves,
      currentPlayer: moves.length === 0 ? (this._turnOverride ?? record?.currentPlayer ?? null) : null,
      humanColor: record?.humanColor ?? null,
      source: this._boardSource,
      counts: this._evaluation.analysis.counts,
    });
  }

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------

  _template() {
    const cloud = this.vision ? '<button type="button" class="zt-seg__btn" data-act="cloud">云端识图</button>' : '';
    return `
      <input type="file" accept="image/*,.json,.txt,application/json,text/plain" hidden />
      <div class="zt-import__drop">
        <button type="button" class="zt-seal zt-seal--small" data-act="pick">选择棋局图片 / 棋谱文件</button>
        <p class="zt-import__drophint">支持棋盘照片与截图（自动识别网格与黑白子）、本站导出的棋谱 .json、15 行 X/O/. 文本局面。<br />也可以把图片拖进来，或直接 Ctrl+V 粘贴截图。</p>
      </div>
      <div class="zt-import__stage">
        <canvas class="zt-import__canvas" aria-label="棋局识别预览"></canvas>
        <div class="zt-import__tools" role="group" aria-label="识别工具">
          <button type="button" class="zt-seg__btn" data-act="redetect">重新识别</button>
          ${cloud}
          <button type="button" class="zt-seg__btn" data-act="rotate">旋转 90°</button>
          <button type="button" class="zt-seg__btn" data-act="clear">清空棋子</button>
          <button type="button" class="zt-seg__btn" data-act="pick">换一张</button>
        </div>
        <p class="zt-import__edithint">拖动四个橙色角点对准棋盘最外侧的交点 · 点击任一交点可在 空 → 黑 → 白 之间切换修正</p>
      </div>
      <p class="zt-import__status" aria-live="polite"></p>
      <div class="zt-import__summary"></div>
      <footer class="zt-import__actions">
        <button type="button" class="zt-seal" data-act="confirm" disabled>在 3D 棋案上继续这盘棋</button>
        <button type="button" class="zt-ghost" data-act="cancel">返回</button>
      </footer>`;
  }

  _setStatus(text, tone = '') {
    const el = /** @type {HTMLElement} */ (this.root.querySelector('.zt-import__status'));
    el.textContent = text;
    el.dataset.tone = tone;
  }

  _renderSummary() {
    const el = /** @type {HTMLElement} */ (this.root.querySelector('.zt-import__summary'));
    const confirm = /** @type {HTMLButtonElement} */ (this.root.querySelector('[data-act=confirm]'));
    const ev = this._evaluation;
    if (!ev) {
      el.innerHTML = '';
      confirm.disabled = true;
      return;
    }
    const { analysis, setupAnalysis } = ev;
    const c = analysis.counts;
    const lines = [];
    lines.push(`<div class="zt-import__counts"><span class="zt-import__stone zt-import__stone--black"></span> 黑 ${c.black} <span class="zt-import__stone zt-import__stone--white"></span> 白 ${c.white}${ev.moves ? ` · 棋谱 ${ev.moves} 手` : ''}</div>`);

    let verdict = '';
    let tone = 'ok';
    if (ev.ok) {
      const side = SIDE_NAME[ev.currentPlayer];
      if (analysis.verdict === PositionVerdict.EMPTY) {
        verdict = '没有识别到棋子。可以拖动角点重新对准棋盘、点击交点手动摆子，或直接以空棋盘开局。';
        tone = 'warn';
      } else {
        verdict = `局面可以继续，轮到<b>${side}方</b>落子。入座后揭开棋罐选择你执的颜色，另一方由 AI 接手。`;
      }
      if (!setupAnalysis.turn.consistent && ev.moves === 0) {
        verdict += ' 注意：黑白子数不合常规（黑应等于白或多一子），请核对识别结果，或在下方手动指定先手方。';
        tone = 'warn';
      }
    } else {
      tone = 'error';
      const winner = analysis.winner ? `${SIDE_NAME[analysis.winner]}方` : '';
      const why = {
        [PositionVerdict.BLACK_WON]: `${winner}已成五连，此局已分胜负，无法继续。若是误识别，点击对应棋子修正。`,
        [PositionVerdict.WHITE_WON]: `${winner}已成五连，此局已分胜负，无法继续。若是误识别，点击对应棋子修正。`,
        [PositionVerdict.BOTH_WON]: '黑白双方都已成五，这不是一个可能出现的局面，请修正识别结果。',
        [PositionVerdict.FULL]: '棋盘已满，无法继续。',
      }[analysis.verdict];
      verdict = why ?? `无法复原：${ev.error}`;
    }
    lines.push(`<p class="zt-import__verdict" data-tone="${tone}">${verdict}</p>`);

    if (this._editable && analysis.counts.total > 0) {
      const opt = (value, label) => `<button type="button" class="zt-seg__btn" data-turn="${value}" aria-pressed="${String(this._turnOverride === value)}">${label}</button>`;
      lines.push(`<div class="zt-import__turn"><span>先手方</span><div class="zt-seg">${opt('auto', '按子数推断')}${opt(BLACK, '黑方先')}${opt(WHITE, '白方先')}</div></div>`);
    }
    el.innerHTML = lines.join('');
    for (const btn of el.querySelectorAll('[data-turn]')) {
      const v = /** @type {HTMLElement} */ (btn).dataset.turn;
      /** @type {HTMLElement} */ (btn).setAttribute('aria-pressed', String((v === 'auto' && this._turnOverride === null) || Number(v) === this._turnOverride));
    }
    confirm.disabled = !ev.ok;
  }

  _layoutCanvas(w, h) {
    // Keep the verdict and the confirm button on screen: the preview never takes more than ~40% of the viewport height.
    const maxHeight = Math.min(MAX_DISPLAY_HEIGHT, Math.max(220, (globalThis.innerHeight || 800) * 0.4));
    const fit = Math.min(MAX_DISPLAY_WIDTH / w, maxHeight / h);
    this._fit = fit;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    this.canvas.style.width = `${Math.round(w * fit)}px`;
    this.canvas.style.height = `${Math.round(h * fit)}px`;
    this.canvas.width = Math.round(w * fit * dpr);
    this.canvas.height = Math.round(h * fit * dpr);
    this._dpr = dpr;
  }

  _draw() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this._board) return;
    const s = this._fit * this._dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.scale(s, s);

    const corners = this._corners;
    if (this._source?.kind === 'image') {
      ctx.drawImage(this._source.canvas, 0, 0);
    } else {
      // Schematic board for records / text positions.
      ctx.fillStyle = '#d9b46f';
      ctx.fillRect(0, 0, SCHEMATIC_SIZE, SCHEMATIC_SIZE);
    }
    if (!corners) return;
    const map = gridToImageMapper(corners);
    const step = 1 / LINES;

    ctx.lineWidth = 1 / this._fit;
    ctx.strokeStyle = this._source?.kind === 'image' ? 'rgba(0, 210, 255, 0.6)' : 'rgba(58, 36, 16, 0.9)';
    ctx.beginPath();
    for (let i = 0; i <= LINES; i++) {
      const [x0, y0] = map(i * step, 0);
      const [x1, y1] = map(i * step, 1);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      const [x2, y2] = map(0, i * step);
      const [x3, y3] = map(1, i * step);
      ctx.moveTo(x2, y2);
      ctx.lineTo(x3, y3);
    }
    ctx.stroke();

    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const value = this._board[row][col];
        if (value === EMPTY) continue;
        const u = col * step;
        const v = row * step;
        const [x, y] = map(u, v);
        const [nx, ny] = map(col < LINES ? u + step : u - step, v);
        const r = Math.hypot(nx - x, ny - y) * 0.4;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = value === BLACK ? 'rgba(18, 18, 20, 0.85)' : 'rgba(250, 248, 240, 0.9)';
        ctx.fill();
        const key = `${row},${col}`;
        const conf = this._cellConfidence ? this._cellConfidence[row * BOARD_SIZE + col] : 1;
        ctx.lineWidth = 2 / this._fit;
        ctx.setLineDash(conf < 0.5 && !this._overrides.has(key) ? [3 / this._fit, 3 / this._fit] : []);
        ctx.strokeStyle = this._overrides.has(key) ? 'rgba(255, 80, 200, 0.95)' : conf < 0.5 ? 'rgba(255, 150, 0, 0.95)' : 'rgba(0, 210, 255, 0.9)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (this._source?.kind === 'image') {
      const hr = 7 / this._fit;
      for (const key of /** @type {const} */ (['tl', 'tr', 'br', 'bl'])) {
        const [x, y] = corners[key];
        ctx.beginPath();
        ctx.arc(x, y, this._drag?.corner === key ? hr * 1.4 : hr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 130, 0, 0.9)';
        ctx.fill();
        ctx.lineWidth = 2 / this._fit;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------

  /** @param {MouseEvent} event */
  _onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target).closest('button');
    if (!target) return;
    if (target.dataset.turn != null) {
      const v = target.dataset.turn;
      this._turnOverride = v === 'auto' ? null : Number(v);
      this._evaluate();
      return;
    }
    switch (target.dataset.act) {
      case 'pick': this.fileInput.click(); break;
      case 'redetect': this._detect(); break;
      case 'cloud': this._recognizeCloud(); break;
      case 'rotate': this._rotate(); break;
      case 'clear': this._clearStones(); break;
      case 'confirm': this._confirm(); break;
      case 'cancel': this._onCancel?.(); break;
      default: break;
    }
  }

  _onFile() {
    const file = this.fileInput.files?.[0];
    if (file) this.loadFile(file);
    this.fileInput.value = '';
  }

  /** @param {DragEvent} event */
  _onDrop(event) {
    event.preventDefault();
    this.root.classList.remove('is-dragover');
    const file = event.dataTransfer?.files?.[0];
    if (file) this.loadFile(file);
  }

  /** @param {ClipboardEvent} event */
  _onPaste(event) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          this.loadFile(file);
          return;
        }
      }
    }
    const text = event.clipboardData?.getData('text/plain');
    if (text && text.trim().length > 30) {
      event.preventDefault();
      this.loadText(text);
    }
  }

  /** Pointer position in analysis-image pixels. */
  _toImage(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) / this._fit, (event.clientY - rect.top) / this._fit];
  }

  /** @param {PointerEvent} event */
  _onPointerDown(event) {
    if (!this._board || !this._corners || event.button !== 0) return;
    const [x, y] = this._toImage(event);
    if (this._source?.kind === 'image') {
      const hit = HANDLE_HIT_CSS_PX / this._fit;
      for (const key of /** @type {const} */ (['tl', 'tr', 'br', 'bl'])) {
        const [cx, cy] = this._corners[key];
        if (Math.hypot(cx - x, cy - y) <= hit) {
          this._drag = { corner: key, pointerId: event.pointerId };
          this.canvas.setPointerCapture(event.pointerId);
          this._draw();
          return;
        }
      }
    }
    if (!this._editable) return;
    const cell = this._nearestCell(x, y);
    if (!cell) return;
    const key = `${cell.row},${cell.col}`;
    const next = CYCLE[this._board[cell.row][cell.col]];
    this._board[cell.row][cell.col] = next;
    this._overrides.set(key, next);
    this._boardSource = this._boardSource === 'llm' ? 'llm' : this._source?.kind === 'image' ? 'image' : 'text';
    this._evaluate();
    this._draw();
  }

  /** @param {PointerEvent} event */
  _onPointerMove(event) {
    if (!this._drag || event.pointerId !== this._drag.pointerId || !this._corners) return;
    const [x, y] = this._toImage(event);
    const src = /** @type {{ canvas: HTMLCanvasElement }} */ (this._source);
    this._corners = {
      ...this._corners,
      [this._drag.corner]: [Math.max(0, Math.min(src.canvas.width, x)), Math.max(0, Math.min(src.canvas.height, y))],
    };
    this._draw();
  }

  /** @param {PointerEvent} event */
  _onPointerUp(event) {
    if (!this._drag || event.pointerId !== this._drag.pointerId) return;
    this._drag = null;
    this._gridReliable = true;
    this._setStatus('已按新角点重新识别 · 点击交点可修正个别棋子');
    this._resample();
  }

  _nearestCell(x, y) {
    if (!this._corners) return null;
    const map = gridToImageMapper(this._corners);
    const step = 1 / LINES;
    let best = null;
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const [cx, cy] = map(col * step, row * step);
        const d = Math.hypot(cx - x, cy - y);
        if (!best || d < best.d) best = { row, col, d, cx, cy };
      }
    }
    if (!best) return null;
    const [nx, ny] = map(best.col < LINES ? (best.col + 1) * step : (best.col - 1) * step, best.row * step);
    const cell = Math.hypot(nx - best.cx, ny - best.cy);
    return best.d <= cell * 0.45 ? { row: best.row, col: best.col } : null;
  }
}

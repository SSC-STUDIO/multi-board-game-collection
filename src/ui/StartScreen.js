/**
 * Start screen / settings sheet shown *before* the player sits down at the
 * table (and again on Esc). It is the one piece of 2D UI in the project and it
 * removes itself from the DOM while a game is in progress, so the "zero 2D
 * overlay" rule from the plan still holds inside the play viewport.
 *
 * Modes: 'title' (first visit), 'menu' (Esc during play) and 'import' (the
 * "复原棋局" panel, hosted inside the same card so the veil never flickers).
 *
 * Markup is generated here; styling lives in start-screen.css / importer.css
 * (linked from index.html so the untranspiled sources work without a bundler).
 */
import { DEFAULT_SETTINGS, SETTING_LABELS, SETTING_OPTIONS, sanitizeSettings } from './Settings.js';
import { publicUrl } from '../utils/PublicUrl.js';

const HINT_TITLE = '入座后揭开黑罐或白罐选择执子颜色 · 拖动环视桌案 · 滚轮推拉 · 点击桌面空白处回正 · Esc 打开设置';
const HINT_MENU = '规则与用时在开新对局时生效 · 棋力、画质与音效即时生效 · 再按 Esc 继续对弈';
const TOUCH_HINT_TITLE = '入座后点棋罐选择执子 · 单指拖动环视 · 双指缩放 · 点桌面空白回正 · 点桌案“设置”打开菜单';
const TOUCH_HINT_MENU = '规则与用时在开新对局时生效 · 棋力、画质与音效即时生效 · 点“继续对弈”返回棋局';

/**
 * @typedef {typeof DEFAULT_SETTINGS} Settings
 * @typedef {'title' | 'menu' | 'import'} ScreenMode
 * @typedef {{ wins: number, losses: number, draws: number }} Stats
 * @typedef {object} StartScreenCallbacks
 * @property {(settings: Settings) => void} onStart     "入座对弈" from the title screen
 * @property {(settings: Settings) => void} onResume    "继续对弈" from the in-game menu
 * @property {(settings: Settings) => void} onNewGame   "新对局" from the in-game menu
 * @property {(settings: Settings, key: string) => void} [onChange]  any setting toggled
 * @property {(settings: Settings) => void} [onTutorial] "新手指导"
 * @property {() => void} [onSave]                       "保存棋谱" (menu only)
 * @property {(settings: Settings) => void} [onResign]   "认输" (menu only, while a game is on)
 */

export class StartScreen {
  /**
   * @param {{ settings?: Partial<Settings>, logoUrl?: string, importer?: { root: HTMLElement, setActive: (a: boolean) => void, setMode: (m: string) => void, reset: () => void } | null, stats?: Stats | null } & StartScreenCallbacks} options
   */
  constructor({ settings = {}, logoUrl = '/favicon.svg', importer = null, stats = null, savedGame = null, onContinueSaved, onStart, onResume, onNewGame, onChange, onTutorial, onSave, onResign } = /** @type {any} */ ({})) {
    this._settings = sanitizeSettings(settings);
    this._callbacks = { onStart, onResume, onNewGame, onChange, onTutorial, onSave, onResign, onContinueSaved };
    this._savedGame = savedGame;
    this._importer = importer;
    /** @type {ScreenMode} */
    this._mode = 'title';
    /** Mode to return to when the import panel closes. @type {'title' | 'menu'} */
    this._returnMode = 'title';
    this._visible = false;
    this._hidePromise = null;
    this._menuContext = { canResign: false, canSave: false };

    this.root = document.createElement('div');
    this.root.className = 'zt-start';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Zenith Tabletop 3D 开始');
    this.root.innerHTML = this._template(publicUrl(logoUrl));
    if (importer) this.root.querySelector('.zt-start__import')?.appendChild(importer.root);

    this._onClick = this._onClick.bind(this);
    this.root.addEventListener('click', this._onClick);
    this._renderSettings();
    this._renderActions();
    this.setStats(stats);
  }

  get visible() {
    return this._visible;
  }

  /** @returns {ScreenMode} */
  get mode() {
    return this._mode;
  }

  /** @returns {Settings} */
  get settings() {
    return { ...this._settings };
  }

  /** Replace the displayed settings (e.g. after URL overrides). */
  setSettings(settings) {
    this._settings = sanitizeSettings({ ...this._settings, ...settings });
    this._renderSettings();
  }

  /** Which menu-only actions make sense right now. */
  setMenuContext({ canResign = false, canSave = false } = {}) {
    this._menuContext = { canResign, canSave };
    if (this._mode === 'menu') this._renderActions();
  }

  /** Lifetime record shown under the title; hidden until a game has been finished. */
  setStats(stats) {
    const el = this.root.querySelector('.zt-start__stats');
    if (!el) return;
    const total = stats ? stats.wins + stats.losses + stats.draws : 0;
    el.textContent = total > 0 ? `战绩 · 胜 ${stats.wins} · 负 ${stats.losses} · 和 ${stats.draws}` : '';
    el.hidden = total === 0;
  }

  /**
   * Attach to the DOM and fade in.
   * @param {ScreenMode} [mode]
   * @param {HTMLElement} [parent]
   */
  show(mode = 'title', parent = document.body) {
    if (mode === 'import' && this._mode !== 'import') this._returnMode = this._mode === 'menu' ? 'menu' : 'title';
    const wasImport = this._mode === 'import';
    this._mode = mode;
    this._hidePromise = null;
    this._renderActions();
    this.root.classList.remove('is-hiding');
    this.root.classList.toggle('is-menu', mode === 'menu');
    this.root.classList.toggle('is-import', mode === 'import');
    if (this._importer) {
      if (mode === 'import') {
        this._importer.setMode(this._settings.mode);
        this._importer.setActive(true);
      } else if (wasImport) {
        this._importer.setActive(false);
      }
    }
    if (!this.root.isConnected) parent.appendChild(this.root);
    // Force a style flush so the entrance transition plays even right after a hide().
    void this.root.offsetWidth;
    this.root.classList.add('is-visible');
    this._visible = true;
    this.root.querySelector('[data-action]')?.focus?.({ preventScroll: true });
  }

  /** Leave the import panel for whichever sheet opened it. */
  back() {
    if (this._mode !== 'import') return;
    this.show(this._returnMode);
  }

  /**
   * Fade out, then detach from the DOM so nothing but the canvas remains.
   * @returns {Promise<void>}
   */
  hide() {
    if (!this._visible) return this._hidePromise ?? Promise.resolve();
    this._visible = false;
    if (this._mode === 'import') this._importer?.setActive(false);
    this.root.classList.add('is-hiding');
    this.root.classList.remove('is-visible');
    this._hidePromise = new Promise((resolve) => {
      const done = () => {
        this.root.removeEventListener('transitionend', done);
        if (!this._visible) this.root.remove();
        resolve();
      };
      this.root.addEventListener('transitionend', done, { once: true });
      // transitionend is not guaranteed (reduced motion, hidden tab): hard stop.
      setTimeout(done, 700);
    });
    return this._hidePromise;
  }

  dispose() {
    this._importer?.setActive(false);
    this.root.removeEventListener('click', this._onClick);
    this.root.remove();
    this._visible = false;
  }

  // ---------------------------------------------------------------------------

  _template(logoUrl) {
    return `
      <div class="zt-start__veil"></div>
      <div class="zt-start__card">
        <header class="zt-start__brand">
          <img class="zt-start__logo" src="${logoUrl}" alt="" width="72" height="72" />
          <div>
            <h1 class="zt-start__title">巅峰棋道</h1>
            <p class="zt-start__sub">Zenith Tabletop 3D · 拟真实体化棋道空间</p>
            <p class="zt-start__stats" hidden></p>
          </div>
        </header>
        <div class="zt-start__rule"></div>
        <section class="zt-start__settings" aria-label="设置"></section>
        <section class="zt-start__import" aria-label="复原棋局"></section>
        <footer class="zt-start__actions"></footer>
        <div class="zt-start__secondary"></div>
        <p class="zt-start__hint"></p>
      </div>`;
  }

  _renderSettings() {
    const section = this.root.querySelector('.zt-start__settings');
    section.innerHTML = Object.keys(SETTING_OPTIONS).map((key) => {
      const buttons = SETTING_OPTIONS[key].map((opt, i) => {
        const pressed = this._settings[key] === opt.value;
        const hint = opt.hint ? ` title="${opt.hint}"` : '';
        return `<button type="button" class="zt-seg__btn" data-key="${key}" data-index="${i}" aria-pressed="${pressed}"${hint}>${opt.label}</button>`;
      }).join('');
      return `<div class="zt-row"><span class="zt-row__label">${SETTING_LABELS[key]}</span><div class="zt-seg" role="group" aria-label="${SETTING_LABELS[key]}">${buttons}</div></div>`;
    }).join('');
  }

  _renderActions() {
    const footer = this.root.querySelector('.zt-start__actions');
    const secondary = this.root.querySelector('.zt-start__secondary');
    const hint = this.root.querySelector('.zt-start__hint');
    const link = (action, label) => `<button type="button" class="zt-link" data-action="${action}">${label}</button>`;
    if (this._mode === 'import') {
      footer.innerHTML = '';
      secondary.innerHTML = '';
      hint.textContent = '';
      return;
    }
    if (this._mode === 'menu') {
      const { canResign, canSave } = this._menuContext;
      footer.innerHTML = `
        <button type="button" class="zt-seal" data-action="resume">继续对弈</button>
        <button type="button" class="zt-ghost" data-action="new">新对局</button>`;
      secondary.innerHTML = [
        canSave ? link('save', '保存棋谱') : '',
        link('import', '复原棋局'),
        canResign ? link('resign', '认输') : '',
        link('tutorial', '新手指导'),
      ].join('');
      hint.textContent = globalThis.matchMedia?.('(pointer: coarse)').matches ? TOUCH_HINT_MENU : HINT_MENU;
    } else {
      footer.innerHTML = `
        ${this._savedGame ? '<button type="button" class="zt-seal" data-action="continue-saved">继续上次棋局</button>' : ''}
        <button type="button" class="${this._savedGame ? 'zt-ghost' : 'zt-seal'}" data-action="start">${this._savedGame ? '另开新局' : '入座对弈'}</button>
        <button type="button" class="zt-ghost" data-action="import">复原棋局</button>`;
      secondary.innerHTML = link('tutorial', '新手指导');
      hint.textContent = this._savedGame ? `上次已保存 ${this._savedGame.moves.length} 手 · 保留执子、规则和剩余用时 · 离开期间不扣时` : (globalThis.matchMedia?.('(pointer: coarse)').matches ? TOUCH_HINT_TITLE : HINT_TITLE);
    }
  }

  /** @param {MouseEvent} event */
  _onClick(event) {
    const target = /** @type {HTMLElement} */ (event.target).closest('button');
    if (!target || !this.root.contains(target)) return;
    // Buttons inside the import panel belong to the importer.
    if (target.closest('.zt-start__import')) return;

    if (target.dataset.key) {
      const key = target.dataset.key;
      const option = SETTING_OPTIONS[key][Number(target.dataset.index)];
      if (!option || this._settings[key] === option.value) return;
      this._settings = { ...this._settings, [key]: option.value };
      for (const btn of this.root.querySelectorAll(`[data-key="${key}"]`)) {
        btn.setAttribute('aria-pressed', String(btn === target));
      }
      this._callbacks.onChange?.(this.settings, key);
      return;
    }

    switch (target.dataset.action) {
      case 'continue-saved':
        this._callbacks.onContinueSaved?.();
        break;
      case 'start':
        this._callbacks.onStart?.(this.settings);
        break;
      case 'resume':
        this._callbacks.onResume?.(this.settings);
        break;
      case 'new':
        this._callbacks.onNewGame?.(this.settings);
        break;
      case 'import':
        this._importer?.reset();
        this.show('import');
        break;
      case 'tutorial':
        this._callbacks.onTutorial?.(this.settings);
        break;
      case 'save':
        this._callbacks.onSave?.();
        break;
      case 'resign':
        this._callbacks.onResign?.(this.settings);
        break;
      default:
        break;
    }
  }
}

/**
 * Guided first-visit tour of the tabletop. Each step names a viewpoint and the
 * props to spotlight, and explains them in the bottom caption with
 * 上一步 / 下一步 / 跳过 buttons. The app performs the camera flight, glow and
 * lighting through `onStep`; this class only sequences steps and remembers in
 * localStorage that the tour has been seen, so it stays free of Three.js.
 */

export const TUTORIAL_STORAGE_KEY = 'zenith.tutorial.v1';

/**
 * @typedef {object} TutorialStep
 * @property {string} id
 * @property {string} view        CameraDirector viewpoint name
 * @property {string[]} spot      entity names to glow ('board' glows the board surface only)
 * @property {string} [mood]      Lighting mood while on this step
 * @property {string} title
 * @property {string} text
 */

/** @type {readonly TutorialStep[]} */
export const TUTORIAL_STEPS = Object.freeze([
  {
    id: 'welcome', view: 'MAIN_PLAY', spot: [],
    title: '欢迎来到棋案',
    text: '桌上的器物都可以操作，棋盘前方的铭牌也能选边、暂停、悔棋、复盘和打开设置。花一分钟，认识这张棋案。',
  },
  {
    id: 'opponent', view: 'MAIN_PLAY', spot: ['opponent'],
    title: '对面的棋手',
    text: '坐在对面的是你的 AI 对手：轮到它时会俯身沉思，伸手从身旁的棋碟里取子落到棋盘上，终局时向你行礼。你自己的手也会从棋罐取子、在记谱册上落笔。',
  },
  {
    id: 'bowls', view: 'MAIN_PLAY', spot: ['bowls'],
    title: '棋罐 · 选边开局',
    text: '揭开左侧黑胡桃木罐执黑先行，揭开右侧白蜡木罐执白后手。终局后再点任一棋罐，即开新的一局。',
  },
  {
    id: 'board', view: 'MAIN_PLAY', spot: ['board'],
    title: '棋盘 · 落子',
    text: '轮到你时，鼠标移到交点会出现半透明的预览子，点击即落子。横、竖、斜任一方向先连成五子者胜。',
  },
  {
    id: 'clock', view: 'CLOCK_FOCUS', spot: ['clock'],
    title: '对局钟 · 暂停与用时',
    text: '双表盘分别记录黑白双方的用时。点击侧边的黄铜扳手即可暂停，再点一次恢复；点钟体只是推近查看。',
  },
  {
    id: 'sandglass', view: 'MAIN_PLAY', spot: ['sandglass'],
    title: '沙漏 · 悔棋',
    text: '点击沙漏，沙漏翻转、沙粒倒流，刚落下的棋子会飞回棋罐。人机对弈时会连带收回 AI 的应手。',
  },
  {
    id: 'manual', view: 'MANUAL_STUDY', spot: ['manual'], mood: 'study',
    title: '古籍 · 棋道导师',
    text: '拿不定主意时点击线装古籍：毛笔会在宣纸上写下推荐着法与批注，棋盘上对应的交点升起一缕青烟。',
  },
  {
    id: 'ledger', view: 'LEDGER_REVIEW', spot: ['ledger'], mood: 'study',
    title: '记谱册 · 行棋记录',
    text: '每一手都会被钢笔记入记谱册。点某一手可查看当时局面，也可点铭牌「棋谱」逐手复盘；复盘期间暂停计时，返回后继续对弈。',
  },
  {
    id: 'stamp', view: 'MAIN_PLAY', spot: ['stamp'],
    title: '印章 · 终局',
    text: '分出胜负时，青田石印章凌空落下，盖出「大捷」「承让」或「和局」。屏幕底部会提示如何再来一局。',
  },
  {
    id: 'camera', view: 'MAIN_PLAY', spot: [],
    title: '镜头与快捷键',
    text: '拖动环视，滚轮或双指缩放；铭牌「俯览」看清棋盘，「设置」打开菜单。Esc 设置，Z 悔棋，H 提示，空格暂停。棋局自动保存，重新打开可继续。',
  },
]);

export class Tutorial {
  /**
   * @param {object} options
   * @param {import('./Hud.js').Hud} options.hud
   * @param {(step: TutorialStep, index: number) => void} options.onStep   fly / glow / light for a step
   * @param {(completed: boolean) => void} options.onFinish              called once when the tour ends
   * @param {readonly TutorialStep[]} [options.steps]
   * @param {Storage | null} [options.storage]
   */
  constructor({ hud, onStep, onFinish, steps = TUTORIAL_STEPS, storage = globalThis.localStorage ?? null }) {
    this.hud = hud;
    this.steps = steps;
    this._onStep = onStep;
    this._onFinish = onFinish;
    this._storage = storage;
    this._index = -1;
    this._active = false;
  }

  /** @param {Storage | null} [storage] */
  static isDone(storage = globalThis.localStorage ?? null) {
    try {
      return storage?.getItem(TUTORIAL_STORAGE_KEY) === 'done';
    } catch {
      return true;
    }
  }

  get active() {
    return this._active;
  }

  get index() {
    return this._index;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._show(0);
  }

  next() {
    if (!this._active) return;
    if (this._index + 1 >= this.steps.length) this.finish(true);
    else this._show(this._index + 1);
  }

  prev() {
    if (!this._active || this._index === 0) return;
    this._show(this._index - 1);
  }

  /** End the tour early (Esc / 跳过). Still marks it as seen: the player chose to leave. */
  skip() {
    this.finish(false);
  }

  /** @param {string} actionId one of the caption button ids */
  handleAction(actionId) {
    if (actionId === 'tutorial:next') this.next();
    else if (actionId === 'tutorial:prev') this.prev();
    else if (actionId === 'tutorial:skip') this.skip();
  }

  finish(completed) {
    if (!this._active) return;
    this._active = false;
    this._index = -1;
    this.hud.clear('center');
    try {
      this._storage?.setItem(TUTORIAL_STORAGE_KEY, 'done');
    } catch {
      /* private mode: the tour will simply offer itself again next visit */
    }
    this._onFinish?.(completed);
  }

  dispose() {
    if (this._active) {
      this._active = false;
      this._index = -1;
      this.hud.clear('center');
    }
  }

  _show(index) {
    this._index = index;
    const step = this.steps[index];
    const last = index === this.steps.length - 1;
    const actions = [];
    if (index > 0) actions.push({ id: 'tutorial:prev', label: '上一步' });
    actions.push({ id: 'tutorial:next', label: last ? '开始对弈' : '下一步', primary: true });
    if (!last) actions.push({ id: 'tutorial:skip', label: '跳过' });
    this.hud.set('center', { title: step.title, text: step.text, meta: `${index + 1} / ${this.steps.length}`, actions });
    this._onStep?.(step, index);
  }
}

/**
 * Bottom-edge captions: three slots (left / centre / right), each an optional
 * rice-paper card with a line of text and optional buttons. This is the only
 * 2D text that may appear over the play viewport, and it is used sparingly:
 * the end-of-game "how to start the next game" hints, the tutorial steps and
 * the "whose turn" note after a restored position.
 *
 * Empty slots are not rendered, and when every slot is empty the root is
 * removed from the DOM, so during normal play nothing but the canvas exists.
 */

/**
 * @typedef {object} CaptionContent
 * @property {string} [title]
 * @property {string} text
 * @property {'left'|'right'} [arrow]   points toward the prop being described
 * @property {string} [meta]            small right-aligned note, e.g. "3 / 9"
 * @property {Array<{ id: string, label: string, primary?: boolean }>} [actions]
 *
 * @typedef {'left'|'center'|'right'} Slot
 */

const SLOTS = /** @type {const} */ (['left', 'center', 'right']);

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

export class Hud {
  /**
   * @param {{ parent?: HTMLElement, onAction?: (id: string, slot: Slot) => void }} [options]
   */
  constructor({ parent = document.body, onAction } = {}) {
    this._parent = parent;
    this._onAction = onAction ?? null;
    /** @type {Record<Slot, CaptionContent | null>} */
    this._content = { left: null, center: null, right: null };

    this.root = document.createElement('div');
    this.root.className = 'zt-hud';
    this.root.setAttribute('aria-live', 'polite');
    for (const slot of SLOTS) {
      const el = document.createElement('div');
      el.className = `zt-hud__slot zt-hud__slot--${slot}`;
      el.dataset.slot = slot;
      this.root.appendChild(el);
    }
    this._onClick = this._onClick.bind(this);
    this.root.addEventListener('click', this._onClick);
  }

  /** True while at least one slot is showing. */
  get visible() {
    return SLOTS.some((slot) => this._content[slot] !== null);
  }

  /**
   * Show a caption in a slot (`null` clears it).
   * @param {Slot} slot
   * @param {CaptionContent | null} content
   */
  set(slot, content) {
    if (!SLOTS.includes(slot)) throw new Error(`Hud: unknown slot "${slot}"`);
    this._content[slot] = content;
    const el = /** @type {HTMLElement} */ (this.root.querySelector(`[data-slot="${slot}"]`));
    if (!content) {
      el.innerHTML = '';
      this._sync();
      return;
    }
    const title = content.title ? `<div class="zt-hud__title">${escapeHtml(content.title)}</div>` : '';
    const meta = content.meta ? `<span class="zt-hud__meta">${escapeHtml(content.meta)}</span>` : '';
    const arrow = content.arrow ? `<span class="zt-hud__arrow zt-hud__arrow--${content.arrow}" aria-hidden="true">${content.arrow === 'left' ? '◀' : '▶'}</span>` : '';
    const actions = content.actions?.length
      ? `<div class="zt-hud__actions">${content.actions.map((a) =>
        `<button type="button" class="zt-hud__btn${a.primary ? ' zt-hud__btn--primary' : ''}" data-action="${escapeHtml(a.id)}">${escapeHtml(a.label)}</button>`).join('')}</div>`
      : '';
    el.innerHTML = `
      <div class="zt-hud__card${content.arrow ? ` zt-hud__card--arrow-${content.arrow}` : ''}">
        ${arrow}
        <div class="zt-hud__body">
          ${title}
          <div class="zt-hud__text">${escapeHtml(content.text)}${meta}</div>
          ${actions}
        </div>
      </div>`;
    this._sync();
    // Restart the entrance transition for replaced content.
    const card = el.firstElementChild;
    if (card) {
      card.classList.remove('is-in');
      void /** @type {HTMLElement} */ (card).offsetWidth;
      card.classList.add('is-in');
    }
  }

  /** Clear one slot or all of them. @param {Slot} [slot] */
  clear(slot) {
    if (slot) {
      this.set(slot, null);
      return;
    }
    for (const s of SLOTS) this._content[s] = null;
    for (const el of this.root.querySelectorAll('.zt-hud__slot')) el.innerHTML = '';
    this._sync();
  }

  /** Bottom captions are meaningless while a sheet covers the screen; hide without forgetting the content. */
  setSuppressed(suppressed) {
    this.root.classList.toggle('is-suppressed', Boolean(suppressed));
  }

  dispose() {
    this.root.removeEventListener('click', this._onClick);
    this.root.remove();
  }

  _sync() {
    if (this.visible) {
      if (!this.root.isConnected) this._parent.appendChild(this.root);
    } else {
      this.root.remove();
    }
  }

  /** @param {MouseEvent} event */
  _onClick(event) {
    const button = /** @type {HTMLElement} */ (event.target).closest('button[data-action]');
    if (!button) return;
    const slot = /** @type {HTMLElement} */ (button.closest('[data-slot]'))?.dataset.slot;
    this._onAction?.(button.dataset.action ?? '', /** @type {Slot} */ (slot));
  }
}

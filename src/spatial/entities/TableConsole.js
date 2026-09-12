import * as THREE from 'three';
import { Entity } from './Entity.js';
import { DynamicTexture, CJK_FONT_STACK } from '../../utils/DynamicTexture.js';

const WIDTH = 1536;
const HEIGHT = 256;
const BUTTON_Y = 112;

/** A single atlas on a brass-edged wooden desk plaque, including touch hit targets. */
export class TableConsole extends Entity {
  constructor() {
    super('tableConsole');
    this.group.position.set(0, 0, 6.25);
    this.dyn = new DynamicTexture({ width: WIDTH, height: HEIGHT });
    this.actions = [];
    this._key = '';
    this._hover = null;
    const body = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.22, 1.3),
      new THREE.MeshStandardMaterial({ color: 0x423022, roughness: 0.55 }));
    body.position.y = 0.11;
    body.castShadow = true;
    body.receiveShadow = true;
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(10.25, 1.19),
      new THREE.MeshStandardMaterial({ map: this.dyn.texture, roughness: 0.7 }));
    this.face.rotation.x = -Math.PI / 2;
    this.face.position.y = 0.225;
    this.group.add(body, this.face);
    this.registerInteractive(this.face, 'table_console', { glow: false });
  }

  setState(title, detail, actions) {
    const key = JSON.stringify([title, detail, actions]);
    if (key === this._key) return;
    this._key = key;
    this.title = title;
    this.detail = detail;
    this.actions = actions;
    this._draw();
  }

  actionAt(intersection) {
    const uv = intersection?.uv;
    if (!uv || (1 - uv.y) * HEIGHT < BUTTON_Y) return null;
    const x = uv.x * WIDTH;
    const slot = Math.floor((x - 22) / ((WIDTH - 44) / this.actions.length));
    const action = this.actions[slot];
    return x >= 22 && x < WIDTH - 22 && action?.enabled ? action.id : null;
  }

  setHover(id) {
    if (id === this._hover) return;
    this._hover = id;
    this._draw();
  }

  _draw() {
    const { ctx } = this.dyn;
    ctx.fillStyle = '#29271f';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = '#b39559';
    ctx.lineWidth = 3;
    ctx.strokeRect(8, 8, WIDTH - 16, HEIGHT - 16);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = `48px ${CJK_FONT_STACK}`;
    ctx.fillStyle = '#f5e6bd';
    ctx.fillText(this.title ?? '', 32, 57, 730);
    ctx.textAlign = 'right';
    ctx.font = '24px sans-serif';
    ctx.fillStyle = '#c7b993';
    ctx.fillText(this.detail ?? '', WIDTH - 32, 57, 700);
    const slot = (WIDTH - 44) / this.actions.length;
    this.actions.forEach((action, i) => {
      const x = 22 + i * slot;
      ctx.fillStyle = action.id === this._hover && action.enabled ? '#ddc08b' : '#e8ddc4';
      if (!action.enabled) ctx.fillStyle = '#454338';
      ctx.fillRect(x + 4, BUTTON_Y, slot - 8, 115);
      ctx.textAlign = 'center';
      ctx.fillStyle = action.enabled ? '#332d22' : '#aaa28e';
      ctx.font = `64px ${CJK_FONT_STACK}`;
      ctx.fillText(action.label, x + slot / 2, 168, slot - 22);
    });
    this.dyn.markDirty();
  }

  dispose() {
    this.dyn.dispose();
    super.dispose();
  }
}

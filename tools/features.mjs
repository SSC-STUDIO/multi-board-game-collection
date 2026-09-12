/** Browser acceptance tests for the desk controls, review and saved sessions. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Cdp, ROOT, launchBrowser, sleep, startStaticServer, waitForHttp } from './lib/browser.mjs';

const out = path.join(ROOT, '_tmp_features');
await fs.mkdir(out, { recursive: true });
const server = startStaticServer(8125);
const browser = await launchBrowser({ cdpPort: 9335, width: 1280, height: 900, gpu: true });
const problems = [];
let cdp;
try {
  await waitForHttp('http://127.0.0.1:8125/index.html');
  cdp = await Cdp.connect(9335);
  await cdp.collectProblems(problems);
  await cdp.openApp('http://127.0.0.1:8125/?quality=low&depth=2');
  const step = async (n = 35) => cdp.eval(`(async () => {
    for (let i = 0; i < ${n}; i++) { zenith.world.render(); await new Promise(r => setTimeout(r, 0)); }
  })()`);
  await cdp.eval(`zenith.world.stop(); zenith.world.clock.getDelta = () => 1/30;
    zenith.pendingTutorial = false; zenith.enterTable(zenith.settings); true`);
  await step(55);
  await sleep(750);

  async function clickAction(id, touch = false) {
    const p = await cdp.eval(`(async () => {
      zenith.syncTableConsole();
      const { Vector3 } = await import('three');
      const c = zenith.tableConsole;
      const i = c.actions.findIndex(a => a.id === '${id}' && a.enabled);
      if (i < 0) throw new Error('Action ${id} unavailable');
      c.face.updateWorldMatrix(true, false);
      const v = c.face.localToWorld(new Vector3(((i + .5) / c.actions.length - .5) * 10.25, -.16 * 1.19, 0));
      v.project(zenith.world.camera);
      const rect = zenith.world.canvas.getBoundingClientRect();
      const x = rect.left + (v.x + 1) * rect.width / 2, y = rect.top + (1 - v.y) * rect.height / 2;
      const hit = zenith.interactions.pick({clientX:x, clientY:y});
      return { x, y, width: innerWidth, height: innerHeight, hit: hit?.id, action: c.actionAt(hit?.intersection) };
    })()`);
    assert(p.x > 0 && p.y > 0 && p.x < p.width && p.y < p.height, `${id} outside viewport: ${JSON.stringify(p)}`);
    assert.equal(p.action, id, `${id} hit testing`);
    if (touch) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x:p.x, y:p.y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x:p.x, y:p.y, button:'left', clickCount:1 });
      await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:p.x, y:p.y, button:'left', clickCount:1 });
    }
    await step();
  }

  await clickAction('black');
  assert.equal(await cdp.eval('zenith.engine.status'), 'PLAYING');
  await clickAction('view');
  assert.equal(await cdp.eval('zenith.director.current'), 'BOARD_STUDY');
  await cdp.eval(`zenith.engine.makeMove(7,7,Date.now()); zenith.cancelAi();
    zenith.engine.makeMove(7,8,Date.now()); zenith.cancelAi(); true`);
  await step(70);
  await clickAction('review');
  assert.equal(await cdp.eval('zenith.engine.status'), 'PAUSED');
  const clock = await cdp.eval('zenith.engine.getState().clock.black');
  await clickAction('first');
  assert.equal(await cdp.eval('[...zenith.board.stones.values()].filter(s=>s.ghost).length'), 2);
  assert.equal(await cdp.eval('zenith.engine.getState().clock.black'), clock);
  await clickAction('next');
  assert.equal(await cdp.eval('zenith.review.index'), 1);
  await cdp.screenshot(path.join(out, 'review-desktop.png'));
  await clickAction('exitReview');
  assert.equal(await cdp.eval('zenith.engine.status'), 'PLAYING');
  assert.equal(await cdp.eval('[...zenith.board.stones.values()].filter(s=>s.ghost).length'), 0);

  // Reset midway through a queued pen animation and page flip: old work must stay cancelled.
  await cdp.eval(`zenith.ledger.writeMove(28,'H8',1); zenith.ledger.writeMove(29,'I8',2); true`);
  await step(3);
  await cdp.eval('zenith.ledger.setMoves([]); true');
  await step(70);
  assert.deepEqual(await cdp.eval('({length:zenith.ledger._moves.length,page:zenith.ledger.page,pen:zenith.ledger.penInHand})'),
    { length:0, page:0, pen:false });
  await cdp.eval('zenith.ledger.setMoves(zenith.engine.moves); true');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled:true });
  await cdp.eval('zenith.world.resize(); zenith.director.snapTo("MAIN_PLAY"); true');
  await step();
  await cdp.screenshot(path.join(out, 'play-phone.png'));
  await clickAction('menu', true);
  assert.equal(await cdp.eval('zenith.menuOpen'), true);
  await cdp.screenshot(path.join(out, 'menu-phone.png'));
  await cdp.eval('zenith.closeMenu(zenith.settings); true');
  await sleep(750);
  await step();
  assert.equal(await cdp.eval('document.body.children.length'), 1);
  // Reload the actual page and continue through the title button, including preserved clocks.
  await cdp.eval('zenith.openMenu(); zenith.persistSession(true); true');
  const saved = await cdp.eval('JSON.parse(localStorage.getItem("zenith.session.v1"))');
  await cdp.send('Page.reload');
  await sleep(1500);
  for (let i = 0; i < 80 && !await cdp.eval('!!globalThis.zenith'); i++) await sleep(250);
  assert(await cdp.eval('!!document.querySelector("[data-action=continue-saved]")'));
  await cdp.eval(`zenith.world.stop(); zenith.world.clock.getDelta = () => 1/30;
    document.querySelector('[data-action=continue-saved]').click(); true`);
  await step(55);
  await sleep(750);
  const continued = await cdp.eval(`({ status:zenith.engine.status, moves:zenith.engine.moves.length,
    human:zenith.engine.getState().humanColor, white:zenith.engine.getState().clock.white,
    black:zenith.engine.getState().clock.black, dom:document.body.children.length })`);
  assert.equal(continued.status, 'PLAYING');
  assert.equal(continued.moves, saved.game.moves.length);
  assert.equal(continued.human, saved.game.humanColor);
  assert.equal(continued.white, saved.game.clock.white);
  assert(continued.black <= saved.game.clock.black && continued.black > saved.game.clock.black - 5000);
  assert.equal(continued.dom, 1);
  assert.deepEqual(problems, []);
  console.log('✓ desk mouse/touch controls, frozen review clock, ghost cleanup, cancelled ledger work, phone menu, reload and resume');
} finally {
  cdp?.close();
  await browser.close();
  server.kill();
}

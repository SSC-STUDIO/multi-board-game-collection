#!/usr/bin/env node
/**
 * Headless-browser smoke test (`npm run smoke`).
 *
 * Boots the static server, drives a headless Chrome/Edge through the whole
 * diegetic flow (start screen → first-visit tutorial → colour selection →
 * moves → free-look → Esc menu → pause → undo → coach → ledger → victory
 * ceremony → end-of-game hints → rematch → picture import → continued game)
 * via the DevTools protocol, collects every runtime exception / console error
 * and drops screenshots into `_tmp_smoke/`. Exits non-zero when the page
 * throws, the render loop stalls or anything but the canvas is in <body>
 * while a game is being played.
 *
 * Uses the local GPU, or SwiftShader on CI. The harness steps a fixed scene dt;
 * software rendering draws every eighth frame plus all assertion checkpoints.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Cdp, ROOT, launchBrowser, sleep, startStaticServer, waitForHttp } from './lib/browser.mjs';

const OUT_DIR = path.join(ROOT, '_tmp_smoke');
const SERVER_PORT = 8123;
const CDP_PORT = 9333;
const WIDTH = 1120;
const HEIGHT = 630;
/** Scene-time step per rendered frame once the harness takes over the loop. */
const FRAME_DT = 1 / 30;

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const server = startStaticServer(SERVER_PORT);
  const browser = await launchBrowser({ cdpPort: CDP_PORT, width: WIDTH, height: HEIGHT, gpu: !process.env.CI });

  const problems = [];
  try {
    const cdp = await Cdp.connect(CDP_PORT);
    await cdp.collectProblems(problems);
    await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/index.html`).catch(() => null);
    console.log('▶ loading page');
    await cdp.openApp(`http://127.0.0.1:${SERVER_PORT}/?quality=low`);

    // Let the real loop prove it runs (first frame compiles every shader, which
    // takes seconds on software GL), then take it over: wall-clock waits are
    // useless at ~1 fps, so frames are stepped with a fixed scene dt instead.
    const frame0 = await cdp.eval('zenith.world.frame');
    const liveDeadline = Date.now() + 15_000;
    let liveFrames = 0;
    while (Date.now() < liveDeadline && liveFrames < 2) {
      await sleep(500);
      liveFrames = (await cdp.eval('zenith.world.frame')) - frame0;
    }
    console.log(`▶ app booted (${liveFrames} live frames)`);
    console.log(`▶ ${await cdp.eval(`(() => {
      const per = [];
      let total = 0;
      for (const child of zenith.world.scene.children) {
        let n = 0;
        child.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints || o.isLine || o.isSprite)) n += Array.isArray(o.material) ? o.material.length : 1; });
        if (n) per.push(child.name + ':' + n);
        total += n;
      }
      return 'visible drawables per pass ≈ ' + total + '  [' + per.join(' ') + ']';
    })()`)}`);

    // Each stepped frame yields to the event loop (like a real rAF tick) so that
    // timers and promise continuations chained between tweens keep flowing.
    await cdp.installFrameStepper({ dt: FRAME_DT });
    const step = (frames) => cdp.step(frames);
    const shot = (name) => cdp.screenshot(path.join(OUT_DIR, name));

    await step(20);
    await shot('00-title.png');

    console.log('▶ start screen → 入座对弈');
    const startVisible = await cdp.eval('!!document.querySelector(".zt-start.is-visible [data-action=start]")');
    if (!startVisible) problems.push('start screen not visible after boot');
    await cdp.eval('document.querySelector(".zt-start [data-action=start]").click(); true');
    await sleep(900); // CSS fade-out + DOM removal are wall-clock
    await step(50); // intro flight (1.4 s scene time)
    if (await cdp.eval('!!document.querySelector(".zt-start")')) problems.push('start screen still in the DOM after entering the table');

    console.log('▶ first visit: guided tour starts by itself');
    const tour = await cdp.eval('JSON.stringify({ active: zenith.tutorial.active, caption: !!document.querySelector(".zt-hud__slot--center .zt-hud__card"), input: zenith.interactions.enabled })');
    console.log(`  tour → ${tour}`);
    if (!JSON.parse(tour).active || !JSON.parse(tour).caption || JSON.parse(tour).input) problems.push(`tutorial did not start on the first visit: ${tour}`);
    await step(10);
    await shot('01a-tutorial-welcome.png');
    for (let i = 0; i < 4; i++) await cdp.eval('document.querySelector(".zt-hud [data-action=\'tutorial:next\']").click(); true');
    await step(35); // flight to the clock close-up
    if ((await cdp.eval('zenith.tutorial.index')) !== 4 || (await cdp.eval('zenith.director.current')) !== 'CLOCK_FOCUS') problems.push('tutorial did not advance to the clock step');
    if (!(await cdp.eval('zenith.spotlight.active'))) problems.push('tutorial spotlight not applied');
    await shot('01b-tutorial-clock.png');
    await cdp.eval('document.querySelector(".zt-hud [data-action=\'tutorial:skip\']").click(); true');
    await step(25);
    const afterTour = await cdp.eval('JSON.stringify({ active: zenith.tutorial.active, hud: !!document.querySelector(".zt-hud"), input: zenith.interactions.enabled, spot: zenith.spotlight.active, camera: zenith.director.current, done: localStorage.getItem("zenith.tutorial.v1") })');
    console.log(`  after skip → ${afterTour}`);
    const at = JSON.parse(afterTour);
    if (at.active || at.hud || !at.input || at.spot || at.camera !== 'MAIN_PLAY' || at.done !== 'done') problems.push(`tutorial did not clean up: ${afterTour}`);
    if (!(await cdp.eval('zenith.seated && zenith.interactions.enabled'))) problems.push('table input not enabled after the tour');
    await shot('01-selection.png');

    console.log('▶ select black');
    await cdp.eval('zenith.engine.selectColor(1, Date.now()).error');
    await step(40);
    await shot('02-selected.png');

    console.log('▶ play a few moves (AI replies on a wall-clock timer)');
    const humanMove = `(() => {
      if (!zenith.engine.isHumanTurn()) return 'ai-turn';
      const s = zenith.engine.getState();
      for (let c = 6; c < 15; c++) for (let r = 5; r < 10; r++) if (s.board[r][c] === 0) { zenith.engine.makeMove(r, c, Date.now()); return r + ',' + c; }
      return 'full';
    })()`;
    const figures = await cdp.eval('JSON.stringify({ opponent: zenith.opponent.group.children.length, player: zenith.player.group.children.length, tray: zenith.tray.color })');
    console.log(`  figures → ${figures}`);
    if (!JSON.parse(figures).opponent || !JSON.parse(figures).player || JSON.parse(figures).tray !== 2) problems.push(`figures / tray not set up: ${figures}`);
    for (let i = 0; i < 4; i++) {
      console.log(`  move → ${await cdp.eval(humanMove)}`);
      if (i === 0) {
        // The player's hand is carrying the stone and the opponent's hand drifts to its dish.
        await step(9);
        const carry = await cdp.eval('JSON.stringify({ carrying: zenith.carrying.size, thinking: zenith.opponentThinking, placed: zenith.board.stones.size })');
        console.log(`  carry → ${carry}`);
        if (JSON.parse(carry).carrying !== 1 || !JSON.parse(carry).thinking) problems.push(`hand carry did not start: ${carry}`);
        await shot('02b-hand-carry.png');
      }
      await step(15);
      await sleep(1700);
      await step(15);
    }
    await step(60); // let the last gestures finish
    const settled = await cdp.eval('JSON.stringify({ carrying: zenith.carrying.size, placed: zenith.board.stones.size, moves: zenith.engine.moves.length })');
    console.log(`  settled → ${settled}`);
    if (JSON.parse(settled).carrying !== 0 || JSON.parse(settled).placed !== JSON.parse(settled).moves) problems.push(`stones did not all land: ${settled}`);
    await shot('03-midgame.png');

    console.log('▶ free-look: drag-orbit + zoom, then click-to-recenter');
    await cdp.eval('zenith.director.orbitBy(0.7, 0.18); zenith.director.zoomBy(0.8); true');
    await step(40);
    await shot('03b-freelook.png');
    if (!(await cdp.eval('zenith.director.hasUserOrbit'))) problems.push('user orbit offset was not applied');
    await cdp.eval('zenith.escape()');
    await step(35);
    if (await cdp.eval('zenith.director.hasUserOrbit')) problems.push('escape() did not clear the user orbit');

    console.log('▶ Esc menu: pause without moving the camera, resume');
    await cdp.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true');
    await step(5);
    const menu = await cdp.eval('JSON.stringify({ visible: !!document.querySelector(".zt-start.is-menu.is-visible"), status: zenith.engine.status, camera: zenith.director.current })');
    console.log(`  menu → ${menu}`);
    if (!JSON.parse(menu).visible || JSON.parse(menu).status !== 'PAUSED' || JSON.parse(menu).camera !== 'MAIN_PLAY') problems.push(`Esc menu misbehaved: ${menu}`);
    await shot('03c-menu.png');
    await cdp.eval('document.querySelector(".zt-start [data-action=resume]").click(); true');
    await sleep(900);
    await step(10);
    if (await cdp.eval('!!document.querySelector(".zt-start")')) problems.push('menu still in the DOM after resume');
    if ((await cdp.eval('zenith.engine.status')) !== 'PLAYING') problems.push('game did not resume after closing the menu');

    console.log('▶ pause via clock plunger');
    await cdp.eval('zenith.engine.togglePause(Date.now()).error');
    await step(30);
    await shot('04-paused.png');
    await cdp.eval('zenith.engine.togglePause(Date.now()).error');
    await step(20);
    await sleep(1700);
    await step(15);

    console.log('▶ undo via sandglass');
    await cdp.eval('zenith.onSandglassClick()');
    await sleep(300);
    await step(10);
    await shot('05-undo-flight.png');
    await step(30);
    await sleep(400);
    await step(5);

    console.log('▶ coach via manual');
    await cdp.eval('zenith.onManualClick()');
    await sleep(700);
    await step(60);
    await shot('06-manual-title.png');
    await step(75);
    await shot('07-manual-comment.png');
    console.log(`  manual → ${await cdp.eval(`JSON.stringify({
      humanTurn: zenith.engine.isHumanTurn(), status: zenith.engine.status, moves: zenith.engine.moves.length,
      undoBusy: zenith.undoBusy, ceremonyBusy: zenith.ceremonyBusy, hintRequest: zenith.hintRequest,
      manualBusy: zenith.manual.busy, title: zenith.manual._advice?.title ?? null, phase: zenith.manual._phase,
      brush: zenith.manual._brushMode, hint: zenith.board.hintDisc.visible, camera: zenith.director.current,
    })`)}`);
    await cdp.eval('zenith.escape()');
    await step(20);

    console.log('▶ ledger review');
    await cdp.eval("zenith.focus('LEDGER_REVIEW', 'study')");
    await step(25);
    await shot('08-ledger.png');
    await cdp.eval('zenith.escape()');
    await step(20);

    console.log('▶ scripted five-in-a-row → victory ceremony');
    await cdp.eval(`(() => {
      const e = zenith.engine;
      e.reset();
      e.selectColor(1, Date.now());
      const seq = [[3,3],[12,3],[3,4],[12,4],[3,5],[12,5],[3,6],[12,6],[3,7]];
      for (const [r, c] of seq) { const res = e.makeMove(r, c, Date.now()); if (res.error) return res.error; }
      return e.getState().status;
    })()`).then((s) => console.log(`  status → ${s}`));
    await sleep(450);
    await step(42);
    await shot('09-victory-slam.png');
    await step(30);
    await shot('10-victory-rebound.png');
    await step(40);
    await shot('11-victory-seal.png');

    console.log('▶ end-of-game hints at the bottom corners');
    await step(20);
    const hints = await cdp.eval(`JSON.stringify({
      status: zenith.engine.status, busy: zenith.ceremonyBusy,
      left: document.querySelector(".zt-hud__slot--left .zt-hud__card")?.textContent.trim() ?? null,
      right: document.querySelector(".zt-hud__slot--right .zt-hud__card")?.textContent.trim() ?? null,
      center: document.querySelector(".zt-hud__slot--center .zt-hud__title")?.textContent.trim() ?? null,
      rematch: !!document.querySelector(".zt-hud [data-action=rematch]"),
      stats: localStorage.getItem("zenith.stats.v1"),
    })`);
    console.log(`  hints → ${hints}`);
    const h = JSON.parse(hints);
    if (h.status !== 'FINISHED' || h.busy || !h.left?.includes('黑') || !h.right?.includes('白') || !h.center?.includes('大捷') || !h.rematch) problems.push(`end-of-game hints missing: ${hints}`);
    if (!h.stats || JSON.parse(h.stats).wins < 1) problems.push(`win was not recorded in stats: ${h.stats}`);
    await shot('12-endgame-hints.png');

    console.log('▶ 同执黑再来一局 (rematch button)');
    await cdp.eval('document.querySelector(".zt-hud [data-action=rematch]").click(); true');
    await step(30);
    const rematch = await cdp.eval('JSON.stringify({ status: zenith.engine.status, human: zenith.engine.getState().humanColor, moves: zenith.engine.moves.length, hud: !!document.querySelector(".zt-hud") })');
    console.log(`  rematch → ${rematch}`);
    if (JSON.parse(rematch).status !== 'PLAYING' || JSON.parse(rematch).human !== 1 || JSON.parse(rematch).moves !== 0 || JSON.parse(rematch).hud) problems.push(`rematch misbehaved: ${rematch}`);

    console.log('▶ Esc menu → 复原棋局: recognise a rendered board picture and continue it in 3D');
    await cdp.eval('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true');
    await step(5);
    await cdp.eval('document.querySelector(".zt-start [data-action=import]").click(); true');
    await step(5);
    if (!(await cdp.eval('!!document.querySelector(".zt-start.is-import.is-visible .zt-import")'))) problems.push('import panel did not open from the menu');
    const stones = [[7, 7, 1], [7, 8, 2], [8, 7, 1], [6, 8, 2], [8, 8, 1], [9, 9, 2], [6, 6, 1], [5, 5, 2], [8, 6, 1], [9, 6, 2], [0, 0, 1], [14, 14, 2]];
    const recognised = await cdp.eval(`(async () => {
      const size = 620, cell = 36, ox = 58, oy = 58;
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      const g = c.getContext('2d');
      g.fillStyle = '#2a1e14'; g.fillRect(0, 0, size, size);
      g.fillStyle = '#ddb370'; g.fillRect(ox - 24, oy - 24, 14 * cell + 48, 14 * cell + 48);
      g.strokeStyle = '#3a2410'; g.lineWidth = 2;
      for (let i = 0; i < 15; i++) {
        g.beginPath(); g.moveTo(ox + i * cell, oy); g.lineTo(ox + i * cell, oy + 14 * cell); g.stroke();
        g.beginPath(); g.moveTo(ox, oy + i * cell); g.lineTo(ox + 14 * cell, oy + i * cell); g.stroke();
      }
      for (const [r, col, p] of ${JSON.stringify(stones)}) {
        g.beginPath(); g.arc(ox + col * cell, oy + r * cell, cell * 0.45, 0, Math.PI * 2);
        g.fillStyle = p === 1 ? '#151515' : '#f2eee4'; g.fill();
      }
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
      await zenith.importer.loadFile(blob);
      const b = zenith.importer._board;
      const got = [];
      for (let r = 0; r < 15; r++) for (let col = 0; col < 15; col++) if (b[r][col]) got.push([r, col, b[r][col]]);
      return JSON.stringify({ got, ok: zenith.importer._evaluation?.ok, turn: zenith.importer._evaluation?.currentPlayer, grid: zenith.importer._gridReliable, confirm: !document.querySelector('.zt-import [data-act=confirm]').disabled });
    })()`);
    console.log(`  recognised → ${recognised}`);
    const rec = JSON.parse(recognised);
    const sortCells = (arr) => arr.map((c) => c.join(':')).sort().join(' ');
    if (sortCells(rec.got) !== sortCells(stones)) problems.push(`image recognition mismatch: expected ${sortCells(stones)} got ${sortCells(rec.got)}`);
    if (!rec.ok || rec.turn !== 1 || !rec.grid || !rec.confirm) problems.push(`import verdict wrong: ${recognised}`);
    await shot('13-import-panel.png');

    await cdp.eval('document.querySelector(".zt-import [data-act=confirm]").click(); true');
    await sleep(900);
    await step(40);
    const restored = await cdp.eval(`JSON.stringify({
      status: zenith.engine.status, stones: zenith.board.stones.size, sheet: !!document.querySelector('.zt-start'),
      caption: document.querySelector('.zt-hud__slot--center .zt-hud__title')?.textContent ?? null, input: zenith.interactions.enabled, camera: zenith.director.current,
    })`);
    console.log(`  restored → ${restored}`);
    const rs = JSON.parse(restored);
    if (rs.status !== 'SELECTING' || rs.stones !== stones.length || rs.sheet || !rs.caption?.includes('轮到黑方') || !rs.input || rs.camera !== 'MAIN_PLAY') problems.push(`restored position not on the table: ${restored}`);
    await shot('14-restored.png');

    console.log('▶ take white: the AI (black) plays on from the restored position');
    await cdp.eval('zenith.engine.selectColor(2, Date.now()).error');
    await step(15);
    await sleep(1700);
    await step(15);
    await shot('15a-opponent-carry.png'); // the opponent's hand on its way from the dish to the board
    await step(60); // let the carry finish and the stone drop
    const continued = await cdp.eval('JSON.stringify({ status: zenith.engine.status, moves: zenith.engine.moves.length, stones: zenith.board.stones.size, hud: !!document.querySelector(".zt-hud"), turn: zenith.engine.currentPlayer })');
    console.log(`  continued → ${continued}`);
    const ct = JSON.parse(continued);
    if (ct.status !== 'PLAYING' || ct.moves < 1 || ct.stones !== stones.length + ct.moves || ct.hud) problems.push(`AI did not continue the restored game: ${continued}`);
    await shot('15-restored-play.png');

    const frame1 = await cdp.eval('zenith.world.frame');
    const info = await cdp.eval('JSON.stringify(zenith.world.renderer.info.render)');
    const dom = await cdp.eval('document.body.children.length + ":" + Array.from(document.body.children).map(e => e.tagName).join(",")');
    console.log(`▶ simulation frames: ${frame1 - frame0}, last rendered checkpoint ${info}`);
    console.log(`▶ DOM under <body> during play: ${dom}`);
    if (liveFrames < 2) problems.push('render loop never produced a frame on its own');
    if (!/^1:CANVAS$/.test(dom)) problems.push(`zero-2D violated during play: ${dom}`);

    cdp.close();
  } catch (err) {
    problems.push(`harness: ${err.message}`);
  } finally {
    await browser.close();
    server.kill();
  }

  if (problems.length) {
    console.log(`\n✗ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('\n✓ smoke test passed');
}

main();

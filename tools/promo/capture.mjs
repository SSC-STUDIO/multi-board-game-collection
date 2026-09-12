import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cdp, ROOT, launchBrowser, sleep, startStaticServer } from '../lib/browser.mjs';
import { GameEngine } from '../../src/core/state/GameEngine.js';
import { findBestMove } from '../../src/core/ai/Search.js';
import { toRecord } from '../../src/core/state/Record.js';

const out = path.join(ROOT, 'artifacts/video');
const probe = process.argv.includes('--preview');
await fs.mkdir(out, { recursive: true });
const engine = new GameEngine({ mode: 'STANDARD', initialMs: 600000 });
engine.selectColor(1, 0);
while (engine.status === 'PLAYING' && engine.moves.length < 60) {
  const state = engine.getState();
  const best = findBestMove(state, { depth: state.currentPlayer === 1 ? 3 : 2, timeLimitMs: 800, randomize: false });
  assert(best, 'a move must exist');
  assert(!engine.makeMove(best.row, best.col, engine.moves.length * 4000).error);
}
assert.equal(engine.status, 'FINISHED');
assert.equal(engine.getState().winner, 1);
const expected = engine.moves.map(({ row, col, player, notation }) => ({ row, col, player, notation }));
assert.equal(expected.length, 21, 'the advertised complete game has 21 moves');
console.log(`Prepared a legal ${expected.length}-move game, ending in black five-in-a-row.`);
const server = startStaticServer(8140);
const browser = await launchBrowser({ cdpPort: 9341, width: 1080, height: 1920, gpu: true });
const problems = [];
let cdp;
try {
  cdp = await Cdp.connect(9341);
  await cdp.collectProblems(problems);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await cdp.openApp('http://127.0.0.1:8140/?quality=high&depth=2', 60000);
  await cdp.eval(`zenith.pendingTutorial=false;
    zenith.enterTable({...zenith.settings,quality:'high',aiDepth:2,timeMinutes:10,sound:true}); true`);
  for (let i = 0; i < 100 && !await cdp.eval('zenith.seated && !!zenith.player.avatar && !!zenith.opponent.avatar'); i++) await sleep(200);
  assert(await cdp.eval('zenith.seated && !!zenith.player.avatar && !!zenith.opponent.avatar'));
  await cdp.eval(`(async()=>{
    zenith.world.adaptiveResolution=false;zenith.world.setResolutionScale(1);zenith.world.idleFpsCap=0;
    zenith.world.setPostFX({samples:0,bloom:true,smaa:true,vignette:.2});
    zenith.lighting.setShadowMapSize(1024);
    // Deterministic tie-breaking for a repeatable film; the white moves still run through the real AI Worker.
    const find=zenith.ai.findBestMove.bind(zenith.ai);
    zenith.ai.findBestMove=(state,options)=>find(state,{...options,randomize:false});
    zenith.director.viewpoints={...zenith.director.viewpoints,
      BOARD_STUDY:{position:[0,20,17],target:[0,3,-3],fov:48},
      PROMO_ROOM:{position:[21,13,18],target:[0,3,-3],fov:42},
      PROMO_FACE:{position:[7,10,-3],target:[0,8,-16],fov:35},
      PROMO_SAND:{position:[-9,6,10],target:[-7.4,1.0,4.6],fov:34},
      PROMO_END:{position:[-16,15,21],target:[0,1,0],fov:45}};
    const {installPromo}=await import('/tools/promo/overlay.js');
    globalThis.promo=await installPromo(zenith);
    globalThis.filmEvents=[];
    zenith.engine.on('*',(payload,event,state)=>{
      if(['onMoveCommitted','onStateReverted','onGameFinished','onPauseToggled'].includes(event.type))
        filmEvents.push({time:(performance.now()-promo.state.start)/1000,type:event.type,moves:state.moves.length,payload});
    });
    zenith.director.snapTo('PROMO_ROOM');return true;
  })()`);
  await sleep(1800);
  await cdp.eval('promo.start()');
  const cue = async (title, subtitle = '', caption = '', type = '') => {
    console.log(`Scene: ${title || type}`);
    await cdp.eval(`promo.cue(${[title, subtitle, caption, type].map(v => JSON.stringify(v)).join(',')});true`);
  };
  const view = async (name, duration = 1400) => cdp.eval(`zenith.director.goTo(${JSON.stringify(name)},{duration:${duration}});true`);
  const still = async name => fs.writeFile(path.join(out, name), Buffer.from(await cdp.eval('promo.still()'), 'base64'));
  await cue('', '', '一间棋室，一位对手，一局完整的交锋。', 'intro');
  await cdp.eval('zenith.director.orbitBy(-.16,.025);true');
  await sleep(6000); await still('cover.png');
  if (!probe) {
    await view('PROMO_FACE');
    await cue('棋逢对手', '立体棋手 · 空间音效', '取子、落子、沉思，每个动作都在场。');
    await sleep(5000);
    await view('MAIN_PLAY');
    await cue('执黑，开局', '一局完整的五子棋实战', '从空棋盘开始，直到分出胜负。');
    await sleep(3000);
    // Real touch selection on the in-world desk plaque.
    const point = await cdp.eval(`(async()=>{
      const {Vector3}=await import('three');zenith.syncTableConsole();
      const c=zenith.tableConsole,i=c.actions.findIndex(a=>a.id==='black');c.face.updateWorldMatrix(true,false);
      const p=c.face.localToWorld(new Vector3(((i+.5)/c.actions.length-.5)*10.25,-.16*1.19,0));p.project(zenith.world.camera);
      return{x:(p.x+1)*540,y:(1-p.y)*960};})()`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await cdp.eval('zenith.engine.status'), 'PLAYING', 'the filmed touch selected black');
    await sleep(1800);
    let undoShown = false, hintShown = false, clockShown = false;
    while (await cdp.eval('zenith.engine.status') !== 'FINISHED') {
      const n = await cdp.eval('zenith.engine.moves.length');
      assert.equal(n % 2, 0, 'ready for a black move');
      const next = expected[n];
      assert(next);
      if (n === 8 && !clockShown) {
        clockShown = true;
        await cue('掌握自己的节奏', '机械棋钟 · 暂停与恢复', '暂停计时，想清楚，再出手。');
        await view('CLOCK_FOCUS'); await sleep(1700);
        await cdp.eval('zenith.onPlungerClick();true');
        assert.equal(await cdp.eval('zenith.engine.status'), 'PAUSED');
        await sleep(3200); await still('clock.png');
        await cdp.eval('zenith.onPlungerClick();true');
        await view('MAIN_PLAY'); await sleep(1800);
      }
      if (n === 8 && !undoShown) {
        undoShown = true;
        await cue('落子，也能回头', '翻转沙漏 · 悔棋', '收回一轮落子，重新选择。');
        await view('PROMO_SAND'); await sleep(1700);
        await cdp.eval('zenith.onSandglassClick();true');
        await sleep(3300);
        assert.equal(await cdp.eval('zenith.engine.moves.length'), 6);
        await view('MAIN_PLAY'); await sleep(1700);
        continue;
      }
      if (n === 12 && !hintShown) {
        hintShown = true;
        await cue('进退之间，有迹可循', '古籍提示 · 毛笔写意', '本地战术分析，把思路写在纸上。');
        await cdp.eval('zenith.onManualClick();true');
        await sleep(6500); await still('advice.png');
        assert(await cdp.eval('zenith.board.hintDisc.visible && !!zenith.manual._advice?.title'), 'tactical advice was actually written');
        await view('MAIN_PLAY'); await sleep(1800);
      }
      if (n === 16) {
        await cdp.eval(`zenith.director.viewpoints.BOARD_STUDY={position:[0,19,8],target:[0,0,.8],fov:52};true`);
        await view('BOARD_STUDY');
        await cue('局势，渐入关键', '俯览棋盘 · 每一手都看得清', '进攻与防守，在黑白之间展开。');
        await sleep(1800);
      } else if (n === 0) await cue('一子落定，交锋开始', '黑方先行 · 白方由游戏内 AI 应手', '棋子落下的声音，也是思考的回声。');
      else if (n === 4) await cue('有来有回，步步为营', '完整对局 · 不跳过着法', '棋手从棋罐取子，再把棋子送上棋盘。');
      else if (n === 8) await cue('重新落子，继续交锋', '悔棋后的实战继续', '每一次选择，都留在棋谱里。');
      else if (n === 12) await cue('看清思路，再落一子', '提示之后 · 对局继续', '这一局，仍由你的选择决定。');
      else if (n === 20) await cue('胜负，就在这一手', '完整实战 · 收官', '最后一子，连成五颗。');
      const click = await cdp.eval(`(()=>{
        const p=zenith.board.getStoneWorldPosition(${next.row},${next.col});p.y-=.085;p.project(zenith.world.camera);
        return{x:(p.x+1)*540,y:(1-p.y)*960};})()`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [click] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      for (let i = 0; i < 75 && await cdp.eval(`zenith.engine.moves.length < ${Math.min(n + 2, expected.length)} || zenith.carrying.size > 0`); i++) await sleep(100);
      const moves = await cdp.eval('zenith.engine.moves.map(({row,col,player,notation})=>({row,col,player,notation}))');
      assert.deepEqual(moves, expected.slice(0, moves.length), 'the actual AI response matches the legal filmed game');
      assert(moves.length > n, 'the filmed touch placed a stone');
      console.log(`Game: ${moves.length}/${expected.length} moves, last ${moves.at(-1).notation}`);
      await sleep(n >= 18 ? 2700 : 2200);
      if (n === 10) await still('midgame.png');
    }
    assert.equal(await cdp.eval('zenith.engine.getState().winner'), 1);
    for (let i = 0; i < 100 && await cdp.eval('zenith.ceremonyBusy'); i++) await sleep(100);
    await cue('五子连珠，一印落定', '黑方胜 · 21 手完整对局', '胜负有结果，落幕也有仪式。');
    await sleep(4500); await still('victory.png');
    await cue('每一步，都值得回看', '逐手复盘 · 留住这局交锋', '从开局到收官，随时回到关键一手。');
    await cdp.eval('zenith.beginReview();true'); await sleep(1800);
    for (const index of [0, 4, 8, 12, 16, 20, 21]) {
      await cdp.eval(`zenith.showReviewMove(${index});true`); await sleep(850);
    }
    await still('review.png');
    await cdp.eval('zenith.endReview();true'); await sleep(1700);
    await view('PROMO_END');
    await cue('', '', '入座，再来一局。', 'outro');
    await sleep(7000);
  }
  const metadata = await cdp.eval('promo.stop()');
  metadata.events = await cdp.eval('filmEvents');
  metadata.record = toRecord(await cdp.eval('zenith.engine.getState()'));
  metadata.gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  metadata.format = '1080x1920, 9:16, Chinese captions, original synthesized music and in-game audio';
  metadata.gameplay = 'All moves shown in order. Black touches follow a locally searched legal record; white uses the unmodified search in the game AI Worker with deterministic tie-breaking. One pair of moves is visibly undone and replayed.';
  assert.deepEqual(problems, []);
  const extension = metadata.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  metadata.sourceFile = `${probe ? 'preview' : 'zenith-mobile-master'}.${extension}`;
  const handle = await fs.open(path.join(out, metadata.sourceFile), 'w');
  try {
    for (let offset = 0; offset < metadata.bytes; offset += 2_000_000) {
      await handle.write(Buffer.from(await cdp.eval(`promo.chunk(${offset},2000000)`), 'base64'));
    }
  } finally { await handle.close(); }
  await fs.writeFile(path.join(out, 'capture.json'), JSON.stringify(metadata, null, 2));
  await fs.writeFile(path.join(out, 'complete-game.json'), JSON.stringify(metadata.record, null, 2));
  console.log(`Captured ${metadata.seconds.toFixed(1)} seconds, ${(metadata.bytes / 1048576).toFixed(1)} MB.`);
} finally {
  cdp?.close(); await browser.close(); server.kill();
}

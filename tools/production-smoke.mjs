/** Serve only the built site under a repository subpath; root asset URLs must fail. */
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Cdp, ROOT, launchBrowser, sleep } from './lib/browser.mjs';

const prefix = '/Zenith-Tabletop-3D/';
const dist = path.join(ROOT, 'dist');
const out = path.join(ROOT, '_tmp_production');
await fs.mkdir(out, {recursive:true});
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.gltf':'model/gltf+json', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.png':'image/png', '.ttf':'font/ttf' };
const missing = [];
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith(prefix)) throw Error('outside mount');
    const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    const file = path.resolve(dist,relative);
    if (!file.startsWith(dist + path.sep)) throw Error('outside dist');
    res.setHeader('Content-Type',mime[path.extname(file)] ?? 'application/octet-stream');
    res.end(await fs.readFile(file));
  } catch {
    if (url.pathname !== '/favicon.ico') missing.push(url.pathname);
    res.writeHead(404); res.end();
  }
});
await new Promise(resolve => server.listen(8126,'127.0.0.1',resolve));
const browser = await launchBrowser({cdpPort:9336,width:1280,height:900,gpu:!process.env.CI});
const problems = [];
let cdp;
try {
  cdp = await Cdp.connect(9336);
  await cdp.collectProblems(problems);
  await cdp.openApp(`http://127.0.0.1:8126${prefix}?quality=low&depth=2`, 60_000);
  // UI and AI run in the real render loop; the browser receives only the production bundle.
  await cdp.eval('zenith.pendingTutorial=false; zenith.enterTable(zenith.settings)');
  await cdp.eval('zenith.onBowlClick(2); true');
  for (let i=0;i<100 && await cdp.eval('zenith.engine.moves.length < 1 || zenith.carrying.size > 0');i++) await sleep(250);
  for (let i=0;i<80 && !await cdp.eval('!!zenith.player.avatar && !!zenith.opponent.avatar');i++) await sleep(250);
  const result = await cdp.eval(`({ title:document.title, moves:zenith.engine.moves.length,
    worker:zenith.ai.offThread, model:!!zenith.world.scene.getObjectByName('chinese_armchair'),
    avatars:!!zenith.player.avatar && !!zenith.opponent.avatar,
    fonts:!!zenith.assets.fonts.kai, dom:document.body.children.length, stones:zenith.board.stones.size })`);
  assert.equal(result.moves,1);
  assert.equal(result.stones,1);
  assert.equal(result.worker,true);
  assert.equal(result.model,true);
  assert.equal(result.avatars,true);
  assert.equal(result.fonts,true);
  assert.equal(result.dom,1);
  assert.match(result.title,/Zenith Tabletop 3D/);
  await cdp.screenshot(path.join(out,'tabletop.png'));
  assert.deepEqual(missing,[]);
  assert.deepEqual(problems,[]);
  console.log('✓ production subpath: models, textures, fonts, AI worker and playable board; no missing requests');
} finally {
  cdp?.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

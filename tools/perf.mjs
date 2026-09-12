#!/usr/bin/env node
/**
 * GPU performance probe (`npm run perf`).
 *
 * Opens the app in headless Chrome *with the real GPU*, sits down at the
 * table, then measures frames-per-second of the live render loop while
 * toggling the usual suspects one at a time (shadows, transmission, pixel
 * ratio, point lights, dynamic textures, render scale 0.8 / 0.6 and the
 * adaptive scaler left to settle). Also dumps high-quality reference
 * screenshots of the main viewpoints into `_tmp_perf/` for visual review.
 * The loop's own governors (adaptive resolution, idle frame cap) are switched
 * off for the run so every row measures exactly one change.
 *
 *   node tools/perf.mjs            # default 1600×900, quality=high
 *   node tools/perf.mjs --seconds 4 --width 1920 --height 1080 --quality medium
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Cdp, ROOT, launchBrowser, sleep, startStaticServer, waitForHttp } from './lib/browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : [])).filter((e) => e.length));
const WIDTH = Number(args.width) || 1600;
const HEIGHT = Number(args.height) || 900;
const SECONDS = Number(args.seconds) || 3;
const QUALITY = args.quality || 'high';
/** Optional tone-mapping override for look comparisons: aces | agx | neutral. */
const TONEMAP = { aces: 4, agx: 6, neutral: 7 }[(args.tonemap ?? '').toLowerCase()] ?? null;
const SHOTS_ONLY = 'shots-only' in args || process.argv.includes('--shots-only');
const SERVER_PORT = 8124;
const CDP_PORT = 9334;
const OUT_DIR = path.join(ROOT, '_tmp_perf');

/** Measure the live rAF loop for `seconds`; returns fps and average ms/frame. */
async function measure(cdp, seconds) {
  const stats = await cdp.eval(`(async () => {
    const start = performance.now(); const f0 = zenith.world.frame;
    await new Promise((r) => setTimeout(r, ${seconds * 1000}));
    const ms = performance.now() - start; const frames = zenith.world.frame - f0;
    return { fps: frames / (ms / 1000), msPerFrame: ms / Math.max(1, frames), frames };
  })()`);
  return stats;
}

/**
 * Wait until the loop has rendered `minFrames` frames and `minMs` have passed
 * (or `maxMs` as a safety net). A quality toggle recompiles every material on
 * its first frame, which on an iGPU can take longer than a fixed sleep; counting
 * frames guarantees that frame is over before the stopwatch starts.
 */
async function settle(cdp, { minFrames = 10, minMs = 400, maxMs = 8000 } = {}) {
  const f0 = await cdp.eval('zenith.world.frame');
  const start = Date.now();
  await sleep(minMs);
  while (Date.now() - start < maxMs) {
    if ((await cdp.eval('zenith.world.frame')) - f0 >= minFrames) return;
    await sleep(100);
  }
}

function report(label, s, note = '') {
  console.log(`  ${label.padEnd(44)} ${s.fps.toFixed(1).padStart(6)} fps   ${s.msPerFrame.toFixed(2).padStart(6)} ms/frame${note}`);
}

/** Temporarily apply a scene tweak, measure, then restore. */
async function scenario(cdp, label, apply, restore) {
  await cdp.eval(`(() => { ${apply}; return true; })()`);
  await settle(cdp);
  const s = await measure(cdp, SECONDS);
  await cdp.eval(`(() => { ${restore}; return true; })()`);
  await settle(cdp, { minMs: 200 });
  report(label, s);
  return s;
}

async function main() {
  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const server = startStaticServer(SERVER_PORT);
  const browser = await launchBrowser({ cdpPort: CDP_PORT, width: WIDTH, height: HEIGHT, gpu: true });
  const problems = [];
  try {
    const cdp = await Cdp.connect(CDP_PORT);
    await cdp.collectProblems(problems);
    await waitForHttp(`http://127.0.0.1:${SERVER_PORT}/index.html`).catch(() => null);
    await cdp.openApp(`http://127.0.0.1:${SERVER_PORT}/?quality=${QUALITY}`);

    const gpu = await cdp.eval(`(() => {
      const gl = zenith.world.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })()`);
    // Headless Chrome never sends input, so the idle cap would halve the loop after 8 s, and the
    // adaptive scaler would silently shrink the buffer: both are measured explicitly below instead.
    await cdp.eval('zenith.world.adaptiveResolution = false; zenith.world.idleFpsCap = 0; true');
    const dpr = await cdp.eval('zenith.world.renderer.getPixelRatio()');
    const size = await cdp.eval('zenith.world.canvas.width + "x" + zenith.world.canvas.height');
    console.log(`▶ GPU: ${gpu}`);
    console.log(`▶ drawing buffer ${size} @ DPR ${dpr}, quality=${QUALITY} (adaptive resolution and idle cap disabled for the run)`);
    if (TONEMAP !== null) {
      await cdp.eval(`(() => {
        zenith.world.renderer.toneMapping = ${TONEMAP};
        zenith.world.scene.traverse((o) => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true)); });
        return true;
      })()`);
      console.log(`▶ tone mapping override: ${args.tonemap}`);
    }

    await sleep(1500);
    await cdp.screenshot(path.join(OUT_DIR, 'title.png'));

    console.log('▶ entering the table');
    await cdp.eval('document.querySelector(".zt-start [data-action=start]").click(); true');
    await sleep(2600);
    const info = await cdp.eval('JSON.stringify(zenith.world.renderer.info.render)');
    const mem = await cdp.eval('JSON.stringify(zenith.world.renderer.info.memory)');
    console.log(`▶ render info ${info}  memory ${mem}`);
    await cdp.screenshot(path.join(OUT_DIR, 'main-play.png'));

    if (!SHOTS_ONLY) await measureAll(cdp, dpr);

    console.log('▶ reference screenshots');
    await cdp.eval('zenith.engine.selectColor(1, Date.now()); true');
    await sleep(300);
    await cdp.eval(`(() => {
      const e = zenith.engine;
      for (const [r, c] of [[7,7],[6,8],[7,8],[8,6],[8,8],[9,9],[6,6],[5,5],[7,9]]) { const res = e.makeMove(r, c, Date.now()); if (res.error) return res.error; }
      return e.getState().status;
    })()`);
    await sleep(1800);
    await cdp.screenshot(path.join(OUT_DIR, 'stones.png'));
    await cdp.eval("zenith.director.goTo('CLOCK_FOCUS'); true");
    await sleep(1200);
    await cdp.screenshot(path.join(OUT_DIR, 'clock-focus.png'));
    await cdp.eval("zenith.director.goTo('MANUAL_STUDY'); true");
    await sleep(1200);
    await cdp.screenshot(path.join(OUT_DIR, 'manual-study.png'));
    await cdp.eval('zenith.director.returnToMain(); zenith.director.orbitBy(0.9, -0.35); zenith.director.zoomBy(1.4); true');
    await sleep(1400);
    await cdp.screenshot(path.join(OUT_DIR, 'room-wide.png'));
    await cdp.eval('zenith.director.orbitBy(2.2, 0.1); true');
    await sleep(1400);
    await cdp.screenshot(path.join(OUT_DIR, 'room-back.png'));
    await cdp.eval('zenith.director.orbitBy(0, 1.2); zenith.director.zoomBy(1.6); true');
    await sleep(1400);
    await cdp.screenshot(path.join(OUT_DIR, 'room-top.png'));

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
  console.log('\n✓ perf probe finished');
}

async function measureAll(cdp, dpr) {
    console.log(`▶ measuring (${SECONDS}s each)`);
    report('baseline', await measure(cdp, SECONDS));

    // What the adaptive scaler can buy: fixed scales first, then the scaler itself left to settle.
    await scenario(cdp, 'resolution scale 0.8', 'zenith.world.setResolutionScale(0.8)', 'zenith.world.setResolutionScale(1)');
    await scenario(cdp, 'resolution scale 0.6', 'zenith.world.setResolutionScale(0.6)', 'zenith.world.setResolutionScale(1)');
    await cdp.eval('zenith.world.adaptiveResolution = true; true');
    await cdp.eval(`(async () => {
      // Steady state = the warm-up is over (first smoothed sample exists) and the scale has not
      // moved for 2.5 s since then; 15 s cap.
      const deadline = performance.now() + 15000;
      let last = zenith.world.resolutionScale, since = null;
      while (performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (since === null && zenith.world.frameTimeMs > 0) since = performance.now();
        if (zenith.world.resolutionScale !== last) { last = zenith.world.resolutionScale; since = performance.now(); }
        else if (since !== null && performance.now() - since > 2500) break;
      }
      return true;
    })()`);
    const adaptive = await measure(cdp, SECONDS);
    report('adaptive resolution, settled', adaptive, `   (scale ${await cdp.eval('zenith.world.resolutionScale')})`);
    await cdp.eval('zenith.world.adaptiveResolution = false; zenith.world.setResolutionScale(1); true');
    await settle(cdp, { minMs: 200 });

    const postfx = await cdp.eval('zenith.world.postfx ? JSON.stringify(zenith.world.postfx.options) : null');
    if (postfx) {
      console.log(`  post chain: ${postfx}`);
      const restore = `zenith.world.setPostFX(${postfx})`;
      await scenario(cdp, 'post chain off entirely', 'zenith.world.setPostFX(null)', restore);
      await scenario(cdp, 'post chain: MSAA 0 (SMAA only)', `zenith.world.setPostFX({ ...${postfx}, samples: 0 })`, restore);
      await scenario(cdp, 'post chain: MSAA 4', `zenith.world.setPostFX({ ...${postfx}, samples: 4 })`, restore);
      await scenario(cdp, 'post chain: bloom off', `zenith.world.setPostFX({ ...${postfx}, bloom: false })`, restore);
      await scenario(cdp, 'post chain: SMAA off', `zenith.world.setPostFX({ ...${postfx}, smaa: false })`, restore);
      await scenario(cdp, 'post chain: vignette off', `zenith.world.setPostFX({ ...${postfx}, vignette: 0 })`, restore);
    }

    await scenario(cdp, 'no shadow maps',
      'zenith.world.setQuality({ shadows: false })',
      'zenith.world.setQuality({ shadows: true })');

    await scenario(cdp, 'shadow map re-rendered every frame',
      'globalThis.__sched = zenith.world._scheduleShadowMap; zenith.world._scheduleShadowMap = () => { zenith.world.renderer.shadowMap.autoUpdate = true; }',
      'zenith.world._scheduleShadowMap = globalThis.__sched');

    await scenario(cdp, 'no transmission (glass/stone → opaque)',
      `globalThis.__tm = []; zenith.world.scene.traverse((o) => { const m = o.material; if (m && m.transmission > 0) { globalThis.__tm.push([m, m.transmission]); m.transmission = 0; m.needsUpdate = true; } })`,
      'for (const [m, t] of globalThis.__tm) { m.transmission = t; m.needsUpdate = true; }');

    await scenario(cdp, 'pixel ratio 1',
      'zenith.world.setQuality({ maxPixelRatio: 1 })',
      `zenith.world.setQuality({ maxPixelRatio: ${dpr} })`);

    await scenario(cdp, 'PCF (hard) instead of PCFSoft shadows',
      'zenith.world.renderer.shadowMap.type = 1; zenith.world.scene.traverse((o) => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true)); })',
      'zenith.world.renderer.shadowMap.type = 2; zenith.world.scene.traverse((o) => { const m = o.material; if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true)); })');

    await scenario(cdp, 'point lights off',
      'globalThis.__pl = []; zenith.world.scene.traverse((o) => { if (o.isPointLight) { globalThis.__pl.push([o, o.intensity]); o.intensity = 0; o.visible = false; } })',
      'for (const [l, i] of globalThis.__pl) { l.intensity = i; l.visible = true; }');

    await scenario(cdp, 'no environment map (IBL)',
      'globalThis.__env = zenith.world.scene.environment; zenith.world.scene.environment = null',
      'zenith.world.scene.environment = globalThis.__env');

    await scenario(cdp, 'clock dial redraw off',
      'globalThis.__dial = zenith.clock._drawDial; zenith.clock._drawDial = () => {}',
      'zenith.clock._drawDial = globalThis.__dial');

    await scenario(cdp, 'everything above off at once',
      `zenith.world.setQuality({ shadows: false, maxPixelRatio: 1 }); zenith.world.scene.environment = null;
       zenith.world.scene.traverse((o) => { const m = o.material; if (m && m.transmission > 0) { m.transmission = 0; m.needsUpdate = true; } if (o.isPointLight) o.visible = false; });`,
      `zenith.world.setQuality({ shadows: true, maxPixelRatio: ${dpr} }); zenith.world.scene.environment = globalThis.__env;
       for (const [m, t] of globalThis.__tm) { m.transmission = t; m.needsUpdate = true; } for (const [l] of globalThis.__pl) l.visible = true;`);

    // Repeated so thermal throttling or a busy CPU during the run shows up as drift.
    await settle(cdp);
    report('baseline (again)', await measure(cdp, SECONDS));
}

main();

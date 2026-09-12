/** Render the existing brand SVG into Android launcher icons using Chrome. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Cdp, ROOT, launchBrowser } from '../lib/browser.mjs';
const res = path.join(ROOT, 'android/app/src/main/res');
const svg = await fs.readFile(path.join(ROOT, 'public/favicon.svg'), 'utf8');
const browser = await launchBrowser({ cdpPort: 9342, width: 512, height: 512 });
let cdp;
try {
  cdp = await Cdp.connect(9342);
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  for (const [density, scale] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
    const dir = path.join(res, `mipmap-${density}`);
    await fs.mkdir(dir, { recursive: true });
    for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
      const foreground = name.endsWith('foreground');
      const size = Math.round((foreground ? 108 : 48) * scale);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
      await cdp.eval(`(() => { document.body.innerHTML=${JSON.stringify(svg)}; document.body.style.cssText='margin:0;display:grid;place-items:center;width:100vw;height:100vh'; const svg=document.querySelector('svg'); svg.style.cssText='width:${foreground ? 64 : 100}%;height:${foreground ? 64 : 100}%'; return true; })()`);
      if (name.endsWith('round')) await cdp.eval("document.querySelector('svg').style.cssText+=';clip-path:circle(50%);border-radius:50%;background:#14100c'; true");
      await cdp.screenshot(path.join(dir, `${name}.png`));
    }
  }
  // Discard only Capacitor's generated splash bitmaps, now replaced by the themed XML.
  for (const dir of await fs.readdir(res, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('drawable')) continue;
    await fs.rm(path.join(res, dir.name, 'splash.png'), { force: true });
  }
} finally {
  cdp?.close();
  await browser.close();
}

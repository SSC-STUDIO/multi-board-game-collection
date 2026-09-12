#!/usr/bin/env node
/**
 * Render a folder of images as one labelled contact sheet (PNG) with headless
 * Chrome — handy for eyeballing candidate textures / model thumbnails.
 *
 *   node tools/contact-sheet.mjs <folder> <out.png> [columns=6] [cell=220]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Cdp, launchBrowser, sleep } from './lib/browser.mjs';

const [folder = '_tmp_thumbs', out = '_tmp_thumbs/sheet.png', columnsArg = '6', cellArg = '220'] = process.argv.slice(2);
const columns = Number(columnsArg);
const cell = Number(cellArg);

async function main() {
  const dir = path.resolve(folder);
  const files = (await fs.readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && f !== path.basename(out)).sort();
  const rows = Math.ceil(files.length / columns);
  const width = columns * cell;
  const height = rows * (cell + 26);
  const items = files.map((f) => `<figure><img src="file:///${path.join(dir, f).replace(/\\/g, '/')}"><figcaption>${f.replace(/\.[^.]+$/, '')}</figcaption></figure>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#111;color:#ddd;font:12px monospace}
    .grid{display:grid;grid-template-columns:repeat(${columns},${cell}px)}
    figure{margin:0;width:${cell}px;height:${cell + 26}px;text-align:center}
    img{width:${cell - 6}px;height:${cell - 6}px;object-fit:cover;display:block;margin:3px}
    figcaption{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px}
  </style></head><body><div class="grid">${items}</div></body></html>`;
  const htmlPath = path.join(dir, '_sheet.html');
  await fs.writeFile(htmlPath, html, 'utf8');

  const browser = await launchBrowser({ cdpPort: 9335, width, height, gpu: false });
  try {
    const cdp = await Cdp.connect(9335);
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `file:///${htmlPath.replace(/\\/g, '/')}` });
    await sleep(2500);
    await cdp.screenshot(path.resolve(out));
    cdp.close();
  } finally {
    await browser.close();
    await fs.rm(htmlPath, { force: true });
  }
}

main();

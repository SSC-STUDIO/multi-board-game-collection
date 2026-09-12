#!/usr/bin/env node
/**
 * Download the CC0 / OFL assets listed in tools/assets.manifest.json into
 * public/assets/ and write public/assets/manifest.json for the app.
 *
 *   npm run assets            # fetch what is missing
 *   npm run assets -- --force # re-download everything
 *
 * Zero dependencies (Node ≥ 20 fetch). Existing files are skipped, so the
 * script is safe to re-run; the app falls back to procedural materials for
 * anything that is absent.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'tools/assets.manifest.json');
const OUT_ROOT = path.join(ROOT, 'public/assets');
const PUBLIC_BASE = '/assets';
const FORCE = process.argv.includes('--force');
const CONCURRENCY = 4;

const PH_API = 'https://api.polyhaven.com/files';
const PH_DL = 'https://dl.polyhaven.org/file/ph-assets';

let downloadedBytes = 0;
let downloadedFiles = 0;
let skipped = 0;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/** Download `url` to `dest` unless it already exists (non-empty). */
async function download(url, dest) {
  if (!FORCE) {
    const stat = await fs.stat(dest).catch(() => null);
    if (stat && stat.size > 0) {
      skipped++;
      return;
    }
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buffer);
  downloadedBytes += buffer.length;
  downloadedFiles++;
  console.log(`  ↓ ${path.relative(ROOT, dest)}  (${(buffer.length / 1024).toFixed(0)} kB)`);
}

/** Run `tasks` (functions returning promises) with limited parallelism; failures are collected, not fatal. */
async function runAll(tasks) {
  const queue = [...tasks];
  const failures = [];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const task = queue.shift();
      try {
        await task();
      } catch (err) {
        failures.push(err.message);
        console.warn(`  ! ${err.message}`);
      }
    }
  });
  await Promise.all(workers);
  return failures;
}

const publicPath = (dest) => `${PUBLIC_BASE}/${path.relative(OUT_ROOT, dest).split(path.sep).join('/')}`;

async function main() {
  const source = JSON.parse(await fs.readFile(SOURCE, 'utf8'));
  const manifest = { generatedAt: new Date().toISOString(), textures: {}, models: {}, hdris: {}, fonts: [], credits: [] };
  const tasks = [];

  // --- Poly Haven textures: diffuse / GL normal / ARM (AO-Roughness-Metalness) ---
  // File names are not fully regular (e.g. some diffuse maps are "_albedo"), so
  // the per-asset file listing is consulted instead of guessing URLs.
  const MAP_KEYS = { diff: 'Diffuse', nor_gl: 'nor_gl', arm: 'arm', rough: 'Rough', ao: 'AO' };
  for (const [key, spec] of Object.entries(source.polyhaven.textures)) {
    const files = await fetchJson(`${PH_API}/${spec.id}`);
    const entry = { id: spec.id, res: spec.res };
    for (const map of spec.maps) {
      const variants = files[MAP_KEYS[map]]?.[spec.res];
      const info = variants?.jpg ?? variants?.png;
      if (!info) {
        console.warn(`  ! ${spec.id}: no ${map} at ${spec.res}, skipped`);
        continue;
      }
      const dest = path.join(OUT_ROOT, 'textures', key, path.basename(new URL(info.url).pathname));
      entry[map] = publicPath(dest);
      tasks.push(() => download(info.url, dest));
    }
    manifest.textures[key] = entry;
    manifest.credits.push({ asset: spec.id, type: 'texture', source: `https://polyhaven.com/a/${spec.id}`, license: 'CC0' });
  }

  // --- Poly Haven glTF models (gltf + bin + textures, relative paths preserved) ---
  for (const [id, spec] of Object.entries(source.polyhaven.models)) {
    const files = await fetchJson(`${PH_API}/${id}`);
    const gltf = files.gltf?.[spec.res]?.gltf;
    if (!gltf) throw new Error(`No glTF at ${spec.res} for model ${id}`);
    const dir = path.join(OUT_ROOT, 'models', id);
    const gltfDest = path.join(dir, path.basename(new URL(gltf.url).pathname));
    tasks.push(() => download(gltf.url, gltfDest));
    for (const [rel, info] of Object.entries(gltf.include ?? {})) {
      tasks.push(() => download(info.url, path.join(dir, ...rel.split('/'))));
    }
    manifest.models[id] = publicPath(gltfDest);
    manifest.credits.push({ asset: id, type: 'model', source: `https://polyhaven.com/a/${id}`, license: 'CC0' });
  }

  // --- Poly Haven HDRIs ---
  for (const [id, spec] of Object.entries(source.polyhaven.hdris)) {
    const file = `${id}_${spec.res}.hdr`;
    const dest = path.join(OUT_ROOT, 'hdri', file);
    tasks.push(() => download(`${PH_DL}/HDRIs/hdr/${spec.res}/${file}`, dest));
    manifest.hdris[id] = publicPath(dest);
    manifest.credits.push({ asset: id, type: 'hdri', source: `https://polyhaven.com/a/${id}`, license: 'CC0' });
  }

  // --- Fonts (OFL: the licence text must travel with the font) ---
  for (const font of source.fonts) {
    const dest = path.join(OUT_ROOT, 'fonts', font.file);
    tasks.push(() => download(font.url, dest));
    if (font.licenseUrl) {
      tasks.push(() => download(font.licenseUrl, path.join(OUT_ROOT, 'fonts', `${path.parse(font.file).name}-OFL.txt`)));
    }
    manifest.fonts.push({ family: font.family, role: font.role, url: publicPath(dest) });
    manifest.credits.push({ asset: font.family, type: 'font', source: font.url, license: 'OFL-1.1' });
  }

  // --- KayKit characters (CC0, pinned to an official release commit) ---
  if (source.kaykit) {
    const { repository, ref, licensePath, models } = source.kaykit;
    const base = `https://raw.githubusercontent.com/${repository}/${ref}`;
    const dir = path.join(OUT_ROOT, 'models', 'kaykit');
    tasks.push(() => download(`${base}/${licensePath}`, path.join(dir, 'LICENSE.txt')));
    for (const [id, spec] of Object.entries(models)) {
      const dest = path.join(dir, spec.file);
      tasks.push(() => download(`${base}/addons/kaykit_character_pack_adventures/Characters/gltf/${spec.file}`, dest));
      manifest.models[id] = publicPath(dest);
      manifest.credits.push({ asset: `KayKit ${spec.name}`, type: 'model', author: 'Kay Lousberg',
        source: `https://github.com/${repository}/tree/${ref}`, license: 'CC0' });
    }
  }

  console.log(`▶ fetching ${tasks.length} files → ${path.relative(ROOT, OUT_ROOT)}`);
  const failures = await runAll(tasks);
  await fs.writeFile(path.join(OUT_ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`✓ ${downloadedFiles} downloaded (${(downloadedBytes / 1048576).toFixed(1)} MB), ${skipped} already present → public/assets/manifest.json`);
  if (failures.length) {
    console.log(`✗ ${failures.length} file(s) failed — re-run to retry:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});

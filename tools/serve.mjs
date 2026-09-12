#!/usr/bin/env node
/**
 * Zero-dependency static preview server (`npm run serve`).
 *
 * Serves the project root as-is and injects an import map into index.html so
 * bare `three` / `three/addons/` specifiers resolve straight to node_modules.
 * This lets the untranspiled sources run without Vite. Use `npm run dev` for
 * HMR and `npm run build` for the optimised bundle.
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

const IMPORT_MAP = `<script type="importmap">${JSON.stringify({
  imports: {
    three: '/node_modules/three/build/three.module.js',
    'three/addons/': '/node_modules/three/examples/jsm/',
  },
})}</script>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    let filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // Mirror Vite: files in public/ are served from the site root.
    let data;
    try {
      data = await fs.readFile(filePath);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'EISDIR') throw err;
      filePath = path.normalize(path.join(ROOT, 'public', pathname));
      data = await fs.readFile(filePath);
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      data = Buffer.from(data.toString('utf8').replace('<head>', `<head>\n    ${IMPORT_MAP}`), 'utf8');
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    res.end(data);
  } catch (err) {
    const status = err?.code === 'ENOENT' || err?.code === 'EISDIR' ? 404 : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(status === 404 ? `Not found: ${req.url}` : `Server error: ${err?.message ?? err}`);
  }
});

server.listen(PORT, () => {
  console.log(`Zenith-Tabletop-3D  →  http://localhost:${PORT}`);
  console.log(`serving ${ROOT}`);
});

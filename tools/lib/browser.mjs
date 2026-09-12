/**
 * Shared helpers for the headless-browser tooling (smoke / perf scripts):
 * locate Chrome or Edge, start the static server, drive the page over the
 * DevTools protocol with Node's built-in WebSocket. Zero dependencies.
 */
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  const found = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found. Set BROWSER_PATH.');
  return found;
}

export async function waitForHttp(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json().catch(() => null);
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Start tools/serve.mjs on `port`; returns the child process. */
export function startStaticServer(port) {
  return spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
}

/**
 * Launch a headless browser with remote debugging.
 * `gpu: false` forces SwiftShader (deterministic, slow); `gpu: true` lets
 * ANGLE pick the real adapter so frame timings are meaningful.
 */
export async function launchBrowser({ cdpPort, width, height, gpu = false }) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zenith-headless-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ];
  if (gpu) {
    args.push('--enable-gpu', '--enable-gpu-rasterization');
    if (process.platform === 'win32') args.push('--use-angle=d3d11');
  } else {
    args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  }
  args.push('about:blank');
  const proc = spawn(findBrowser(), args, { stdio: 'ignore' });
  return {
    proc,
    async close() {
      proc.kill();
      await sleep(300);
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(e));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  /** Connect to the first page target of a browser listening on `cdpPort`. */
  static async connect(cdpPort) {
    const targets = await waitForHttp(`http://127.0.0.1:${cdpPort}/json`);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('No page target exposed by the browser');
    const cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    return cdp;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  /** Evaluate an expression in the page and return its JSON value (awaits promises). */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  📷 ${path.relative(ROOT, file)}`);
  }

  /**
   * Route page exceptions / console errors into `problems` (and echo them).
   * @param {string[]} problems
   */
  async collectProblems(problems, { verbose = Boolean(process.env.SMOKE_VERBOSE) } = {}) {
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');
    this.on('Runtime.exceptionThrown', (p) => {
      const text = p.exceptionDetails.exception?.description ?? p.exceptionDetails.text;
      problems.push(`exception: ${text}`);
      console.log(`  ✗ ${text.split('\n')[0]}`);
    });
    this.on('Runtime.consoleAPICalled', (p) => {
      const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error') problems.push(`console.error: ${text}`);
      if (p.type === 'error' || p.type === 'warning' || verbose) console.log(`  ${p.type}: ${text}`);
    });
    this.on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error') {
        problems.push(`log: ${p.entry.text}`);
        console.log(`  ✗ ${p.entry.text}`);
      }
    });
  }

  /** Navigate and wait until `globalThis.zenith` exists. */
  async openApp(url, timeoutMs = 20_000) {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval('typeof globalThis.zenith === "object"')) return;
      await sleep(250);
    }
    throw new Error('App did not boot (globalThis.zenith missing)');
  }

  close() {
    this.ws.close();
  }
}

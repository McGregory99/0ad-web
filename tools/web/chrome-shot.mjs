#!/usr/bin/env node
// Drive headless Chrome over the DevTools protocol: serve a directory with COOP/COEP,
// open it, run a timed script of screenshots and input events, and log the console.
//
// Usage: node tools/web/chrome-shot.mjs <dir> <outdir> <script> [query] [port]
//   script: comma-separated steps, e.g. "wait:20,shot:menu,click:640:360,wait:2,shot:after"
//     wait:<s>          sleep s seconds
//     shot:<name>       save <outdir>/<name>.png
//     click:<x>:<y>     left click at CSS pixel (x, y)
//     key:<key>         press a key (DOM key name, e.g. Escape, Enter, a)
//     move:<x>:<y>      move the mouse
//     stats             log Module.remoteStats (remote file reads, requests, bytes)
// Writes <outdir>/console.log (console messages and exceptions, with seconds since start).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, outdir, script, query = '', port = '8094'] = process.argv.slice(2);
if (!dir || !outdir || !script) {
  console.error('usage: chrome-shot.mjs <dir> <outdir> <script> [query] [port]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outdir, { recursive: true });
const logFile = join(outdir, 'console.log');
writeFileSync(logFile, '');
const t0 = Date.now();
const log = (line) => appendFileSync(logFile, `[${((Date.now() - t0) / 1000).toFixed(1)}] ${line}\n`);

const server = spawn('node', [join(root, 'tools/spikes/serve.mjs'), dir, port], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'chrome-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--remote-debugging-port=0',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  chrome.kill('SIGKILL');
  server.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
process.on('exit', cleanup);

const wsUrl = await new Promise((resolveUrl, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolveUrl(m[1]);
  });
  setTimeout(() => reject(new Error('Chrome did not start')), 15000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
const handlers = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: ok, reject: fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(JSON.stringify(msg.error))) : ok(msg.result);
  } else if (msg.method) {
    for (const h of handlers) h(msg);
  }
});
const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
  const id = nextId++;
  pending.set(id, { resolve: ok, reject: fail });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const s = (method, params) => send(method, params, sessionId);
handlers.push((msg) => {
  if (msg.sessionId !== sessionId) return;
  if (msg.method === 'Runtime.consoleAPICalled') {
    log(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    log(`exception: ${d.exception?.description ?? d.text}`);
  } else if (msg.method === 'Log.entryAdded') {
    log(`${msg.params.entry.source}/${msg.params.entry.level}: ${msg.params.entry.text}`);
  }
});
await s('Runtime.enable');
await s('Log.enable');
await s('Page.enable');
await s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await s('Page.navigate', { url: `http://127.0.0.1:${port}/${query}` });

const mouse = (type, x, y, extra = {}) =>
  s('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, ...extra });
for (const step of script.split(',')) {
  const [op, a, b] = step.split(':');
  if (op === 'wait') await sleep(Number(a) * 1000);
  else if (op === 'shot') {
    const { data } = await s('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outdir, `${a}.png`), Buffer.from(data, 'base64'));
    log(`shot ${a}`);
  } else if (op === 'move') await mouse('mouseMoved', Number(a), Number(b));
  else if (op === 'click') {
    const [x, y] = [Number(a), Number(b)];
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, { clickCount: 1 });
    await mouse('mouseReleased', x, y, { clickCount: 1 });
    log(`click ${x},${y}`);
  } else if (op === 'key') {
    await s('Input.dispatchKeyEvent', { type: 'keyDown', key: a });
    await s('Input.dispatchKeyEvent', { type: 'keyUp', key: a });
    log(`key ${a}`);
  } else if (op === 'stats') {
    const { result } = await s('Runtime.evaluate', { expression: 'JSON.stringify(Module.remoteStats)', returnByValue: true });
    log(`stats ${result.value}`);
  } else throw new Error(`unknown step ${step}`);
}
cleanup();
process.exit(0);

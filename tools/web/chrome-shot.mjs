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
//     reload            reload the page (same profile: Cache Storage survives)
//     fps:<s>           measure requestAnimationFrame intervals for s seconds (frames, fps, p50/p99/max ms)
//     resize:<w>:<h>    change the viewport size live (Emulation.setDeviceMetricsOverride)
//     evalfile:<path>   evaluate the JavaScript in <path> in the page (awaits a returned Promise) and log the result
//     keydown:<key> / keyup:<key>   press or release a key only (hold keys across waits)
// Keys: DOM key names (Escape, Enter, Tab, ArrowUp, F11, a, ...); code and keyCode are filled in.
// Env CHROME_GPU=1 uses the real GPU (ANGLE Metal) instead of SwiftShader.
// Env CHROME_W / CHROME_H set the viewport size (default 1280x720).
// Writes <outdir>/console.log (console messages and exceptions, with seconds since start).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
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
const W = Number(process.env.CHROME_W || 1280), H = Number(process.env.CHROME_H || 720);
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
  ...(process.env.CHROME_GPU === '1' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  `--window-size=${W},${H}`, 'about:blank',
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
await s('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await s('Page.navigate', { url: `http://127.0.0.1:${port}/${query}` });

// DOM key name -> [code, Windows virtual key code]; SDL reads code/keyCode, not key.
function keyInfo(key) {
  const named = { Escape: ['Escape', 27], Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
    ' ': ['Space', 32], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39],
    ArrowDown: ['ArrowDown', 40], Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18],
    Delete: ['Delete', 46], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34] };
  if (named[key]) return named[key];
  const f = /^F(\d{1,2})$/.exec(key);
  if (f) return [key, 111 + Number(f[1])];
  if (/^[a-z]$/i.test(key)) return [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
  if (/^\d$/.test(key)) return [`Digit${key}`, key.charCodeAt(0)];
  return [key, 0];
}
const keyEvent = (type, key) => {
  const [code, vk] = keyInfo(key);
  const text = key.length === 1 && type === 'keyDown' ? { text: key } : {};
  return s('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...text });
};
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
    await keyEvent('keyDown', a);
    await keyEvent('keyUp', a);
    log(`key ${a}`);
  } else if (op === 'keydown' || op === 'keyup') {
    await keyEvent(op === 'keydown' ? 'keyDown' : 'keyUp', a);
    log(`${op} ${a}`);
  } else if (op === 'evalfile') {
    const expression = readFileSync(a, 'utf8');
    const { result, exceptionDetails } = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    log(`evalfile ${a}: ${exceptionDetails ? 'EXCEPTION ' + (exceptionDetails.exception?.description ?? exceptionDetails.text) : JSON.stringify(result.value)}`);
  } else if (op === 'reload') {
    await s('Page.reload', { ignoreCache: false });
    log('reload');
  } else if (op === 'resize') {
    await s('Emulation.setDeviceMetricsOverride', { width: Number(a), height: Number(b), deviceScaleFactor: 1, mobile: false });
    log(`resize ${a}x${b}`);
  } else if (op === 'fps') {
    const expression = `new Promise((done) => {
      const times = []; let last = performance.now(); const end = last + ${Number(a) * 1000};
      const tick = (now) => { times.push(now - last); last = now;
        if (now < end) requestAnimationFrame(tick);
        else { times.sort((x, y) => x - y); const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
          done(JSON.stringify({ frames: times.length, fps: +(times.length / ${Number(a)}).toFixed(1),
            p50: +q(0.5).toFixed(1), p99: +q(0.99).toFixed(1), max: +times[times.length - 1].toFixed(1) })); } };
      requestAnimationFrame(tick); })`;
    const { result } = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    log(`fps ${result.value}`);
  } else if (op === 'stats') {
    const { result } = await s('Runtime.evaluate', { expression: 'JSON.stringify(Module.remoteStats)', returnByValue: true });
    log(`stats ${result.value}`);
  } else throw new Error(`unknown step ${step}`);
}
cleanup();
process.exit(0);

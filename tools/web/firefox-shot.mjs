#!/usr/bin/env node
// Firefox counterpart of chrome-shot.mjs, driven over WebDriver BiDi: serve a directory with
// COOP/COEP, open it in headless Firefox, run a timed script of steps, and log the console.
//
// Usage: node tools/web/firefox-shot.mjs <dir> <outdir> <script> [query] [port]
//   Steps: wait:<s>, shot:<name>, click:<x>:<y>, move:<x>:<y>, key:<key>, keydown:<key>, keyup:<key>,
//          fps:<s>, evalfile:<path>, stats (same meaning as in chrome-shot.mjs).
// Env FIREFOX_W / FIREFOX_H set the viewport (default 1280x720). Audio is muted unless FIREFOX_AUDIO=1.
// Env FIREFOX_NOLOG=1 does not subscribe to console messages (to rule out their cost).
// Env FIREFOX_HEADED=1 opens a visible window (real GPU path) instead of headless.
// Writes <outdir>/console.log (console messages and errors, with seconds since start).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, outdir, script, query = '', port = '8095'] = process.argv.slice(2);
if (!dir || !outdir || !script) {
  console.error('usage: firefox-shot.mjs <dir> <outdir> <script> [query] [port]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';
const W = Number(process.env.FIREFOX_W || 1280), H = Number(process.env.FIREFOX_H || 720);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outdir, { recursive: true });
const logFile = join(outdir, 'console.log');
writeFileSync(logFile, '');
const t0 = Date.now();
const log = (line) => appendFileSync(logFile, `[${((Date.now() - t0) / 1000).toFixed(1)}] ${line}\n`);

const server = spawn('node', [join(root, 'tools/spikes/serve.mjs'), dir, port], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'firefox-shot-'));
writeFileSync(join(profile, 'user.js'), [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("webgl.force-enabled", true);',
  ...(process.env.FIREFOX_AUDIO === '1' ? [] : ['user_pref("media.volume_scale", "0.0");']),
].join('\n') + '\n');
const firefox = spawn(FIREFOX, [
  ...(process.env.FIREFOX_HEADED === '1' ? [] : ['--headless']), '--no-remote', '--profile', profile,
  '--remote-debugging-port=0', `--width=${W}`, `--height=${H}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  firefox.kill('SIGKILL');
  server.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
process.on('exit', cleanup);

const wsBase = await new Promise((resolveUrl, reject) => {
  let buf = '';
  firefox.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
    if (m) resolveUrl(m[1]);
  });
  setTimeout(() => reject(new Error('Firefox did not start')), 30000);
});

const ws = new WebSocket(`${wsBase}/session`);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.type === 'error' ? fail(new Error(`${msg.error}: ${msg.message}`)) : ok(msg.result);
  } else if (msg.method === 'log.entryAdded') {
    const e = msg.params;
    const text = e.text ?? (e.args || []).map((a) => a.value ?? a.type).join(' ');
    log(`${e.type === 'javascript' ? 'exception' : e.level}: ${text}`);
  }
});
const send = (method, params = {}) => new Promise((ok, fail0) => {
  const fail = (e) => fail0(new Error(`${method}: ${e.message}`));
  const id = nextId++;
  pending.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params }));
});

await send('session.new', { capabilities: {} });
if (process.env.FIREFOX_NOLOG !== '1') await send('session.subscribe', { events: ['log.entryAdded'] });
const { context } = await send('browsingContext.create', { type: 'tab' });
await send('browsingContext.setViewport', { context, viewport: { width: W, height: H } });
await send('browsingContext.navigate', { context, url: `http://127.0.0.1:${port}/${query}`, wait: 'none' });

const evaluate = async (expression) => {
  const r = await send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' });
  if (r.type === 'exception') return `EXCEPTION ${r.exceptionDetails?.text}`;
  return r.result?.value;
};
// DOM key name -> WebDriver key value (special keys use the WebDriver private-use code points).
const keyValue = (key) => ({ Escape: '', Enter: '', Tab: '', Backspace: '',
  ArrowLeft: '', ArrowUp: '', ArrowRight: '', ArrowDown: '', Shift: '',
  Control: '', Alt: '', Delete: '', Home: '', End: '', PageUp: '',
  PageDown: '' })[key] ?? (/^F(\d{1,2})$/.test(key) ? String.fromCharCode(0xE031 + Number(key.slice(1)) - 1) : key);
const keys = (actions) => send('input.performActions', { context, actions: [{ type: 'key', id: 'kbd', actions }] });
const pointer = (actions) => send('input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }] });

for (const step of script.split(',')) {
  const [op, a, b] = step.split(':');
  if (op === 'wait') await sleep(Number(a) * 1000);
  else if (op === 'shot') {
    const { data } = await send('browsingContext.captureScreenshot', { context });
    writeFileSync(join(outdir, `${a}.png`), Buffer.from(data, 'base64'));
    log(`shot ${a}`);
  } else if (op === 'move') await pointer([{ type: 'pointerMove', x: Number(a), y: Number(b) }]);
  else if (op === 'click') {
    const [x, y] = [Number(a), Number(b)];
    await pointer([{ type: 'pointerMove', x, y }, { type: 'pointerDown', button: 0 }, { type: 'pause', duration: 50 }, { type: 'pointerUp', button: 0 }]);
    log(`click ${x},${y}`);
  } else if (op === 'key') {
    await keys([{ type: 'keyDown', value: keyValue(a) }, { type: 'keyUp', value: keyValue(a) }]);
    log(`key ${a}`);
  } else if (op === 'keydown' || op === 'keyup') {
    await keys([{ type: op === 'keydown' ? 'keyDown' : 'keyUp', value: keyValue(a) }]);
    log(`${op} ${a}`);
  } else if (op === 'evalfile') {
    log(`evalfile ${a}: ${JSON.stringify(await evaluate(readFileSync(a, 'utf8')))}`);
  } else if (op === 'fps') {
    const expression = `new Promise((done) => {
      const times = []; let last = performance.now(); const end = last + ${Number(a) * 1000};
      const tick = (now) => { times.push(now - last); last = now;
        if (now < end) requestAnimationFrame(tick);
        else { times.sort((x, y) => x - y); const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
          done(JSON.stringify({ frames: times.length, fps: +(times.length / ${Number(a)}).toFixed(1),
            p50: +q(0.5).toFixed(1), p99: +q(0.99).toFixed(1), max: +times[times.length - 1].toFixed(1) })); } };
      requestAnimationFrame(tick); })`;
    log(`fps ${await evaluate(expression)}`);
  } else if (op === 'stats') {
    log(`stats ${await evaluate('JSON.stringify(Module.remoteStats)')}`);
  } else throw new Error(`unknown step ${step}`);
}
cleanup();
process.exit(0);

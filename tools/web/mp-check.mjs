#!/usr/bin/env node
// Two-player multiplayer check of the browser build over the ENet WebSocket tunnel (T7.1b):
// starts the relay (tools/relay/relay.mjs) and a COOP/COEP file server, opens two pages in one
// headless Chrome (one window each, so neither is a hidden background tab), autostarts a host in
// the first and a client joining 127.0.0.1 in the second, waits until both reach the match,
// stays there, takes a screenshot of each and reports Module.zeroadNet.stats and desync lines.
//
// Usage: node tools/web/mp-check.mjs <build dir> <outdir> [seconds in match, default 120] [http port, default 8096]
// Env: MP_MAP (default scenarios/arcadia), RELAY_PORT (default 20600; the relay is started here and
//      must not already run on that port), MP_START_TIMEOUT seconds until both pages are in the
//      match (default 420), CHROME_GPU=1 real GPU instead of SwiftShader, CHROME_W / CHROME_H,
//      MP_STACKS=<s> logs each page's main-thread JS/wasm call stack s seconds after the client
//      page opened (diagnosis of a stalled main thread).
// Writes <outdir>/{host,client}.console.log, relay.log, {host,client}.png, {host,client}.{mainlog,interestinglog}.html
// (the engine's logs) and summary.json.
// Exit 0 when both pages reached the match, no desync line appeared, both sides sent and received
// more datagrams during the match and both were still connected at the end; 1 otherwise.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, outdir, matchSecondsArg = '120', port = '8096'] = process.argv.slice(2);
if (!dir || !outdir) {
  console.error('usage: mp-check.mjs <build dir> <outdir> [seconds in match] [http port]');
  process.exit(2);
}
const matchSeconds = Number(matchSecondsArg);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = Number(process.env.CHROME_W || 1280), H = Number(process.env.CHROME_H || 720);
const MAP = process.env.MP_MAP || 'scenarios/arcadia';
const RELAY_PORT = process.env.RELAY_PORT || '20600';
const START_TIMEOUT = Number(process.env.MP_START_TIMEOUT || 420) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(outdir, { recursive: true });
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);
const say = (line) => { console.log(`[${stamp()}] ${line}`); appendFileSync(join(outdir, 'mp-check.log'), `[${stamp()}] ${line}\n`); };
writeFileSync(join(outdir, 'mp-check.log'), '');

const relayLog = createWriteStream(join(outdir, 'relay.log'));
const relay = spawn('node', [join(root, 'tools/relay/relay.mjs')], {
  env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT }, stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stdout.pipe(relayLog);
relay.stderr.pipe(relayLog);
let relayExited = false;
relay.on('exit', (code) => { relayExited = true; say(`relay exited (${code})`); });
const server = spawn('node', [join(root, 'tools/spikes/serve.mjs'), dir, port], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'mp-check-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--remote-debugging-port=0',
  ...(process.env.CHROME_GPU === '1' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', `--window-size=${W},${H}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  chrome.kill('SIGKILL');
  server.kill();
  relay.kill();
  // Synchronous: the process exits right after cleanup, so a timer would never fire.
  try { rmSync(profile, { recursive: true, force: true }); } catch (error) { console.error(`profile ${profile} not removed: ${error}`); }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

const wsUrl = await new Promise((resolveUrl, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) resolveUrl(m[1]);
  });
  setTimeout(() => reject(new Error('Chrome did not start')), 15000);
});
await sleep(500);
if (relayExited) { say('relay did not start (port in use?), see relay.log'); process.exit(1); }

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

// One page per window: a background tab is hidden, and the engine's frame loop runs on
// requestAnimationFrame, which stops in hidden pages.
async function openPage(name) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = { name, sessionId, lines: [], started: null, bound: null };
  page.s = (method, params) => send(method, params, sessionId);
  const file = join(outdir, `${name}.console.log`);
  writeFileSync(file, '');
  const log = (line) => {
    page.lines.push(line);
    appendFileSync(file, `[${stamp()}] ${line}\n`);
    if (!page.started && line.includes('GAME STARTED')) {
      page.started = Date.now();
      page.matchLineIndex = page.lines.length - 1;
      say(`${name}: in the match`);
    }
    if (line.includes('[zeroad-net]') && line.includes('closed')) say(`${name}: ${line}`);
    const bound = /\[zeroad-net\] socket \d+: bound (\S+)/.exec(line);
    if (bound && !page.bound) { page.bound = bound[1]; say(`${name}: relay socket bound ${bound[1]}`); }
  };
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
  await page.s('Runtime.enable');
  await page.s('Log.enable');
  await page.s('Page.enable');
  await page.s('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Enabling the debugger after the 16 MB module compiled stalls; enable it before loading.
  if (process.env.MP_STACKS) await page.s('Debugger.enable');
  await page.s('Emulation.setDeviceMetricsOverride', { width: W, height: H, screenWidth: W, screenHeight: H, deviceScaleFactor: 1, mobile: false });
  page.evaluate = async (expression) => {
    const { result, exceptionDetails } = await page.s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return exceptionDetails ? `EXCEPTION ${exceptionDetails.exception?.description ?? exceptionDetails.text}` : result.value;
  };
  page.stats = async () => {
    const v = await page.evaluate('JSON.stringify(typeof Module !== "undefined" && Module.zeroadNet ? Module.zeroadNet.stats : null)');
    try { return JSON.parse(v); } catch { return v; }
  };
  return page;
}

// Pause the page's main thread and log its call stack (works while wasm spins in a loop).
async function dumpStack(page) {
  const paused = new Promise((done) => handlers.push((msg) => {
    if (msg.sessionId === page.sessionId && msg.method === 'Debugger.paused') done(msg.params.callFrames);
  }));
  await page.s('Debugger.pause');
  const frames = await Promise.race([paused, sleep(10000).then(() => null)]);
  say(`${page.name} main-thread stack: ${frames ? frames.map((f) => f.functionName || '(anonymous)').join(' < ') : 'no pause within 10 s'}`);
  if (frames) await page.s('Debugger.resume');
}

const base = `?arg=-mod=public&arg=-conf=windowed:true&relay=${encodeURIComponent(`ws://127.0.0.1:${RELAY_PORT}/`)}`;
const hostQuery = `${base}&arg=-autostart=${MAP}&arg=-autostart-host&arg=-autostart-host-players=2&arg=-autostart-playername=host`;
const clientQuery = `${base}&arg=-autostart-client=127.0.0.1&arg=-autostart-playername=client`;
const host = await openPage('host');
const client = await openPage('client');
const waitFor = async (what, check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(500);
  }
  say(`timeout waiting for ${what}`);
  return false;
};

const summary = { map: MAP, matchSeconds, host: {}, client: {} };
let ok = true;
await host.s('Page.navigate', { url: `http://127.0.0.1:${port}/${hostQuery}` });
say(`host page opened: ${hostQuery}`);
ok = await waitFor('the host relay socket to bind', () => host.bound, 120000);
if (ok) {
  await client.s('Page.navigate', { url: `http://127.0.0.1:${port}/${clientQuery}` });
  say(`client page opened: ${clientQuery}`);
  if (process.env.MP_STACKS) {
    await sleep(Number(process.env.MP_STACKS) * 1000);
    for (const page of [host, client]) await dumpStack(page);
  }
  ok = await waitFor('both pages in the match', () => host.started && client.started, START_TIMEOUT);
}
for (const page of [host, client])
  summary[page.name].visibility = await page.evaluate('document.visibilityState');
if (ok) {
  summary.host.statsAtStart = await host.stats();
  summary.client.statsAtStart = await client.stats();
  say(`stats at start: host ${JSON.stringify(summary.host.statsAtStart)} client ${JSON.stringify(summary.client.statsAtStart)}`);
  for (let left = matchSeconds; left > 0; left -= 30) {
    await sleep(Math.min(30, left) * 1000);
    say(`in match: host ${JSON.stringify(await host.stats())} client ${JSON.stringify(await client.stats())}`);
  }
}
for (const page of [host, client]) {
  const { data } = await page.s('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outdir, `${page.name}.png`), Buffer.from(data, 'base64'));
  const p = summary[page.name];
  p.reachedMatch = Boolean(page.started);
  p.matchStartSeconds = page.started ? +((page.started - t0) / 1000).toFixed(1) : null;
  p.bound = page.bound;
  p.stats = await page.stats();
  p.pthreadPool = await page.evaluate('JSON.stringify({ unused: PThread.unusedWorkers.length, threads: Object.keys(PThread.pthreads).length })');
  p.desyncLines = page.lines.filter((l) => /out.of.sync|\bOOS\b|desync/i.test(l));
  p.netLines = page.lines.filter((l) => l.includes('[zeroad-net]'));
  p.errorLines = page.lines.filter((l) => /^(error|exception)|\/error:|ERROR/.test(l)).slice(0, 40);
  // The engine's own logs (network messages, disconnect reasons) live in the page's file system.
  for (const log of ['mainlog', 'interestinglog']) {
    const text = await page.evaluate(`(() => { try { return Module.FS.readFile('/home/web_user/.local/state/0ad/log/${log}.html', { encoding: 'utf8' }); } catch (e) { return 'unreadable: ' + e; } })()`);
    writeFileSync(join(outdir, `${page.name}.${log}.html`), String(text));
  }
}
const grew = (p) => p.statsAtStart && p.stats && p.stats.sent > p.statsAtStart.sent && p.stats.received > p.statsAtStart.received;
// The match must still be connected at the end: a relay WebSocket is still open and no socket was
// closed after the match started (stats.sockets counts every socket ever opened, so it is not
// compared with stats.open).
const connected = (page, p) => p.stats && p.stats.open > 0 &&
  !page.lines.slice(page.matchLineIndex ?? 0).some((l) => l.includes('[zeroad-net]') && l.includes('closed'));
summary.host.connectedAtEnd = Boolean(connected(host, summary.host));
summary.client.connectedAtEnd = Boolean(connected(client, summary.client));
summary.pass = ok && summary.host.reachedMatch && summary.client.reachedMatch &&
  summary.host.desyncLines.length === 0 && summary.client.desyncLines.length === 0 &&
  Boolean(grew(summary.host)) && Boolean(grew(summary.client)) &&
  summary.host.connectedAtEnd && summary.client.connectedAtEnd;
writeFileSync(join(outdir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
for (const page of [host, client]) {
  const p = summary[page.name];
  say(`${page.name}: match ${p.reachedMatch} (at ${p.matchStartSeconds} s), connected at end ${p.connectedAtEnd}, bound ${p.bound}, visibility ${p.visibility}, pthread pool ${p.pthreadPool}, stats ${JSON.stringify(p.stats)}, desync lines ${p.desyncLines.length}, error lines ${p.errorLines.length}`);
  for (const l of p.desyncLines) say(`  ${page.name} desync: ${l}`);
}
say(`PASS=${summary.pass}`);
cleanup();
process.exit(summary.pass ? 0 : 1);

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
//      MP_NATIVE=client — a native pyrogenesis joins the browser host as a client: the host page
//      autostarts on the relay's UDP 20595 socket and the native client joins 127.0.0.1 (T7.1c).
//      MP_NATIVE=host — the native pyrogenesis is the host, listening on UDP 20595, and the browser
//      client page joins 127.0.0.1 through the relay (T7.1d). Unset keeps the two-browser check.
//      MP_NATIVE_ARGS extra native arguments, space-separated (e.g. "-autostart-nonvisual").
//      MP_GUI=1 drives the real multiplayer dialogs instead of autostart (T7.1e2): the host page
//      creates a room (Multijugador > Crear partida), its "Room code: <port>" console line is the
//      code the client page types into Conectar por IP, and the host starts the match from the
//      game setup page. summary.roomCode holds the code; <page>-step{1,3,4}.png are screenshots,
//      client-joindialog.png shows the join dialog with its "Open games" drop-down (T7.2b), and the
//      relay's GET /rooms must list the room under the host's name (summary.roomListed/roomName).
//      MP_GUI_LIST=1 (with MP_GUI) picks the room from that drop-down instead of typing the code.
//      SITE_URL (e.g. https://192.168.0.28:8012/) loads that deployed site instead of starting the
//      relay and serve.mjs; the page then uses its own default relay unless SITE_RELAY is set. Not
//      supported with MP_NATIVE (exit 2).
// Writes <outdir>/{host,client}.console.log, relay.log, {host,client}.png, {host,client}.{mainlog,interestinglog}.html
// (the engine's logs) and summary.json; with MP_NATIVE also native.log and native.mainlog.html.
// Exit 0 when both pages reached the match, no desync line appeared, both sides sent and received
// more datagrams during the match and both were still connected at the end; 1 otherwise.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, createWriteStream, copyFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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
const MP_NATIVE = ['client', 'host'].includes(process.env.MP_NATIVE) ? process.env.MP_NATIVE : null;
const MP_GUI = process.env.MP_GUI === '1';
const SITE_URL = (process.env.SITE_URL || '').trim();
const SITE_RELAY = (process.env.SITE_RELAY || '').trim();
// With SITE_URL there is no local relay or server; the query goes after exactly one '/'.
const siteBase = SITE_URL ? SITE_URL.replace(/\/+$/, '') : '';
const pageUrl = (query) => (siteBase ? `${siteBase}/${query}` : `http://127.0.0.1:${port}/${query}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The relay's GET /rooms (T7.2a): the room list the join dialog's "Open games" drop-down shows.
// With SITE_URL the relay is the deployed site's; its certificate is self-signed, so it is ignored
// for this request only (not for the pages).
const roomsUrl = SITE_URL
  ? `https://${new URL(SITE_URL).hostname}:20600/rooms`
  : `http://127.0.0.1:${RELAY_PORT}/rooms`;
async function fetchRooms() {
  if (!SITE_URL) {
    const response = await fetch(roomsUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`GET ${roomsUrl} answered ${response.status}`);
    return await response.json();
  }
  const https = await import('node:https');
  const url = new URL(roomsUrl);
  return await new Promise((ok, fail) => {
    const request = https.get({ hostname: url.hostname, port: url.port, path: url.pathname, rejectUnauthorized: false }, (response) => {
      if (response.statusCode !== 200) { response.resume(); fail(new Error(`GET ${roomsUrl} answered ${response.statusCode}`)); return; }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => { try { ok(JSON.parse(body)); } catch (error) { fail(error); } });
    });
    request.on('error', fail);
    request.setTimeout(5000, () => request.destroy(new Error(`GET ${roomsUrl} timed out`)));
  });
}
mkdirSync(outdir, { recursive: true });
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1);
const say = (line) => { console.log(`[${stamp()}] ${line}`); appendFileSync(join(outdir, 'mp-check.log'), `[${stamp()}] ${line}\n`); };
writeFileSync(join(outdir, 'mp-check.log'), '');
if (SITE_URL) say(`site url: ${siteBase}`);
if (SITE_URL && MP_NATIVE) {
  console.error('SITE_URL and MP_NATIVE cannot be combined: a native pyrogenesis needs the local relay on UDP 20595');
  process.exit(2);
}

// A deployed site brings its own relay (and page server): start neither.
const relayLog = SITE_URL ? null : createWriteStream(join(outdir, 'relay.log'));
const relay = SITE_URL ? null : spawn('node', [join(root, 'tools/relay/relay.mjs')], {
  env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT }, stdio: ['ignore', 'pipe', 'pipe'],
});
if (relay) {
  relay.stdout.pipe(relayLog);
  relay.stderr.pipe(relayLog);
}
let relayExited = false;
if (relay) relay.on('exit', (code) => { relayExited = true; say(`relay exited (${code})`); });
const server = SITE_URL ? null : spawn('node', [join(root, 'tools/spikes/serve.mjs'), dir, port], { stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'mp-check-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--remote-debugging-port=0',
  ...(process.env.CHROME_GPU === '1' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
  '--mute-audio', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', ...(SITE_URL ? ['--ignore-certificate-errors'] : []),
  `--window-size=${W},${H}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let native = null;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  chrome.kill('SIGKILL');
  if (server) server.kill();
  if (relay) relay.kill();
  if (native && native.proc.exitCode === null && native.proc.signalCode === null) native.proc.kill('SIGKILL');
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

// DOM key name -> [code, Windows virtual key code]; SDL reads code/keyCode, not key
// (same mapping as tools/web/chrome-shot.mjs).
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
async function sendKey(page, type, key) {
  const [code, vk] = keyInfo(key);
  const text = key.length === 1 && type === 'keyDown' ? { text: key } : {};
  await page.s('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...text });
}

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
  // Input over the DevTools protocol (MP_GUI): CSS pixel coordinates, DOM key names.
  page.click = async (x, y) => {
    const mouse = (type, extra = {}) => page.s('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, ...extra });
    await mouse('mouseMoved');
    await mouse('mousePressed', { clickCount: 1 });
    await mouse('mouseReleased', { clickCount: 1 });
    say(`${name}: click ${x},${y}`);
  };
  page.key = async (key) => {
    await sendKey(page, 'keyDown', key);
    await sendKey(page, 'keyUp', key);
    say(`${name}: key ${key}`);
  };
  page.shot = async (file) => {
    const { data } = await page.s('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
    say(`${name}: screenshot ${file}`);
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

// A native pyrogenesis taking part in the match (T7.1c/d). Its stdout+stderr go line by line to
// <outdir>/native.log and into an object shaped like a page.
function startNative(role) {
  const nativeDir = join(root, 'upstream/binaries/system');
  const args = ['-mod=public'];
  if (role === 'host')
    args.push(`-autostart=${MAP}`, '-autostart-host', '-autostart-host-players=2', '-autostart-playername=native');
  else args.push('-autostart-client=127.0.0.1', '-autostart-playername=native');
  for (const arg of (process.env.MP_NATIVE_ARGS || '').split(' ')) if (arg) args.push(arg);
  const proc = spawn(join(nativeDir, 'pyrogenesis'), args, { cwd: nativeDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const nativeSide = { name: 'native', lines: [], started: null, matchLineIndex: null, proc };
  const file = join(outdir, 'native.log');
  writeFileSync(file, '');
  const log = (line) => {
    nativeSide.lines.push(line);
    appendFileSync(file, `[${stamp()}] ${line}\n`);
    if (!nativeSide.started && line.includes('GAME STARTED')) {
      nativeSide.started = Date.now();
      nativeSide.matchLineIndex = nativeSide.lines.length - 1;
      say('native: in the match');
    }
  };
  let buf = '';
  const onData = (data) => {
    buf += data.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      log(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code, signal) => {
    if (buf) log(buf);
    buf = '';
    say(`native exited (code ${code}, signal ${signal})`);
  });
  say(`native ${role} started: ${join(nativeDir, 'pyrogenesis')} ${args.join(' ')}`);
  return nativeSide;
}

// With SITE_URL the page uses its own default relay (wss://<page host>:20600/); SITE_RELAY
// overrides it, e.g. for a local relay next to a locally served site.
const relayQuery = SITE_URL
  ? (SITE_RELAY ? `&relay=${encodeURIComponent(SITE_RELAY)}` : '')
  : `&relay=${encodeURIComponent(`ws://127.0.0.1:${RELAY_PORT}/`)}`;
const base = `?arg=-mod=public&arg=-conf=windowed:true${relayQuery}`;
const hostQuery = `${base}&arg=-autostart=${MAP}&arg=-autostart-host&arg=-autostart-host-players=2&arg=-autostart-playername=host`;
const clientQuery = `${base}&arg=-autostart-client=127.0.0.1&arg=-autostart-playername=client`;
// Only the pages this run needs: a native side replaces one of the two browser pages.
let host = null;
let client = null;
if (MP_NATIVE === 'host') {
  native = startNative('host');
  // The native host needs a few seconds to listen on UDP 20595 before a client joins.
  await sleep(15000);
  client = await openPage('client');
} else {
  host = await openPage('host');
  if (MP_NATIVE !== 'client') client = await openPage('client');
}
const waitFor = async (what, check, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(500);
  }
  say(`timeout waiting for ${what}`);
  return false;
};

const browserPages = [host, client].filter(Boolean);
const summary = { map: MAP, matchSeconds };
for (const page of browserPages) summary[page.name] = {};
let ok = true;
if (MP_GUI) {
  // Step 1: host page, base query only (no autostart): dismiss the start overlay, then
  // Multijugador > Crear partida > Continuar.
  await host.s('Page.navigate', { url: pageUrl(base) });
  say(`host page opened (GUI): ${pageUrl(base)}`);
  await sleep(25000);
  await host.click(491, 553);
  await sleep(2000);
  await host.click(180, 253);
  await sleep(2000);
  await host.click(418, 317);
  await sleep(3000);
  await host.click(748, 453);
  await host.shot(join(outdir, 'host-step1.png'));
  // Step 2: the room code the host shows in its page console (web_roomcode.js warn()).
  ok = await waitFor('the host Room code line', () => host.lines.some((l) => /Room code: (\d+)/.test(l)), 60000);
  const codeLine = host.lines.find((l) => /Room code: (\d+)/.test(l));
  const code = codeLine ? /Room code: (\d+)/.exec(codeLine)[1] : null;
  if (code) {
    summary.roomCode = code;
    say(`Room code: ${code}`);
  } else {
    say('no Room code line on the host page');
    ok = false;
  }
  // Step 2b: the relay lists the host's room once the host announced its name (0x03 META, T7.2a).
  if (ok) {
    const end = Date.now() + 20000;
    let room = null;
    for (;;) {
      try {
        const rooms = await fetchRooms();
        say(`rooms: ${JSON.stringify(rooms)}`);
        const found = (rooms && Array.isArray(rooms.rooms) ? rooms.rooms : [])
          .find((r) => String(r.code) === String(code) && typeof r.name === 'string' && r.name !== '');
        if (found) { room = found; break; }
      } catch (error) {
        say(`rooms fetch failed: ${error.message || error}`);
      }
      if (Date.now() >= end) break;
      await sleep(2000);
    }
    summary.roomListed = Boolean(room);
    summary.roomName = room ? room.name : null;
    say(`room listed: ${summary.roomListed}${room ? `, name ${room.name}` : ''}`);
    if (!room) ok = false;
  }
  // Step 3: client page, Conectar por IP, replace the server field's text with the code.
  if (ok) {
    // Both pages get their own default "Player NNNN" name from web_roomcode.js.
    await client.s('Page.navigate', { url: pageUrl(base) });
    say(`client page opened (GUI): ${pageUrl(base)}`);
    await sleep(25000);
    await client.click(491, 553);
    await sleep(2000);
    await client.click(180, 253);
    await sleep(2000);
    await client.click(418, 285);
    await sleep(3000);
    // The join dialog's "Open games" drop-down fills from the relay's room list within a few
    // seconds (web_roomcode.js polls Engine.WebRoomList every 2 s): capture it before typing.
    await sleep(5000);
    await client.shot(join(outdir, 'client-joindialog.png'));
    if (process.env.MP_GUI_LIST === '1') {
      // Pick the first open game from the drop-down instead of typing the code: its
      // SelectionChange writes the code into the server field.
      await client.click(748, 379);
      await sleep(1000);
      await client.shot(join(outdir, 'client-droplist.png'));
      await client.click(748, 403);
      await sleep(1000);
      await client.shot(join(outdir, 'client-picked.png'));
    } else {
      await client.click(748, 339);
      await sleep(1000);
      await client.key('End');
      for (let i = 0; i < 20; i++) await client.key('Backspace');
      for (const digit of code) await client.key(digit);
    }
    await sleep(1000);
    await client.click(748, 473);
    await client.shot(join(outdir, 'client-step3.png'));
    await host.shot(join(outdir, 'host-step3.png'));
    // Step 4: the client joins the host's game setup page and readies up (the bottom-right
    // button is "I'm ready" for a joining client), then the host starts the match.
    await sleep(20000);
    await client.click(1185, 681);
    await sleep(3000);
    await host.click(1185, 681);
    await host.shot(join(outdir, 'host-step4.png'));
    await client.shot(join(outdir, 'client-step4.png'));
    ok = await waitFor('both pages in the match', () => host.started && client.started, START_TIMEOUT);
  }
} else if (MP_NATIVE === 'host') {
  await client.s('Page.navigate', { url: pageUrl(clientQuery) });
  say(`client page opened: ${pageUrl(clientQuery)}`);
  ok = await waitFor('the browser page and the native side in the match', () => client.started && native.started, START_TIMEOUT);
} else {
  await host.s('Page.navigate', { url: pageUrl(hostQuery) });
  say(`host page opened: ${pageUrl(hostQuery)}`);
  ok = await waitFor('the host relay socket to bind', () => host.bound, 120000);
  if (ok && MP_NATIVE === 'client') {
    native = startNative('client');
    ok = await waitFor('the browser page and the native side in the match', () => host.started && native.started, START_TIMEOUT);
  } else if (ok) {
    await client.s('Page.navigate', { url: pageUrl(clientQuery) });
    say(`client page opened: ${pageUrl(clientQuery)}`);
    if (process.env.MP_STACKS) {
      await sleep(Number(process.env.MP_STACKS) * 1000);
      for (const page of browserPages) await dumpStack(page);
    }
    ok = await waitFor('both pages in the match', () => host.started && client.started, START_TIMEOUT);
  }
}
for (const page of browserPages)
  summary[page.name].visibility = await page.evaluate('document.visibilityState');
if (ok) {
  for (const page of browserPages) summary[page.name].statsAtStart = await page.stats();
  say(`stats at start: ${browserPages.map((page) => `${page.name} ${JSON.stringify(summary[page.name].statsAtStart)}`).join(' ')}`);
  for (let left = matchSeconds; left > 0; left -= 30) {
    await sleep(Math.min(30, left) * 1000);
    const parts = [];
    for (const page of browserPages) parts.push(`${page.name} ${JSON.stringify(await page.stats())}`);
    // What the native engine prints during the match: its turn/update lines, if any.
    if (native) parts.push(`native turn lines ${native.lines.filter((l) => /turn/i.test(l)).length}`);
    say(`in match: ${parts.join(' ')}`);
  }
}
for (const page of browserPages) {
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
if (native) {
  summary.native = {
    reachedMatch: Boolean(native.started),
    matchStartSeconds: native.started ? +((native.started - t0) / 1000).toFixed(1) : null,
    exited: native.proc.exitCode,
    desyncLines: native.lines.filter((l) => /out.of.sync|\bOOS\b|desync/i.test(l)),
    errorLines: native.lines.filter((l) => /ERROR|error:/.test(l)).slice(0, 40),
    turnLines: native.lines.filter((l) => /turn/i.test(l)).length,
  };
  // The engine writes this while it runs; copy it, never delete it.
  try { copyFileSync(join(homedir(), 'Library/Application Support/0ad/logs/mainlog.html'), join(outdir, 'native.mainlog.html')); }
  catch (error) { say(`native mainlog not copied: ${error.code || error}`); }
}
const grew = (p) => p.statsAtStart && p.stats && p.stats.sent > p.statsAtStart.sent && p.stats.received > p.statsAtStart.received;
// The match must still be connected at the end: a relay WebSocket is still open and no socket was
// closed after the match started (stats.sockets counts every socket ever opened, so it is not
// compared with stats.open).
const connected = (page, p) => p.stats && p.stats.open > 0 &&
  !page.lines.slice(page.matchLineIndex ?? 0).some((l) => l.includes('[zeroad-net]') && l.includes('closed'));
for (const page of browserPages) summary[page.name].connectedAtEnd = Boolean(connected(page, summary[page.name]));
// With a native side only one browser page is in the match, and the native side must have reached
// the match, still be running at the end and show no desync line. The two-browser rule is unchanged.
const nativeRunning = Boolean(native) && native.proc.exitCode === null && native.proc.signalCode === null;
summary.pass = Boolean(ok && browserPages.every((page) => {
  const p = summary[page.name];
  return p.reachedMatch && p.desyncLines.length === 0 && Boolean(grew(p)) && p.connectedAtEnd;
}) && (!native || (summary.native.reachedMatch && nativeRunning && summary.native.desyncLines.length === 0)) &&
  (!MP_GUI || summary.roomListed));
writeFileSync(join(outdir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
for (const page of browserPages) {
  const p = summary[page.name];
  say(`${page.name}: match ${p.reachedMatch} (at ${p.matchStartSeconds} s), connected at end ${p.connectedAtEnd}, bound ${p.bound}, visibility ${p.visibility}, pthread pool ${p.pthreadPool}, stats ${JSON.stringify(p.stats)}, desync lines ${p.desyncLines.length}, error lines ${p.errorLines.length}`);
  for (const l of p.desyncLines) say(`  ${page.name} desync: ${l}`);
}
if (native) {
  const p = summary.native;
  say(`native: match ${p.reachedMatch} (at ${p.matchStartSeconds} s), running at end ${nativeRunning}, exited ${p.exited}, turn lines ${p.turnLines}, desync lines ${p.desyncLines.length}, error lines ${p.errorLines.length}`);
  for (const l of p.desyncLines) say(`  native desync: ${l}`);
}
say(`PASS=${summary.pass}`);
cleanup();
process.exit(summary.pass ? 0 : 1);

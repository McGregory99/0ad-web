#!/usr/bin/env node
// End-to-end check of the web build in several browsers: run the same skirmish scenario
// (boot -> main menu -> single player -> skirmish -> START -> in the match -> measure fps ->
// screenshot) through tools/web/chrome-shot.mjs and tools/web/firefox-shot.mjs, one browser at
// a time, then parse each console.log and print PASS/FAIL per browser plus a summary JSON.
//
// Usage: node tools/web/e2e.mjs <build dir> <outdir> [port]   (port defaults to 8107)
// Env:
//   E2E_BROWSERS    comma list of browsers to run (default "chrome,firefox")
//   E2E_MIN_FPS     minimum fps in the match for a browser to pass (default 30)
//   E2E_MATCH_WAIT  seconds to wait in the match before measuring fps (default 40)
// The shot tools get the full game query '?arg=-mod=public&arg=-conf=windowed:true' and a 1280x720
// viewport; Chrome runs with CHROME_GPU=1 (real GPU, ANGLE Metal).
//
// Outputs: <outdir>/<browser>/console.log and PNGs from the shot tool, <outdir>/<browser>/tool.log
// (the shot tool's own stdout/stderr) and <outdir>/summary.json (one object per browser + pass).
// A browser passes when the shot tool exits 0, the log shows a "GAME STARTED" line, the measured
// fps is >= E2E_MIN_FPS and the log has no exception lines (error lines such as the harmless 404
// for a missing remote file do not fail the run; the known AI worker message
// "Cannot read properties of null (reading 'init')" is only counted as knownAiWorkerError).
// Exit code: 0 only if every selected browser passed, 1 otherwise, 2 on bad usage.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, outdir, port = '8107'] = process.argv.slice(2);
if (!dir || !outdir) {
  console.error('usage: e2e.mjs <build dir> <outdir> [port]');
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const browsers = (process.env.E2E_BROWSERS || 'chrome,firefox').split(',').map((b) => b.trim()).filter(Boolean);
const minFps = Number(process.env.E2E_MIN_FPS || 30);
const matchWait = Number(process.env.E2E_MATCH_WAIT || 40);
const TOOLS = { chrome: 'tools/web/chrome-shot.mjs', firefox: 'tools/web/firefox-shot.mjs' };
// Main menu -> single player -> skirmish -> START (default map), then the scenario steps.
const START = 'click:491:553,wait:2,click:180:221,wait:3,click:418:221,wait:8,click:1185:681';
const steps = `wait:25,shot:menu,${START},wait:${matchWait},stats,fps:10,shot:game`;
const query = '?arg=-mod=public&arg=-conf=windowed:true';
const KNOWN_AI_WORKER = "Cannot read properties of null (reading 'init')";

mkdirSync(outdir, { recursive: true });

const unknown = browsers.filter((b) => !TOOLS[b]);
if (unknown.length) {
  console.error(`unknown browser(s): ${unknown.join(',')} (known: ${Object.keys(TOOLS).join(',')})`);
  process.exit(2);
}

// Run one shot tool and wait for it to exit; its stdout/stderr go to <outdir>/<browser>/tool.log.
function runTool(browser) {
  const bdir = join(outdir, browser);
  mkdirSync(bdir, { recursive: true });
  const fd = openSync(join(bdir, 'tool.log'), 'w');
  const env = { ...process.env, ...(browser === 'chrome' ? { CHROME_GPU: '1' } : {}) };
  return new Promise((done) => {
    const child = spawn('node', [join(root, TOOLS[browser]), dir, bdir, steps, query, port], {
      env, stdio: ['ignore', fd, fd],
    });
    child.on('error', (e) => done({ code: null, error: e.message }));
    child.on('exit', (code, signal) => done({ code, signal }));
  });
}

// Turn a console.log into the facts the PASS rule needs.
function parseLog(browser) {
  const file = join(outdir, browser, 'console.log');
  const out = {
    consoleLog: file,
    reachedMatch: false,
    fps: null, frames: null, p50: null, p99: null, max: null,
    errorLines: [], exceptionLines: [], knownAiWorkerError: 0,
  };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const body = line.replace(/^\[[\d.]+\] /, '');
    const m = /^([\w/]+): (.*)$/.exec(body);
    const level = m ? m[1] : '';
    const text = m ? m[2] : body;
    if (text.includes('GAME STARTED')) out.reachedMatch = true;
    if (/^fps /.test(body)) {
      const payload = body.slice(4);
      let parsed = null;
      try { parsed = JSON.parse(payload); } catch { /* fall through to the regex */ }
      if (!parsed) {
        const g = (k) => {
          const r = new RegExp(`"${k}":(-?[\\d.]+)`).exec(payload);
          return r ? Number(r[1]) : null;
        };
        parsed = { frames: g('frames'), fps: g('fps'), p50: g('p50'), p99: g('p99'), max: g('max') };
      }
      for (const k of ['frames', 'fps', 'p50', 'p99', 'max']) {
        if (typeof parsed[k] === 'number') out[k] = parsed[k];
      }
    }
    const isException = level === 'exception';
    const isError = isException || level === 'error' || level.endsWith('/error');
    if (isError) {
      if (text.includes(KNOWN_AI_WORKER)) out.knownAiWorkerError++;
      else if (out.errorLines.length < 20) out.errorLines.push(line);
      if (isException && out.exceptionLines.length < 20) out.exceptionLines.push(line);
    }
  }
  return out;
}

const results = {};
let allPass = true;
for (const browser of browsers) {
  const started = new Date().toISOString();
  const run = await runTool(browser);
  const parsed = parseLog(browser);
  const reasons = [];
  if (run.code !== 0) reasons.push(run.error ? `tool failed: ${run.error}` : `tool exit ${run.code}${run.signal ? ` (${run.signal})` : ''}`);
  if (!parsed.reachedMatch) reasons.push('no GAME STARTED line');
  if (parsed.fps === null) reasons.push('no fps measurement');
  else if (parsed.fps < minFps) reasons.push(`fps ${parsed.fps} < ${minFps}`);
  if (parsed.exceptionLines.length) reasons.push(`${parsed.exceptionLines.length} exception line(s)`);
  const pass = reasons.length === 0;
  allPass = allPass && pass;
  results[browser] = {
    browser,
    startedAt: started,
    outdir: join(outdir, browser),
    toolExitCode: run.code,
    pass,
    reasons,
    reachedMatch: parsed.reachedMatch,
    fps: parsed.fps, frames: parsed.frames, p50: parsed.p50, p99: parsed.p99, max: parsed.max,
    errorLines: parsed.errorLines,
    exceptionLines: parsed.exceptionLines,
    knownAiWorkerError: parsed.knownAiWorkerError,
  };
  console.log(pass
    ? `${browser}: PASS fps=${parsed.fps} (p99=${parsed.p99 ?? 'n/a'} max=${parsed.max ?? 'n/a'})`
    : `${browser}: FAIL (${reasons.join('; ')})`);
}

writeFileSync(join(outdir, 'summary.json'), JSON.stringify({
  build: dir, port: Number(port), minFps, matchWait, steps, query,
  browsers: results, pass: allPass,
}, null, 2) + '\n');
console.log(`summary: ${join(outdir, 'summary.json')}`);
console.log(`PASS=${allPass}`);
process.exit(allPass ? 0 : 1);

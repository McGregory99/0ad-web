// Preload for the Node wasm replay: CPU-profile the main thread between two "Turn N" lines.
// Usage: NODE_OPTIONS="--require <this file>" TURNPROF_FROM=<n> TURNPROF_TO=<m> TURNPROF_OUT=<file.cpuprofile> ...
// Profiling starts when "Turn <from>" is printed and stops at "Turn <to>"; "Turn N" is printed
// when turn N starts, so the profile covers turns from .. to-1.
'use strict';
const inspector = require('node:inspector');
const fs = require('node:fs');
const from = Number(process.env.TURNPROF_FROM), to = Number(process.env.TURNPROF_TO), outFile = process.env.TURNPROF_OUT;
if (from >= 0 && to > from && outFile) {
  const session = new inspector.Session();
  session.connect();
  let state = 'idle';
  const onText = (text) => {
    const m = /^Turn (\d+)/m.exec(String(text));
    if (!m) return;
    const n = Number(m[1]);
    if (state === 'idle' && n === from) {
      state = 'running';
      session.post('Profiler.enable');
      session.post('Profiler.setSamplingInterval', { interval: 100 });
      session.post('Profiler.start');
    } else if (state === 'running' && n >= to) {
      state = 'done';
      session.post('Profiler.stop', (err, result) => {
        fs.writeFileSync(outFile, JSON.stringify(err ? { error: String(err) } : result.profile));
      });
    }
  };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { onText(chunk); return write(chunk, ...rest); };
  // With NODERAWFS, printf reaches fd 1/2 through fs.writeSync.
  const writeSync = fs.writeSync;
  fs.writeSync = function (fd, buf, ...rest) {
    if (fd === 1 || fd === 2) {
      if (typeof buf === 'string') onText(buf);
      else {
        const offset = typeof rest[0] === 'number' ? rest[0] : 0;
        const length = typeof rest[1] === 'number' ? rest[1] : buf.byteLength - offset;
        onText(Buffer.from(buf.buffer, buf.byteOffset + offset, length).toString());
      }
    }
    return writeSync.call(this, fd, buf, ...rest);
  };
  const log = console.log.bind(console);
  console.log = (...args) => { onText(args.join(' ')); return log(...args); };
}

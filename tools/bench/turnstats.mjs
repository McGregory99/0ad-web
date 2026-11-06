// Reads replay output on stdin; timestamps each "Turn N" line and prints per-turn cost stats.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
let last = null, lastTurn = null; const d = []; let final = '';
rl.on('line', (l) => {
  const m = /^Turn (\d+)/.exec(l); const t = performance.now();
  if (m) { if (last !== null) d.push([lastTurn, t - last]); last = t; lastTurn = +m[1]; }
  if (l.includes('Final state')) final = l;
});
rl.on('close', () => {
  const v = d.map((x) => x[1]).sort((a, b) => a - b); const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const sum = v.reduce((a, b) => a + b, 0);
  console.log(final); console.log(`turns=${v.length} total=${(sum / 1000).toFixed(1)}s avg=${(sum / v.length).toFixed(2)}ms p50=${q(0.5).toFixed(2)} p95=${q(0.95).toFixed(2)} p99=${q(0.99).toFixed(2)} max=${v[v.length - 1].toFixed(2)}`);
  console.log('over 50ms:', v.filter((x) => x > 50).length, 'over 100ms:', v.filter((x) => x > 100).length, 'over 200ms:', v.filter((x) => x > 200).length);
  console.log('top10:', d.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, ms]) => `${t}:${ms.toFixed(0)}`).join(' '));
});

// Summarize a .cpuprofile: top functions by self time and by inclusive time.
// Usage: node tools/bench/profsummary.mjs <file.cpuprofile> [top=40]
import fs from 'node:fs';
const [file, topArg = '40'] = process.argv.slice(2);
const top = Number(topArg);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const hits = new Map();
p.samples.forEach((id, i) => hits.set(id, (hits.get(id) || 0) + (p.timeDeltas[i] || 0)));
const label = (n) => `${n.callFrame.functionName || '(anon)'}${n.callFrame.url ? ' ' + n.callFrame.url.split('/').pop() : ''}`;
const self = new Map(), incl = new Map();
let total = 0;
for (const [id, us] of hits) {
  total += us;
  const n = byId.get(id);
  self.set(label(n), (self.get(label(n)) || 0) + us);
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const l = label(byId.get(cur));
    if (seen.has(l)) continue;
    seen.add(l);
    incl.set(l, (incl.get(l) || 0) + us);
  }
}
const fmt = (m) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top)
  .map(([l, us]) => `${(us / 1000).toFixed(1).padStart(8)} ms ${(100 * us / total).toFixed(1).padStart(5)}%  ${l.slice(0, 140)}`).join('\n');
console.log(`total ${(total / 1000).toFixed(1)} ms\n== self\n${fmt(self)}\n== inclusive\n${fmt(incl)}`);

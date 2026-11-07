// Tests for sm-sort.js (SpiderMonkey 128 comparator sort). Run: node tools/wasm/ai/sm-sort.test.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const { install } = createRequire(import.meta.url)('./sm-sort.js');

const realm = vm.createContext({});
install(realm.Array ? realm : vm.runInContext('globalThis', realm));
const run = (code) => vm.runInContext(code, realm);

// Stable for consistent comparators, on both the insertion (<= 8) and merge (> 8) paths.
for (const n of [0, 1, 2, 7, 8, 9, 16, 33, 100]) {
	const out = run(`Array.from({length: ${n}}, (_, i) => ({k: (i * 7) % 3, i})).sort((a, b) => a.k - b.k)`);
	for (let i = 1; i < n; i++)
		assert.ok(out[i - 1].k < out[i].k || (out[i - 1].k === out[i].k && out[i - 1].i < out[i].i), `stable n=${n}`);
}
// undefined sorts last without calling the comparator; holes are removed to the end.
assert.equal(run(`let c = 0; const a = [3, undefined, 1, , 2]; a.sort((x, y) => { c++; if (x === undefined || y === undefined) throw 1; return x - y; }); JSON.stringify([a, a.length, 3 in a, 4 in a])`),
	'[[1,2,3,null,null],5,true,false]');
// No comparator: native default sort; non-callable comparator: TypeError; returns the receiver.
assert.equal(run(`[10, 9, 1].sort().join()`), '1,10,9');
assert.throws(() => run(`[2, 1].sort(5)`), /sort/);
assert.equal(run(`const r = [2, 1]; r.sort((a, b) => a - b) === r`), true);
// NaN results count as "in order" (RvalIsLessOrEqual).
assert.equal(run(`[3, 1, 2].sort(() => NaN).join()`), '3,1,2');
// Typed arrays with a comparator.
assert.equal(run(`new Int32Array([5, -1, 3, 0, 9, 8, 7, 6, 2, 4]).sort((a, b) => b - a).join()`), '9,8,7,6,5,4,3,2,0,-1');
// The property keeps the built-in attributes.
const desc = run(`Object.getOwnPropertyDescriptor(Array.prototype, 'sort')`);
assert.deepEqual([desc.writable, desc.enumerable, desc.configurable], [true, false, true]);
console.log('sm-sort tests passed');

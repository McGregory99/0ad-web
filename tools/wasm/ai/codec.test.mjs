// Tests for codec.js: lossless round trips, and the copy embedded in CCmpAIManager.cpp must match.
// Usage: node tools/wasm/ai/codec.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Codec = require('./codec.js');
const here = new URL('.', import.meta.url);

const roundTrip = (value) => Codec.decode(Codec.encode(value));
const value = {
	n: 1.5, i: 7, neg0: -0, nan: NaN, inf: Infinity, ninf: -Infinity, u: undefined,
	s: 'text', zs: '\u0000s', arr: [1, undefined, null, 'x'],
	set: new Set([1, 'a', { b: 2 }]), map: new Map([[1, 'one'], ['k', new Set([3])]]),
	u16: new Uint16Array([1, 65535]), u8: new Uint8Array([0, 255]), f64: new Float64Array([0.1, -0]),
	nested: { deep: [{ x: undefined }] },
};
const back = roundTrip(value);
assert.deepEqual(back, value);
assert.ok(Object.is(back.neg0, -0) && Number.isNaN(back.nan));
assert.ok('u' in back && 'x' in back.nested.deep[0]);
assert.ok(back.set instanceof Set && back.map.get('k') instanceof Set);
assert.ok(back.u16 instanceof Uint16Array && Object.is(back.f64[1], -0));
assert.equal(roundTrip(undefined), undefined);

// Values from another realm (the simulation realm in SpiderMonkey) use brand checks.
const other = vm.runInNewContext('({ s: new Set([1]), m: new Map([[2, 3]]), t: new Uint8Array([4]) })');
const otherBack = roundTrip(other);
assert.ok(otherBack.s instanceof Set && otherBack.s.has(1));
assert.equal(otherBack.m.get(2), 3);
assert.ok(otherBack.t instanceof Uint8Array);

// The embedded copy in CCmpAIManager.cpp is the same code.
const body = (text, start) => {
	const from = text.indexOf(start);
	assert.ok(from >= 0, start);
	const to = text.indexOf('\n})();', from);
	return text.slice(from + start.length, to).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
};
const cpp = fs.readFileSync(new URL('../../../upstream/source/simulation2/components/CCmpAIManager.cpp', here), 'utf8');
const js = fs.readFileSync(new URL('codec.js', here), 'utf8');
assert.deepEqual(body(cpp, 'const Codec = (function() {'), body(js, 'var ZeroADCodec = (function() {'));
console.log('codec tests passed');

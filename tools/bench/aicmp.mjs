// Compares two AI command logs written with ZEROAD_AI_LOG (CCmpAIManager.cpp): per turn, the
// commands every AI pushed and the AI RNG state after the turn.
// Usage: node tools/bench/aicmp.mjs <a.ailog> <b.ailog> [a.stats b.stats]
//   Exit 0 when the logs (and the "Final state" hashes of the optional .stats files) are equal.
import fs from 'node:fs';

function readTurns(file) {
	const turns = [];
	let turn = null;
	for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
		if (line.startsWith('T ')) {
			const [, n, count, rng] = line.split(' ');
			turn = { n: +n, count: +count, rng, commands: [] };
			turns.push(turn);
		} else if (line.startsWith('C ') && turn) {
			turn.commands.push(line.slice(2));
		}
	}
	return turns;
}

const [aFile, bFile, aStats, bStats] = process.argv.slice(2);
if (!aFile || !bFile) {
	console.error('usage: node aicmp.mjs <a.ailog> <b.ailog> [a.stats b.stats]');
	process.exit(2);
}
const a = readTurns(aFile);
const b = readTurns(bFile);
const commands = (turns) => turns.reduce((sum, t) => sum + t.commands.length, 0);
console.log(`${aFile}: ${a.length} turns, ${commands(a)} commands`);
console.log(`${bFile}: ${b.length} turns, ${commands(b)} commands`);

let equal = true;
const n = Math.min(a.length, b.length);
for (let i = 0; i < n; ++i) {
	const x = a[i], y = b[i];
	const diff = x.rng !== y.rng ? 'rng' :
		x.commands.length !== y.commands.length ? 'command count' :
		x.commands.findIndex((c, j) => c !== y.commands[j]) >= 0 ? 'command' : null;
	if (!diff)
		continue;
	equal = false;
	console.log(`FIRST DIVERGENCE at turn ${x.n}: ${diff} differs`);
	console.log(`  a: rng ${x.rng}, ${x.commands.length} commands`);
	console.log(`  b: rng ${y.rng}, ${y.commands.length} commands`);
	const j = x.commands.findIndex((c, k) => c !== y.commands[k]);
	if (j >= 0) {
		console.log(`  a[${j}]: ${String(x.commands[j]).slice(0, 400)}`);
		console.log(`  b[${j}]: ${String(y.commands[j]).slice(0, 400)}`);
	}
	break;
}
if (equal && a.length !== b.length) {
	equal = false;
	console.log(`logs equal for ${n} turns, then one log ends (${a.length} vs ${b.length} turns)`);
}
if (equal)
	console.log(`AI command logs identical: ${n} turns`);

if (aStats && bStats) {
	const hash = (file) => (/Final state: (\S+)/.exec(fs.readFileSync(file, 'utf8')) || [, 'none'])[1];
	const ha = hash(aStats), hb = hash(bStats);
	console.log(`final state hashes: ${ha} ${hb} ${ha === hb ? 'equal' : 'DIFFERENT'}`);
	equal = equal && ha === hb && ha !== 'none';
}
process.exit(equal ? 0 : 1);

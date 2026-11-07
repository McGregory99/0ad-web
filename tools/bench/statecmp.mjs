// Compares the per-computation AI input digests of the in-process AI ("ST"/"SD" lines in the
// replay output) and the remote AI (worker trace file), written with ZEROAD_AI_TRACE_STATE
// (CCmpAIManager.cpp, tools/wasm/ai/ai-worker.js). Reports the first computation whose game
// state or maps differ, and the computations in which the AI changed its state objects.
// Usage: node tools/bench/statecmp.mjs <in-process output or raw.tsv> <worker trace>
import fs from 'node:fs';

function read(file) {
	const rows = [];
	for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
		const line = raw.replace(/^[\d.]+\t/, '');
		if (line.startsWith('ST ')) {
			const [, n, state, length, pass, terr, mutated] = line.split(' ');
			rows.push({ n: +n, state, length: +length, pass, terr, mutated: mutated === '1', diff: [] });
		} else if (line.startsWith('SD ') && rows.length) {
			rows[rows.length - 1].diff.push(line);
		}
	}
	return rows;
}

const [aFile, bFile] = process.argv.slice(2);
const a = read(aFile), b = read(bFile);
console.log(`${a.length} and ${b.length} computations`);
const mutatedA = a.filter((r) => r.mutated), mutatedB = b.filter((r) => r.mutated);
console.log(`AI changed its input state: in-process ${mutatedA.length} times, remote ${mutatedB.length} times`);
for (const r of mutatedA.slice(0, 3))
	console.log(`  in-process computation ${r.n}:\n    ${r.diff.join('\n    ')}`);
for (let i = 0; i < Math.min(a.length, b.length); ++i) {
	const x = a[i], y = b[i];
	const fields = ['state', 'length', 'pass', 'terr'].filter((f) => x[f] !== y[f]);
	if (fields.length) {
		console.log(`first difference at computation ${x.n}: ${fields.join(', ')}`);
		console.log(`  in-process: ${JSON.stringify(x)}`);
		console.log(`  remote:     ${JSON.stringify(y)}`);
		process.exit(1);
	}
}
console.log('no input difference in the common prefix');

// Finds the first Math call whose result differs between the in-process AI (SpiderMonkey, "MT"
// lines in the replay output) and the remote AI (worker trace file). Both written with
// ZEROAD_AI_TRACE_MATH (CCmpAIManager.cpp, tools/wasm/ai/ai-worker.js).
// Usage: node tools/bench/mathcmp.mjs <in-process output or raw.tsv> <worker trace>
import fs from 'node:fs';

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n')
	.map((l) => l.replace(/^[\d.]+\t/, '')).filter((l) => l.startsWith('MT '));
const [aFile, bFile] = process.argv.slice(2);
const a = lines(aFile), b = lines(bFile);
console.log(`${a.length} and ${b.length} traced lines`);
let compute = 0;
for (let i = 0; i < Math.min(a.length, b.length); ++i) {
	if (a[i] === 'MT compute')
		++compute;
	if (a[i] !== b[i]) {
		console.log(`first difference at line ${i} (computation ${compute}):`);
		console.log(`  in-process: ${a[i]}`);
		console.log(`  remote:     ${b[i]}`);
		process.exit(1);
	}
}
console.log('no difference in the common prefix');

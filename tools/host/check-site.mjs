// check-site.mjs -- verify that a host serves a packaged 0 A.D. web build correctly.
//
// Usage: node tools/host/check-site.mjs <base url>
//   e.g. node tools/host/check-site.mjs http://127.0.0.1:8108/
//
// Run it against the local test server while preparing a deploy, and against the
// public URL after the upload. It only reads; nothing is uploaded or changed.
//
// Checks (each printed as `ok` or `FAIL` with the observed value):
//   1. the page: 200, COOP: same-origin, COEP: require-corp
//   2. pyrogenesis.wasm: Content-Type application/wasm, CORP header
//   3. pyrogenesis.js: Content-Type contains "javascript"
//   4. remote-files.json: 200 and valid JSON; its first entry gives the zip path
//   5. that zip with `Range: bytes=0-65535`: 206, Content-Range, 65536 bytes,
//      no Content-Encoding (compression must be off for the zips)
//   6. licenses/licenses.html: 200 and no SOURCE_URL placeholder left
//
// Exit code 0 if every check passes, 1 otherwise. Only Node built-ins are used.
//
// Note on CORP: `Cross-Origin-Resource-Policy` is required for *cross-origin*
// subresources under COEP require-corp; the local reference server
// tools/spikes/serve.mjs does not send it and the game still runs, because the
// build is served from one origin. Check 2 therefore reports a missing CORP as
// `warn` (not a failure), but a real host should send it anyway.

let failures = 0;

function report(level, name, detail) {
	if (level === 'FAIL') failures++;
	console.log(`${level.padEnd(4)}  ${name}: ${detail}`);
}

function ok(name, detail) { report('ok', name, detail); }
function fail(name, detail) { report('FAIL', name, detail); }
function warn(name, detail) { report('warn', name, detail); }

const arg = process.argv[2];
if (!arg) {
	console.error('usage: node tools/host/check-site.mjs <base url>');
	process.exit(2);
}
const base = arg.endsWith('/') ? arg : arg + '/';

const url = (rel) => new URL(rel, base).href;

// 1. The page itself: cross-origin isolation headers.
try {
	const res = await fetch(url(''));
	const coop = res.headers.get('cross-origin-opener-policy');
	const coep = res.headers.get('cross-origin-embedder-policy');
	const body = await res.text();
	if (res.status !== 200) fail('page status', `${res.status} (expected 200)`);
	else ok('page status', '200');
	if (coop === 'same-origin') ok('page COOP', coop);
	else fail('page COOP', `${coop} (expected same-origin)`);
	if (coep === 'require-corp') ok('page COEP', coep);
	else fail('page COEP', `${coep} (expected require-corp)`);
	if (body.length === 0) fail('page body', 'empty');
} catch (e) {
	fail('page', `request failed: ${e.message}`);
}

// 2. The wasm module: MIME type matters, otherwise streaming compilation is refused.
try {
	const res = await fetch(url('pyrogenesis.wasm'));
	const type = res.headers.get('content-type');
	const corp = res.headers.get('cross-origin-resource-policy');
	if (res.status !== 200) fail('wasm status', `${res.status} (expected 200)`);
	if (type && type.split(';')[0].trim() === 'application/wasm') ok('wasm content-type', type);
	else fail('wasm content-type', `${type} (expected application/wasm)`);
	if (corp) ok('wasm CORP', corp);
	else warn('wasm CORP', 'absent (allowed for same-origin; required for cross-origin)');
	// Do not download 16 MB just to look at headers.
	if (res.body) await res.body.cancel();
} catch (e) {
	fail('wasm', `request failed: ${e.message}`);
}

// 3. The loader script.
try {
	const res = await fetch(url('pyrogenesis.js'));
	const type = res.headers.get('content-type');
	if (res.status !== 200) fail('js status', `${res.status} (expected 200)`);
	if (type && type.includes('javascript')) ok('js content-type', type);
	else fail('js content-type', `${type} (expected text/javascript)`);
	if (res.body) await res.body.cancel();
} catch (e) {
	fail('js', `request failed: ${e.message}`);
}

// 4. remote-files.json: shape is an array of {path, url, size}; `url` is relative
// to the page and points at the zip the engine downloads with Range requests.
let zipUrl = null;
try {
	const res = await fetch(url('remote-files.json'));
	if (res.status !== 200) {
		fail('remote-files.json status', `${res.status} (expected 200)`);
		if (res.body) await res.body.cancel();
	} else {
		const text = await res.text();
		let data;
		try {
			data = JSON.parse(text);
		} catch (e) {
			fail('remote-files.json parse', e.message);
			data = null;
		}
		if (data) {
			if (!Array.isArray(data)) fail('remote-files.json shape', `expected an array, got ${typeof data}`);
			else if (data.length === 0) fail('remote-files.json entries', 'array is empty');
			else if (!data[0].url) fail('remote-files.json entry', `first entry has no url: ${JSON.stringify(data[0])}`);
			else {
				zipUrl = data[0].url;
				ok('remote-files.json', `${data.length} entries, first zip ${zipUrl} (${data[0].size} bytes)`);
			}
		}
	}
} catch (e) {
	fail('remote-files.json', `request failed: ${e.message}`);
}

// 5. The zip must answer Range with 206 and 65536 bytes, uncompressed.
if (!zipUrl) {
	fail('zip range', 'skipped: no zip path from remote-files.json');
} else {
	try {
		const res = await fetch(url(zipUrl), { headers: { Range: 'bytes=0-65535' } });
		const cr = res.headers.get('content-range');
		const enc = res.headers.get('content-encoding');
		const buf = Buffer.from(await res.arrayBuffer());
		if (res.status === 206) ok('zip range status', '206');
		else fail('zip range status', `${res.status} (expected 206 Partial Content)`);
		if (cr) ok('zip Content-Range', cr);
		else fail('zip Content-Range', 'absent');
		if (buf.length === 65536) ok('zip range body', `${buf.length} bytes`);
		else fail('zip range body', `${buf.length} bytes (expected 65536)`);
		if (enc) fail('zip Content-Encoding', `${enc} (compression must be off for zips)`);
		else ok('zip Content-Encoding', 'absent (uncompressed)');
	} catch (e) {
		fail('zip range', `request failed: ${e.message}`);
	}
}

// 6. The licenses page must no longer contain the SOURCE_URL placeholder.
try {
	const res = await fetch(url('licenses/licenses.html'));
	if (res.status !== 200) {
		fail('licenses status', `${res.status} (expected 200)`);
		if (res.body) await res.body.cancel();
	} else {
		const text = await res.text();
		if (text.includes('SOURCE_URL')) fail('licenses SOURCE_URL', 'placeholder still present');
		else ok('licenses SOURCE_URL', 'absent (source URL filled in)');
	}
} catch (e) {
	fail('licenses', `request failed: ${e.message}`);
}

console.log(failures === 0 ? '\nall checks ok' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

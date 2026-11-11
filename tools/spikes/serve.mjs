// Static file server for browser tests: COOP/COEP headers (needed for SharedArrayBuffer/pthreads)
// and HTTP Range support. Usage: node serve.mjs <root-dir> [port]
// Env SERVE_KBPS limits the total response bandwidth (kilobits per second, shared by all
// connections) and SERVE_LATENCY_MS delays each response, to emulate a real network.
// Env SERVE_HOST sets the listen address (default 127.0.0.1; 0.0.0.0 serves the local network).
// Env SERVE_TLS_CERT and SERVE_TLS_KEY (PEM files) serve HTTPS: other devices need it, because
// browsers only allow cross-origin isolation on https or localhost.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8080);
const kbps = Number(process.env.SERVE_KBPS || 0);
const latencyMs = Number(process.env.SERVE_LATENCY_MS || 0);
const bytesPerMs = kbps * 1000 / 8 / 1000;
let nextFree = 0;
// One shared FIFO link: each chunk waits until the link has sent everything queued before it.
const reserve = (n) => {
	const now = performance.now();
	nextFree = Math.max(now, nextFree) + n / bytesPerMs;
	return new Promise((r) => setTimeout(r, nextFree - now));
};
async function send(res, stream) {
	if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
	if (!bytesPerMs) { stream.pipe(res); return; }
	res.on('close', () => stream.destroy());
	try {
		for await (const chunk of stream) {
			await reserve(chunk.length);
			if (res.destroyed) return;
			if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
		}
		res.end();
	} catch { res.destroy(); }
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

const host = process.env.SERVE_HOST || '127.0.0.1';
const tls = process.env.SERVE_TLS_CERT && process.env.SERVE_TLS_KEY
	? { cert: fs.readFileSync(process.env.SERVE_TLS_CERT), key: fs.readFileSync(process.env.SERVE_TLS_KEY) } : null;
const handler = (req, res) => {
	const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
	let file = path.join(root, urlPath);
	if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
	if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
	fs.stat(file, (err, st) => {
		if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
		const headers = {
			'Content-Type': types[path.extname(file)] || 'application/octet-stream',
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cache-Control': 'no-store',
			'Accept-Ranges': 'bytes',
		};
		const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
		if (m) {
			const start = Number(m[1]);
			const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
			if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
			res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
			send(res, fs.createReadStream(file, { start, end, highWaterMark: 16384 }));
			return;
		}
		res.writeHead(200, { ...headers, 'Content-Length': st.size });
		send(res, fs.createReadStream(file, { highWaterMark: 16384 }));
	});
};
(tls ? https.createServer(tls, handler) : http.createServer(handler))
	.listen(port, host, () => console.log(`serving ${root} on ${tls ? 'https' : 'http'}://${host}:${port}/`));

// Static file server for browser tests: COOP/COEP headers (needed for SharedArrayBuffer/pthreads)
// and HTTP Range support. Usage: node serve.mjs <root-dir> [port]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8080);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
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
			fs.createReadStream(file, { start, end }).pipe(res);
			return;
		}
		res.writeHead(200, { ...headers, 'Content-Length': st.size });
		fs.createReadStream(file).pipe(res);
	});
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));

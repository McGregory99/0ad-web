#!/usr/bin/env node
// UDP relay for the browser build's ENet tunnel (T7.1b, wire protocol in PROTOCOL.md).
// Each WebSocket session owns one UDP socket on this machine; the relay forwards datagrams
// between the WebSocket and that socket, so browser hosts get a real UDP port that browsers
// (through their own sessions) and native 0 A.D. clients can reach.
//
// Usage: node tools/relay/relay.mjs
// Env:
//   RELAY_HOST       WebSocket listen address (default 127.0.0.1; 0.0.0.0 for the local network)
//   RELAY_PORT       WebSocket listen port (default 20600)
//   RELAY_TLS_CERT, RELAY_TLS_KEY   PEM files: serve wss:// (needed when the page uses https)
//   RELAY_PUBLIC_IP  IPv4 reported in BOUND (default 0.0.0.0 = unknown)
//   RELAY_UDP_MIN, RELAY_UDP_MAX    port range for BIND 0 (default: any free port)
//   RELAY_DEST       destination policy: "any" (default when RELAY_HOST is loopback) or "public"
//                    (only public unicast addresses and this relay's own sessions; default otherwise)
//   RELAY_IDLE_MS    close sessions idle this long (default 120000)
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const BIND = 0x01, SEND = 0x02, BOUND = 0x81, ERROR = 0x82, RECV = 0x83;
export const MAX_PAYLOAD = 4096;
const HEADER = 7; // type + ipv4 + port

// The `ws` package: installed next to the relay in production, otherwise the copy bundled with emsdk.
async function loadWs() {
	try {
		return await import('ws');
	} catch {
		const require = createRequire(import.meta.url);
		return require(fileURLToPath(new URL('../emsdk/upstream/emscripten/node_modules/ws/index.js', import.meta.url)));
	}
}

const ipToBytes = (ip) => ip.split('.').map(Number);
const bytesToIp = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const isLoopback = (ip) => ip.startsWith('127.');

// Private, loopback, link-local, CGNAT, multicast, reserved and unspecified IPv4 ranges.
export function isPublicIPv4(ip) {
	const [a, b] = ipToBytes(ip);
	return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
}

function frame(type, ip, port, payload) {
	const out = Buffer.allocUnsafe(HEADER + (payload ? payload.length : 0));
	out[0] = type;
	const ipb = ipToBytes(ip);
	for (let i = 0; i < 4; i++) out[1 + i] = ipb[i];
	out.writeUInt16BE(port, 5);
	if (payload) payload.copy(out, HEADER);
	return out;
}

export async function startRelay(options = {}) {
	const host = options.host ?? process.env.RELAY_HOST ?? '127.0.0.1';
	const port = Number(options.port ?? process.env.RELAY_PORT ?? 20600);
	const publicIp = options.publicIp ?? process.env.RELAY_PUBLIC_IP ?? '0.0.0.0';
	const udpMin = Number(options.udpMin ?? process.env.RELAY_UDP_MIN ?? 0);
	const udpMax = Number(options.udpMax ?? process.env.RELAY_UDP_MAX ?? 0);
	const dest = options.dest ?? process.env.RELAY_DEST ?? (isLoopback(host) ? 'any' : 'public');
	const idleMs = Number(options.idleMs ?? process.env.RELAY_IDLE_MS ?? 120000);
	const cert = options.cert ?? process.env.RELAY_TLS_CERT;
	const key = options.key ?? process.env.RELAY_TLS_KEY;
	const log = options.log ?? ((line) => console.log(`[relay] ${line}`));
	if (dest !== 'any' && dest !== 'public') throw new Error(`RELAY_DEST must be "any" or "public", not "${dest}"`);

	const { WebSocketServer } = await loadWs();
	const server = cert && key
		? https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) })
		: http.createServer();
	const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
	const boundPorts = new Set();
	const stats = { sessions: 0, toUdp: 0, toWs: 0, dropped: 0 };
	let nextId = 1;

	// A session's own port on this relay, reached by loopback or by the relay's public address.
	const isRelaySession = (ip, p) => boundPorts.has(p) && (isLoopback(ip) || ip === publicIp);
	const allowed = (ip, p) => p !== 0 && (dest === 'any' || isRelaySession(ip, p) || isPublicIPv4(ip));

	function bindUdp(socket, wanted) {
		return new Promise((resolve, reject) => {
			const tryPort = (p) => {
				const onError = (error) => {
					socket.removeListener('listening', onListening);
					if (wanted === 0 && udpMin && p < udpMax) tryPort(p + 1);
					else reject(error);
				};
				const onListening = () => {
					socket.removeListener('error', onError);
					resolve(socket.address().port);
				};
				socket.once('error', onError);
				socket.once('listening', onListening);
				socket.bind(p, '0.0.0.0');
			};
			tryPort(wanted === 0 && udpMin ? udpMin : wanted);
		});
	}

	wss.on('connection', (ws, request) => {
		const id = nextId++;
		const who = `#${id} ${request.socket.remoteAddress}`;
		let udp = null, udpPort = 0, closed = false, binding = false, lastActive = Date.now();
		stats.sessions++;
		const close = (reason) => {
			if (closed) return;
			closed = true;
			clearInterval(idleTimer);
			if (udp) {
				boundPorts.delete(udpPort);
				udp.close();
			}
			if (ws.readyState === ws.OPEN) ws.close();
			log(`${who} closed (${reason})`);
		};
		const fail = (text) => {
			if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([ERROR]), Buffer.from(text)]));
			close(text);
		};
		const idleTimer = setInterval(() => { if (Date.now() - lastActive > idleMs) close('idle'); }, Math.min(idleMs, 10000));

		ws.on('message', async (data, isBinary) => {
			lastActive = Date.now();
			const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
			if (!isBinary || buf.length === 0) return fail('binary messages only');
			// The UDP socket is still binding: nothing can be sent or bound twice yet.
			if (binding) { stats.dropped++; return; }
			if (!udp) {
				if (buf[0] !== BIND || buf.length !== 3) return fail('first message must be BIND');
				const wanted = buf.readUInt16BE(1);
				const socket = dgram.createSocket('udp4');
				binding = true;
				try {
					udpPort = await bindUdp(socket, wanted);
				} catch (error) {
					socket.close();
					binding = false;
					return closed ? undefined : fail(`bind ${wanted}: ${error.code ?? error.message}`);
				}
				binding = false;
				if (closed) { socket.close(); return; }
				udp = socket;
				boundPorts.add(udpPort);
				udp.on('message', (msg, rinfo) => {
					lastActive = Date.now();
					if (msg.length > MAX_PAYLOAD || ws.bufferedAmount > 1 << 20) { stats.dropped++; return; }
					ws.send(frame(RECV, rinfo.address, rinfo.port, msg));
					stats.toWs++;
				});
				udp.on('error', (error) => fail(`udp: ${error.code ?? error.message}`));
				ws.send(frame(BOUND, publicIp, udpPort));
				log(`${who} bound udp ${udpPort}`);
				return;
			}
			if (buf[0] === BIND) return fail('BIND sent twice');
			// SEND before BOUND is ignored (the UDP socket is still binding).
			if (buf[0] !== SEND || buf.length < HEADER || !udpPort) { stats.dropped++; return; }
			const ip = bytesToIp(buf, 1), p = buf.readUInt16BE(5);
			if (buf.length - HEADER > MAX_PAYLOAD || !allowed(ip, p)) { stats.dropped++; return; }
			udp.send(buf.subarray(HEADER), p, ip);
			stats.toUdp++;
		});
		ws.on('close', () => close('websocket closed'));
		ws.on('error', (error) => close(`websocket: ${error.message}`));
		log(`${who} connected`);
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});
	const address = server.address();
	log(`listening on ${cert && key ? 'wss' : 'ws'}://${host}:${address.port}/ (dest policy ${dest})`);
	return {
		port: address.port,
		stats,
		close: () => new Promise((resolve) => {
			for (const client of wss.clients) client.terminate();
			wss.close(() => server.close(() => resolve()));
		}),
	};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
	startRelay().catch((error) => {
		console.error(`[relay] ${error.message}`);
		process.exit(1);
	});
}

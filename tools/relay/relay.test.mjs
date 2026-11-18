// Tests for the ENet tunnel relay (PROTOCOL.md). Run: node --test tools/relay/relay.test.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { after, before, test } from 'node:test';
import { BIND, BOUND, ERROR, MAX_PAYLOAD, RECV, SEND, isPublicIPv4, startRelay } from './relay.mjs';

let relay;
before(async () => { relay = await startRelay({ port: 0, log: () => {} }); });
after(() => relay.close());

// A WebSocket client that collects binary messages and lets tests await the next one.
async function connect(url = `ws://127.0.0.1:${relay.port}/`) {
	const ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	const queue = [], waiters = [];
	ws.addEventListener('message', (ev) => {
		const msg = Buffer.from(ev.data);
		waiters.length ? waiters.shift()(msg) : queue.push(msg);
	});
	const closed = new Promise((r) => ws.addEventListener('close', r, { once: true }));
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	const next = (ms = 2000) => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('no message')), ms);
		waiters.push((m) => { clearTimeout(t); resolve(m); });
	});
	return { ws, next, closed };
}

const bindMsg = (port) => Buffer.from([BIND, port >> 8, port & 0xff]);
const sendMsg = (ip, port, payload) => Buffer.concat([Buffer.from([SEND, ...ip.split('.').map(Number), port >> 8, port & 0xff]), payload]);
const parse = (m) => ({ type: m[0], ip: `${m[1]}.${m[2]}.${m[3]}.${m[4]}`, port: m.readUInt16BE(5), payload: m.subarray(7) });

async function bound(client, port = 0) {
	client.ws.send(bindMsg(port));
	const reply = parse(await client.next());
	assert.equal(reply.type, BOUND);
	assert.ok(reply.port > 0);
	return reply.port;
}

async function udpPeer() {
	const sock = dgram.createSocket('udp4');
	await new Promise((r) => sock.bind(0, '127.0.0.1', r));
	const received = [];
	sock.on('message', (msg, rinfo) => received.push({ msg, rinfo }));
	return { sock, port: sock.address().port, received };
}
const until = async (cond, ms = 2000) => {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error('timeout');
		await new Promise((r) => setTimeout(r, 10));
	}
};

test('BIND 0 replies BOUND with a free UDP port', async () => {
	const c = await connect();
	await bound(c);
	c.ws.close();
});

test('SEND becomes a UDP datagram from the bound port; UDP replies come back as RECV', async () => {
	const c = await connect();
	const port = await bound(c);
	const peer = await udpPeer();
	c.ws.send(sendMsg('127.0.0.1', peer.port, Buffer.from('hello')));
	await until(() => peer.received.length === 1);
	assert.equal(peer.received[0].msg.toString(), 'hello');
	assert.equal(peer.received[0].rinfo.port, port);
	peer.sock.send(Buffer.from('world'), port, '127.0.0.1');
	const reply = parse(await c.next());
	assert.deepEqual([reply.type, reply.ip, reply.port, reply.payload.toString()], [RECV, '127.0.0.1', peer.port, 'world']);
	peer.sock.close();
	c.ws.close();
});

test('two sessions reach each other (browser joins browser)', async () => {
	const host = await connect(), client = await connect();
	const hostPort = await bound(host, 0);
	const clientPort = await bound(client);
	client.ws.send(sendMsg('127.0.0.1', hostPort, Buffer.from('connect')));
	const atHost = parse(await host.next());
	assert.deepEqual([atHost.port, atHost.payload.toString()], [clientPort, 'connect']);
	host.ws.send(sendMsg('127.0.0.1', clientPort, Buffer.from('ack')));
	const atClient = parse(await client.next());
	assert.deepEqual([atClient.port, atClient.payload.toString()], [hostPort, 'ack']);
	host.ws.close();
	client.ws.close();
});

test('BIND on a port in use replies ERROR and closes', async () => {
	const a = await connect();
	const port = await bound(a);
	const b = await connect();
	b.ws.send(bindMsg(port));
	const reply = await b.next();
	assert.equal(reply[0], ERROR);
	assert.match(reply.subarray(1).toString(), /EADDRINUSE/);
	await b.closed;
	a.ws.close();
});

test('a first message other than BIND is an error', async () => {
	const c = await connect();
	c.ws.send(sendMsg('127.0.0.1', 9, Buffer.from('x')));
	assert.equal((await c.next())[0], ERROR);
	await c.closed;
});

test('oversized payloads are dropped, not forwarded', async () => {
	const c = await connect();
	await bound(c);
	const peer = await udpPeer();
	const before = relay.stats.dropped;
	c.ws.send(sendMsg('127.0.0.1', peer.port, Buffer.alloc(MAX_PAYLOAD + 1)));
	c.ws.send(sendMsg('127.0.0.1', peer.port, Buffer.from('small')));
	await until(() => peer.received.length === 1);
	assert.equal(peer.received[0].msg.toString(), 'small');
	assert.equal(relay.stats.dropped, before + 1);
	peer.sock.close();
	c.ws.close();
});

test('closing the WebSocket frees the UDP port', async () => {
	const a = await connect();
	const port = await bound(a);
	a.ws.close();
	await a.closed;
	await new Promise((r) => setTimeout(r, 50));
	const b = await connect();
	assert.equal(await bound(b, port), port);
	b.ws.close();
});

test('"public" policy only forwards to public addresses and relay sessions', async () => {
	const strict = await startRelay({ port: 0, dest: 'public', log: () => {} });
	const url = `ws://127.0.0.1:${strict.port}/`;
	const peer = await udpPeer();
	const a = await connect(url), b = await connect(url);
	await bound(a);
	const bPort = await bound(b);
	a.ws.send(sendMsg('127.0.0.1', peer.port, Buffer.from('blocked')));
	a.ws.send(sendMsg('127.0.0.1', bPort, Buffer.from('session')));
	assert.equal(parse(await b.next()).payload.toString(), 'session');
	assert.equal(peer.received.length, 0);
	assert.equal(strict.stats.dropped, 1);
	peer.sock.close();
	await strict.close();
});

test('WebSocket closed during the UDP bind: no crash, relay keeps working', async () => {
	// Node's global WebSocket has no terminate(); the relay's own `ws` package does.
	const { createRequire } = await import('node:module');
	const Client = createRequire(import.meta.url)('../emsdk/upstream/emscripten/node_modules/ws/index.js');
	const own = await startRelay({ port: 0, log: () => {} });
	const url = `ws://127.0.0.1:${own.port}/`;
	const errors = [];
	const record = (error) => errors.push(error);
	process.on('uncaughtException', record);
	process.on('unhandledRejection', record);
	try {
		for (let i = 0; i < 20; i++) {
			const ws = new Client(url);
			await new Promise((resolve, reject) => {
				ws.once('open', resolve);
				ws.once('error', reject);
			});
			ws.send(bindMsg(0));
			ws.terminate();
		}
		await new Promise((r) => setTimeout(r, 500));
		const c = await connect(url);
		assert.ok((await bound(c)) > 0);
		c.ws.close();
	} finally {
		process.off('uncaughtException', record);
		process.off('unhandledRejection', record);
		await own.close();
	}
	assert.deepEqual(errors.map((e) => (e && (e.stack || e.message)) || e), []);
});

test('isPublicIPv4', () => {
	for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.20.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1'])
		assert.equal(isPublicIPv4(ip), false, ip);
	for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '1.1.1.1'])
		assert.equal(isPublicIPv4(ip), true, ip);
});

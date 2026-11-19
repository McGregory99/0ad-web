// Tests for the ENet tunnel relay (PROTOCOL.md). Run: node --test tools/relay/relay.test.mjs
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { after, before, test } from 'node:test';
import { BIND, BOUND, ERROR, MAX_PAYLOAD, META, RECV, SEND, isPublicIPv4, startRelay } from './relay.mjs';

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
const metaMsg = (value) => Buffer.concat([Buffer.from([META]), Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]);
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

// A free UDP port on this machine: the room code a test room will bind on the relay.
async function freeUdpPort() {
	const sock = dgram.createSocket('udp4');
	await new Promise((r) => sock.bind(0, '127.0.0.1', r));
	const port = sock.address().port;
	await new Promise((r) => sock.close(r));
	return port;
}

// A relay whose room range is exactly one port P, so a test controls who is a room.
async function roomRelay() {
	const roomPort = await freeUdpPort();
	const room = await startRelay({ port: 0, roomMin: roomPort, roomMax: roomPort, log: () => {} });
	const base = `http://127.0.0.1:${room.port}`;
	const list = async () => (await (await fetch(`${base}/rooms`)).json()).rooms;
	return { relay: room, roomPort, base, list, url: `ws://127.0.0.1:${room.port}/`, close: () => room.close() };
}

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

test('GET /rooms on a relay with no sessions is an empty list with the CORS/CORP headers', async () => {
	const room = await roomRelay();
	try {
		const res = await fetch(`${room.base}/rooms`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('content-type'), 'application/json');
		assert.equal(res.headers.get('cache-control'), 'no-store');
		assert.equal(res.headers.get('access-control-allow-origin'), '*');
		assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
		assert.deepEqual(await res.json(), { rooms: [] });
	} finally {
		await room.close();
	}
});

test('a room session is listed, META fills name and players, closing removes it', async () => {
	const room = await roomRelay();
	const c = await connect(room.url);
	try {
		assert.equal(await bound(c, room.roomPort), room.roomPort);
		let rooms = await room.list();
		assert.equal(rooms.length, 1);
		assert.equal(rooms[0].code, room.roomPort);
		assert.equal(rooms[0].name, null);
		assert.equal(rooms[0].players, null);
		assert.ok(rooms[0].age === 0 || rooms[0].age === 1, `age ${rooms[0].age}`);
		c.ws.send(metaMsg({ name: "Ana's game", players: 2 }));
		await new Promise((r) => setTimeout(r, 100));
		rooms = await room.list();
		assert.equal(rooms[0].name, "Ana's game");
		assert.equal(rooms[0].players, 2);
		c.ws.close();
		await c.closed;
		await new Promise((r) => setTimeout(r, 100));
		assert.deepEqual(await room.list(), []);
	} finally {
		c.ws.close();
		await room.close();
	}
});

test('a session bound outside the room range is not listed and its META is dropped', async () => {
	const c = await connect();
	const port = await bound(c);
	const peer = await udpPeer();
	try {
		assert.ok(port < 20700 || port > 20999, `port ${port}`);
		const before = relay.stats.dropped;
		c.ws.send(metaMsg({ name: 'not a room', players: 1 }));
		c.ws.send(sendMsg('127.0.0.1', peer.port, Buffer.from('still alive')));
		await until(() => peer.received.length === 1);
		assert.equal(peer.received[0].msg.toString(), 'still alive');
		assert.equal(relay.stats.dropped, before + 1);
		const rooms = (await (await fetch(`http://127.0.0.1:${relay.port}/rooms`)).json()).rooms;
		assert.equal(rooms.some((room) => room.code === port), false);
	} finally {
		peer.sock.close();
		c.ws.close();
	}
});

test('a room drops invalid META without closing and keeps the last valid name', async () => {
	const room = await roomRelay();
	const c = await connect(room.url);
	try {
		await bound(c, room.roomPort);
		c.ws.send(metaMsg({ name: 'ok', players: 1 }));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((await room.list())[0].name, 'ok');
		const before = room.relay.stats.dropped;
		c.ws.send(metaMsg('{not json'));
		c.ws.send(metaMsg('[1,2]'));
		c.ws.send(Buffer.concat([Buffer.from([META]), Buffer.alloc(513, 0x20)])); // 514 bytes
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(room.relay.stats.dropped, before + 3);
		const rooms = await room.list();
		assert.equal(rooms.length, 1);
		assert.equal(rooms[0].name, 'ok');
		assert.equal(rooms[0].players, 1);
	} finally {
		c.ws.close();
		await room.close();
	}
});

test('META cleans the name and validates players', async () => {
	const room = await roomRelay();
	const c = await connect(room.url);
	try {
		await bound(c, room.roomPort);
		c.ws.send(metaMsg({ name: '  a\u0001b  ', players: 99 }));
		await new Promise((r) => setTimeout(r, 100));
		let listed = (await room.list())[0];
		assert.equal(listed.name, 'ab');
		assert.equal(listed.players, null);
		c.ws.send(metaMsg({ name: 'x'.repeat(50) }));
		await new Promise((r) => setTimeout(r, 100));
		listed = (await room.list())[0];
		assert.equal(listed.name, 'x'.repeat(40));
		assert.equal(listed.players, null);
		c.ws.send(metaMsg({ name: 5 }));
		await new Promise((r) => setTimeout(r, 100));
		assert.equal((await room.list())[0].name, null);
	} finally {
		c.ws.close();
		await room.close();
	}
});

test('META as the very first message is an error and closes the WebSocket', async () => {
	const c = await connect();
	c.ws.send(metaMsg({ name: 'too early' }));
	assert.equal((await c.next())[0], ERROR);
	await c.closed;
});

test('HTTP: unknown paths 404, other methods on /rooms 405, query string ignored', async () => {
	const room = await roomRelay();
	try {
		const nope = await fetch(`${room.base}/nope`);
		assert.equal(nope.status, 404);
		const post = await fetch(`${room.base}/rooms`, { method: 'POST' });
		assert.equal(post.status, 405);
		assert.equal(post.headers.get('allow'), 'GET');
		const query = await fetch(`${room.base}/rooms?x=1`);
		assert.equal(query.status, 200);
		assert.deepEqual(await query.json(), { rooms: [] });
	} finally {
		await room.close();
	}
});

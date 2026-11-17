// ENet datagram tunnel, JavaScript side (T7.1b). The C side is tools/wasm/enet-tunnel.c
// (built into libenet.a by tools/wasm/build-enet.sh); the wire protocol is tools/relay/PROTOCOL.md.
// Each ENet socket is one WebSocket to the relay, which owns a real UDP socket for it.
//
// Main thread: Module.zeroadNet = { relayUrl, stats }. The relay URL comes from the page query
// ?relay=<ws url>, default ws[s]://<page hostname>:20600/. stats counts sockets, open WebSockets,
// datagrams and payload bytes sent/received, drops and errors, and the datagrams/commands currently
// queued for ENet (rxQueued) and for the I/O thread (txQueued) (tests read it).
// The WebSockets themselves live on a dedicated pthread (the "network I/O" thread, started by
// enet-tunnel.c before main), because the engine's main thread does not always return to the
// event loop. That thread calls zeroadNetStartIoThread() and then only runs event handlers.
// Without Module.zeroadNet (Node build) the C side starts no I/O thread.
if (typeof window !== 'undefined' && (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD)) {
	const relayUrl = new URLSearchParams(location.search).get('relay') ||
		`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:20600/`;
	const names = ['sockets', 'open', 'sent', 'received', 'bytesSent', 'bytesReceived', 'dropped', 'errors', 'rxQueued', 'txQueued'];
	Module.zeroadNet = {
		relayUrl,
		statsPointer: 0, // set by enet-tunnel.c
		get stats() {
			const stats = {};
			names.forEach((name, i) => { stats[name] = this.statsPointer ? HEAPU32[(this.statsPointer >> 2) + i] : 0; });
			return stats;
		},
	};
}

// Runs on the network I/O thread. signalPointer: futex word bumped by the C side for every queued
// command; statsPointer: u32 counters (same order as `names` above; this thread writes the first 8).
function zeroadNetStartIoThread(relayUrl, signalPointer, statsPointer) {
	const OPEN = 1, BIND_CMD = 2, SEND_DATA = 3, CLOSE = 4;
	const BIND = 0x01, BOUND = 0x81, ERROR = 0x82, RECV = 0x83, HEADER = 7;
	const MAX_QUEUED = 1024; // datagrams kept per socket until the relay confirms the bind
	const STAT = { sockets: 0, open: 1, sent: 2, received: 3, bytesSent: 4, bytesReceived: 5, dropped: 6, errors: 7 };
	const count = (name, n = 1) => Atomics.add(HEAPU32, (statsPointer >> 2) + STAT[name], n);
	const sockets = new Map(); // `${slot}:${generation}` -> socket state
	const key = (slot, generation) => `${slot}:${generation}`;
	const encoder = new TextEncoder();
	const log = (s, message) => {
		const bytes = encoder.encode(`[zeroad-net] socket ${s.slot}: ${message} (relay ${relayUrl})`);
		const pointer = _zeroad_net_malloc(bytes.length + 1);
		if (!pointer) return;
		HEAPU8.set(bytes, pointer);
		HEAPU8[pointer + bytes.length] = 0;
		_zeroad_net_log(pointer);
	};
	const ipv4 = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

	const transmit = (s, datagram) => {
		s.ws.send(datagram);
		count('sent');
		count('bytesSent', datagram.length - HEADER);
	};
	// BIND goes out once the WebSocket is open and the engine either bound the socket or wants to
	// send (ENet clients never bind: their host has no address, so the relay picks a port).
	const maybeBind = (s) => {
		if (s.bindSent || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
		if (s.port === null && s.queue.length === 0) return;
		const port = s.port ?? 0;
		s.ws.send(new Uint8Array([BIND, port >> 8, port & 0xff]));
		s.bindSent = true;
	};
	const forget = (s) => {
		if (s.queue.length) count('dropped', s.queue.length);
		s.queue = [];
		if (sockets.get(key(s.slot, s.generation)) === s) sockets.delete(key(s.slot, s.generation));
	};
	const onMessage = (s, data) => {
		const bytes = new Uint8Array(data);
		if (bytes.length === 0) return;
		if (bytes[0] === RECV) {
			if (bytes.length < HEADER) return;
			const pointer = _zeroad_net_rx_alloc(bytes.length);
			if (!pointer) { count('dropped'); return; }
			HEAPU8.set(bytes, pointer);
			if (_zeroad_net_rx_push(s.slot, s.generation, pointer)) {
				count('received');
				count('bytesReceived', bytes.length - HEADER);
			} else count('dropped');
		} else if (bytes[0] === BOUND && bytes.length >= HEADER) {
			s.bound = true;
			const port = (bytes[5] << 8) | bytes[6];
			// Little-endian u32 whose memory bytes are the address bytes (ENetAddress.host).
			const host = (bytes[1] | (bytes[2] << 8) | (bytes[3] << 16) | (bytes[4] << 24)) >>> 0;
			_zeroad_net_bound(s.slot, s.generation, host, port);
			log(s, `bound ${ipv4(bytes, 1)}:${port} (requested port ${s.port ?? 0})`);
			for (const datagram of s.queue) transmit(s, datagram);
			s.queue = [];
		} else if (bytes[0] === ERROR) {
			count('errors');
			log(s, `relay error: ${new TextDecoder().decode(bytes.subarray(1))}`);
		}
	};

	const open = (slot, generation) => {
		const s = { slot, generation, ws: null, port: null, bindSent: false, bound: false, closed: false, wasOpen: false, queue: [] };
		sockets.set(key(slot, generation), s);
		count('sockets');
		try {
			s.ws = new WebSocket(relayUrl);
		} catch (error) {
			count('errors');
			log(s, `cannot open: ${error}`);
			s.closed = true;
			return;
		}
		s.ws.binaryType = 'arraybuffer';
		s.ws.onopen = () => { s.wasOpen = true; count('open'); maybeBind(s); };
		s.ws.onmessage = (event) => onMessage(s, event.data);
		s.ws.onerror = () => { if (!s.closed) count('errors'); };
		s.ws.onclose = (event) => {
			if (s.wasOpen) { s.wasOpen = false; count('open', -1); }
			if (!s.closed) log(s, `closed by relay (code ${event.code}${event.reason ? ', ' + event.reason : ''})`);
			s.closed = true;
			forget(s);
		};
	};
	const run = (command) => {
		command >>>= 0; // wasm returns pointers as signed i32; memory can exceed 2 GB
		const base = command >>> 2;
		const type = HEAP32[base + 1], slot = HEAP32[base + 2], generation = HEAP32[base + 3];
		const s = type === OPEN ? null : sockets.get(key(slot, generation));
		if (type === OPEN) open(slot, generation);
		else if (type === BIND_CMD) {
			if (!s) return;
			s.port = HEAP32[base + 4];
			maybeBind(s);
		} else if (type === SEND_DATA) {
			const length = HEAP32[base + 5];
			if (!s || s.closed) { count('dropped'); return; }
			const datagram = HEAPU8.slice(command + 24, command + 24 + length);
			if (s.bound) transmit(s, datagram);
			else if (s.queue.length < MAX_QUEUED) { s.queue.push(datagram); maybeBind(s); }
			else count('dropped');
		} else if (type === CLOSE) {
			if (!s) return;
			s.closed = true;
			log(s, 'closed by the engine');
			forget(s);
			if (s.ws) s.ws.close();
		}
	};
	const drain = () => {
		for (let command; (command = _zeroad_net_tx_pop());) {
			try {
				run(command);
			} finally {
				_zeroad_net_free(command);
			}
		}
	};
	// Read the signal, drain, then sleep until the signal changes (no lost wake-ups: a command
	// queued after the read changes the word, so waitAsync returns "not-equal" at once).
	const index = signalPointer >> 2;
	const loop = () => {
		const seen = Atomics.load(HEAP32, index);
		drain();
		if (typeof Atomics.waitAsync === 'function') {
			const result = Atomics.waitAsync(HEAP32, index, seen);
			if (result.async) result.value.then(loop);
			else setTimeout(loop, 0);
		} else setTimeout(loop, 4);
	};
	loop();
}

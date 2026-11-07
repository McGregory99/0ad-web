// JS library for headless Node runs (WASM_PROFILE=node): there is no display to wait for,
// and NODERAWFS reads every file directly, so there are no remote files.
addToLibrary({
	zeroad_wait_frame: function() {},
	zeroad_remote_pread__sig: 'pippd',
	zeroad_remote_pread: function(fd, buffer, count, offset) { return -2; },

	// Remote AI (ZEROAD_AI_REMOTE=1, source/simulation2/components/AIRemote.cpp): the AI scripts
	// run in a worker_threads Worker (tools/wasm/ai/ai-worker.js, found next to this script in
	// ai/ or at $ZEROAD_AI_WORKER). Both threads share two SharedArrayBuffers:
	//   ctrl (Int32Array): [0] state: 0 idle, 1 message for the worker, 2 message for the engine;
	//                      [1] message length in bytes; [2] kind of a message for the engine:
	//                      0 = final reply, otherwise an AIRemote::ServiceKind callback.
	//   data (growable): the message bytes (UTF-8).
	// The engine thread blocks in Atomics.wait (allowed on Node's main thread) and answers the
	// worker's callbacks by calling back into wasm (zeroad_ai_service) until the final reply.
	$ZeroADAI: {
		worker: null,
		ctrl: null,
		data: null,
		reply: null,
		failed: false,
		start() {
			if (ZeroADAI.worker || ZeroADAI.failed)
				return !!ZeroADAI.worker;
			try {
				const { Worker } = require('node:worker_threads');
				const path = require('node:path');
				const script = process.env.ZEROAD_AI_WORKER || path.join(__dirname, 'ai', 'ai-worker.js');
				const ctrl = new SharedArrayBuffer(16);
				const data = new SharedArrayBuffer(1 << 20, { maxByteLength: 1 << 30 });
				ZeroADAI.ctrl = new Int32Array(ctrl);
				ZeroADAI.data = new Uint8Array(data);
				ZeroADAI.worker = new Worker(script, { workerData: { ctrl, data, memory: wasmMemory } });
				ZeroADAI.worker.unref();
			} catch (e) {
				ZeroADAI.failed = true;
				err('AI worker: failed to start: ' + e);
			}
			return !!ZeroADAI.worker;
		},
		write(bytes) {
			const data = ZeroADAI.data;
			if (bytes.length > data.buffer.byteLength)
				data.buffer.grow(Math.min(data.buffer.maxByteLength, Math.max(bytes.length, 2 * data.buffer.byteLength)));
			data.set(bytes);
			ZeroADAI.ctrl[1] = bytes.length;
		},
	},
	zeroad_ai_remote_call__deps: ['$ZeroADAI', 'zeroad_ai_service_input', 'zeroad_ai_service', 'zeroad_ai_service_output'],
	zeroad_ai_remote_call__sig: 'ipp',
	zeroad_ai_remote_call: function(request, length) {
		if (!ZeroADAI.start())
			return -1;
		const ctrl = ZeroADAI.ctrl;
		ZeroADAI.write(HEAPU8.subarray(request, request + length));
		Atomics.store(ctrl, 0, 1);
		Atomics.notify(ctrl, 0);
		for (;;) {
			// Late-game AI turns may take seconds; a dead worker would block forever.
			if (Atomics.wait(ctrl, 0, 1, 600000) === 'timed-out') {
				err('AI worker: no reply after 600 s');
				ZeroADAI.failed = true;
				return -1;
			}
			const kind = ctrl[2];
			const size = ctrl[1];
			if (kind === 0) {
				ZeroADAI.reply = ZeroADAI.data.slice(0, size);
				Atomics.store(ctrl, 0, 0);
				Atomics.notify(ctrl, 0);
				return size;
			}
			const input = _zeroad_ai_service_input(size);
			HEAPU8.set(ZeroADAI.data.subarray(0, size), input);
			const outputSize = _zeroad_ai_service(kind, size);
			const output = _zeroad_ai_service_output();
			ZeroADAI.write(HEAPU8.subarray(output, output + outputSize));
			Atomics.store(ctrl, 0, 1);
			Atomics.notify(ctrl, 0);
		}
	},
	zeroad_ai_remote_result__deps: ['$ZeroADAI'],
	zeroad_ai_remote_result__sig: 'vp',
	zeroad_ai_remote_result: function(out) {
		HEAPU8.set(ZeroADAI.reply, out);
		ZeroADAI.reply = null;
	},
});

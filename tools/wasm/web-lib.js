// JS library for the browser build (WASM_PROFILE=web).
addToLibrary({
	// Hand control back to the browser until the next display refresh. With -sJSPI the wasm
	// stack suspends here, so 0 A.D.'s blocking main loop keeps working: the frame is presented
	// and input events are delivered while the loop waits.
	zeroad_wait_frame__async: true,
	zeroad_wait_frame: async function() {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	},

	// Remote files: large archives (public.zip) are not downloaded up front. web-env.pre.js
	// creates an empty MEMFS node with the real size for each entry of remote-files.json, and
	// io::Issue (lib/file/io/io.cpp) sends every read here first. Data is fetched with HTTP
	// Range requests in aligned blocks and kept in an in-memory LRU cache.
	$ZeroADRemote: {
		blockSize: 64 << 10,
		cacheLimit: 768 << 20,
		cacheBytes: 0,
		blocks: new Map(), // `${url}#${index}` -> Uint8Array, in LRU order
		inflight: new Map(), // `${url}#${index}` -> Promise
		stats: { reads: 0, cachedReads: 0, persistentHits: 0, requests: 0, bytes: 0, ms: 0 },
		warnedPthread: false,
		key(url, index) { return `${url}#${index}`; },
		touch(key) {
			const block = ZeroADRemote.blocks.get(key);
			ZeroADRemote.blocks.delete(key);
			ZeroADRemote.blocks.set(key, block);
			return block;
		},
		store(key, block) {
			ZeroADRemote.blocks.set(key, block);
			ZeroADRemote.cacheBytes += block.length;
			for (const [oldKey, oldBlock] of ZeroADRemote.blocks) {
				if (ZeroADRemote.cacheBytes <= ZeroADRemote.cacheLimit)
					break;
				ZeroADRemote.blocks.delete(oldKey);
				ZeroADRemote.cacheBytes -= oldBlock.length;
			}
		},
		// Opt-in per-path log (page URL must have remotelog=1; otherwise it stays empty and
		// costs nothing). Key: zip member path (or the archive URL when it cannot be mapped).
		remoteLog: {}, // path -> { reads, bytesRead, bytesFetched }
		remoteLogEnabled: null, // tri-state: null = not read from the page URL yet
		zipIndex: null, // lazily built { cdOfs, entries:[{ofs,name}] } from cached blocks
		zipIndexFailed: false,
		remoteLogging() {
			if (ZeroADRemote.remoteLogEnabled === null)
				ZeroADRemote.remoteLogEnabled = typeof location !== 'undefined' &&
					new URLSearchParams(location.search).get('remotelog') === '1';
			return ZeroADRemote.remoteLogEnabled;
		},
		blockLen(remote, index) {
			return Math.min(ZeroADRemote.blockSize, remote.size - index * ZeroADRemote.blockSize);
		},
		// Copy [ofs, ofs+len) out of blocks that are ALREADY in the memory cache.
		// Returns null if any needed block is missing, so this never triggers a fetch.
		cachedRange(remote, ofs, len) {
			const size = ZeroADRemote.blockSize;
			const out = new Uint8Array(len);
			let done = 0;
			while (done < len) {
				const position = ofs + done;
				const index = Math.floor(position / size);
				const block = ZeroADRemote.blocks.get(ZeroADRemote.key(remote.url, index));
				if (!block)
					return null;
				const from = position - index * size;
				const n = Math.min(len - done, block.length - from);
				out.set(block.subarray(from, from + n), done);
				done += n;
			}
			return out;
		},
		// Map byte offsets to zip member names by walking the central directory that the
		// engine has already read into the cache. Never reads from the network.
		zipIndexFor(remote) {
			if (ZeroADRemote.zipIndex || ZeroADRemote.zipIndexFailed)
				return ZeroADRemote.zipIndex;
			const u16 = (a, p) => a[p] | (a[p + 1] << 8);
			const u32 = (a, p) => (a[p] | (a[p + 1] << 8) | (a[p + 2] << 16) | (a[p + 3] << 24)) >>> 0;
			const tailLen = Math.min(66000, remote.size);
			const tail = ZeroADRemote.cachedRange(remote, remote.size - tailLen, tailLen);
			if (!tail)
				return null;
			let ecdr = -1;
			for (let i = tail.length - 22; i >= 0; --i)
				if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
					ecdr = i;
					break;
				}
			if (ecdr < 0) {
				ZeroADRemote.zipIndexFailed = true;
				return null;
			}
			const numEntries = u16(tail, ecdr + 10);
			const cdSize = u32(tail, ecdr + 12);
			const cdOfs = u32(tail, ecdr + 16);
			if (numEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOfs === 0xFFFFFFFF) {
				ZeroADRemote.zipIndexFailed = true; // zip64: not handled, fall back to the URL
				return null;
			}
			const cd = ZeroADRemote.cachedRange(remote, cdOfs, cdSize);
			if (!cd)
				return null; // central directory not in the cache yet
			const entries = [];
			let p = 0;
			for (let i = 0; i < numEntries && p + 46 <= cd.length; ++i) {
				if (u32(cd, p) !== 0x02014b50)
					break;
				const nameLen = u16(cd, p + 28);
				const extraLen = u16(cd, p + 30);
				const commentLen = u16(cd, p + 32);
				const lfhOfs = u32(cd, p + 42);
				let name = '';
				for (let j = 0; j < nameLen; ++j)
					name += String.fromCharCode(cd[p + 46 + j]);
				entries.push({ ofs: lfhOfs, name });
				p += 46 + nameLen + extraLen + commentLen;
			}
			entries.sort((a, b) => a.ofs - b.ofs);
			ZeroADRemote.zipIndex = { cdOfs, entries };
			return ZeroADRemote.zipIndex;
		},
		// Name of the zip member whose bytes contain <offset>.
		attribute(remote, offset) {
			const index = ZeroADRemote.zipIndexFor(remote);
			if (!index)
				return remote.url;
			if (offset >= index.cdOfs)
				return '(zip central directory)';
			const entries = index.entries;
			let lo = 0, hi = entries.length - 1, best = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (entries[mid].ofs <= offset) {
					best = mid;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			return best >= 0 ? entries[best].name : '(zip local headers)';
		},
		logRead(remote, offset, count, fetched) {
			const name = ZeroADRemote.attribute(remote, offset);
			const entry = ZeroADRemote.remoteLog[name] ||
				(ZeroADRemote.remoteLog[name] = { reads: 0, bytesRead: 0, bytesFetched: 0 });
			entry.reads++;
			entry.bytesRead += count;
			entry.bytesFetched += fetched;
		},

		// Persistent cache (Cache Storage): one entry per block, keyed by a synthetic URL that
		// includes the file size, so a new archive version never reuses old blocks.
		cachePromise: null,
		persistent() {
			if (!ZeroADRemote.cachePromise)
				ZeroADRemote.cachePromise = (globalThis.caches ? caches.open('zeroad-blocks-v1') : Promise.reject())
					.catch(() => null);
			return ZeroADRemote.cachePromise;
		},
		// Optional URL override: blocksize=<KiB> (default 64 KiB). The Cache Storage key
		// already carries bs=<bytes>, so different sizes never reuse each other's blocks.
		configureBlockSize() {
			if (typeof location === 'undefined')
				return;
			const kib = parseInt(new URLSearchParams(location.search).get('blocksize'), 10);
			if (kib > 0)
				ZeroADRemote.blockSize = kib << 10;
		},
		cacheUrl(remote, index) { return `${remote.url}?size=${remote.size}&block=${index}&bs=${ZeroADRemote.blockSize}`; },
		// Load blocks [first, last]: from Cache Storage when present, the rest from the network.
		async fetchSpan(remote, first, last) {
			const cache = await ZeroADRemote.persistent();
			let missingFirst = first;
			while (cache && missingFirst <= last) {
				const hit = await cache.match(ZeroADRemote.cacheUrl(remote, missingFirst));
				if (!hit)
					break;
				ZeroADRemote.store(ZeroADRemote.key(remote.url, missingFirst), new Uint8Array(await hit.arrayBuffer()));
				ZeroADRemote.stats.persistentHits++;
				++missingFirst;
			}
			if (missingFirst <= last)
				await ZeroADRemote.fetchNetwork(remote, missingFirst, last, cache);
		},
		async fetchNetwork(remote, first, last, cache) {
			const size = ZeroADRemote.blockSize;
			const start = first * size;
			const end = Math.min((last + 1) * size, remote.size) - 1;
			const t0 = performance.now();
			const response = await fetch(remote.url, { headers: { Range: `bytes=${start}-${end}` } });
			if (response.status !== 206)
				throw new Error(`remote read ${remote.url} ${start}-${end}: HTTP ${response.status}`);
			const data = new Uint8Array(await response.arrayBuffer());
			if (data.length !== end - start + 1)
				throw new Error(`remote read ${remote.url} ${start}-${end}: got ${data.length} bytes`);
			const stats = ZeroADRemote.stats;
			stats.requests++;
			stats.bytes += data.length;
			stats.ms += performance.now() - t0;
			for (let index = first; index <= last; ++index) {
				const block = data.slice((index - first) * size, Math.min((index - first + 1) * size, data.length));
				ZeroADRemote.store(ZeroADRemote.key(remote.url, index), block);
				// Fire and forget: a failed cache write (quota) only costs a later re-download.
				cache?.put(ZeroADRemote.cacheUrl(remote, index), new Response(block)).catch(() => {});
			}
		},
		async load(remote, first, last) {
			// Group the missing blocks into contiguous spans, one request each.
			const waits = [];
			let spanStart = -1;
			for (let index = first; index <= last + 1; ++index) {
				const key = ZeroADRemote.key(remote.url, index);
				const missing = index <= last && !ZeroADRemote.blocks.has(key);
				if (missing && ZeroADRemote.inflight.has(key)) {
					waits.push(ZeroADRemote.inflight.get(key));
				} else if (missing) {
					if (spanStart < 0)
						spanStart = index;
					continue;
				}
				if (spanStart >= 0) {
					const promise = ZeroADRemote.fetchSpan(remote, spanStart, index - 1);
					for (let i = spanStart; i < index; ++i)
						ZeroADRemote.inflight.set(ZeroADRemote.key(remote.url, i), promise);
					const keys = [];
					for (let i = spanStart; i < index; ++i)
						keys.push(ZeroADRemote.key(remote.url, i));
					waits.push(promise.finally(() => keys.forEach((k) => ZeroADRemote.inflight.delete(k))));
					spanStart = -1;
				}
			}
			await Promise.all(waits);
		},
		copy(remote, buffer, offset, count) {
			const size = ZeroADRemote.blockSize;
			let done = 0;
			while (done < count) {
				const position = offset + done;
				const index = Math.floor(position / size);
				const block = ZeroADRemote.touch(ZeroADRemote.key(remote.url, index));
				const from = position - index * size;
				const n = Math.min(count - done, block.length - from);
				HEAPU8.set(block.subarray(from, from + n), buffer + done);
				done += n;
			}
			return count;
		},
	},

	// Returns the number of bytes read, -1 on error, or -2 if fd is not a remote file.
	// On a cache miss it returns a Promise, which suspends the wasm stack (JSPI).
	zeroad_remote_pread__deps: ['$ZeroADRemote', '$FS'],
	zeroad_remote_pread__sig: 'pippd',
	zeroad_remote_pread__async: true,
	zeroad_remote_pread: function(fd, buffer, count, offset) {
		if (ENVIRONMENT_IS_PTHREAD) {
			if (!ZeroADRemote.warnedPthread)
				err('zeroad_remote_pread: called on a pthread, remote files are main-thread only');
			ZeroADRemote.warnedPthread = true;
			return -2;
		}
		const remote = FS.getStream(fd)?.node?.zeroadRemote;
		if (!remote)
			return -2;
		ZeroADRemote.stats.reads++;
		count = Math.max(0, Math.min(count, remote.size - offset));
		if (count === 0)
			return 0;
		const size = ZeroADRemote.blockSize;
		const first = Math.floor(offset / size);
		const last = Math.floor((offset + count - 1) / size);
		if (ZeroADRemote.remoteLogging()) {
			let fetched = 0;
			for (let index = first; index <= last; ++index) {
				const key = ZeroADRemote.key(remote.url, index);
				if (!ZeroADRemote.blocks.has(key) && !ZeroADRemote.inflight.has(key))
					fetched += ZeroADRemote.blockLen(remote, index);
			}
			ZeroADRemote.logRead(remote, offset, count, fetched);
		}
		let cached = true;
		for (let index = first; index <= last && cached; ++index)
			cached = ZeroADRemote.blocks.has(ZeroADRemote.key(remote.url, index));
		if (cached) {
			ZeroADRemote.stats.cachedReads++;
			return ZeroADRemote.copy(remote, buffer, offset, count);
		}
		return ZeroADRemote.load(remote, first, last).then(
			() => ZeroADRemote.copy(remote, buffer, offset, count),
			(error) => { err(`zeroad_remote_pread: ${error}`); return -1; });
	},

	// Called from web-env.pre.js (preRun): create the remote file nodes.
	zeroad_register_remote_files__deps: ['$FS', '$ZeroADRemote'],
	zeroad_register_remote_files: function(list, baseUrl) {
		ZeroADRemote.configureBlockSize();
		for (const entry of list) {
			const slash = entry.path.lastIndexOf('/');
			FS.mkdirTree(entry.path.slice(0, slash));
			const node = FS.createFile(entry.path.slice(0, slash), entry.path.slice(slash + 1), null, true, false);
			node.usedBytes = entry.size;
			node.zeroadRemote = { url: new URL(entry.url, baseUrl).href, size: entry.size };
		}
		Module.remoteStats = ZeroADRemote.stats;
		Module.remoteLog = ZeroADRemote.remoteLog;
	},

	// Remote AI (ZEROAD_AI_REMOTE=1, source/simulation2/components/AIRemote.cpp): the AI scripts run
	// in a Web Worker (ai/ai-worker.js next to the page, AI modules under ai/modules/). Same protocol
	// as tools/wasm/node-lib.js (ctrl/data SharedArrayBuffers), but the main thread may not block:
	// zeroad_ai_remote_call suspends the engine with JSPI and awaits Atomics.waitAsync. Servicing a
	// callback can itself suspend (remote file reads), so zeroad_ai_service is a JSPI export
	// (-sJSPI_EXPORTS in tools/wasm/build-engine.sh) and returns a Promise.
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
				const ctrl = new SharedArrayBuffer(16);
				const data = new SharedArrayBuffer(1 << 20, { maxByteLength: 1 << 30 });
				ZeroADAI.ctrl = new Int32Array(ctrl);
				ZeroADAI.data = new Uint8Array(data);
				ZeroADAI.worker = new Worker(new URL('ai/ai-worker.js', document.baseURI), { name: 'zeroad-ai' });
				ZeroADAI.worker.onerror = (event) => err(`AI worker: ${event.message || event}`);
				ZeroADAI.worker.postMessage({ ctrl, data, memory: wasmMemory });
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
		// Resolves when ctrl[0] is no longer 1 (the worker posted a message), or with 'timed-out'.
		async waitForWorker(timeout) {
			const result = Atomics.waitAsync(ZeroADAI.ctrl, 0, 1, timeout);
			return result.async ? await result.value : result.value;
		},
		stats: { calls: 0, callbacks: 0, ms: 0, maxMs: 0 },
	},
	zeroad_ai_remote_call__deps: ['$ZeroADAI', 'zeroad_ai_service_input', 'zeroad_ai_service', 'zeroad_ai_service_output'],
	zeroad_ai_remote_call__sig: 'ipp',
	zeroad_ai_remote_call__async: true,
	zeroad_ai_remote_call: async function(request, length) {
		if (!ZeroADAI.start())
			return -1;
		const t0 = performance.now();
		const ctrl = ZeroADAI.ctrl;
		ZeroADAI.write(HEAPU8.subarray(request, request + length));
		Atomics.store(ctrl, 0, 1);
		Atomics.notify(ctrl, 0);
		for (;;) {
			// Late-game AI turns may take seconds; a dead worker would block forever.
			if (await ZeroADAI.waitForWorker(600000) === 'timed-out') {
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
				const ms = performance.now() - t0;
				const stats = ZeroADAI.stats;
				++stats.calls;
				stats.ms += ms;
				stats.maxMs = Math.max(stats.maxMs, ms);
				return size;
			}
			++ZeroADAI.stats.callbacks;
			const input = _zeroad_ai_service_input(size);
			HEAPU8.set(ZeroADAI.data.subarray(0, size), input);
			const outputSize = await _zeroad_ai_service(kind, size);
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
		Module.aiStats = ZeroADAI.stats;
	},
});

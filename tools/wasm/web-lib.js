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
		blockSize: 1 << 20,
		cacheLimit: 768 << 20,
		cacheBytes: 0,
		blocks: new Map(), // `${url}#${index}` -> Uint8Array, in LRU order
		inflight: new Map(), // `${url}#${index}` -> Promise
		stats: { reads: 0, cachedReads: 0, requests: 0, bytes: 0, ms: 0 },
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
		// Fetch blocks [first, last] of a file with a single Range request.
		async fetchSpan(remote, first, last) {
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
			for (let index = first; index <= last; ++index)
				ZeroADRemote.store(ZeroADRemote.key(remote.url, index),
					data.subarray((index - first) * size, Math.min((index - first + 1) * size, data.length)));
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
		for (const entry of list) {
			const slash = entry.path.lastIndexOf('/');
			FS.mkdirTree(entry.path.slice(0, slash));
			const node = FS.createFile(entry.path.slice(0, slash), entry.path.slice(slash + 1), null, true, false);
			node.usedBytes = entry.size;
			node.zeroadRemote = { url: new URL(entry.url, baseUrl).href, size: entry.size };
		}
		Module.remoteStats = ZeroADRemote.stats;
	},
});

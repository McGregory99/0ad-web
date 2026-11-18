// Browser build (WASM_PROFILE=web): command-line arguments come from the page URL,
// e.g. index.html?arg=-mod=mod&arg=-nosound. Without any, boot the game (public mod) in a
// window: a page cannot enter fullscreen before a user gesture, so the game would otherwise
// switch to fullscreen on the first click. Alt+Enter still toggles fullscreen.
{
	const args = new URLSearchParams(location.search).getAll('arg');
	Module.arguments = args.length ? args : ['-mod=public', '-conf=windowed:true'];
}
// Emscripten's ICU port links only ICU's stub data; the real data file is preloaded at /icu.
Module.preRun = [].concat(Module.preRun || [], () => {
	ENV.ICU_DATA = '/icu';
	// PBL is on since the backport of upstream bug 1909656 (T0.5b); ?pbl=0 keeps the old
	// C++-interpreter path for comparison.
	ENV.JIT_OPTION_portableBaselineInterpreter = new URLSearchParams(location.search).get('pbl') === '0' ? 'false' : 'true';
});
// Reference replay check (T5.3, tools/web/replay-check.sh): index.html?replay=<url of commands.txt>
// &arg=-replay=/replay/commands.txt copies the replay into the in-memory file system before main()
// and runs it non-visually. Replay-only test hooks (source/simulation2/components/CCmpAIManager.cpp):
// &ailog=1 sets ZEROAD_AI_LOG=/replay/ai.log, &hashskip=1 sets ZEROAD_AI_HASH_SKIP_SCRIPTS=1.
// Module.zeroadReplay.done resolves with { hash, lastTurn, seconds } when "# Final state:" is printed;
// Module.zeroadReplay.readFile(path) reads a file back. Without ?replay= nothing here runs.
if (typeof window !== 'undefined' && (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD)
	&& new URLSearchParams(location.search).has('replay')) {
	const params = new URLSearchParams(location.search);
	const replay = { lastTurn: -1, start: 0 };
	let finish;
	Module.zeroadReplay = {
		done: new Promise((resolve) => { finish = resolve; }),
		readFile: (path) => FS.readFile(path),
	};
	// The engine prints "Turn <n> (<length>)..." per turn and "# Final state: <hash>" at the end.
	const consoleLog = console.log;
	console.log = (...args) => {
		const line = String(args[0]);
		const turn = /^Turn (\d+) /.exec(line);
		if (turn) replay.lastTurn = Number(turn[1]);
		else if (line.startsWith('# Final state: '))
			finish({ hash: line.slice(15).trim(), lastTurn: replay.lastTurn, seconds: (performance.now() - replay.start) / 1000 });
		consoleLog.apply(console, args);
	};
	Module.preRun = [].concat(Module.preRun || [], () => {
		if (params.get('ailog') === '1') ENV.ZEROAD_AI_LOG = '/replay/ai.log';
		if (params.get('hashskip') === '1') ENV.ZEROAD_AI_HASH_SKIP_SCRIPTS = '1';
		addRunDependency('zeroad-replay');
		fetch(params.get('replay'))
			.then((response) => {
				if (!response.ok) throw new Error(`${response.status} ${response.url}`);
				return response.arrayBuffer();
			})
			.then((buffer) => {
				FS.mkdirTree('/replay');
				FS.writeFile('/replay/commands.txt', new Uint8Array(buffer));
				replay.start = performance.now();
			})
			.catch((error) => err(`replay: ${error}`))
			.finally(() => removeRunDependency('zeroad-replay'));
	});
}
// Remote files (see web-lib.js): remote-files.json lists [{path, url, size}] next to the page.
Module.preRun = [].concat(Module.preRun || [], () => {
	addRunDependency('zeroad-remote-files');
	fetch('remote-files.json')
		.then((response) => response.ok ? response.json() : [])
		.then((list) => _zeroad_register_remote_files(list, location.href))
		.catch((error) => err(`remote-files.json: ${error}`))
		.finally(() => removeRunDependency('zeroad-remote-files'));
});
// Persist user data and config across reloads (runbooks/T2.4b): mount the two engine data folders on
// Emscripten's IndexedDB filesystem. Cache and logs stay in memory. Main thread only (pthread workers
// must not mount IDBFS); if IndexedDB is unavailable the game still boots.
if (typeof window !== 'undefined' && (typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD)) {
	const zeroadIdbfsDirs = ['/home/web_user/.local/share/0ad', '/home/web_user/.config/0ad'];
	// syncfs(false) mirrors memory into IndexedDB (it deletes stored files missing in memory), so it must
	// never run before the stored files were loaded.
	let zeroadIdbfsReady = false;
	Module.preRun = [].concat(Module.preRun || [], () => {
		addRunDependency('zeroad-idbfs');
		const start = performance.now();
		let mounted = true;
		for (const dir of zeroadIdbfsDirs) {
			try {
				FS.mkdirTree(dir);
				FS.mount(IDBFS, {}, dir);
			} catch (error) {
				mounted = false;
				err(`IDBFS mount ${dir}: ${error}`);
			}
		}
		if (!mounted) {
			removeRunDependency('zeroad-idbfs');
			return;
		}
		FS.syncfs(true, (error) => {
			if (error) err(`IDBFS populate: ${error}`);
			else {
				zeroadIdbfsReady = true;
				console.log(`[zeroad] IDBFS populate ${(performance.now() - start).toFixed(0)} ms`);
			}
			removeRunDependency('zeroad-idbfs');
		});
	});

	let zeroadSyncRunning = false;
	let zeroadSyncAgain = false;
	const zeroadPersist = () => {
		if (!zeroadIdbfsReady) return;
		if (zeroadSyncRunning) {
			zeroadSyncAgain = true;
			return;
		}
		zeroadSyncRunning = true;
		const start = performance.now();
		FS.syncfs(false, (error) => {
			zeroadSyncRunning = false;
			if (error) err(`IDBFS persist: ${error}`);
			else console.log(`[zeroad] IDBFS persist ${(performance.now() - start).toFixed(0)} ms`);
			if (zeroadSyncAgain) {
				zeroadSyncAgain = false;
				zeroadPersist();
			}
		});
	};
	Module.zeroadPersist = zeroadPersist;
	setInterval(zeroadPersist, 10000);
	addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') zeroadPersist(); });
	addEventListener('pagehide', () => zeroadPersist());

	// Browsers start an AudioContext suspended until a user gesture. Keep the contexts the
	// OpenAL layer creates, resume them on the first click or key press, and expose them as
	// Module.audioContexts so tests can read their state.
	if (typeof AudioContext !== 'undefined') {
		const contexts = [];
		Module.audioContexts = contexts;
		const NativeAudioContext = AudioContext;
		globalThis.AudioContext = class extends NativeAudioContext {
			constructor(...args) {
				super(...args);
				contexts.push(this);
			}
		};
		const resumeAll = () => {
			for (const context of contexts)
				if (context.state === 'suspended')
					context.resume();
		};
		for (const type of ['pointerdown', 'keydown', 'touchend'])
			addEventListener(type, resumeAll, { capture: true });
	}
}

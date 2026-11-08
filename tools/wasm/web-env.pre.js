// Browser build (WASM_PROFILE=web): command-line arguments come from the page URL,
// e.g. index.html?arg=-mod=mod&arg=-nosound. Without any, boot the "mod" mod only.
{
	const args = new URLSearchParams(location.search).getAll('arg');
	Module.arguments = args.length ? args : ['-mod=mod'];
}
// Emscripten's ICU port links only ICU's stub data; the real data file is preloaded at /icu.
Module.preRun = [].concat(Module.preRun || [], () => { ENV.ICU_DATA = '/icu'; });
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
}

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

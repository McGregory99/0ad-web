// Browser build (WASM_PROFILE=web): command-line arguments come from the page URL,
// e.g. index.html?arg=-mod=mod&arg=-nosound. Without any, boot the "mod" mod only.
{
	const args = new URLSearchParams(location.search).getAll('arg');
	Module.arguments = args.length ? args : ['-mod=mod'];
}

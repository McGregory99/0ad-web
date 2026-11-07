// JS library for headless Node runs (WASM_PROFILE=node): there is no display to wait for,
// and NODERAWFS reads every file directly, so there are no remote files.
addToLibrary({
	zeroad_wait_frame: function() {},
	zeroad_remote_pread__sig: 'pippd',
	zeroad_remote_pread: function(fd, buffer, count, offset) { return -2; },
});

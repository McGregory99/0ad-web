// JS library for the browser build (WASM_PROFILE=web).
addToLibrary({
	// Hand control back to the browser until the next display refresh. With -sJSPI the wasm
	// stack suspends here, so 0 A.D.'s blocking main loop keeps working: the frame is presented
	// and input events are delivered while the loop waits.
	zeroad_wait_frame__async: true,
	zeroad_wait_frame: async function() {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	},
});

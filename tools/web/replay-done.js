// chrome-shot evalfile step for the browser replay check (tools/web/replay-check.sh): waits for the
// replay started by index.html?replay=... (tools/wasm/web-env.pre.js) to print "# Final state:", then
// returns { hash, lastTurn, seconds } plus the size and SHA-256 of /replay/ai.log when &ailog=1.
// The engine never closes the AI log in the browser, so its last stdio buffer may be missing.
(async () => {
  while (typeof Module === 'undefined' || !Module.zeroadReplay)
    await new Promise((resolve) => setTimeout(resolve, 200));
  const result = await Module.zeroadReplay.done;
  if (new URLSearchParams(location.search).get('ailog') === '1') {
    const bytes = Module.zeroadReplay.readFile('/replay/ai.log');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    result.aiLog = { bytes: bytes.length, sha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') };
  }
  return result;
})()

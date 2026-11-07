// Headless Node runs (WASM_PROFILE=node): forward selected host environment
// variables to the wasm getenv(), which otherwise sees Emscripten's synthetic env.
Module.preRun = Module.preRun || [];
Module.preRun.push(() => {
  const keys = ['HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'ZEROAD_EXECUTABLE'];
  for (const k of Object.keys(process.env)) if (/^(JIT_OPTION_|JS_GC_|MOZ_GC)/.test(k)) keys.push(k);
  for (const k of keys) if (process.env[k] !== undefined) ENV[k] = process.env[k];
});

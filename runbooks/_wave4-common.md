# Wave 4 — rules shared by every wave-4 runbook (read this first)

- Root: `~/DEVELOPMENT/0ad-web` (ROOT). Run every command from ROOT unless a step says otherwise.
- Six workers run at the same time in the same folder. Touch ONLY the files your runbook lists.
- **Engine lock.** The engine build tree and `upstream/binaries/system-wasm` are shared. Any
  `tools/wasm/build-engine.sh` call, any Node run of the engine and any copy of
  `upstream/binaries/system-web` MUST go through the lock:
  `WORKER=<your name> tools/wasm/with-lock.sh <command...>`. It waits for other workers (up to 60 min).
- **Browser tests** use your own copy of the web build (`runs/web-<your name>`), never
  `upstream/binaries/system-web` directly, and your own port (given in your runbook).
- macOS has no `timeout`. Use `perl -e 'alarm shift; exec @ARGV' <seconds> <command...>`.
- A build that fails in a file you did NOT edit: STOP, put the last 30 lines of `runs/engine-make.log` in the
  report, STATUS: blocked. Do not fix other people's code.
- Starting a skirmish in the browser at 1280x720 (main menu → single player → skirmish → start):
  `START='click:491:553,wait:2,click:180:221,wait:3,click:418:221,wait:8,click:1185:681'`
  URL query for the full game: `'?arg=-mod=public&arg=-conf=windowed:true'`
- `tools/web/chrome-shot.mjs` steps: `wait:s shot:name click:x:y key:K keydown:K keyup:K move:x:y stats fps:s reload evalfile:path`.
  Env `CHROME_GPU=1` = real GPU; `CHROME_W`/`CHROME_H` = viewport size. Output: `<outdir>/console.log` + PNGs.
- AGENTS.md rules still apply (no commits, no `rm -rf`, no installs, report evidence as observed/derived/inferred).

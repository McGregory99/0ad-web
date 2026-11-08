# Wave 5 — shared rules

Read `runbooks/_wave4-common.md` first: every rule there applies (engine lock, own web copy,
own port, perl alarm, STOP on foreign build errors, START clicks, chrome-shot steps, AGENTS.md).

Wave 5 additions:
- Copy the web build only like this (keeps the public.zip symlink):
  `WORKER=<you> tools/wasm/with-lock.sh sh -c 'WASM_PROFILE=web tools/wasm/build-engine.sh > runs/<task>-build.log 2>&1; s=$?; if [ $s -eq 0 ]; then rm -r runs/web-<you> 2>/dev/null; cp -RP upstream/binaries/system-web runs/web-<you>; fi; exit $s'`
  If you did NOT change engine code or build files, skip the build:
  `WORKER=<you> tools/wasm/with-lock.sh sh -c 'rm -r runs/web-<you> 2>/dev/null; cp -RP upstream/binaries/system-web runs/web-<you>'`
- Ports: t10=8101, t41=8102, t01=8103, tsk=8104.
- Six workers share the GPU, so fps numbers are noisy. Always report fps together with the time of day.
- Edits in `upstream/` stay uncommitted. The supervisor commits and writes patch files.
- In the report, label every claim: **observed** (you saw it in output), **derived** (computed from
  observed numbers), **inferred** (your guess).

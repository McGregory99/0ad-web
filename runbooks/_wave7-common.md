# Wave 7 — shared rules (read this first)

Read `AGENTS.md` and `runbooks/_wave4-common.md` too: their rules apply, with these changes.

- **This wave you write code.** You may edit ONLY the files your runbook lists under
  "Files you may edit", and create only the new files it names. Never touch other files.
  Do not reformat code you did not change. Keep the file's existing style (tabs vs spaces,
  brace style, comment style).
- When a step says "write", write the code yourself from the description. When a code block is
  given, use it as written unless it does not compile; then fix the smallest thing and say so
  in the report.
- If a test fails because of YOUR change, you may fix your change and retry, up to 3 times per
  step. If it still fails, STOP and report (STATUS: blocked) with the failing output.
- **Locks.** Engine builds and copies of `upstream/binaries/system-web`:
  `WORKER=<you> tools/wasm/with-lock.sh <command...>` (engine lock).
  Every multiplayer test (anything that runs `tools/web/mp-check.mjs` or a native
  `pyrogenesis` with `-autostart-host`/`-autostart-client`) needs the UDP port 20595, so run it
  under the mp lock: `WORKER=<you> LOCK_NAME=mp tools/wasm/with-lock.sh <command...>`.
  Never hold the engine lock while waiting for the mp lock.
- **Keep the Mac awake** for any test longer than a minute: prefix it with `caffeinate -dims`.
- Long commands write to a log under `runs/<task>/` and you show only `tail -20` of it.
- Ports: t71x http 8105 / relay 20610; t71c http 8106 / relay 20620; t82 http 8107; t44 http 8108; t71e http 8109 / relay 20640; t05 http 8110; t45 http 8111; t71e3 http 8109 / relay 20640; t45b http 8111 / relay 20650.
- Your own web build copy is `runs/web-<you>`. Copy it only through the engine lock
  (`cp -RP`, keeps the symlinks).
- No commits. The supervisor reviews your diff (`git diff -- <your files>`) and commits.
- The report always ends with: the exact list of files you changed or created, the commands you
  ran for tests with their observed result, and `git diff --stat -- <your files>`.
- Label every claim **observed**, **derived** or **inferred**.

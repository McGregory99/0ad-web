# 0ad-web — 0 A.D. 0.28.0 playable in the browser (WebAssembly)

Objective: port (not rewrite) the pyrogenesis engine 0.28.0 to WebAssembly with Emscripten. Branch: `main`.
Delivery: `ask-on-risk`. Execution: Opus supervises and writes runbooks; pi workers (local `qwen3.6-35b-a3b`) execute them in Herdr panes. Test runner: native/wasm replay hash comparison.

## Specs

- **S1** — User goal, verbatim: "quiero que traces un plan para reimplementar 0ad en webassembly o para que sea jugable en el navegador. este juego es opensource y por tanto lo he descargado /Users/gcancio/Downloads/0ad-0.28.0-macos-aarch64.dmg"
- **S2** — Workers, verbatim: "no las hagas tu sino que lo hagas con subagentes de pi" / "le damos con pi con qwen local"
- **S3** — Memory, verbatim: "Too esto debe quedar en un engram proyect." → Engram project `0ad-web`, topic `odd/0ad-web/tasks`.
- **S4** — Location, verbatim: "todo el trabajo en una carpeta 0ad-web dentro de development." → `~/DEVELOPMENT/0ad-web`.
- **S5** — Roles, verbatim: "tu, que eres un OPUS. debes ser su supervisor y darles un plan facilitado. ellos solo son los que ejecutan el trabajo sucio" → every task gets a step-by-step runbook in `runbooks/`, a report in `reports/`, and supervisor review.
- **S6** — Go/no-go gate (T0.3): the wasm headless replay must reproduce the native reference hashes. Route A (SpiderMonkey compiled to wasm) if the wasm replay is at most 3x slower than native; otherwise ask the user about Route B (bridge to the browser JS engine).
- **S7** — First playable milestone: single player vs AI, desktop Chrome, light data profile (menu + 1 map + 2 civs, under 300 MB).

Evidence from the shipped DMG (REA, 2026-11-06): `pyrogenesis` 86 MB arm64, statically links ICU, gloox, SDL2, SpiderMonkey, OpenAL, miniupnpc, libsodium, FreeType; separate MoltenVK/AtlasUI/Collada dylibs; `public.zip` 3.5 GB (52,829 files: DDS 2.1 GB, PMD 345 MB, OGG 269 MB, cached XMB).

## Tasks

| ID | Task | Specs | Route | Depends | Status | Evidence |
|----|------|-------|-------|---------|--------|----------|
| T0.1 | Native build + reference replay + native replay time | S1,S6 | pi `t01` | — | in progress | `runbooks/T0.1-*.md` → `reports/T0.1.md` |
| T0.2 | SpiderMonkey 128 → wasm32 (Emscripten, no JIT) | S1,S6 | pi (runbook pending) | T0.1 | pending | |
| T0.3 | Headless wasm replay in Node: hash equality + speed ratio (GATE) | S6 | pi (runbook pending) | T0.2 | pending | |
| T1.1 | Emscripten premake toolchain (pthreads, PROXY_TO_PTHREAD, OffscreenCanvas, 4 GB, wasm EH) | S1 | pi | T0.1 | pending | |
| T1.2 | Third-party libs → wasm (zlib, png, xml2, freetype, ogg/vorbis, fmt, sodium, ICU) | S1 | pi, one per lib | T1.1 | pending | |
| T1.3 | Remove/stub Atlas, FCollada, nvtt, miniupnpc, gloox, curl/mod.io, crash handler | S1 | pi | T0.1 | pending | |
| T1.4 | `lib/sysdep` emscripten platform | S1 | pi | T1.1 | pending | |
| T2.1 | SDL2 window/input in browser | S1 | pi | T1.4 | pending | |
| T2.2 | Main loop on pthread + OffscreenCanvas | S1 | pi | T1.1 | pending | |
| T2.3 | Audio via Emscripten OpenAL | S1 | pi | T1.2 | pending | |
| T2.4 | User data persistence (OPFS/IDBFS) | S1 | pi | T1.4 | pending | |
| T3.1 | WebGL2 backend from the GL/GLES backend | S1 | pi | T0.1 | pending | |
| T3.2 | Shaders → GLSL ES 3.00 | S1 | pi | T3.1 | pending | |
| T3.3 | DDS via S3TC extension; KTX2/Basis later | S1 | pi | T3.1 | pending | |
| T3.4 | Web graphics defaults | S1 | pi | T3.1 | pending | |
| T4.1 | Offline chunking of public.zip + manifest | S1 | pi | T0.1 | pending | |
| T4.2 | Streaming VFS + OPFS cache | S1 | pi | T4.1,T1.4 | pending | |
| T4.3 | Light data profile | S7 | pi | T4.1 | pending | |
| T4.4 | Hosting with COOP/COEP | S1 | pi | T4.1 | pending | |
| T5.1 | Boot to main menu in Chrome | S7 | supervisor + pi | F1–F4 | pending | |
| T5.2 | Skirmish vs AI playable | S7 | supervisor + pi | T5.1 | pending | |
| T5.3 | Reference replays deterministic in browser | S6 | pi | T5.2 | pending | |
| T6.1 | Profiling; Petra AI in worker | S7 | pi | T5.2 | pending | |
| T6.2 | Memory under 4 GB or Memory64 | S7 | pi | T5.2 | pending | |
| T6.3 | Route B (only if gate fails) | S6 | ask user | T0.3 | pending | |
| T7.1 | Networking: WebRTC or WebSocket relay | S1 | pi | T5.2 | pending | |
| T7.2 | Lobby | S1 | pi | T7.1 | pending | |
| T8.1 | License compliance (GPL-2+, CC-BY-SA 3.0, trademark) | S1 | supervisor | — | pending | |
| T8.2 | Browser matrix + e2e | S7 | pi | T5.2 | pending | |

## Log

- **L1** (2026-11-06, user): "Hola. quiero que traces un plan para reimplementar 0ad en webassembly o para que sea jugable en el navegador. este juego es opensource y por tanto lo he descargado /Users/gcancio/Downloads/0ad-0.28.0-macos-aarch64.dmg traza un plan con tareas y te digo a que subagentes vamos a lanzarselas. estima el tiempo que llevara implementarlo usando infinitos agentes. aplica REA"
- **L2** (2026-11-06, user): "quiero que para hacer estas tareas, no las hagas tu sino que lo hagas con subagentes de pi. Too esto debe quedar en un engram proyect. y todo el trabajo en una carpeta 0ad-web dentro de development. DIME LOS PROXIMOS PASOS Y TE CONFIRMO"
- **L3** (2026-11-06, user): "le damos con pi con qwen local"
- **L4** (2026-11-06, user): "ten en cuenta que tu, que eres un OPUS. debes ser su supervisor y darles un plan facilitado. ellos solo son los que ejecutan el trabajo sucio"
- **L5** (2026-11-06, supervisor): repo created; upstream cloned at tag `v0.28.0` (`a2cae4d6`, LFS skipped, 254 MB) into `upstream/`; real data copied from DMG into `data/mods/` (public 3.3 GB, mod 89 MB). Upstream data folders are LFS pointers, so T0.1 step 1 links the real data. Estimate given: MVP 4–6 weeks wall-clock with unlimited strong agents; with a local 35B-A3B worker expect it to be slower and to need more supervisor rewrites of runbooks.
- **L6** (2026-11-06, supervisor): T0.1 runbook written; launching pi worker `t01` in a Herdr pane.

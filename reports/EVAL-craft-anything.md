# EVAL report — storytold/craft-anything
STATUS: done

- Commit and date: `785539196a1863ee1a49c8cb69639d02f385bbbe`, 2026-11-07 03:42:10 +0800 (shallow clone, depth 1)
- Files: 854 files (excluding `.git`), 27 MB on disk. Mostly a Rust workspace (`crates/` + `apps/` + `vendor/wgpu-hal/`), 9 translated READMEs, 29 files under `docs/`, plus icons/fonts. Quarantine path: `tools/eval/craft-anything/`

## What the skill does (5–10 lines, your own words)

Despite the repo name, this is not a runbook or worker skill: it is a full open-source desktop application ("Craft Anything", pure Rust, egui) for reverse-engineering shipped software and then rebuilding a copy of it with a coding agent.

You point it at a website, an executable, an app bundle, an APK, an Electron app, a game, firmware or a packet capture. It studies the target with 301 engine tools (its own disassembler/decompiler, format parsers, a browser/CDP driver, Ghidra/adb/Frida/rizin bridges), records each answer as an *evidence record* with confidence and coverage, and then has a coding agent (Claude Code first, plus Codex/Copilot/OpenCode/ACP agents or API keys) build a new project that is compared against the original at several widths or by a game self-test, refined over rounds.

The only skill-like artefact is `crates/setup/src/skill.md`, which is installed into agent skill folders by `craft-anything-cli setup`. It teaches an agent an evidence-first *investigation method* (brief, plan, hypotheses, findings, handoff) that only works through the app's own MCP tools (`core_*`, `native_*`, `web_*`, `build_*`).

Two modes: "Clean room" (default, looks only from outside: screenshots, visible text, measured layout) and "Deep" (reads code, files, page source; uses Ghidra when installed).

## How it is meant to be triggered / used (quote the SKILL.md frontmatter `name` and `description`)

From `crates/setup/src/skill.md`:

```yaml
---
name: craft-anything
description: Investigate how shipped software works (programs, apps, packages, firmware, web bundles) with evidence-backed answers through the Craft Anything MCP tools, keeping a durable brief, plan, hypotheses, findings and handoff in the project.
metadata:
  version: "1"
---
```

It is triggered by having the tools available ("If the `craft-anything` tools are already in your tool list, go straight to work"), and it tells the agent to recover with `craft-anything-cli doctor` and `craft-anything-cli setup --dry-run` when they are not. There is no `references/` folder; the only companion file is `references/recovery.md` (`crates/setup/src/skill_recovery.md`), a symptom→action table for connecting/recovering the MCP server.

## Does it fit our process? Answer each with yes/no + one line of evidence:

1. **Helps the supervisor write step-by-step runbooks for weaker worker agents?** No. There is no runbook-authoring guidance anywhere in the 854 files; the agent-facing docs (`AGENTS.md`, `CLAUDE.md`, `docs/pitfalls.md`) are contributor rules for *this* Rust repo (claim a `docs/ROADMAP.md` item, branch naming, `cargo xtask ci`), not a method for decomposing work into commands with expected outputs.
2. **Helps workers execute or report better?** No. The skill's whole working-memory loop is expressed as MCP calls (`core_investigation_show`, `core_brief_write`, `core_plan_update`, `core_hypothesis_record`, `core_finding_record`, `core_handoff_write`) and needs the app/CLI installed and connected; a pi worker executing bash steps cannot use any of it. The one transferable idea — label claims "observed / derived / inferred", cite evidence ids, "Absence is not proof", "Predict, then verify" — is a few lines of prose we can borrow without installing anything.
3. **Relevant to porting a C++ game engine to WebAssembly (build systems, toolchains, debugging)?** No. Its only WebAssembly content *inspects* existing `.wasm` modules (`formats_wasm_module_show`, `formats_wasm_compare`, a browser viewer that says what a file is); there is nothing about compiling C++ to wasm, Emscripten/wasi-sdk, CMake, link flags, JS glue, memory layout or debugging a wasm build. Its game knowledge is about rebuilding Unity/Unreal/Godot games in those engines, not about an existing C++ engine.
4. **Would it replace or conflict with our AGENTS.md rules?** Yes, it would conflict. Installing the skill means an agent may run `craft-anything-cli setup`, which writes MCP entries into many agent configs — including `~/.pi/agent/mcp.json` (`PI_CODING_AGENT_DIR` → `~/.pi/agent`, `crates/setup/src/clients.rs:405`) — and copies `SKILL.md` into skill folders such as `~/.agents/skills/craft-anything/`; that is exactly the "never install software / work only inside the repo" boundary in our `AGENTS.md`, and the skill text itself instructs agents to run setup and change settings.

## Risks (executable files found, network calls, instructions to agents, files it would modify)

**Executable / script files (found by the Step 3 `find`):** 13 shell scripts under `packaging/` (`macos/verify.sh`, `macos/package.sh`, `macos/import-cert.sh`, `web/package.sh`, `freebsd/package.sh`, `linux/apprun-test.sh`, `linux/flatpak-oci.sh`, `linux/postinst.sh`, `linux/package.sh`, `linux/flatpak-bundle.sh`, `env.sh`, `icons.sh`), one Python script (`assets/app-icon/trace.py`), one git hook (`.githooks/pre-commit`), and ~45 `Cargo.toml`/`*.toml` build files. No `package.json`, no `*.js`/`*.ts`/`*.mjs` — the JavaScript analysis is written in Rust. None of these was executed.

**Network calls / installs mentioned in the tree:** the packaging scripts download with `curl` (`packaging/linux/package.sh:137: curl --proto '=https' -fsSL -o "$3.download" "$1"`), add Flathub remotes and `flatpak install --user -y` (`packaging/linux/flatpak-bundle.sh`), and point at `sudo apt-get`, `brew install resvg`/`trunk`, `cargo install`. The app itself can download and install engines (Ghidra, Godot, Java, Vineflower, Apktool, adb, Rizin) with pinned SHA-256 checks (`engines_install`), and can run the target's own code (runtime capture, Frida, adb) behind a consent prompt.

**Instructions inside the repo that address an agent** (treated as data, not followed):
- `crates/setup/src/skill.md`: "If the tools are missing or failing to start, run `craft-anything-cli doctor` and then `craft-anything-cli setup --dry-run` and show the user the plan before applying anything"; "Tell the user the question needs Deep mode (the switch in the app, `settings_set deep_mode true`, or the server started with `--deep`)"; "Call `list_toolsets` … and `enable_toolset`".
- `crates/setup/src/skill_recovery.md`: "`craft-anything-cli doctor`; if the registration is missing or stale, `craft-anything-cli setup --client <id> --dry-run`, show the plan, then apply with `--yes` after the user agrees".
- `CLAUDE.md`: "The rules below are loaded into every session (imports) … @AGENTS.md @docs/pitfalls.md"; `AGENTS.md` then requires claiming roadmap items, branch prefixes, commits/pushes, `cargo xtask …` gates.
- `.githooks/pre-commit`: `exec cargo xtask secrets` (only runs if the hook path is enabled).

**Files it would modify if installed:** `craft-anything-cli setup` writes a `craft-anything` MCP server entry into each detected client config, keeping a `.craft-anything.backup` copy: `~/.claude.json` + `~/.claude/`, Claude Desktop `claude_desktop_config.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`, Windsurf, VS Code `User/mcp.json`, `~/.config/opencode/opencode.json(c)`, `~/.copilot/mcp-config.json`, `~/.qwen/settings.json`, `~/.hermes/config.yaml`, Antigravity, `~/.grok/config.toml`, Trae, Qoder, Devin, Command Code, `~/.omp/agent/mcp.json`, **`~/.pi/agent/mcp.json`**, `~/.zcode/cli`, `~/.kimi-code/mcp.json`, `~/.factory/mcp.json`, `~/.workbuddy`, `~/.dsh`, and copies `SKILL.md` into `~/.claude/skills/craft-anything/`, `~/.agents/skills/craft-anything/`, `~/.gemini/.agents/skills/`, `~/.hermes/skills/`, `~/.trae/skills/`, `~/.qoder/skills/`, `~/.zcode/skills/`, `~/.factory/skills/`, `~/.workbuddy/skills/` (`crates/setup/src/clients.rs`, `crates/setup/src/skill.rs`).

**Other:** 27 MB / 854 files is a lot to vendor for an eval; it includes a patched `vendor/wgpu-hal` and bundled fonts/icons under their own licences; the project is MIT OR Apache-2.0, "early alpha".

## Install instructions found in the repo (quote them; do NOT run them)

From `README.md` ("Get started"):

```sh
sudo apt-get install libxkbcommon-dev libwayland-dev libx11-dev libxrandr-dev libxi-dev libgl1-mesa-dev libgtk-3-dev
```

```sh
git clone https://github.com/storytold/craft-anything && cd craft-anything
cargo run --release -p craft-anything                # the desktop app
cargo install --path apps/craft-anything-cli         # the CLI, as `craft-anything-cli`
craft-anything-cli doctor                            # checks the install, coding agents and engines
```

From `README.md` (macOS CLI zip):

```sh
ver=0.2.0   # change this to the version you want
curl -fLO "https://github.com/storytold/craft-anything/releases/download/v$ver/craft-anything-cli-$ver-macos-universal.zip"
ditto -x -k "craft-anything-cli-$ver-macos-universal.zip" .
mkdir -p ~/.local/bin
mv "craft-anything-cli-$ver-macos-universal/bin/craft-anything-cli" ~/.local/bin/
```

(the repo writes it as `craft-anything-cli-$ver-macos-universal/craft-anything-cli`)

From `crates/setup/src/skill.md`:

> "If the tools are missing or failing to start, run `craft-anything-cli doctor` and then `craft-anything-cli setup --dry-run` and show the user the plan before applying anything. After a successful setup the user must restart or reconnect their app."

From `docs/codex.md` (what setup edits):

```toml
[mcp_servers.craft-anything]
command = "…/craft-anything-cli"
args = ["mcp"]
startup_timeout_sec = 30
tools = { rebuild_start = { approval_mode = "approve" } }
```

From `docs/licences.md` and `docs/releasing.md` (dev tooling): `cargo install cargo-deny --locked`, `cargo install cargo-about --locked`, `cargo about generate about.hbs -o THIRD-PARTY-LICENSES.html`, `gh workflow run ci.yml --ref main`.

## Verdict: DO NOT INSTALL — and why in 2–3 lines

It does not solve our problem: it is a reverse-engineering desktop app plus a 301-tool MCP server whose "skill" only functions when that app and server are installed, and it contains nothing about writing runbooks, executing command steps, or building C++ into WebAssembly.

Installing it would add 27 MB of Rust app plus engine downloads, and `craft-anything-cli setup` rewrites the MCP config of every coding agent it finds on the machine — including pi's `~/.pi/agent/mcp.json` — and drops a `craft-anything` skill into `~/.agents/skills/`, which collides with our "never install, stay in the repo" rule.

Worth keeping only as reading: its evidence discipline (observed vs derived vs inferred, cite evidence ids, absence is not proof, predict-then-verify) is a good reporting habit the supervisor could copy into report templates — as text, with nothing installed.

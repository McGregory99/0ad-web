#!/bin/sh
# Runs the reference replay on the Node wasm build and writes runs/<name>.stats (turnstats.mjs).
# Extra arguments are environment assignments, e.g.
#   tools/bench/ai-replay.sh T0.6-remote ZEROAD_AI_REMOTE=1 ZEROAD_AI_LOG=$PWD/runs/T0.6-remote.ailog
# AI test hooks (source/simulation2/components/CCmpAIManager.cpp):
#   ZEROAD_AI_REMOTE=1             run the AI scripts in tools/wasm/ai/ai-worker.js
#   ZEROAD_AI_LOG=<file>           per-turn AI command log (compare with tools/bench/aicmp.mjs)
#   ZEROAD_AI_HASH_SKIP_SCRIPTS=1  state hash without the AI script objects
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="$1"; shift
[ -n "$NAME" ] || { echo "usage: $0 <name> [VAR=value...]" >&2; exit 2; }
H="$(mktemp -d)"
cd "$ROOT/upstream/binaries/system-wasm"
set +e
env "$@" HOME="$H" ZEROAD_EXECUTABLE="$PWD/pyrogenesis" JIT_OPTION_portableBaselineInterpreter=false \
  perl -e 'alarm shift; exec @ARGV' 1800 node pyrogenesis -replay="$ROOT/fixtures/reference-replay/commands.txt" 2>&1 \
  | node "$ROOT/tools/bench/turnstats.mjs" "$ROOT/runs/$NAME.raw.tsv" > "$ROOT/runs/$NAME.stats"
status=$?
set -e
# The temporary HOME only holds the engine's cache and logs.
find "$H" -depth -delete
cat "$ROOT/runs/$NAME.stats"
exit $status

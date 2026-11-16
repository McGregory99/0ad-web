#!/bin/sh
# Browser reference replay check (T5.3, S8-Q1): runs fixtures/reference-replay in headless Chrome and
# compares the final state hash and the AI command log with the Node/native references.
# Usage: tools/web/replay-check.sh <web build dir> <remote|local> <outdir> [port]
#   The build must contain the ?replay= block of tools/wasm/web-env.pre.js (any web build made after T5.3).
#   remote: AI in the Web Worker (default page mode), hash without AI script objects (ZEROAD_AI_HASH_SKIP_SCRIPTS)
#   local:  AI in the engine (?ai=local), full hash, comparable with native
# Writes <outdir>/view (symlinks to the build plus the replay) and <outdir>/console.log; exits 1 on a mismatch.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$(cd "$1" && pwd)"; MODE="$2"; OUT="$3"; PORT="${4:-8195}"
case "$MODE" in
  remote) QUERY='hashskip=1'; WANT=5428b90a27ecd769cd3d76b38ddb11dd ;;
  local) QUERY='ai=local'; WANT=6908836f8d8ca50562faab971ad0c4ca ;;
  *) echo "usage: $0 <web build dir> <remote|local> <outdir> [port]" >&2; exit 2 ;;
esac
WANT_AILOG=3fd36858ecde7c13aaac3a84280cd1b126e80bf6b7f062dda90c65231e8601d8
mkdir -p "$OUT/view/replay"
for f in "$BUILD"/*; do ln -sfn "$f" "$OUT/view/$(basename "$f")"; done
ln -sfn "$ROOT/fixtures/reference-replay/commands.txt" "$OUT/view/replay/commands.txt"
perl -e 'alarm 2400; exec @ARGV' node "$ROOT/tools/web/chrome-shot.mjs" "$OUT/view" "$OUT" \
  "evalfile:$ROOT/tools/web/replay-done.js" \
  "index.html?$QUERY&ailog=1&replay=replay/commands.txt&arg=-replay=/replay/commands.txt" "$PORT"
RESULT="$(grep 'evalfile .*replay-done.js' "$OUT/console.log" | sed 's/.*replay-done.js: //')"
echo "$RESULT"
echo "expected hash $WANT, AI log sha256 $WANT_AILOG"
case "$RESULT" in *"\"hash\":\"$WANT\""*"\"sha256\":\"$WANT_AILOG\""*) echo MATCH ;; *) echo MISMATCH; exit 1 ;; esac

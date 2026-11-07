#!/bin/sh
# Run a command while holding the engine lock. Workers share one build tree and one output
# directory (upstream/binaries/system-wasm), so builds and Node runs of that binary must not overlap.
# Usage: WORKER=<name> tools/wasm/with-lock.sh <command> [args...]
# Waits up to 60 minutes for the lock; exits 3 on timeout. The lock owner is in runs/.engine.lock/owner.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="$ROOT/runs/.engine.lock"
mkdir -p "$ROOT/runs"
i=0
until mkdir "$LOCK" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -gt 720 ]; then echo "lock timeout; held by: $(cat "$LOCK/owner" 2>/dev/null)" >&2; exit 3; fi
  [ $((i % 12)) -eq 1 ] && echo "waiting for lock held by: $(cat "$LOCK/owner" 2>/dev/null)" >&2
  sleep 5
done
echo "${WORKER:-unknown} pid $$ since $(date '+%H:%M:%S'): $*" > "$LOCK/owner"
trap 'rm -r "$LOCK"' EXIT INT TERM HUP
"$@"

#!/bin/sh
# Serve a directory with COOP/COEP and open it in headless Chrome; console lines go to the log.
# Usage: tools/web/chrome-run.sh <dir> <seconds> <log> [query-string] [port]
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$1"; SECS="$2"; LOG="$3"; QUERY="${4:-}"; PORT="${5:-8093}"
node "$ROOT/tools/spikes/serve.mjs" "$DIR" "$PORT" > /dev/null 2>&1 &
SERVER=$!
PROFILE=$(mktemp -d)
perl -e 'alarm shift; exec @ARGV' "$SECS" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --user-data-dir="$PROFILE" --no-first-run --enable-logging=stderr --v=0 \
  --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1280,720 \
  "http://127.0.0.1:$PORT/$QUERY" > "$LOG" 2>&1 || true
kill "$SERVER" 2>/dev/null || true
rm -r "$PROFILE"
grep -E 'CONSOLE' "$LOG" | grep -v 'GPU stall' | sed -E 's/^\[[^]]*\] //; s/, source: .*$//' > "$LOG.console" || true
wc -l < "$LOG.console"

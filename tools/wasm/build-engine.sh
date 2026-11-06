#!/bin/sh
# Generate the Emscripten workspace and build pyrogenesis.wasm into upstream/binaries/system-wasm.
# Usage: tools/wasm/build-engine.sh [make args...]   (logs in runs/engine-*.log)
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/tools/emsdk/emsdk_env.sh" > /dev/null 2>&1
export PKG_CONFIG_LIBDIR="$ROOT/wasm/pkgconfig" PKG_CONFIG_PATH="$ROOT/wasm/pkgconfig"
cd "$ROOT/upstream/build/premake"
CC=emcc CXX=em++ ../../libraries/source/premake-core/bin/premake5 --file=premake5.lua \
  --outpath=../workspaces/emscripten --os=linux --gles --with-system-mozjs \
  --without-atlas --without-nvtt --without-collada --without-lobby --without-miniupnpc \
  --without-tests --without-pch gmake > "$ROOT/runs/engine-premake.log" 2>&1
cd ../workspaces/emscripten
# Link profile. node: headless runs in Node (gate T0.3) with direct host file access.
WASM_PROFILE="${WASM_PROFILE:-node}"
COMMON_LDFLAGS="-O2 --profiling-funcs -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB -sPTHREAD_POOL_SIZE=8"
case "$WASM_PROFILE" in
  node) export LDFLAGS="$COMMON_LDFLAGS -sENVIRONMENT=node,worker -sNODERAWFS=1 -sEXIT_RUNTIME=1 --pre-js $ROOT/tools/wasm/node-env.pre.js" ;;
  *) echo "unknown WASM_PROFILE: $WASM_PROFILE" >&2; exit 2 ;;
esac
echo "profile: $WASM_PROFILE"
set +e
emmake make config=release -j6 "$@" > "$ROOT/runs/engine-make.log" 2>&1
status=$?
set -e
# upstream/package.json declares "type": "module"; Emscripten's output is CommonJS.
printf '{ "type": "commonjs" }\n' > "$ROOT/upstream/binaries/system-wasm/package.json"
echo "make exit: $status (log: runs/engine-make.log)"
grep -cE 'error:' "$ROOT/runs/engine-make.log" || true
exit $status

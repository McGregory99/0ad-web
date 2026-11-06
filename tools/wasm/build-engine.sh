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
set +e
emmake make config=release -j6 "$@" > "$ROOT/runs/engine-make.log" 2>&1
status=$?
set -e
echo "make exit: $status (log: runs/engine-make.log)"
grep -cE 'error:' "$ROOT/runs/engine-make.log" || true
exit $status

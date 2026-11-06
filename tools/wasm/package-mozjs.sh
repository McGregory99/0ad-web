#!/bin/sh
# Package the wasm SpiderMonkey build into wasm/spidermonkey/dist-wasm/lib for the engine link.
# Inputs: obj-wasi from wasm/spidermonkey/build-wasi.sh. Safe to re-run.
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
O="$ROOT/wasm/spidermonkey/mozjs-128.13.0/obj-wasi"
D="$ROOT/wasm/spidermonkey/dist-wasm/lib"
WASI="$ROOT/tools/wasi-sdk/bin"
mkdir -p "$D"
cp "$O/js/src/build/libjs_static.a" "$D/"
cp "$O/wasm32-wasip1-threads/release/libjsrust.a" "$D/"
# mfbt/mozglue/memory objects are built but not archived by mozbuild.
rm -f "$D/libmozglue_extra.a"
(cd "$O" && find mfbt mozglue memory -name '*.o' | sort | xargs "$WASI/llvm-ar" rcs "$D/libmozglue_extra.a")
cp "$ROOT/wasm/deps/wasi-prefix/lib/libz.a" "$D/libwasi_z.a"
# Shim for wasi-libc symbols that Emscripten's libc lacks (see tools/smoke/wasi_compat.c).
. "$ROOT/tools/emsdk/emsdk_env.sh" > /dev/null 2>&1
emcc -O2 -pthread -c "$ROOT/tools/smoke/wasi_compat.c" -o "$D/wasi_compat.o"
rm -f "$D/libwasi_compat.a"
emar rcs "$D/libwasi_compat.a" "$D/wasi_compat.o"
rm -f "$D/wasi_compat.o"
ls -la "$D"

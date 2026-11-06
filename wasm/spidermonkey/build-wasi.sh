#!/bin/sh
set -e
ROOT="$HOME/DEVELOPMENT/0ad-web"
WASI="$ROOT/tools/wasi-sdk"
TC="$ROOT/tools/rustup/toolchains/1.79.0-aarch64-apple-darwin/bin"
export RUSTUP_HOME="$ROOT/tools/rustup" CARGO_HOME="$ROOT/tools/cargo"
export RUSTC="$TC/rustc" CARGO="$TC/cargo" PATH="$TC:$PATH"
export CC="$WASI/bin/clang --sysroot=$WASI/share/wasi-sysroot"
export CXX="$WASI/bin/clang++ --sysroot=$WASI/share/wasi-sysroot"
export AR="$WASI/bin/llvm-ar" NM="$WASI/bin/llvm-nm" RANLIB="$WASI/bin/llvm-ranlib" OBJCOPY="$WASI/bin/llvm-objcopy" STRIP="$WASI/bin/llvm-strip"
# wasi-sdk 24 ships no readelf; configure only needs it as a tool probe
export READELF=/opt/homebrew/opt/llvm/bin/llvm-readelf
export CBINDGEN="$ROOT/tools/cargo/bin/cbindgen"
export HOST_CC=/usr/bin/clang HOST_CXX=/usr/bin/clang++
export MOZCONFIG="$ROOT/wasm/spidermonkey/mozconfig-wasi"
export MOZ_NOSPAM=1 MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE=none
export MOZBUILD_STATE_PATH="$ROOT/wasm/spidermonkey/mozbuild-state"
# zlib built for wasi by runbook T0.2-E1e (js standalone always uses system zlib)
WP="$ROOT/wasm/deps/wasi-prefix"
export PKG_CONFIG_LIBDIR="$WP/lib/pkgconfig" PKG_CONFIG_PATH="$WP/lib/pkgconfig"
# -matomics/-mbulk-memory: the engine links with shared memory (pthreads); every object must allow it.
# SpiderMonkey itself stays single-threaded on wasi (no-op mutexes) and is only used from the main thread.
export CFLAGS="-w -matomics -mbulk-memory -I$WP/include" CXXFLAGS="-w -matomics -mbulk-memory -I$WP/include" LDFLAGS="-L$WP/lib"
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory"
cd "$ROOT/wasm/spidermonkey/mozjs-128.13.0"
/opt/homebrew/bin/python3.12 ./mach build -j4

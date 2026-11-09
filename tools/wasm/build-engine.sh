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
# Native wasm exceptions for every engine object (catching is off by default in Emscripten,
# and JSPI cannot suspend through the JS-based exception wrappers). Changing these flags needs a
# clean rebuild: delete build/workspaces/emscripten/obj first (make does not track flags).
export CFLAGS="-fwasm-exceptions" CXXFLAGS="-fwasm-exceptions"
# Link profile. node: headless runs in Node (gate T0.3) with direct host file access.
# web: browser build (main thread + JSPI), copied to upstream/binaries/system-web with index.html.
WASM_PROFILE="${WASM_PROFILE:-node}"
OUT="$ROOT/upstream/binaries/system-wasm"
COMMON_LDFLAGS="-O2 --profiling-funcs -fwasm-exceptions -Wl,--wrap=vswprintf -Wl,--wrap=swprintf -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB"
# ICU data: the web build preloads a filtered copy (runbooks/T4.3d, T4.3e) without collation, break
# iteration, transliteration, converters, rbnf, units and locales the game does not ship
# (28.6 MB -> 4.3 MB). Needs the host icupkg; without it the full file is used.
ICU_FULL="$ROOT/tools/emsdk/upstream/emscripten/cache/ports/icu/icu/source/data/in/icudt68l.dat"
ICU_DAT="$ICU_FULL"
ICU_HOST="$ROOT/upstream/libraries/macos/icu"
if [ "$WASM_PROFILE" = web ] && [ -x "$ICU_HOST/sbin/icupkg" ]; then
  ICU_DAT="$OUT/icu/icudt68l.dat"
  if [ ! -f "$ICU_DAT" ] || [ "$ROOT/tools/wasm/icu/remove.txt" -nt "$ICU_DAT" ]; then
    mkdir -p "$OUT/icu"; rm -f "$ICU_DAT"
    DYLD_LIBRARY_PATH="$ICU_HOST/lib" "$ICU_HOST/sbin/icupkg" -r "$ROOT/tools/wasm/icu/remove.txt" "$ICU_FULL" "$ICU_DAT"
  fi
fi
case "$WASM_PROFILE" in
  node) export LDFLAGS="$COMMON_LDFLAGS -sPTHREAD_POOL_SIZE=8 -sENVIRONMENT=node,worker -sNODERAWFS=1 -sEXIT_RUNTIME=1 --pre-js $ROOT/tools/wasm/node-env.pre.js --js-library $ROOT/tools/wasm/node-lib.js" ;;
  web)
    W="$ROOT/tools/wasm/web"; D="$ROOT/upstream/binaries/data"
    # Map settings index (runbooks/T4.3h): every map's <ScriptSettings> text extracted at build
    # time, so the game setup screen does not download each map's cached XMB. Regenerated when
    # public.zip or the generator is newer than the existing index.
    PUBLIC_ZIP="$ROOT/upstream/binaries/data/mods/public/public.zip"
    MAPSETTINGS_IDX="$OUT/mapsettings.idx"
    if [ ! -f "$MAPSETTINGS_IDX" ] || [ "$PUBLIC_ZIP" -nt "$MAPSETTINGS_IDX" ] || \
       [ "$ROOT/tools/wasm/map-settings-index.py" -nt "$MAPSETTINGS_IDX" ]; then
      mkdir -p "$OUT"
      python3 -I "$ROOT/tools/wasm/map-settings-index.py" "$PUBLIC_ZIP" "$MAPSETTINGS_IDX"
    fi
    export LDFLAGS="$COMMON_LDFLAGS -sPTHREAD_POOL_SIZE=12 -sENVIRONMENT=web,worker -sJSPI=1 -sJSPI_EXPORTS=zeroad_ai_service -sEXIT_RUNTIME=0 \
      -sMAX_WEBGL_VERSION=2 -sMIN_WEBGL_VERSION=2 -sFULL_ES3=1 -sGL_ENABLE_GET_PROC_ADDRESS=1 \
      -lidbfs.js -sEXPORTED_RUNTIME_METHODS=FS \
      --pre-js $ROOT/tools/wasm/web-env.pre.js --js-library $ROOT/tools/wasm/web-lib.js \
      --preload-file $W/pyrogenesis-exe-placeholder.txt@/0ad/binaries/system/pyrogenesis \
      --preload-file $D/config@/0ad/binaries/data/config \
      --preload-file $MAPSETTINGS_IDX@/0ad/mapsettings.idx \
      -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=zeroad_register_remote_files \
      --preload-file $D/mods/public/mod.json@/0ad/binaries/data/mods/public/mod.json \
      --preload-file $W/overlay/public@/0ad/binaries/data/mods/public \
      --preload-file $ICU_DAT@/icu/icudt68l.dat" ;;
  *) echo "unknown WASM_PROFILE: $WASM_PROFILE" >&2; exit 2 ;;
esac
# Both profiles write the same output file: remove it so make relinks with this profile's flags.
rm -f "$OUT/pyrogenesis" "$OUT/pyrogenesis.wasm" "$OUT/pyrogenesis.data"
echo "profile: $WASM_PROFILE"
set +e
emmake make config=release -j6 "$@" > "$ROOT/runs/engine-make.log" 2>&1
status=$?
set -e
# upstream/package.json declares "type": "module"; Emscripten's output is CommonJS.
printf '{ "type": "commonjs" }\n' > "$ROOT/upstream/binaries/system-wasm/package.json"
# Remote AI worker (ZEROAD_AI_REMOTE=1, see tools/wasm/node-lib.js): looked up next to the script.
[ "$WASM_PROFILE" = node ] && ln -sfn "$ROOT/tools/wasm/ai" "$OUT/ai"
if [ "$WASM_PROFILE" = web ] && [ $status -eq 0 ]; then
  WEB="$ROOT/upstream/binaries/system-web"
  mkdir -p "$WEB"
  cp "$OUT/pyrogenesis" "$WEB/pyrogenesis.js"
  cp "$OUT/pyrogenesis.wasm" "$OUT/pyrogenesis.data" "$ROOT/tools/wasm/web/index.html" "$WEB/"
  rm -r "$WEB/licenses" 2>/dev/null || true
  cp -R "$ROOT/tools/wasm/web/licenses" "$WEB/licenses"
  # The mod archives are streamed with HTTP Range requests (see tools/wasm/web-lib.js), not
  # preloaded: mod.zip alone is 89 MB, 47 MB of it CJK fonts only some locales load. The release
  # archives store every member uncompressed; the web build serves deflated copies
  # (tools/wasm/recompress-zip.py, lossless, the engine inflates them). WASM_PUBLIC_STORED=1 serves
  # the original archives instead.
  PUBLIC_ZIP="$ROOT/upstream/binaries/data/mods/public/public.zip"
  REMOTE_JSON="["
  for MOD in mod public; do
    MOD_ZIP="$ROOT/upstream/binaries/data/mods/$MOD/$MOD.zip"
    SERVED_ZIP="$(cd "$(dirname "$MOD_ZIP")" && pwd -P)/$MOD.zip"
    if [ "${WASM_PUBLIC_STORED:-0}" != 1 ]; then
      DEFLATED_ZIP="$OUT/$MOD-deflate.zip"
      if [ ! -f "$DEFLATED_ZIP" ] || [ "$MOD_ZIP" -nt "$DEFLATED_ZIP" ] || \
         [ "$ROOT/tools/wasm/recompress-zip.py" -nt "$DEFLATED_ZIP" ]; then
        python3 -I "$ROOT/tools/wasm/recompress-zip.py" "$MOD_ZIP" "$DEFLATED_ZIP"
      fi
      SERVED_ZIP="$(cd "$OUT" && pwd -P)/$MOD-deflate.zip"
    fi
    mkdir -p "$WEB/mods/$MOD"
    ln -sf "$SERVED_ZIP" "$WEB/mods/$MOD/$MOD.zip"
    [ "$REMOTE_JSON" = "[" ] || REMOTE_JSON="$REMOTE_JSON, "
    REMOTE_JSON="$REMOTE_JSON{\"path\": \"/0ad/binaries/data/mods/$MOD/$MOD.zip\", \"url\": \"mods/$MOD/$MOD.zip\", \"size\": $(stat -f %z -L "$SERVED_ZIP")}"
  done
  printf '%s]\n' "$REMOTE_JSON" > "$WEB/remote-files.json"
  # Remote AI (ZEROAD_AI_REMOTE=1, see web-lib.js): the worker scripts and the AI modules from
  # public.zip. The modules import each other with VFS-root specifiers ("simulation/ai/..."), which
  # browsers cannot resolve, so they are rewritten relative to ai/modules/simulation/ai/<name>/
  # (every AI module sits at that depth).
  rm -r "$WEB/ai" 2>/dev/null || true
  mkdir -p "$WEB/ai/modules"
  cp "$ROOT/tools/wasm/ai/ai-worker.js" "$ROOT/tools/wasm/ai/codec.js" "$ROOT/tools/wasm/ai/sm-sort.js" "$WEB/ai/"
  unzip -q -o "$PUBLIC_ZIP" 'simulation/ai/*' -d "$WEB/ai/modules"
  find "$WEB/ai/modules" -name '*.js' -exec sed -i '' -E "s#([\"'])simulation/ai/#\\1../../../simulation/ai/#g" {} +
  echo "web build copied to $WEB"
fi
echo "make exit: $status (log: runs/engine-make.log)"
grep -cE 'error:' "$ROOT/runs/engine-make.log" || true
exit $status

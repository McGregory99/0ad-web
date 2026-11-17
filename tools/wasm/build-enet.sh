#!/bin/sh
# Build ENet 1.3.18 for the browser/Node wasm builds with the WebSocket datagram tunnel as its
# socket layer (T7.1b, tools/wasm/enet-tunnel.c, protocol tools/relay/PROTOCOL.md), and
# install it as wasm/deps/prefix/lib/libenet.a (headers there are unchanged).
#
# The upstream sources in wasm/deps/src/enet-1.3.18 stay pristine: unix.c is compiled from a copy
# cut just before its first socket function (enet_socket_bind), which keeps enet_initialize,
# enet_time_*, enet_address_* and enet_host_random_seed; the enet_socket_* functions and
# enet_socketset_select come from enet-tunnel.c. win32.c compiles to nothing outside Windows.
# Usage: tools/wasm/build-enet.sh
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/tools/emsdk/emsdk_env.sh" > /dev/null 2>&1
SRC="$ROOT/wasm/deps/src/enet-1.3.18"
PREFIX="$ROOT/wasm/deps/prefix"
TUNNEL="$ROOT/tools/wasm/enet-tunnel.c"
UNIX_SHA=eb901bc255150fdf867b4a71419b1b233e5bb0858abf298da282320a2fa02045
if [ "$(shasum -a 256 "$SRC/unix.c" | cut -d' ' -f1)" != "$UNIX_SHA" ]; then
  echo "build-enet: $SRC/unix.c is not the ENet 1.3.18 file this script cuts; check the cut point" >&2
  exit 1
fi
OBJ="$(mktemp -d)"
trap 'rm -f "$OBJ"/*.o "$OBJ"/*.c "$OBJ"/libenet.a; rmdir "$OBJ"' EXIT
# Same flags as the configured autotools tree (Makefile CFLAGS and DEFS).
CFLAGS="-O2 -pthread -I$SRC/include -DHAS_GETADDRINFO=1 -DHAS_GETNAMEINFO=1 -DHAS_GETHOSTBYADDR_R=1 \
  -DHAS_GETHOSTBYNAME_R=1 -DHAS_POLL=1 -DHAS_FCNTL=1 -DHAS_INET_PTON=1 -DHAS_INET_NTOP=1 \
  -DHAS_MSGHDR_FLAGS=1 -DHAS_SOCKLEN_T=1"
# unix.c up to (not including) "int" + "enet_socket_bind (": everything else is socket code.
awk '/^enet_socket_bind \(/ { found = 1; exit } { if (NR > 1) print prev; prev = $0 } END { if (!found) exit 1 }' \
  "$SRC/unix.c" > "$OBJ/unix-base.c"
printf '\n#endif /* !_WIN32 */\n' >> "$OBJ/unix-base.c"
for f in callbacks compress host list packet peer protocol; do
  emcc $CFLAGS -c "$SRC/$f.c" -o "$OBJ/$f.o"
done
emcc $CFLAGS -c "$OBJ/unix-base.c" -o "$OBJ/unix-base.o"
emcc $CFLAGS -Wall -Wextra -Wno-unused-parameter -c "$TUNNEL" -o "$OBJ/enet-tunnel.o"
emar rcs "$OBJ/libenet.a" "$OBJ"/*.o
cp "$OBJ/libenet.a" "$PREFIX/lib/libenet.a"
echo "installed $PREFIX/lib/libenet.a"

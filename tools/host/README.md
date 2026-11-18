# Hosting the 0 A.D. web build

This directory holds the deployment kit for the WebAssembly build: a packaging
script, a header checker, a Caddy config and a systemd unit for the multiplayer
relay. Nothing here uploads or publishes anything; every command runs on your
own machine or on the host you own.

## What you need

- **A static file host** that lets you set response headers and answer HTTP
  `Range` requests (any web server, a CDN with header rules, or Caddy). The
  build cannot run without the cross-origin isolation headers below.
- **A machine for the relay** with a public IPv4 address and a TLS certificate
  for its hostname. The relay is a separate process on TCP 20600 plus a UDP port
  range, and the page connects to it with `wss://`.
- **A public URL for the source code** (GPL): the licenses page links to it, so
  the build you upload must be packaged with that URL filled in.
- A TLS certificate for the page host: browsers only allow cross-origin
  isolation on `https://` (or `localhost`).

## Step 1 — package the build

```sh
sh tools/host/package-site.sh runs/web-t44 runs/T4.4/site https://example.org/0ad-web-source
```

- The out directory must not exist yet; the script refuses (exit 2) instead of
  deleting anything.
- Symlinks are resolved (`cp -RL`), so `mods/public/public.zip` and
  `mods/mod/mod.zip` become real files and the directory is self-contained.
- Every `SOURCE_URL` placeholder in `licenses/licenses.html` is replaced with
  the source URL you pass.
- `SHA256SUMS` is written next to the site (`shasum -a 256`, relative paths), so
  you can verify the upload: `shasum -a 256 -c SHA256SUMS` inside the out dir.

The build used here is 958 MiB (observed with `du -shL`).

## Step 2 — upload the out directory

Copy the whole out directory to the web root. For example (not tested here):

```sh
rsync -a --delete-after runs/T4.4/site/ user@webhost:/srv/0ad-web/
```

`--delete-after` is only safe if that directory contains nothing but this site.

## Step 3 — configure the host

### Required headers

| File(s) | Header | Value | Why |
|---|---|---|---|
| every response | `Cross-Origin-Opener-Policy` | `same-origin` | SharedArrayBuffer for pthreads |
| every response | `Cross-Origin-Embedder-Policy` | `require-corp` | same |
| every file | `Cross-Origin-Resource-Policy` | `same-origin` | keep the build usable only from its own origin |
| `*.wasm` | `Content-Type` | `application/wasm` | streaming compilation; a wrong type is refused |
| `*.js` | `Content-Type` | `text/javascript` | module/worker scripts |
| `*.zip` | `Accept-Ranges` + `Range` → `206 Partial Content` | `bytes` | the engine reads the mod zips in 64 KiB blocks |
| `*.zip` | `Content-Encoding` | none | a compressed response cannot be ranged |
| everything except `*.html` | `Cache-Control` | `public, max-age=3600` | big immutable assets |
| `*.html` | `Cache-Control` | `no-cache` | pages change with every build |

### Caddy (reference config, not run here)

`tools/host/Caddyfile` implements the table above. Caddy v2 gets the certificate
automatically:

```sh
SITE_DOMAIN=play.example.org SITE_ROOT=/srv/0ad-web caddy run --config tools/host/Caddyfile
```

Caddy is **not** a reverse proxy for the relay: the relay listens on its own port.

### Other hosts

With nginx, the same table becomes `add_header Cross-Origin-Opener-Policy
same-origin always;` (and the other two) in the `server` block, `types {
application/wasm wasm; }`, and `gzip off` for `location ~ \.zip$`. Range
requests are on by default in nginx. This variant was not tested here.

## Step 4 — check the host

```sh
node tools/host/check-site.mjs https://play.example.org/
```

It reads only, and prints `ok`/`FAIL` per check: page headers, wasm MIME type,
script MIME type, `remote-files.json`, a 64 KiB `Range` request on the first zip
and the licenses page. Exit code 0 means every check passed. Run it locally
first against the test server:

```sh
node tools/spikes/serve.mjs runs/T4.4/site 8108 &
node tools/host/check-site.mjs http://127.0.0.1:8108/
```

## Step 5 — the multiplayer relay

The relay (`tools/relay/relay.mjs`, protocol in `tools/relay/PROTOCOL.md`) gives
each browser socket a real UDP socket on the relay machine. Browsers connect to
`wss://<page host>:20600/` by default.

```sh
# on the relay machine (commands below are examples, not tested here except the
# relay start itself)
useradd --system --no-create-home --shell /usr/sbin/nologin 0ad-relay
mkdir -p /opt/0ad-web/tools
cp -R tools/relay /opt/0ad-web/tools/relay
cd /opt/0ad-web/tools/relay && npm install ws
install -m 0640 tools/host/zeroad-relay.service /etc/systemd/system/
install -d /etc/0ad-web
systemctl daemon-reload && systemctl enable --now zeroad-relay
```

`/etc/0ad-web/relay.env` (read by the unit through `EnvironmentFile=-`):

```
RELAY_PUBLIC_IP=203.0.113.10
RELAY_TLS_CERT=/etc/0ad-web/relay.crt
RELAY_TLS_KEY=/etc/0ad-web/relay.key
```

The unit fixes `RELAY_HOST=0.0.0.0 RELAY_PORT=20600 RELAY_UDP_MIN=20700
RELAY_UDP_MAX=20999`. Open the firewall for **TCP 20600** and **UDP
20700-20999** (for example `ufw allow 20600/tcp` and `ufw allow
20700:20999/udp`; not tested here).

Without TLS you can smoke-test the relay start on the local machine (observed
to print `listening on ws://127.0.0.1:20630/`):

```sh
RELAY_HOST=127.0.0.1 RELAY_PORT=20630 RELAY_UDP_MIN=20700 RELAY_UDP_MAX=20710 \
	perl -e 'alarm shift; exec @ARGV' 3 node tools/relay/relay.mjs
```

If the relay runs on a different host than the page, open the game with an
explicit relay URL:

```
https://play.example.org/?relay=wss://relay.example.org:20600/
```

## Known limits

- **Safari is not supported yet** (it lacks WebAssembly JSPI). Chrome and Firefox work.
- **Host the whole archives, but players download only part of them.** `remote-files.json`
  lists `mod.zip` (73,762,755 bytes) and `public.zip` (908,650,851 bytes); the game reads them
  in 64 KiB Range blocks and caches what it read, so the first match downloads about 110 MB
  (task log T3.3), not the full ~982 MB.
- The relay must have a public IPv4 address and its UDP port range open;
  players behind CGNAT need a relay they can reach.
- The zips must not be compressed by the host, or `Range` requests break.

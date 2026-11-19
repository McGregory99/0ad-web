# ENet datagram tunnel — wire protocol (T7.1b)

The browser build cannot open UDP sockets. Each ENet socket in the browser becomes one WebSocket
to the relay (`tools/relay/relay.mjs`); the relay owns one real UDP socket per WebSocket and
forwards datagrams both ways. ENet itself (reliability, sequencing, peers) runs unchanged on top.

## Transport

- One WebSocket per ENet socket. URL: page query `?relay=<ws url>`; default
  `ws[s]://<page hostname>:20600/` (`wss` when the page is served over https).
- Every message is a binary WebSocket message. Byte 0 is the message type.
- Multi-byte integers are big-endian. An IPv4 address is 4 bytes in network order: exactly the
  bytes of `ENetAddress.host` as stored in memory.

## Messages

| Type | Direction | Layout | Meaning |
|---|---|---|---|
| `0x01` BIND | client → relay | `[0x01][u16 port]` | Bind this session's UDP socket to `0.0.0.0:port` on the relay (`0` = any free port). Must be the first message; sent exactly once. |
| `0x02` SEND | client → relay | `[0x02][4 B ipv4][u16 port][payload]` | Send `payload` as one UDP datagram from the session's socket to `ipv4:port`. Ignored before BOUND. |
| `0x03` META | client → relay | `[0x03][utf-8 JSON object]` | Room metadata (name and player count) shown by `GET /rooms`. At most 513 bytes in total. Dropped, without closing the session, when the session is not a room, the message is too long, or the text is not a JSON object. Only `name` and `players` are read; a later META replaces an earlier one. |
| `0x81` BOUND | relay → client | `[0x81][4 B ipv4][u16 port]` | Bind succeeded. `ipv4:port` is the address peers should use (the relay's public address, or `0.0.0.0` when the relay does not know it). |
| `0x82` ERROR | relay → client | `[0x82][utf-8 text]` | Bind failed (e.g. port in use) or protocol error; the relay closes the WebSocket after sending it. The browser marks the socket failed: ENet's send and receive on it return -1. |
| `0x83` RECV | relay → client | `[0x83][4 B ipv4][u16 port][payload]` | A UDP datagram arrived on the session's socket from `ipv4:port`. |

## Limits

- Payload at most 4096 bytes (ENet MTU in the game is 1372; `NetEnet.cpp:51`). Larger SEND
  messages are dropped.
- META messages are at most 513 bytes in total.
- Closing the WebSocket closes the UDP socket, and the reverse.
- The relay may enforce a port range, an idle timeout and a per-session rate limit.

## Room list

A session is a **room** when its bound UDP port is inside `roomMin..roomMax` (both ends
included). Defaults are `20700..20999`, the range the browser build picks a room code from
(T7.1e: the room code is the host's UDP port on the relay). Override them with
`RELAY_ROOM_MIN` / `RELAY_ROOM_MAX` (or the `roomMin` / `roomMax` options of `startRelay`).

`GET /rooms` on the same HTTP(S) server lists the open rooms, sorted by `code` ascending:

```json
{"rooms":[{"code":20705,"name":"Ana's game","players":2,"age":12}]}
```

- `code` is the session's UDP port on the relay.
- `name` and `players` are `null` until the session sends a META. `name` is the string with
  control characters removed, trimmed and cut to 40 characters (or `null`); `players` is an
  integer from 0 to 64 (or `null`).
- `age` is the whole number of seconds since BOUND.
- A closed session disappears from the list at once.
- A query string is ignored (`/rooms?x=1` is `/rooms`). Other paths answer `404`; other
  methods on `/rooms` answer `405` with `Allow: GET`.

Response headers: `Content-Type: application/json`, `Cache-Control: no-store`,
`Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, so a page on
any origin can read the list.

**Names are user text.** Clients must display them as plain text (text content, never HTML),
so a name cannot inject markup into the room list.

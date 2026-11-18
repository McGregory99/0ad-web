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
| `0x81` BOUND | relay → client | `[0x81][4 B ipv4][u16 port]` | Bind succeeded. `ipv4:port` is the address peers should use (the relay's public address, or `0.0.0.0` when the relay does not know it). |
| `0x82` ERROR | relay → client | `[0x82][utf-8 text]` | Bind failed (e.g. port in use) or protocol error; the relay closes the WebSocket after sending it. The browser marks the socket failed: ENet's send and receive on it return -1. |
| `0x83` RECV | relay → client | `[0x83][4 B ipv4][u16 port][payload]` | A UDP datagram arrived on the session's socket from `ipv4:port`. |

## Limits

- Payload at most 4096 bytes (ENet MTU in the game is 1372; `NetEnet.cpp:51`). Larger SEND
  messages are dropped.
- Closing the WebSocket closes the UDP socket, and the reverse.
- The relay may enforce a port range, an idle timeout and a per-session rate limit.

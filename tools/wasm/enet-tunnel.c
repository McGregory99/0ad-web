/*
 * enet-tunnel.c — ENet 1.3.18 socket layer for the browser build of 0 A.D. (0ad-web T7.1b).
 *
 * Browsers cannot open UDP sockets, so every ENet datagram socket becomes one WebSocket to a UDP
 * relay (tools/relay/relay.mjs, wire protocol in tools/relay/PROTOCOL.md).
 *
 * The WebSockets live on a dedicated "network I/O" pthread, not on the browser main thread: the
 * main thread runs the engine under JSPI and does not always return to the event loop (the
 * multiplayer autostart loop in GameSetup.cpp sleeps in a loop before the main loop starts, map
 * loading can stall it), and a WebSocket only delivers events when its thread's event loop runs.
 * The I/O thread starts at program start (before main, while the preloaded pthread pool still has
 * free workers), sets up its JavaScript side (tools/wasm/enet-tunnel.pre.js) and returns to its
 * event loop. No Emscripten proxying is used to reach it: proxying between two workers is relayed
 * by the main thread. Instead:
 *
 *   - create/bind/send/destroy append a command to a shared queue (tunnelLock) and bump a futex
 *     word; the I/O thread waits on that word with Atomics.waitAsync and drains the queue with
 *     zeroad_net_tx_pop;
 *   - the I/O thread's onmessage handler copies each RECV frame into wasm memory and appends it to
 *     the socket's queue (zeroad_net_rx_alloc + zeroad_net_rx_push);
 *   - enet_socket_receive pops from that queue without blocking, and enet_socket_wait waits on a
 *     condition variable with ENet's timeout (network threads only; never on the main thread).
 *
 * Without the JavaScript side (Node build: Module.zeroadNet is defined only in the browser main
 * thread) no I/O thread starts; sockets are created but send and receive nothing.
 * Log lines from the I/O thread reach the page console through the main thread's mailbox
 * (zeroad_net_log), which is drained even while the main thread spins in a futex wait.
 *
 * An ENetSocket is an index into a fixed table. Each slot carries a generation counter that the
 * JavaScript side echoes back, so a frame that arrives for a destroyed (or reused) slot is dropped.
 * Only ENET_SOCKET_TYPE_DATAGRAM is supported; the stream functions fail.
 *
 * The rest of ENet's unix.c (enet_initialize, enet_time_*, enet_address_*,
 * enet_host_random_seed) is compiled unchanged from the pristine source by tools/wasm/build-enet.sh.
 *
 * ENet is Copyright (c) 2002-2024 Lee Salzman, MIT licence; this file is under the same licence.
 */
#include <emscripten/em_asm.h>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define ENET_BUILDING_LIB 1
#include "enet/enet.h"

#define TUNNEL_MAX_SOCKETS 64
#define TUNNEL_MAX_FRAMES 1024                 /* per socket receive queue */
#define TUNNEL_MAX_BYTES (4 * 1024 * 1024)     /* per socket receive queue */
#define TUNNEL_HEADER 7                        /* type + ipv4 + port */
#define TUNNEL_MAX_PAYLOAD 4096                /* PROTOCOL.md limit */
#define TUNNEL_SEND 0x02
#define TUNNEL_RECV 0x83
#define TUNNEL_BIND_TIMEOUT_MS 5000           /* one relay round trip; a host must not wait long */

typedef struct TunnelFrame
{
    struct TunnelFrame * next;
    size_t length;          /* bytes in data: the whole RECV message, header included */
    uint8_t data [];
} TunnelFrame;

typedef struct
{
    int used;
    int generation;
    int boundKnown;
    int failed;              /* the relay refused or closed this socket: send and receive fail */
    ENetAddress bound;       /* from the relay's BOUND message */
    enet_uint16 requestedPort;
    TunnelFrame * head;
    TunnelFrame * tail;
    size_t frames;
    size_t bytes;
} TunnelSocket;

/* A command for the I/O thread. JavaScript reads the fields at fixed offsets (enet-tunnel.pre.js):
   next 0, type 4, slot 8, generation 12, port 16, length 20, data 24. */
typedef struct TunnelCommand
{
    struct TunnelCommand * next;
    int32_t type;
    int32_t slot;
    int32_t generation;
    int32_t port;
    int32_t length;
    uint8_t data [];
} TunnelCommand;

_Static_assert (offsetof (TunnelCommand, type) == 4 && offsetof (TunnelCommand, slot) == 8 &&
                offsetof (TunnelCommand, generation) == 12 && offsetof (TunnelCommand, port) == 16 &&
                offsetof (TunnelCommand, length) == 20 && offsetof (TunnelCommand, data) == 24,
                "TunnelCommand layout must match enet-tunnel.pre.js");

enum { TUNNEL_OPEN = 1, TUNNEL_BIND = 2, TUNNEL_SEND_DATA = 3, TUNNEL_CLOSE = 4 };

/* Counters shown by Module.zeroadNet.stats: 0-7 are written by the I/O thread's JavaScript;
   8 = datagrams waiting in receive queues for ENet, 9 = commands waiting for the I/O thread. */
static uint32_t tunnelStats [10];
static size_t tunnelRxCount;

static TunnelSocket tunnelSockets [TUNNEL_MAX_SOCKETS];
static pthread_mutex_t tunnelLock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t tunnelArrived = PTHREAD_COND_INITIALIZER;
static TunnelCommand * tunnelTxHead, * tunnelTxTail;
static size_t tunnelTxCount;
static uint32_t tunnelTxSignal;          /* futex word the I/O thread waits on */
static int tunnelEnabled;                /* I/O thread started */
static char tunnelRelayUrl [512];

/* Queue a command for the I/O thread (takes ownership). Without an I/O thread it is dropped. */
static void
tunnel_post (TunnelCommand * command)
{
    int queued = 0;
    command -> next = NULL;
    pthread_mutex_lock (& tunnelLock);
    if (tunnelEnabled && (command -> type != TUNNEL_SEND_DATA || tunnelTxCount < TUNNEL_MAX_FRAMES))
    {
        if (tunnelTxTail != NULL)
          tunnelTxTail -> next = command;
        else
          tunnelTxHead = command;
        tunnelTxTail = command;
        ++ tunnelTxCount;
        tunnelStats [9] = (uint32_t) tunnelTxCount;
        queued = 1;
    }
    pthread_mutex_unlock (& tunnelLock);
    if (! queued)
    {
        free (command);
        return;
    }
    __atomic_add_fetch (& tunnelTxSignal, 1, __ATOMIC_SEQ_CST);
    emscripten_futex_wake (& tunnelTxSignal, INT_MAX);
}

static void
tunnel_post_control (int type, int slot, int generation, int port)
{
    TunnelCommand * command = (TunnelCommand *) malloc (sizeof (TunnelCommand));
    if (command == NULL)
      return;
    command -> type = type;
    command -> slot = slot;
    command -> generation = generation;
    command -> port = port;
    command -> length = 0;
    tunnel_post (command);
}

static void *
tunnel_io_thread (void * argument)
{
    (void) argument;
    EM_ASM ({ zeroadNetStartIoThread (UTF8ToString ($0), $1, $2); },
            tunnelRelayUrl, & tunnelTxSignal, tunnelStats);
    /* Return to this worker's event loop; the WebSocket handlers run there. */
    emscripten_exit_with_live_runtime ();
    return NULL;
}

/* Runs before main on the main thread: start the I/O thread when the page set up Module.zeroadNet. */
__attribute__ ((constructor)) static void
tunnel_start (void)
{
    pthread_t thread;
    pthread_attr_t attributes;
    int hasPage = EM_ASM_INT ({
        if (typeof Module.zeroadNet !== 'object' || typeof zeroadNetStartIoThread !== 'function') return 0;
        stringToUTF8 (Module.zeroadNet.relayUrl, $0, $1);
        Module.zeroadNet.statsPointer = $2;
        return 1;
    }, tunnelRelayUrl, (int) sizeof (tunnelRelayUrl), tunnelStats);
    if (! hasPage)
      return;
    pthread_attr_init (& attributes);
    pthread_attr_setstacksize (& attributes, 64 * 1024);
    if (pthread_create (& thread, & attributes, tunnel_io_thread, NULL) == 0)
    {
        pthread_detach (thread);
        tunnelEnabled = 1;
    }
    pthread_attr_destroy (& attributes);
}

/* Caller holds tunnelLock. */
static TunnelSocket *
tunnel_get (ENetSocket socket)
{
    if (socket < 0 || socket >= TUNNEL_MAX_SOCKETS || ! tunnelSockets [socket].used)
      return NULL;
    return & tunnelSockets [socket];
}

/* Caller holds tunnelLock. Returns the detached list; free it outside the lock. */
static TunnelFrame *
tunnel_detach_queue (TunnelSocket * s)
{
    TunnelFrame * list = s -> head;
    tunnelRxCount -= s -> frames;
    tunnelStats [8] = (uint32_t) tunnelRxCount;
    s -> head = s -> tail = NULL;
    s -> frames = s -> bytes = 0;
    return list;
}

static void
tunnel_free_frames (TunnelFrame * list)
{
    while (list != NULL)
    {
        TunnelFrame * next = list -> next;
        free (list);
        list = next;
    }
}

/* Absolute CLOCK_REALTIME deadline timeoutMs from now (pthread_cond_timedwait's clock). */
static void
tunnel_deadline (struct timespec * deadline, enet_uint32 timeoutMs)
{
    clock_gettime (CLOCK_REALTIME, deadline);
    deadline -> tv_sec += timeoutMs / 1000;
    deadline -> tv_nsec += (long) (timeoutMs % 1000) * 1000000L;
    if (deadline -> tv_nsec >= 1000000000L)
    {
        deadline -> tv_sec += 1;
        deadline -> tv_nsec -= 1000000000L;
    }
}

/* ---- Called from JavaScript on the network I/O thread (tools/wasm/enet-tunnel.pre.js) ---- */

/* Buffer for one RECV message of `length` bytes; hand it to zeroad_net_rx_push. */
EMSCRIPTEN_KEEPALIVE uint8_t *
zeroad_net_rx_alloc (int length)
{
    TunnelFrame * frame;
    if (length < TUNNEL_HEADER || length > TUNNEL_HEADER + TUNNEL_MAX_PAYLOAD)
      return NULL;
    frame = (TunnelFrame *) malloc (sizeof (TunnelFrame) + (size_t) length);
    if (frame == NULL)
      return NULL;
    frame -> next = NULL;
    frame -> length = (size_t) length;
    return frame -> data;
}

/* Queue a buffer from zeroad_net_rx_alloc on socket (slot, generation). Takes ownership.
   Returns 1 if queued, 0 if dropped (socket gone, or queue full). */
EMSCRIPTEN_KEEPALIVE int
zeroad_net_rx_push (int slot, int generation, uint8_t * data)
{
    TunnelFrame * frame = (TunnelFrame *) (data - offsetof (TunnelFrame, data));
    TunnelSocket * s;
    int queued = 0;

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (slot);
    if (s != NULL && s -> generation == generation &&
        s -> frames < TUNNEL_MAX_FRAMES && s -> bytes + frame -> length <= TUNNEL_MAX_BYTES)
    {
        if (s -> tail != NULL)
          s -> tail -> next = frame;
        else
          s -> head = frame;
        s -> tail = frame;
        ++ s -> frames;
        s -> bytes += frame -> length;
        tunnelStats [8] = (uint32_t) ++ tunnelRxCount;
        queued = 1;
    }
    pthread_mutex_unlock (& tunnelLock);

    if (queued)
      pthread_cond_broadcast (& tunnelArrived);
    else
      free (frame);
    return queued;
}

/* The relay answered BIND. host holds the 4 address bytes in memory order (network order). */
EMSCRIPTEN_KEEPALIVE void
zeroad_net_bound (int slot, int generation, enet_uint32 host, int port)
{
    TunnelSocket * s;
    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (slot);
    if (s != NULL && s -> generation == generation)
    {
        s -> bound.host = host;
        s -> bound.port = (enet_uint16) port;
        s -> boundKnown = 1;
    }
    pthread_mutex_unlock (& tunnelLock);
    /* enet_socket_bind waits for this answer (hosts only). */
    pthread_cond_broadcast (& tunnelArrived);
}

/* The relay sent ERROR or closed the WebSocket on its own. Later sends and receives fail. */
EMSCRIPTEN_KEEPALIVE void
zeroad_net_failed (int slot, int generation)
{
    TunnelSocket * s;
    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (slot);
    if (s != NULL && s -> generation == generation)
      s -> failed = 1;
    pthread_mutex_unlock (& tunnelLock);
    pthread_cond_broadcast (& tunnelArrived);
}

/* Next command for the I/O thread, or NULL. JavaScript frees it with zeroad_net_free. */
EMSCRIPTEN_KEEPALIVE TunnelCommand *
zeroad_net_tx_pop (void)
{
    TunnelCommand * command;
    pthread_mutex_lock (& tunnelLock);
    command = tunnelTxHead;
    if (command != NULL)
    {
        tunnelTxHead = command -> next;
        if (tunnelTxHead == NULL)
          tunnelTxTail = NULL;
        -- tunnelTxCount;
        tunnelStats [9] = (uint32_t) tunnelTxCount;
    }
    pthread_mutex_unlock (& tunnelLock);
    return command;
}

EMSCRIPTEN_KEEPALIVE void *
zeroad_net_malloc (int size)
{
    return malloc ((size_t) size);
}

EMSCRIPTEN_KEEPALIVE void
zeroad_net_free (void * pointer)
{
    free (pointer);
}

/* Print a NUL-terminated message from zeroad_net_malloc on the page console (takes ownership). */
EMSCRIPTEN_KEEPALIVE void
zeroad_net_log (char * message)
{
    MAIN_THREAD_ASYNC_EM_ASM ({
        console.log (UTF8ToString ($0));
        _zeroad_net_free ($0);
    }, message);
}

/* ---- Room list (T7.2b, PROTOCOL.md "Room list") ---- */

/* Announce the room of the tunnel socket bound to UDP `port` (the room code) to the relay: one
   META message [0x03][utf-8 JSON object], sent verbatim like a SEND. Returns 0, or -1 when no
   open socket is bound to that port or the JSON does not fit the relay's 513-byte META limit. */
EMSCRIPTEN_KEEPALIVE int
zeroad_net_room_meta (int port, const char * json)
{
    TunnelCommand * command;
    size_t length;
    int slot = -1, generation = 0, i;

    if (json == NULL || (length = strlen (json)) > 512)
      return -1;

    pthread_mutex_lock (& tunnelLock);
    for (i = 0; i < TUNNEL_MAX_SOCKETS; ++ i)
    {
        TunnelSocket * s = & tunnelSockets [i];
        if (s -> used && ! s -> failed && s -> boundKnown && (int) s -> bound.port == port)
        {
            slot = i;
            generation = s -> generation;
            break;
        }
    }
    pthread_mutex_unlock (& tunnelLock);

    if (slot < 0)
      return -1;

    command = (TunnelCommand *) malloc (sizeof (TunnelCommand) + 1 + length);
    if (command == NULL)
      return -1;
    command -> type = TUNNEL_SEND_DATA;
    command -> slot = slot;
    command -> generation = generation;
    command -> port = 0;
    command -> length = (int32_t) (1 + length);
    command -> data [0] = 0x03;
    memcpy (command -> data + 1, json, length);
    tunnel_post (command);
    return 0;
}

/* The relay's last room list text (GET /rooms), "" before the first answer or after a failed
   fetch. Asks Module.zeroadNet.roomsText() (main thread, enet-tunnel.pre.js), which fetches again
   when none is running and the last one started more than 2 s ago. The caller frees the result. */
EM_JS (char *, zeroad_net_rooms_json, (void), {
    if (typeof Module.zeroadNet !== 'object' || typeof Module.zeroadNet.roomsText !== 'function')
        return stringToNewUTF8 ("");
    return stringToNewUTF8 (Module.zeroadNet.roomsText ());
});

/* ---- ENet socket API ---- */

ENetSocket
enet_socket_create (ENetSocketType type)
{
    int slot, generation = 0;

    if (type != ENET_SOCKET_TYPE_DATAGRAM)
      return ENET_SOCKET_NULL;

    pthread_mutex_lock (& tunnelLock);
    for (slot = 0; slot < TUNNEL_MAX_SOCKETS; ++ slot)
      if (! tunnelSockets [slot].used)
        break;
    if (slot < TUNNEL_MAX_SOCKETS)
    {
        TunnelSocket * s = & tunnelSockets [slot];
        generation = s -> generation + 1;
        memset (s, 0, sizeof (* s));
        s -> used = 1;
        s -> generation = generation;
    }
    pthread_mutex_unlock (& tunnelLock);

    if (slot == TUNNEL_MAX_SOCKETS)
      return ENET_SOCKET_NULL;

    tunnel_post_control (TUNNEL_OPEN, slot, generation, 0);
    return slot;
}

int
enet_socket_bind (ENetSocket socket, const ENetAddress * address)
{
    int generation, port = address != NULL ? address -> port : 0;
    TunnelSocket * s;
    struct timespec deadline;
    int result;

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (socket);
    if (s != NULL)
    {
        s -> requestedPort = (enet_uint16) port;
        generation = s -> generation;
    }
    pthread_mutex_unlock (& tunnelLock);

    if (s == NULL)
      return -1;

    /* The relay binds 0.0.0.0:port; the requested host address is ignored. */
    tunnel_post_control (TUNNEL_BIND, socket, generation, port);

    /* Clients (port 0) never learn their port: return at once. A host must know immediately
       whether the relay bound the requested port, because its own client connects to
       127.0.0.1:port (JSInterface_Network.cpp) — if the bind failed that is somebody else's game.
       Waiting here is safe on the main thread: the WebSocket lives on the network I/O thread,
       which answers without the main thread. It is short (one relay round trip) and happens only
       when hosting, so the GUI learns of a failure before it claims to host. */
    if (port == 0)
      return 0;
    if (! tunnelEnabled)
      return 0;  /* no I/O thread (Node build): keep the old "bind always succeeds" behaviour */

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (socket);
    if (s == NULL || s -> generation != generation)
    {
        pthread_mutex_unlock (& tunnelLock);
        return -1;
    }
    if (! s -> boundKnown && ! s -> failed)
    {
        tunnel_deadline (& deadline, TUNNEL_BIND_TIMEOUT_MS);
        while (s -> used && s -> generation == generation && ! s -> boundKnown && ! s -> failed)
            if (pthread_cond_timedwait (& tunnelArrived, & tunnelLock, & deadline) == ETIMEDOUT)
                break;
    }
    result = (s -> used && s -> generation == generation && s -> boundKnown && ! s -> failed) ? 0 : -1;
    pthread_mutex_unlock (& tunnelLock);
    return result;
}

int
enet_socket_get_address (ENetSocket socket, ENetAddress * address)
{
    TunnelSocket * s;
    int result = -1;

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (socket);
    if (s != NULL)
    {
        if (s -> boundKnown)
          * address = s -> bound;
        else
        {
            address -> host = ENET_HOST_ANY;
            address -> port = s -> requestedPort;
        }
        result = 0;
    }
    pthread_mutex_unlock (& tunnelLock);
    return result;
}

int
enet_socket_listen (ENetSocket socket, int backlog)
{
    (void) socket;
    (void) backlog;
    return -1;
}

int
enet_socket_set_option (ENetSocket socket, ENetSocketOption option, int value)
{
    (void) socket;
    (void) option;
    (void) value;
    return 0;
}

int
enet_socket_get_option (ENetSocket socket, ENetSocketOption option, int * value)
{
    (void) socket;
    switch (option)
    {
        case ENET_SOCKOPT_ERROR:
            * value = 0;
            return 0;

        case ENET_SOCKOPT_TTL:
            * value = 64;
            return 0;

        default:
            return -1;
    }
}

int
enet_socket_connect (ENetSocket socket, const ENetAddress * address)
{
    (void) socket;
    (void) address;
    return -1;
}

ENetSocket
enet_socket_accept (ENetSocket socket, ENetAddress * address)
{
    (void) socket;
    (void) address;
    return ENET_SOCKET_NULL;
}

int
enet_socket_shutdown (ENetSocket socket, ENetSocketShutdown how)
{
    (void) socket;
    (void) how;
    return 0;
}

void
enet_socket_destroy (ENetSocket socket)
{
    TunnelSocket * s;
    TunnelFrame * pending = NULL;
    int generation = 0;

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (socket);
    if (s != NULL)
    {
        pending = tunnel_detach_queue (s);
        generation = s -> generation;
        /* Keep the generation: the next create on this slot increments it, so frames that
           arrive late for this socket no longer match. */
        s -> used = 0;
    }
    pthread_mutex_unlock (& tunnelLock);

    if (s == NULL)
      return;

    tunnel_free_frames (pending);
    pthread_cond_broadcast (& tunnelArrived);
    tunnel_post_control (TUNNEL_CLOSE, socket, generation, 0);
}

int
enet_socket_send (ENetSocket socket,
                  const ENetAddress * address,
                  const ENetBuffer * buffers,
                  size_t bufferCount)
{
    size_t i, length = 0, offset;
    TunnelCommand * command;
    TunnelSocket * s;
    uint8_t * message;
    int generation = 0, valid;

    if (address == NULL)
      return -1;

    for (i = 0; i < bufferCount; ++ i)
      length += buffers [i].dataLength;

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (socket);
    valid = s != NULL && ! s -> failed;
    if (valid)
      generation = s -> generation;
    pthread_mutex_unlock (& tunnelLock);

    if (! valid)
      return -1;

    /* The relay drops larger datagrams; behave like a lossy network instead of failing. */
    if (length > TUNNEL_MAX_PAYLOAD)
      return (int) length;

    command = (TunnelCommand *) malloc (sizeof (TunnelCommand) + TUNNEL_HEADER + length);
    if (command == NULL)
      return 0;
    command -> type = TUNNEL_SEND_DATA;
    command -> slot = socket;
    command -> generation = generation;
    command -> port = 0;
    command -> length = (int32_t) (TUNNEL_HEADER + length);
    message = command -> data;

    message [0] = TUNNEL_SEND;
    memcpy (message + 1, & address -> host, 4);
    message [5] = (uint8_t) (address -> port >> 8);
    message [6] = (uint8_t) (address -> port & 0xFF);
    offset = TUNNEL_HEADER;
    for (i = 0; i < bufferCount; ++ i)
    {
        memcpy (message + offset, buffers [i].data, buffers [i].dataLength);
        offset += buffers [i].dataLength;
    }

    tunnel_post (command);
    return (int) length;
}

int
enet_socket_receive (ENetSocket socket,
                     ENetAddress * address,
                     ENetBuffer * buffers,
                     size_t bufferCount)
{
    TunnelSocket * s;
    TunnelFrame * frame = NULL;
    size_t i, payloadLength, capacity = 0, offset;
    int failed = 0;

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (socket);
    if (s != NULL)
      failed = s -> failed;
    if (s != NULL && s -> head != NULL)
    {
        frame = s -> head;
        s -> head = frame -> next;
        if (s -> head == NULL)
          s -> tail = NULL;
        -- s -> frames;
        s -> bytes -= frame -> length;
        tunnelStats [8] = (uint32_t) -- tunnelRxCount;
    }
    pthread_mutex_unlock (& tunnelLock);

    if (s == NULL)
      return -1;
    if (frame == NULL)
      return failed ? -1 : 0;

    for (i = 0; i < bufferCount; ++ i)
      capacity += buffers [i].dataLength;
    payloadLength = frame -> length - TUNNEL_HEADER;
    if (payloadLength > capacity)
    {
        /* Like recvmsg with MSG_TRUNC: ENet skips the datagram. */
        free (frame);
        return -2;
    }

    if (address != NULL)
    {
        memcpy (& address -> host, frame -> data + 1, 4);
        address -> port = (enet_uint16) ((frame -> data [5] << 8) | frame -> data [6]);
    }

    offset = TUNNEL_HEADER;
    for (i = 0; i < bufferCount && offset < frame -> length; ++ i)
    {
        size_t n = frame -> length - offset;
        if (n > buffers [i].dataLength)
          n = buffers [i].dataLength;
        memcpy (buffers [i].data, frame -> data + offset, n);
        offset += n;
    }

    free (frame);
    return (int) payloadLength;
}

int
enet_socketset_select (ENetSocket maxSocket, ENetSocketSet * readSet, ENetSocketSet * writeSet, enet_uint32 timeout)
{
    ENetSocketSet wantRead;
    struct timespec deadline;
    int waited = 0, ready, socket;
    int mayBlock = timeout > 0 && ! emscripten_is_main_runtime_thread ();

    if (readSet != NULL)
      wantRead = * readSet;
    else
      FD_ZERO (& wantRead);
    if (maxSocket >= TUNNEL_MAX_SOCKETS)
      maxSocket = TUNNEL_MAX_SOCKETS - 1;

    pthread_mutex_lock (& tunnelLock);
    for (;;)
    {
        ready = 0;
        for (socket = 0; socket <= maxSocket; ++ socket)
        {
            if (FD_ISSET (socket, & wantRead))
            {
                TunnelSocket * s = tunnel_get (socket);
                if (s != NULL && (s -> head != NULL || s -> failed))
                  ++ ready;
            }
            /* Sends never block. */
            if (writeSet != NULL && FD_ISSET (socket, writeSet) && tunnel_get (socket) != NULL)
              ++ ready;
        }
        if (ready > 0 || ! mayBlock)
          break;
        if (! waited)
        {
            tunnel_deadline (& deadline, timeout);
            waited = 1;
        }
        if (pthread_cond_timedwait (& tunnelArrived, & tunnelLock, & deadline) == ETIMEDOUT)
          mayBlock = 0;  /* one last check, then return */
    }

    if (readSet != NULL)
      for (socket = 0; socket <= maxSocket; ++ socket)
        if (FD_ISSET (socket, readSet))
        {
            TunnelSocket * s = tunnel_get (socket);
            if (s == NULL || (s -> head == NULL && ! s -> failed))
              FD_CLR (socket, readSet);
        }
    if (writeSet != NULL)
      for (socket = 0; socket <= maxSocket; ++ socket)
        if (FD_ISSET (socket, writeSet) && tunnel_get (socket) == NULL)
          FD_CLR (socket, writeSet);
    pthread_mutex_unlock (& tunnelLock);
    return ready;
}

int
enet_socket_wait (ENetSocket socket, enet_uint32 * condition, enet_uint32 timeout)
{
    enet_uint32 wanted = * condition;
    struct timespec deadline;
    TunnelSocket * s;
    int generation, result = 0;

    * condition = ENET_SOCKET_WAIT_NONE;

    pthread_mutex_lock (& tunnelLock);
    s = tunnel_get (socket);
    if (s == NULL)
    {
        pthread_mutex_unlock (& tunnelLock);
        return -1;
    }
    generation = s -> generation;

    if (wanted & ENET_SOCKET_WAIT_SEND)
      * condition |= ENET_SOCKET_WAIT_SEND;

    if (wanted & ENET_SOCKET_WAIT_RECEIVE)
    {
        /* Wait only on network threads, only when nothing else is ready: blocking the main
           thread would freeze the page. */
        if (s -> head == NULL && timeout > 0 && ! (* condition & ENET_SOCKET_WAIT_SEND) &&
            ! emscripten_is_main_runtime_thread ())
        {
            tunnel_deadline (& deadline, timeout);
            while (s -> used && s -> generation == generation && s -> head == NULL && ! s -> failed)
              if (pthread_cond_timedwait (& tunnelArrived, & tunnelLock, & deadline) == ETIMEDOUT)
                break;
        }
        if (! s -> used || s -> generation != generation)
          result = -1;
        else
        if (s -> head != NULL || s -> failed)
          * condition |= ENET_SOCKET_WAIT_RECEIVE;
    }
    pthread_mutex_unlock (& tunnelLock);
    return result;
}

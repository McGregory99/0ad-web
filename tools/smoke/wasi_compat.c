// E2c shim: symbols that wasi-libc headers make SpiderMonkey/Rust reference, but that
// Emscripten's libc (musl-based) does not define. Experimental; see odd/tasks/0ad-web.md.
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

// wasi-libc: `#define CLOCK_MONOTONIC (&_CLOCK_MONOTONIC)`, a pointer to a struct.
// Code built against wasi headers passes that address to clock_gettime(); translate it.
struct __clockid { int id; };
const struct __clockid _CLOCK_MONOTONIC = {CLOCK_MONOTONIC};
const struct __clockid _CLOCK_REALTIME = {CLOCK_REALTIME};

int __real_clock_gettime(clockid_t, struct timespec*);
int __wrap_clock_gettime(clockid_t id, struct timespec* ts) {
  if ((uintptr_t)id == (uintptr_t)&_CLOCK_MONOTONIC) id = CLOCK_MONOTONIC;
  else if ((uintptr_t)id == (uintptr_t)&_CLOCK_REALTIME) id = CLOCK_REALTIME;
  return __real_clock_gettime(id, ts);
}

// struct timeval differs: wasi-libc has a 64-bit tv_usec, Emscripten a 32-bit one followed by
// 4 bytes of padding. SpiderMonkey (wasi headers) reads all 8 bytes, so Date.now() picked up stack
// garbage and jumped by years between calls (the in-game menu animation never finished). Zero the
// struct first: the padding then reads as the high half of a valid 64-bit value, and callers built
// with Emscripten headers see the same struct as before.
int __real_gettimeofday(struct timeval* restrict, void* restrict);
int __wrap_gettimeofday(struct timeval* restrict tv, void* restrict tz) {
  if (tv) memset(tv, 0, 16);
  return __real_gettimeofday(tv, tz);
}
_Static_assert(sizeof(struct timeval) == 16, "Emscripten struct timeval layout changed");

// wasi-libc exports `errno` as a thread-local variable; Emscripten uses
// __errno_location(). With atomics enabled the wasi objects (and Rust's
// wasip1-threads std) reference it as real TLS, so it must be _Thread_local.
// It is NOT the Emscripten libc errno: Rust reads it only for error messages.
#undef errno
_Thread_local int errno;

// wasi-libc provides arc4random_buf; Emscripten provides getentropy (max 256 bytes per call).
void arc4random_buf(void* buf, size_t n) {
  unsigned char* p = (unsigned char*)buf;
  while (n > 0) {
    size_t chunk = n > 256 ? 256 : n;
    getentropy(p, chunk);
    p += chunk;
    n -= chunk;
  }
}

// E2c shim: symbols that wasi-libc headers make SpiderMonkey/Rust reference, but that
// Emscripten's libc (musl-based) does not define. Experimental; see odd/tasks/0ad-web.md.
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>
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

// wasi-libc exports `errno` as a plain (thread-local) variable; Emscripten uses
// __errno_location(). Rust reads it only to build error messages.
int errno;

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

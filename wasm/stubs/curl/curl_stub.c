/* libcurl stub for the WebAssembly build: the browser has no raw sockets, so every
 * network operation fails cleanly. Used by mod.io and user reports, which then report
 * "no connection". Headers are the real libcurl 8.7.1 headers (curl license). */
#define CURL_DISABLE_TYPECHECK 1
#include <curl/curl.h>
#include <stdlib.h>
#include <string.h>

static int dummy_handle;

CURLcode curl_global_init(long flags) { (void)flags; return CURLE_OK; }
void curl_global_cleanup(void) {}
char* curl_version(void) { return (char*)"libcurl/0 (wasm stub, no network)"; }

curl_version_info_data* curl_version_info(CURLversion age) {
  static curl_version_info_data info;
  (void)age;
  info.age = CURLVERSION_NOW;
  info.version = "0.0.0-wasm-stub";
  info.host = "wasm32-unknown-emscripten";
  return &info;
}

CURL* curl_easy_init(void) { return (CURL*)&dummy_handle; }
void curl_easy_cleanup(CURL* h) { (void)h; }
CURLcode curl_easy_setopt(CURL* h, CURLoption o, ...) { (void)h; (void)o; return CURLE_OK; }
CURLcode curl_easy_perform(CURL* h) { (void)h; return CURLE_COULDNT_CONNECT; }
CURLcode curl_easy_getinfo(CURL* h, CURLINFO i, ...) { (void)h; (void)i; return CURLE_UNKNOWN_OPTION; }
const char* curl_easy_strerror(CURLcode c) { (void)c; return "network is not available in the browser build"; }

char* curl_easy_escape(CURL* h, const char* s, int len) {
  (void)h;
  size_t n = len > 0 ? (size_t)len : strlen(s);
  char* out = (char*)malloc(n * 3 + 1);
  static const char hex[] = "0123456789ABCDEF";
  size_t j = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~')
      out[j++] = (char)c;
    else { out[j++] = '%'; out[j++] = hex[c >> 4]; out[j++] = hex[c & 15]; }
  }
  out[j] = 0;
  return out;
}
void curl_free(void* p) { free(p); }

struct curl_slist* curl_slist_append(struct curl_slist* list, const char* s) {
  struct curl_slist* item = (struct curl_slist*)malloc(sizeof(*item));
  item->data = strdup(s);
  item->next = NULL;
  if (!list) return item;
  struct curl_slist* last = list;
  while (last->next) last = last->next;
  last->next = item;
  return list;
}
void curl_slist_free_all(struct curl_slist* list) {
  while (list) { struct curl_slist* next = list->next; free(list->data); free(list); list = next; }
}

CURLM* curl_multi_init(void) { return (CURLM*)&dummy_handle; }
CURLMcode curl_multi_cleanup(CURLM* m) { (void)m; return CURLM_OK; }
/* Every added transfer completes once, with CURLE_COULDNT_CONNECT. */
#define MAX_PENDING 64
static CURL* pending[MAX_PENDING];
static int pending_count;

CURLMcode curl_multi_add_handle(CURLM* m, CURL* h) {
  (void)m;
  if (pending_count < MAX_PENDING) pending[pending_count++] = h;
  return CURLM_OK;
}
CURLMcode curl_multi_remove_handle(CURLM* m, CURL* h) {
  (void)m;
  for (int i = 0; i < pending_count; i++)
    if (pending[i] == h) { pending[i] = pending[--pending_count]; break; }
  return CURLM_OK;
}
CURLMcode curl_multi_perform(CURLM* m, int* running) {
  (void)m;
  if (running) *running = 0;
  return CURLM_OK;
}
CURLMsg* curl_multi_info_read(CURLM* m, int* left) {
  static CURLMsg msg;
  (void)m;
  if (pending_count == 0) { if (left) *left = 0; return NULL; }
  msg.msg = CURLMSG_DONE;
  msg.easy_handle = pending[--pending_count];
  msg.data.result = CURLE_COULDNT_CONNECT;
  if (left) *left = pending_count;
  return &msg;
}
const char* curl_multi_strerror(CURLMcode c) { (void)c; return "network is not available in the browser build"; }

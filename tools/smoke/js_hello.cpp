// E2 smoke test: wasi-built SpiderMonkey 128 linked by Emscripten, evaluated in Node.
#include <cstdio>
#include <cstring>

#include <jsapi.h>
#include <js/CompilationAndEvaluation.h>
#include <js/Context.h>
#include <js/GlobalObject.h>
#include <js/Initialization.h>
#include <js/RealmOptions.h>
#include <js/SourceText.h>
#include <mozilla/Utf8.h>

static const JSClass kGlobalClass = {"global", JSCLASS_GLOBAL_FLAGS, &JS::DefaultGlobalClassOps};

int main() {
  if (!JS_Init()) { std::puts("FAIL JS_Init"); return 1; }
  JSContext* cx = JS_NewContext(64L * 1024 * 1024);
  if (!cx) { std::puts("FAIL JS_NewContext"); return 1; }
  if (!JS::InitSelfHostedCode(cx)) { std::puts("FAIL InitSelfHostedCode"); return 1; }

  int result = 0;
  {
    JS::RealmOptions options;
    JS::RootedObject global(cx, JS_NewGlobalObject(cx, &kGlobalClass, nullptr, JS::FireOnNewGlobalHook, options));
    if (!global) { std::puts("FAIL JS_NewGlobalObject"); return 1; }
    JSAutoRealm ar(cx, global);

    const char* code = "let s = 0; for (let i = 0; i < 1000000; i++) s = (s + i * 7) % 1000003; [1 + 2 * 3, s].join(',')";
    JS::CompileOptions copts(cx);
    copts.setFileAndLine("hello.js", 1);
    JS::SourceText<mozilla::Utf8Unit> source;
    if (!source.init(cx, code, std::strlen(code), JS::SourceOwnership::Borrowed)) { std::puts("FAIL source"); return 1; }
    JS::RootedValue rval(cx);
    if (!JS::Evaluate(cx, copts, source, &rval) || !rval.isString()) { std::puts("FAIL Evaluate"); result = 1; }
    else {
      JS::UniqueChars s = JS_EncodeStringToUTF8(cx, JS::RootedString(cx, rval.toString()));
      std::printf("JS OK %s\n", s.get());
    }
  }
  JS_DestroyContext(cx);
  JS_ShutDown();
  return result;
}

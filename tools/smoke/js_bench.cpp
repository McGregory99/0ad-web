// Benchmark (3M method calls, property writes, Map) — wasm SpiderMonkey interpreter speed.
// E2 smoke test: wasi-built SpiderMonkey 128 linked by Emscripten, evaluated in Node.
#include <chrono>
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

    const char* code =
      "function Unit(id) { this.id = id; this.hp = 100; this.pos = {x: id % 97, y: id % 89}; }\n"
      "Unit.prototype.step = function (t) { this.pos.x = (this.pos.x * 31 + t) % 1009; this.pos.y = (this.pos.y * 17 + this.id) % 1013; if (this.pos.x > 900) this.hp -= 1; };\n"
      "let units = []; for (let i = 0; i < 2000; i++) units.push(new Unit(i));\n"
      "let map = new Map(); let acc = 0;\n"
      "for (let t = 0; t < 1500; t++) { for (const u of units) { u.step(t); acc = (acc + u.pos.x * 3 + u.pos.y) % 1000003; } map.set(t % 100, acc); }\n"
      "let hp = 0; for (const u of units) hp += u.hp; [1 + 2 * 3, acc, hp, map.size].join(',')";
    JS::CompileOptions copts(cx);
    copts.setFileAndLine("hello.js", 1);
    JS::SourceText<mozilla::Utf8Unit> source;
    if (!source.init(cx, code, std::strlen(code), JS::SourceOwnership::Borrowed)) { std::puts("FAIL source"); return 1; }
    JS::RootedValue rval(cx);
    auto t0 = std::chrono::steady_clock::now();
    if (!JS::Evaluate(cx, copts, source, &rval) || !rval.isString()) { std::puts("FAIL Evaluate"); result = 1; }
    else {
      JS::UniqueChars s = JS_EncodeStringToUTF8(cx, JS::RootedString(cx, rval.toString()));
      double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
      std::printf("JS OK %s eval_ms=%.0f\n", s.get(), ms);
    }
  }
  JS_DestroyContext(cx);
  JS_ShutDown();
  return result;
}

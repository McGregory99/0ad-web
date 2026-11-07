// T2.0b spike: keep a blocking while() game loop on the browser main thread and yield once per
// frame with JSPI (emscripten_sleep). Also checks native wasm exceptions and a "blocking" file read
// that is really an async HTTP Range fetch (EM_ASYNC_JS), the planned streaming-VFS primitive.
#include <SDL2/SDL.h>
#include <GLES3/gl3.h>
#include <emscripten.h>
#include <cstdio>
#include <stdexcept>

EM_ASYNC_JS(int, fetch_range, (const char* url, int start, int length, unsigned char* out), {
	const response = await fetch(UTF8ToString(url), { headers: { Range: `bytes=${start}-${start + length - 1}` } });
	const bytes = new Uint8Array(await response.arrayBuffer());
	HEAPU8.set(bytes.subarray(0, length), out);
	return response.status * 100000 + bytes.length;
});

EM_ASYNC_JS(void, wait_animation_frame, (), {
	await new Promise((resolve) => requestAnimationFrame(resolve));
});

static int ThrowAndCatch()
{
	try
	{
		throw std::runtime_error("expected");
	}
	catch (const std::runtime_error&)
	{
		return 1;
	}
	return 0;
}

int main()
{
	printf("EXCEPTION_CAUGHT %d\n", ThrowAndCatch());

	unsigned char buf[16] = {};
	const int r = fetch_range("main.cpp", 3, 8, buf);
	printf("FETCH status=%d bytes=%d text=%.8s\n", r / 100000, r % 100000, buf);

	if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0)
	{
		printf("SDL_Init failed: %s\n", SDL_GetError());
		return 1;
	}
	SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
	SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
	SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
	SDL_Window* win = SDL_CreateWindow("spike", 0, 0, 1280, 720, SDL_WINDOW_OPENGL);
	if (!win || !SDL_GL_CreateContext(win))
	{
		printf("window/context failed: %s\n", SDL_GetError());
		return 1;
	}
	printf("GL_VERSION %s\n", glGetString(GL_VERSION));

	int frames = 0, events = 0, total = 0;
	double t0 = emscripten_get_now();
	while (total < 1200) // blocking loop, like 0 A.D.'s main loop
	{
		SDL_Event e;
		while (SDL_PollEvent(&e))
			if (e.type == SDL_KEYDOWN || e.type == SDL_MOUSEBUTTONDOWN || e.type == SDL_MOUSEMOTION)
				events++;
		const float c = (frames % 60) / 60.0f;
		glClearColor(c, 0.2f, 1.0f - c, 1.0f);
		glClear(GL_COLOR_BUFFER_BIT);
		SDL_GL_SwapWindow(win);
#ifdef YIELD_RAF
		wait_animation_frame(); // yield until the next display refresh
#else
		emscripten_sleep(0); // yield to the browser so the frame is presented and events arrive
#endif
		frames++;
		total++;
		const double now = emscripten_get_now();
		if (now - t0 >= 1000.0)
		{
			printf("FPS %d events=%d\n", frames, events);
			frames = events = 0;
			t0 = now;
		}
	}
	printf("LOOP DONE\n");
	return 0;
}

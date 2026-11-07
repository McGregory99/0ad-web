// T2.0 spike: SDL2 + OpenGL ES 3 (WebGL2) driven by emscripten_set_main_loop.
// Built twice: on a PROXY_TO_PTHREAD pthread with OffscreenCanvas, and on the browser main thread.
#include <SDL2/SDL.h>
#include <GLES3/gl3.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <stdio.h>

static SDL_Window* win;
static int frames, events;
static double t0;

static void frame(void)
{
	SDL_Event e;
	while (SDL_PollEvent(&e))
	{
		if (e.type == SDL_KEYDOWN || e.type == SDL_MOUSEBUTTONDOWN)
			printf("EVENT type=0x%x\n", e.type);
		if (e.type == SDL_KEYDOWN || e.type == SDL_MOUSEBUTTONDOWN || e.type == SDL_MOUSEMOTION)
			events++;
	}
	const float c = (frames % 60) / 60.0f;
	glClearColor(c, 0.2f, 1.0f - c, 1.0f);
	glClear(GL_COLOR_BUFFER_BIT);
	SDL_GL_SwapWindow(win);
	frames++;
	const double now = emscripten_get_now();
	if (now - t0 >= 1000.0)
	{
		printf("FPS %d events=%d main_browser_thread=%d\n", frames, events, emscripten_is_main_browser_thread());
		frames = 0;
		events = 0;
		t0 = now;
	}
}

int main(void)
{
	if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0)
	{
		printf("SDL_Init failed: %s\n", SDL_GetError());
		return 1;
	}
	SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
	SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
	SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
	win = SDL_CreateWindow("spike", 0, 0, 1280, 720, SDL_WINDOW_OPENGL);
	if (!win)
	{
		printf("SDL_CreateWindow failed: %s\n", SDL_GetError());
		return 1;
	}
	if (!SDL_GL_CreateContext(win))
	{
		printf("SDL_GL_CreateContext failed: %s\n", SDL_GetError());
		return 1;
	}
	printf("GL_VERSION %s\nGL_RENDERER %s\n", glGetString(GL_VERSION), glGetString(GL_RENDERER));
	t0 = emscripten_get_now();
	emscripten_set_main_loop(frame, 0, 1);
	return 0;
}

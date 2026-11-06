#include <cstdio>
#include <zlib.h>
#include <png.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include <ogg/ogg.h>
#include <vorbis/codec.h>
#include <SDL2/SDL.h>
#include <unicode/uversion.h>
#include <boost/version.hpp>
#include <AL/al.h>
#include <AL/alc.h>

int main() {
    std::printf("zlib %s\n", zlibVersion());
    std::printf("libpng %u\n", (unsigned)png_access_version_number());
    FT_Library ft;
    std::printf("freetype init %d\n", (int)FT_Init_FreeType(&ft));
    ogg_sync_state oy; ogg_sync_init(&oy);
    vorbis_info vi; vorbis_info_init(&vi);
    std::printf("ogg+vorbis ok\n");
    SDL_version v; SDL_GetVersion(&v);
    std::printf("SDL %d.%d.%d\n", v.major, v.minor, v.patch);
    UVersionInfo uv; u_getVersion(uv);
    std::printf("ICU %d.%d\n", uv[0], uv[1]);
    std::printf("boost %d\n", BOOST_VERSION);
    std::printf("openal symbol %p\n", (void*)&alcOpenDevice);
    std::printf("PORTS OK\n");
    return 0;
}

#!/usr/bin/env python3
"""Write a deflated mod archive whose DDS textures lack their top mip level (task T3.3).

The web build ships textures at medium resolution by default (odd/tasks/0ad-web.md, L45).
The engine does the same at load time for textures.quality = 1
(graphics/TextureManager.cpp): it skips the top level when the texture has more than one
mip level and min(width, height) > 8, except for textures marked m_IgnoreQuality. Doing it
in the archive instead saves the download. Rules, mirroring the engine:

  - only art/textures/**/*.cached.dds members are candidates;
  - never art/textures/ui/ (GUI sprites, GUIRenderer.cpp and CGUI.cpp: SetIgnoreQuality),
    art/textures/animated/minimap-flare/ (CMiniMap.cpp: SetIgnoreQuality),
    art/textures/skies/ (SkyManager.cpp decodes them directly, no quality step) and
    art/textures/terrain/alphamaps/ (TerrainTextureManager.cpp decodes them directly);
  - only formats lib/tex/tex_dds.cpp loads: FOURCC DXT1/DXT3/DXT5, RGB(A) 8-bit masks,
    8-bit alpha; anything else (DX10 header, ATI1/ATI2, ...) is left unchanged and counted.

The rewritten header has width/height halved, mip count minus one and pitch or linear size
of the new top level, and passes the same checks as the engine's DDS loader. The web
config keeps textures.quality = 2, so the engine loads the trimmed file at its full size.
Every other member is copied unchanged; compression follows tools/wasm/recompress-zip.py
(deflate, already-compressed types stored); member order is kept.

Usage:
    python3 -I tools/wasm/trim-texture-mips.py <in.zip> <out.zip> [level]
"""

import collections
import importlib.util
import os
import struct
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('recompress_zip', os.path.join(HERE, 'recompress-zip.py'))
_recompress = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_recompress)
ALREADY_COMPRESSED = _recompress.ALREADY_COMPRESSED

KEEP_FULL = ('art/textures/ui/', 'art/textures/animated/minimap-flare/', 'art/textures/skies/',
             'art/textures/terrain/alphamaps/')

DDSD_PITCH, DDSD_MIPMAPCOUNT, DDSD_LINEARSIZE = 0x8, 0x20000, 0x80000
DDPF_ALPHAPIXELS, DDPF_ALPHA, DDPF_FOURCC, DDPF_RGB = 0x1, 0x2, 0x4, 0x40
HEADER = 128  # "DDS " + DDS_HEADER


def ceil_log2(x):
    return (x - 1).bit_length()


def round_up(x, n):
    return (x + n - 1) // n * n


def pixel_format(data):
    """(bpp, padding) the engine uses for this DDS, or None when tex_dds.cpp would not load it."""
    pf_size, pf_flags, fourcc, bits, r, g, b, a = struct.unpack_from('<II4sIIIII', data, 76)
    if pf_size != 32:
        return None
    if pf_flags & DDPF_RGB:
        if pf_flags & DDPF_ALPHAPIXELS and a != 0xFF000000:
            return None
        if (r, g, b) != (0xFF, 0xFF00, 0xFF0000) or bits != (32 if pf_flags & DDPF_ALPHAPIXELS else 24):
            return None
        return bits, 1
    if pf_flags & DDPF_ALPHA:
        return (8, 1) if bits == 8 and a == 0xFF else None
    if pf_flags & DDPF_FOURCC:
        return {b'DXT1': (4, 4), b'DXT3': (8, 4), b'DXT5': (8, 4)}.get(fourcc)
    return None


def level_sizes(w, h, bpp, padding, count):
    sizes = []
    for _ in range(count):
        sizes.append(round_up(w, padding) * round_up(h, padding) * bpp // 8)
        w, h = max(w // 2, 1), max(h // 2, 1)
    return sizes


def engine_accepts(data):
    """The size, pitch and mip-chain checks of tex_dds.cpp decode_sd()."""
    if data[:4] != b'DDS ' or len(data) < HEADER:
        return False
    flags, h, w, pitch_or_size, _depth, mips = struct.unpack_from('<IIIIII', data, 8)
    fmt = pixel_format(data)
    if fmt is None or not w or not h:
        return False
    bpp, padding = fmt
    pitch = round_up(w, padding) * bpp // 8
    stored_h = round_up(h, padding)
    if flags & DDSD_PITCH and pitch_or_size != round_up(pitch, 4):
        return False
    if flags & DDSD_LINEARSIZE and pitch_or_size != pitch * stored_h and \
            abs(pitch_or_size - int(pitch * stored_h * 1.333333)) > 64:
        return False
    count = mips if flags & DDSD_MIPMAPCOUNT and mips else 1
    if count > 1 and count != ceil_log2(max(w, h)) + 1:
        return False
    return len(data) >= HEADER + sum(level_sizes(w, h, bpp, padding, count))


def trim_top_mip(data):
    """(new bytes, None) with the top level dropped, or (None, reason) to keep the member as is."""
    if data[:4] != b'DDS ' or len(data) < HEADER:
        return None, 'not-dds'
    flags, h, w, _pitch_or_size, _depth, mips = struct.unpack_from('<IIIIII', data, 8)
    fmt = pixel_format(data)
    if fmt is None:
        return None, 'unsupported-format'
    if not engine_accepts(data):
        return None, 'invalid-input'
    if not (flags & DDSD_MIPMAPCOUNT and mips > 1 and min(w, h) > 8):
        return None, 'single-mip-or-small'
    bpp, padding = fmt
    nw, nh, nmips = max(w // 2, 1), max(h // 2, 1), mips - 1
    if nmips != ceil_log2(max(nw, nh)) + 1:
        return None, 'odd-mip-chain'
    top = level_sizes(w, h, bpp, padding, 1)[0]
    header = bytearray(data[:HEADER])
    new_pitch = round_up(nw, padding) * bpp // 8
    pitch_or_size = round_up(new_pitch, 4) if flags & DDSD_PITCH else new_pitch * round_up(nh, padding)
    struct.pack_into('<III', header, 12, nh, nw, pitch_or_size)
    struct.pack_into('<I', header, 28, nmips)
    out = bytes(header) + data[HEADER + top:]
    if not engine_accepts(out):
        return None, 'rewrite-rejected'
    return out, None


def is_candidate(name):
    return name.startswith('art/textures/') and name.endswith('.cached.dds') and \
        not name.startswith(KEEP_FULL)


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    level = int(sys.argv[3]) if len(sys.argv) == 4 else 9
    tmp = dst + '.tmp'
    counts = collections.Counter()
    raw_in = raw_out = packed = dds_in = dds_out = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, 'w', allowZip64=True) as zout:
        for info in zin.infolist():
            if info.is_dir():
                continue
            data = zin.read(info)
            raw_in += len(data)
            if is_candidate(info.filename):
                dds_in += len(data)
                trimmed, reason = trim_top_mip(data)
                if trimmed is None:
                    counts['dds kept: ' + reason] += 1
                else:
                    counts['dds trimmed'] += 1
                    data = trimmed
                dds_out += len(data)
            elif info.filename.endswith('.dds'):
                counts['dds kept: full-quality path'] += 1
            else:
                counts['other members'] += 1
            out = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            out.external_attr = info.external_attr
            if info.filename.lower().endswith(ALREADY_COMPRESSED):
                out.compress_type = zipfile.ZIP_STORED
                zout.writestr(out, data)
            else:
                out.compress_type = zipfile.ZIP_DEFLATED
                zout.writestr(out, data, compresslevel=level)
            raw_out += len(data)
            packed += zout.getinfo(info.filename).compress_size
    os.replace(tmp, dst)
    for key in sorted(counts):
        print(f'{key}: {counts[key]}')
    print(f'candidate dds bytes {dds_in} -> {dds_out}; raw {raw_in} -> {raw_out} bytes; '
          f'packed {packed} bytes; archive {os.path.getsize(dst)} bytes')


if __name__ == '__main__':
    main()

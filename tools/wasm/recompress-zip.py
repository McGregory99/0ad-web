#!/usr/bin/env python3
"""Rewrite a 0 A.D. mod archive with deflate compression (runbook T4.3j).

The release public.zip stores every member uncompressed (3.5 GB). The web build streams
it over HTTP Range requests, so stored members cost their full size in download. The
engine's zip reader inflates deflated members (lib/file/archive/archive_zip.cpp), so a
deflated copy is lossless and needs no engine change. Members that are already
compressed (audio, images) stay stored. Member order is kept.

Usage:
    python3 -I tools/wasm/recompress-zip.py <in.zip> <out.zip> [level]
"""

import os
import sys
import zipfile

ALREADY_COMPRESSED = ('.ogg', '.png', '.jpg', '.jpeg', '.zip', '.ttf', '.otf', '.woff', '.woff2')


def main():
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    src, dst = sys.argv[1], sys.argv[2]
    level = int(sys.argv[3]) if len(sys.argv) == 4 else 9
    tmp = dst + '.tmp'
    raw = packed = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(tmp, 'w', allowZip64=True) as zout:
        for info in zin.infolist():
            if info.is_dir():
                continue
            data = zin.read(info)
            out = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            out.external_attr = info.external_attr
            if info.filename.lower().endswith(ALREADY_COMPRESSED):
                out.compress_type = zipfile.ZIP_STORED
                zout.writestr(out, data)
            else:
                out.compress_type = zipfile.ZIP_DEFLATED
                zout.writestr(out, data, compresslevel=level)
            raw += info.file_size
            packed += zout.getinfo(info.filename).compress_size
    os.replace(tmp, dst)
    print(f'members written; raw {raw} bytes, packed {packed} bytes, ratio {packed / max(raw, 1):.3f}')


if __name__ == '__main__':
    main()

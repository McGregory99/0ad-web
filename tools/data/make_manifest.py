"""Build a manifest describing where each file's data lives inside a zip.

The manifest lets a browser fetch single files out of a large zip with HTTP
Range requests: for every entry it records the byte offset of the compressed
data, its compressed size, uncompressed size, method and CRC32.

Usage:
    python3 -I tools/data/make_manifest.py <input.zip> <output.json> [--verify N]

Standard library only.
"""

import json
import os
import random
import struct
import sys
import zipfile
import zlib

LOCAL_HEADER_SIG = 0x04034B50
# <IHHHHHIIIHH == 30 bytes, matching the fixed part of a local file header.
LOCAL_HEADER = struct.Struct("<IHHHHHIIIHH")


def build_manifest(zip_path):
    """Return the manifest dict for zip_path, entries sorted by path."""
    entries = []
    archive_size = os.path.getsize(zip_path)
    with zipfile.ZipFile(zip_path) as zf, open(zip_path, "rb") as raw:
        for info in zf.infolist():
            if info.filename.endswith("/"):
                continue  # directory entry

            raw.seek(info.header_offset)
            header = raw.read(LOCAL_HEADER.size)
            if len(header) != LOCAL_HEADER.size:
                raise ValueError(f"bad local header for {info.filename}")

            fields = LOCAL_HEADER.unpack(header)
            if fields[0] != LOCAL_HEADER_SIG:
                raise ValueError(f"bad local header for {info.filename}")

            # Lengths come from THIS local header, not from info.extra.
            name_len = fields[9]
            extra_len = fields[10]
            data_offset = info.header_offset + LOCAL_HEADER.size + name_len + extra_len

            entries.append(
                {
                    "path": info.filename,
                    "offset": data_offset,
                    "csize": info.compress_size,
                    "usize": info.file_size,
                    "method": info.compress_type,
                    "crc32": info.CRC,
                }
            )

    entries.sort(key=lambda entry: entry["path"])
    return {
        "archive": os.path.basename(zip_path),
        "archive_size": archive_size,
        "entry_count": len(entries),
        "entries": entries,
    }


def verify(zip_path, manifest, n):
    """Check n random entries (all if fewer than n) and return the count checked."""
    entries = manifest["entries"]
    if n >= len(entries):
        chosen = list(entries)
    else:
        chosen = random.Random(0).sample(entries, n)

    with open(zip_path, "rb") as raw:
        for entry in chosen:
            path = entry["path"]
            raw.seek(entry["offset"])
            data = raw.read(entry["csize"])
            if len(data) != entry["csize"]:
                raise ValueError(f"short read for {path}")

            method = entry["method"]
            if method == 0:
                plain = data
            elif method == 8:
                try:
                    plain = zlib.decompress(data, -15)
                except zlib.error as exc:
                    raise ValueError(f"corrupt deflate data for {path}: {exc}") from exc
            else:
                raise ValueError(f"unsupported compression method {method} for {path}")

            if len(plain) != entry["usize"]:
                raise ValueError(f"size mismatch for {path}")
            if (zlib.crc32(plain) & 0xFFFFFFFF) != entry["crc32"]:
                raise ValueError(f"crc mismatch for {path}")

    print(f"VERIFY OK {len(chosen)}")
    return len(chosen)


def main(argv):
    args = list(argv)
    n = None
    if "--verify" in args:
        index = args.index("--verify")
        try:
            n = int(args[index + 1])
        except (IndexError, ValueError):
            print("--verify needs an integer argument", file=sys.stderr)
            return 2
        del args[index : index + 2]

    if len(args) != 2:
        print(
            "usage: make_manifest.py <input.zip> <output.json> [--verify N]",
            file=sys.stderr,
        )
        return 2

    zip_path, out_path = args
    manifest = build_manifest(zip_path)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, separators=(",", ":"))

    if n is not None:
        verify(zip_path, manifest, n)

    print(f"MANIFEST {manifest['entry_count']} entries -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

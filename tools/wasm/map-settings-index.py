#!/usr/bin/env python3
"""Build a map-settings index from a mod zip (runbook T4.3h).

The game setup screen calls LoadMapSettings for every map, and the engine
(CMapSummaryReader::LoadMap) reads the whole <map>.xml.cached.xmb only to keep the
<ScriptSettings> text. This script extracts that text once, at build time, into a small
file the web build preloads.

Usage:
    python3 -I tools/wasm/map-settings-index.py <public.zip> <out-file>

Output format (one record per map, sorted by path):
    <path>\\n<byte length of settings as UTF-8>\\n<settings bytes>\\n
"""

import sys
import xml.etree.ElementTree as ET
import zipfile


def iter_map_members(z):
    for info in z.infolist():
        name = info.filename
        if info.is_dir():
            continue
        if not name.startswith("maps/"):
            continue
        if not name.endswith(".xml"):
            continue
        if ".cached." in name:
            continue
        yield name


def script_settings(root):
    """Return the text of the root's direct <ScriptSettings> child, or None."""
    for child in root:
        if isinstance(child.tag, str) and child.tag.lower() == "scriptsettings":
            return child.text or ""
    return None


def main(argv):
    if len(argv) != 2:
        print("usage: map-settings-index.py <public.zip> <out-file>", file=sys.stderr)
        return 2
    zip_path, out_path = argv

    found = written = skipped = failed = 0
    records = []

    with zipfile.ZipFile(zip_path) as z:
        for name in iter_map_members(z):
            found += 1
            try:
                root = ET.fromstring(z.read(name))
            except ET.ParseError as error:
                failed += 1
                print(f"parse failed: {name}: {error}", file=sys.stderr)
                continue
            settings = script_settings(root)
            if settings is None:
                skipped += 1
                continue
            records.append((name, settings.encode("utf-8")))

    records.sort(key=lambda record: record[0])

    total = 0
    with open(out_path, "wb") as f:
        for name, data in records:
            header = name.encode("utf-8") + b"\n" + str(len(data)).encode("ascii") + b"\n"
            f.write(header)
            f.write(data)
            f.write(b"\n")
            total += len(header) + len(data) + 1
            written += 1

    print(f"maps found: {found}")
    print(f"written: {written}")
    print(f"skipped (no ScriptSettings): {skipped}")
    print(f"failed to parse: {failed}")
    print(f"total output bytes: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Tests for make_manifest.py (T4.1)."""

import json
import os
import tempfile
import unittest
import zipfile
import zlib

import make_manifest


def read_entry_bytes(zip_path, entry):
    """Read csize bytes at offset and decompress according to method."""
    with open(zip_path, "rb") as f:
        f.seek(entry["offset"])
        data = f.read(entry["csize"])
    method = entry["method"]
    if method == 0:
        return data
    if method == 8:
        return zlib.decompress(data, -15)
    raise AssertionError("unexpected method %r" % (method,))


class ManifestTests(unittest.TestCase):
    def test_stored_and_deflated_roundtrip(self):
        payload_a = b"hello"
        payload_b = bytes(range(256)) * 50
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = os.path.join(tmp, "sample.zip")
            out_path = os.path.join(tmp, "manifest.json")
            with zipfile.ZipFile(zip_path, "w") as zf:
                zf.writestr("a.txt", payload_a, compress_type=zipfile.ZIP_STORED)
                zf.writestr(
                    "dir/b.bin", payload_b, compress_type=zipfile.ZIP_DEFLATED
                )

            rc = make_manifest.main([zip_path, out_path])
            self.assertEqual(rc, 0)

            with open(out_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)

            self.assertEqual(manifest["entry_count"], 2)
            self.assertEqual(manifest["archive"], "sample.zip")
            self.assertEqual(manifest["archive_size"], os.path.getsize(zip_path))
            paths = [e["path"] for e in manifest["entries"]]
            self.assertEqual(paths, sorted(paths))
            self.assertEqual(paths, ["a.txt", "dir/b.bin"])

            expected = {"a.txt": payload_a, "dir/b.bin": payload_b}
            for entry in manifest["entries"]:
                self.assertEqual(
                    set(entry),
                    {"path", "offset", "csize", "usize", "method", "crc32"},
                )
                data = read_entry_bytes(zip_path, entry)
                self.assertEqual(data, expected[entry["path"]])
                self.assertEqual(len(data), entry["usize"])
                self.assertEqual(zlib.crc32(data) & 0xFFFFFFFF, entry["crc32"])

    def test_directories_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = os.path.join(tmp, "dirs.zip")
            out_path = os.path.join(tmp, "manifest.json")
            with zipfile.ZipFile(zip_path, "w") as zf:
                zf.writestr(zipfile.ZipInfo("d/"), b"")
                zf.writestr("d/x.txt", b"x")

            rc = make_manifest.main([zip_path, out_path])
            self.assertEqual(rc, 0)

            with open(out_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)

            paths = [e["path"] for e in manifest["entries"]]
            self.assertEqual(paths, ["d/x.txt"])
            self.assertEqual(manifest["entry_count"], 1)

    def test_verify_detects_corruption(self):
        payload = bytes(range(256)) * 10
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = os.path.join(tmp, "corrupt.zip")
            out_path = os.path.join(tmp, "manifest.json")
            with zipfile.ZipFile(zip_path, "w") as zf:
                zf.writestr("data.bin", payload, compress_type=zipfile.ZIP_DEFLATED)

            manifest = make_manifest.build_manifest(zip_path)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(manifest, f)

            # Sanity check: verify passes on the intact archive.
            self.assertEqual(
                make_manifest.verify(zip_path, manifest, len(manifest["entries"])),
                len(manifest["entries"]),
            )

            entry = manifest["entries"][0]
            with open(zip_path, "r+b") as f:
                f.seek(entry["offset"])
                original = f.read(1)
                f.seek(entry["offset"])
                f.write(bytes([original[0] ^ 0xFF]))

            with self.assertRaises(ValueError):
                make_manifest.verify(zip_path, manifest, len(manifest["entries"]))


if __name__ == "__main__":
    unittest.main()

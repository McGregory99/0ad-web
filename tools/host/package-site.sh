#!/bin/sh
# package-site.sh -- turn a local web build into a self-contained upload directory.
#
# Usage:
#   tools/host/package-site.sh <web build dir> <out dir> <source url>
#
#   <web build dir>  a build tree such as runs/web-t44 (symlinks are resolved)
#   <out dir>        where the upload copy goes; it MUST NOT exist yet
#   <source url>     public URL of the GPL source code, replaces SOURCE_URL
#                    in licenses/licenses.html
#
# What it does:
#   1. refuses to run if <out dir> already exists (exit 2, nothing is deleted)
#   2. copies the build with `cp -RL`, so the result has no symlinks and is
#      self-contained (mods/*.zip are real files, not links into upstream/)
#   3. replaces every SOURCE_URL placeholder in the copied licenses.html
#   4. writes <out dir>/SHA256SUMS (sha256 of every file, relative paths)
#   5. prints the size of <out dir>
#
# Nothing is uploaded, deployed or deleted.

set -eu

if [ "$#" -ne 3 ]; then
	echo "usage: $0 <web build dir> <out dir> <source url>" >&2
	exit 2
fi

BUILD=$1
OUT=$2
SOURCE_URL=$3

if [ ! -d "$BUILD" ]; then
	echo "error: build dir '$BUILD' does not exist" >&2
	exit 2
fi

if [ -e "$OUT" ]; then
	echo "error: out dir '$OUT' already exists, refusing to overwrite or delete it" >&2
	exit 2
fi

echo "== copying $BUILD -> $OUT (symlinks resolved)"
cp -RL "$BUILD" "$OUT"

# Replace the SOURCE_URL placeholder in every licenses page of the copy.
echo "== replacing SOURCE_URL with $SOURCE_URL"
found=0
for page in $(find "$OUT" -name licenses.html -type f); do
	found=1
	tmp="$page.tmp.$$"
	sed "s|SOURCE_URL|$SOURCE_URL|g" "$page" > "$tmp"
	mv "$tmp" "$page"
	echo "   patched $page"
done
if [ "$found" -eq 0 ]; then
	echo "error: no licenses.html found under $OUT" >&2
	exit 1
fi

# Checksums of the upload copy, relative paths only.
echo "== writing SHA256SUMS"
(
	cd "$OUT"
	find . -type f ! -name SHA256SUMS | sort | while IFS= read -r f; do
		shasum -a 256 "$f"
	done | sed 's|  \./|  |' > SHA256SUMS
)

echo "== done"
du -sh "$OUT"

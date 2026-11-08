#!/usr/bin/env python3
"""Build runs/T4.3e/remove.txt from runs/T4.3e/items.txt (T4.3e Step 2).

Rules (from the runbook):
  * remove every item under coll/, brkitr/, translit/, rbnf/, unit/
  * remove every *.cnv, cnvalias.icu, unames.icu, uts46.nrm, nfkc_cf.nrm, nfkc.nrm
    (keep nfc.nrm)
  * remove locale data files (top-level xx.res / xx_YY.res and the same under
    curr/, lang/, region/, zone/) for locales outside the keep list
  * keep res_index.res, pool.res and every other non-locale item
"""
import re
import sys

ITEMS = "runs/T4.3e/items.txt"
OUT = "runs/T4.3e/remove.txt"

# 27 shipped locales (T4.3d Step 2) plus root/en.
SHIPPED_LANGS = {
    "ca", "cs", "de", "el", "es", "eu", "fi", "fr", "gl", "hu", "id", "it",
    "ja", "ko", "nl", "pl", "pt", "ru", "sk", "sv", "tr", "uk", "vi", "zh",
}
# "en" is kept explicitly (en, en_*, en_GB). Children of the above languages
# (pt_BR, pt_PT, zh_TW, zh_Hant*, ...) are kept by the first-component rule.
KEEP_LANGS = SHIPPED_LANGS | {"en"}

REMOVE_FOLDERS = {"coll", "brkitr", "translit", "rbnf", "unit"}
REMOVE_FILES = {"cnvalias.icu", "unames.icu", "uts46.nrm", "nfkc_cf.nrm", "nfkc.nrm"}
LOCALE_FOLDERS = {"", "curr", "lang", "region", "zone"}
PROTECTED_NAMES = {"res_index", "pool"}

# xx, xx_YY, xx_Hant_TW, en_US_POSIX, ca_ES_VALENCIA ...
LOCALE_RE = re.compile(r"^[a-z]{2,3}(_[A-Za-z0-9]+)*$")


def is_locale_res(item):
    folder, _, base = item.rpartition("/")
    if folder not in LOCALE_FOLDERS:
        return False
    if not base.endswith(".res"):
        return False
    name = base[:-4]
    if name in PROTECTED_NAMES:
        return False
    return name == "root" or bool(LOCALE_RE.match(name))


def keep_locale(name):
    if name == "root":
        return True
    return name.split("_")[0] in KEEP_LANGS


def main():
    with open(ITEMS, encoding="utf-8") as f:
        items = [line.rstrip("\n") for line in f if line.strip()]

    remove = []
    kept = []
    for item in items:
        folder, _, base = item.rpartition("/")
        folder_key = folder if folder else "(top-level)"
        drop = False
        reason = ""
        if folder in REMOVE_FOLDERS:
            drop, reason = True, "folder"
        elif base.endswith(".cnv") or base in REMOVE_FILES:
            drop, reason = True, "file"
        elif is_locale_res(item):
            name = base[:-4]
            if not keep_locale(name):
                drop, reason = True, "locale"
            else:
                reason = "locale-kept"
        (remove if drop else kept).append((folder_key, item, reason))

    with open(OUT, "w", encoding="utf-8") as f:
        for _, item, _ in remove:
            f.write(item + "\n")

    folders = sorted({k for k, _, _ in remove} | {k for k, _, _ in kept})
    print(f"{'folder':<14}{'removed':>9}{'kept':>8}")
    for folder in folders:
        r = sum(1 for k, _, _ in remove if k == folder)
        k = sum(1 for kk, _, _ in kept if kk == folder)
        print(f"{folder:<14}{r:>9}{k:>8}")
    print(f"{'TOTAL':<14}{len(remove):>9}{len(kept):>8}")

    by_reason = {}
    for _, _, reason in remove:
        by_reason[reason] = by_reason.get(reason, 0) + 1
    print("removed by reason:", dict(sorted(by_reason.items())))


if __name__ == "__main__":
    sys.exit(main())

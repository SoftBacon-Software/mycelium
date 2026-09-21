#!/usr/bin/env python3
"""Clean-room gate for the operator console (task 89).

Counts exact stripped-line matches (lines >= 40 chars after stripping, minus a
small boilerplate stoplist) between public/console/** and one or more
reference files or directories passed as arguments.

The point: the K-kira lane that writes the console is forbidden to OPEN the
reference material (the forked dashboard and its clones). This tool does the
reading FOR the lane — the lane runs it and reports the number. The gate is a
number, and the number must be 0.

Output contract: prints exactly one integer (the match count) on stdout.
Exit code 0 only when the count is 0; 1 when anything matched; 2 on usage
error. Gates read the exit code, never grepped output.

Scanned console files: .html .css .js .svg under public/console/ (fonts/,
node_modules/ and binary/font files are skipped — woff2 and OFL licence text
are third-party by licence, not by design).
"""

import sys
from pathlib import Path

MIN_LEN = 40

# Boilerplate that any two hand-written web files may legitimately share.
# Kept small and generic — a stoplist is an escape hatch, not a sieve.
STOPLIST = {
    "window.addeventlistener('domcontentloaded', function () {",
    "document.addeventlistener('keydown', function (e) {",
    "if (!res.ok) throw new error('http ' + res.status);",
    "throw new error('network error');",
    "content-type: application/json",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta charset=\"utf-8\">",
    "<!doctype html>",
    "</body>",
    "</html>",
}

CONSOLE_EXT = {".html", ".css", ".js", ".svg"}
SKIP_DIR_NAMES = {"fonts", "node_modules", ".git"}


def _lines_in_file(path):
    """Set of qualifying stripped lines from one text file."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    out = set()
    for raw in text.splitlines():
        s = raw.strip().lower()
        if len(s) >= MIN_LEN and s not in STOPLIST:
            out.add(s)
    return out


def _iter_scan(path):
    """Yield files under `path` (a file, or a directory walked recursively)."""
    if path.is_file():
        yield path
        return
    for p in sorted(path.rglob("*")):
        if not p.is_file():
            continue
        if p.suffix.lower() not in CONSOLE_EXT:
            continue
        if any(part in SKIP_DIR_NAMES for part in p.parts):
            continue
        yield p


def reference_lines(args):
    """Union of qualifying lines across every reference argument."""
    out = set()
    for arg in args:
        p = Path(arg)
        if not p.exists():
            print(f"cleanroom_check: reference path does not exist: {arg}", file=sys.stderr)
            sys.exit(2)
        for f in _iter_scan(p):
            out |= _lines_in_file(f)
    return out


def console_lines(root):
    out = set()
    for f in _iter_scan(root):
        out |= _lines_in_file(f)
    return out


def main(argv):
    if len(argv) < 2:
        print("usage: cleanroom_check.py <reference-file-or-dir> [more...]", file=sys.stderr)
        return 2
    root = Path(__file__).resolve().parent.parent / "public" / "console"
    if not root.is_dir():
        print(f"cleanroom_check: console dir missing: {root}", file=sys.stderr)
        return 2
    ours = console_lines(root)
    refs = reference_lines(argv[1:])
    count = len(ours & refs)
    print(count)
    return 0 if count == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

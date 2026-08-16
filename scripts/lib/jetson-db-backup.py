#!/usr/bin/env python3
"""Hot, WAL-consistent backup of the Mycelium database, verified by opening it.

Runs on jetson01, which has no sqlite3 CLI. The source is live and has a WAL, so
a file copy is not a backup -- this uses sqlite3.Connection.backup() against a
read-only URI. It then OPENS the result and integrity-checks it, because a copy
nobody opened has hidden a corrupt backup before.

    python3 jetson-db-backup.py <src.db> <dest.db>
    python3 jetson-db-backup.py --verify-only <db>

Exits non-zero, loudly, on any failure. Prints a JSON summary on success.

See docs/superpowers/specs/2026-08-16-jetson-mycelium-deploy-design.md
"""
import json
import sqlite3
import sys
from pathlib import Path


def verify(path):
    """Open a database and prove it is sound.

    Returns (integrity, row_counts). Raises SystemExit if it cannot be opened or
    fails integrity_check -- an unreadable file must never be reported as a
    successful backup.
    """
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        raise SystemExit(f"FAIL: cannot open {path}: {exc}")
    try:
        try:
            integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        except sqlite3.DatabaseError as exc:
            raise SystemExit(f"FAIL: {path} is not a readable database: {exc}")
        if integrity != "ok":
            raise SystemExit(f"FAIL: integrity_check on {path}: {integrity}")
        rows = {}
        tables = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        for (name,) in tables:
            rows[name] = con.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
        return integrity, rows
    finally:
        con.close()


def main(argv):
    if len(argv) == 3 and argv[1] == "--verify-only":
        integrity, rows = verify(argv[2])
        print(json.dumps({"integrity": integrity, "tables": len(rows), "rows": rows}))
        return 0

    if len(argv) != 3:
        raise SystemExit(__doc__)

    src, dest = Path(argv[1]), Path(argv[2])
    if not src.exists():
        raise SystemExit(f"FAIL: source database does not exist: {src}")
    if src.stat().st_size == 0:
        raise SystemExit(
            f"FAIL: source {src} is 0 bytes. The repo-root mycelium.db is a decoy; "
            "the real database is server/data/mycelium.db."
        )

    dest.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(str(dest))
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()

    integrity, rows = verify(dest)
    print(json.dumps({
        "integrity": integrity,
        "tables": len(rows),
        "rows": rows,
        "src_bytes": src.stat().st_size,
        "dest_bytes": dest.stat().st_size,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

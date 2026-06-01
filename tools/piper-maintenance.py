#!/usr/bin/env python3
"""
Piper — small maintenance worker for the Mycelium squad.

Runs three independent loops against a local Mycelium instance and
Apple Foundation Models (via `apple_fm_shim`):

  Loop A — squad health (every 120s):
      Read /admin/overview slim, find stale-heartbeat agents and
      attention items that persist across cycles, post short
      observation to #squad-health.

  Loop B — memory hygiene (every 30 min):
      Audit the training-corpus memory surfaces — m5Max's auto-memory
      MEMORY.md + each squad persona's SOUL/USER/MEMORY files — for
      index size overruns, > 200-char entries, dead [[backlinks]],
      and duplicate name slugs. Post findings, don't edit.

  Loop C — training curation (every 60 min):
      Sample recent agent_messages from Kira/Lucy/Ada/Echo and tag
      each as train-good / train-skip / train-unsure in the
      `curation_tags` table (added to ~/.openjarvis/agents.db).
      Heuristic-only — no LLM call needed for the tagging itself.

Piper does NOT reassign work, claim bugs, create tasks, or modify
substrate. Pure observation + tagging.

Graceful degradation: if apple_fm_shim is unreachable, narration
falls back to a heuristic one-liner; tagging + memory hygiene work
unchanged.

Usage:
    MYCELIUM_ADMIN_KEY=... python piper-maintenance.py --status
    MYCELIUM_ADMIN_KEY=... python piper-maintenance.py --once --dry-run
    MYCELIUM_ADMIN_KEY=... python piper-maintenance.py
    MYCELIUM_ADMIN_KEY=... python piper-maintenance.py --loop a --once
"""

import argparse
import json
import logging
import os
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as uerror
from urllib import parse as uparse
from urllib import request as urequest

VERSION = "0.1.0"

# ─── Config (env-overridable) ───────────────────────────────────────────

MYCELIUM_URL    = os.environ.get("MYCELIUM_URL", "http://localhost:3002")
APPLE_FM_URL    = os.environ.get("APPLE_FM_URL", "http://localhost:8079")
ADMIN_KEY       = os.environ.get("MYCELIUM_ADMIN_KEY", "")
PIPER_AGENT_ID  = os.environ.get("PIPER_AGENT_ID", "piper")
HEALTH_CHANNEL  = os.environ.get("HEALTH_CHANNEL", "squad-health")

PIPER_PERSONA   = Path.home() / ".openjarvis" / "personas" / "piper" / "SOUL.md"

# Loop B scope — only the training-corpus surfaces
M5MAX_MEMORY_DIR    = Path.home() / ".claude" / "projects" / "-Users-grb-Projects-velum" / "memory"
SQUAD_PERSONA_DIRS  = [
    Path.home() / ".openjarvis" / "personas" / name
    for name in ("kira", "lucy", "ada", "echo")
]
MEMORY_INDEX_LIMIT_BYTES = 24 * 1024
MEMORY_ENTRY_MAX_CHARS   = 200

# Loop C scope — only the four with active training pipelines
CURATION_SQUAD_NAMES    = ("kira", "lucy", "ada", "echo")
CURATION_SAMPLE_SIZE    = 50
AGENTS_DB               = Path.home() / ".openjarvis" / "agents.db"

INTERVAL_A_DEFAULT = 120
INTERVAL_B_DEFAULT = 30 * 60
INTERVAL_C_DEFAULT = 60 * 60

# Persistent state for two-cycle filter (prevents narrating transient blips)
_attention_seen_last_cycle: set = set()
_stale_hb_seen_last_cycle:  set = set()

log = logging.getLogger("piper")


# ─── HTTP helpers ───────────────────────────────────────────────────────

def _myc(method: str, path: str, body=None, params=None):
    url = f"{MYCELIUM_URL}/api/mycelium{path}"
    if params:
        url += "?" + uparse.urlencode(params)
    headers = {"X-Admin-Key": ADMIN_KEY,
               "X-Acting-As": PIPER_AGENT_ID}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urequest.Request(url, headers=headers, data=data, method=method)
    with urequest.urlopen(req, timeout=15) as r:
        text = r.read().decode("utf-8", errors="replace")
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

def mycelium_get(path, params=None): return _myc("GET",  path, params=params)
def mycelium_post(path, body):       return _myc("POST", path, body=body)
def mycelium_put(path, body):        return _myc("PUT",  path, body=body)


def apple_fm_classify(prompt: str, system: str | None = None,
                       max_tokens: int = 128) -> str | None:
    """Call Apple FM shim. Returns text or None on any failure (graceful)."""
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    body = {
        "model": "apple-fm",
        "messages": msgs,
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }
    try:
        req = urequest.Request(
            f"{APPLE_FM_URL}/v1/chat/completions",
            headers={"Content-Type": "application/json"},
            data=json.dumps(body).encode(), method="POST",
        )
        with urequest.urlopen(req, timeout=30) as r:
            obj = json.load(r)
        return (obj["choices"][0].get("message") or {}).get("content") or ""
    except (uerror.URLError, ConnectionRefusedError, TimeoutError) as e:
        log.debug(f"apple-fm unreachable: {e}")
        return None
    except Exception as e:
        log.warning(f"apple-fm error: {e}")
        return None


# ─── Persona ────────────────────────────────────────────────────────────

def load_persona_system() -> str:
    if PIPER_PERSONA.exists():
        return PIPER_PERSONA.read_text()
    return ("You are Piper, the squad's small maintenance worker. "
            "Two sentences max per observation. Cite the signal that "
            "triggered it. Never narrate when nothing's wrong.")


# ─── Channel resolution ─────────────────────────────────────────────────

def _find_channel(slug: str):
    """Look up channel by slug (with caching across calls)."""
    if not hasattr(_find_channel, "_cache"):
        _find_channel._cache = {}
    if slug in _find_channel._cache:
        return _find_channel._cache[slug]
    channels = mycelium_get("/channels")
    chs = channels if isinstance(channels, list) else channels.get("data", []) or channels.get("channels", [])
    for c in chs or []:
        if c.get("slug") == slug or c.get("name") == slug or c.get("name") == "#" + slug:
            _find_channel._cache[slug] = c
            return c
    return None


def post_to_health(observation: str, signals: dict | None = None) -> int | None:
    obs = observation.strip()
    if signals:
        obs += "\n\n```json\n" + json.dumps(signals, default=str, indent=2)[:2000] + "\n```"
    ch = _find_channel(HEALTH_CHANNEL)
    if not ch:
        log.warning(f"channel '{HEALTH_CHANNEL}' not found — observation NOT posted")
        log.info(f"observation was: {obs[:200]}")
        return None
    try:
        result = mycelium_post(f"/channels/{ch['id']}/messages", {
            "from_agent": PIPER_AGENT_ID,
            "content": obs,
        })
        return (result or {}).get("id") if isinstance(result, dict) else None
    except Exception as e:
        log.error(f"post_to_health failed: {e}")
        return None


# ─── Loop A — squad health ──────────────────────────────────────────────

_STALE_HB_RE = re.compile(r"(\d+)\s*([hd])")   # "3h" / "2d"; minutes ignored

def _heartbeat_is_stale(hb: str | None) -> bool:
    if not hb:
        return False
    hb = hb.strip().lower()
    if hb in ("never", "unknown", ""):
        return True
    return bool(_STALE_HB_RE.search(hb))


def loop_a_cycle(dry_run: bool = False) -> None:
    global _attention_seen_last_cycle, _stale_hb_seen_last_cycle

    try:
        overview = mycelium_get("/admin/overview")
    except Exception as e:
        log.error(f"loop_a fetch failed: {e}")
        return
    if not isinstance(overview, dict):
        log.error(f"loop_a: unexpected overview shape: {type(overview).__name__}")
        return

    attention = overview.get("attention", []) or []
    agents    = overview.get("agents", []) or []

    # Two-cycle filter on attention items
    current_keys = {f"{a.get('type')}:{a.get('id')}" for a in attention}
    persistent_attention = [a for a in attention
                            if f"{a.get('type')}:{a.get('id')}" in _attention_seen_last_cycle]
    _attention_seen_last_cycle = current_keys

    # Stale heartbeats — online agents with a multi-hour-or-more gap
    stale_hb_now = [{"id": a["id"], "heartbeat": a.get("heartbeat", ""),
                     "working_on": a.get("working_on") or ""}
                    for a in agents
                    if a.get("status") == "online"
                    and _heartbeat_is_stale(a.get("heartbeat"))
                    and a["id"] != PIPER_AGENT_ID]
    current_hb_keys = {s["id"] for s in stale_hb_now}
    persistent_hb = [s for s in stale_hb_now if s["id"] in _stale_hb_seen_last_cycle]
    _stale_hb_seen_last_cycle = current_hb_keys

    if not persistent_attention and not persistent_hb:
        log.info(f"loop_a: clean (or transient — attention={len(attention)}, "
                 f"stale_hb_new={len(stale_hb_now)})")
        return

    snapshot = {"attention": persistent_attention[:6],
                "stale_heartbeats": persistent_hb[:6]}

    # Brain call (may return None if shim down — graceful)
    obs = apple_fm_classify(
        "Snapshot:\n" + json.dumps(snapshot, indent=2)
        + "\n\nWrite ONE short observation (≤2 sentences) of what stands out. "
        "Cite the specific item(s). No filler.",
        system=load_persona_system(),
        max_tokens=120,
    )
    if not obs:
        # Heuristic fallback
        bits = []
        if persistent_hb:
            sample = ", ".join(f"{s['id']}({s['heartbeat']})" for s in persistent_hb[:3])
            bits.append(f"Stale heartbeats: {sample}.")
        if persistent_attention:
            bits.append(f"{len(persistent_attention)} unresolved attention items.")
        obs = " ".join(bits) or "(empty)"

    log.info(f"loop_a observation: {obs[:200]}")
    if not dry_run:
        post_to_health(obs, signals=snapshot)


# ─── Loop B — memory hygiene ────────────────────────────────────────────

_FRONTMATTER_NAME_RE = re.compile(r"^name:\s*([a-z0-9_-]+)", re.MULTILINE)
_BACKLINK_RE         = re.compile(r"\[\[([a-zA-Z0-9_-]+)\]\]")


def audit_memory_index(index_path: Path) -> dict:
    f = {
        "surface":           index_path.parent.name,
        "path":              str(index_path),
        "size_bytes":        0,
        "over_limit":        False,
        "entry_count":       0,
        "long_entries":      [],
        "dead_backlinks":    [],
        "duplicate_slugs":   [],
        "orphan_files":      [],
    }
    if not index_path.exists():
        return f

    content = index_path.read_text(errors="replace")
    f["size_bytes"] = len(content.encode())
    f["over_limit"] = f["size_bytes"] > MEMORY_INDEX_LIMIT_BYTES

    entry_lines = [l for l in content.splitlines() if l.strip().startswith("- ")]
    f["entry_count"] = len(entry_lines)
    indexed_slugs = set()
    for line in entry_lines:
        m = re.search(r"\(([a-zA-Z0-9_-]+)\.md\)", line)
        if m:
            indexed_slugs.add(m.group(1))
        if len(line) > MEMORY_ENTRY_MAX_CHARS:
            f["long_entries"].append({
                "slug":   m.group(1) if m else "?",
                "length": len(line),
            })

    # Walk peer .md files
    memory_dir = index_path.parent
    existing = {p.stem for p in memory_dir.glob("*.md") if p.name != "MEMORY.md"}

    # Dead backlinks
    for md_path in memory_dir.glob("*.md"):
        if md_path.name == "MEMORY.md":
            continue
        try:
            text = md_path.read_text(errors="replace")
        except OSError:
            continue
        for m in _BACKLINK_RE.finditer(text):
            target = m.group(1)
            if target not in existing:
                f["dead_backlinks"].append({"in": md_path.stem, "target": target})
    f["dead_backlinks"] = f["dead_backlinks"][:20]

    # Duplicate name slugs (multiple files declaring the same `name:`)
    slugs = defaultdict(list)
    for md_path in memory_dir.glob("*.md"):
        try:
            text = md_path.read_text(errors="replace")
        except OSError:
            continue
        m = _FRONTMATTER_NAME_RE.search(text)
        if m:
            slugs[m.group(1)].append(md_path.stem)
    f["duplicate_slugs"] = [{"slug": k, "files": v}
                            for k, v in slugs.items() if len(v) > 1]

    # Orphan files — exist on disk but not in MEMORY.md
    f["orphan_files"] = sorted(existing - indexed_slugs)[:20]

    return f


def audit_persona_dir(persona_dir: Path) -> dict:
    f = {"surface": f"persona-{persona_dir.name}", "files": {}}
    if not persona_dir.exists():
        f["missing"] = True
        return f
    for fname in ("SOUL.md", "USER.md", "MEMORY.md"):
        p = persona_dir / fname
        if p.exists():
            text = p.read_text(errors="replace")
            f["files"][fname] = {
                "size_bytes": p.stat().st_size,
                "lines":      len(text.splitlines()),
            }
    return f


def loop_b_cycle(dry_run: bool = False) -> None:
    findings = []

    if M5MAX_MEMORY_DIR.exists():
        findings.append(audit_memory_index(M5MAX_MEMORY_DIR / "MEMORY.md"))

    for d in SQUAD_PERSONA_DIRS:
        findings.append(audit_persona_dir(d))

    issues = []
    for f in findings:
        if f.get("over_limit"):
            issues.append(f"{f['surface']}: index {f['size_bytes']:,} bytes (over 24KB)")
        if f.get("long_entries"):
            issues.append(f"{f['surface']}: {len(f['long_entries'])} index entries >200 chars")
        if f.get("dead_backlinks"):
            issues.append(f"{f['surface']}: {len(f['dead_backlinks'])} dead [[backlinks]]")
        if f.get("duplicate_slugs"):
            issues.append(f"{f['surface']}: {len(f['duplicate_slugs'])} duplicate name slugs")
        if f.get("orphan_files"):
            issues.append(f"{f['surface']}: {len(f['orphan_files'])} files missing from index")
        if f.get("missing"):
            issues.append(f"{f['surface']}: persona dir missing")

    if not issues:
        log.info("loop_b: memory surfaces clean")
        return

    obs = "Memory hygiene: " + " ".join("• " + i for i in issues[:8])
    log.info(f"loop_b observation: {obs[:300]}")
    if not dry_run:
        post_to_health(obs, signals={"findings": findings})


# ─── Loop C — training curation ─────────────────────────────────────────

CURATION_DDL = """
CREATE TABLE IF NOT EXISTS curation_tags (
    message_id INTEGER PRIMARY KEY,
    agent_id   TEXT    NOT NULL,
    tag        TEXT    NOT NULL,    -- train-good | train-skip | train-unsure
    reason     TEXT    NOT NULL DEFAULT '',
    tagged_at  REAL    NOT NULL,
    tagger     TEXT    NOT NULL DEFAULT 'piper'
);
CREATE INDEX IF NOT EXISTS idx_curation_agent ON curation_tags(agent_id);
CREATE INDEX IF NOT EXISTS idx_curation_tag   ON curation_tags(tag);
"""

def ensure_curation_table() -> None:
    con = sqlite3.connect(AGENTS_DB)
    try:
        con.executescript(CURATION_DDL)
        con.commit()
    finally:
        con.close()


def resolve_squad_agent_ids() -> dict[str, str]:
    """Resolve {name: agent_id} from agents.db for the curation target list."""
    if not AGENTS_DB.exists():
        return {}
    con = sqlite3.connect(AGENTS_DB)
    try:
        rows = con.execute(
            f"SELECT id, lower(name) FROM managed_agents "
            f"WHERE lower(name) IN ({','.join('?'*len(CURATION_SQUAD_NAMES))})",
            CURATION_SQUAD_NAMES,
        ).fetchall()
    finally:
        con.close()
    return {name: aid for aid, name in rows}


def score_message(text: str) -> tuple[str, str]:
    """Heuristic scoring — no LLM needed."""
    s = (text or "").strip()
    if not s:
        return ("train-skip", "empty")
    if len(s) < 20:
        return ("train-skip", "too-short")

    tokens = s.split()
    if len(tokens) >= 16:
        grams = [" ".join(tokens[i:i+8]) for i in range(len(tokens) - 7)]
        rep = Counter(grams).most_common(1)[0][1] if grams else 0
        if rep >= 8:
            return ("train-skip", f"rep_score={rep}")

    if len(s) > 12000:
        return ("train-skip", "over-12k-chars")
    if len(s) < 80:
        return ("train-unsure", "short-response")

    return ("train-good", "")


def loop_c_cycle(dry_run: bool = False) -> None:
    if not AGENTS_DB.exists():
        log.warning(f"loop_c: {AGENTS_DB} missing")
        return

    ensure_curation_table()
    squad = resolve_squad_agent_ids()
    if not squad:
        log.warning("loop_c: no squad agent records found")
        return

    tagged: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    con = sqlite3.connect(AGENTS_DB)
    try:
        for name, agent_id in squad.items():
            rows = con.execute("""
                SELECT m.rowid, m.content
                  FROM agent_messages m
             LEFT JOIN curation_tags ct ON ct.message_id = m.rowid
                 WHERE m.agent_id = ?
                   AND m.direction = 'agent_to_user'
                   AND ct.message_id IS NULL
              ORDER BY m.created_at DESC
                 LIMIT ?
            """, (agent_id, CURATION_SAMPLE_SIZE)).fetchall()

            for rowid, content in rows:
                tag, reason = score_message(content or "")
                if not dry_run:
                    con.execute(
                        "INSERT OR REPLACE INTO curation_tags "
                        "(message_id, agent_id, tag, reason, tagged_at, tagger) "
                        "VALUES (?, ?, ?, ?, ?, 'piper')",
                        (rowid, agent_id, tag, reason, time.time())
                    )
                tagged[name][tag] += 1
        if not dry_run:
            con.commit()
    finally:
        con.close()

    total = sum(sum(d.values()) for d in tagged.values())
    if total == 0:
        log.info("loop_c: no new messages to tag")
        return

    bits = []
    for name in CURATION_SQUAD_NAMES:
        d = tagged.get(name)
        if not d:
            continue
        good   = d.get("train-good", 0)
        skip   = d.get("train-skip", 0)
        unsure = d.get("train-unsure", 0)
        bits.append(f"{name}: {good}/{good+skip+unsure} good")
    obs = f"Curation pass tagged {total} msgs. " + ", ".join(bits) + "."
    log.info(f"loop_c observation: {obs}")
    if not dry_run:
        post_to_health(obs, signals={"tagged": {k: dict(v) for k, v in tagged.items()}})


# ─── Self-heartbeat ─────────────────────────────────────────────────────

def heartbeat_self() -> None:
    try:
        mycelium_put(f"/admin/agents/{PIPER_AGENT_ID}/heartbeat", {
            "status":     "online",
            "working_on": "squad maintenance loops",
        })
    except Exception as e:
        log.debug(f"heartbeat failed: {e}")


# ─── --status ───────────────────────────────────────────────────────────

def status_dump() -> int:
    print(f"piper-maintenance v{VERSION}")
    print(f"  mycelium: {MYCELIUM_URL}")
    print(f"  apple-fm: {APPLE_FM_URL}")
    print(f"  persona:  {PIPER_PERSONA} ({'present' if PIPER_PERSONA.exists() else 'MISSING'})")
    print(f"  agents.db: {AGENTS_DB} ({'present' if AGENTS_DB.exists() else 'MISSING'})")

    apple_test = apple_fm_classify("Reply with: OK", max_tokens=4)
    print(f"  apple-fm reachable: {'YES' if apple_test is not None else 'NO — heuristic-only mode'}")

    try:
        overview = mycelium_get("/admin/overview")
        agents = overview.get("agents", []) or []
        attention = overview.get("attention", []) or []
        print(f"  mycelium overview: {len(agents)} agents, {len(attention)} attention items")
        for a in agents[:12]:
            stale = "*" if _heartbeat_is_stale(a.get("heartbeat")) else " "
            print(f"    {stale} {a.get('id','?'):20s} {a.get('status','?'):10s} "
                  f"hb={a.get('heartbeat','-'):>8s}  {a.get('working_on') or ''}"[:120])
        if attention:
            print(f"  attention items:")
            for x in attention[:6]:
                print(f"    {x.get('type','?'):16s} #{x.get('id','?')}  {(x.get('title') or x.get('action') or '')[:70]}")
    except Exception as e:
        print(f"  mycelium: FAIL — {e}")
        return 1

    ch = _find_channel(HEALTH_CHANNEL)
    print(f"  #{HEALTH_CHANNEL} channel: {'present (#' + str(ch['id']) + ')' if ch else 'MISSING — create with --init-channel'}")
    return 0


def init_channel() -> int:
    """Create the #squad-health channel if it doesn't exist."""
    ch = _find_channel(HEALTH_CHANNEL)
    if ch:
        print(f"channel already exists: #{ch['id']} '{ch.get('name')}'")
        return 0
    try:
        result = mycelium_post("/channels", {
            "name":        "squad-health",
            "slug":        HEALTH_CHANNEL,
            "type":        "general",
            "description": "Piper posts squad-maintenance observations here.",
        })
        print(f"created channel: {json.dumps(result, indent=2)}")
        _find_channel._cache.pop(HEALTH_CHANNEL, None)
        return 0
    except Exception as e:
        print(f"channel create failed: {e}")
        return 1


# ─── Main ───────────────────────────────────────────────────────────────

def main() -> int:
    p = argparse.ArgumentParser(description="Piper — squad maintenance worker")
    p.add_argument("--once",         action="store_true", help="one cycle of selected loops then exit")
    p.add_argument("--loop",         choices=["a", "b", "c"], help="only run one loop")
    p.add_argument("--dry-run",      action="store_true", help="don't post observations / don't write tags")
    p.add_argument("--status",       action="store_true", help="status snapshot, no LLM, exit")
    p.add_argument("--init-channel", action="store_true", help="create #squad-health if missing, exit")
    p.add_argument("--interval-a",   type=int, default=INTERVAL_A_DEFAULT)
    p.add_argument("--interval-b",   type=int, default=INTERVAL_B_DEFAULT)
    p.add_argument("--interval-c",   type=int, default=INTERVAL_C_DEFAULT)
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if not ADMIN_KEY:
        print("ERROR: MYCELIUM_ADMIN_KEY env var required", file=sys.stderr)
        return 1

    if args.init_channel:
        return init_channel()

    if args.status:
        return status_dump()

    if args.once:
        if args.loop in (None, "a"): loop_a_cycle(dry_run=args.dry_run)
        if args.loop in (None, "b"): loop_b_cycle(dry_run=args.dry_run)
        if args.loop in (None, "c"): loop_c_cycle(dry_run=args.dry_run)
        return 0

    # Daemon mode
    last_a = last_b = last_c = 0.0
    next_hb = 0.0
    log.info(f"piper online — A={args.interval_a}s B={args.interval_b}s C={args.interval_c}s "
             f"(dry={args.dry_run})")
    try:
        while True:
            now = time.monotonic()
            if now >= next_hb:
                heartbeat_self()
                next_hb = now + 60
            if now - last_a >= args.interval_a:
                try: loop_a_cycle(dry_run=args.dry_run)
                except Exception as e: log.error(f"loop_a crashed: {e}")
                last_a = now
            if now - last_b >= args.interval_b:
                try: loop_b_cycle(dry_run=args.dry_run)
                except Exception as e: log.error(f"loop_b crashed: {e}")
                last_b = now
            if now - last_c >= args.interval_c:
                try: loop_c_cycle(dry_run=args.dry_run)
                except Exception as e: log.error(f"loop_c crashed: {e}")
                last_c = now
            time.sleep(5)
    except KeyboardInterrupt:
        log.info("shutting down")
        return 0


if __name__ == "__main__":
    sys.exit(main())

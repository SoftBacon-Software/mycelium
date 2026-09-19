#!/usr/bin/env python3
"""trajectory — Mycelium episodes ⇄ Letta trajectory v1 (task 243).

Two commands, one round trip:

  export  the EPISODE rows of one session (metadata.session_id) become a
          Letta trajectory v1 file (https://github.com/letta-ai/trajectory)
          — one text record per episode, verbatim — plus a Mycelium sidecar.
  ingest  a trajectory v1 file becomes EPISODE rows again, through the
          platform's EXISTING POST /memory/index (embedded, chunk-aware,
          searchable — no new organ), with the full provenance gate
          (agent + session_date required; facts are NOT written here —
          episodes only, the 3040 lesson).

THE BRIEF DEFECT THIS TOOL ENCODES (verified against the v1 schema, kept at
tools/trajectory-v1.schema.json): the brief said Mycelium's timeline/supersede
metadata "rides in the record's extension fields, never dropped" — but v1 sets
`additionalProperties: false` on EVERY record variant (meta/user/assistant/
tool/system/observation/reasoning) and on tool_call. There are NO extension
fields. So the interop contract is: the trajectory file stays a bare,
schema-validating v1 array ( interoperability is the point ), and everything
v1 cannot carry — the full original episode metadata, authority/confidence,
supersede lines, the episode source_ids — rides in a SIDECAR file
`<out>.mycelium.json` (format mycelium-episode-sidecar/1). `ingest --sidecar`
re-attaches it: the resolved provenance of THIS ingest wins (agent/
session_date/session_id/origin), and every non-colliding original key rides
along untouched. Metadata is never dropped; it just cannot live inside v1.

TIMESTAMPS: v1 REQUIRES one on every non-meta record (pattern
^\\d{4}-..T..:..:..(Z|±hh:mm)$). An episode exports at its own created_at
when that matches the pattern, else at its session_date T00:00:00Z — a
derived stamp, stated here and visible in the output; the original
session_date is in the sidecar regardless.

WHAT DOES NOT BECOME AN EPISODE (counted, never silently dropped):
  * meta records (v1's provenance header, not a turn) — `ingest` skips them
    by design and reports the count;
  * assistant records with tool_calls (content null — v1 requires null there)
    and any record without string content — reported by index;
  * export-side: episode rows without string content_text — reported by
    source_id. All of them ride in the sidecar where one is written.

TRANSPORT: curl, not urllib — python sockets die from inside lanes; curl
lives (the 2026-09-17 ledger lesson). Inject a fake `runner` in tests.

ROW SHAPE written by ingest (the platform refuses a 400 without the first two):
  source_type   'episode'
  source_id     'episode:<sha256(session_id:record_index:content)>' — stable
                per file content + position, so re-ingesting the same file
                upserts (ON CONFLICT DO UPDATE) and lands 0 new rows
  content_text  the record's content, verbatim
  metadata      agent, session_date, session_id, origin   [platform gate]
                traj_role, traj_index, traj_timestamp    [round-trip keys]
                traj_tool_call_id / traj_ok              [tool records]
                + every non-colliding key from the sidecar, if given
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from urllib.parse import urlencode
from pathlib import Path

DEFAULT_NAMESPACE = "lab"
SIDECAR_SUFFIX = ".mycelium.json"
SIDECAR_FORMAT = "mycelium-episode-sidecar/1"
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# The v1 record variants, exactly as tools/trajectory-v1.schema.json says them:
# required keys, optional keys, and content type. additionalProperties is false
# everywhere, so anything outside these sets makes the FILE not a trajectory.
VARIANTS = {
    "meta": {"required": {"role", "source"}, "optional": {"cwd", "git_branch", "model"}},
    "user": {"required": {"role", "content", "timestamp"}, "optional": set()},
    "system": {"required": {"role", "content", "timestamp"}, "optional": set()},
    "observation": {"required": {"role", "content", "timestamp"}, "optional": set()},
    "reasoning": {"required": {"role", "content", "timestamp"}, "optional": set()},
    "assistant": {"required": {"role", "content", "timestamp"}, "optional": {"tool_calls"}},
    "tool": {"required": {"role", "tool_call_id", "content", "timestamp"}, "optional": {"ok"}},
}
TEXT_ROLES = {"user", "system", "observation", "reasoning", "assistant", "tool"}


def default_url() -> str:
    """Canonical platform API base. MYCELIUM_URL env wins; then the lab's ONE
    place for the substrate name (~/.claude/hooks/substrate.conf); then the
    documented 2026-07 cutover address."""
    env = os.environ.get("MYCELIUM_URL", "").strip()
    if env:
        return env.rstrip("/")
    try:
        for line in (Path.home() / ".claude/hooks/substrate.conf").read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and line.split("=", 1)[0].strip() == "MYCELIUM_URL":
                base = line.split("=", 1)[1].strip().rstrip("/")
                return base if base.endswith("/api/mycelium") else base + "/api/mycelium"
    except OSError:
        pass
    return "http://192.168.50.106:3002/api/mycelium"


def _parse_response(out: str) -> dict:
    """Split the `-w` status trailer, parse the JSON body, raise on >=400."""
    body, _, code = out.rpartition("\n")
    body = body or out  # no -w trailer when the server wrote nothing
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"non-JSON response (http {code.strip()}): {body[:200]}") from e
    if code.strip().isdigit() and int(code.strip()) >= 400:
        raise RuntimeError(f"HTTP {code.strip()}: {json.dumps(parsed)[:200]}")
    return parsed


def _curl_run(argv: list, stdin_bytes: bytes | None) -> str:
    """The real transport: one curl; returns the RAW body+status output —
    parsing is the client's (`_parse_response`), so fakes only mimic curl."""
    proc = subprocess.run(argv, input=stdin_bytes, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"curl rc={proc.returncode}: {proc.stderr.decode('utf-8', errors='replace').strip()[:200]}")
    return proc.stdout.decode("utf-8", errors="replace")


class CurlClient:
    """POST/GET against the platform's semantic-memory routes via curl."""

    def __init__(self, url: str | None = None, admin_key: str | None = None,
                 acting_as: str = "m5Max", runner=None):
        self.base = (url or default_url()).rstrip("/")
        key = admin_key or os.environ.get("MYCELIUM_API_KEY") or os.environ.get("ADMIN_KEY")
        if not key:
            raise SystemExit(
                "trajectory: no admin key — set MYCELIUM_API_KEY (or ADMIN_KEY); "
                "episode writes carry the operator's key, not a guessed one")
        self._headers = ["-H", f"X-Admin-Key: {key}", "-H", f"X-Acting-As: {acting_as}"]
        self._runner = runner or _curl_run

    def request(self, method: str, path: str, *, params: dict | None = None,
                json_body: dict | None = None, timeout: int = 30) -> dict:
        qs = ("?" + urlencode(params)) if params else ""
        argv = ["curl", "-sS", "--max-time", str(timeout), "-X", method,
                self.base + path + qs, *self._headers, "-w", "\n%{http_code}"]
        stdin_bytes = None
        if json_body is not None:
            argv += ["-H", "Content-Type: application/json", "--data-binary", "@-"]
            stdin_bytes = json.dumps(json_body).encode("utf-8")
        return _parse_response(self._runner(argv, stdin_bytes))


# --------------------------------------------------------------- validation --

def validate_records(records) -> list[str]:
    """Mirror of trajectory-v1.schema.json's constraints — every refusal the
    real schema would make, by hand (the tool carries no schema deps)."""
    errors: list[str] = []
    if not isinstance(records, list):
        return [f"top level must be an array, got {type(records).__name__}"]
    if not records:
        return ["empty trajectory (v1 requires minItems 1)"]
    for i, rec in enumerate(records):
        if not isinstance(rec, dict):
            errors.append(f"[{i}] not an object")
            continue
        role = rec.get("role")
        spec = VARIANTS.get(role)
        if spec is None:
            errors.append(f"[{i}] role {role!r} is not a v1 variant")
            continue
        missing = spec["required"] - set(rec)
        if missing:
            errors.append(f"[{i}] {role}: missing required {sorted(missing)}")
        unknown = set(rec) - spec["required"] - spec["optional"]
        if unknown:
            errors.append(f"[{i}] {role}: unknown keys {sorted(unknown)} (v1 is additionalProperties:false)")
        if "timestamp" in rec and isinstance(rec.get("timestamp"), str) \
                and not TIMESTAMP_RE.match(rec["timestamp"]):
            errors.append(f"[{i}] {role}: timestamp does not match the v1 pattern")
        if role == "meta" and not isinstance(rec.get("source", ""), str):
            errors.append(f"[{i}] meta: source must be a string")
        if role in TEXT_ROLES and "content" in rec:
            content = rec["content"]
            ok_types = (str, type(None)) if role == "assistant" else (str,)
            if not isinstance(content, ok_types):
                errors.append(f"[{i}] {role}: content must be a string"
                              + (" or null" if role == "assistant" else ""))
        if "tool_calls" in rec:
            calls = rec["tool_calls"]
            if not isinstance(calls, list) or not calls:
                errors.append(f"[{i}] assistant: tool_calls must be a non-empty array")
            else:
                for j, call in enumerate(calls):
                    if not isinstance(call, dict) or not isinstance(call.get("id"), str) \
                            or not isinstance(call.get("name"), str) or not isinstance(call.get("args"), str) \
                            or set(call) - {"id", "name", "args"}:
                        errors.append(f"[{i}] assistant: tool_calls[{j}] must be exactly "
                                      f"{{id, name, args}} with string values")
        if "ok" in rec and not isinstance(rec.get("ok"), bool):
            errors.append(f"[{i}] tool: ok must be a boolean")
    return errors


# ------------------------------------------------------------------ helpers --

def _row_sort_key(row: dict):
    """Order by the provider's capture seq when present, else source_id — a
    stable, stated order, never dict luck."""
    meta = row.get("metadata") or {}
    seq = meta.get("seq")
    return (0, seq, row.get("source_id", "")) if isinstance(seq, int) else (1, 0, row.get("source_id", ""))


def _episode_timestamp(row: dict) -> str:
    created = row.get("created_at")
    if isinstance(created, str) and TIMESTAMP_RE.match(created):
        return created
    session_date = (row.get("metadata") or {}).get("session_date", "")
    if DATE_RE.match(session_date):
        return session_date + "T00:00:00Z"  # derived, stated in the module docstring
    return "1970-01-01T00:00:00Z"


def _row_role(row: dict) -> str:
    role = (row.get("metadata") or {}).get("traj_role")
    return role if role in TEXT_ROLES else "observation"


def episode_to_record(row: dict) -> dict | None:
    """One episode row -> one v1 text record, or None when the row has no
    string content to carry (counted by the caller, never dropped silently)."""
    text = row.get("content_text")
    if not isinstance(text, str):
        return None
    role = _row_role(row)
    ts = _episode_timestamp(row)
    if role == "tool":
        meta = row.get("metadata") or {}
        rec = {"role": "tool",
               "tool_call_id": meta.get("traj_tool_call_id") or row.get("source_id", "episode:unknown"),
               "content": text, "timestamp": ts}
        if isinstance(meta.get("traj_ok"), bool):
            rec["ok"] = meta["traj_ok"]
        return rec
    return {"role": role, "content": text, "timestamp": ts}


def _record_text(rec: dict) -> str | None:
    """The string an episode row will carry, or None when this record cannot
    be an episode (meta, or assistant-with-tool_calls whose content v1 forces
    to null)."""
    if not isinstance(rec.get("content"), str):
        return None
    return rec["content"]


def _sidecar_entry(meta: dict) -> dict:
    return {"format": SIDECAR_FORMAT, "metadata": meta}


# ------------------------------------------------------------------- export --

def cmd_export(args, client) -> int:
    params = {"agent": args.agent, "namespace": args.namespace, "limit": 500}
    res = client.request("GET", "/memory/episodes", params=params)
    all_rows = res.get("results", [])
    rows = [r for r in all_rows if (r.get("metadata") or {}).get("session_id") == args.session_id]
    rows.sort(key=_row_sort_key)

    records: list[dict] = []
    sidecar_records: dict = {}
    non_text: list[dict] = []
    for i, row in enumerate(rows):
        rec = episode_to_record(row)
        meta = dict(row.get("metadata") or {})
        meta["episode_source_id"] = row.get("source_id")
        if rec is None:
            non_text.append({"episode_source_id": row.get("source_id"),
                             "reason": "episode has no string content_text",
                             "metadata": meta})
            continue
        sidecar_records[str(len(records))] = _sidecar_entry(meta)
        records.append(rec)

    errors = validate_records(records)
    if errors:
        print("[trajectory] EXPORT REFUSED — the records are not a valid v1 trajectory:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    out_path.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    sidecar = {
        "format": SIDECAR_FORMAT,
        "agent": args.agent,
        "session_id": args.session_id,
        "namespace": args.namespace,
        "records": sidecar_records,
        "non_text": non_text,
    }
    sidecar_path = Path(str(out_path) + SIDECAR_SUFFIX)
    sidecar_path.write_text(json.dumps(sidecar, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"[trajectory] export: agent={args.agent} session={args.session_id} "
          f"scanned={len(all_rows)} matched={len(rows)} records={len(records)} "
          f"non_text={len(non_text)}")
    print(f"[trajectory] wrote {out_path} (+ sidecar {sidecar_path})")
    if non_text:
        print("[trajectory] episodes NOT exported as records (sidecar carries them):", file=sys.stderr)
        for entry in non_text:
            print(f"  {entry['episode_source_id']}: {entry['reason']}", file=sys.stderr)
    return 0


# ------------------------------------------------------------------- ingest --

def build_episode_rows(records: list, *, agent: str, session_date: str, session_id: str,
                       origin: str, namespace: str, sidecar: dict | None) -> tuple[list, dict]:
    """Records -> episode rows + a skip report. meta records and records
    without string content are SKIPPED BY COUNT (the module contract), never
    silently. Sidecar metadata rides under every non-colliding key; THIS
    ingest's resolved provenance always wins."""
    rows: list[dict] = []
    skipped_meta = 0
    skipped_no_text: list[dict] = []
    sidecar_records = (sidecar or {}).get("records", {})
    for i, rec in enumerate(records):
        role = rec.get("role")
        if role == "meta":
            skipped_meta += 1
            continue
        text = _record_text(rec)
        if text is None:
            skipped_no_text.append({"index": i, "role": role,
                                    "reason": "record has no string content "
                                              "(meta aside, v1 forces tool_calls records to content null)"})
            continue
        meta = dict((sidecar_records.get(str(i), {}).get("metadata")) or {})
        meta.update({
            "agent": agent, "session_date": session_date, "session_id": session_id,
            "origin": origin, "traj_role": role, "traj_index": i,
        })
        if isinstance(rec.get("timestamp"), str):
            meta["traj_timestamp"] = rec["timestamp"]
        if role == "tool":
            meta["traj_tool_call_id"] = rec.get("tool_call_id")
            if isinstance(rec.get("ok"), bool):
                meta["traj_ok"] = rec["ok"]
        rows.append({
            "source_type": "episode",
            "source_id": "episode:" + hashlib.sha256(
                f"{session_id}:{i}:{text}".encode("utf-8")).hexdigest(),
            "content_text": text,
            "namespace": namespace,
            "metadata": meta,
        })
    return rows, {"skipped_meta": skipped_meta, "skipped_no_text": skipped_no_text}


def cmd_ingest(args, client) -> int:
    raw = Path(args.trajectory).read_bytes()
    try:
        records = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        print(f"[trajectory] INGEST REFUSED — not readable JSON: {e}", file=sys.stderr)
        return 2
    errors = validate_records(records)
    if errors:
        print("[trajectory] INGEST REFUSED — not a valid v1 trajectory:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        return 2

    sidecar = None
    if args.sidecar:
        try:
            sidecar = json.loads(Path(args.sidecar).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"[trajectory] INGEST REFUSED — sidecar unreadable: {e}", file=sys.stderr)
            return 2

    agent = args.agent or (sidecar or {}).get("agent")
    session_date = args.session_date or (sidecar or {}).get("session_date")
    if not agent or not session_date or not DATE_RE.match(session_date):
        print("[trajectory] INGEST REFUSED — provenance gate: pass --agent and --session-date "
              "(YYYY-MM-DD), or a sidecar carrying both; the platform 400s an episode without them",
              file=sys.stderr)
        return 2
    session_id = args.session_id or (sidecar or {}).get("session_id") \
        or "traj-" + hashlib.sha256(raw).hexdigest()[:12]
    origin = args.origin or f"trajectory:{Path(args.trajectory).name}"

    rows, skips = build_episode_rows(records, agent=agent, session_date=session_date,
                                     session_id=session_id, origin=origin,
                                     namespace=args.namespace, sidecar=sidecar)
    if args.dry_run:
        print(f"[trajectory] dry-run: records={len(records)} episodes={len(rows)} "
              f"skipped_meta={skips['skipped_meta']} skipped_no_text={len(skips['skipped_no_text'])} "
              f"session_id={session_id}")
        if rows:
            print("[trajectory] first rendered row:")
            print(json.dumps(rows[0], indent=2, ensure_ascii=False))
        return 0

    indexed = 0
    failures: list[dict] = []
    for row in rows:
        try:
            client.request("POST", "/memory/index", json_body=row)
            indexed += 1
        except Exception as e:  # noqa: BLE001 — recorded, not swallowed
            failures.append({"source_id": row["source_id"], "traj_index": row["metadata"]["traj_index"],
                             "error": f"{type(e).__name__}: {e}"})

    print(f"[trajectory] ingest: records={len(records)} episodes={len(rows)} "
          f"indexed={indexed} failed={len(failures)} "
          f"skipped_meta={skips['skipped_meta']} skipped_no_text={len(skips['skipped_no_text'])} "
          f"session_id={session_id} origin={origin}")
    if skips["skipped_no_text"]:
        print("[trajectory] records NOT ingested as episodes:", file=sys.stderr)
        for s in skips["skipped_no_text"]:
            print(f"  [{s['index']}] {s['role']}: {s['reason']}", file=sys.stderr)
    if failures:
        print("[trajectory] ROWS NOT INDEXED (platform refused):", file=sys.stderr)
        for f in failures:
            print(f"  {f['source_id']} (record {f['traj_index']})\n    {f['error']}", file=sys.stderr)
        return 3
    return 0


# ---------------------------------------------------------------------- cli --

def main(argv=None, client=None) -> int:
    ap = argparse.ArgumentParser(
        description="Mycelium episodes ⇄ Letta trajectory v1 (task 243).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    pe = sub.add_parser("export", help="one session's episode rows -> trajectory v1 file + sidecar")
    pe.add_argument("--agent", required=True)
    pe.add_argument("--session-id", required=True, dest="session_id")
    pe.add_argument("--out", required=True, help="trajectory file to write (sidecar lands next to it)")
    pe.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    pe.add_argument("--url", default=None)
    pe.set_defaults(func=cmd_export)

    pi = sub.add_parser("ingest", help="trajectory v1 file -> episode rows (POST /memory/index)")
    pi.add_argument("trajectory")
    pi.add_argument("--sidecar", default=None, help="mycelium sidecar; re-attaches export-time metadata")
    pi.add_argument("--agent", default=None)
    pi.add_argument("--session-date", default=None, dest="session_date",
                    help="YYYY-MM-DD (required without a sidecar that carries it)")
    pi.add_argument("--session-id", default=None, dest="session_id",
                    help="default: sidecar's, else traj-<sha12 of the file>")
    pi.add_argument("--origin", default=None)
    pi.add_argument("--namespace", default=DEFAULT_NAMESPACE)
    pi.add_argument("--url", default=None)
    pi.add_argument("--dry-run", action="store_true", help="zero network; counts + one rendered row")
    pi.set_defaults(func=cmd_ingest)

    args = ap.parse_args(argv)
    if client is None:
        client = CurlClient(url=args.url)
    return args.func(args, client)


if __name__ == "__main__":
    sys.exit(main())

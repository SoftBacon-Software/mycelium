#!/usr/bin/env python3
"""mempalace_sidecar — local HTTP wrapper around MemPalace for the memory
benchmark (the CONTROL arm, task 263).

The bench arms are JavaScript; MemPalace is Python. This sidecar drives
MemPalace's OWN ingest + search API — `mempalace.mcp_server.tool_add_drawer`
and `tool_search`, the same functions the product's MCP server dispatches —
against a per-run local ChromaDB palace. It NEVER touches chromadb directly:
calling the vector store behind the product's back is exactly the flaw the
2026-10-29 analysis (jarvis/runs/research/mempalace-analysis-2026-10-29.md)
found in MemPalace's own LongMemEval scripts, and the control arm exists to
measure the product, not the flaw.

Three routes on 127.0.0.1 (never on a routable interface):

    GET  /health   -> {ok, pid, mempalace_version, mempalace_version_matches,
                       pin{commit, tarball_sha256}, embedder{model, dims},
                       palace{path, drawers}, chunk_size, storage, ...}
    POST /add      {user_id, messages, metadata?}  -> ONE add_drawer per
                       haystack session (the session flattened to text — the
                       product chunks it at its configured chunk_size, default
                       800, and returns the chunk count)
    POST /search   {query, user_id, limit}         -> {results: [{memory, score,
                       id, session_index, room, distance}], count,
                       candidates_fetched}

Unlike the letta arm (external server), the store here is LOCAL — a per-run
palace dir the spawner (arm_mempalace.mjs) wipes for a fresh run and purges at
teardown, exactly like the mem0/qdrant and zep/kuzu stores. There is therefore
no /delete_all route: teardown removes the directory after the sidecar has
stopped (purging under a live chromadb client would strand its caches).

What this arm deliberately does NOT wire (the director's config, task 263):

  * NO LLM anywhere. Raw mode = verbatim drawers; write and search are LLM-free
    product paths, so the sidecar needs no LLM endpoint and never dials the
    3090. MemPalace's LLM rerank surface is never called.
  * NO AAAK. The compression feature is never invoked; the regime stamps it off.
  * EMBEDDER = the product default MiniLM (all-MiniLM-L6-v2, 384-dim ONNX) —
    as-shipped, deliberately NOT the incumbent arms' nomic-embed-text/768; the
    difference is part of what "MemPalace as shipped" means and is stamped.

Config comes from env vars only — the spawner resolves them; this file never
hardcodes an address or path:

    MEMPALACE_CONFIG_DIR       the product's config dir (per run)
    MEMPALACE_PALACE_PATH      the palace (ChromaDB) dir (per run)
    MEMPALACE_EMBEDDING_MODEL  default "minilm" (the product default)
    MEMPALACE_EMBEDDER_CACHE   optional — dir holding the pre-warmed ONNX
                               model (setup_mempalace_venv.sh puts it inside
                               the venv); redirected before chromadb loads so
                               RUN time needs no network (HF_HUB_OFFLINE=1)

On startup it prints `MEMPALACE_SIDECAR_READY <port>` to stderr (flushed) —
that line is the spawn handshake; the spawner polls /health afterwards.

Hermetic testing: `make_handler(SidecarState(...))` accepts an injected
`runtime_factory`, so test_mempalace_sidecar.py drives the real HTTP surface
with a fake runtime — no network beyond 127.0.0.1, no mempalace import.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

REQUIRED_ENV = [
    "MEMPALACE_CONFIG_DIR",
    "MEMPALACE_PALACE_PATH",
]

DEFAULTS = {
    "MEMPALACE_EMBEDDING_MODEL": "minilm",  # the product default (as-shipped arm)
    "MEMPALACE_EMBEDDER_CACHE": "",  # empty = chromadb's own cache location
}

# The pinned source this arm benchmarks — mirrors setup_mempalace_venv.sh.
# /health records the version the INSTALLED package reports; a mismatch lands
# in the facts as `mempalace_version_matches: false` rather than a refusal —
# the director may deliberately point the bench at a different pin.
MEMPALACE_VERSION_UNDER_TEST = "3.12.0"
MEMPALACE_PIN_COMMIT = "84582fb055a6429261f9c779da86c0561ec80adc"
MEMPALACE_PIN_TARBALL_SHA256 = "fabe6c765c16fb43b300ddb9f17de44c9f2f3dc6a19e885514fe1659504d762d"

STORAGE_NOTE = (
    "mempalace OSS palace (local ChromaDB, default backend) — per-run palace dir, "
    "installed from the pinned commit via setup_mempalace_venv.sh (venv "
    "bench/memory/.venvs/mempalace, gitignored). Ingest/search go through the "
    "product's own mcp_server tools, never raw chromadb."
)

# The sidecar tags every session's drawers with a synthetic source_file so each
# search hit can be traced to its session (task 207's read_hits). Shape:
# bench/<question_id>/session_<index>.txt — SESSION_SOURCE_RE parses it back.
SESSION_SOURCE_RE = re.compile(r"/session_(\d+)\.txt$")


def session_index_from_source(source_path):
    """The session index encoded in a drawer's source_file, or None (never a
    guess — an unexpected source shape stamps null, like letta's tags)."""
    if not source_path:
        return None
    m = SESSION_SOURCE_RE.search(str(source_path))
    return int(m.group(1)) if m else None


def mempalace_version():
    """Installed mempalace version from package metadata — 'not-installed'
    keeps config_from_env (and the hermetic tests) working on any python3."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("mempalace")
    except PackageNotFoundError:
        return "not-installed"


def _apply_embedder_cache(cache_dir):
    """Redirect chromadb's MiniLM ONNX cache BEFORE chromadb/mempalace load.
    setup_mempalace_venv.sh pre-warms the model into the venv; this makes run
    time offline (the spawner also sets HF_HUB_OFFLINE=1)."""
    if not cache_dir:
        return
    try:
        import chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 as onnxmod
        from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2

        target = os.path.join(cache_dir, "onnx_models", "all-MiniLM-L6-v2")
        if hasattr(onnxmod, "DOWNLOAD_PATH"):
            onnxmod.DOWNLOAD_PATH = target
        if hasattr(ONNXMiniLM_L6_V2, "DOWNLOAD_PATH"):
            ONNXMiniLM_L6_V2.DOWNLOAD_PATH = target
    except Exception:
        # chromadb not importable in this interpreter (hermetic tests) — the
        # real runtime applies the override itself before its first embed.
        pass


def config_from_env(env):
    """Env -> (palace facts). Raises ValueError listing what's missing."""
    missing = [k for k in REQUIRED_ENV if not env.get(k)]
    if missing:
        raise ValueError(f"mempalace_sidecar missing required env: {', '.join(missing)}")
    merged = dict(DEFAULTS)
    for k in DEFAULTS:
        if env.get(k) is not None:
            merged[k] = env[k]
    for k in REQUIRED_ENV:
        merged[k] = env[k]

    palace_path = merged["MEMPALACE_PALACE_PATH"].rstrip("/")
    # the pre-warmed-model redirect MUST land before mempalace (→ chromadb)
    # is first imported — the runtime factory calls this again defensively.
    _apply_embedder_cache(merged["MEMPALACE_EMBEDDER_CACHE"])
    installed_version = mempalace_version()
    facts = {
        "mempalace_version_under_test": MEMPALACE_VERSION_UNDER_TEST,
        "mempalace_version": installed_version,
        # flagged, not refused: the director may deliberately point the bench
        # at a different pin — the row just has to say which version ran
        "mempalace_version_matches": installed_version == MEMPALACE_VERSION_UNDER_TEST,
        "pin": {"commit": MEMPALACE_PIN_COMMIT, "tarball_sha256": MEMPALACE_PIN_TARBALL_SHA256},
        "embedder": {
            "model": merged["MEMPALACE_EMBEDDING_MODEL"],
            "dims": 384,  # all-MiniLM-L6-v2 — the product default's output width
            "cache": merged["MEMPALACE_EMBEDDER_CACHE"] or None,
        },
        "palace": {"path": palace_path},
        "storage": STORAGE_NOTE,
        # the director-pinned config, stamped where the receipt can quote it
        "raw_mode": True,  # verbatim drawers; no LLM in the write path
        "llm_rerank": False,  # tool_search's default path; never invoked
        "aaak": False,  # the compression feature; never invoked
        "ingest_api": "mempalace.mcp_server.tool_add_drawer (the product's own write path)",
        "search_api": "mempalace.mcp_server.tool_search (the product's own read path)",
    }
    return facts


def flatten_session(messages):
    """The session's turns -> one text. ONE add_drawer per haystack session —
    the product chunks it at its configured chunk_size (default 800) exactly
    as it would chunk any ingested file."""
    return "\n".join(f"{m['role']}: {m['content']}" for m in messages)


class MempalaceRuntime:
    """The lazily-imported product API. Nothing from mempalace is imported at
    module load — the hermetic tests never pay the chromadb import, and a
    /health probe does not need the product at all."""

    def __init__(self, facts):
        self.facts = facts
        self._lock = threading.Lock()
        self._tools = None

    def _api(self):
        with self._lock:
            if self._tools is None:
                import mempalace.mcp_server as mcp

                self._tools = mcp
            return self._tools

    def status(self):
        """tool_status -> drawer counts for /health. A missing palace is the
        expected fresh-store state (count 0), not an error."""
        try:
            st = self._api().tool_status()
            if isinstance(st, dict) and st.get("error"):
                return {"total_drawers": 0, "wings": {}, "rooms": {}}
            return st
        except Exception:
            return {"total_drawers": 0, "wings": {}, "rooms": {}}

    def add_session(self, wing, room, text, source_file):
        """One verbatim drawer (product-chunked) via tool_add_drawer. Returns
        (drawer_id, chunks). Raises on the product's {success: False} shape."""
        r = self._api().tool_add_drawer(
            wing=wing, room=room, content=text, source_file=source_file, added_by="bench"
        )
        if not isinstance(r, dict) or not r.get("success"):
            raise RuntimeError(f"tool_add_drawer failed: {json.dumps(r)[:300]}")
        return r.get("drawer_id"), int(r.get("chunks") or 0)

    def search(self, query, limit):
        """tool_search -> normalized hits. Raises on the product's error
        envelope — a failed search is never a fake empty."""
        r = self._api().tool_search(query=query, limit=limit)
        if not isinstance(r, dict) or r.get("error"):
            raise RuntimeError(f"tool_search failed: {json.dumps(r)[:300]}")
        hits = []
        for h in r.get("results") or []:
            hits.append(
                {
                    "memory": h.get("text"),
                    "score": h.get("similarity"),
                    "id": h.get("drawer_id"),
                    "session_index": session_index_from_source(h.get("source_path")),
                    "room": h.get("room"),
                    "distance": h.get("distance"),
                }
            )
        return hits, int(r.get("total_before_filter") or 0)


class SidecarState:
    """Env + the lazily-created runtime. One per process."""

    def __init__(self, env=None, runtime_factory=None):
        self.env = env if env is not None else os.environ
        self.facts = config_from_env(self.env)
        if runtime_factory is None:
            runtime_factory = MempalaceRuntime
        self.runtime = runtime_factory(self.facts)


class BadRequest(Exception):
    pass


def _read_json(handler):
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        raise BadRequest("missing request body")
    try:
        return json.loads(handler.rfile.read(length).decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise BadRequest(f"body is not valid JSON: {e}")


def make_handler(state, inflight=None):
    """Build a request handler bound to `state` — the seam the unittest drives."""

    class Handler(BaseHTTPRequestHandler):
        def handle(self):
            if inflight is None:
                return super().handle()
            with inflight:
                return super().handle()

        def log_message(self, fmt, *args):  # stderr, one line — the spawner surfaces it on failure
            import sys

            sys.stderr.write("[mempalace-sidecar] %s\n" % (fmt % args))
            sys.stderr.flush()

        def _send(self, status, payload):
            body = (json.dumps(payload) + "\n").encode("utf8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _fail(self, status, error):
            self._send(status, {"ok": False, "error": str(error)})

        def do_GET(self):
            if self.path == "/health":
                # the store is LOCAL and the sidecar owns its dirs: ok is
                # decided by the dirs existing/being usable, not by a remote
                # probe (unlike the letta arm, whose store is external).
                palace_ok = os.path.isdir(state.facts["palace"]["path"])
                self._send(
                    200,
                    {
                        "ok": palace_ok,
                        "pid": os.getpid(),
                        "palace_ok": palace_ok,
                        "error": None if palace_ok else f"palace dir missing: {state.facts['palace']['path']}",
                        **state.facts,
                        **state.runtime.status(),
                    },
                )
                return
            self._fail(404, f"no such route: {self.path}")

        def do_POST(self):
            try:
                body = _read_json(self)
                if self.path == "/add":
                    self._send(200, self._add(body))
                elif self.path == "/search":
                    self._send(200, self._search(body))
                else:
                    self._fail(404, f"no such route: {self.path}")
            except BadRequest as e:
                self._fail(400, e)
            except Exception as e:  # loud 500 — the arm must never see a silent failure
                self._fail(500, e)

        def _add(self, body):
            user_id = body.get("user_id")
            messages = body.get("messages")
            if not user_id or not isinstance(user_id, str):
                raise BadRequest("user_id (non-empty string) is required")
            if not isinstance(messages, list) or not messages:
                raise BadRequest("messages (non-empty list of {role, content}) is required")
            for m in messages:
                if not isinstance(m, dict) or not m.get("role") or not isinstance(m.get("content"), str):
                    raise BadRequest("each message needs {role, content}")
            metadata = body.get("metadata") or {}
            question_id = str(metadata.get("question_id") or "unknown")
            session_index = int(metadata.get("session_index") or 0)
            # the per-session source_file is the provenance tag search hits
            # carry back (task 207); wing/room scope the run/question.
            source_file = f"bench/{question_id}/session_{session_index}.txt"
            drawer_id, chunks = state.runtime.add_session(
                wing=user_id,
                room=question_id,
                text=flatten_session(messages),
                source_file=source_file,
            )
            return {"ok": True, "drawer_id": drawer_id, "count": chunks}

        def _search(self, body):
            user_id = body.get("user_id")
            query = body.get("query")
            limit = body.get("limit")
            if not user_id or not isinstance(user_id, str):
                raise BadRequest("user_id (non-empty string) is required")
            if not query or not isinstance(query, str):
                raise BadRequest("query (non-empty string) is required")
            if not isinstance(limit, int) or limit <= 0:
                raise BadRequest("limit (positive int) is required — the retrieval budget is never defaulted")
            results, candidates = state.runtime.search(query, limit)
            return {
                "ok": True,
                "results": results,
                "count": len(results),
                "candidates_fetched": candidates,
            }

    return Handler


class Inflight:
    """Count of requests being served — lets a stop wait for the in-flight add."""

    def __init__(self):
        self.n = 0
        self.cv = threading.Condition()

    def __enter__(self):
        with self.cv:
            self.n += 1
        return self

    def __exit__(self, *exc):
        with self.cv:
            self.n -= 1
            self.cv.notify_all()
        return False

    def wait_zero(self, timeout_s):
        """True if the count reached 0 within the timeout."""
        deadline = time.monotonic() + timeout_s
        with self.cv:
            while self.n > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self.cv.wait(remaining)
        return True


def serve(state, port=0, host="127.0.0.1", inflight=None):
    """Bind, print the ready line, serve until terminated. Returns the server."""
    server = ThreadingHTTPServer((host, port), make_handler(state, inflight))
    import sys

    sys.stderr.write(f"MEMPALACE_SIDECAR_READY {server.server_address[1]}\n")
    sys.stderr.flush()
    return server


# How long a deferred stop waits for the in-flight add to commit before giving
# up — matched to the arm's per-request budget (30 min).
STOP_GRACE_S = 1800


def main(runtime_factory=None):
    """Run the sidecar until terminated. `runtime_factory` is the hermetic-test
    seam: tests drive the REAL signal protocol with a fake runtime whose add()
    blocks, proving the drain behaviour."""
    import signal
    import sys

    state = SidecarState(runtime_factory=runtime_factory)
    inflight = Inflight()
    server = serve(state, port=int(os.environ.get("MEMPALACE_SIDECAR_PORT") or 0), inflight=inflight)

    # Same stop semantics as the mem0/zep/letta sidecars: a stop CLOSES the
    # listener immediately (new connects get ECONNREFUSED, not hangs), lets the
    # in-flight request finish within STOP_GRACE_S, then exits. A SECOND signal
    # exits immediately.
    stopping = {"flag": False}

    def _deferred_stop(signum, frame):
        if stopping["flag"]:
            sys.stderr.write(f"[mempalace-sidecar] second stop signal — exiting now (pid {os.getpid()})\n")
            sys.stderr.flush()
            os._exit(0)
        stopping["flag"] = True
        sys.stderr.write(f"[mempalace-sidecar] SIGTERM/SIGINT received (pid {os.getpid()}) — closing listener, draining in-flight request, then exiting\n")
        sys.stderr.flush()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _deferred_stop)
    signal.signal(signal.SIGINT, _deferred_stop)

    try:
        server.serve_forever()
    finally:
        server.server_close()
        if stopping["flag"] and not inflight.wait_zero(STOP_GRACE_S):
            sys.stderr.write(f"[mempalace-sidecar] in-flight request did not finish within {STOP_GRACE_S}s — exiting anyway\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()

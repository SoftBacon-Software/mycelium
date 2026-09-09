#!/usr/bin/env python3
"""mem0_sidecar — local HTTP wrapper around Mem0 OSS for the memory benchmark.

The bench arms are JavaScript; Mem0 is Python. This sidecar runs Mem0's OSS
`Memory` against its local Qdrant store and exposes exactly four routes on
127.0.0.1 (never on a routable interface):

    GET  /health                 -> {ok, pid, mem0_version, llm{...}, embedder{...}, vector_store{...}}
    POST /add     {user_id, messages, metadata?}   -> Mem0 add()  (one POST per haystack session)
    POST /search  {query, user_id, limit}          -> {results: [{memory, score, ...}]}
    POST /delete_all {user_id}                     -> purge the scope

The Mem0 client is created lazily on first use, so /health works (and the
spawner can poll it) without the LLM/embedder endpoints being up.

Config comes from env vars only — the spawner (arm_mem0.mjs) resolves them from
env/substrate.conf; this file never hardcodes an address:

    MEM0_LLM_BASE_URL        OpenAI-compatible base (…/v1 on the 3090 box)
    MEM0_LLM_MODEL           default qwen3.8:27b — the SAME answerer the other arms use
    MEM0_LLM_API_KEY         sentinel for llama.cpp (default "unused")
    MEM0_EMBEDDER_BASE_URL   ollama on the platform host
    MEM0_EMBEDDER_MODEL      default nomic-embed-text (the model the Mycelium arm embeds with)
    MEM0_EMBEDDER_DIMS       768 for the Jetson's nomic-embed-text (mem0 assumes 512 — wrong here, measured)
    MEM0_STORE_PATH          per-run dir for the local Qdrant store + history DB
    MEM0_SIDECAR_PORT        0 = ephemeral (default)
    MEM0_MAX_LLM_TOKENS      mem0 extraction budget (default 4096 — thinking models spend it)

On startup it prints `MEM0_SIDECAR_READY <port>` to stderr (flushed) — that line
is the spawn handshake; the spawner polls /health afterwards.

Telemetry is force-disabled (MEM0_TELEMETRY=False before mem0 is imported): a
$0 clean-room arm does not phone home.

Hermetic testing: `make_handler(SidecarState(...))` accepts an injected
`memory_factory`, so test_mem0_sidecar.py drives the real HTTP surface with a
fake Mem0 client — no network beyond 127.0.0.1, no model calls.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

REQUIRED_ENV = [
    "MEM0_LLM_BASE_URL",
    "MEM0_LLM_MODEL",
    "MEM0_EMBEDDER_BASE_URL",
    "MEM0_EMBEDDER_MODEL",
    "MEM0_EMBEDDER_DIMS",
    "MEM0_STORE_PATH",
]

DEFAULTS = {
    "MEM0_LLM_API_KEY": "unused",
    "MEM0_MAX_LLM_TOKENS": "4096",
    "MEM0_SIDECAR_PORT": "0",
    "MEM0_VECTOR_STORE_PROVIDER": "qdrant",  # mem0 OSS default local store
    "MEM0_SEARCH_THRESHOLD": "0.1",  # mem0 OSS search default; stamped in the regime
}


def ensure_telemetry_off(env=None):
    """Disable mem0's PostHog telemetry before mem0 is imported."""
    (env if env is not None else os.environ)["MEM0_TELEMETRY"] = "False"


def config_from_env(env):
    """Env -> (mem0 MemoryConfig dict, facts dict). Raises ValueError listing what's missing."""
    missing = [k for k in REQUIRED_ENV if not env.get(k)]
    if missing:
        raise ValueError(f"mem0_sidecar missing required env: {', '.join(missing)}")
    merged = dict(DEFAULTS)
    for k in DEFAULTS:
        if env.get(k) is not None:
            merged[k] = env[k]
    for k in REQUIRED_ENV:
        merged[k] = env[k]

    dims = int(merged["MEM0_EMBEDDER_DIMS"])
    store_path = merged["MEM0_STORE_PATH"]
    config = {
        "llm": {
            "provider": "openai",  # OpenAI-COMPATIBLE endpoint (llama.cpp /v1), via mem0's openai provider
            "config": {
                "model": merged["MEM0_LLM_MODEL"],
                "openai_base_url": merged["MEM0_LLM_BASE_URL"],
                "api_key": merged["MEM0_LLM_API_KEY"],
                "temperature": 0,  # the harness answerer runs at temperature 0
                "max_tokens": int(merged["MEM0_MAX_LLM_TOKENS"]),
            },
        },
        "embedder": {
            "provider": "ollama",
            "config": {
                "model": merged["MEM0_EMBEDDER_MODEL"],
                "ollama_base_url": merged["MEM0_EMBEDDER_BASE_URL"],
                "embedding_dims": dims,
            },
        },
        "vector_store": {
            "provider": merged["MEM0_VECTOR_STORE_PROVIDER"],
            "config": {
                "path": store_path,
                "embedding_model_dims": dims,
            },
        },
        "history_db_path": os.path.join(store_path, "history.db"),
        "version": "v1.1",
    }
    facts = {
        "mem0_version": mem0_version(),
        "llm": {"model": merged["MEM0_LLM_MODEL"], "base_url_host": urlparse(merged["MEM0_LLM_BASE_URL"]).netloc},
        "embedder": {
            "model": merged["MEM0_EMBEDDER_MODEL"],
            "base_url_host": urlparse(merged["MEM0_EMBEDDER_BASE_URL"]).netloc,
            "dims": dims,
        },
        "vector_store": {"provider": merged["MEM0_VECTOR_STORE_PROVIDER"], "path": store_path},
        "search_threshold": float(merged["MEM0_SEARCH_THRESHOLD"]),
        "max_llm_tokens": int(merged["MEM0_MAX_LLM_TOKENS"]),
    }
    return config, facts


def mem0_version():
    """Installed mem0ai version from package metadata — no heavy mem0 import."""
    from importlib.metadata import version

    return version("mem0ai")


def default_memory_factory(config):
    """The real Mem0 client. Heavy import deferred to first use."""
    ensure_telemetry_off()
    from mem0 import Memory

    return Memory.from_config(config)


class SidecarState:
    """Env + the lazily-created Mem0 client. One per process."""

    def __init__(self, env=None, memory_factory=default_memory_factory):
        self.env = env if env is not None else os.environ
        self._factory = memory_factory
        self._memory = None
        self._lock = threading.Lock()
        self.config, self.facts = config_from_env(self.env)

    @property
    def memory(self):
        with self._lock:
            if self._memory is None:
                self._memory = self._factory(self.config)
            return self._memory


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

            sys.stderr.write("[mem0-sidecar] %s\n" % (fmt % args))
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
                self._send(200, {"ok": True, "pid": os.getpid(), **state.facts})
                return
            self._fail(404, f"no such route: {self.path}")

        def do_POST(self):
            try:
                body = _read_json(self)
                if self.path == "/add":
                    self._send(200, self._add(body))
                elif self.path == "/search":
                    self._send(200, self._search(body))
                elif self.path == "/delete_all":
                    self._send(200, self._delete_all(body))
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
            result = state.memory.add(messages, user_id=user_id, metadata=body.get("metadata"), infer=True)
            results = result.get("results", []) if isinstance(result, dict) else []
            return {"ok": True, "results": results, "count": len(results)}

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
            result = state.memory.search(
                query, top_k=limit, filters={"user_id": user_id}, threshold=state.facts["search_threshold"]
            )
            raw = result.get("results", []) if isinstance(result, dict) else []
            results = [
                {
                    "memory": r.get("memory"),
                    "score": r.get("score"),
                    "id": r.get("id"),
                    "created_at": r.get("created_at"),
                }
                for r in raw
            ]
            return {"ok": True, "results": results, "count": len(results)}

        def _delete_all(self, body):
            user_id = body.get("user_id")
            if not user_id or not isinstance(user_id, str):
                raise BadRequest("user_id (non-empty string) is required")
            state.memory.delete_all(user_id=user_id)
            return {"ok": True, "user_id": user_id}

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

    sys.stderr.write(f"MEM0_SIDECAR_READY {server.server_address[1]}\n")
    sys.stderr.flush()
    return server


# How long a deferred stop waits for the in-flight add to commit before giving
# up — matched to the arm's per-request budget (30 min).
STOP_GRACE_S = 1800


def main(memory_factory=default_memory_factory):
    """Run the sidecar until terminated. `memory_factory` is the hermetic-test
    seam (same one make_handler takes): tests drive the REAL signal protocol
    with a fake Mem0 client whose add() blocks, proving the drain behaviour."""
    import signal
    import sys
    import threading
    import time

    state = SidecarState(memory_factory=memory_factory)
    inflight = Inflight()
    server = serve(state, port=int(os.environ.get("MEM0_SIDECAR_PORT") or 0), inflight=inflight)

    # A SIGTERM mid-add would drop the client's connection with no way to know
    # whether the add committed — a replay could duplicate facts. So a stop
    # CLOSES the listener immediately (the death is visible: new connects get
    # ECONNREFUSED, not hangs), lets the in-flight request finish within
    # STOP_GRACE_S, then exits. (The spawner's stop() escalates to SIGKILL on
    # its own 15 s timeout, so clean teardown never waits on the grace.) An
    # unknown external SIGTERM killed the sidecar mid-run once (2026-09-09, 47
    # min into a smoke) — this makes even that case leave a recoverable store.
    stopping = {"flag": False}

    def _deferred_stop(signum, frame):
        if stopping["flag"]:
            sys.stderr.write(f"[mem0-sidecar] second stop signal — exiting now (pid {os.getpid()})\n")
            sys.stderr.flush()
            os._exit(0)
        stopping["flag"] = True
        sys.stderr.write(f"[mem0-sidecar] SIGTERM/SIGINT received (pid {os.getpid()}) — closing listener, draining in-flight request, then exiting\n")
        sys.stderr.flush()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _deferred_stop)
    signal.signal(signal.SIGINT, _deferred_stop)

    try:
        server.serve_forever()
    finally:
        server.server_close()
        if stopping["flag"] and not inflight.wait_zero(STOP_GRACE_S):
            sys.stderr.write(f"[mem0-sidecar] in-flight request did not finish within {STOP_GRACE_S}s — exiting anyway\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()

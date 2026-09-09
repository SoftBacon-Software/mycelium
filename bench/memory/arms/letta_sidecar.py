#!/usr/bin/env python3
"""letta_sidecar — local HTTP wrapper around an OSS Letta server for the memory
benchmark.

The bench arms are JavaScript; Letta is Python. This sidecar fronts Letta's
OSS server over the official `letta-client` SDK and exposes exactly four routes
on 127.0.0.1 (never on a routable interface):

    GET  /health   -> {ok, pid, letta_version, letta_client_version,
                       server{url_host, version}, llm{...}, embedder{...},
                       agent{id}, storage}
    POST /add      {user_id, messages, metadata?}  -> ONE archival passage per
                                                      haystack session (the whole
                                                      session flattened to text)
    POST /search   {query, user_id, limit}         -> {results: [{memory, score,
                                                       id, created_at}]}
    POST /delete_all {user_id}                     -> DELETE the run's Letta agent
                                                      (its archival memory with it)

Unlike the mem0/zep sidecars this one holds NO local store: the current OSS
Letta server cannot run without a PostgreSQL+pgvector server (evidence in
letta-requirements.txt), and installing a database server is a director
decision (lane rule). So the store under test is an already-running Letta
server, addressed via LETTA_SERVER_URL — and /health FAILS (ok=false) when that
server does not answer: an arm whose memory system is unreachable must not
boot, unlike mem0/zep where the store is local and always present.

The Letta agent is created lazily on first add/search (include_base_tools off,
no core memory blocks — this benchmark exercises archival memory only; the
final answer is the SAME shared answerer chat as the other arms, driven by
arm_letta.mjs). The agent's LLM/embedder configs point at the SAME endpoints
the other arms use, so the configs are stamped and comparable even though the
agent loop itself never runs.

Config comes from env vars only — the spawner (arm_letta.mjs) resolves them
from env/substrate.conf; this file never hardcodes an address:

    LETTA_SERVER_URL         the Letta server under test (required, no default)
    LETTA_LLM_BASE_URL       OpenAI-compatible base (…/v1 on the 3090 box)
    LETTA_LLM_MODEL          default qwen3.8:27b — the SAME answerer the other arms use
    LETTA_LLM_API_KEY        sentinel for llama.cpp (default "unused")
    LETTA_MAX_LLM_TOKENS     default 4096 (stamped into the agent config)
    LETTA_EMBEDDER_BASE_URL  ollama on the platform host
    LETTA_EMBEDDER_MODEL     default nomic-embed-text (the model the other arms embed with)
    LETTA_EMBEDDER_DIMS      768 for the platform host's nomic-embed-text (measured)
    LETTA_SIDECAR_PORT       0 = ephemeral (default)
    LETTA_CLIENT_API_KEY     sentinel sent as the SDK api key (default "unused")
    LETTA_STATE_FILE         optional — where the run's agent id is persisted
                             (a restarted/resumed sidecar reattaches to the
                             same agent; default: in-process only)

On startup it prints `LETTA_SIDECAR_READY <port>` to stderr (flushed) — that
line is the spawn handshake; the spawner polls /health afterwards.

Hermetic testing: `make_handler(SidecarState(...))` accepts an injected
`client_factory`, so test_letta_sidecar.py drives the real HTTP surface with a
fake Letta client — no network beyond 127.0.0.1, no letta_client import.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

REQUIRED_ENV = [
    "LETTA_SERVER_URL",
    "LETTA_LLM_BASE_URL",
    "LETTA_EMBEDDER_BASE_URL",
]

DEFAULTS = {
    "LETTA_LLM_MODEL": "qwen3.8:27b",  # the answerer default in run.mjs
    "LETTA_LLM_API_KEY": "unused",
    "LETTA_MAX_LLM_TOKENS": "4096",
    "LETTA_EMBEDDER_MODEL": "nomic-embed-text",  # the platform's embedder
    "LETTA_EMBEDDER_DIMS": "768",  # measured on the platform host's ollama
    "LETTA_SIDECAR_PORT": "0",
    "LETTA_CLIENT_API_KEY": "unused",
}

# The OSS server version this arm benchmarks (mirrors letta-requirements.txt).
# /health records the version the SERVER actually reports; a mismatch lands in
# the facts as `letta_version_matches: false` rather than a refusal — the
# director may point the bench at a different pinned server deliberately.
LETTA_VERSION_UNDER_TEST = "0.16.8"

STORAGE_NOTE = (
    "letta server archival memory (external) — OSS letta 0.16.8 requires a "
    "PostgreSQL+pgvector server; the [sqlite] extra ships but is non-functional "
    "(asyncpg is a hard ORM import and db.py has no sqlite branch), so no "
    "embedded store exists. Evidence in letta-requirements.txt."
)


def letta_client_version():
    """Installed letta-client version from package metadata — 'not-installed'
    keeps config_from_env (and the hermetic tests) working on any python3."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("letta-client")
    except PackageNotFoundError:
        return "not-installed"


def config_from_env(env):
    """Env -> (client kwargs, agent configs, facts). Raises ValueError listing
    what's missing."""
    missing = [k for k in REQUIRED_ENV if not env.get(k)]
    if missing:
        raise ValueError(f"letta_sidecar missing required env: {', '.join(missing)}")
    merged = dict(DEFAULTS)
    for k in DEFAULTS:
        if env.get(k) is not None:
            merged[k] = env[k]
    for k in REQUIRED_ENV:
        merged[k] = env[k]

    dims = int(merged["LETTA_EMBEDDER_DIMS"])
    server_url = merged["LETTA_SERVER_URL"].rstrip("/")
    client_kwargs = {
        "base_url": server_url,
        "api_key": merged["LETTA_CLIENT_API_KEY"],
    }
    llm_config = {
        "model": merged["LETTA_LLM_MODEL"],
        "model_endpoint_type": "openai",  # OpenAI-COMPATIBLE endpoint (llama.cpp /v1)
        "model_endpoint": merged["LETTA_LLM_BASE_URL"].rstrip("/"),
        "context_window": 32768,  # the qwen3.8:27b seat on llama.cpp (one 64k slot; 32k context)
        "max_tokens": int(merged["LETTA_MAX_LLM_TOKENS"]),
    }
    embedding_config = {
        "embedding_endpoint_type": "ollama",
        "embedding_endpoint": merged["LETTA_EMBEDDER_BASE_URL"].rstrip("/"),
        "embedding_model": merged["LETTA_EMBEDDER_MODEL"],
        "embedding_dim": dims,
        "embedding_chunk_size": 300,  # letta's default; unused on the passages path (no chunking)
    }
    facts = {
        "letta_version_under_test": LETTA_VERSION_UNDER_TEST,
        "letta_client_version": letta_client_version(),
        "server": {"url_host": urlparse(server_url).netloc},
        "llm": {"model": merged["LETTA_LLM_MODEL"], "base_url_host": urlparse(merged["LETTA_LLM_BASE_URL"]).netloc},
        "embedder": {
            "model": merged["LETTA_EMBEDDER_MODEL"],
            "base_url_host": urlparse(merged["LETTA_EMBEDDER_BASE_URL"]).netloc,
            "dims": dims,
        },
        "storage": STORAGE_NOTE,
    }
    return client_kwargs, llm_config, embedding_config, facts


def default_client_factory(client_kwargs):
    """The real letta_client. Import deferred to first use."""
    from letta_client import Letta

    return Letta(**client_kwargs)


class LettaRuntime:
    """The lazily-created letta client + the run's agent. Created on first use;
    /health probes the server (a down store fails the boot gate) but does NOT
    create the agent — creation needs nothing from the server until first add,
    but keeping /health side-effect-free apart from the probe makes it
    pollable.

    `state_file` (LETTA_STATE_FILE, optional) persists the run's agent id so a
    RESTARTED sidecar (mid-run crash — the arm restarts only on ECONNREFUSED)
    or a RESUMED run reattaches to the same agent instead of lazily creating a
    second one and silently forking the run's memory. Without it the agent is
    per-process only (what the hermetic tests exercise)."""

    def __init__(self, client_kwargs, llm_config, embedding_config, client_factory=default_client_factory, state_file=None):
        self._client_kwargs = client_kwargs
        self._llm_config = llm_config
        self._embedding_config = embedding_config
        self._factory = client_factory
        self._state_file = state_file
        self._client = None
        self._agent_id = None
        self._lock = threading.Lock()

    @property
    def client(self):
        with self._lock:
            if self._client is None:
                self._client = self._factory(self._client_kwargs)
            return self._client

    def probe_server(self):
        """GET /v1/health on the letta server -> reported version. Raises on
        connection failure (the caller turns that into /health ok=false)."""
        return self.client.health().version

    def _read_prior_agent(self):
        if not self._state_file:
            return None
        try:
            with open(self._state_file, encoding="utf8") as f:
                return json.load(f).get("agent_id")
        except (OSError, ValueError):
            return None

    def _write_agent_state(self, agent_id):
        if not self._state_file:
            return
        try:
            d = os.path.dirname(self._state_file)
            if d:
                os.makedirs(d, exist_ok=True)
            with open(self._state_file, "w", encoding="utf8") as f:
                json.dump({"agent_id": agent_id}, f)
        except OSError:
            pass  # persistence is best-effort; in-process identity still works

    def _clear_agent_state(self):
        if not self._state_file:
            return
        try:
            os.unlink(self._state_file)
        except OSError:
            pass

    def ensure_agent(self):
        """The run's agent — reattached from LETTA_STATE_FILE when one was
        persisted (retrieve; a missing/deleted agent falls back to create),
        else created once. Archival-only (no base tools, no core memory
        blocks: the benchmark never runs the agent loop). Builds the client
        inline rather than via the `client` property: Lock is not reentrant
        and the property takes the same lock."""
        with self._lock:
            if self._agent_id is None:
                if self._client is None:
                    self._client = self._factory(self._client_kwargs)
                agent = None
                prior = self._read_prior_agent()
                if prior:
                    try:
                        agent = self._client.agents.retrieve(prior)  # reattach — the store survives the sidecar
                    except Exception:
                        agent = None  # gone (or server flapped): create fresh, loudly, below
                if agent is None:
                    agent = self._client.agents.create(
                        llm_config=self._llm_config,
                        embedding_config=self._embedding_config,
                        memory_blocks=[],
                        include_base_tools=False,
                    )
                self._agent_id = agent.id
                self._write_agent_state(self._agent_id)
            return self._agent_id

    def insert_passage(self, text, tags):
        agent_id = self.ensure_agent()
        created = self.client.agents.passages.create(agent_id, text=text, tags=tags)
        return agent_id, len(created)

    def search_passages(self, query, limit):
        agent_id = self.ensure_agent()
        items = self.client.agents.passages.search(agent_id, query=query, top_k=limit)
        results = [
            {
                "memory": item.passage.text,
                "score": item.score,
                "id": item.passage.id,
                "created_at": item.passage.created_at.isoformat() if item.passage.created_at else None,
            }
            for item in items
        ]
        return agent_id, results

    def delete_agent(self):
        """Teardown: the run's agent IS the store — deleting it purges the
        scope (and the persisted identity). Idempotent (no agent yet ->
        nothing to delete)."""
        with self._lock:
            agent_id = self._agent_id
            self._agent_id = None
        if agent_id is None:
            self._clear_agent_state()
            return None
        self.client.agents.delete(agent_id)
        self._clear_agent_state()
        return agent_id


class SidecarState:
    """Env + the lazily-created letta runtime. One per process."""

    def __init__(self, env=None, client_factory=default_client_factory):
        self.env = env if env is not None else os.environ
        self._factory = client_factory
        self._runtime = None
        self._lock = threading.Lock()
        self.state_file = self.env.get("LETTA_STATE_FILE") or None
        self.client_kwargs, self.llm_config, self.embedding_config, self.facts = config_from_env(self.env)

    @property
    def runtime(self):
        with self._lock:
            if self._runtime is None:
                self._runtime = LettaRuntime(
                    self.client_kwargs,
                    self.llm_config,
                    self.embedding_config,
                    client_factory=self._factory,
                    state_file=self.state_file,
                )
            return self._runtime


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


def flatten_session(messages):
    """The session's turns -> one text. ONE passage per haystack session (the
    analogue of the other arms' one memory row per session; letta's passages
    API does not chunk)."""
    return "\n".join(f"{m['role']}: {m['content']}" for m in messages)


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

            sys.stderr.write("[letta-sidecar] %s\n" % (fmt % args))
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
                try:
                    # the store is REMOTE: probe it. A down letta server fails
                    # the boot gate (ok=false) — the spawner must not start a
                    # run whose memory system is unreachable.
                    server_version = state.runtime.probe_server()
                    self._send(
                        200,
                        {
                            "ok": True,
                            "pid": os.getpid(),
                            "letta_version": server_version,
                            "letta_version_matches": server_version == state.facts["letta_version_under_test"],
                            "agent_id": state.runtime._agent_id,
                            **state.facts,
                        },
                    )
                except Exception as e:
                    self._send(
                        200,
                        {
                            "ok": False,
                            "pid": os.getpid(),
                            "error": f"letta server unreachable at {state.facts['server']['url_host']}: {e}",
                            **state.facts,
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
            metadata = body.get("metadata") or {}
            tags = [
                user_id,
                "bench:longmemeval",
                f"question_id:{metadata.get('question_id')}",
                f"session_index:{metadata.get('session_index')}",
            ]
            agent_id, count = state.runtime.insert_passage(flatten_session(messages), tags)
            return {"ok": True, "agent_id": agent_id, "count": count}

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
            agent_id, results = state.runtime.search_passages(query, limit)
            return {"ok": True, "agent_id": agent_id, "results": results, "count": len(results)}

        def _delete_all(self, body):
            user_id = body.get("user_id")
            if not user_id or not isinstance(user_id, str):
                raise BadRequest("user_id (non-empty string) is required")
            deleted = state.runtime.delete_agent()
            return {"ok": True, "user_id": user_id, "deleted_agent": deleted}

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

    sys.stderr.write(f"LETTA_SIDECAR_READY {server.server_address[1]}\n")
    sys.stderr.flush()
    return server


# How long a deferred stop waits for the in-flight add to commit before giving
# up — matched to the arm's per-request budget (30 min).
STOP_GRACE_S = 1800


def main(client_factory=default_client_factory):
    """Run the sidecar until terminated. `client_factory` is the hermetic-test
    seam: tests drive the REAL signal protocol with a fake Letta client whose
    create() blocks, proving the drain behaviour."""
    import signal
    import sys
    import threading

    state = SidecarState(client_factory=client_factory)
    inflight = Inflight()
    server = serve(state, port=int(os.environ.get("LETTA_SIDECAR_PORT") or 0), inflight=inflight)

    # Same stop semantics as the mem0/zep sidecars: a stop CLOSES the listener
    # immediately (new connects get ECONNREFUSED, not hangs), lets the
    # in-flight request finish within STOP_GRACE_S, then exits. A SECOND signal
    # exits immediately.
    stopping = {"flag": False}

    def _deferred_stop(signum, frame):
        if stopping["flag"]:
            sys.stderr.write(f"[letta-sidecar] second stop signal — exiting now (pid {os.getpid()})\n")
            sys.stderr.flush()
            os._exit(0)
        stopping["flag"] = True
        sys.stderr.write(f"[letta-sidecar] SIGTERM/SIGINT received (pid {os.getpid()}) — closing listener, draining in-flight request, then exiting\n")
        sys.stderr.flush()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _deferred_stop)
    signal.signal(signal.SIGINT, _deferred_stop)

    try:
        server.serve_forever()
    finally:
        server.server_close()
        if stopping["flag"] and not inflight.wait_zero(STOP_GRACE_S):
            sys.stderr.write(f"[letta-sidecar] in-flight request did not finish within {STOP_GRACE_S}s — exiting anyway\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()

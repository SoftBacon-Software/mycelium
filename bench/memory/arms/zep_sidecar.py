#!/usr/bin/env python3
"""zep_sidecar — local HTTP wrapper around Graphiti OSS (Zep's open-source graph
memory) for the memory benchmark.

The bench arms are JavaScript; Graphiti is Python. This sidecar runs Graphiti
against its embedded Kuzu graph store and exposes exactly four routes on
127.0.0.1 (never on a routable interface):

    GET  /health   -> {ok, pid, graphiti_version, kuzu_version, llm{...}, embedder{...},
                       graph_store{...}, search{...}, telemetry}
    POST /add      {user_id, messages, metadata?}  -> one Graphiti episode (one POST per
                                                      haystack session, extraction via the LLM)
    POST /search   {query, user_id, limit}         -> {results: [{memory (the fact), score,
                                                      id, created_at}]}
    POST /delete_all {user_id}                     -> purge the scope (group_id) from the graph

The Graphiti client is created lazily on first use, so /health works (and the
spawner can poll it) without the LLM/embedder endpoints being up.

Config comes from env vars only — the spawner (arm_zep.mjs) resolves them from
env/substrate.conf; this file never hardcodes an address:

    ZEP_LLM_BASE_URL        OpenAI-compatible base (…/v1 on the 3090 box) — the extraction LLM
    ZEP_LLM_MODEL           default qwen3.8:27b — the SAME answerer model the other arms use
    ZEP_LLM_API_KEY         sentinel for llama.cpp (default "unused")
    ZEP_MAX_LLM_TOKENS      default 16384 — Graphiti's own default for local models
    ZEP_EMBEDDER_BASE_URL   OpenAI-compatible embeddings base — the platform host's ollama /v1
    ZEP_EMBEDDER_MODEL      default nomic-embed-text (the model the mycelium + mem0 arms embed with)
    ZEP_EMBEDDER_DIMS       768 for the platform host's nomic-embed-text (measured)
    ZEP_STORE_PATH          per-run dir holding the embedded Kuzu graph database
    ZEP_SIDECAR_PORT        0 = ephemeral (default)

On startup it prints `ZEP_SIDECAR_READY <port>` to stderr (flushed) — that line
is the spawn handshake; the spawner polls /health afterwards.

What Graphiti is configured with, and why (each choice is stamped into the
regime via /health):

  - LLM  = OpenAIGenericClient (Graphiti's client for OpenAI-compatible
    endpoints; its docs name llama.cpp explicitly) against the same qwen3.8:27b
    endpoint the other arms answer with. json_schema structured output (the
    default) — llama.cpp enforces it by constrained decoding.
  - Embedder = OpenAIEmbedder against the platform host's ollama /v1 — the SAME
    embedder model (nomic-embed-text, 768 dims) the mycelium and mem0 arms use.
    graphiti-core has no ollama embedder class; ollama's OpenAI-compatible
    /v1/embeddings makes that irrelevant.
  - Graph store = KuzuDriver, embedded and dockerless (a file-backed kuzu
    database, no server). ⚠ graphiti-core marks the Kuzu backend deprecated
    (upstream kuzu unmaintained); it is the ONLY embedded store graphiti-core
    ships — the alternatives are Neo4j / FalkorDB SERVERS, which this harness
    does not install. The deprecation is stamped into the regime.
  - Search = graphiti.search(), whose default config is EDGE_HYBRID_SEARCH_RRF
    (bm25 + cosine similarity fused by RRF) — Graphiti's out-of-the-box search,
    with NO LLM reranker. Graphiti's default cross-encoder
    (OpenAIRerankerClient) would add one boolean LLM call per fact per query and
    hardcodes OpenAI-tokenizer logit_bias (token ids 6432/7983 = "True"/"False"
    in cl100k — wrong for a qwen tokenizer) with max_tokens=1, which a thinking
    model burns on its reasoning open. RRF is a first-class Graphiti recipe, so
    the cross-encoder is a no-op that exists only to satisfy Graphiti's
    constructor without demanding an OPENAI_API_KEY.
  - Telemetry force-disabled (GRAPHITI_TELEMETRY_ENABLED=false before the
    import): a $0 clean-room arm does not phone home (PostHog ships as a
    hard dependency).

Hermetic testing: `make_handler(SidecarState(...))` accepts an injected
`client_factory`, so test_zep_sidecar.py drives the real HTTP surface with a
fake Graphiti client — no network beyond 127.0.0.1, no model calls, no
graphiti-core import.
"""

import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

REQUIRED_ENV = [
    "ZEP_LLM_BASE_URL",
    "ZEP_LLM_MODEL",
    "ZEP_EMBEDDER_BASE_URL",
    "ZEP_EMBEDDER_MODEL",
    "ZEP_EMBEDDER_DIMS",
    "ZEP_STORE_PATH",
]

DEFAULTS = {
    "ZEP_LLM_API_KEY": "unused",
    "ZEP_MAX_LLM_TOKENS": "16384",  # Graphiti's own default for local models
    "ZEP_SIDECAR_PORT": "0",
}

# Search recipe + reranker posture, as surfaced by /health and the regime stamp.
SEARCH_RECIPE = "graphiti.search default = EDGE_HYBRID_SEARCH_RRF (bm25 + cosine, RRF; no LLM reranker)"
CROSS_ENCODER = "none (no-op required by Graphiti's constructor; RRF search never calls it)"

GRAPH_STORE_NOTE = (
    "embedded kuzu database (dockerless, file-backed) — graphiti-core marks the kuzu "
    "backend deprecated (upstream kuzu unmaintained); the alternatives are Neo4j/FalkorDB "
    "SERVERS, which this harness does not install"
)


def ensure_telemetry_off(env=None):
    """Disable Graphiti's PostHog telemetry before graphiti_core is imported."""
    (env if env is not None else os.environ)["GRAPHITI_TELEMETRY_ENABLED"] = "false"


def graphiti_version():
    """Installed graphiti-core version from package metadata — 'not-installed' keeps
    config_from_env (and the hermetic tests) working on any python3."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("graphiti-core")
    except PackageNotFoundError:
        return "not-installed"


def kuzu_version():
    """Installed kuzu version — same fallback discipline as graphiti_version()."""
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("kuzu")
    except PackageNotFoundError:
        return "not-installed"


def config_from_env(env):
    """Env -> (client config dict, facts dict). Raises ValueError listing what's missing."""
    missing = [k for k in REQUIRED_ENV if not env.get(k)]
    if missing:
        raise ValueError(f"zep_sidecar missing required env: {', '.join(missing)}")
    merged = dict(DEFAULTS)
    for k in DEFAULTS:
        if env.get(k) is not None:
            merged[k] = env[k]
    for k in REQUIRED_ENV:
        merged[k] = env[k]

    dims = int(merged["ZEP_EMBEDDER_DIMS"])
    store_path = merged["ZEP_STORE_PATH"]
    config = {
        "llm": {
            "base_url": merged["ZEP_LLM_BASE_URL"],  # OpenAI-COMPATIBLE endpoint (llama.cpp /v1)
            "api_key": merged["ZEP_LLM_API_KEY"],
            "model": merged["ZEP_LLM_MODEL"],
            "max_tokens": int(merged["ZEP_MAX_LLM_TOKENS"]),
        },
        "embedder": {
            "base_url": merged["ZEP_EMBEDDER_BASE_URL"],  # ollama's OpenAI-compatible /v1
            "api_key": "unused",
            "model": merged["ZEP_EMBEDDER_MODEL"],
            "dims": dims,
        },
        "graph_store": {"provider": "kuzu-embedded", "path": store_path},
    }
    facts = {
        "graphiti_version": graphiti_version(),
        "kuzu_version": kuzu_version(),
        "llm": {"model": merged["ZEP_LLM_MODEL"], "base_url_host": urlparse(merged["ZEP_LLM_BASE_URL"]).netloc,
                "max_tokens": int(merged["ZEP_MAX_LLM_TOKENS"])},
        "embedder": {
            "model": merged["ZEP_EMBEDDER_MODEL"],
            "base_url_host": urlparse(merged["ZEP_EMBEDDER_BASE_URL"]).netloc,
            "dims": dims,
        },
        "graph_store": {"provider": "kuzu-embedded", "path": store_path, "deprecated_upstream": True,
                        "note": GRAPH_STORE_NOTE},
        "search": {"recipe": SEARCH_RECIPE, "cross_encoder": CROSS_ENCODER,
                   "budget": "per-request num_results (the harness retrieval budget)"},
        "telemetry": "disabled (GRAPHITI_TELEMETRY_ENABLED=false before import)",
    }
    return config, facts


class NoopCrossEncoder:
    """Graphiti's constructor requires a cross-encoder; its default
    (OpenAIRerankerClient) demands an OPENAI_API_KEY at construction and, if
    used, makes one boolean LLM call per fact with OpenAI-tokenizer logit_bias.
    This arm's search path is graphiti.search() — EDGE_HYBRID_SEARCH_RRF — which
    never calls the cross-encoder. rank() preserves input order so that, if some
    future code path does call it, the behaviour stays defined (and countable
    in a test) rather than becoming a network call.

    This base class is deliberately graphiti-free so the hermetic unittest can
    import it; default_client_factory binds the real ABC (GraphitiClients
    validates cross_encoder by isinstance — measured: a bare object is refused
    with a pydantic ValidationError)."""

    def __init__(self):
        self.calls = 0

    async def rank(self, query, passages):
        self.calls += 1
        return [(p, 1.0) for p in passages]


def default_client_factory(config):
    """The real Graphiti client. Heavy import deferred to first use. The kuzu
    DeprecationWarning is NOT suppressed — it prints to stderr once, the spawner
    forwards it into the run log, and the regime stamps it."""
    ensure_telemetry_off()
    from graphiti_core import Graphiti
    from graphiti_core.cross_encoder.client import CrossEncoderClient
    from graphiti_core.driver.kuzu_driver import KuzuDriver
    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient

    class RrfNoopCrossEncoder(NoopCrossEncoder, CrossEncoderClient):
        """NoopCrossEncoder bound to Graphiti's own ABC — satisfies the
        GraphitiClients isinstance validation while keeping the local no-op
        rank()."""

    llm, emb, store = config["llm"], config["embedder"], config["graph_store"]
    # ZEP_STORE_PATH is the per-run store DIRECTORY (the run unit the spawner
    # purges); kuzu gets a database path of its own inside it — kuzu.Database
    # refuses to open a pre-made directory and creates/opens `<store>/graph` on
    # first use (measured: an empty mkdir'd dir → "Database path cannot be a
    # directory").
    driver = KuzuDriver(db=os.path.join(store["path"], "graph"))
    return Graphiti(
        graph_driver=driver,
        llm_client=OpenAIGenericClient(
            config=LLMConfig(
                api_key=llm["api_key"],
                model=llm["model"],
                base_url=llm["base_url"],
                temperature=0,  # the harness answerer runs at temperature 0
                max_tokens=llm["max_tokens"],
                small_model=llm["model"],  # one model: the same endpoint serves both roles
            )
        ),
        embedder=OpenAIEmbedder(
            config=OpenAIEmbedderConfig(
                api_key=emb["api_key"],
                base_url=emb["base_url"],
                embedding_model=emb["model"],
                embedding_dim=emb["dims"],
            )
        ),
        cross_encoder=RrfNoopCrossEncoder(),
    )


class LoopRunner:
    """One background asyncio loop for the life of the process.

    Graphiti is async; the stdlib HTTP server is threaded. Every async call is
    submitted to this single loop and awaited — which also keeps the kuzu
    AsyncConnection (created on this loop) usable for every request, instead of
    betting that it survives being driven from a different event loop per
    request."""

    def __init__(self):
        import asyncio

        self._asyncio = asyncio
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True, name="zep-sidecar-asyncio")
        self._thread.start()

    def run(self, coro, timeout_s):
        import concurrent.futures

        future = self._asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout=timeout_s)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise TimeoutError(f"graphiti call exceeded {timeout_s}s") from None


# How long one /add (a full LLM extraction over a haystack session) may take —
# matched to the arm's per-request budget (30 min). Same bound applies to
# /search (one hybrid query, embeddings included) and client bootstrap.
REQUEST_TIMEOUT_S = 1800


class SidecarState:
    """Env + the lazily-created Graphiti client + the loop it runs on. One per process."""

    def __init__(self, env=None, client_factory=default_client_factory):
        self.env = env if env is not None else os.environ
        self._factory = client_factory
        self._client = None
        self._lock = threading.Lock()
        self.loops = LoopRunner()
        self.config, self.facts = config_from_env(self.env)

    @property
    def client(self):
        with self._lock:
            if self._client is None:
                client = self._factory(self.config)
                # Graphiti init on kuzu: create the FTS indices the bm25 search
                # method needs. Once, before first use, on the loop.
                self.loops.run(client.build_indices_and_constraints(), REQUEST_TIMEOUT_S)
                self._client = client
            return self._client


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


def _validate_scope_and_messages(body):
    user_id = body.get("user_id")
    if not user_id or not isinstance(user_id, str):
        raise BadRequest("user_id (non-empty string) is required")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise BadRequest("messages (non-empty list of {role, content}) is required")
    for m in messages:
        if not isinstance(m, dict) or not m.get("role") or not isinstance(m.get("content"), str):
            raise BadRequest("each message needs {role, content}")
    return user_id, messages


# The labels that carry a group_id in the kuzu schema — the same set graphiti's
# own kuzu delete walks (its RelatesToNode_ intermediates model entity edges,
# because kuzu cannot fulltext-index edge properties).
GROUPED_LABELS = ["RelatesToNode_", "Entity", "Episodic", "Community", "Saga"]


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

            sys.stderr.write("[zep-sidecar] %s\n" % (fmt % args))
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
            user_id, messages = _validate_scope_and_messages(body)
            metadata = body.get("metadata") or {}
            if not isinstance(metadata, dict):
                raise BadRequest("metadata (when present) must be an object")
            qid = metadata.get("question_id")
            idx = metadata.get("session_index")
            name = f"{qid}-s{idx}" if qid is not None and idx is not None else f"session-{uuid.uuid4()}"
            episode_body = "\n".join(f"{m['role']}: {m['content']}" for m in messages)
            import sys

            t0 = time.time()
            # `source` is left at Graphiti's own signature default
            # (EpisodeType.message — right for chat sessions) and the type is
            # never imported here: with the hermetic fake factory the handler
            # must run with graphiti-core absent.
            result = state.loops.run(
                state.client.add_episode(
                    name=name,
                    episode_body=episode_body,
                    source_description="bench longmemeval haystack session",
                    reference_time=datetime.now(timezone.utc),
                    group_id=user_id,
                ),
                REQUEST_TIMEOUT_S,
            )
            edges = list(getattr(result, "edges", []) or [])
            # Graphiti episodes carry no metadata table: bench provenance lives in
            # the episode name (question-session) and the arm's checkpoint files.
            print(
                f"[zep-sidecar] add {name}: {len(edges)} facts extracted in {time.time() - t0:.1f}s",
                file=sys.stderr,
                flush=True,
            )
            return {"ok": True, "episode": name, "count": len(edges)}

        def _search(self, body):
            user_id = body.get("user_id")
            if not user_id or not isinstance(user_id, str):
                raise BadRequest("user_id (non-empty string) is required")
            query = body.get("query")
            if not query or not isinstance(query, str):
                raise BadRequest("query (non-empty string) is required")
            limit = body.get("limit")
            if not isinstance(limit, int) or limit <= 0:
                raise BadRequest("limit (positive int) is required — the retrieval budget is never defaulted")
            edges = state.loops.run(
                state.client.search(query, group_ids=[user_id], num_results=limit), REQUEST_TIMEOUT_S
            )
            results = [
                {
                    "memory": e.fact,
                    "score": None,  # RRF returns a ranked list; graphiti.search() exposes no scores
                    "id": e.uuid,
                    "created_at": e.created_at.isoformat() if getattr(e, "created_at", None) else None,
                }
                for e in edges
            ]
            return {"ok": True, "results": results, "count": len(results)}

        def _delete_all(self, body):
            user_id = body.get("user_id")
            if not user_id or not isinstance(user_id, str):
                raise BadRequest("user_id (non-empty string) is required")
            client = state.client

            async def _purge():
                conn = client.driver.client  # the kuzu AsyncConnection the driver was built on
                for label in GROUPED_LABELS:
                    await conn.execute(
                        f"MATCH (n:{label}) WHERE n.group_id IN $group_ids DETACH DELETE n",
                        {"group_ids": [user_id]},
                    )

            state.loops.run(_purge(), REQUEST_TIMEOUT_S)
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

    sys.stderr.write(f"ZEP_SIDECAR_READY {server.server_address[1]}\n")
    sys.stderr.flush()
    return server


# How long a deferred stop waits for the in-flight add to commit before giving
# up — matched to the arm's per-request budget (30 min).
STOP_GRACE_S = 1800


def main(client_factory=default_client_factory):
    """Run the sidecar until terminated. `client_factory` is the hermetic-test
    seam (same one make_handler takes via SidecarState): tests drive the REAL
    signal protocol with a fake Graphiti client whose add_episode blocks,
    proving the drain behaviour."""
    import signal
    import sys
    import threading

    state = SidecarState(client_factory=client_factory)
    inflight = Inflight()
    server = serve(state, port=int(os.environ.get("ZEP_SIDECAR_PORT") or 0), inflight=inflight)

    # Same two-stage stop the mem0 sidecar honours: a SIGTERM mid-add would drop
    # the client's connection with no way to know whether the episode committed —
    # a replay could duplicate facts. So the stop CLOSES the listener immediately
    # (the death is visible: new connects get ECONNREFUSED, not hangs), lets the
    # in-flight request finish within STOP_GRACE_S, then exits. A SECOND signal
    # exits now — teardown need not wait out a 30-minute extraction.
    stopping = {"flag": False}

    def _deferred_stop(signum, frame):
        if stopping["flag"]:
            sys.stderr.write(f"[zep-sidecar] second stop signal — exiting now (pid {os.getpid()})\n")
            sys.stderr.flush()
            os._exit(0)
        stopping["flag"] = True
        sys.stderr.write(f"[zep-sidecar] SIGTERM/SIGINT received (pid {os.getpid()}) — closing listener, draining in-flight request, then exiting\n")
        sys.stderr.flush()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _deferred_stop)
    signal.signal(signal.SIGINT, _deferred_stop)

    try:
        server.serve_forever()
    finally:
        server.server_close()
        if stopping["flag"] and not inflight.wait_zero(STOP_GRACE_S):
            sys.stderr.write(f"[zep-sidecar] in-flight request did not finish within {STOP_GRACE_S}s — exiting anyway\n")
            sys.stderr.flush()


if __name__ == "__main__":
    main()

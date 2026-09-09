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
    MEM0_INFER               on|off (default on) — the DEFAULT ingestion mode for /add:
                             off = Memory.add(..., infer=False) stores each non-system
                             message verbatim, no extraction LLM. Arms pass `infer`
                             per request; this is the fallback + the /health stamp.
    MEM0_LLM_TIMEOUT_S       default 1500 — read timeout of the OpenAI client mem0 builds
    MEM0_LLM_MAX_RETRIES     default 0 — mem0's client retried 2× at 600 s = the arm's
                             1800 s bound (three smokes died there 2026-09-09); a retry
                             only re-queues behind other generations on the box
    MEM0_NO_THINK            1 (default via the spawner since task 182) — mem0 builds
                             its own extraction prompts and its OpenAI client cannot
                             pass extra body fields, so the sidecar starts a tiny
                             IN-PROCESS forwarding proxy (127.0.0.1, ephemeral port)
                             that injects "chat_template_kwargs":
                             {"enable_thinking": false} into every
                             /v1/chat/completions body and forwards to
                             MEM0_LLM_BASE_URL; mem0 is pointed at the proxy.
                             /health reports extraction_thinking=off + proxy facts.

On startup it prints `MEM0_SIDECAR_READY <port>` to stderr (flushed) — that line
is the spawn handshake; the spawner polls /health afterwards.

Telemetry is force-disabled (MEM0_TELEMETRY=False before mem0 is imported): a
$0 clean-room arm does not phone home.

Hermetic testing: `make_handler(SidecarState(...))` accepts an injected
`memory_factory`, so test_mem0_sidecar.py drives the real HTTP surface with a
fake Mem0 client — no network beyond 127.0.0.1, no model calls.
"""

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
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
    "MEM0_INFER": "on",  # default ingestion mode; the arms pass infer explicitly
    "MEM0_NO_THINK": "0",  # spawner defaults this to 1 since task 182
    # mem0 builds its OpenAI client with the library defaults: read timeout 600 s
    # and max_retries 2 → 3 × 600 s = 1800 s, exactly the arm's request bound.
    # Three Mem0 smokes died there on 2026-09-09: one extraction call queued
    # behind another client's long generation, re-queued at the back on every
    # retry, killed by the arm. One honest wait, no re-queueing:
    "MEM0_LLM_TIMEOUT_S": "1500",
    "MEM0_LLM_MAX_RETRIES": "0",
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
    infer_raw = str(merged["MEM0_INFER"]).strip().lower()
    if infer_raw not in ("on", "off"):
        raise ValueError(f"MEM0_INFER must be on|off (got {merged['MEM0_INFER']!r})")
    infer_default = infer_raw == "on"
    no_think = str(merged["MEM0_NO_THINK"]).strip().lower() in ("1", "true", "on", "yes")
    llm_timeout_s = float(merged["MEM0_LLM_TIMEOUT_S"])
    llm_max_retries = int(merged["MEM0_LLM_MAX_RETRIES"])
    if llm_timeout_s <= 0 or llm_max_retries < 0:
        raise ValueError(
            f"MEM0_LLM_TIMEOUT_S must be > 0 and MEM0_LLM_MAX_RETRIES >= 0 "
            f"(got {merged['MEM0_LLM_TIMEOUT_S']!r}, {merged['MEM0_LLM_MAX_RETRIES']!r})"
        )
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
        "llm": {
            "model": merged["MEM0_LLM_MODEL"],
            "base_url_host": urlparse(merged["MEM0_LLM_BASE_URL"]).netloc,
            "timeout_s": llm_timeout_s,
            "max_retries": llm_max_retries,
            "client_bounds_why": "one honest wait per extraction call; a retry re-queues behind other generations",
        },
        "embedder": {
            "model": merged["MEM0_EMBEDDER_MODEL"],
            "base_url_host": urlparse(merged["MEM0_EMBEDDER_BASE_URL"]).netloc,
            "dims": dims,
        },
        "vector_store": {"provider": merged["MEM0_VECTOR_STORE_PROVIDER"], "path": store_path},
        "search_threshold": float(merged["MEM0_SEARCH_THRESHOLD"]),
        "max_llm_tokens": int(merged["MEM0_MAX_LLM_TOKENS"]),
        "ingestion_infer": infer_default,
        "extraction_thinking": "off" if no_think else "on",
    }
    return config, facts


def mem0_version():
    """Installed mem0ai version from package metadata — no heavy mem0 import."""
    from importlib.metadata import version

    return version("mem0ai")


# ---------------------------------------------------------------------------
# The no-think forwarding proxy (task 182, addendum 6).
#
# mem0's extraction prompts are built inside the library and its OpenAI client
# cannot pass extra body fields (chat_template_kwargs) — so with MEM0_NO_THINK
# the sidecar stands up this tiny proxy, points mem0's llm config at it, and
# every /v1/chat/completions body gets "chat_template_kwargs":
# {"enable_thinking": false} injected before forwarding to MEM0_LLM_BASE_URL.
# llama.cpp honours the flag; extraction stops spending the one 3090 slot on
# ~300 reasoning tokens per add (measured 2026-09-09 ~10:25).
# ---------------------------------------------------------------------------

# End-to-end extraction can take minutes on a contended endpoint; matched to
# the arm's per-request budget rather than any short urllib default.
PROXY_FORWARD_TIMEOUT_S = 1800

# The only headers worth forwarding to the model endpoint (hop-by-hop headers
# are never forwarded).
_PROXY_FORWARD_HEADERS = ("content-type", "authorization", "accept", "api-key")


def make_no_think_proxy_handler(target_base_url, timeout_s=PROXY_FORWARD_TIMEOUT_S):
    """Build a proxy handler forwarding everything to `target_base_url`.

    The request path is re-based: a client whose base_url is
    `http://127.0.0.1:<port>/v1` asks for `/v1/chat/completions`; a target that
    already ends in `/v1` must not get a doubled prefix.
    """
    target = target_base_url.rstrip("/")

    class NoThinkProxyHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"  # close per request — same shape as the sidecar

        def log_message(self, fmt, *args):  # stderr, one line — the spawner surfaces it
            import sys

            sys.stderr.write("[mem0-no-think-proxy] %s\n" % (fmt % args))
            sys.stderr.flush()

        def _reply(self, status, payload, content_type):
            self.send_response(status)
            self.send_header("Content-Type", content_type or "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _forward(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length > 0 else None
            if body:
                try:
                    parsed = json.loads(body.decode("utf8"))
                    if isinstance(parsed, dict):
                        existing = parsed.get("chat_template_kwargs")
                        parsed["chat_template_kwargs"] = {
                            **(existing if isinstance(existing, dict) else {}),
                            "enable_thinking": False,
                        }
                        body = json.dumps(parsed).encode("utf8")
                except (UnicodeDecodeError, json.JSONDecodeError):
                    pass  # non-JSON body: forwarded untouched

            path = self.path
            if target.endswith("/v1") and path.startswith("/v1/"):
                path = path[len("/v1"):]
            url = target + path

            headers = {k: v for k, v in self.headers.items() if k.lower() in _PROXY_FORWARD_HEADERS}
            req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
            try:
                with urllib.request.urlopen(req, timeout=timeout_s) as res:
                    self._reply(res.status, res.read(), res.headers.get("Content-Type"))
            except urllib.error.HTTPError as e:
                self._reply(e.code, e.read(), e.headers.get("Content-Type"))
            except Exception as e:  # loud 502 — never a hang, never a silent drop
                self._reply(
                    502,
                    json.dumps({"ok": False, "error": f"no-think proxy forward failed: {e}"}).encode("utf8"),
                    "application/json",
                )

        do_POST = _forward
        do_GET = _forward
        do_DELETE = _forward
        do_PUT = _forward

    return NoThinkProxyHandler


def start_no_think_proxy(target_base_url, host="127.0.0.1", port=0):
    """Bind the proxy on loopback, serve it on a daemon thread.

    Returns (server, thread, base_url) where base_url is what mem0's llm
    config should point at (`http://127.0.0.1:<port>/v1`).
    """
    server = ThreadingHTTPServer((host, port), make_no_think_proxy_handler(target_base_url))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://{host}:{server.server_address[1]}/v1"
    return server, thread, base_url


def bound_mem0_openai_client(timeout_s, max_retries):
    """Make every OpenAI client mem0 builds carry our bounds.

    mem0's OpenAILLM does `OpenAI(api_key=..., base_url=...)` (mem0ai 2.0.20
    mem0/llms/openai.py:53) — no timeout, no retry knob in its config — so the
    library defaults apply (read 600 s, 2 retries). We wrap the class the
    module resolves at call time; idempotent (re-binding replaces the wrapper,
    never wraps the wrapper). Returns the bound class.
    """
    ensure_telemetry_off()
    import mem0.llms.openai as mem0_openai

    real = getattr(mem0_openai, "_bench_real_OpenAI", None) or mem0_openai.OpenAI

    class BoundedOpenAI(real):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault("timeout", timeout_s)
            kwargs.setdefault("max_retries", max_retries)
            super().__init__(*args, **kwargs)

    BoundedOpenAI.__name__ = real.__name__
    mem0_openai._bench_real_OpenAI = real
    mem0_openai.OpenAI = BoundedOpenAI
    return BoundedOpenAI


def default_memory_factory(config):
    """The real Mem0 client. Heavy import deferred to first use."""
    ensure_telemetry_off()
    from mem0 import Memory

    return Memory.from_config(config)


class ExtractionFailureCounter(logging.Handler):
    """Counts mem0's "Error parsing extraction response" log records.

    mem0 (2.0.20 mem0/memory/main.py:983) logs the failure and SKIPS the
    session — the arm's /add returns ok with zero facts and nothing says a
    session was lost. The receipt must report ingestion loss per arm the same
    way on both sides of the 2×2 (the mycelium-extract arm counts its own
    drops), so the sidecar counts these and exposes the total on /health and
    on every /add reply.
    """

    MATCH = "Error parsing extraction response"

    def __init__(self):
        super().__init__(level=logging.ERROR)
        self.count = 0
        self._lock = threading.Lock()

    def emit(self, record):
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 — a bad record must not break counting
            return
        if self.MATCH in msg:
            with self._lock:
                self.count += 1


def install_extraction_failure_counter(logger_name="mem0"):
    """Attach ONE counter to mem0's logger tree (idempotent); returns it."""
    lg = logging.getLogger(logger_name)
    for h in lg.handlers:
        if isinstance(h, ExtractionFailureCounter):
            return h
    h = ExtractionFailureCounter()
    lg.addHandler(h)
    return h


class SidecarState:
    """Env + the lazily-created Mem0 client. One per process."""

    def __init__(
        self,
        env=None,
        memory_factory=default_memory_factory,
        proxy_starter=start_no_think_proxy,
        client_binder=bound_mem0_openai_client,
    ):
        self.env = env if env is not None else os.environ
        self._factory = memory_factory
        self._binder = client_binder  # runs ONCE, before the first client build
        self._memory = None
        self._lock = threading.Lock()
        self.config, self.facts = config_from_env(self.env)
        self.infer_default = self.facts["ingestion_infer"]
        self.parse_failures = install_extraction_failure_counter()
        self.client_bounds = {"timeout_s": self.facts["llm"]["timeout_s"], "max_retries": self.facts["llm"]["max_retries"]}
        self._proxy_server = None
        if self.facts["extraction_thinking"] == "off":
            # mem0 cannot carry chat_template_kwargs itself — stand up the
            # in-process proxy and point the llm config at it
            target = self.env["MEM0_LLM_BASE_URL"]
            self._proxy_server, self._proxy_thread, proxy_url = proxy_starter(target)
            self.config["llm"]["config"]["openai_base_url"] = proxy_url
            self.facts["llm"] = {
                **self.facts["llm"],
                "base_url_host": urlparse(proxy_url).netloc,
                "no_think_proxy_for": urlparse(target).netloc,
            }
            self.facts["no_think_proxy"] = {"base_url": proxy_url, "target_base_url": target}

    def close_proxy(self):
        """Test teardown: stop the forwarding proxy, if one is running."""
        if self._proxy_server is not None:
            self._proxy_server.shutdown()
            self._proxy_server.server_close()
            self._proxy_server = None

    @property
    def memory(self):
        with self._lock:
            if self._memory is None:
                self._binder(self.client_bounds["timeout_s"], self.client_bounds["max_retries"])
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
                self._send(200, {"ok": True, "pid": os.getpid(), **state.facts,
                                 "extraction_parse_failures": state.parse_failures.count})
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
            # infer: raw (False) vs LLM-extraction (True) ingestion — the arms
            # always pass it; MEM0_INFER is the default for callers that don't
            infer = body.get("infer", state.infer_default)
            if not isinstance(infer, bool):
                raise BadRequest("infer (bool) — raw vs extraction ingestion; true|false, not a string")
            before = state.parse_failures.count
            result = state.memory.add(messages, user_id=user_id, metadata=body.get("metadata"), infer=infer)
            results = result.get("results", []) if isinstance(result, dict) else []
            failed_here = state.parse_failures.count - before
            return {"ok": True, "results": results, "count": len(results),
                    "extraction_parse_failed": failed_here > 0,
                    "extraction_parse_failures_total": state.parse_failures.count}

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


def main(memory_factory=default_memory_factory, client_binder=bound_mem0_openai_client):
    """Run the sidecar until terminated. `memory_factory` is the hermetic-test
    seam (same one make_handler takes): tests drive the REAL signal protocol
    with a fake Mem0 client whose add() blocks, proving the drain behaviour."""
    import signal
    import sys
    import threading
    import time

    state = SidecarState(memory_factory=memory_factory, client_binder=client_binder)
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

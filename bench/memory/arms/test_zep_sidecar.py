"""Hermetic unittest for the zep (graphiti) benchmark sidecar.

Exercises the REAL HTTP surface (make_handler + SidecarState on an ephemeral
127.0.0.1 port) with a FAKE Graphiti client injected as client_factory — no
network beyond 127.0.0.1, no model calls, no graphiti-core import.

Run (any python3 works; the module is stdlib-only):

    bench/memory/arms/.zep-venv/bin/python -m unittest -v bench/memory/arms/test_zep_sidecar.py
    # or: cd bench/memory/arms && python3 -m unittest -v test_zep_sidecar
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zep_sidecar  # noqa: E402

TEST_ENV = {
    "ZEP_LLM_BASE_URL": "http://llm-host.local:11434/v1",
    "ZEP_LLM_MODEL": "qwen3.8:27b",
    "ZEP_LLM_API_KEY": "unused",
    "ZEP_EMBEDDER_BASE_URL": "http://embed-host.local:11434/v1",
    "ZEP_EMBEDDER_MODEL": "nomic-embed-text",
    "ZEP_EMBEDDER_DIMS": "768",
    "ZEP_STORE_PATH": "/tmp/zep-sidecar-test-store",
}


class FakeEdge:
    """Stands in for graphiti_core.edges.EntityEdge — the search result shape."""

    def __init__(self, fact, uuid, created_at=None):
        self.fact = fact
        self.uuid = uuid
        self.created_at = created_at or datetime(2026, 9, 9, 12, 0, 0, tzinfo=timezone.utc)


class FakeEpisodeResult:
    def __init__(self, edges):
        self.edges = edges


class FakeConn:
    """The kuzu AsyncConnection stand-in the /delete_all purge drives."""

    def __init__(self, record):
        self.record = record

    async def execute(self, query, params=None):
        self.record.append({"query": " ".join(query.split()), "params": params})
        return None


class FakeDriver:
    def __init__(self, record):
        self.client = FakeConn(record)


class FakeGraphiti:
    """Stands in for graphiti_core.Graphiti — records calls, returns Graphiti-shaped results."""

    def __init__(self):
        self.episodes = []
        self.searches = []
        self.purges = []
        self.init_calls = 0
        self.driver = FakeDriver(self.purges)

    async def build_indices_and_constraints(self):
        self.init_calls += 1
        return None

    async def add_episode(self, *, name, episode_body, source_description, reference_time, group_id, **kwargs):
        self.episodes.append(
            {
                "name": name,
                "episode_body": episode_body,
                "source_description": source_description,
                "reference_time": reference_time,
                "group_id": group_id,
                **kwargs,
            }
        )
        return FakeEpisodeResult([FakeEdge("User likes tea.", "e1"), FakeEdge("User moved to Lisbon.", "e2")])

    async def search(self, query, group_ids=None, num_results=10):
        self.searches.append({"query": query, "group_ids": group_ids, "num_results": num_results})
        return [
            FakeEdge("User likes tea.", "e1"),
            FakeEdge("User moved to Lisbon.", "e2"),
        ]


def get(url):
    with urllib.request.urlopen(url, timeout=5) as res:
        return res.status, json.loads(res.read().decode("utf8"))


def post(url, payload):
    data = json.dumps(payload).encode("utf8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read().decode("utf8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf8"))


class SidecarHTTPTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGraphiti()
        state = zep_sidecar.SidecarState(env=dict(TEST_ENV), client_factory=lambda cfg: self.fake)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), zep_sidecar.make_handler(state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.state = state

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    # ---------------- /health ------------------------------------------------

    def test_health_reports_config_facts_without_touching_graphiti(self):
        status, body = get(f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIsInstance(body["pid"], int)
        self.assertEqual(body["llm"], {"model": "qwen3.8:27b", "base_url_host": "llm-host.local:11434", "max_tokens": 16384})
        self.assertEqual(
            body["embedder"],
            {"model": "nomic-embed-text", "base_url_host": "embed-host.local:11434", "dims": 768},
        )
        self.assertEqual(body["graph_store"]["provider"], "kuzu-embedded")
        self.assertTrue(body["graph_store"]["deprecated_upstream"])  # stamped honestly into the regime
        self.assertIn("EDGE_HYBRID_SEARCH_RRF", body["search"]["recipe"])
        # the Graphiti client is lazy: no /add or /search means it was never created
        self.assertEqual(self.fake.episodes, [])
        self.assertEqual(self.fake.searches, [])
        self.assertEqual(self.fake.init_calls, 0)

    # ---------------- /add ---------------------------------------------------

    def test_add_builds_one_episode_per_post_scoped_by_group_id(self):
        status, body = post(
            f"{self.base}/add",
            {
                "user_id": "bench-p1-run",
                "messages": [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi"},
                ],
                "metadata": {"question_id": "q1", "session_index": 0},
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["count"], 2)  # facts extracted by Graphiti
        self.assertEqual(body["episode"], "q1-s0")  # provenance in the episode name
        self.assertEqual(len(self.fake.episodes), 1)
        call = self.fake.episodes[0]
        self.assertEqual(call["group_id"], "bench-p1-run")  # the scope IS the graphiti group_id
        self.assertEqual(call["episode_body"], "user: hello\nassistant: hi")
        self.assertEqual(call["source_description"], "bench longmemeval haystack session")
        self.assertEqual(call["name"], "q1-s0")
        self.assertIsNotNone(call["reference_time"])
        # Graphiti's own extraction is never bypassed: no override kwargs leaked in
        self.assertEqual(call, {k: v for k, v in call.items()})

    def test_add_without_metadata_still_names_the_episode(self):
        status, body = post(
            f"{self.base}/add",
            {"user_id": "u", "messages": [{"role": "user", "content": "x"}]},
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["episode"].startswith("session-"))  # unique fallback name

    def test_add_first_use_bootstraps_indices_exactly_once(self):
        post(f"{self.base}/add", {"user_id": "u", "messages": [{"role": "user", "content": "x"}]})
        post(f"{self.base}/search", {"query": "q", "user_id": "u", "limit": 5})
        self.assertEqual(self.fake.init_calls, 1)  # Graphiti-on-kuzu init: once, before first use

    def test_add_validates_loudly(self):
        status, body = post(f"{self.base}/add", {"messages": [{"role": "user", "content": "x"}]})
        self.assertEqual(status, 400)
        self.assertIn("user_id", body["error"])

        status, body = post(f"{self.base}/add", {"user_id": "u", "messages": "not-a-list"})
        self.assertEqual(status, 400)
        self.assertIn("messages", body["error"])

        status, body = post(f"{self.base}/add", {"user_id": "u", "messages": [{"role": "user"}]})
        self.assertEqual(status, 400)
        self.assertIn("role", body["error"])

        status, body = post(f"{self.base}/add", {"user_id": "u", "messages": [{"role": "user", "content": "x"}], "metadata": "junk"})
        self.assertEqual(status, 400)
        self.assertIn("metadata", body["error"])

    def test_add_failure_is_a_loud_500(self):
        def boom(cfg):
            fake = FakeGraphiti()

            async def failing_add(**kwargs):
                raise RuntimeError("LLM endpoint down")

            fake.add_episode = failing_add
            return fake

        state = zep_sidecar.SidecarState(env=dict(TEST_ENV), client_factory=boom)
        server = ThreadingHTTPServer(("127.0.0.1", 0), zep_sidecar.make_handler(state))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            status, body = post(
                f"http://127.0.0.1:{server.server_address[1]}/add",
                {"user_id": "u", "messages": [{"role": "user", "content": "x"}]},
            )
            self.assertEqual(status, 500)
            self.assertFalse(body["ok"])
            self.assertIn("LLM endpoint down", body["error"])  # never a silent failure
        finally:
            server.shutdown()
            server.server_close()

    # ---------------- /search ------------------------------------------------

    def test_search_maps_limit_to_num_results_and_scopes_by_group_id(self):
        status, body = post(
            f"{self.base}/search", {"query": "What does the user like?", "user_id": "bench-p1-run", "limit": 5}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["results"][0]["memory"], "User likes tea.")
        self.assertEqual(body["results"][0]["id"], "e1")
        self.assertTrue(body["results"][0]["created_at"].startswith("2026-09-09T12:00:00"))
        call = self.fake.searches[0]
        self.assertEqual(call["num_results"], 5)  # the retrieval budget, verbatim
        self.assertEqual(call["group_ids"], ["bench-p1-run"])  # strict scope

    def test_search_requires_an_explicit_limit(self):
        status, body = post(f"{self.base}/search", {"query": "q", "user_id": "u"})
        self.assertEqual(status, 400)
        self.assertIn("limit", body["error"])

    # ---------------- /delete_all ---------------------------------------------

    def test_delete_all_purges_every_grouped_label_for_the_scope(self):
        status, body = post(f"{self.base}/delete_all", {"user_id": "bench-p1-run"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.fake.purges, [
            {"query": f"MATCH (n:{label}) WHERE n.group_id IN $group_ids DETACH DELETE n",
             "params": {"group_ids": ["bench-p1-run"]}}
            for label in zep_sidecar.GROUPED_LABELS
        ])

    def test_delete_all_requires_a_user_id(self):
        status, body = post(f"{self.base}/delete_all", {})
        self.assertEqual(status, 400)
        self.assertIn("user_id", body["error"])

    # ---------------- protocol hygiene -----------------------------------------

    def test_unknown_route_is_404_and_bad_json_is_400(self):
        status, body = post(f"{self.base}/nope", {"a": 1})
        self.assertEqual(status, 404)
        self.assertEqual(body["ok"], False)

        req = urllib.request.Request(
            f"{self.base}/add", data=b"not-json", headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            urllib.request.urlopen(req, timeout=5)
            self.fail("expected 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)


class NoopCrossEncoderTest(unittest.TestCase):
    """The constructor-required cross-encoder must be a local, counted no-op —
    never an OpenAI client that demands an API key at construction."""

    def test_rank_preserves_order_and_counts_calls(self):
        enc = zep_sidecar.NoopCrossEncoder()
        import asyncio

        result = asyncio.run(enc.rank("q", ["b", "a", "c"]))
        self.assertEqual(result, [("b", 1.0), ("a", 1.0), ("c", 1.0)])
        self.assertEqual(enc.calls, 1)


class ConfigFromEnvTest(unittest.TestCase):
    def test_full_env_maps_to_graphiti_config_facts(self):
        config, facts = zep_sidecar.config_from_env(dict(TEST_ENV))
        self.assertEqual(config["llm"]["base_url"], "http://llm-host.local:11434/v1")  # OpenAI-COMPATIBLE
        self.assertEqual(config["llm"]["model"], "qwen3.8:27b")
        self.assertEqual(config["llm"]["max_tokens"], 16384)
        self.assertEqual(config["embedder"]["base_url"], "http://embed-host.local:11434/v1")
        self.assertEqual(config["embedder"]["dims"], 768)  # int, not "768"
        self.assertEqual(config["graph_store"], {"provider": "kuzu-embedded", "path": "/tmp/zep-sidecar-test-store"})
        self.assertEqual(facts["llm"]["base_url_host"], "llm-host.local:11434")
        self.assertTrue(facts["graph_store"]["deprecated_upstream"])
        self.assertIn("disabled", facts["telemetry"])

    def test_missing_env_lists_everything_missing(self):
        with self.assertRaises(ValueError) as ctx:
            zep_sidecar.config_from_env({"ZEP_LLM_MODEL": "x"})
        self.assertIn("ZEP_LLM_BASE_URL", str(ctx.exception))
        self.assertIn("ZEP_STORE_PATH", str(ctx.exception))

    def test_versions_fall_back_to_not_installed_without_the_packages(self):
        # hermetic: no graphiti-core import anywhere; a bare python3 without the
        # venv still reports a usable (if honest) version string
        self.assertIsInstance(zep_sidecar.graphiti_version(), str)
        self.assertIsInstance(zep_sidecar.kuzu_version(), str)

    def test_telemetry_can_be_forced_off(self):
        env = {}
        zep_sidecar.ensure_telemetry_off(env)
        self.assertEqual(env["GRAPHITI_TELEMETRY_ENABLED"], "false")


def _connect_refused_within(port, seconds):
    """True once the port stops accepting connections (listener closed)."""
    import socket
    import time

    stop_at = time.time() + seconds
    while time.time() < stop_at:
        s = socket.socket()
        s.settimeout(1)
        try:
            s.connect(("127.0.0.1", port))
        except OSError:
            return True
        finally:
            s.close()
        time.sleep(0.2)
    return False


def _stderr_line(proc, prefix, deadline_s=30):
    """Next stderr line starting with `prefix` (sidecar signals via stderr)."""
    import time

    stop_at = time.time() + deadline_s
    while time.time() < stop_at:
        line = proc.stderr.readline()
        if not line:
            break
        text = line.decode("utf8", "replace")
        if text.startswith(prefix):
            return text
    raise AssertionError(f"sidecar stderr never produced a line starting with {prefix!r}")


class TwoStageStopProtocolTest(unittest.TestCase):
    """The subprocess stop protocol, for real: first SIGTERM closes the
    LISTENER (the death becomes visible — new connects are refused) while the
    process stays up to drain the in-flight request; a second SIGTERM exits
    immediately. The spawner's stop() nudges on exactly this protocol."""

    def _spawn(self, argv, store):
        import subprocess

        env = dict(os.environ, **TEST_ENV)
        env["ZEP_STORE_PATH"] = store
        env["PYTHONPATH"] = os.path.dirname(os.path.abspath(zep_sidecar.__file__))
        return subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_idle_stop_exits_cleanly_on_the_first_sigterm(self):
        import signal
        import subprocess

        proc = self._spawn([sys.executable, zep_sidecar.__file__], tempfile.mkdtemp(prefix="zep-stop-idle-"))
        try:
            port = int(_stderr_line(proc, "ZEP_SIDECAR_READY").split()[1])
            health = urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5)
            self.assertEqual(health.status, 200)

            proc.send_signal(signal.SIGTERM)
            # nothing in flight: the drain is instant, so the process exits on
            # its own — the listener closing is still what makes the death visible
            self.assertTrue(_connect_refused_within(port, 10), "listener still accepting after SIGTERM")
            self.assertEqual(proc.wait(timeout=10), 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)

    def test_first_sigterm_closes_listener_process_drains_second_exits(self):
        # A fake Graphiti whose add_episode() BLOCKS until a sentinel file
        # appears — the only way to observe the drain window from outside the
        # process.
        import signal

        store = tempfile.mkdtemp(prefix="zep-stop-drain-")
        release = os.path.join(store, "release")
        driver = (
            "import asyncio, os, sys, time\n"
            "import zep_sidecar\n"
            f"RELEASE = {release!r}\n"
            "class BlockingClient:\n"
            "    async def build_indices_and_constraints(self):\n"
            "        return None\n"
            "    async def add_episode(self, **kwargs):\n"
            "        sys.stderr.write('ADD_INFLIGHT\\n'); sys.stderr.flush()\n"
            "        deadline = time.time() + 60\n"
            "        while not os.path.exists(RELEASE) and time.time() < deadline:\n"
            "            await asyncio.sleep(0.05)\n"
            "        class R: edges = []\n"
            "        return R()\n"
            "    async def search(self, *a, **kw):\n"
            "        return []\n"
            "zep_sidecar.main(client_factory=lambda cfg: BlockingClient())\n"
        )
        proc = self._spawn([sys.executable, "-c", driver], store)
        try:
            port = int(_stderr_line(proc, "ZEP_SIDECAR_READY").split()[1])

            # POST /add in the background; wait until the handler is inside it
            def post_add():
                try:
                    post(f"http://127.0.0.1:{port}/add", {"user_id": "u", "messages": [{"role": "user", "content": "x"}]})
                except Exception:
                    pass  # the process exits mid-request on the second signal

            threading.Thread(target=post_add, daemon=True).start()
            _stderr_line(proc, "ADD_INFLIGHT")

            proc.send_signal(signal.SIGTERM)
            # 1) the death is visible: listener closed, new connects REFUSED
            self.assertTrue(_connect_refused_within(port, 10), "listener still accepting after SIGTERM")
            # 2) ...but the process is still alive, draining the blocked add
            self.assertIsNone(proc.poll(), "sidecar exited on the FIRST SIGTERM instead of draining")

            # 3) the second signal (the spawner's nudge) exits NOW — it must not
            #    wait out the blocked add
            proc.send_signal(signal.SIGTERM)
            self.assertEqual(proc.wait(timeout=10), 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()

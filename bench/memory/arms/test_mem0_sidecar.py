"""Hermetic unittest for the mem0 benchmark sidecar.

Exercises the REAL HTTP surface (make_handler + SidecarState on an ephemeral
127.0.0.1 port) with a FAKE Mem0 client injected as memory_factory — no network
beyond 127.0.0.1, no model calls, no mem0 import.

Run (any python3 works; the module is stdlib-only):

    bench/memory/arms/.mem0-venv/bin/python -m unittest -v bench/memory/arms/test_mem0_sidecar.py
    # or: cd bench/memory/arms && python3 -m unittest -v test_mem0_sidecar
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mem0_sidecar  # noqa: E402

TEST_ENV = {
    "MEM0_LLM_BASE_URL": "http://llm-host.local:11434/v1",
    "MEM0_LLM_MODEL": "qwen3.8:27b",
    "MEM0_LLM_API_KEY": "unused",
    "MEM0_EMBEDDER_BASE_URL": "http://embed-host.local:11434",
    "MEM0_EMBEDDER_MODEL": "nomic-embed-text",
    "MEM0_EMBEDDER_DIMS": "768",
    "MEM0_STORE_PATH": "/tmp/mem0-sidecar-test-store",
    "MEM0_VECTOR_STORE_PROVIDER": "qdrant",
}


class FakeMemory:
    """Stands in for mem0.memory.Memory — records calls, returns mem0-shaped results."""

    def __init__(self):
        self.adds = []
        self.searches = []
        self.deletes = []

    def add(self, messages, user_id=None, metadata=None, infer=True):
        self.adds.append({"messages": messages, "user_id": user_id, "metadata": metadata, "infer": infer})
        return {"results": [{"id": "mem-1", "memory": "User likes tea.", "event": "ADD"}]}

    def search(self, query, top_k=20, filters=None, threshold=0.1):
        self.searches.append({"query": query, "top_k": top_k, "filters": filters, "threshold": threshold})
        return {
            "results": [
                {"id": "mem-1", "memory": "User likes tea.", "score": 0.42, "created_at": "2026-09-08T00:00:00Z"},
                {"id": "mem-2", "memory": "User moved to Lisbon.", "score": 0.31, "created_at": "2026-09-08T00:00:01Z"},
            ]
        }

    def delete_all(self, user_id=None):
        self.deletes.append(user_id)
        return True


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
        self.fake = FakeMemory()
        state = mem0_sidecar.SidecarState(env=dict(TEST_ENV), memory_factory=lambda cfg: self.fake)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), mem0_sidecar.make_handler(state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    # ---------------- /health ------------------------------------------------

    def test_health_reports_config_facts_without_touching_mem0(self):
        status, body = get(f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIsInstance(body["pid"], int)
        self.assertEqual(body["llm"], {"model": "qwen3.8:27b", "base_url_host": "llm-host.local:11434"})
        self.assertEqual(
            body["embedder"],
            {"model": "nomic-embed-text", "base_url_host": "embed-host.local:11434", "dims": 768},
        )
        self.assertEqual(body["vector_store"], {"provider": "qdrant", "path": "/tmp/mem0-sidecar-test-store"})
        # the Mem0 client is lazy: no /add or /search means it was never created
        self.assertEqual(self.fake.adds, [])

    # ---------------- /add ---------------------------------------------------

    def test_add_passes_messages_user_and_metadata_through(self):
        status, body = post(
            f"{self.base}/add",
            {
                "user_id": "bench-p1-run",
                "messages": [{"role": "user", "content": "hello"}],
                "metadata": {"question_id": "q1", "session_index": 0},
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["count"], 1)  # memories extracted
        self.assertEqual(len(self.fake.adds), 1)
        call = self.fake.adds[0]
        self.assertEqual(call["user_id"], "bench-p1-run")
        self.assertEqual(call["messages"], [{"role": "user", "content": "hello"}])
        self.assertEqual(call["metadata"], {"question_id": "q1", "session_index": 0})
        self.assertTrue(call["infer"])  # Mem0's own extraction — never bypassed

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

    # ---------------- /search ------------------------------------------------

    def test_search_maps_limit_to_top_k_and_scopes_by_user(self):
        status, body = post(
            f"{self.base}/search", {"query": "What does the user like?", "user_id": "bench-p1-run", "limit": 5}
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["count"], 2)
        self.assertEqual(
            body["results"][0],
            {"memory": "User likes tea.", "score": 0.42, "id": "mem-1", "created_at": "2026-09-08T00:00:00Z"},
        )
        call = self.fake.searches[0]
        self.assertEqual(call["top_k"], 5)  # the retrieval budget, verbatim
        self.assertEqual(call["filters"], {"user_id": "bench-p1-run"})  # strict scope
        self.assertEqual(call["threshold"], 0.1)  # the stamped mem0 default

    def test_search_requires_an_explicit_limit(self):
        status, body = post(f"{self.base}/search", {"query": "q", "user_id": "u"})
        self.assertEqual(status, 400)
        self.assertIn("limit", body["error"])

    # ---------------- /delete_all ---------------------------------------------

    def test_delete_all_purges_the_scope(self):
        status, body = post(f"{self.base}/delete_all", {"user_id": "bench-p1-run"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.fake.deletes, ["bench-p1-run"])

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


class ConfigFromEnvTest(unittest.TestCase):
    def test_full_env_maps_to_mem0_config(self):
        config, facts = mem0_sidecar.config_from_env(dict(TEST_ENV))
        self.assertEqual(config["llm"]["provider"], "openai")  # OpenAI-COMPATIBLE (llama.cpp /v1)
        self.assertEqual(config["llm"]["config"]["model"], "qwen3.8:27b")
        self.assertEqual(config["llm"]["config"]["openai_base_url"], "http://llm-host.local:11434/v1")
        self.assertEqual(config["llm"]["config"]["temperature"], 0)
        self.assertEqual(config["embedder"]["provider"], "ollama")
        self.assertEqual(config["embedder"]["config"]["embedding_dims"], 768)  # int, not "768"
        self.assertEqual(config["vector_store"]["provider"], "qdrant")
        self.assertEqual(config["vector_store"]["config"]["embedding_model_dims"], 768)
        self.assertEqual(config["vector_store"]["config"]["path"], "/tmp/mem0-sidecar-test-store")
        self.assertTrue(config["history_db_path"].endswith("history.db"))
        self.assertEqual(facts["llm"]["base_url_host"], "llm-host.local:11434")
        self.assertEqual(facts["search_threshold"], 0.1)

    def test_missing_env_lists_everything_missing(self):
        with self.assertRaises(ValueError) as ctx:
            mem0_sidecar.config_from_env({"MEM0_LLM_MODEL": "x"})
        self.assertIn("MEM0_LLM_BASE_URL", str(ctx.exception))
        self.assertIn("MEM0_STORE_PATH", str(ctx.exception))

    def test_telemetry_can_be_forced_off(self):
        env = {}
        mem0_sidecar.ensure_telemetry_off(env)
        self.assertEqual(env["MEM0_TELEMETRY"], "False")


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
        env["MEM0_STORE_PATH"] = store
        env["PYTHONPATH"] = os.path.dirname(os.path.abspath(mem0_sidecar.__file__))
        return subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_idle_stop_exits_cleanly_on_the_first_sigterm(self):
        import signal
        import subprocess

        proc = self._spawn([sys.executable, mem0_sidecar.__file__], tempfile.mkdtemp(prefix="mem0-stop-idle-"))
        try:
            port = int(_stderr_line(proc, "MEM0_SIDECAR_READY").split()[1])
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
        # A fake Mem0 whose add() BLOCKS until a sentinel file appears — the
        # only way to observe the drain window from outside the process.
        import signal

        store = tempfile.mkdtemp(prefix="mem0-stop-drain-")
        release = os.path.join(store, "release")
        driver = (
            "import os, sys, threading, time\n"
            "import mem0_sidecar\n"
            f"RELEASE = {release!r}\n"
            "class BlockingMemory:\n"
            "    def add(self, messages, user_id=None, metadata=None, infer=True):\n"
            "        sys.stderr.write('ADD_INFLIGHT\\n'); sys.stderr.flush()\n"
            "        deadline = time.time() + 60\n"
            "        while not os.path.exists(RELEASE) and time.time() < deadline:\n"
            "            time.sleep(0.05)\n"
            "        return {'results': []}\n"
            "    def search(self, query, top_k=20, filters=None, threshold=0.1):\n"
            "        return {'results': []}\n"
            "    def delete_all(self, user_id=None):\n"
            "        return True\n"
            "mem0_sidecar.main(memory_factory=lambda cfg: BlockingMemory())\n"
        )
        proc = self._spawn([sys.executable, "-c", driver], store)
        try:
            port = int(_stderr_line(proc, "MEM0_SIDECAR_READY").split()[1])

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

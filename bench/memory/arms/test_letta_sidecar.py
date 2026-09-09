"""Hermetic unittest for the letta benchmark sidecar.

Exercises the REAL HTTP surface (make_handler + SidecarState on an ephemeral
127.0.0.1 port) with a FAKE Letta client injected as client_factory — no
network beyond 127.0.0.1, no model calls, no letta_client import.

Run (any python3 works; the module is stdlib-only):

    bench/memory/arms/.letta-venv/bin/python -m unittest -v bench/memory/arms/test_letta_sidecar.py
    # or: cd bench/memory/arms && python3 -m unittest -v test_letta_sidecar
"""

import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import letta_sidecar  # noqa: E402

TEST_ENV = {
    "LETTA_SERVER_URL": "http://letta-host.local:8283",
    "LETTA_LLM_BASE_URL": "http://llm-host.local:11434/v1",
    "LETTA_LLM_MODEL": "qwen3.8:27b",
    "LETTA_EMBEDDER_BASE_URL": "http://embed-host.local:11434",
    "LETTA_EMBEDDER_MODEL": "nomic-embed-text",
    "LETTA_EMBEDDER_DIMS": "768",
}


class FakePassage:
    def __init__(self, pid, text, created_at=None):
        self.id = pid
        self.text = text
        self.created_at = created_at


class FakeSearchItem:
    def __init__(self, passage, score):
        self.passage = passage
        self.score = score


class FakePassages:
    """client.agents.passages — the SDK namespace the sidecar drives."""

    def __init__(self, outer):
        self._outer = outer

    def create(self, agent_id, text=None, tags=None):
        self._outer.adds.append({"agent_id": agent_id, "text": text, "tags": tags})
        passage = FakePassage(f"passage-{len(self._outer.passages_store) + 1}", text)
        self._outer.passages_store.append(passage)
        return [passage]

    def search(self, agent_id, query=None, top_k=None):
        self._outer.searches.append({"agent_id": agent_id, "query": query, "top_k": top_k})
        items = [
            FakeSearchItem(FakePassage("passage-1", "User moved to Lisbon.", datetime(2026, 9, 8, 0, 0, 0)), 0.42),
            FakeSearchItem(FakePassage("passage-2", "User likes tea.", datetime(2026, 9, 8, 0, 0, 1)), 0.31),
        ]
        return items[:top_k] if isinstance(top_k, int) else items


class FakeAgents:
    """client.agents — records create/delete/retrieve, returns letta-shaped
    objects. retrieve() succeeds only for `existing_agent_id` (set by tests
    that exercise the LETTA_STATE_FILE reattach path)."""

    def __init__(self, outer):
        self._outer = outer
        self.created = []
        self.deleted = []
        self.retrieved = []
        self.passages = FakePassages(outer)

    def create(self, llm_config=None, embedding_config=None, memory_blocks=None, include_base_tools=True):
        self.created.append(
            {
                "llm_config": llm_config,
                "embedding_config": embedding_config,
                "memory_blocks": memory_blocks,
                "include_base_tools": include_base_tools,
            }
        )
        self._outer.agent_id = f"agent-{len(self.created):04d}-fake"
        return type("Agent", (), {"id": self._outer.agent_id})()

    def retrieve(self, agent_id):
        self.retrieved.append(agent_id)
        if self._outer.existing_agent_id and agent_id == self._outer.existing_agent_id:
            return type("Agent", (), {"id": agent_id})()
        raise RuntimeError(f"agent {agent_id} not found")

    def delete(self, agent_id):
        self.deleted.append(agent_id)


class FakeClient:
    """Stands in for letta_client.Letta — exactly the SDK surface the sidecar
    drives: health(), agents.create/delete/retrieve, agents.passages.create/search."""

    def __init__(self, client_kwargs):
        self.client_kwargs = client_kwargs
        self.agent_id = None
        self.existing_agent_id = None
        self.adds = []
        self.searches = []
        self.passages_store = []
        self.server_up = True
        self.reported_version = "0.16.8"
        self.agents = FakeAgents(self)

    def health(self):
        if not self.server_up:
            raise ConnectionError(f"[Errno 61] Connection refused -> {self.client_kwargs['base_url']}")
        return type("Health", (), {"version": self.reported_version})()


def make_fake_factory(holder):
    """client_factory seam: builds ONE FakeClient for the runtime, no matter
    how many times the lazy property is consulted."""

    class Factory:
        def __call__(self, client_kwargs):
            if holder.get("client") is None:
                holder["client"] = FakeClient(client_kwargs)
            return holder["client"]

    return Factory()


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as res:
            return res.status, json.loads(res.read().decode("utf8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf8"))


def post(url, payload, raw=None):
    data = raw if raw is not None else json.dumps(payload).encode("utf8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.loads(res.read().decode("utf8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf8"))


def _connect_refused_within(port, seconds):
    import socket
    import time

    stop_at = time.time() + seconds
    while time.time() < stop_at:
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=1)
            sock.close()
            time.sleep(0.1)  # still accepting — keep waiting
        except OSError:
            return True
    return False


def _stderr_line(proc, prefix, deadline_s=30):
    """Next stderr line starting with `prefix` (sidecar signals via stderr).
    The deadline is enforced with select: readline() alone would block past
    any deadline when the child never produces the line."""
    import select
    import time

    stream = proc.stderr
    stop_at = time.time() + deadline_s
    while True:
        remaining = stop_at - time.time()
        if remaining <= 0:
            break
        ready, _, _ = select.select([stream], [], [], remaining)
        if not ready:
            break  # deadline hit while waiting for a line
        line = stream.readline()  # readable -> returns promptly (b"" at EOF)
        if not line:
            break
        text = line.decode("utf8", "replace")
        if text.startswith(prefix):
            return text
    raise AssertionError(f"sidecar stderr never produced a line starting with {prefix!r} within {deadline_s}s")


class SidecarHTTPTest(unittest.TestCase):
    def setUp(self):
        self.holder = {}
        state = letta_sidecar.SidecarState(env=dict(TEST_ENV), client_factory=make_fake_factory(self.holder))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), letta_sidecar.make_handler(state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.state = state

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    @property
    def fake(self):
        # force the runtime to build its client (the /health probe does this too)
        return self.state.runtime.client

    # ---------------- /health ------------------------------------------------

    def test_health_probes_the_server_and_reports_facts(self):
        status, body = get(f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["letta_version"], "0.16.8")
        self.assertTrue(body["letta_version_matches"])
        self.assertEqual(body["server"]["url_host"], "letta-host.local:8283")
        self.assertEqual(body["llm"], {"model": "qwen3.8:27b", "base_url_host": "llm-host.local:11434"})
        self.assertEqual(
            body["embedder"],
            {"model": "nomic-embed-text", "base_url_host": "embed-host.local:11434", "dims": 768},
        )
        self.assertIn("PostgreSQL+pgvector", body["storage"])
        self.assertIsNone(body["agent_id"])  # the run agent is created on the first add, not before

    def test_health_flags_a_version_mismatch_instead_of_refusing(self):
        self.fake.reported_version = "0.9.0"
        status, body = get(f"{self.base}/health")
        self.assertTrue(body["ok"])
        self.assertFalse(body["letta_version_matches"])
        self.assertEqual(body["letta_version"], "0.9.0")

    def test_health_with_the_server_down_is_ok_false_and_names_the_host(self):
        self.fake.server_up = False
        status, body = get(f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertFalse(body["ok"])
        self.assertIn("letta server unreachable at letta-host.local:8283", body["error"])

    # ---------------- /add ---------------------------------------------------

    def test_add_validates_loudly(self):
        for payload, needle in [
            ({"messages": [{"role": "user", "content": "x"}]}, "user_id"),
            ({"user_id": "u"}, "messages"),
            ({"user_id": "u", "messages": []}, "messages"),
            ({"user_id": "u", "messages": "not-a-list"}, "messages"),
            ({"user_id": "u", "messages": [{"role": "user"}]}, "content"),
        ]:
            status, body = post(f"{self.base}/add", payload)
            self.assertEqual(status, 400, f"expected 400 for {payload}")
            self.assertIn(needle, body["error"])

    def test_add_writes_ONE_flattened_passage_per_session_with_provenance_tags(self):
        messages = [
            {"role": "user", "content": "I am moving to Lisbon in the spring."},
            {"role": "assistant", "content": "Lisbon is a great choice."},
        ]
        status, body = post(
            f"{self.base}/add",
            {
                "user_id": "bench-p1-run1",
                "messages": messages,
                "metadata": {"question_id": "q-9", "session_index": 2, "bench": "longmemeval", "bench_run_id": "run1"},
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["count"], 1)  # ONE passage per session — not per turn
        self.assertEqual(len(self.fake.adds), 1)
        add = self.fake.adds[0]
        self.assertEqual(add["text"], "user: I am moving to Lisbon in the spring.\nassistant: Lisbon is a great choice.")
        self.assertEqual(
            add["tags"],
            ["bench-p1-run1", "bench:longmemeval", "question_id:q-9", "session_index:2"],
        )
        self.assertTrue(body["agent_id"].startswith("agent-"))

    def test_add_reuses_one_agent_across_sessions(self):
        msgs = [{"role": "user", "content": "hello"}]
        post(f"{self.base}/add", {"user_id": "s", "messages": msgs})
        post(f"{self.base}/add", {"user_id": "s", "messages": msgs})
        self.assertEqual(len(self.fake.agents.created), 1)  # ONE agent per run

    def test_agent_is_created_archival_only(self):
        post(f"{self.base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "hi"}]})
        created = self.fake.agents.created[0]
        self.assertFalse(created["include_base_tools"])  # the agent loop never runs
        self.assertEqual(created["memory_blocks"], [])  # no core memory — archival only
        self.assertEqual(created["llm_config"]["model_endpoint_type"], "openai")
        self.assertEqual(created["llm_config"]["model_endpoint"], "http://llm-host.local:11434/v1")
        self.assertEqual(created["embedding_config"]["embedding_endpoint_type"], "ollama")
        self.assertEqual(created["embedding_config"]["embedding_dim"], 768)

    # ---------------- /search ------------------------------------------------

    def test_search_passes_the_budget_as_top_k_and_maps_results(self):
        post(f"{self.base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "seed"}]})
        status, body = post(f"{self.base}/search", {"query": "Which city am I moving to?", "user_id": "s", "limit": 5})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.fake.searches[-1]["top_k"], 5)  # the budget is honoured exactly
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["results"][0]["memory"], "User moved to Lisbon.")
        self.assertEqual(body["results"][0]["score"], 0.42)
        self.assertEqual(body["results"][0]["id"], "passage-1")
        self.assertEqual(body["results"][0]["created_at"], "2026-09-08T00:00:00")

    def test_search_honours_a_budget_smaller_than_the_hit_count(self):
        post(f"{self.base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "seed"}]})
        status, body = post(f"{self.base}/search", {"query": "q", "user_id": "s", "limit": 1})
        self.assertEqual(body["count"], 1)  # top_k=1 -> one result, never defaulted

    def test_search_never_defaults_the_budget(self):
        for limit in [None, 0, -1, 2.5, "5"]:
            status, body = post(f"{self.base}/search", {"query": "q", "user_id": "s", "limit": limit})
            self.assertEqual(status, 400, f"expected 400 for limit={limit!r}")
            self.assertIn("limit", body["error"])

    # ---------------- /delete_all ---------------------------------------------

    def test_delete_all_deletes_the_run_agent_and_is_idempotent(self):
        post(f"{self.base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "hi"}]})
        agent_id = self.fake.agent_id
        status, body = post(f"{self.base}/delete_all", {"user_id": "s"})
        self.assertEqual(status, 200)
        self.assertEqual(body["deleted_agent"], agent_id)
        self.assertEqual(self.fake.agents.deleted, [agent_id])
        status, body = post(f"{self.base}/delete_all", {"user_id": "s"})
        self.assertTrue(body["ok"])
        self.assertIsNone(body["deleted_agent"])  # already gone — not an error
        self.assertEqual(len(self.fake.agents.deleted), 1)

    def test_delete_all_never_creates_an_agent(self):
        status, body = post(f"{self.base}/delete_all", {"user_id": "s"})
        self.assertTrue(body["ok"])
        self.assertEqual(self.fake.agents.created, [])  # teardown must not create an agent

    # ---------------- protocol hygiene ----------------------------------------

    def test_unknown_route_is_404_and_bad_json_is_400(self):
        status, body = post(f"{self.base}/nope", {"a": 1})
        self.assertEqual(status, 404)
        status, body = get(f"{self.base}/nope")
        self.assertEqual(status, 404)
        status, body = post(f"{self.base}/add", None, raw=b"not json")
        self.assertEqual(status, 400)

    def test_a_client_failure_is_a_LOUD_500(self):
        def boom(client_kwargs):
            raise RuntimeError("embedder exploded")

        state = letta_sidecar.SidecarState(env=dict(TEST_ENV), client_factory=boom)
        server = ThreadingHTTPServer(("127.0.0.1", 0), letta_sidecar.make_handler(state))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{server.server_address[1]}"
            status, body = post(f"{base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "x"}]})
            self.assertEqual(status, 500)
            self.assertIn("embedder exploded", body["error"])
        finally:
            server.shutdown()
            server.server_close()

    # ---------------- config ----------------------------------------------------

    def test_config_requires_the_server_url_and_fails_loud(self):
        env = {k: v for k, v in TEST_ENV.items() if k != "LETTA_SERVER_URL"}
        with self.assertRaises(ValueError) as ctx:
            letta_sidecar.config_from_env(env)
        self.assertIn("LETTA_SERVER_URL", str(ctx.exception))

    def test_config_builds_client_kwargs_and_stamps(self):
        kwargs, llm, emb, facts = letta_sidecar.config_from_env(dict(TEST_ENV))
        self.assertEqual(kwargs["base_url"], "http://letta-host.local:8283")
        self.assertEqual(llm["context_window"], 32768)
        self.assertEqual(llm["max_tokens"], 4096)
        self.assertEqual(emb["embedding_dim"], 768)
        self.assertEqual(facts["letta_version_under_test"], letta_sidecar.LETTA_VERSION_UNDER_TEST)

    def test_flatten_session_prefixes_roles_and_joins_newlines(self):
        text = letta_sidecar.flatten_session([{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}])
        self.assertEqual(text, "user: a\nassistant: b")


@contextmanager
def sidecar_server(env):
    """A real HTTP sidecar over an injected fake client, on an ephemeral port."""
    holder = {}
    state = letta_sidecar.SidecarState(env=dict(env), client_factory=make_fake_factory(holder))
    server = ThreadingHTTPServer(("127.0.0.1", 0), letta_sidecar.make_handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state, holder, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


class StateFileTest(unittest.TestCase):
    """LETTA_STATE_FILE: a RESTARTED sidecar (mid-run crash — the arm restarts
    only on ECONNREFUSED) or a RESUMED run must reattach to the run's existing
    agent. Lazily creating a second agent would silently fork the run's memory:
    sessions written before the restart become unreachable to the search."""

    def setUp(self):
        import tempfile

        self.dir = tempfile.mkdtemp(prefix="letta-state-")
        self.state_file = os.path.join(self.dir, "agent.json")
        self.env = dict(TEST_ENV, LETTA_STATE_FILE=self.state_file)

    def test_first_add_persists_the_agent_id(self):
        with sidecar_server(self.env) as (state, holder, base):
            status, body = post(f"{base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "x"}]})
            self.assertEqual(status, 200)
            self.assertEqual(body["agent_id"], holder["client"].agent_id)
            with open(self.state_file, encoding="utf8") as f:
                self.assertEqual(json.load(f), {"agent_id": holder["client"].agent_id})
            self.assertEqual(holder["client"].agents.retrieved, [])  # no prior — nothing to reattach to

    def test_a_restarted_sidecar_reattaches_instead_of_creating_a_second_agent(self):
        with open(self.state_file, "w", encoding="utf8") as f:
            json.dump({"agent_id": "agent-persisted"}, f)
        with sidecar_server(self.env) as (state, holder, base):
            fake = state.runtime.client  # force client construction, then stage the server-side truth
            fake.existing_agent_id = "agent-persisted"
            status, body = post(f"{base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "x"}]})
            self.assertEqual(status, 200)
            self.assertEqual(holder["client"].agents.retrieved, ["agent-persisted"])
            self.assertEqual(holder["client"].agents.created, [])  # NOT a second agent
            self.assertEqual(body["agent_id"], "agent-persisted")

    def test_a_stale_state_file_falls_back_to_creating_fresh(self):
        with open(self.state_file, "w", encoding="utf8") as f:
            json.dump({"agent_id": "agent-vanished"}, f)  # deleted server-side (or another run's leftover)
        with sidecar_server(self.env) as (state, holder, base):
            status, body = post(f"{base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "x"}]})
            self.assertEqual(status, 200)
            self.assertEqual(holder["client"].agents.retrieved, ["agent-vanished"])  # tried, 404'd
            self.assertEqual(len(holder["client"].agents.created), 1)  # then created fresh
            with open(self.state_file, encoding="utf8") as f:
                self.assertEqual(json.load(f), {"agent_id": body["agent_id"]})  # file rewritten truthfully

    def test_delete_all_clears_the_persisted_identity(self):
        with open(self.state_file, "w", encoding="utf8") as f:
            json.dump({"agent_id": "agent-persisted"}, f)
        with sidecar_server(self.env) as (state, holder, base):
            fake = state.runtime.client
            fake.existing_agent_id = "agent-persisted"
            post(f"{base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "x"}]})
            status, body = post(f"{base}/delete_all", {"user_id": "s"})
            self.assertTrue(body["ok"])
            self.assertFalse(os.path.exists(self.state_file))  # a fresh run must NOT reattach to a deleted agent
            self.assertEqual(holder["client"].agents.deleted, ["agent-persisted"])


class TwoStageStopProtocolTest(unittest.TestCase):
    """The subprocess stop protocol, for real: first SIGTERM closes the
    LISTENER (the death becomes visible — new connects are refused) while the
    process stays up to drain the in-flight request; a second SIGTERM exits
    immediately. The spawner's stop() nudges on exactly this protocol."""

    def _spawn(self, argv, server_url=None):
        import subprocess

        env = dict(os.environ, **TEST_ENV)
        if server_url is not None:
            # the real /health PROBES the letta server; a closed loopback port
            # refuses instantly (a fake hostname would hang in mDNS/DNS past
            # the test's HTTP timeouts)
            env["LETTA_SERVER_URL"] = server_url
        env["PYTHONPATH"] = os.path.dirname(os.path.abspath(letta_sidecar.__file__))
        return subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_idle_stop_exits_cleanly_on_the_first_sigterm(self):
        import signal

        proc = self._spawn([sys.executable, letta_sidecar.__file__], server_url="http://127.0.0.1:1")
        try:
            port = int(_stderr_line(proc, "LETTA_SIDECAR_READY").split()[1])
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
        # A fake Letta client whose agents.create() BLOCKS until a sentinel file
        # appears — the only way to observe the drain window from outside the
        # process. (The /add path blocks inside create: the run agent does not
        # exist yet, and the sidecar never creates agents outside a request.)
        import signal
        import tempfile

        store = tempfile.mkdtemp(prefix="letta-stop-drain-")
        release = os.path.join(store, "release")
        driver = (
            "import os, sys, time\n"
            "import letta_sidecar\n"
            f"RELEASE = {release!r}\n"
            "class Blocked:\n"
            "    id = 'agent-blocked-fake'\n"
            "class BlockingAgents:\n"
            "    passages = None\n"
            "    def create(self, **k):\n"
            "        sys.stderr.write('ADD_INFLIGHT\\n'); sys.stderr.flush()\n"
            "        deadline = time.time() + 60\n"
            "        while not os.path.exists(RELEASE) and time.time() < deadline:\n"
            "            time.sleep(0.05)\n"
            "        return Blocked()\n"
            "class BlockingClient:\n"
            "    def __init__(self, client_kwargs):\n"
            "        self.agents = BlockingAgents()\n"
            "    def health(self):\n"
            "        return type('Health', (), {'version': '0.16.8'})()\n"
            "letta_sidecar.main(client_factory=lambda kwargs: BlockingClient(kwargs))\n"
        )
        proc = self._spawn([sys.executable, "-c", driver])
        try:
            port = int(_stderr_line(proc, "LETTA_SIDECAR_READY").split()[1])

            # POST /add in the background; wait until the handler is inside it
            def post_add():
                try:
                    post(f"http://127.0.0.1:{port}/add", {"user_id": "u", "messages": [{"role": "user", "content": "x"}]})
                except Exception:
                    pass  # the process exits mid-request on the second signal

            import threading

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

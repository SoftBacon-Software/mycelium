"""Hermetic unittest for the mempalace benchmark sidecar (the CONTROL arm).

Exercises the REAL HTTP surface (make_handler + SidecarState on an ephemeral
127.0.0.1 port) and the REAL MempalaceRuntime mapping code, with a FAKE
mcp_server injected at the runtime's `_tools` seam — the fake returns
product-shaped envelopes ({success, drawer_id, chunks} / tool_search's
{results, total_before_filter}), so the normalization (text→memory,
similarity→score, source_path→session_index) is under test, not re-typed. No
network beyond 127.0.0.1, no model calls, no mempalace import (the module is
stdlib-only; the product import happens lazily inside the real runtime only).

Run (any python3 works; the module is stdlib-only):

    bench/memory/.venvs/mempalace/bin/python -m unittest -v bench/memory/arms/test_mempalace_sidecar.py
    # or: cd bench/memory/arms && python3 -m unittest -v test_mempalace_sidecar
"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from contextlib import contextmanager
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mempalace_sidecar  # noqa: E402


def _tmp_dirs():
    return tempfile.mkdtemp(prefix="mp263-config-"), tempfile.mkdtemp(prefix="mp263-palace-")


CONFIG_DIR, PALACE_DIR = _tmp_dirs()

TEST_ENV = {
    "MEMPALACE_CONFIG_DIR": CONFIG_DIR,
    "MEMPALACE_PALACE_PATH": PALACE_DIR,
}


class FakeMcp:
    """Stands in for mempalace.mcp_server — exactly the surface the runtime
    drives: tool_add_drawer / tool_search / tool_status. Returns the PRODUCT's
    own envelope shapes (verified against the pinned source), so the runtime's
    mapping runs for real."""

    def __init__(self):
        self.drawers = []
        self.searches = []
        self.drawers_store = []
        self.fail_add = None  # envelope returned instead of success
        self.fail_search = None
        self.search_results = []
        self.total_before_filter = 0
        self.status = {"total_drawers": 7, "wings": {"bench-p1-run1": 7}, "rooms": {}}

    def tool_add_drawer(self, **kwargs):
        self.drawers.append(kwargs)
        if self.fail_add is not None:
            return self.fail_add
        drawer_id = f"drawer-{len(self.drawers_store) + 1}-fake"
        self.drawers_store.append({"drawer_id": drawer_id, **kwargs})
        self.status["total_drawers"] = len(self.drawers_store)
        return {"success": True, "drawer_id": drawer_id, "wing": kwargs.get("wing"), "room": kwargs.get("room"), "chunks": 3}

    def tool_search(self, query, limit=None, **kwargs):
        self.searches.append({"query": query, "limit": limit, **kwargs})
        if self.fail_search is not None:
            return self.fail_search
        return {
            "query": query,
            "filters": {},
            "total_before_filter": self.total_before_filter,
            "results": self.search_results[: limit if isinstance(limit, int) else None],
            "distance_metric": "cosine",
        }

    def tool_status(self):
        return self.status


def make_runtime_factory(holder):
    """runtime_factory seam: the REAL MempalaceRuntime, with its product import
    pre-bound to ONE FakeMcp — the mapping code is exercised, the product is
    not imported."""

    class Factory:
        def __call__(self, facts):
            if holder.get("runtime") is None:
                rt = mempalace_sidecar.MempalaceRuntime(facts)
                rt._tools = holder.setdefault("fake", FakeMcp())
                holder["runtime"] = rt
            return holder["runtime"]

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
    """Next stderr line starting with `prefix` (the sidecar signals on stderr).
    select-enforced: readline() alone would block past any deadline when the
    child never produces the line."""
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
        state = mempalace_sidecar.SidecarState(env=dict(TEST_ENV), runtime_factory=make_runtime_factory(self.holder))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), mempalace_sidecar.make_handler(state))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.state = state

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    @property
    def fake(self):
        # force the runtime to build (the /health probe does this too)
        return self.holder["fake"]

    # ---------------- /health ------------------------------------------------

    def test_health_reports_facts_and_the_product_status(self):
        status, body = get(f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["mempalace_version_under_test"], "3.12.0")
        self.assertEqual(
            body["pin"],
            {
                "commit": "84582fb055a6429261f9c779da86c0561ec80adc",
                "tarball_sha256": "fabe6c765c16fb43b300ddb9f17de44c9f2f3dc6a19e885514fe1659504d762d",
            },
        )
        self.assertEqual(body["embedder"]["model"], "minilm")  # the product default, as-shipped
        self.assertEqual(body["embedder"]["dims"], 384)
        self.assertEqual(body["palace"]["path"], PALACE_DIR)
        self.assertTrue(body["raw_mode"])  # verbatim drawers — no LLM in the write path
        self.assertFalse(body["llm_rerank"])  # the rerank surface is never invoked
        self.assertFalse(body["aaak"])  # the compression feature is never invoked
        self.assertIn("product's own mcp_server tools", body["storage"])
        self.assertIn("never raw chromadb", body["storage"])  # the flaw the control arm exists to avoid
        # the product's own status rides along (drawers, wings)
        self.assertEqual(body["total_drawers"], 7)
        # the version stamp matches iff the installed package reports the pin
        self.assertEqual(body["mempalace_version_matches"], body["mempalace_version"] == "3.12.0")

    def test_health_with_the_palace_dir_missing_is_ok_false_and_names_it(self):
        os.rmdir(PALACE_DIR)
        try:
            status, body = get(f"{self.base}/health")
            self.assertEqual(status, 200)
            self.assertFalse(body["ok"])  # the LOCAL store is the ok gate (unlike letta's remote probe)
            self.assertIn(PALACE_DIR, body["error"])
        finally:
            os.mkdir(PALACE_DIR)

    # ---------------- /add ---------------------------------------------------

    def test_add_validates_loudly(self):
        for payload, needle in [
            ({"messages": [{"role": "user", "content": "x"}]}, "user_id"),
            ({"user_id": "u"}, "messages"),
            ({"user_id": "u", "messages": []}, "messages"),
            ({"user_id": "u", "messages": "not-a-list"}, "messages"),
            ({"user_id": "u", "messages": [{"role": "user"}]}, "content"),
            ({"user_id": "u", "messages": [{"role": "user", "content": 5}]}, "content"),
        ]:
            status, body = post(f"{self.base}/add", payload)
            self.assertEqual(status, 400, f"expected 400 for {payload}")
            self.assertIn(needle, body["error"])
        self.assertEqual(self.fake.drawers, [])  # nothing reached the product

    def test_add_files_ONE_verbatim_drawer_per_session_with_the_provenance_source(self):
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
        self.assertEqual(body["count"], 3)  # the product's own chunk count, passed through
        self.assertTrue(body["drawer_id"].startswith("drawer-"))
        self.assertEqual(len(self.fake.drawers), 1)  # ONE drawer per session — not per turn
        drawer = self.fake.drawers[0]
        self.assertEqual(drawer["content"], "user: I am moving to Lisbon in the spring.\nassistant: Lisbon is a great choice.")
        self.assertEqual(drawer["wing"], "bench-p1-run1")  # the run scope
        self.assertEqual(drawer["room"], "q-9")  # the question
        self.assertEqual(drawer["source_file"], "bench/q-9/session_2.txt")  # the session provenance tag
        self.assertEqual(drawer["added_by"], "bench")

    def test_add_without_metadata_defaults_to_question_unknown_session_0(self):
        status, body = post(f"{self.base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(status, 200)
        self.assertEqual(self.fake.drawers[0]["source_file"], "bench/unknown/session_0.txt")

    def test_a_product_failure_envelope_is_a_LOUD_500(self):
        self.fake.fail_add = {"success": False, "error": "wing name rejected"}
        status, body = post(f"{self.base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "x"}]})
        self.assertEqual(status, 500)
        self.assertIn("wing name rejected", body["error"])

    # ---------------- /search ------------------------------------------------

    def _seed_hits(self):
        self.fake.total_before_filter = 20  # the product over-fetched 4x before ranking
        self.fake.search_results = [
            {
                "drawer_id": "drawer-1",
                "text": "user: I am moving to Lisbon in the spring.",
                "wing": "bench-p1-run1",
                "room": "q-9",
                "source_file": "session_0.txt",
                "source_path": "/tmp/mp/bench/q-9/session_0.txt",
                "similarity": 0.658,
                "distance": 0.342,
                "bm25_score": 0.0,
                "matched_via": "vector",
            },
            {
                "drawer_id": "drawer-2",
                "text": "user: My manager is Dana now.",
                "wing": "bench-p1-run1",
                "room": "q-9",
                "source_file": "session_3.txt",
                "source_path": "/tmp/mp/bench/q-9/session_3.txt",
                "similarity": 0.551,
                "distance": 0.449,
            },
        ]

    def test_search_passes_the_budget_and_maps_the_product_envelope(self):
        post(f"{self.base}/add", {"user_id": "s", "messages": [{"role": "user", "content": "seed"}]})
        self._seed_hits()
        status, body = post(f"{self.base}/search", {"query": "Which city am I moving to?", "user_id": "s", "limit": 5})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(self.fake.searches[-1]["limit"], 5)  # the budget is honoured exactly
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["candidates_fetched"], 20)  # stamped: the pool the product ranked
        r = body["results"][0]
        self.assertEqual(r["memory"], "user: I am moving to Lisbon in the spring.")
        self.assertEqual(r["score"], 0.658)  # similarity, renamed
        self.assertEqual(r["id"], "drawer-1")
        self.assertEqual(r["session_index"], 0)  # parsed back from source_path (task 207)
        self.assertEqual(body["results"][1]["session_index"], 3)
        self.assertEqual(body["results"][1]["room"], "q-9")

    def test_search_honours_a_budget_smaller_than_the_hit_count(self):
        self._seed_hits()
        status, body = post(f"{self.base}/search", {"query": "q", "user_id": "s", "limit": 1})
        self.assertEqual(body["count"], 1)  # limit=1 -> one result, never defaulted

    def test_search_never_defaults_the_budget(self):
        for limit in [None, 0, -1, 2.5, "5"]:
            status, body = post(f"{self.base}/search", {"query": "q", "user_id": "s", "limit": limit})
            self.assertEqual(status, 400, f"expected 400 for limit={limit!r}")
            self.assertIn("limit", body["error"])

    def test_search_validates_query_and_user_id(self):
        for payload, needle in [
            ({"query": "q", "limit": 5}, "user_id"),
            ({"user_id": "s", "limit": 5}, "query"),
            ({"user_id": "s", "query": "", "limit": 5}, "query"),
        ]:
            status, body = post(f"{self.base}/search", payload)
            self.assertEqual(status, 400, f"expected 400 for {payload}")
            self.assertIn(needle, body["error"])

    def test_a_product_search_error_is_a_LOUD_500(self):
        self.fake.fail_search = {"error": "No palace found"}
        status, body = post(f"{self.base}/search", {"query": "q", "user_id": "s", "limit": 5})
        self.assertEqual(status, 500)
        self.assertIn("No palace found", body["error"])

    # ---------------- protocol hygiene ----------------------------------------

    def test_unknown_route_is_404_and_bad_json_is_400(self):
        status, body = post(f"{self.base}/nope", {"a": 1})
        self.assertEqual(status, 404)
        status, body = get(f"{self.base}/nope")
        self.assertEqual(status, 404)
        status, body = post(f"{self.base}/add", None, raw=b"not json")
        self.assertEqual(status, 400)
        status, body = post(f"{self.base}/add", None, raw=b"")  # empty body
        self.assertEqual(status, 400)

    # ---------------- config ----------------------------------------------------

    def test_config_requires_the_per_run_dirs_and_fails_loud(self):
        for missing in ["MEMPALACE_CONFIG_DIR", "MEMPALACE_PALACE_PATH"]:
            env = {k: v for k, v in TEST_ENV.items() if k != missing}
            with self.assertRaises(ValueError) as ctx:
                mempalace_sidecar.config_from_env(env)
            self.assertIn(missing, str(ctx.exception))

    def test_config_stamps_the_control_arm_facts(self):
        facts = mempalace_sidecar.config_from_env(dict(TEST_ENV, MEMPALACE_EMBEDDING_MODEL="minilm"))
        self.assertEqual(facts["mempalace_version_under_test"], mempalace_sidecar.MEMPALACE_VERSION_UNDER_TEST)
        self.assertTrue(facts["raw_mode"])
        self.assertFalse(facts["llm_rerank"])
        self.assertFalse(facts["aaak"])
        self.assertEqual(facts["embedder"]["dims"], 384)
        self.assertEqual(facts["palace"]["path"], PALACE_DIR)

    def test_flatten_session_prefixes_roles_and_joins_newlines(self):
        text = mempalace_sidecar.flatten_session([{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}])
        self.assertEqual(text, "user: a\nassistant: b")

    def test_session_index_parses_from_the_provenance_source_or_stays_none(self):
        f = mempalace_sidecar.session_index_from_source
        self.assertEqual(f("/tmp/mp/bench/q-9/session_0.txt"), 0)
        self.assertEqual(f("/tmp/mp/bench/q-9/session_12.txt"), 12)
        self.assertEqual(f("bench/q-9/session_000.txt"), 0)  # zero-padded still parses
        self.assertIsNone(f(None))
        self.assertIsNone(f(""))
        self.assertIsNone(f("bench/q-9/summary.txt"))  # an unexpected shape stamps null — never a guess
        self.assertIsNone(f("bench/q-9/session_x.txt"))


@contextmanager
def sidecar_server(env):
    """A real HTTP sidecar over an injected fake product, on an ephemeral port."""
    holder = {}
    state = mempalace_sidecar.SidecarState(env=dict(env), runtime_factory=make_runtime_factory(holder))
    server = ThreadingHTTPServer(("127.0.0.1", 0), mempalace_sidecar.make_handler(state, mempalace_sidecar.Inflight()))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state, holder, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


class InflightTest(unittest.TestCase):
    """The drain counter: a deferred stop waits for the in-flight add, and the
    wait times out honestly rather than hanging forever."""

    def test_wait_zero_times_out_while_a_request_is_open_then_true_after_release(self):
        inflight = mempalace_sidecar.Inflight()
        with inflight:
            self.assertFalse(inflight.wait_zero(0.05))  # still in-flight -> honest timeout
        self.assertTrue(inflight.wait_zero(0.05))  # released -> True

    def test_wait_zero_blocks_until_a_concurrent_request_exits(self):
        import time

        inflight = mempalace_sidecar.Inflight()
        result = {}

        def waiter():
            result["ok"] = inflight.wait_zero(5)

        with inflight:
            t = threading.Thread(target=waiter, daemon=True)
            t.start()
            time.sleep(0.05)
            self.assertFalse(result)  # still blocked inside the open request
        t.join(timeout=5)
        self.assertTrue(result["ok"])  # released by the with-block exit


class TwoStageStopProtocolTest(unittest.TestCase):
    """The subprocess stop protocol, for real: first SIGTERM closes the
    LISTENER (the death becomes visible — new connects are refused) while the
    process stays up to drain the in-flight request; a second SIGTERM exits
    immediately. The spawner's stop() nudges on exactly this protocol."""

    def _spawn(self, driver, palace_dir):
        import subprocess

        env = dict(
            os.environ,
            MEMPALACE_CONFIG_DIR=CONFIG_DIR,
            MEMPALACE_PALACE_PATH=palace_dir,
            PYTHONPATH=os.path.dirname(os.path.abspath(mempalace_sidecar.__file__)),
        )
        return subprocess.Popen([sys.executable, "-c", driver], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_idle_stop_exits_cleanly_on_the_first_sigterm(self):
        import signal

        proc = self._spawn("import mempalace_sidecar\nmempalace_sidecar.main()\n", PALACE_DIR)
        try:
            port = int(_stderr_line(proc, "MEMPALACE_SIDECAR_READY").split()[1])
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
        # A fake runtime whose add_session() BLOCKS until a sentinel file
        # appears — the only way to observe the drain window from outside the
        # process. (The /add path blocks inside add_session: the product write
        # is the slow part the teardown must not truncate.)
        import signal

        store = tempfile.mkdtemp(prefix="mp263-stop-drain-")
        release = os.path.join(store, "release")
        palace = tempfile.mkdtemp(prefix="mp263-stop-palace-")
        driver = (
            "import os, sys, time\n"
            "import mempalace_sidecar\n"
            f"RELEASE = {release!r}\n"
            "class Blocked:\n"
            "    pass\n"
            "class BlockingRuntime:\n"
            "    def __init__(self, facts):\n"
            "        self.facts = facts\n"
            "    def status(self):\n"
            "        return {'total_drawers': 0}\n"
            "    def add_session(self, wing, room, text, source_file):\n"
            "        sys.stderr.write('ADD_INFLIGHT\\n'); sys.stderr.flush()\n"
            "        deadline = time.time() + 60\n"
            "        while not os.path.exists(RELEASE) and time.time() < deadline:\n"
            "            time.sleep(0.05)\n"
            "        return 'drawer-blocked', 1\n"
            "    def search(self, query, limit):\n"
            "        return [], 0\n"
            "mempalace_sidecar.main(runtime_factory=lambda facts: BlockingRuntime(facts))\n"
        )
        proc = self._spawn(driver, palace)
        try:
            port = int(_stderr_line(proc, "MEMPALACE_SIDECAR_READY").split()[1])

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

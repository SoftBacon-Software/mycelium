"""Unit tests for tools/trajectory.py — episodes ⇄ Letta trajectory v1 (task 243).

No network: a fake runner records the curl argv and answers from a canned
queue. The round trip pinned here is the brief's acceptance test:

    transcript turns -> episodes -> export -> records -> ingest -> episodes
    with BYTE-IDENTICAL content_text and the traj_role restored via sidecar.

The export output is ALSO validated against the REAL v1 schema file
(tools/trajectory-v1.schema.json) with the jsonschema library when it is
importable — the tool's hand validator mirrors that schema, and this test is
what proves the mirror. Run with a python that has pytest + jsonschema:

    /Users/grb/Projects/mycelium-agent/.venv/bin/python -m pytest tools/test_trajectory.py -q
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("trajectory", HERE / "trajectory.py")
traj = importlib.util.module_from_spec(spec)
sys.modules["trajectory"] = traj
spec.loader.exec_module(traj)


class FakeRunner:
    """Records argv; answers each call with the next canned (status, body),
    as RAW curl output — body + the `-w` status trailer. Status parsing is
    the client's job (_parse_response), so a >=400 here raises THERE."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, argv, stdin_bytes):
        self.calls.append({"argv": argv, "stdin": stdin_bytes})
        status, body = self.responses.pop(0)
        return json.dumps(body) + f"\n{status}"


def _fake_out(status, body):
    # mirrors _curl_run's "-w \n%{http_code}" trailer contract
    return json.dumps(body) + f"\n{status}"


def _client(responses):
    runner = FakeRunner(responses)
    client = traj.CurlClient(url="http://fake.test/api/mycelium", admin_key="k", runner=runner)
    return client, runner


EPISODE_ROW = {
    "source_type": "episode",
    "source_id": "episode:abc",
    "content_text": "Deploy the staging build after the index rebuild finishes",
    "created_at": "2026-09-19T14:22:05.123Z",
    "metadata": {"agent": "mycelium-agent", "session_date": "2026-09-19",
                 "session_id": "sess_9", "origin": "hermes-turn:sess_9", "seq": 2,
                 "writer": "mycelium-agent-plugin"},
}


# ---------------------------------------------------------------- validator --

def test_validator_accepts_every_v1_variant():
    records = [
        {"role": "meta", "source": "letta", "cwd": "/x", "model": "m"},
        {"role": "user", "content": "hello", "timestamp": "2026-09-19T10:00:00Z"},
        {"role": "observation", "content": "observed", "timestamp": "2026-09-19T10:00:00+02:00"},
        {"role": "assistant", "content": None,
         "timestamp": "2026-09-19T10:00:01Z",
         "tool_calls": [{"id": "c1", "name": "shell", "args": "{\"cmd\":\"ls\"}"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "out", "ok": True,
         "timestamp": "2026-09-19T10:00:02Z"},
    ]
    assert traj.validate_records(records) == []


def test_validator_refuses_extension_fields_and_bad_stamps():
    errors = traj.validate_records([
        {"role": "user", "content": "x", "timestamp": "2026-09-19T10:00:00Z",
         "supersedes": "episode:old"},                      # additionalProperties:false
        {"role": "system", "content": "x", "timestamp": "2026-09-19 10:00:00"},  # not ISO-T
        {"role": "reasoning", "content": 5, "timestamp": "2026-09-19T10:00:00Z"},
        {"role": "tool", "tool_call_id": "c", "content": "x"},  # timestamp missing
    ])
    assert len(errors) == 4
    assert any("supersedes" in e for e in errors)
    assert any("timestamp does not match" in e for e in errors)


def test_validator_refuses_empty_and_nondict():
    assert traj.validate_records([]) == ["empty trajectory (v1 requires minItems 1)"]
    assert len(traj.validate_records(["nope"])) == 1


def test_hand_validator_agrees_with_the_real_schema():
    """The mirror is proven against the shipped schema: valid files pass both,
    defective files fail both, same direction."""
    js = pytest.importorskip("jsonschema")
    schema = json.loads((HERE / "trajectory-v1.schema.json").read_text())
    validate = js.Draft202012Validator(schema)
    good = [
        {"role": "user", "content": "q", "timestamp": "2026-09-19T10:00:00Z"},
        {"role": "assistant", "content": "a", "timestamp": "2026-09-19T10:00:01.5+02:00"},
    ]
    assert traj.validate_records(good) == []
    assert list(validate.iter_errors(good)) == []
    for bad in (
        [{"role": "user", "content": "q", "timestamp": "nope"}],
        [{"role": "user", "content": "q", "timestamp": "2026-09-19T10:00:00Z", "extra": 1}],
        [{"role": "tool", "tool_call_id": "c", "content": "x", "timestamp": "2026-09-19T10:00:00Z"}],
        [],
    ):
        ours = traj.validate_records(bad)
        theirs = list(validate.iter_errors(bad))
        assert bool(ours) == bool(theirs), (bad, ours, theirs)


# ------------------------------------------------------------------- export --

def _export_env(rows, tmp_path):
    client, runner = _client([(200, {"source_type": "episode", "count": len(rows), "results": rows})])
    out = tmp_path / "traj.json"
    rc = traj.main(["export", "--agent", "mycelium-agent", "--session-id", "sess_9",
                    "--out", str(out), "--url", "http://fake.test/api/mycelium"], client=client)
    return rc, out, runner


def test_export_writes_v1_records_and_sidecar(tmp_path):
    rc, out, runner = _export_env([EPISODE_ROW], tmp_path)
    assert rc == 0
    records = json.loads(out.read_text())
    assert records == [{"role": "observation",
                        "content": EPISODE_ROW["content_text"],
                        "timestamp": "2026-09-19T14:22:05.123Z"}]
    sidecar = json.loads((tmp_path / "traj.json.mycelium.json").read_text())
    assert sidecar["format"] == traj.SIDECAR_FORMAT
    assert sidecar["records"]["0"]["metadata"]["episode_source_id"] == "episode:abc"
    assert sidecar["records"]["0"]["metadata"]["session_date"] == "2026-09-19"
    # transport was curl with the admin header
    argv = runner.calls[0]["argv"]
    assert argv[0] == "curl" and any("X-Admin-Key: k" in a for a in argv)
    assert "/memory/episodes?agent=mycelium-agent&namespace=lab&limit=500" in argv[argv.index("-X") + 2]


def test_export_orders_by_seq_and_derives_stamp_from_session_date(tmp_path):
    late = dict(EPISODE_ROW, source_id="episode:z", content_text="second thing",
                metadata=dict(EPISODE_ROW["metadata"], seq=9))
    early = dict(EPISODE_ROW, source_id="episode:a", content_text="first thing",
                 created_at=None, metadata=dict(EPISODE_ROW["metadata"], seq=1))
    rc, out, _ = _export_env([late, early], tmp_path)
    assert rc == 0
    records = json.loads(out.read_text())
    assert [r["content"] for r in records] == ["first thing", "second thing"]
    # no created_at -> the stated session_date T00:00:00Z derivation
    assert records[0]["timestamp"] == "2026-09-19T00:00:00Z"


def test_export_filters_to_the_session_and_counts_non_text(tmp_path):
    other = dict(EPISODE_ROW, source_id="episode:other",
                 metadata=dict(EPISODE_ROW["metadata"], session_id="sess_OTHER"))
    textless = dict(EPISODE_ROW, source_id="episode:nope", content_text=None)
    rc, out, _ = _export_env([other, textless, EPISODE_ROW], tmp_path)
    assert rc == 0
    assert len(json.loads(out.read_text())) == 1
    sidecar = json.loads((tmp_path / "traj.json.mycelium.json").read_text())
    assert [n["episode_source_id"] for n in sidecar["non_text"]] == ["episode:nope"]


def test_export_restores_traj_role_from_the_row(tmp_path):
    row = dict(EPISODE_ROW, content_text="it failed on the retry cap",
               metadata=dict(EPISODE_ROW["metadata"], traj_role="assistant", seq=3))
    rc, out, _ = _export_env([row], tmp_path)
    assert rc == 0
    (rec,) = json.loads(out.read_text())
    assert rec["role"] == "assistant" and rec["content"] == "it failed on the retry cap"


def test_tool_records_export_with_their_call_id_and_ok(tmp_path):
    row = dict(EPISODE_ROW, content_text="gate output: 3 passed",
               metadata=dict(EPISODE_ROW["metadata"], traj_role="tool",
                             traj_tool_call_id="call_7", traj_ok=True, seq=4))
    rc, out, _ = _export_env([row], tmp_path)
    assert rc == 0
    (rec,) = json.loads(out.read_text())
    assert rec == {"role": "tool", "tool_call_id": "call_7", "content": "gate output: 3 passed",
                   "ok": True, "timestamp": EPISODE_ROW["created_at"]}


# ------------------------------------------------------------------- ingest --

def test_ingest_writes_provenanced_episode_rows(tmp_path):
    traj_file = tmp_path / "in.json"
    traj_file.write_text(json.dumps([
        {"role": "user", "content": "Where did the DeploymentPlan step go?",
         "timestamp": "2026-09-19T09:00:00Z"},
        {"role": "meta", "source": "letta", "model": "gemini-2.5-pro"},
    ]))
    client, runner = _client([(200, {"ok": True})] * 2)
    rc = traj.main(["ingest", str(traj_file), "--agent", "mycelium-agent",
                    "--session-date", "2026-09-19", "--session-id", "sess_ing",
                    "--url", "http://fake.test/api/mycelium"], client=client)
    assert rc == 0
    (call,) = runner.calls  # the meta record produced NO post
    row = json.loads(call["stdin"])
    assert row["source_type"] == "episode"
    assert row["content_text"] == "Where did the DeploymentPlan step go?"
    meta = row["metadata"]
    assert meta["agent"] == "mycelium-agent" and meta["session_date"] == "2026-09-19"
    assert meta["session_id"] == "sess_ing" and meta["origin"] == "trajectory:in.json"
    assert meta["traj_role"] == "user" and meta["traj_index"] == 0
    assert meta["traj_timestamp"] == "2026-09-19T09:00:00Z"


def test_ingest_is_idempotent_on_the_same_file(tmp_path):
    traj_file = tmp_path / "in.json"
    traj_file.write_text(json.dumps([
        {"role": "user", "content": "same words", "timestamp": "2026-09-19T09:00:00Z"}]))
    client, runner = _client([(200, {"ok": True})])
    traj.main(["ingest", str(traj_file), "--agent", "a", "--session-date", "2026-09-19",
               "--session-id", "s", "--url", "http://fake.test/api/mycelium"], client=client)
    row1 = json.loads(runner.calls[0]["stdin"])
    client2, runner2 = _client([(200, {"ok": True})])
    traj.main(["ingest", str(traj_file), "--agent", "a", "--session-date", "2026-09-19",
               "--session-id", "s", "--url", "http://fake.test/api/mycelium"], client=client2)
    assert json.loads(runner2.calls[0]["stdin"])["source_id"] == row1["source_id"]


def test_ingest_refuses_invalid_files_and_missing_provenance(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps([{"role": "user", "content": "x", "timestamp": "now",
                                "extension_field": 1}]))
    client, _ = _client([])
    rc = traj.main(["ingest", str(bad), "--agent", "a", "--session-date", "2026-09-19",
                    "--url", "http://fake.test/api/mycelium"], client=client)
    assert rc == 2
    good = tmp_path / "good.json"
    good.write_text(json.dumps([{"role": "user", "content": "x",
                                 "timestamp": "2026-09-19T09:00:00Z"}]))
    client2, runner2 = _client([])
    rc = traj.main(["ingest", str(good), "--url", "http://fake.test/api/mycelium"], client=client2)
    assert rc == 2  # no agent/session_date anywhere -> the gate refuses
    assert runner2.calls == []  # nothing was posted


def test_ingest_assistant_tool_calls_record_is_skipped_by_count(tmp_path):
    traj_file = tmp_path / "in.json"
    traj_file.write_text(json.dumps([
        {"role": "assistant", "content": None, "timestamp": "2026-09-19T09:00:00Z",
         "tool_calls": [{"id": "c1", "name": "shell", "args": "{}"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "the tool's own output",
         "ok": False, "timestamp": "2026-09-19T09:00:01Z"},
    ]))
    client, runner = _client([(200, {"ok": True})])
    rc = traj.main(["ingest", str(traj_file), "--agent", "a", "--session-date", "2026-09-19",
                    "--url", "http://fake.test/api/mycelium"], client=client)
    assert rc == 0
    (call,) = runner.calls
    row = json.loads(call["stdin"])
    assert row["content_text"] == "the tool's own output"  # the tool record DID become an episode
    assert row["metadata"]["traj_role"] == "tool"
    assert row["metadata"]["traj_tool_call_id"] == "c1" and row["metadata"]["traj_ok"] is False


def test_ingest_dry_run_makes_zero_calls_and_renders_a_row(tmp_path, capsys):
    traj_file = tmp_path / "in.json"
    traj_file.write_text(json.dumps([
        {"role": "user", "content": "dry run me", "timestamp": "2026-09-19T09:00:00Z"}]))
    client, runner = _client([])
    rc = traj.main(["ingest", str(traj_file), "--agent", "a", "--session-date", "2026-09-19",
                    "--dry-run", "--url", "http://fake.test/api/mycelium"], client=client)
    assert rc == 0 and runner.calls == []
    out = capsys.readouterr().out
    assert "episodes=1" in out and "dry run me" in out


def test_ingest_sidecar_rides_original_metadata_under_this_ingests_provenance(tmp_path):
    traj_file = tmp_path / "in.json"
    traj_file.write_text(json.dumps([
        {"role": "user", "content": "carried", "timestamp": "2026-09-19T09:00:00Z"}]))
    sidecar = tmp_path / "in.json.mycelium.json"
    sidecar.write_text(json.dumps({
        "format": traj.SIDECAR_FORMAT, "agent": "old-agent", "session_id": "old-sess",
        "session_date": "2026-09-01", "records": {"0": {"format": traj.SIDECAR_FORMAT,
            "metadata": {"agent": "old-agent", "session_date": "2026-09-01",
                         "session_id": "old-sess", "origin": "hermes-turn:old",
                         "claimed_kind": "factual", "source_authority": "inferred"}}},
        "non_text": []}))
    client, runner = _client([(200, {"ok": True})])
    rc = traj.main(["ingest", str(traj_file), "--sidecar", str(sidecar),
                    "--agent", "new-agent", "--session-date", "2026-09-19",
                    "--session-id", "new-sess",
                    "--url", "http://fake.test/api/mycelium"], client=client)
    assert rc == 0
    meta = json.loads(runner.calls[0]["stdin"])["metadata"]
    # THIS ingest's provenance wins; the original episode's extra keys ride along
    assert meta["agent"] == "new-agent" and meta["session_id"] == "new-sess"
    assert meta["claimed_kind"] == "factual" and meta["source_authority"] == "inferred"
    assert meta["origin"] == "trajectory:in.json"


# --------------------------------------------------------------- round trip --

def test_round_trip_episodes_export_ingest_episodes_byte_identical(tmp_path):
    """THE brief's acceptance test: turns -> episodes -> export -> records ->
    ingest -> episodes, byte-identical text, traj_role restored, sidecar keys
    never dropped."""
    turns = [
        ("user", "Which scenario planted the $10 discrepancy?"),
        ("assistant", "C2_settlement — the appraisal tax line, misread 151.72 as 161.72."),
        ("tool", "checker output: 15 of 20 failing runs never re-derived the total"),
    ]
    rows = []
    for i, (role, text) in enumerate(turns):
        rows.append(dict(EPISODE_ROW, source_id=f"episode:{i}", content_text=text,
                         metadata=dict(EPISODE_ROW["metadata"], seq=i, traj_role=role,
                                       **({"traj_tool_call_id": "c" + str(i)} if role == "tool" else {}))))
    # --- export
    client, _ = _client([(200, {"source_type": "episode", "count": 3, "results": rows})])
    out = tmp_path / "rt.json"
    rc = traj.main(["export", "--agent", "mycelium-agent", "--session-id", "sess_9",
                    "--out", str(out), "--url", "http://fake.test/api/mycelium"], client=client)
    assert rc == 0
    # the exported file validates against the REAL v1 schema (when the library
    # is present — the tool's own validator already refused anything invalid)
    try:
        import jsonschema as _js
    except ImportError:
        _js = None
    if _js is not None:
        schema = json.loads((HERE / "trajectory-v1.schema.json").read_text())
        assert list(_js.Draft202012Validator(schema).iter_errors(json.loads(out.read_text()))) == []
    # --- ingest (against a fresh platform)
    client2, runner2 = _client([(200, {"ok": True})] * 3)
    rc = traj.main(["ingest", str(out), "--sidecar", str(out) + traj.SIDECAR_SUFFIX,
                    "--agent", "mycelium-agent", "--session-date", "2026-09-19",
                    "--session-id", "sess_9", "--url", "http://fake.test/api/mycelium"],
                   client=client2)
    assert rc == 0
    landed = [json.loads(c["stdin"]) for c in runner2.calls]
    assert [r["content_text"] for r in landed] == [t[1] for t in turns]  # byte-identical
    assert [r["metadata"]["traj_role"] for r in landed] == [t[0] for t in turns]
    assert landed[2]["metadata"]["traj_tool_call_id"] == "c2"
    assert all(r["metadata"]["agent"] == "mycelium-agent" and r["metadata"]["session_date"]
               == "2026-09-19" for r in landed)  # the platform gate would 400 otherwise


def test_ingest_platform_refusal_is_a_row_failure_not_a_crash(tmp_path):
    traj_file = tmp_path / "in.json"
    traj_file.write_text(json.dumps([
        {"role": "user", "content": "one", "timestamp": "2026-09-19T09:00:00Z"},
        {"role": "user", "content": "two", "timestamp": "2026-09-19T09:00:01Z"}]))
    client, _ = _client([(400, {"error": "refuseIfUnprovenanced"}), (200, {"ok": True})])
    rc = traj.main(["ingest", str(traj_file), "--agent", "a", "--session-date", "2026-09-19",
                    "--url", "http://fake.test/api/mycelium"], client=client)
    assert rc == 3  # the failure is the exit code, not an exception

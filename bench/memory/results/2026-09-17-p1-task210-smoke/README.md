# task 210 — the flag path's first arm-level smoke (MYCELIUM_TIMELINE_FACTS=am_facts through the real run.mjs CLI)

2026-09-17, lane F-mycelium, worktree `/private/tmp/myc-tl-merge`, branch
`bench/m5max/timeline-merged` (merge commit dc6942a4 = 219ba34d + c4fc94be, plus the
smoke-commit fixes noted at the bottom). Server under test: **a scratch boot of THIS
worktree** — `/health` reported `commit_sha dc6942a4` (both blockers below are
quoted verbatim; the model legs are SCRIPTED and stamped as such — everything
else is the real harness).

## Why the model legs are scripted (both real answerers lane-blocked, verbatim)

The brief's command implies a real answerer. Neither was available to a lane:

1. The 3090's single slot was held by the DIRECTOR's live n=50 timeline run
   (visible in `ps`: `node bench/memory/run.mjs --split longmemeval --arms
   mycelium-timeline --n 50 --receipt`, pid 1181, 4h28m elapsed at check time).
   The bench slot lock refuses a second holder; a lane does not contend.
2. The Mac's served oMLX seat (`:8780`) 503s every model LOAD under the
   a84-sftmix heavy lock (a lane may not restart it). One probe, verbatim:

   ```
   {"error":{"message":"Cannot load Laguna-XS-2.1-oq4e-agentic-r2c-lora: a machine-wide heavy load is in progress ('a84-sftmix', pid 1512, held 3936s). Loading now would overcommit the box. Retry in ~30s.","type":"server_error","param":null,"code":null}}
   ```

So the chat endpoint is `fake-chat.mjs` (scripted extraction / reconcile decision
/ judge / answer; every request logged to `fake-chat-requests.ndjson`), and the
embedding provider is `fake-embedder.mjs` (the 206 pattern: ollama shape,
constant 2-dim vector, full index path runs). The ROUTES legs — ADD/SUPERSEDE
through `/auto-memory/facts`, namespace scoping, semantic index, purge,
counters, `facts_layer` stamps — are REAL end to end: real server, real arm
code inside the real `node bench/memory/run.mjs` CLI.

## What ran

```
MYCELIUM_TIMELINE_FACTS=am_facts node bench/memory/run.mjs --split longmemeval \
  --arms mycelium-timeline --n 1 --max-sessions 5 --receipt \
  --answer-url http://127.0.0.1:3997/v1 --answer-model scripted-smoke \
  --judge-url http://127.0.0.1:3997/v1 --judge-model scripted-smoke \
  --no-slot-lock
```

`--no-slot-lock` is the deliberate, stamped escape hatch: the answerer is the
Mac's scripted endpoint, so no 3090 slot is involved (with the default lock the
run probes the 3090 via substrate.conf and refuses against pid 1181's hold).
`--split longmemeval` used the REAL pinned corpus: downloaded from the split
registry's URL, sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
= the pin exactly.

Three passes, all committed under `bench/memory/results/`:

| pass | run dir | path | what it proves |
|---|---|---|---|
| first | `2026-09-17-p1-203802` + `-204603` | default + flag | keyword-mode (embed config 404'd — see "findings"); the 205/207 stamp set + purge + receipts on both paths |
| final | `2026-09-17-p1-210712` (default) + `-210727` (flag) | default + flag | THE headline pair, vector mode (coverage 100%), all pre-committed numbers |
| b8 leg | `2026-09-17-p1-211039` (+ duplicate `-211100` — a re-invocation that still completed; both green, both kept) | flag, `--budget 8` | the supersede-rendering leg (see below) |

## The pre-committed numbers, as measured (final pass)

1. **≥1 ADD + ≥1 SUPERSEDE through the routes** — flag run `-210727`
   `write_decisions`: `{"candidates":5,"adds":1,"supersedes":4,"keeps":0,
   "decision_calls":4,"decision_failures":0,"fastpath_adds":0}` — 1 auto-ADD +
   a 4-long SUPERSEDE chain, every supersede through
   `POST /auto-memory/facts/:id/supersede` (counter below).
2. **A supersede renders the dated line inside a hit** — b8 leg `-211039`,
   read_hits ranks 6 and 7 carry the real rendered line:
   `"superseded on 2026-09-17 21:10:40 by: The user has a manager named Alex"`.
   At the default budget 5 the superseded tail does NOT fit (1 current fact +
   5 episodes fill the budget; `interleaveLayers` gives superseded facts only
   what neither live layer can use) — hence the `--budget 8` leg, which is a
   comparability-key deviation and NOT a grid number.
3. **Second-namespace read returns 0 of the first's rows** —
   `GET /auto-memory/facts?namespace=other-run-never-used-amfacts` → 0 rows
   (`final-pass/facts-other-ns.json`); run-ns current rows: 1 (the chain head).
4. **Route-usage counters > 0** — `route_usage` verbatim (both runs):
   ```
   POST  /auto-memory/facts                     5
   POST  /auto-memory/facts/:id/supersede       4
   GET   /memory/config                         3
   PUT   /memory/config                         1
   DELETE /memory/index/:sourceType/:sourceId    20
   POST  /memory/index/bulk                     10
   GET   /memory/list                           12
   POST  /memory/search                         14
   GET   /memory/stats                          4
   ```
5. **Regime carries `facts_layer` on both paths** — default receipt:
   `"facts_layer": "memory-rows"`; flag receipts: `"facts_layer": "am_facts"`
   (+ the `facts_routes` block); row meta: `facts_layer: am_facts` present on
   the flag path, ABSENT on the default path (the byte gate's shape).
6. **The namespace is purged at run end** — index rows: both namespaces drain
   to 0 (the `-amfacts` namespace purged as `am_fact`, 5 deleted, 0 remaining —
   see finding 1). Fact TABLE rows: per-id DELETE, 5 found / 5 deleted /
   0 remaining (`final-pass/fact-row-sweep.json`) — **per-id DELETE is
   smoke-scale only; task 211 is the bulk purge**; the receipt already stamps
   the gap (`facts_routes.known_gap`: "am_facts has no namespace bulk-purge
   route: the index rows purge via /memory/index?namespace=…, the fact ROWS
   remain (per-id DELETE only)"). Never a silent skip: the ids were read from
   the scratch DB because the `/facts` list is current-only by design
   (`superseded_by IS NULL`) and cleanup had already drained the index.

## Findings (each fixed in this branch, with tests)

1. **THE PURGE LEAK (the real catch — a merge-lane row, not just a smoke).**
   run.mjs purged every namespace with the run's ONE dataset source_type
   (`bench_longmemeval`). The routes layer indexes as `am_fact`, so the
   `-amfacts` purge matched 0 rows, deleted 0, and **leaked the run's fact
   index past cleanup** (first pass: a live am_fact row survived into
   post-run verification). Fix: the arm declares `namespaceSourceTypes`
   (`{[namespace]: sourceType, [factsNs]: FACT_INDEX_SOURCE_TYPE}` on the
   routes path), run.mjs builds the per-namespace map (both the success and
   failure purge paths), and `purgeNamespaces` purges each namespace with its
   own type (and says so in its log line). Regression tests:
   `test/unit/bench-memory-arm-mycelium-timeline-facts.test.js` (arm map on
   both paths + per-namespace type pass-through) and the updated log-shape
   assertion in `bench-memory-cleanup.test.js`.
2. **`/auto-memory/facts` scopes reads by caller identity** — the route
   filters `agent_id = who`; reads must present the SAME `X-Acting-As` the
   rows were written with (the run writes as `m5Max`), or the list is empty.
   The 206 route smoke did this implicitly; it is now explicit in the driver.
3. **FK-ordered fact deletes** — a supersede chain rows point forward
   (`superseded_by` names the replacement), so per-id deletes must run oldest
   first; DESC order 500s (`FOREIGN KEY constraint failed`) on every row but
   the oldest.
4. **First-pass keyword mode** — the embed config PUT went to the bare
   `/memory/config` and 404'd (the plugin API mounts at
   `/api/mycelium/memory/config`); the run degraded EXACTLY as designed:
   `retrieval_mode: "keyword-fallback"`, `degraded_reason` stamped, searches
   keyword-only, receipts honest. That pass is preserved under
   `first-pass-keyword-mode/` as the degrade-path evidence.

## The byte-identity gate (deliverable 2) — unchanged and green

`test/unit/bench-memory-timeline-golden-bytes.test.js` regenerates the fixture
rows on the merged tree and byte-diffs against
`bench/memory/fixtures/timeline-default-golden.rows.jsonl`
(generated on pre-merge bench @ 219ba34d, sha1 `90b3f323c2961430c6a9fe56fdbe292c9d6eca84`).
The negative control was run during development: substituting master's arm
file crashes the fixture (no `searchLayer` error tolerance), so the gate
detects arm changes. Suite status at commit time: vitest 1317 passed /
1 skipped (pre-existing skip), 141 test files; auto-memory node tests green.

## Driver scripts (committed, rerunnable)

- `run-smoke.sh` — the canonical pass (boot fake embedder :3998 + fake chat
  :3997 + scratch server :3999 from this worktree; PUT config; default run,
  flag run; counters; isolation reads; per-id sweep; index-purge verify).
- `run-smoke-budget8-supersede-leg.sh` — the supersede-rendering leg.
- `fake-chat.mjs` / `fake-embedder.mjs` — the scripted endpoints.

# task 206 — the am_facts routes' first real caller: capped smoke receipt

2026-09-17, lane F-mycelium. The smoke drove the NEW routes end-to-end on a
live server boot of this worktree's tree (commit 1cffdda + this branch):

```
DATA_DIR=/tmp/myc-amfacts-smoke/data PORT=3999 ADMIN_KEY=… JWT_SECRET=… node server/index.js
→ /health ok, version 0.1.0, commit_sha 1cffddab
```

Embedding: a loopback ollama-shaped fake (`/api/embed → {embeddings:[[0.6,0.8]]}`
on 127.0.0.1:3998), configured via `PUT /memory/config` — so the full index
path ran (sm_embeddings row + embed scheduler write-back through the hooked
side-channel `db.__myceliumEmbeddingWrite` + vector cache), not just keyword.

## What ran (route-smoke.mjs, verbatim output in route-smoke.out.txt)

Through `bench/memory/platform.mjs` — the SAME client the timeline arm uses:

1. **ADD ×3** through `POST /auto-memory/facts` in the run-scoped namespace
   `bench-p1-smoke20260917-amfacts` (ids 8, 9, 10), full metadata contract
   (episode / valid_from / supersedes / question_id / run_id).
2. **SEARCH** — `POST /memory/search` (hybrid, `source_types: ["am_fact"]`)
   answers the new facts in their namespace; **other namespace: 0 hits**.
3. **SUPERSEDE** through `POST /auto-memory/facts/10/supersede?namespace=…`:
   old row closed (valid_to stamped, superseded_by=10), same namespace.
4. **The superseded fact STAYS indexed** — its hit renders the line:
   `User's manager is Alex\n\n[superseded on 2026-09-17 17:09:16 by: User's new manager is Dana now]`
   and the search shows `8[superseded], 10[current], 9[current]` — history and
   current coexist in one index.
5. **ISOLATION** — second-namespace list: **0 rows**; unscoped list: **0 rows**
   (namespaced bench rows never surface in the lab's live unscoped fact store).

## Route-usage counters (route_usage table, verbatim in route-usage-counters.txt)

```
GET   /auto-memory/facts                3
POST  /auto-memory/facts                3
POST  /auto-memory/facts/:id/supersede  1
GET   /memory/list                      1
POST  /memory/search                    3
```

## The bench-arm leg: documented SKIP (slot-lock refusal, verbatim)

The `--split fixture --arms mycelium-timeline --n 1 --max-sessions 5` run was
attempted TWICE and refused by the 3090 slot lock both times (verbatim in
slot-lock-refusal.txt):

```
[run] FAILED: 3090 slots busy: 1/1 held — pid 1181 (2026-09-17-p1-155748 mycelium-timeline, since 2026-09-17T15:57:48.786Z). …
```

The single 3090 slot was held by a LIVE n=50 timeline run (the director's
timeline-v2 bench). The served Mac seat (oMLX :8780) was independently
unusable — its prefill guard rejected a 4-token prompt (`current 38.97 GB,
dynamic ceiling 37.52 GB` — floor bloated above its own ceiling; not
restartable by a lane). The arm's flag path is fully covered by the hermetic
fake-platform suite (`test/unit/bench-memory-arm-mycelium-timeline-facts.test.js`,
6 tests) — the routes leg above is the live-server evidence.

## Files

- `route-smoke.mjs` — the driver (re-runnable against any scratch server)
- `route-smoke.out.txt` — the clean-pass output verbatim
- `route-usage-counters.txt` — the counter rows verbatim
- `slot-lock-refusal.txt` — the documented SKIP verbatim

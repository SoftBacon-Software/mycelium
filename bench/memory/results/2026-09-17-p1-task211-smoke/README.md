# task 211 — am_facts bulk delete by namespace: capped smoke receipt

2026-09-17, lane F-mycelium. The smoke drove the NEW route end-to-end on a
live server boot of this worktree's tree (branch `feat/m5max/amfacts-bulk-delete`,
base `4b5dd674`):

```
DATA_DIR=<temp dir> PORT=3997 ADMIN_KEY=… JWT_SECRET=… node server/index.js
→ /health ok, version 0.1.0, commit_sha 4b5dd674
```

Scratch boot only: temp DATA_DIR (removed on exit), loopback port, server
child killed by the driver before exit. No model, no 3090 slot, no deploy.
Embedding: NO provider configured on the scratch boot — `POST /memory/search`
ran in keyword mode (degrade-to-keyword is the honest no-provider state); the
vector-side assertions (scheduler write-back, hybrid hits) live in the
hermetic suite (`test/unit/auto-memory-amfacts-bulk.test.js`).

## What ran (route-smoke.mjs, verbatim output in route-smoke.out.txt)

1. **ADD ×4** through `POST /auto-memory/facts` — three facts in the run
   namespace `bench-p1-smoke20260917-amfacts-purge`, one bystander in
   `…-other-amfacts` (ids 1–4).
2. **SUPERSEDE** — Dana replaces Alex through
   `POST /facts/1/supersede?namespace=…`: old row closed
   (`superseded_by=3`, `valid_to` stamped), and per task 206 the superseded
   row STAYS indexed — 2 ns hits before the purge (ids 1, 3).
3. **PURGE** — `DELETE /auto-memory/facts?namespace=…`:
   **`200 {deleted: 3, namespaces: [...]}`** — current (2) AND superseded (1)
   rows alike.
4. **The OTHER namespace: deleted 0 there** — its 1 row survives AND still
   answers a search (1 hit) — the pre-committed survival numbers.
5. **SEARCH AFTER PURGE: 0 hits** in the purged namespace through
   `POST /memory/search` scoped to it — the index rows went out with the rows
   (same seam: `unindexFacts`).
6. **UNSCOPED REFUSAL** — `DELETE /facts` (no namespace) → **400** naming the
   rule (legacy rows / Aria's internal writer unreachable by design);
   **NON-ADMIN** (presented-but-wrong key) → **403**.

## Route-usage counters (route_usage table, verbatim in route-usage-counters.txt)

```
DELETE /auto-memory/facts                3   (the purge 200 + the 400 + the 403 — everything counted by default)
POST   /auto-memory/facts                4
POST   /auto-memory/facts/:id/supersede  1
GET    /auto-memory/facts                1
POST   /memory/search                    3
```

## Files

- `route-smoke.mjs` — the driver (self-contained: spawns the scratch server,
  drives, dumps counters, kills the server; re-runnable)
- `route-smoke.out.txt` — the clean-pass output verbatim
- `route-usage-counters.txt` — the counter rows verbatim

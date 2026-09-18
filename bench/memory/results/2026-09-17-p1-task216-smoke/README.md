# task 216 — the am_facts purge leg's flag-path cleanup smoke (rows first, then index, verify both zero)

2026-09-17, lane F-mycelium, worktree `/private/tmp/myc-amfacts-purge`, branch
`feat/m5max/amfacts-purge-leg` (off master `75f411c3`, which carries 211's
`DELETE /auto-memory/facts?namespace=<ns>` route). Server under test: **a
scratch boot of THIS worktree** on `127.0.0.1:3994` (fresh DATA_DIR per leg, so
each leg's `route_usage` counters are that leg's own truth). The model legs are
SCRIPTED and stamped as such — a lane never holds a model seat; everything else
is the real harness (real server, real arm, real routes, real cleanup inside
the real `node bench/memory/run.mjs` CLI).

## Why the model legs are scripted (the 210 pattern)

`fake-chat.mjs` (scripted extraction / reconcile decision / judge / answer,
every request logged) and `fake-embedder.mjs` (ollama shape, constant 2-dim
vector — the full index path runs, no model). One addition over 210:
`--fail-answer-after 0` makes every answer call past the first return 500;
`answer.mjs` retries transient 5xx then THROWS — a scripted mid-write death
with the fact rows already in the `am_facts` table, which is leg 3's
instrument. `--no-slot-lock` throughout: the 3090 is never touched, no slot
lock was contended, no refusal to quote.

## What ran (`bash run-smoke.sh`; ~15 s/leg)

```
node bench/memory/run.mjs --split longmemeval --arms mycelium-timeline --n 1 --max-sessions 5 --receipt --budget 5 \
  --answer-url http://127.0.0.1:3995/v1 --answer-model scripted-smoke \
  --judge-url  http://127.0.0.1:3995/v1 --judge-model scripted-smoke --no-slot-lock
```
leg 1 with `env -u MYCELIUM_TIMELINE_FACTS`, legs 2–3 with
`MYCELIUM_TIMELINE_FACTS=am_facts` (leg 3 adds the death knob).

## Pre-committed number (1): facts_deleted == facts written, BOTH verify reads 0

Leg 2 (`leg2-run/`):

- facts written = `adds 1 + supersedes 4` = **5** (from
  `leg2-run/summary.json` → `write_info.mycelium_timeline` decision stamps;
  route counters agree: `POST /auto-memory/facts = 5`,
  `POST /auto-memory/facts/:id/supersede = 4`)
- **`cleanup.facts_cleanup.facts_deleted` = 5** — equal, as pre-committed
- **`facts_rows_remaining_after` = 0** (factsList verify) and
  **`search_hits_after` = 0** (POST /memory/search scoped to the namespace,
  `source_types ["am_fact"]`, hybrid mode) — the receipt's cleanup section,
  verbatim from `leg2-run/summary.json`:

```json
"facts_cleanup": {"namespace":"bench-p1-2026-09-18-p1-021600-amfacts","route":"DELETE /auto-memory/facts?namespace=<ns>","facts_deleted":5,"facts_rows_remaining_after":0,"search_hits_after":0,"search":{"query":"How long did I wait for the decision on my asylum application?","namespace":"bench-p1-2026-09-18-p1-021600-amfacts","source_types":["am_fact"]}}
```

- API corroboration while the server was still up (`leg2-run/facts-after-purge.json`,
  `leg2-run/search-after-purge.json`): facts list 0 rows, search 0 hits
- scratch DB after (`sqlite3`): 0 rows in the `-amfacts` namespace,
  0 with `superseded_by IS NOT NULL` — the SUPERSEDED rows drained too
- stderr order (`leg2-run/cli.out`): the ROWS purge line first, then the index
  purges — the receipt's stated order, visible in the log
- regime stamp measured (`leg2-run/summary.json` →
  `regime.mycelium_timeline.facts_routes.facts_cleanup`): `measured: true`,
  `facts_deleted: 5`, `facts_rows_remaining_after: 0`, `search_hits_after: 0`
- `route_usage` (`leg2-run/route-usage-counters.txt`):
  `DELETE /auto-memory/facts = 1` — fired exactly once

## Leg 1 — the default path is byte-identical (the facts route never fires)

`leg1-run/`: exit 0, `facts_layer: memory-rows`, `cleanup` has NO
`facts_cleanup` key, `regime.mycelium_timeline` has NO `facts_routes` block,
`route-usage-counters.txt` has **no** DELETE `/auto-memory/facts` line at all,
and the API facts list on the (never-written) `-amfacts` namespace returns 0.

## Leg 3 — the failure path still purges (a dead run strands nothing)

`leg3-run/`: exit 1 (the scripted 500 kills the run mid-write, after the fact
rows landed), NO summary.json (died before it — expected), and the finally-path
purge in `cli.out`:

```
[run] cleanup after failure — cleanup facts bench-p1-2026-09-18-p1-021617-amfacts: 5 fact rows purged (DELETE /auto-memory/facts?namespace=bench-p1-2026-09-18-p1-021617-amfacts)
[run] cleanup after failure: 5 index rows deleted, 0 remaining, facts 5 purged, verify 0 rows / 0 hits after
```

scratch DB after: 0 `am_facts` rows, 0 `am_fact` index rows in the namespace;
`route_usage`: `DELETE /auto-memory/facts = 1`. The dead run's rows and index
both drained.

## The stale stamp, replaced (the regime diff)

The pre-216 flag-path regime block carried:

> `known_gap: 'am_facts has no namespace bulk-purge route: the index rows purge via /memory/index?namespace=…, the fact ROWS remain (per-id DELETE only)'`

That was stale the moment 211 landed its route. `bench/memory/run.mjs` now
stamps `facts_cleanup` (route + `measured` + the three numbers) in its place,
and the memory-rows branch's `store_not_am_facts_why` gained the UPDATE line
naming 211 and quoting the old `known_gap` text verbatim so a future reader can
diff the claim. Leg 2's summary shows the measured stamp (above); leg 1's shows
the memory-rows branch unchanged.

## Artifacts

- `run-smoke.sh` — the driver (three legs, fresh scratch server per leg)
- `fake-chat.mjs`, `fake-embedder.mjs` — the scripted model legs
- `leg{1,2,3}-run/` — each leg's run dir (summary.json, rows, judged, facts,
  `cli.out` stderr, `route-usage-counters.txt`, API corroboration JSONs)
- `leg1-receipt.md`, `leg2-receipt.md` — the rendered receipts
  (leg 3 has none: it died before the receipt step, by design)

# F-mycelium 378 — RECEIPT: a game namespace reads its current rows

Task: `GET /memory/list` takes one `source_type` and returns superseded rows
beside live ones, newest-inserted first. A game master booting on
`game:<name>` cannot ask the platform "every current ruling, measurement, look
and mechanic in this namespace, dated" without N similarity searches that rank
by query and never promise completeness. This task adds the deterministic
read: `source_types=<a,b,…>` + `namespace`, superseded rows excluded by the
SAME predicate the lesson reads use, ordered by the row's own date, with a
`truncated` flag. Advances ROADMAP-TOOLS-1.0 Step 2 item 2; serves
DESIGN-game-masters-2026-10-29 §2.1/§2.3 and G-factory 100 (`gm.py recall`).

Branch: `myc/F-mycelium-378-current-rows`
Worktree: `~/Projects/_wt/F-mycelium-378-current-rows`
Base: `origin/master` @ `c8a95de6`

## Base check

```
$ git merge-base --is-ancestor cba05725 HEAD && echo BASE_CHECK_ok
BASE_CHECK_ok
```

`cba05725` (F-mycelium 262's kind-aware supersede) is an ancestor of the base;
262's merge landed as `cc739f43` on origin/master. Local `master` (`46d9ed3f`)
does NOT contain it (the brief's warning, verified: `git merge-base
--is-ancestor cba05725 master` fails) — the worktree was therefore cut from
`origin/master`, not local master.

## F-mycelium 377 ordering note

The brief says fire AFTER 377 and rebase onto it "if it has landed". 377
(`lane/f-mycelium-377-listing-isolation` @ `478588a8`) has NOT landed on
origin/master, and its branch is cut from local master `46d9ed3f` — the
commit that LACKS 262. No rebase was done; this task is cut from the named
base (`origin/master`). The two tasks both touch
`server/plugins/semantic-memory/routes.js` + `db.js`; whoever lands second
rebases.

## Changes

- `server/plugins/semantic-memory/db.js`
  - `LIVE_ROW_SQL` — the ONE "row is live" predicate
    (`json_extract(metadata, '$.superseded_by') IS NULL`) extracted to module
    scope and SHARED (never copied) by `listProvenanceRows` (186's
    lessons/history read, previously inline) and the new `listByTypes`.
  - `listByTypes(sourceTypes, opts)` — multi-kind sibling of `listByType`:
    one namespace, 1–8 kinds, superseded excluded by default via
    `LIVE_ROW_SQL`, ordered `COALESCE(valid_from, learned_at, created_at)
    DESC, created_at DESC, source_type ASC, source_id ASC` (186's own-date
    rule generalized; ties deterministic so two calls return byte-identical
    bodies), fetches limit+1 and returns `{rows, truncated}`.
- `server/plugins/semantic-memory/routes.js` (`GET /memory/list`)
  - `source_types=<a,b,…>` as an ALTERNATIVE to `source_type`. Exactly one of
    the two; both → 400 (one sentence). `source_types` (1–8 kinds) REQUIRES
    `namespace` → 400 otherwise (a cross-namespace multi-kind listing is a
    search, not a list). `refuseCompanionScoped` runs for EVERY kind.
    `include_superseded=1` reads superseded rows back with their pointer.
    Response: `{results, source_types, namespace, include_superseded, count,
    truncated}`.
  - The single-`source_type` form is UNCHANGED byte for byte — same SQL, same
    order, same response keys (proven by the snapshot test below).
- `server/plugins/semantic-memory/README.md` — API table row for the
  `source_types` form + a "Current rows — one namespace, several kinds"
  section with the `game:build-and-die` example.
- `test/unit/memory-list-current-rows.test.js` — the RED→GREEN file (10
  cases).
- Docs-count gates (the 11-05 law: the PR tip runs the docs gates too —
  adding one test file moved the count): `README.md` 188→189, `CLAUDE.md`
  188→189, `CONTRIBUTING.md` 188→189 test-file counts.

## RED (base code, new file only)

```
$ npx vitest run test/unit/memory-list-current-rows.test.js; echo rc=1
 Test Files  1 failed (1)
      Tests  8 failed | 2 passed (10)
rc=1
```

Every new-contract case fails on the base; the two cases whose contract
already holds (an empty `source_types` is a 400 — the single-form's own guard
answers it; the single-kind snapshot) pass. The snapshot's base body itself
shows the hole: `source_type=ruling` returns the SUPERSEDED `r-v1` beside the
live `r-v2`.

## GREEN (after the change)

```
$ npx vitest run test/unit/memory-list-current-rows.test.js
 Test Files  1 passed (1)
      Tests  10 passed (10)
rc=0
```

The snapshot case proves the single-`source_type` body on the same seed is
byte-identical to the base's body: the fixture
(`test/unit/fixtures/memory-list-single-kind.snapshot.json`) carries the base
code's exact response text AND the frozen seeded DB (generated on the base
with `SNAPSHOT_UPDATE=1` BEFORE the route/db change; the default run mounts
the CURRENT routes over that frozen DB and demands the body match).

## Planted pair (the shared predicate is load-bearing)

```
$ # LIVE_ROW_SQL replaced with "1=1" in db.js, test re-run:
      × three current rows, newest valid_from first, the other namespace absent
AssertionError: expected 4 to be 3 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
rc=1
$ # restored; re-run:
      Tests  10 passed (10)
rc=0
```

Exactly the "three current rows" case goes RED when the one shared predicate
is broken — the test watches the SHARED expression, not a copy.

## Full suite + lint

```
$ npm test; echo rc=$?
 Test Files  189 passed (189)
rc=0
$ npm run lint; echo rc=$?
✖ 335 problems (0 errors, 335 warnings)
rc=0   (max-warnings 338 — under the cap, 0 errors)
```

No KNOWN-RED to name: the full suite is green on this branch (189 files,
0 failed), so there is no pre-existing red to excuse.

## Gates run

- `node test/refactor/route-manifest.mjs --check` → `route manifest unchanged
  (286 routes) ✓`, rc 0 (no route added — `/list` extended in place).
- `docs-inventory-accuracy` + `readme-named-endpoints-gate` → 15/15 passed
  after the 188→189 count bumps, rc 0.

## Single-`source_type` callers re-checked on this base (unchanged form)

Brief's 11-05 grep, re-verified here:
- jarvis `tools/unprompted_write.py:318` (`?source_type=…&namespace=…`)
- jarvis `tools/unprompted_recall.py:299` (same shape)
- jarvis `tools/lesson_rows_rekey.py:57` (`LIST_PATH = "/memory/list"`)
- mycelium `bench/memory/reanswer.mjs` (rows-present check via the single form)
- mycelium `bench/memory/tools/cleanup-run.mjs` (manual-inspection hint)

All keep working unchanged — the single-kind branch is byte-identical
(snapshot case).

## Commit

Landed as one commit on `myc/F-mycelium-378-current-rows` (no push, no PR —
the director opens it, two converging reviews, then deploys :3002).

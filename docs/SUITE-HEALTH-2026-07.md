# Mycelium test-suite health audit — 2026-07-28

Read-only audit. No test logic was changed. Every classification below is
backed by reading the assertion body (not the test name). The two hollow
findings and the refactor drift were verified against the live source.

Repo: `~/Projects/mycelium`. Suite: vitest, `npm test`, 56 collected files
(52 `test/unit` + 3 `test/smoke` + 1 `test/refactor`).

---

## §0 — Headline: it runs, and it's green

Verbatim summary line from `npm test` (run from repo root, 2026-07-28 09:40):

```
 Test Files  56 passed (56)
      Tests  986 passed (986)
   Start at  09:40:58
   Duration  2.51s (transform 5.72s, setup 0ms, import 6.81s, tests 17.32s, environment 5ms)
```

**No failures, no errors, zero skipped.** The green is real in the narrow
sense (the suite executes and the assertions hold). It is *mostly* honest in
the deeper sense: **47 of 56 files drive real code and assert on real output.**
But it is not wholly honest — there are **2 hollow files** that read as
coverage but cannot fail when the code they claim to guard breaks, and one of
those is also the highest-value casualty of the 2026-07 refactor.

Bottom line: the suite is a strong net that caught the refactor's moves
correctly, **except** it quietly stopped guarding schema/migration drift when
the migrations moved to `db/core.js`.

---

## §1 — Is the green honest? Classification of all 56 files

Counts (measured, not adjectives):

| Category | Count | What it means |
|---|---:|---|
| **BEHAVIORAL** | 47 | Drives the code and asserts on what it produced. Fails if behavior breaks. |
| **MIXED** | 5 | Mostly behavioral, with one named thin spot (cited). |
| **EXISTENCE** | 2 | Asserts a thing is exported/registered/present. Catches removal, not correctness. Honest but narrow. |
| **HOLLOW** | 2 | Mirrors the impl, hardcodes the source of truth, or swallows the failure path — **cannot fail when the code breaks**. |

Rubric (from the brief): HOLLOW > EXISTENCE > MIXED > BEHAVIORAL. A test is
classified by its *weakest* load-bearing assertion.

### §1.1 — The HOLLOW files (the finding that matters)

#### `test/unit/schema-drift.test.js` — hollow, and refactor-stale
Stated intent (lines 1-3): *"FAIL LOUDLY if server/schema.sql and the db.js
migrations list ever disagree. This catches the exact fresh-init gap that was
bug #10."*

What it actually does: `extractMigrations()` (lines 14-84) hardcodes a
**51-entry migrations array inside the test file** and the suite compares
`schema.sql` against *that copy*. It never reads `db.js` (or `db/core.js`).
Line 102: `const { migrations, teamColumns } = extractMigrations();` —
reads the local hardcoded function, not the source of truth. The header
comment (lines 15-16) even dates itself: *"Lines 38-99 in db.js."*

Why it cannot guard: a migration added to the code without updating
`schema.sql` — the precise bug-#10 scenario — is undetected **unless a human
also hand-edits the test's array**, at which point the human is the drift
detector, not the test. The second `it()` (lines 125-149) is a vacuous
self-check: it injects a fake column into the test's *own* loop and asserts
the loop throws — it tests the test, not production.

Measured proof it has already drifted from the source of truth: the live
migrations array now lives in **`server/db/core.js:51`** (it moved during the
db decomposition; `db.js` is a 74-line barrel with no migrations). diffing the
test's hardcoded copy against `db/core.js`:

- **In `db/core.js`, absent from the test's copy (live migrations the test is
  blind to):** `plan_steps.attempt_count`, `projects.repo_path`.
- Both columns *are* currently present in `server/schema.sql` (lines 272 and
  44), so there is **no active drift today** — but the guard would stay green
  if either were dropped from `schema.sql`. It is a latent blind spot, and it
  is already 2 entries out of date.

This is worse than no test: it reads as a drift gate and isn't one.

#### `test/smoke/admin-key-timing-safe.test.js` — hollow (local-copy mirror)
Stated intent (lines 4-8): pin the `crypto.timingSafeEqual`-based `isAdminKey`
comparator so a regression to direct `===` gets caught.

What it actually does: defines its **own** `isAdminKey` in the test file
(lines 10-14) — a copy of the source helper — and tests 1-4 (lines 19-40)
call **that local copy**. They pass identically whether the real helper is
timing-safe or regressed to `return key === expected`. Test 5 (lines 42-72)
touches the real source but only asserts the substring `/isAdminKey/` is
present (existence) and runs a regex for `=== ADMIN_KEY` outside `.length`
(source-text scan). A behavior-breaking rewrite that preserves the identifier
and avoids that exact `===` token sails through.

The real `isAdminKey` is defined at `server/routes/mycelium.js:201` (exported
at `:1596`) and `server/index.js:28`, invoked at ~7 callsites. Its timing-safe
**positive** path (correct key → true) is exercised by no test that drives the
real function.

### §1.2 — The MIXED files (named thin spots)

| File | Thin spot (file:line) | Carrying assertion |
|---|---|---|
| `test/unit/ssrf-guard.test.js` | **L5-16 & L56-67**: `assertPublicHost('https://google.com')` wrapped in `try/catch` that does `expect(true).toBe(true)` on error — vacuous, cannot fail if the validator breaks. | The other ~15 tests are solid behavioral SSRF-range checks (`rejects.toThrow(SSRFBlockedError)` per private/loopback/mapped range). |
| `test/unit/db-agent-auth-cascade.test.js` | **L285-327 (Part A)**: tests a local `isAdminKeyReplica` copy; the header (L286-289) openly concedes *"the local replica alone proves nothing about production code."* | **L329-373 (Part B)**: regex-extracts the *real* `isAdminKey` body from `mycelium.js` + `index.js`, asserts it contains `crypto.timingSafeEqual` + a length guard + is not downgraded to `===`, and asserts `checkAdmin`/`checkAdminOrOperator`/`checkAgentOrAdmin`/`checkVoiceAuth` actually invoke it. Honest, fairly stringent static guard. |
| `test/unit/mcp-resolve-url.test.js` | **L101**: `expect(typeof api.API_URL).toBe('string')` — existence-flavored sanity (the comment admits it). | 5 real `resolveUrl` tests asserting settings.json > env > localhost precedence. |
| `test/unit/project-id-no-escape.test.js` | **L58-64**: source-text mirror asserting `routes/mycelium.js` does not contain `escapeHtml(req.body.project_id` — **stale post-refactor** (task creation moved to `server/routes/tasks.js`; that pattern exists nowhere now, so it passes trivially and would not catch re-introduction in `tasks.js`). | **L40-55 (test 1)**: real `POST /tasks` with `'proj&a<b>"x"'`, then asserts the stored `project_id` round-trips verbatim — the actual guard, exercised through the mount. |
| `test/unit/liveness-debounce.test.js` | **L40-43**: existence (`typeof … === 'function'` + `_studioSeenCache` defined); **L79-87**: source-text mirror greping `mycelium.js` for exact call-site strings (not stale — `touchStudioUserSeenDebounce` stayed in `mycelium.js:436`). | **L45-77 (tests 2-4)**: real debounce behavior — 25 hammer-calls collapse to one cache write; back-dating triggers a fresh write. |

### §1.3 — The EXISTENCE files (honest, narrow)

- **`test/refactor/db-manifest.test.js`** — pins the 306-export `db.js` surface
  against a *committed* snapshot (`test/refactor/db-manifest.snapshot`,
  guarded by `existsSync`), with an independent `expect(count).toBe(306)` and a
  precise lost/added diff. Catches a dropped/renamed/re-typed/re-aritied export
  on a move. Does not verify any function does the right thing — and doesn't
  pretend to. Intentionally narrow, wired into the suite. Appropriate.
- **`test/smoke/license-and-version.test.js`** — `existsSync` on
  LICENSE/SECURITY.md/CONTRIBUTING.md + a version-format regex. Catches removal
  or a license swap. Catches no correctness.

### §1.4 — The 47 BEHAVIORAL files

Every one of these drives real code (a real DB op, a real `supertest` call
against the mounted router, or a real function call) and asserts on a real
output (status code, response body, row state, thrown error, index count).
Representative evidence per group:

- **The 11 route-characterization suites** (`admin`, `agents`, `assets-files-widgets`,
  `concepts-projects-skills`, `context`, `drones`, `github-spend-runs-voice`,
  `messages-channels`, `plans-approvals`, `plugins-webhooks`, `tasks`,
  `teams-orgs` — `agents` read in full, the other 10 sampled-then-confirmed by
  parallel readers): each mounts `(await import('…/routes/mycelium.js')).default`,
  drives it via `supertest`, and asserts on hardcoded expected values independent
  of the SUT. They also include a large number of explicitly-labeled
  `LATENT`/`SMELL` tests that *lock current buggy behavior* (e.g.
  `agents-characterization.test.js:292` pins the ghost-agent heartbeat
  savepoint write; `plans-approvals-characterization.test.js:666` pins the
  unreachable-quorum bug). These are honest characterization — they trip if
  anyone changes the behavior, which is the point. Not hollow.
- **The 11 db-layer unit suites** (`db-agent-heartbeat`, `db-approvals`,
  `db-approvals-resolved`, `db-approval-votes`, `db-drone-claim`, `db-init`,
  `db-reconciliation`, `db-runs`, `db-task-deps`, `db-timesince`, `residency`):
  import the `server/db.js` barrel, call real functions against a temp
  `DATA_DIR`, assert on row state / return values / counts. Several pin
  historically-broken behavior (negative `timeSince`, stale-claim auto-fail,
  the UPSERT quorum-forge, UTC-`Z` normalization).
- **The auto-memory suites** (`auto-memory-index-cascade`,
  `auto-memory-failure-surfacing`, `auto-memory-temporal`) — the strongest in
  the repo: real in-memory `better-sqlite3` with the *real plugin schema*,
  assertions on `am_facts` / `sm_embeddings` row counts. `index-cascade`
  covers all 5 fact-removal paths and pins the FK-safe `superseded_by` form so
  a regression to the `-1` sentinel fails. This is the test net for the
  recent index-cascade fix, and it is excellent.
- **Security/auth** (`a2a-rpc-auth`, `auth-roles`, `asset-download-path-traversal`,
  `bcrypt-fallback-dos`, `directive-and-upload-auth`, `drone-mesh-rce`,
  `guardrails-route-coverage`, `host-header-hardening`, `plugin-router-async-guard`,
  `researcher-ssrf`, `route-enum-reject-and-reconciliation`, `studio-login`):
  each asserts **both** the denied path (the 401/403/404, the blocked fetch,
  the canary-not-leaked) and the allowed path. `researcher-ssrf` is exemplary —
  it double-asserts `expect(result.error).toBe('SSRF blocked')` **and**
  `expect(fetchSpy).not.toHaveBeenCalled()`.
- **Two behavioral-but-narrow** worth naming:
  - `is-admin-key.test.js` imports the **real** `isAdminKey` but only tests the
    missing-env null-guard (`isAdminKey('x')` → `false`, no throw). It never
    asserts the positive path. A regression where `isAdminKey` always returns
    `false` (catastrophic — locks out all admin access) would pass this test.
    See the `isAdminKey` cross-cutting note in §2.
  - `bcrypt-fallback-dos.test.js` drives the gate function
    (`hasLegacyBcryptAgents`) behaviorally but does not prove `checkAgent`
    actually consults it (a coverage seam, not a hollow spot).

Full per-file ledger: counts above; every non-BEHAVIORAL file is enumerated in
§1.1-§1.3 with file:line. Anything not listed there is BEHAVIORAL.

---

## §2 — The 6539→~1747 refactor: did the tests follow the code?

### What the refactor touched (from `git log`)
- **Routes:** `server/routes/mycelium.js` decomposed from 6539 lines to a
  shared-middleware + auth + mounts file, now **1799 lines** (it was ~1747 at
  decomposition; it has grown ~52 lines since, from the auto-memory routes).
  Handlers were extracted into **15 domain modules** under `server/routes/`:
  `admin, agents, assets, bugs, channels, concepts, context, drones, feedback,
  messages, misc, plans, plugins, tasks, teams`.
- **DB:** `server/db.js` decomposed from 4497 lines to a **74-line barrel
  facade** over **31 entity modules** under `server/db/`, with `core.js`
  (257 lines) at the bottom owning the connection, the prepared-statement
  cache, `buildUpdate`, and the migrations. The `migrations` array **moved from
  `db.js` to `server/db/core.js:51`**.

### Did behavior retain its test through the move?

**Routes — YES, through the facade.** All 11 characterization suites mount
the real router (`const routes = (await import('…/routes/mycelium.js')).default;
app.use('/api/mycelium', routes)`) and drive it with `supertest`. Post-refactor
`mycelium.js` mounts the 15 sub-routers, so the extracted handlers are still
exercised end-to-end. Verified: **zero tests import any `routes/<sub>.js`
module directly** — every route test goes through the god-file facade. The
route-side behavior did not lose its test in the move.

**DB — YES, through the barrel.** All `db-*` suites import `server/db.js` and
call real functions; the barrel re-exports the 31 entity modules, so extracted
code is exercised. The 306-export surface is pinned in-suite by
`db-manifest.test.js`. The db-side behavior did not lose its test in the move.

### Two seams the refactor opened

**Seam A — the route-surface decomposition gate never runs in the suite.**
There is a `test/refactor/route-manifest.mjs` (with a committed
`route-manifest.snapshot`) that walks the *real mounted router* recursively —
including nested sub-routers, so it's identical pre/post extraction — and diffs
method+path+middleware-chain. It is the route-side twin of the db-manifest gate.
**But there is no `route-manifest.test.js`.** It is not collected by vitest
(`include: test/**/*.test.js`), it is not in `package.json`, and it is not in
CI (`.github/`). It is a manual `node test/refactor/route-manifest.mjs --check`
step. So unlike the db side (whose manifest *is* wired in), a silently
dropped / re-pathed / re-authed route during or after the decomposition is
**not** caught by `npm test`.

**Seam B — schema/migration drift lost its guard entirely (highest-value
finding).** This is the §1.1 hollow test meeting the refactor. The migrations
array moved `db.js → db/core.js`. `schema-drift.test.js` was already hollow
(hardcoded its own copy); the refactor severed even its nominal reference (its
comment still says "db.js lines 38-99," a file that no longer holds any
migrations). The `db-manifest` gate catches *export-surface* drift, not
*schema.sql ↔ migrations* agreement. **Net: the live migrations in
`db/core.js` currently have no drift guard in the suite.** Bug #10's exact
failure mode — a migration added without a matching `schema.sql` column — is
unguarded. It is latent (the 2 already-diverged columns are still in
`schema.sql` today), not active, but the guard is blind.

**Refactor-stale source scan (minor):** `project-id-no-escape.test.js:63`
watches `routes/mycelium.js` for a pattern whose handler moved to
`routes/tasks.js`; the pattern exists nowhere now, so the scan passes
trivially and would miss re-introduction in `tasks.js`. Its companion
behavioral test (test 1) still guards the real behavior through the mount.
The other source-scans (`db-agent-auth-cascade` Part B, `liveness-debounce`
test 5) target auth helpers and the debounce wrapper that **stayed** in
`mycelium.js`, so they are not stale.

### `isAdminKey` — a cross-cutting coverage gap (not caused by the refactor)
The security-critical timing-safe comparator is defined in two places
(`mycelium.js:201`, `index.js:28`) and invoked at ~7 callsites, but its real
behavior is covered only narrowly:
- The **positive** path (correct key → `true`) and the same-length-wrong-key
  constant-time rejection are tested **only against local replica copies**
  (`admin-key-timing-safe` tests 1-4, `db-agent-auth-cascade` Part A).
- The **real** function is imported and driven by exactly one test
  (`is-admin-key.test.js`), which covers only the missing-env null guard.
- The "is it actually invoked on protected routes" question is answered only
  by static source-text scanning (`db-agent-auth-cascade` Part B) — decent
  (it would catch a `===` downgrade), but it cannot verify constant-time-ness.

This predates the refactor and is not made worse by it (the helpers stayed in
`mycelium.js`), but it is the single most security-relevant thin spot in the
suite and the helpers now sit in a file that is mostly mounts.

---

## §3 — Skips

**Zero skipped tests.** Verified two independent ways:
- `grep -rnE '\b(it|test|describe)\.(skip|todo)\b|\bxit\b|\bxdescribe\b' test/`
  → no matches (the only apparent hits, `process.exit(...)`, are the
  `xit(` substring inside "e**xit(**" in the manifest CLI scripts — not tests).
- The vitest summary reports no `skipped` count, and there is no `.only`/
  `xit` anywhere, so nothing is focused away either.

Nothing to triage. There are no parked failures masquerading as skips.

---

## §4 — What to fix first (findings, not chores — no test logic was changed)

Ranked by value. All are read-only-safe recommendations; none were applied.

1. **Re-point the schema-drift guard at the live migrations** (`schema-drift.test.js`).
   Read the migrations array from `server/db/core.js` (e.g. export it, or
   `import` the module and reflect) instead of hardcoding a copy. Until this
   is done, `db/core.js` has no schema-drift guard and the test is
   actively misleading. This is the single highest-value fix in the audit.
2. **Wire `route-manifest` into the suite** — add a `route-manifest.test.js`
   that wraps `route-manifest.mjs --check` the same way `db-manifest.test.js`
   wraps the db one, so the route-surface decomposition gate runs on every
   `npm test` and in CI. Right now only the db side is gated in-suite.
3. **Drive the real `isAdminKey`** — replace the local-copy tests in
   `admin-key-timing-safe` (and the Part A replica in `db-agent-auth-cascade`)
   with calls to the real exported helper (`mycelium.js` already exports it at
   `:1596`), covering the positive path and the same-length-wrong-key case.
   Drop or narrow the source-text greps.
4. **Delete the two vacuous SSRF tests** (`ssrf-guard.test.js:5-16` and
   `:56-67`) or make them assert the real positive behavior (`expect(result)`
   on the resolved hostname) instead of `expect(true).toBe(true)` in a catch.
5. **Refresh the stale source scan** in `project-id-no-escape.test.js:58-64`
   to point at `routes/tasks.js` (or delete it — test 1 already proves the
   behavior through the mount).

---

### Method & caveats
- `npm test` run once from repo root; full log at `/tmp/mycelium-test-run.log`.
  No server was started; `server/data/` (the 1.2 GB live DB) was not touched.
- All 56 files read; the 47 BEHAVIORAL classifications were produced by reading
  assertion bodies (5 parallel readers + author adjudication of every
  non-BEHAVIORAL flag against the live source). The two HOLLOW findings and the
  refactor drift were re-verified by the author directly (definition sites,
  the `db/core.js` vs hardcoded-list diff, and the `isAdminKey` grep).
- The server/data `grep` hits for `isAdminKey` are the binary DB files and are
  not test coverage.
- `routes/mycelium.js` line count is the **current** 1799; the brief's "1747"
  was the figure at decomposition time.

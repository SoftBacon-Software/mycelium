# task 214 smoke — namespace-scoped embedding wait (branch `feat/m5max/memory-coverage-route`)

Two live legs were attempted on 2026-09-17. One was refused (the FULL capped
smoke), one ran and BANKED the pre-committed comparison (the reduced
instrument). Nothing here was smoothed over: both outcomes are documented
verbatim.

## Leg 1 — FULL capped smoke (`ns-wait-smoke.mjs`): DOCUMENTED SKIP (slot lock)

The real `run.mjs --arms mycelium,mycelium-timeline --n 1 --max-sessions 5`
was refused by the 3090 slot lock before any bench work started:

```
[run] FAILED: 3090 slots busy: 1/1 held — pid 56594 (2026-09-17-p1-224225
mycelium-timeline, since 2026-09-17T22:42:25.756Z). A benchmark run never
shares a slot with another client (a call queued behind a long generation is
how the Mem0 smokes died); wait for the holders to finish, or run with
--no-slot-lock deliberately. Lock dir: /Users/grb/.cache/mycelium-bench/slot-locks
```

The holder is the director's own bench r2 run. Per the brief:
**slot-lock refusal = documented SKIP** — `--no-slot-lock` was deliberately
NOT used (queueing this smoke's generations behind r2's long calls is exactly
the failure the lock exists to prevent). Consequence: the answer-side clauses
(every answered query `hybrid`, zero keyword-fallback rows) and the live
`run.mjs` wiring stamps are pinned by the HERMETIC suite only
(`bench-memory-coverage-wiring.test.js`) until the full smoke re-runs on a
free slot.

**Re-run (post-r2, slot free):**
```
node bench/memory/results/2026-09-17-p1-task214-smoke/ns-wait-smoke.mjs
```
The driver self-contains: scratch boot on :3998 (temp DATA_DIR, removed on
exit), embedder → Jetson ollama via the curl relay, 60 unembedded noise rows
seeded as the deterministic global freeze, global observer polling
/memory/stats, the real run spawned with its own slot lock. Requires the
gitignored split dataset (or the `bench/memory/data` symlink task 214's
worktree used).

## Leg 2 — REDUCED instrument (`ns-wait-compare.mjs`): MEASURED (clause 1)

No answerer (the slot refusal stands) — the same scratch boot + freeze
seeding, then ONE write of 50 rows through the platform seam the run uses
(`platform.indexBulk`) split across the run's two namespace shapes
(`bench-p1-smoke214` + `bench-p1-smoke214-amfacts`), both waits started at the
same t0: the shipped `waitForArmEmbeddings` namespace path vs the pre-214
global `/memory/stats` poll.

**Pre-committed clause 1, measured 2026-09-17 (two runs, agreeing; artifact
`ns-wait-compare.out.json`):**

| leg | settled | waited | coverage at end |
|---|---|---|---|
| NAMESPACE (shipped path) | **true** | **15011 ms** | BOTH namespaces 100%, `poll_failures=0`, `scope=namespace` |
| GLOBAL (pre-214 poll) | false (180 s cap) | 180379 ms | **frozen at 45%** (50/110 rows) |

4/4 checks PASS:

```
PASS  scope === 'namespace'
PASS  namespace leg settled at 100% of BOTH namespaces
PASS  namespace waited_ms (15011) <= global waited_ms (180379)
PASS  global freeze held (never reached 99.9)
```

The freeze is a number the observer READ (45%), not an assertion made in a
catch block — this matters because the first instrument draft hardcoded
`last_coverage: null` into its unsettled return, which would have made the
freeze vacuous even if every poll had succeeded. That defect was found by
asking "what would this print if the polls were blind?", fixed, and re-run.

**Re-run:** `node bench/memory/results/2026-09-17-p1-task214-smoke/ns-wait-compare.mjs`

## The curl relay (`jetson-relay.mjs`) — why the embedder dials 127.0.0.1

On this Mac, raw sockets from node AND python to `192.168.50.x` fail
EHOSTUNREACH while curl connects (re-probed 2026-09-17 with the sandbox fully
disabled: node fails, python fails, curl answers; ARP entries healthy on both
en0/en10; the same failure is the recorded lane lesson). Suspected mechanism:
macOS per-app Local-Network permission, never granted to the node/python
binaries. The scratch server embeds via node fetch, so it cannot reach the
Jetson's ollama directly — the relay forwards loopback HTTP to
`192.168.50.106:11434` using `/usr/bin/curl`, one curl per request.

This is INSTRUMENT plumbing, not a platform change: the deployed platform
embeds on the Jetson itself, over loopback, where fetch works. The platform's
own bench client (`platform.mjs`) already carries the same workaround as its
sticky-curl fallback for the bench→platform direction; the relay covers the
platform→embedder direction, which only a Mac-hosted scratch boot hits.

## What each pre-committed clause got

| clause (brief, verbatim intent) | status |
|---|---|
| namespace-scoped wait wall-clock ≤ global-wait wall-clock, same write | **MEASURED** — 15011 ms vs unsettled-at-180-s, frozen at 45% |
| BOTH reaching 100% of the run's namespaces before the first answer | namespace leg MEASURED at 100%/100%; "before the first answer" — hermetic + wiring tests only (no answerer ran: slot refusal) |
| every answer row's retrieval_mode 'hybrid', zero keyword-fallback rows | HERMETIC ONLY until the full smoke re-runs on a free slot |

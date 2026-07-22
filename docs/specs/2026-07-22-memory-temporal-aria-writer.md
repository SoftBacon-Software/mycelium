# Memory System — Temporal Facts + Provenance + Aria's Writer

**Date:** 2026-07-22 · **Author:** m5Max · **Status:** slice 1A implemented (tests pending green)

## Goal
Make `am_facts` (mycelium `auto-memory` plugin) the lab's single **canonical, SOTA-shaped**
memory store — **bi-temporal validity + provenance-scoped trust** — and wire **Aria's**
transcript→memory consolidation to write into it **with dedup**. So agents *and Gilbert* stop
re-deriving what's already known, and the store stays **right** over time.

## Why
Today: four disconnected stores (`am_facts`, `sm_embeddings`, the Claude `.md` store, squad
`agent_memory/graph`); Aria's writer is unbuilt (`aria_distill.py` dumps candidates to stdout).
The re-derivation tax is real (this session re-proposed a 6-day-old design as new). SOTA survey
(2026-07-22): the #1 load-bearing mechanism for a multi-agent store is **bi-temporal
supersession** (Graphiti); the **leapfrog lane** is multi-agent governance + proactive push —
mycelium's home turf.

## Verified current state (bytes, not the map)
`am_facts`: `id, agent_id, project_id, category, fact_text, confidence(0.8), source_type,
source_id, superseded_by(self-FK; -1=decay-pruned), created_at, updated_at` + migrated
`access_count/last_accessed_at`. Write via `createFact` (**no dedup**); merge only via 6-hourly
LLM `runConsolidation` → `supersedeFact`; per-category exponential `decay.js`. Migration pattern:
idempotent try/catch `ALTER TABLE ADD COLUMN` (`db.js:5-6`). **No** temporal intervals, provenance
tier, or write-time dedup.

## Target model
- **Bi-temporal.** `valid_from`/`valid_to` (world-time) alongside `created_at/updated_at`
  (ingestion-time). **Invariant: `valid_to IS NULL` ⟺ `superseded_by IS NULL` ⟺ current.**
  Supersession *closes the interval*, never deletes → `factsAsOf(ts)` answers "what did we believe
  on date X" (dissolves the three-file "dead-end / the-unlock / diffusion-MTP-CORE" contradiction).
- **Provenance-scoped trust** — `source_authority` reflects **how VALIDATED, not who spoke**
  (corrected 2026-07-22 after an over-rotation — see [[feedback_calibrated_trust_verify_once_bank_confidence]]):
  - `verified` — ground-truth-checked (code/tests/measurement); `verified_at` stamped; trusted until stale.
  - `directive` — operator's stated intent/preference/decision (authoritative for what-Gilbert-*wants*;
    superseded only by a new directive; **does NOT decay**).
  - `inferred` — extracted OR operator-**recollected** but unverified; decays; the re-verification queue.
  - ⚠️ Operator *factual claims* land as `inferred`, NOT privileged — the store's job is to be RIGHT,
    not deferential. "If what you feel is right counteracts what he says, that's when you check."
- **Re-verification.** `verified_at` + `factsDueForReverification()` + `reverifyFact()` =
  the "confirm aging memories with timestamps" loop. Aria owns the schedule (slice 2).

## Slices
- **1A — store foundation (this):** schema migration (4 cols + 2 indexes + backfill), `db.js`
  helpers (`createFact` provenance, `supersedeFact` interval-close, `reverifyFact`,
  `factsDueForReverification`, `factsAsOf`, `getDecayableFacts` skips directive, `pruneLowConfidence`
  closes interval), vitest tests. **Additive, reversible, zero behavior change to existing callers**
  (7-arg `createFact` still works via appended optional args).
- **1B — Aria's dedup-writer (`aria_write.py`):** parse `aria_distill` candidates → recall similar
  (`/memory/search`) → LLM decides **ADD / UPDATE / NOOP / CONFLICT→verify** → `POST /auto-memory/facts`.
  Maps candidate `{name,type,desc,body}` → `am_facts {fact_text, category, source_authority}`.
  New write endpoints (`POST /facts`, `/facts/:id/reverify`, `/facts/:id/supersede`, `GET /facts/as-of`).
- **2 — unify + loop + recall:** `.md` store becomes a *projection* of `am_facts` (also the Part-2a
  "inject into Claude Code" answer, via projection + a `UserPromptSubmit` hook); Aria's hourly
  re-verification pass (launchd); multi-signal recall (relevance×recency×importance) into live
  `/memory/search`; graph/PPR. Then the leapfrog: governance scopes + the concept-pair→memory
  **bombardment**; a LongMemEval/BEAM eval to *prove* SOTA (gate, not vendor claim).

## Schema change (idempotent, backward-compatible)
```sql
ALTER TABLE am_facts ADD COLUMN valid_from TEXT;
ALTER TABLE am_facts ADD COLUMN valid_to   TEXT;
ALTER TABLE am_facts ADD COLUMN verified_at TEXT;
ALTER TABLE am_facts ADD COLUMN source_authority TEXT NOT NULL DEFAULT 'inferred';
UPDATE am_facts SET valid_from = created_at WHERE valid_from IS NULL;
UPDATE am_facts SET valid_to  = updated_at WHERE superseded_by IS NOT NULL AND valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_am_facts_valid     ON am_facts(valid_to);
CREATE INDEX IF NOT EXISTS idx_am_facts_authority ON am_facts(source_authority);
```

## Tests — `test/unit/auto-memory-temporal.test.js` (vitest, isolated better-sqlite3)
Migration on a populated pre-temporal table; backfill `valid_from=created_at`; `createFact`
defaults + explicit provenance; `supersedeFact` closes interval + invariant; `reverifyFact` stamps
+ preserves confidence when omitted; `factsDueForReverification` includes unverified-inferred,
excludes directive + recently-verified; `factsAsOf` interval containment; decay skips directive;
`pruneLowConfidence` closes interval.

## Acceptance
Existing callers unchanged; migration idempotent on a populated table; new temporal/provenance paths
green. Slice 1B/2 gated on this.

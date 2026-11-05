# Receipt — lane F-mycelium task 337: review A's three FIX findings on 333, closed for review B

Lane: F-mycelium · task 337 · branch `lane/f-mycelium-337-333-fix`
(its own worktree — the lab's private checkout, named without a path),
cut from master `abf42f22` (333's
receipt commit). Findings read VERBATIM from
`docs/reviews/F-333r.md` @ `lane/f-mycelium-334-review` (47974ef6).
Branch-only local commits; not pushed, not merged — review B and the landing
are the director's.

## F1 — a mixed receipt's opening line stated the opposite of its banner → `69857f29`

`renderGridReceipt` pushed "one regime each, one grid" unconditionally — a
FALSE sentence on exactly the path task 333 created, printed two lines above
the bold MIXED REGIME banner. The sentence is now conditional
(`bench/memory/grid.mjs`, the `task 333-F1` comment): mixed → "the runs'
regimes DIFFER — composed under --allow-mixed-regime (see the table below)";
the default path's text is byte-unchanged.

Proof (the tests pin BOTH branches — `test/unit/bench-memory-grid.test.js`):

- mixed path: `expect(md).toContain("the runs' regimes DIFFER — composed under --allow-mixed-regime")`
  and `expect(md).not.toContain('one regime each, one grid')`
- clean path (`allowMixedRegime` on a same-regime pair): `expect(md).toContain('one regime each, one grid')`

`vitest run test/unit/bench-memory-grid.test.js` → **Test Files 1 passed (1),
Tests 80 passed (80), EXIT=0** (no behaviour change anywhere else in the file).

## F2 — the rejudge stamp was parsed twice → `428fb701`

One reader now owns the parse: `rejudgeJudgePromptStamp(summary)` (exported
from `bench/memory/grid.mjs`, doc-commented task 333-F2) — the pair's
top-level `judge_prompt_version` falling back to the pair's regime mirror,
normalized to null. Both callers use it:

- the composer: `loadRun`'s `rejudge.judge_prompt_version` (was the inline
  `summary.judge_prompt_version ?? summary.regime?.judge?.… ?? null`)
- the table: `regimes.mjs` `runLike` (was the second inline parser — it cannot
  call `loadRun`, so it now imports the same symbol instead)

The divergence test (`test/unit/bench-memory-regimes.test.js`, "ONE reader for
the composer and the table (task 333-F2)") imports the reader from grid.mjs
and asserts `runLike(entry).rejudge.judge_prompt_version ===
rejudgeJudgePromptStamp(entry.summary)` on every stamp shape — top-level wins
over the mirror, mirror-only fallback, nullish → null — plus the composer's
own `loadRun` object asserted against the same symbol on the same summary.

`vitest run test/unit/bench-memory-regimes.test.js test/unit/bench-memory-grid.test.js`
→ **Test Files 2 passed (2), Tests 102 passed (102), EXIT=0**; eslint clean on
the four touched files.

## F3 — the generated table drifted; the 333 receipt misquoted it → `b15dd64c`

Two halves, per the review:

1. **Deterministic generation.** The wall-clock `Generated:` line was the only
   drift between the committed `regimes.md` and a regeneration. `utcStamp()`
   is deleted; the stamp is now `generatedFromRuns(entries)` — the NEWEST
   banked run file's own `regime.date_utc` (content-derived, so a fresh clone
   is stable too), rendered as
   `Generated: 2026-09-19T14:10:07Z (the newest banked run file's date_utc — regeneration is byte-stable)`.
   Proof on the clean post-commit tree, quoted:

   ```
   $ node bench/memory/regimes.mjs && git diff --stat bench/memory/regimes.md
   regimes: 20 banked run files in 10 regimes; 4 composed grids audited (mixed: 0, unverifiable citations: 2) -> bench/memory/regimes.md
   DIFF_STAT_LINES=0        # git diff --stat printed NOTHING — empty
   TREE_CLEAN=yes
   ```

   Two consecutive regenerations hash identical:
   sha256 `91338344037f7cdbae74d219e2af1c0f58fd781b14649a73d10e41f19b1ed2c9`
   both times. The one-time regeneration (in the commit) moved ONLY the stamp
   line — every table row byte-unchanged, matching review A's demand-1
   finding.

2. **The 333 receipt's Deliverable-1 table corrected**
   (`docs/receipts/F-333/RECEIPT.md`): the hand-typed table summed to 19,
   split the six-file judge-prompt.2 regime, omitted
   `summary.rejudge-v3.json`, and called the 224225 v2 row "regime 4".
   Corrected to the tool's own grouping — 1, 1, 6, 4, 2, 1, 1, 1, 1, 2, sum
   **20**, the table's own headline total — with the "regime 4" reference now
   regime 3, and a correction note attributing review A F3 + task 337 (the
   generated artifact was right throughout).

Tests: `generatedFromRuns` pinned (newest run's date_utc; insertion order
irrelevant; unreadable entries excluded; empty tree → the named placeholder,
never a clock read).

## Suite (deliverable 4)

`npx vitest run test/unit/bench-memory-*.test.js` → **EXIT=0**

```
 Test Files  32 passed (32)
      Tests  607 passed (607)
```

(333 landed 603; +2 F2 divergence tests, +2 F3 stamp tests = 607.)
`node_modules` is a SYMLINK to the 333 worktree's `node_modules`
(this checkout has none; the same borrow review A used — said per the brief).
The symlink is gitignored; `git status` clean.

## Commits (oldest → newest)

- `69857f29` — 333-F1
- `428fb701` — 333-F2
- `b15dd64c` — 333-F3
- (this receipt: its own commit, the branch head)

## Artifacts

| path | mtime |
|---|---|
| `bench/memory/grid.mjs` | 2026-11-04 23:06:33 |
| `test/unit/bench-memory-grid.test.js` | 2026-11-04 23:06:10 |
| `bench/memory/regimes.mjs` | 2026-11-04 23:07:29 |
| `test/unit/bench-memory-regimes.test.js` | 2026-11-04 23:07:52 |
| `docs/receipts/F-333/RECEIPT.md` | 2026-11-04 23:08:39 |
| `bench/memory/regimes.md` (regenerated) | 2026-11-04 23:09:11 |

No merge, no push, no model call, no seat touched, no grading file edited
(lane rules 2/4/6). Review B is the director's.

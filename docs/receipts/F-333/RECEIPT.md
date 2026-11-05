# Receipt — lane F-mycelium task 333: every banked p1 row carries its regime stamp in one table

Lane: F-mycelium · task 333 · branch `lane/f-mycelium-333-regime-table` (worktree
`~/Projects/_wt/f-mycelium-333-regime-table`), cut from master `160dc52b`,
landed as commit **`e6173fa0`** (branch-only; not pushed, not merged — the
director's fast-forward).

## The defect this closes

The 330 survey's banked timeline numbers (p1 0.400, KU 8/15, SSA 1.000→5/5 cells,
TR 0.400; write ADD 13,505 / SUP 220 / KEEP 230) are 3090-qwen3.8-regime numbers
(results `2026-09-17-p1-224225`, rejudge pass under judge-prompt.2), while a
Mac-XS-regime pilot quotes different ones beside them. Nothing made the regime
visible, and the grid composer could compose across regimes silently.

## Deliverable 1 — the regime table

`bench/memory/regimes.mjs` (new) → `bench/memory/regimes.md` (committed;
regenerated 2026-11-04 20:15): **20 banked run files in 10 regimes**, one row per
run file × arm, every cell rendered from the run files (no hand-typed numbers).
Row counts per regime:

| regime (label prefix) | files |
|---|---|
| 1 — hermetic fixture n=3 (unstamped judge prompt) | 1 |
| 2 — 3090 qwen3.8, judge-prompt.2 unstamped primary (185920) | 1 |
| 3 — 3090 qwen3.8, judge-prompt.2 rejudge pairs (n=50 each) | 3 |
| 4 — 3090 qwen3.8, judge-prompt.2 primaries + 224225 v2 | 3 |
| 5 — scripted-smoke budget 5 (127.0.0.1:3997) | 4 |
| 6 — scripted-smoke budget 8 | 2 |
| 7 — Laguna-XS answerer @ localhost:8780, judge-prompt.2 | 1 |
| 8 — Laguna-XS answerer @ localhost:8780, judge-prompt.4 | 1 |
| 9 — 3090 qwen3.8, judge-prompt.4, n=1 | 1 |
| 10 — 3090 qwen3.8, judge-prompt.4, n=50 | 2 |

The 330-named numbers appear in the table with their regime: regime 4's
`2026-09-17-p1-224225/summary.rejudge.json` row renders
`mycelium-timeline: p1 0.400 (20/0/30 of 50) · knowledge-update 8/15 ·
single-session-assistant 5/5 · temporal-reasoning 2/5 · write: ADD 13,505 /
SUP 220 / KEEP 230` under `qwen3.8:27b @ desktop-1uiqnip:11434 · judge prompt
judge-prompt.2` — the 3090 regime, verbatim from the run's own files.

## Deliverable 2 — the composer refuses mixed regimes

`bench/memory/grid.mjs`: `REGIME_IDENTITY_FIELDS` (one definition of the regime,
shared with regimes.mjs) + `findRegimeDifferences` / `assertSameRegime`. A
composition whose runs differ on `regime.answerer.url_host`,
`regime.answerer.temperature`, `regime.judge.url_host`, or on any **platform
field both runs stamp** refuses (`GridRefusal`) before anything is written.
`--allow-mixed-regime` (run.mjs flag → `composeGrid({ allowMixedRegime })`)
lifts ONLY the regime guard — the old comparability keys stay unconditional —
and the receipt then prints the regimes side by side under a bold
`## MIXED REGIME` banner. A platform-NULL run beside a platform-stamped run
still composes (the committed mem0×mycelium shape; absence is shown, never
judged). The default path renders nothing new: the banked
`2026-09-17-p1-224225-rejudge+2026-09-09-p1-195034-grid.md` re-renders
**byte-identical** (the existing no-regression test pins it, still green).

## MIXED findings (named)

4 committed grid receipts audited (`bench/memory/regimes.md` audit table):

- **0 MIXED.** Every committed grid's resolvable runs share one regime under
  the composer's own rule (`findRegimeDifferences` over the loaded runs).
- **2 unverifiable citations, named:** `2026-09-09-…+2026-09-11-p1-025039-grid.md`
  and `…+2026-09-11-p1-123327-grid.md` cite run files that no longer exist in
  the tree — a committed grid whose evidence is gone cannot be re-checked.
  Named in the table, never silent.
- The cross-regime mix risk the 330 survey described lives in PROSE quoting,
  not in a committed grid: the Mac-XS pilot rows (branch `memlead-1103`,
  `2026-11-04-p1-023923`) are not in this tree. From this task on, composing
  them beside the 3090 banked rows refuses without `--allow-mixed-regime`,
  and the table shows each stamp.

## RED / GREEN

- **RED (observed before implementing):** 8 new tests in
  `test/unit/bench-memory-grid.test.js` (`task 333` describe) — the two-regime
  fixture pair composed SILENTLY (`composeGrid` returned a receipt; the
  refusal tests failed on `err === null`). `findRegimeDifferences` did not
  exist.
- **GREEN:** all 32 `test/unit/bench-memory-*.test.js` files — **603 passed**
  (incl. the 8 new guard tests + 20 new tests in
  `test/unit/bench-memory-regimes.test.js`), eslint clean on the touched
  files, `node bench/memory/regimes.mjs` exit 0 printing
  `20 banked run files in 10 regimes; 4 composed grids audited (mixed: 0,
  unverifiable citations: 2)`. CLI end-to-end: a two-box fixture pair refuses
  with exit 1 naming `regime.answerer.url_host`; with `--allow-mixed-regime
  --receipt` it composes, `mixed_regime: true` in JSON, and the receipt
  carries the MIXED REGIME table.

## Artifacts

- `bench/memory/grid.mjs` (modified) — regime guard + side-by-side section
- `bench/memory/run.mjs` (modified) — `--allow-mixed-regime`, `mixed_regime` JSON
- `bench/memory/regimes.mjs` (new) + `bench/memory/regimes.md` (generated)
- `bench/memory/README.md` (modified) — regime paragraph links regimes.md
- `test/unit/bench-memory-grid.test.js` (+8 tests),
  `test/unit/bench-memory-regimes.test.js` (new, 20 tests)

No merge, no push, no model calls, no seat touched (lane rules 2/6).

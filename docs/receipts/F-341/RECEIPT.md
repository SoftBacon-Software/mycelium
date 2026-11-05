# Receipt — lane F-mycelium task 341: the regimes table is a TEST

Lane: F-mycelium · task 341 · branch `lane/f-mycelium-341-regimes-test`
(worktree `~/Projects/_wt/f-mycelium-341-regimes-test`), cut from master
`fe05881f` (task 340's landing; the brief's floor was `b832052d`, "or
later"). Nothing kept 337's F3 proof (`node bench/memory/regimes.mjs` →
empty `git diff`) from silently breaking — the next banked run or a stamp
rename drifts the committed `bench/memory/regimes.md` from the tool. The
equality is now a vitest. Branch-only local commits; not pushed, not
merged — the director lands.

## What landed

1. **One refactor, no second renderer** (`bench/memory/regimes.mjs`): the
   CLI's whole pipeline (collect → group → audit → render) moved OUT of
   `main()` into an exported `renderRegimes({ resultsDir, receiptsDir })`
   returning `{ md, groups, total, grids, mixed, unverifiable }`; `main()`
   is now call-it → write-it → print-the-line. The test drives THIS
   function — the exact bytes the CLI writes — so it can never diverge
   from the tool by construction. The CLI log line is byte-unchanged.
2. **The test** (`test/unit/bench-memory-regimes-committed.test.js`), two
   tests:
   - **equality**: `renderRegimes().md` vs the committed
     `bench/memory/regimes.md` — byte for byte; on mismatch the failure
     message carries a unified diff (first 40 lines, context 3, built by a
     self-contained LCS helper — no diff library) and the one fix command:
     `node bench/memory/regimes.mjs`.
   - **determinism**: renders twice, compares byte-identical; and pins the
     `Generated:` line to `generatedFromRuns(collectRunFiles(results))` —
     if the wall clock ever sneaks back into the stamp (the thing 337-F3
     deleted), the line stops matching the content-derived value and the
     test fails.
3. **README** (`bench/memory/README.md`): the regime machinery table (340)
   gets the row **"committed table = regenerated"** — what / file / what it
   does / the command, with the observed outputs quoted; the 340 verified
   comment extended with the 341 proof lines.

## The two vitest lines (deliverable 4, quoted)

**GREEN on the clean tree** (before planting):

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  165ms
```

**RED — plant**: `sed -i '' 's/0\.380/0.381/' bench/memory/regimes.md`
(one digit in the 185920 mycelium row, `git diff --stat` = 1 file changed):

```
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

Failure message (the diff works): hunk `@@ -24,11 +24,11 @@`, `- …mycelium:
p1 0.381 (19/0/31 of 50)…` (the planted committed row) vs `+ …mycelium: p1
0.380…` (the tool's), followed by the fix line. The determinism test kept
passing through the plant — correct: the drift was committed-side, and two
renders of the tool still agree with each other.

**GREEN — restored** (`git checkout -- bench/memory/regimes.md` in the
WORKTREE, tree diff back to 0 lines):

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

`RESTORED_EXIT=0`.

## The refactor changed nothing (proof)

On the clean tree, after the extraction:

```
$ node bench/memory/regimes.mjs
regimes: 20 banked run files in 10 regimes; 4 composed grids audited (mixed: 0, unverifiable citations: 2) -> bench/memory/regimes.md
EXIT=0
DIFF_LINES=0        # git diff --stat bench/memory/regimes.md printed NOTHING
sha256 91338344037f7cdbae74d219e2af1c0f58fd781b14649a73d10e41f19b1ed2c9
```

— the same value 337's and 340's receipts recorded.

## Suite

`npx vitest run test/unit/bench-memory-*.test.js` → **EXIT=0**

```
 Test Files  33 passed (33)
      Tests  609 passed (609)
```

(340 landed 32 files / 607 tests; +1 file, +2 tests = this deliverable.)
`node_modules` is a SYMLINK to the main checkout's
`~/Projects/mycelium/node_modules` (this worktree has none; the same
borrow 337 recorded). The symlink is gitignored. ESLint clean on both
touched sources.

## Commits

- (prior to the receipt) the deliverable: regimes.mjs + the test + the README row
- (this receipt: its own commit, the branch head — sha posted in the lane message)

## Artifacts

| path | mtime |
|---|---|
| `bench/memory/regimes.mjs` (the renderRegimes() extraction) | 2026-11-05 00:27:03 |
| `test/unit/bench-memory-regimes-committed.test.js` (the deliverable) | 2026-11-05 00:28:15 |
| `bench/memory/README.md` (the new row) | 2026-11-05 00:29:06 |
| `bench/memory/regimes.md` (untouched content; mtime is the CLI re-run's) | 2026-11-05 00:28:46 |

No merge, no push, no model call, no oMLX, no heavy_lock, no seat touched,
no grading file edited (lane rules 2/4/6). Review B is the director's.

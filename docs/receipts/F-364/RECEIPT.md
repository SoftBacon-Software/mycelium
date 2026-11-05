# Receipt — lane F-mycelium task 364: the union tree — PR #214 merges origin, the full suite runs green on it

Lane: F-mycelium · task 364 · branch `pr/regime-table-union`
(its own worktree — the lab's private checkout, named without a path),
cut from local master `46d9ed3f` and merged with `origin/master`
`c8a95de6`. Branch-only local commits; NEVER pushed — the director
pushes the branch onto PR #214 and pastes the body.

## Why this lane exists (the finding it answers)

Task 362 (`docs/receipts/362/RECEIPT.md` on `lane/f-mycelium-362-ci`)
found that PR #214 showed CI green while having run **no suite at all**:
GitHub reported the PR CONFLICTING against `origin/master`, a
conflicting PR has no merge ref, and `test.yml` (no path filters, fires
on `pull_request`) therefore never created a run — #214's only check was
CodeQL's default-setup analysis of the head sha. The conflict was one
file, `bench/memory/README.md`: the arm roster grew on both sides with
DIFFERENT arms (origin's PR #212 added `mempalace`; the regime line
added `mycelium-timeline`). Behind the conflict rode the two
deterministic docs-gate debts that review 357 had verified RED on
`46d9ed3f` (`docs/reviews/F-341r-reconfirm-2.md`). This lane builds the
union, cures both debts on it, and proves the FULL suite green on the
result — so the director's push makes CI run, and pass, for real.

## The merge — the conflict hunks and their resolution

`git merge origin/master` in the worktree → exactly one conflicted file,
as 362 predicted: `bench/memory/README.md` (`run.mjs` auto-merged
clean; no other file conflicted). Two hunks, both resolved as the UNION
— keep every fact both sides wrote:

- **Hunk 1 — the `--arms` doc line (README ~line 28).** HEAD:
  `subset of none,mycelium,mycelium-extract,mycelium-timeline,mem0,mem0-raw,zep,letta`;
  origin: the same list plus `mempalace` but without `mycelium-timeline`.
  Resolution: `subset of none,mycelium,mycelium-extract,mycelium-timeline,mem0,mem0-raw,zep,letta,mempalace (default none,mycelium)`
  (two-line wrap kept, as the HEAD side had it).
- **Hunk 2 — the `arms/` legend (README ~line 663).** HEAD listed
  `arm_mycelium_timeline` but not `arm_mempalace`; origin listed
  `arm_mempalace` but not `arm_mycelium_timeline`, and each sidecar
  parenthetical omitted the other side's sidecar. Resolution: the legend
  lists BOTH — `arm_none, arm_mycelium, arm_mycelium_extract,
  arm_mycelium_timeline, arm_mem0, arm_mem0_raw, arm_zep, arm_letta,
  arm_mempalace, registry (+ mem0/zep/letta/mempalace_sidecar.py,
  requirements + per-arm venvs, gitignored)`.

Merge commit: **`d480f79f`** (one merge commit, as the brief demands).

### Registry proof (executed, quoted)

The legend must be TRUE of the tree, and `bench/memory/arms/index.mjs`
auto-merged carrying both sides. Proof by execution (the brief's
`--list-arms` does not exist as a flag — run.mjs's registry is the
exported `ARM_FACTORIES`; `node bench/memory/run.mjs --list-arms`
falls through to the run path and wants the gitignored dataset, so the
equivalent proof is importing the registry):

```
$ node -e "import('./bench/memory/arms/index.mjs').then(m => console.log(JSON.stringify(Object.keys(m.ARM_FACTORIES))))"
["none","mycelium","mem0","mem0-raw","zep","letta","mempalace","mycelium-extract","mycelium-timeline"]
```

All nine arms registered. `ls bench/memory/arms/` shows both
`arm_mycelium_timeline.mjs` and `arm_mempalace.mjs` (+ both sidecars)
on the union.

## The two docs-gate debts, cured on the union tree

RED baseline (NOT re-run here — quoted from review 357,
`docs/reviews/F-341r-reconfirm-2.md`, whose full-suite run on
`46d9ed3f` captured it): `npx vitest run` → `2 failed | 175 passed
(177 files)`, exit 1 — `docs-inventory-accuracy` (the docs said "175
files"; 357's tip count was 177) and `docs-reachability` (receipts
F-333 / F-337 / F-340 / F-341 unlinked from both entry docs).

1. **`docs-inventory-accuracy` — commit `d64686fa`.** The gate computes
   the real count by the same walk vitest uses (`test/**/*.test.js`,
   recursive, from the filesystem) and requires every covered doc
   (README.md, CLAUDE.md, CONTRIBUTING.md) to state exactly that count
   and no other "N files" literal. On the union the real count is
   **190** — NOT 362's ≈178 estimate: origin's own README already said
   188 (origin grew too), and the union adds our two regime-line test
   files (`bench-memory-regimes.test.js`,
   `bench-memory-regimes-committed.test.js`). All three docs' "188
   files" lines (README.md:263, CLAUDE.md:20, CONTRIBUTING.md:128)
   now say 190. No gate weakened, no grading file touched — the docs
   were stale, the gate was right.
2. **`docs-reachability` — same commit `d64686fa`.** The gate's
   reachability contract (read from `test/unit/docs-reachability.test.js`):
   every tracked `docs/**/*.md` must have its basename mentioned in
   README.md or CONTRIBUTING.md, or live under `docs/specs/` or
   `docs/examples/`; gitignored files are outside the gate's universe;
   untracked-but-addable files are INSIDE it. The four receipts were
   unlinked. CONTRIBUTING.md's Tests section now carries a "Work
   receipts" index naming each receipt path with a one-line summary —
   the place the gate reads, an honest index rather than a drive-by
   string.

GREEN on the union (executed this lane, rc captured directly before any
pipe — the 357 lesson):

```
$ npx vitest run test/unit/docs-inventory-accuracy.test.js \
    test/unit/docs-reachability.test.js test/unit/docs-ops-detail-gate.test.js
Test Files  3 passed (3) · Tests  18 passed (18) · exit 0
```

(The third documented gate, `docs-ops-detail-gate` — green since
`46d9ed3f` — stays green.)

## The regimes table on the union — legitimate movement, its own commit

```
$ node bench/memory/regimes.mjs
regimes: 21 banked run files in 11 regimes; 4 composed grids audited
(mixed: 0, unverifiable citations: 2) -> bench/memory/regimes.md   [exit 0]
$ git status --porcelain bench/memory/regimes.md
 M bench/memory/regimes.md
```

The table MOVED, legitimately: origin's merged banked results add one
regime — the mempalace P1 run (`bench/memory/results/2026-10-29-p1-214803/`,
mempalace p1 1.000 (3/0/0 of 3), qwen3.8:27b answerer, XS judge,
judge-prompt.4) — and the stamp moves to the newest banked run file's
`date_utc` (`2026-10-29T21:48:04Z`) per the determinism contract, never
the wall clock. 20 run files in 10 regimes → 21 in 11; mixed: 0 and
unverifiable citations: 2 unchanged. Regenerated table committed as
**`bedcb7ef`** (its own commit, as the brief demands). The
committed-table equality test passing in the full suite is the
byte-stability pin on this exact content.

## The private-path sweep — six hits found, cured, then empty

The brief's sweep, over EVERY file this branch changes vs
`origin/master` (`git diff --name-only origin/master...HEAD | xargs
grep -nE '<HOME>/Projects/|/Users/<operator>/'` — the home prefixes
elided here for the same reason as below) — the lesson of the morning
(363's class; note 357's sweep used the narrower jarvis-subtree pattern
and so passed these):

```
docs/receipts/F-333/RECEIPT.md:4:  [lab root]/_wt/f-mycelium-333-regime-table
docs/receipts/F-337/RECEIPT.md:4:  [lab root]/_wt/f-mycelium-337-333-fix
docs/receipts/F-337/RECEIPT.md:99: [lab root]/_wt/f-mycelium-333-regime-table/node_modules
docs/receipts/F-340/RECEIPT.md:4:  [lab root]/_wt/f-mycelium-340-readme
docs/receipts/F-341/RECEIPT.md:4:  [lab root]/_wt/f-mycelium-341-regimes-test
docs/receipts/F-341/RECEIPT.md:97: [lab root]/mycelium/node_modules
```

(`[lab root]` elides the private home prefix the sweep matched — the
paths' tails identify each hit; the prefix is the defect itself and is
not re-embedded here.)

Six hits — the lane-worktree paths in our own four receipts' headers and
two node_modules borrow paths. Cured in **`11350c72`** (docs-only),
per the F-340 precedent (`46d9ed3f`): the method stays (branch names,
shas, "its own worktree", "a SYMLINK to the main checkout's
`node_modules`"), the lab-internal paths go ("named without a path").
Post-cure sweep: **exit 1, no match — empty**, quoted:

```
$ git diff --name-only origin/master...HEAD | xargs grep -nE '<HOME>/Projects/|/Users/<operator>/'
<no output>  [SWEEP_EXIT=1 — grep found nothing]
```

16 files differ from `origin/master` on this branch (three-dot diff:
the PR's own delta; the 16th is this receipt). Docs gates re-run after the cure: exit 0, 18/18.

## The gates (all executed in the worktree; rc captured directly)

| gate | command | result |
|---|---|---|
| FULL suite | `npx vitest run` | **exit 0 — Test Files 190 passed (190) · Tests 2157 passed \| 1 skipped (2158)** |
| bench subset | `npx vitest run test/unit/bench-memory-*.test.js` | **exit 0 — Test Files 34 passed (34) · Tests 623 passed (623)** — exactly 357's union math (33 + origin's mempalace test) |
| docs gates | inventory + reachability + ops-detail | **exit 0 — 18/18** |
| lint | `npm run lint` | **exit 0** (0 errors, 335 pre-existing warnings — the gate's pass condition) |
| audit | `npm run audit` | **exit 0 — found 0 vulnerabilities** (`--omit=dev --audit-level=high`) |
| regimes | `node bench/memory/regimes.mjs` | **exit 0**, re-run twice on the clean tree, `git status --porcelain` empty both times — byte-stable |

The two RED-side quotes come from review 357 (on `46d9ed3f`) and 362
(the conflict, executed worktree-free via `git merge-tree`); everything
GREEN above ran on the final bytes of this branch, with this receipt,
its CONTRIBUTING index line, and the bench-README truth row present in
the working tree exactly as committed (the tree was gated, then
committed byte-identical — no post-commit delta).

**The flake episodes on this tip, named per the house protocol (two,
different files, the machine-load signature):** early full-suite runs
(before this receipt existed) tripped (1) `federation-routes.test.js`
once — "the souvenir door refuses too" expected 403, got 401 — and (2)
`enforcement-rules-admin.test.js` once — "rollback restores the value
but the row stays durable" expected 403, got 200. Each file re-run
ALONE passed immediately (exit 0, 43/43 and 34/34 respectively, the
exact failing tests included), and the immediate full-suite re-runs
were green — including the final quoted run on these exact bytes. This
is the machine-load flake class the earlier reviews named trip-by-trip
(362: #213's own body names `federation-routes`; 344/347/352 name
companion-memory-api rate-limit / lessons-memory-rows / orgs-routes /
drone-mesh-rce), not a union defect — this lane's commits are docs-only
and cannot move a route's auth code path. The class still deserves its
own lane (repro serially per the known pollution class); it does not
block this PR.

## Commits on this branch (this lane's, oldest → newest)

| commit | one line |
|---|---|
| `d480f79f` | the union merge: origin/master merged; the one conflict (bench README arm roster) resolved as the union; registry proof quoted |
| `d64686fa` | docs cure: "190 files" (README/CLAUDE/CONTRIBUTING) + the four receipts linked from CONTRIBUTING's Work-receipts index |
| `bedcb7ef` | regimes.md regenerated on the union (21 run files in 11 regimes; stamp = the newest run's date_utc) |
| `11350c72` | the four receipts' private lab paths rewritten (the broad sweep's six hits; method stays, paths go) |
| (this commit) | the F-364 receipt + its CONTRIBUTING index line + the bench-README truth row (the regime-machinery table's observed output re-verified on the union: 21/11, sha `4f5c125ae5e77ad0…` — task 340's every-claim-quotes-its-observation contract) |

Tip for the director's push: this commit IS the branch tip of
`pr/regime-table-union`; the tip sha is quoted in the lane's platform
post. Every gate quote above ran on exactly these bytes.

## Note for whoever re-runs the suite in this worktree

The PR body for the director lives UNTRACKED at
`docs/reviews/PR-214-UNION-BODY.md` in this worktree. The reachability
gate deliberately gates untracked-but-addable docs, and that body's
basename is unlinked by design (it is a paste-me file, not a shipped
doc) — so a full-suite re-run in THIS worktree with the body file
present will red `docs-reachability` on exactly that one file. That red
is the body's presence, not the branch's: untracked files never push,
and CI runs a clean checkout of the merge ref, where the file does not
exist. Move the body aside (or delete it after pasting) before a local
re-run if you want the suite's own green unchanged.

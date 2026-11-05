# Receipt — lane F-mycelium task 340: bench/memory README truth pass after 333/337/335

Lane: F-mycelium · task 340 · branch `lane/f-mycelium-340-readme`
(its own worktree — the lab's private checkout, named without a path),
cut from master `b832052d` — the BASE
CHECK ran first: `git log --oneline -3 master` showed 337's commits at the tip
(`b832052d` task-337 receipt, `b15dd64c` 333-F3, `428fb701` 333-F2). Docs-only
change: `bench/memory/README.md` is the only tracked file touched (no grading
file — lane rule 4 clean). Branch-only local commits; not pushed, not merged —
the director lands.

## Before/after

`git diff --stat`: `bench/memory/README.md | 118 insertions(+), 9 deletions(-)`.

**Corrected (old → new), every one re-derived from master's files:**

1. **`--arms` flag list omitted `mycelium-timeline`.** The registry is the arm
   list — `node --input-type=module -e "import('./bench/memory/arms/index.mjs').then(m=>console.log(Object.keys(m.ARM_FACTORIES).join(',')))"`
   → `none,mycelium,mem0,mem0-raw,zep,letta,mycelium-extract,mycelium-timeline`.
   The flag line and the Layout `arms/` line now both carry it.
2. **The Arms section never introduced the timeline arm** — while the README's
   own re-answer section says "the timeline arm's n=50 write is ~9 h" (an arm
   the reader had never met). Added a `mycelium-timeline` bullet: episodic +
   reconciled layers, ADD/SUPERSEDE/KEEP per-row decisions
   (`meta.write_decisions`), read policy `fact-episode-interleave` (+ its
   `-history` variant), phrased from `arms/arm_mycelium_timeline.mjs`'s own
   header and exports.
3. **The judge label rule was headed "judge prompt v2, `judge-prompt.2`" as if
   current.** `grep "JUDGE_PROMPT_VERSION =" bench/memory/judge.mjs` →
   `'judge-prompt.4'`. Header now states the current stamp is v4 (gold
   classified first, then prompt-by-class) and the WRONG/PARTIAL/EXACT rubric
   below is the FACT-gold branch — the v2 text byte-identical inside v4
   (judge.mjs's own words). Also: the intro's label set now notes abstention
   golds are a binary EXACT / WRONG branch (`ABSTENTION_RULES`: "Respond with
   exactly one word: EXACT or WRONG.").
4. **The 2×2 render sentence said "in one run".** Since task 183 the grid
   renders `renderIngestionGrid` over the UNION of arms across composed runs;
   the renderer returns nothing unless all four arms are present. Sentence now
   says both paths.
5. **The Layout block omitted `grid.mjs`** (the composer — load-bearing since
   333) and had split.mjs/receipt.mjs descriptions merged on one line; the
   `arms/` line omitted `arm_mycelium_timeline`. Fixed all three.
6. **THE RECEIPT had no mention at all.** Added a short section: what the
   repair-class set is (ON/OFF lessons arm, code-gate grading, sign test,
   repair-class only, 4 specimens → 8 fires, p ≥ 0.125 directional), where it
   lives (the lab's private repository, named without a path — the
   pre-registration ships with the result; no prereg text duplicated), that NOTHING has fired (dir holds prereg +
   frozen set only, verified by ls), and the two-frontier-review rule before
   any fire.

**Added (deliverable 1):** the regime machinery table at the top of the regime
section — flag / file / what it does / the command that shows it, every command
executed on master @ `b832052d` during this task (outputs quoted verbatim in
the README):

| what | the command | observed |
|---|---|---|
| regime table | `node bench/memory/regimes.mjs` | `regimes: 20 banked run files in 10 regimes; 4 composed grids audited (mixed: 0, unverifiable citations: 2)`, EXIT=0, `git diff --stat bench/memory/regimes.md` EMPTY, sha256 `91338344037f7cdbae74d219e2af1c0f58fd781b14649a73d10e41f19b1ed2c9` — the exact value 337's receipt recorded |
| composer refusal | `node bench/memory/run.mjs --grid-from-results bench/memory/results/2026-09-08-p1-185920,bench/memory/results/2026-09-17-p1-225526` | EXIT=1, naming `judge.judge_prompt_version`, `answerer.model`, `n`, `question_ids` (this committed two-regime pair also differs on comparability keys — `assertComparable` runs BEFORE the regime guard, grid.mjs) |
| regime guard + `--allow-mixed-regime` | `npx vitest run test/unit/bench-memory-grid.test.js` | 80 passed, EXIT=0 (describe `task 333 — a mixed-regime pair refuses unless allowMixedRegime`). No committed pair is comparability-clean-but-regime-split, so the fixtures are the guard's CLI-independent proof — said in the README, not hidden |

## Numbers verified unchanged (the README was mostly true)

- Dataset sha256 = `split.mjs expectedSha256`; 500 items =
  `regime.dataset.items_available` stamped in committed summaries.
- `meta.hits=10` (185920): all 50 rows of `mycelium.rows.jsonl` re-read —
  values `{10}`; the banked **0.380** = that run's `summary.rejudge.json`
  mycelium p1 (judge-prompt.2 pass), rendered in regimes.md regime 3.
- Adoption-gate cell 8/15 = 0.533 — the 224225 v2 rejudge row in regimes.md.
- Pins: `mem0ai==2.0.20`, `ollama==0.6.2`, `graphiti-core[kuzu]==0.30.2`,
  `letta-client==1.12.1`, `letta==0.16.8` — all in the requirements files.
- Env override names (MEM0_/ZEP_/LETTA_ ×4 each), `MEM0_NO_THINK`,
  `MEM0_TELEMETRY=False`, `EDGE_HYBRID_SEARCH_RRF`,
  `GRAPHITI_TELEMETRY_ENABLED=false`, `LETTA_SERVER_URL` (no default),
  `include_base_tools` off, nomic-embed-text @ 768.
- Flag defaults: `--budget` 5, `--answer-model` qwen3.8:27b, `--answer-url`
  BOX_3090_URL+/v1, `--judge-url` localhost:8780/v1, `--judge-model`
  Laguna-XS-2.1-mlx-oq4e-agentic-ours, answer max-tokens default 4096
  (`--answer-max-tokens`), embed-wait cap `Math.max(8*60*1000, rows*500)`,
  `p1_score` weights `{exact:1, partial:0.5, wrong:0}` (judge.mjs
  SCORE_WEIGHT), read policy `fact-episode-interleave`, prereg/ three claim
  files, `meta.read_hits` stamp.
- **Honest note:** the mem0 line-number citations (`mem0/memory/main.py:770` /
  `:880`, `mem0/configs/prompts.py:15`) cite the pinned wheel's source; the
  venv is gitignored so they are NOT re-derivable from a clean checkout —
  a README comment now says exactly that (the pin is the verified part).

Every corrected/verified spot carries a `<!-- verified 2026-11-05 by <command> -->
` comment in the README.

## Suite + links (deliverable 4)

- `npx vitest run test/unit/bench-memory-*.test.js` → **Test Files 32 passed
  (32), Tests 607 passed (607), EXIT=0** (run AFTER the edits; docs-only, and
  still green).
- Link pass (manual): markdown links = 2, both `[regimes.md](regimes.md)` →
  resolves. Inline references to the lab's private planning and prereg
  documents → exist in the private repository (named, not pathed, in the README). External: the HF dataset URL →
  `curl -sI` → **HTTP 302** (HF's standard CDN redirect — resource live).

## Artifacts

| path | mtime |
|---|---|
| `bench/memory/README.md` (the deliverable) | see `ls -l` at commit |
| `docs/receipts/F-340/RECEIPT.md` (this file) | see `ls -l` at commit |
| `bench/memory/regimes.md` | UNCHANGED — regenerated byte-identical, no diff |

No merge, no push, no model call, no seat touched, no grading file edited
(lane rules 2/4/6). Review B is the director's.

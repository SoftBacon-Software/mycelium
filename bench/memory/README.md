# bench/memory — the memory benchmark (P1)

One harness we control, regime-stamped, receipt-gated. Task 163 = the
SKELETON: two arms (`none`, `mycelium`) on LongMemEval-S. Task 169 landed
the first competitor arm (`mem0` — Mem0 OSS via a local sidecar); task 180
the second (`zep` — Zep's OSS graphiti on its embedded kuzu store); task 181
the third (`letta` — the OSS Letta server's archival memory via its official
client SDK).

Program: `jarvis/runs/fable-specs/BRIEF-memory-sota-program.md` §P1.

**Pre-registrations:** `prereg/` — the three publishable claims (task
F-mycelium 244), written before any run and cut once: the 30-night receipt,
model-swap identity, supersede-with-history vs last-writer-wins.

## Run it

```bash
# the gate command (writes the receipt + two rows):
node bench/memory/run.mjs --split longmemeval --arms none,mycelium --n 50 --receipt

# useful flags
#   --budget 5              retrieval top-k (regime parameter)
#   --keep                  do NOT delete the run's rows from the platform
#   --answer-url URL        OpenAI-compatible answer endpoint (default: BOX_3090_URL from substrate.conf + /v1)
#   --answer-model ID       (default qwen3.8:27b)
#   --arms LIST             subset of none,mycelium,mycelium-extract,mycelium-timeline,
#                           mem0,mem0-raw,zep,letta (default none,mycelium)
#   --judge-url URL         (default http://localhost:8780/v1 — the served XS seat)
#   --judge-model ID        (default Laguna-XS-2.1-mlx-oq4e-agentic-ours)
#   --handlabels FILE       judge-agreement vs a hand-scored set (see below)
#   --from-results DIR      rebuild the receipt from a finished run's own output
#   --retrieval-audit       grid receipts: render the retrieval audit (task 207)
#                           — per type × arm hit@budget / median gold rank / MRR
#                           over STAMPED rows (meta.read_hits), the gold-mapping
#                           method + coverage, and the pre-committed diagnostic
#                           branch (budget-10 replay vs answer-side transcripts)
#   --question-type T       run ONLY the selected items of that type (the
#                           budget-10 diagnostic replay lever) — the receipt is
#                           stamped NON-COMPARABLE: do not grid, do not quote
#
# re-judge a saved run under the CURRENT judge rubric (task 168):
#   node bench/memory/run.mjs --from-results bench/memory/results/<runId> \
#     --rejudge --handlabels bench/memory/handlabels/<file>.json --receipt
# (judge-only: no answerer calls, no platform calls; writes judged.rejudge.jsonl
#  + summary.rejudge.json beside the originals and a `<runId>-rejudge` receipt)
#
# re-answer a KEPT run under the CURRENT read policy (task 188) — answer + judge
# only, against the run's kept namespaces (write side reused):
#   node bench/memory/run.mjs --reanswer bench/memory/results/<runId> --receipt
# (refuses if the run's rows were purged; writes <arm>.rows.reanswer-<policy>.jsonl
#  + judged.reanswer-<policy>.jsonl + summary.reanswer-<policy>.json beside the
#  originals and a `<runId>-reanswer-<policy>` receipt)
```
<!-- verified 2026-11-05 by: the flag list re-derived from the registry —
     node --input-type=module -e "import('./bench/memory/arms/index.mjs').then(m=>console.log(Object.keys(m.ARM_FACTORIES).join(',')))"
     → none,mycelium,mem0,mem0-raw,zep,letta,mycelium-extract,mycelium-timeline
     (the pre-340 line omitted mycelium-timeline). The flag defaults re-read in
     bench/memory/run.mjs — --budget default '5' (run.mjs), --answer-url default
     BOX_3090_URL + /v1 and --answer-model default qwen3.8:27b (run.mjs),
     --judge-url default http://localhost:8780/v1 and --judge-model default
     Laguna-XS-2.1-mlx-oq4e-agentic-ours (run.mjs), --max-sessions /
     --question-type / --rejudge-suffix / --grid-from-results / --rejudge-pass /
     --allow-mixed-regime all parsed (run.mjs parseArgs + branches) -->

Cost: $0 — the answerer and the judge are both local models.

## Dataset provenance

- **Split:** LongMemEval-S (cleaned), 500 items.
- **File:** `bench/memory/data/longmemeval_s_cleaned.json` (gitignored — never committed).
- **URL:** https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
- **sha256:** `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
  <!-- verified 2026-11-05 by: grep expectedSha256 bench/memory/split.mjs (same
       hex, the loader's gate); 500 items per regime.dataset.items_available=500
       stamped in the committed summaries (e.g. results/2026-09-08-p1-185920/summary.json)
       — the corpus file itself is gitignored and not re-hashed on a clean checkout -->

- **Licence:** MIT (dataset card: "License: mit"). We do not redistribute the
  corpus; the pinned URL + sha is the provenance. Cite:
  Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term
  Interactive Memory*, ICLR 2025.
- The loader REFUSES to run against a file whose sha256 does not match —
  dataset identity is part of the regime stamp.
- Selection rule (deterministic, stamped): sort by `question_id` ascending,
  take the first n. Same split + same n ⇒ same items forever.
- Note: the cleaned S split's abstention variants are the question_ids carrying
  the `_abs` suffix (e.g. `0862e8bf_abs`). Observed, not documented upstream:
  every `_abs` gold in run 2026-09-17-p1-224225 begins "The information
  provided is not enough" / "You did not mention". The judge classifies the
  gold by that marker FIRST (task 226, judge-prompt.4) — a fact gold is never
  judged under the abstention rule. The non-`_abs` types:
  single-session-user/assistant/preference, multi-session, temporal-reasoning,
  knowledge-update.

## The regime stamp

Every result row and the receipt carry:

```json
{ "date_utc", "git_sha", "git_dirty", "harness",
  "dataset": {name, file, sha256, licence, url, items_available},
  "answerer": {model, url_host, temperature, max_tokens},
  "judge": {model, url_host, judge_prompt_version},
  "retrieval": {budget, chunking, source_type, namespace, server_mode},
  "platform": {url_host, version, embedding_provider, embedding_model, chunk_size},
  "n", "selection_rule", "notes" }
```

The platform address is never hardcoded: resolved from `MYCELIUM_URL`, else
`~/.claude/hooks/substrate.conf`. The admin key: `MYCELIUM_ADMIN_KEY`, else
the keychain service named in the same conf.

**One regime per grid (task 333).** The same model name on another box is
another regime: the grid composer refuses a composition whose runs differ on
`answerer.url_host`, `answerer.temperature`, `judge.url_host`, or on any
platform field both runs stamp (a platform-NULL run — the mem0 shape —
composes with a stamped one; absence is shown, never judged). The refusal
lifts only under `--allow-mixed-regime`, and the receipt then prints the
regimes side by side under a bold MIXED REGIME banner — never silently.
Every banked run file, one row per run × arm, grouped by regime, with a
regime audit of every composed grid receipt:
[`bench/memory/regimes.md`](regimes.md), regenerated by
`node bench/memory/regimes.mjs`.

**Regime machinery — flag / file / what it does / the command that shows it.**
Every command below was run on master @ `b832052d`, 2026-11-05 (task 340):

| what | file | what it does | the command that shows it |
|---|---|---|---|
| the regime table | `bench/memory/regimes.mjs` → `bench/memory/regimes.md` | every banked run file × arm, grouped by regime, plus a MIXED audit of every committed grid receipt; regeneration is byte-stable (the stamp is the newest banked run's `date_utc`, not the wall clock) | `node bench/memory/regimes.mjs` → `regimes: 20 banked run files in 10 regimes; 4 composed grids audited (mixed: 0, unverifiable citations: 2)`; a re-run on a clean tree leaves `git diff --stat bench/memory/regimes.md` EMPTY (sha256 `91338344037f7cdb…`, stable across regenerations) |
| committed table = regenerated | `test/unit/bench-memory-regimes-committed.test.js` (task 341) | the equality above made permanent: renders the table in-process through the CLI's own pipeline (`renderRegimes()` — one function, no second renderer) and FAILS with a unified diff (first 40 lines) + the fix command the moment the committed `regimes.md` drifts from the tool; a second test renders twice and compares, and pins the stamp to the runs' newest `date_utc` (no wall clock) | `npx vitest run test/unit/bench-memory-regimes-committed.test.js` → **2 passed**, EXIT=0; with one digit planted wrong in a committed row (`0.380`→`0.381`) → **1 failed** at `@@ -24,11 +24,11 @@` showing the planted cell vs the tool's, restored → **2 passed** |
| the composer | `bench/memory/grid.mjs` (`composeGrid`) | `--grid-from-results <dir,…>` composes the grid receipt from finished run dirs; incomparable runs refuse with exit 1 naming every differing key | `node bench/memory/run.mjs --grid-from-results bench/memory/results/2026-09-08-p1-185920,bench/memory/results/2026-09-17-p1-225526` → **exit 1**, naming `judge.judge_prompt_version`, `answerer.model`, `n`, `question_ids` (this committed two-regime pair also differs on comparability keys, so comparability names first) |
| the regime guard | `bench/memory/grid.mjs` (`REGIME_ENFORCED_KEYS`, `findRegimeDifferences`) | additionally refuses a composition whose runs differ on `regime.answerer.url_host`, `regime.answerer.temperature`, `regime.judge.url_host`, or any platform field BOTH runs stamp — the seat move comparability cannot see (a platform-NULL run — the mem0 shape — still composes; absence is shown, never judged) | `npx vitest run test/unit/bench-memory-grid.test.js` → **80 passed** (describe `task 333 — a mixed-regime pair refuses unless allowMixedRegime`; no committed pair is comparability-clean-but-regime-split, so the fixtures in that describe are the guard's proof) |
| `--allow-mixed-regime` | `bench/memory/run.mjs` → `composeGrid({ allowMixedRegime })` | lifts ONLY the regime guard — every comparability key stays unconditional — and the receipt then prints the regimes side by side under a bold `## MIXED REGIME` banner | the same describe: the mixed-path assertions pin both the banner and the "the runs' regimes DIFFER — composed under --allow-mixed-regime" opening line (task 333-F1), and the clean path keeps the one-regime sentence |

<!-- verified 2026-11-05 by: all four commands executed on master @ b832052d in
     the task-340 worktree; outputs quoted verbatim above. regimes.md sha256
     91338344037f7cdbae74d219e2af1c0f58fd781b14649a73d10e41f19b1ed2c9 matched
     the value task 337's receipt recorded.
     task-341 row: npx vitest run test/unit/bench-memory-regimes-committed.test.js
     → 2 passed, EXIT=0; plant (sed 0.380→0.381 in one committed row) →
     Test Files 1 failed (1), Tests 1 failed | 1 passed (2) with the
     @@ -24,11 +24,11 @@ hunk; git checkout -- → 2 passed, EXIT=0, tree diff 0 lines. -->

## THE RECEIPT — the repair-class prereg (jarvis side, not this repo)

THE RECEIPT is the lab's lessons-on-vs-off experiment: repeat tasks fired
twice — same id, same seat, same recovered base, both arms — once with
yesterday's lessons injected into the brief (ON) and once without (OFF),
graded by the workflow's own code gates (never a model judge) and analysed as
a two-sided exact sign test on the discordant pairs. The first frozen set is
**repair-class only** — the 2026-11-04 census's only class with ≥ 3 fireable
candidates — 4 specimens → 8 fires; at n = 4 the smallest achievable two-sided
p is 0.125, so the claim is directional by construction (pre-committed as
such in the prereg).

It lives in the jarvis checkout (a sibling repo):
`~/Projects/jarvis/training/glm-distill/eval/receipt/repair-set-2026-11-05.PREREG.md`,
written BEFORE any fire, with the frozen set
(`repair-set-2026-11-05.json`, selection sha256 `24daf61d1a1d…`) beside it.
**Nothing has fired** — as of 2026-11-05 that directory holds only the prereg
and the frozen set. A fire run is a separate, later decision, gated by the
house two-frontier-review rule (two frontier reviews that converge on the
same sha) before any seat runs. The prereg text is not duplicated here —
read the file; it is the claim of record.
<!-- verified 2026-11-05 by: ls of that jarvis directory (2 files, no fire
     output); facts read from the prereg itself; selection sha256 quoted from it -->

## Arms

An arm exposes `write(sessionTurns, {questionId})` and `answer(question) → {text, meta}`.

- **`none`** — no memory. Answers from the question alone.
- **`mycelium`** — the platform's memory API. write: one memory row per
  haystack session under `source_type=bench_longmemeval`,
  `namespace=bench-p1-<runId>` (strict SQL-level scope on both keyword and
  vector search — no leakage in or out). answer: hybrid `/memory/search` at
  the retrieval budget, retrieved rows become the answer context. The same
  answer model is used for both arms; only the context differs.
- **`mem0`** — Mem0 OSS (`mem0ai`) via a local Python sidecar
  (`arms/mem0_sidecar.py`, see below). write: one `add()` per haystack
  session (Mem0's own LLM fact extraction, not bypassed). answer: Mem0
  search at the retrieval budget, memories joined into the SAME RAG prompt
  arm_mycelium uses, same answer model. Scope = one `user_id` per run — the
  same granularity as the mycelium namespace.
- **`zep`** — Zep's OSS graph memory (`graphiti-core`) via a local Python
  sidecar (`arms/zep_sidecar.py`, see below). write: one Graphiti
  `add_episode()` per haystack session (entity/edge extraction via the LLM,
  not bypassed). answer: `graphiti.search()` at the retrieval budget, the
  retrieved facts joined into the SAME RAG prompt the other arms use, same
  answer model. Scope = one graphiti `group_id` per run — the same
  granularity as the mycelium namespace and the mem0 `user_id`.
- **`letta`** — the OSS Letta server's (formerly MemGPT) archival memory via
  a local Python sidecar (`arms/letta_sidecar.py`, see below). write: one
  archival **passage** per haystack session (the session flattened to
  `role: content` text — Letta's passages API does not chunk, and its agent
  loop is deliberately NOT run). answer: archival semantic search
  (`agents.passages.search`, the API twin of the agent's
  `archival_memory_search` tool) at the retrieval budget, joined into the
  SAME RAG prompt the other arms use, same answer model. Scope = one Letta
  agent per run (created lazily, reattached across sidecar restarts via a
  state file, deleted at teardown unless `--keep`).
- **`mem0-raw`** (task 182) — the Mem0 RAW-ingestion control. Identical to
  `mem0` except `Memory.add(..., infer=False)` (mem0ai 2.0.20,
  `mem0/memory/main.py:770`; the raw path `_add_to_vector_store` at
  `:880` stores each non-system message verbatim — no LLM in the write
  path). Scope is suffixed `-raw` so the two mem0 arms never share a store
  or a resume checkpoint.
- **`mycelium-extract`** (task 182) — the Mycelium EXTRACTION control.
  Identical to `mycelium` in retrieval + answer (same hybrid search, same
  budget, same RAG prompt — asserted byte-identical in tests), but write
  first distills each session into a fact list with the answerer model
  (temperature 0, thinking OFF) and indexes ONE ROW PER FACT into a
  `-extract`-suffixed namespace. See the next section.
- **`mycelium-timeline`** — the timeline arm (BRIEF-lab-alive-memory-program §3).
  Two linked layers, one namespace each (the base namespace + a `-timeline`-
  suffixed one): an EPISODIC layer byte-for-byte identical to the `mycelium`
  arm's write (one raw row per session), and a RECONCILED layer — the same
  extractor call as `mycelium-extract` (thinking off), each candidate fact
  reconciled against the user's current facts by ONE decision call
  (temperature 0, thinking off): ADD / SUPERSEDE / KEEP, stamped per row as
  `meta.write_decisions` (a superseded fact is never deleted — it gains
  `valid_to` + a `superseded_by` pointer). Read policy
  `fact-episode-interleave`, stamped `regime.timeline.read_policy`
  (`fact-episode-interleave-history` is the measured variant): facts and
  episodes interleave f,e,f,e,… INSIDE the same retrieval budget, so the
  verbatim episodic layer always reaches the answerer. This is the arm behind
  every banked September-17+ timeline run — see
  [`regimes.md`](regimes.md).
  <!-- verified 2026-11-05 by: bench/memory/arms/arm_mycelium_timeline.mjs
       header + TIMELINE_READ_POLICY/TIMELINE_READ_POLICY_HISTORY exports;
       the ADD/SUP/KEEP totals rendered per row in bench/memory/regimes.md -->
- Rows are deleted from the platform after the run (per-source_id DELETE,
  verified 0 remaining) unless `--keep`. The mem0 arm never touches the
  platform; its store is a per-run local dir, purged after the run unless
  `--keep`.

**Budget wiring (fixed 2026-09-09).** Arms destructure `retrievalBudget`, but
`run.mjs` used to pass only `budget` — so the mycelium arm searched with the
SERVER's default limit (10) while the regime stamped 5. Evidence: every
mycelium row in run `2026-09-08-p1-185920` shows `meta.hits=10`. The none-vs-
mycelium comparison inside that run still stands (one answerer, one judge, one
run), but its stamped budget was not the exercised budget; treat the banked
0.380 as a **top-10** number. `run.mjs` now carries `retrievalBudget`, and both
arms refuse a factory call without a positive-int budget, so this class of
drift fails loudly before any rows are written.
<!-- verified 2026-11-05 by: all 50 rows of results/2026-09-08-p1-185920/
     mycelium.rows.jsonl re-read — meta.hits values = {10}; the 0.380 is the
     mycelium p1 of that run's summary.rejudge.json (judge-prompt.2 pass),
     rendered in bench/memory/regimes.md regime 3 -->

## Ingestion controls — the {Mycelium, Mem0} × {raw, extract} 2×2 (task 182)

The as-shipped grid compares systems AS SHIPPED: arm mycelium writes one raw
row per session, arm mem0 runs LLM fact extraction. That confounds two
decisions — **what a system writes** (ingestion policy) and **how well it
finds it later** (retrieval). A mycelium-vs-mem0 gap could be extraction
helping, or retrieval being better, or both. Task 182 adds the two off-diagonal
arms so each factor can be read separately:

| system \ ingestion | raw (no extraction) | extract (LLM extraction) |
|---|---|---|
| **Mycelium** | `mycelium` (as shipped) | `mycelium-extract` |
| **Mem0** | `mem0-raw` | `mem0` (as shipped) |

Reading it: `mycelium` vs `mycelium-extract` is the effect of extraction ON
Mycelium's retrieval; `mem0-raw` vs `mem0` is the same effect on Mem0's;
`mycelium-extract` vs `mem0` is extraction-vs-extraction (a fair retrieval
race); `mycelium` vs `mem0-raw` is raw-vs-raw. The receipt renders this table
(from the run's own scores, rendered not typed) whenever all four arms are
present — in one run, or across the UNION of arms a composed grid draws from
several finished runs (`--grid-from-results`).
<!-- verified 2026-11-05 by: bench/memory/ingestion.mjs renderIngestionGrid
     returns null unless all four arm names are present; bench/memory/grid.mjs
     renders it over buildUnion(runs) (the task-183 composition) -->

**Arm design.**

- `mem0-raw`: identical to `mem0` except every `add()` passes
  `infer=False` (`mem0/memory/main.py:770`), which stores each non-system
  message verbatim (`:880`) — Mem0's own raw mode, not a bypass of it. Same
  embedder, budget, RAG prompt, answerer as `mem0`. Isolation: scope suffixed
  `-raw`, and its resume checkpoint file is separate, so a restart never
  lets one arm skip sessions the other committed.
- `mycelium-extract`: retrieval + answer are the SAME code path as
  `mycelium` (the test asserts the answer prompt is byte-identical given the
  same retrieval). Write extracts first: the answerer model
  (`qwen3.8:27b`, temperature 0, `--extract-max-tokens` default 4096) reads
  the session transcript and returns `{"facts": [...]}`; each fact is POSTed
  to `/memory/index` as its own row. The extraction prompt
  (`arms/arm_mycelium_extract.mjs EXTRACTION_SYSTEM`) mirrors the STRUCTURE
  of mem0's `FACT_RETRIEVAL_PROMPT` (mem0ai 2.0.20,
  `mem0/configs/prompts.py:15`: role statement → what counts as a fact →
  few-shot pairs → JSON contract + rules) with wording paraphrased, not
  copied — so both extraction arms ask the model for the same KIND of
  output without shipping vendor text.

**Row shape: one row per fact (stamped `facts_row_shape: one_row_per_fact`).**
Arm mem0 stores one memory per extracted fact, so per-fact rows are what an
extraction step produces upstream of retrieval; indexing the whole fact list
as ONE row would change the size of each retrieved context chunk and
re-confound the comparison this arm exists to remove (bigger rows ≈ more
context, not better memory). The receipt stamps facts-per-session stats
(count, mean, min, max) next to the grid so the extraction rate is visible.

**Extraction thinking is OFF in both extraction arms (stamped).** The 3090
serves ONE llama.cpp slot; thinking-on extraction burned ~300 reasoning
tokens per add. `mycelium-extract` calls the answerer endpoint with
`chat_template_kwargs {"enable_thinking": false}`. For mem0, the sidecar
(`arms/mem0_sidecar.py`) starts an in-process forwarding proxy
(stdlib `http.server`, 127.0.0.1, ephemeral port) when
`MEM0_NO_THINK=1` (the default — set `MEM0_NO_THINK=0` to escape-hatch back
to thinking-on) and injects that same kwarg into every `/v1/chat/completions`
body before forwarding to `MEM0_LLM_BASE_URL`; Mem0's LLM client is pointed
at the proxy, and the proxy's presence is stamped into the sidecar `/health`.
A run refuses to start if its arms would mix extraction-thinking modes
unstamped (`assertNoExtractionThinkingMix`) — raw arms are exempt (no LLM in
their write path).

**Commands.** Capped smoke (controls only, 1 question, 5 sessions):

```bash
node bench/memory/run.mjs --split longmemeval --arms mem0-raw,mycelium-extract --n 1 --max-sessions 5
```

Full n=50 grid with all four arms (single run, single judge):

```bash
node bench/memory/run.mjs --split longmemeval --arms mycelium,mycelium-extract,mem0,mem0-raw --n 50
```

## The mem0 arm (sidecar setup)

Mem0 is Python; the arms are JavaScript. `arm_mem0.mjs` spawns
`arms/mem0_sidecar.py` (stdlib `http.server`, 127.0.0.1 only), learns its
ephemeral port from a `MEM0_SIDECAR_READY <port>` stderr line, and stops it
gating on BOTH child exit AND the port actually being freed. One-time setup:

```bash
python3.12 -m venv bench/memory/arms/.mem0-venv
bench/memory/arms/.mem0-venv/bin/pip install -r bench/memory/arms/mem0-requirements.txt
```

Pinned there: `mem0ai==2.0.20`, `ollama==0.6.2` (mem0 2.0.20's default vector
store is **qdrant local mode** — path-based, no server, no keys). Addresses
resolve from env / substrate.conf, never literals: LLM =
`BOX_3090_URL` + `/v1` (the SAME answerer the other arms use — Mem0's fact
extraction runs on it too); embedder = `OLLAMA_URL`, else the `MYCELIUM_URL`
host's `:11434` (the platform host's ollama). Env overrides:
`MEM0_LLM_BASE_URL`, `MEM0_EMBEDDER_BASE_URL`, `MEM0_EMBEDDER_DIMS`,
`MEM0_SIDECAR_PYTHON`.
<!-- verified 2026-11-05 by: bench/memory/arms/mem0-requirements.txt pins
     mem0ai==2.0.20 + ollama==0.6.2; the four env names re-read in
     arms/mem0_sidecar.py + arms/arm_mem0.mjs. The mem0 line-number citations
     in this section (mem0/memory/main.py:770 / :880, mem0/configs/prompts.py:15)
     cite the pinned wheel's source — the venv is gitignored, so they are NOT
     re-derivable from a clean checkout; the pin is the verifiable part. -->

The sidecar's unittest (request/response shapes, fake Mem0 client,
127.0.0.1-only):

```bash
bench/memory/arms/.mem0-venv/bin/python -m unittest -v bench/memory/arms/test_mem0_sidecar.py
```

Quirks measured on the live rig (2026-09-08, sidecar probe):

- **The Jetson's `nomic-embed-text` emits 768-dim vectors, not the 512 mem0
  assumes.** `MEM0_EMBEDDER_DIMS=768` is the default here; a mismatch surfaces
  as a qdrant shape error on the first `add()`.
- **Mem0 phones home (PostHog) unless told not to.** The sidecar sets
  `MEM0_TELEMETRY=False` before importing mem0 — a $0 clean-room arm makes no
  external calls.
- **One `add()` = one extraction LLM call + one embed + N fact embeds.** A
  real 20 KB / 12-turn session took ~30 s end-to-end against qwen3.8:27b on
  the 3090. LongMemEval-S items carry ~50 sessions each, so the WRITE phase
  dominates: ~25 min per item. Budget accordingly (the n=50 run is a
  detached, multi-hour affair).
- BM25/rerank (`mem0ai[extras]`, `mem0ai[nlp]`) are NOT installed — the arm
  runs mem0's default OSS retrieval (pure vector over the local qdrant
  store), which is what the receipt's regime block stamps.

## The zep arm (sidecar setup)

Zep's OSS engine is Graphiti (Python; the arms are JavaScript). `arm_zep.mjs`
spawns `arms/zep_sidecar.py` (stdlib `http.server`, 127.0.0.1 only), learns
its ephemeral port from a `ZEP_SIDECAR_READY <port>` stderr line, and stops it
gating on BOTH child exit AND the port actually being freed. One-time setup:

```bash
python3.12 -m venv bench/memory/arms/.zep-venv
bench/memory/arms/.zep-venv/bin/pip install -r bench/memory/arms/zep-requirements.txt
```

Pinned there: `graphiti-core[kuzu]==0.30.2` — the `kuzu` extra is Graphiti's
ONLY embedded graph store (file-backed, dockerless; no Neo4j/FalkorDB server
is installed). ⚠ graphiti-core marks the kuzu backend **deprecated** (upstream
kuzu unmaintained); it is stamped into the regime (`regime.zep.graph_store`)
as part of what "Zep OSS, embedded, $0" means on this rig. Addresses resolve
from env / substrate.conf, never literals: LLM = `BOX_3090_URL` + `/v1` (the
SAME answerer the other arms use — Graphiti's entity/edge extraction runs on
it too, via `OpenAIGenericClient`'s json_schema structured output); embedder =
`OLLAMA_URL` (or the `MYCELIUM_URL` host's `:11434`) **+ `/v1`** — ollama's
OpenAI-compatible embeddings endpoint, since graphiti-core ships no ollama
embedder class. Env overrides: `ZEP_LLM_BASE_URL`, `ZEP_EMBEDDER_BASE_URL`,
`ZEP_EMBEDDER_DIMS`, `ZEP_SIDECAR_PYTHON`.
<!-- verified 2026-11-05 by: bench/memory/arms/zep-requirements.txt pins
     graphiti-core[kuzu]==0.30.2; the four env names re-read in
     arms/zep_sidecar.py + arms/arm_zep.mjs; EDGE_HYBRID_SEARCH_RRF +
     GRAPHITI_TELEMETRY_ENABLED=false re-read in arms/zep_sidecar.py -->

The sidecar's unittest (request/response shapes, fake Graphiti client,
127.0.0.1-only):

```bash
bench/memory/arms/.zep-venv/bin/python -m unittest -v bench/memory/arms/test_zep_sidecar.py
```

Regime-critical configuration (all stamped via the sidecar's `/health`):

- **Search = `graphiti.search()`'s default config, EDGE_HYBRID_SEARCH_RRF**
  (bm25 + cosine fused by RRF) — NO LLM reranker. Graphiti's default
  cross-encoder (`OpenAIRerankerClient`) makes one boolean LLM call per fact
  per query and hardcodes OpenAI-tokenizer logit_bias (cl100k ids for
  "True"/"False" — wrong for a qwen tokenizer) with max_tokens=1, which a
  thinking model burns on its reasoning open. RRF is a first-class Graphiti
  recipe; the constructor-required cross-encoder is a counted no-op.
- **Telemetry force-disabled** — `GRAPHITI_TELEMETRY_ENABLED=false` before the
  import (PostHog ships as a hard dependency). A $0 clean-room arm makes no
  external calls.
- **One `add()` = one full extraction pass** (entities + edges + resolution) —
  expect it to cost at least what mem0's extraction costs per session; budget
  the write phase accordingly and use `--max-sessions N` for smokes.

## The letta arm (sidecar setup + storage requirement)

Letta's OSS server is Python; the arms are JavaScript. `arm_letta.mjs` spawns
`arms/letta_sidecar.py` (stdlib `http.server`, 127.0.0.1 only), learns its
ephemeral port from a `LETTA_SIDECAR_READY <port>` stderr line, and stops it
gating on BOTH child exit AND the port actually being freed. The sidecar
drives the letta server over the official `letta-client` SDK — it never runs
the agent loop. One-time setup:

```bash
python3.12 -m venv bench/memory/arms/.letta-venv
bench/memory/arms/.letta-venv/bin/pip install -r bench/memory/arms/letta-requirements.txt
```

Pinned there: `letta-client==1.12.1` (the SDK the sidecar imports) and
`letta==0.16.8` (the OSS server version under test — provenance pin; the
sidecar stamps the version the server REPORTS and flags a mismatch via
`letta_version_matches` rather than refusing).

⚠ **THE STORAGE DIFFERENCE — read before pointing this arm anywhere.** OSS
letta 0.16.8 cannot run without a PostgreSQL+pgvector SERVER: `asyncpg` is a
hard ORM import, `db.py` has no sqlite branch, and the `[sqlite]` extra ships
non-functional (evidence: `letta-requirements.txt`). This harness does not
install a database server — that is a director decision. So unlike the
mem0/qdrant and zep/kuzu arms there is NO embedded store here: the sidecar
fronts an ALREADY-RUNNING letta server at `LETTA_SERVER_URL` (env or
substrate.conf — no default, this harness never hardcodes an address), and
`/health` PROBES that server: `ok:false` fails the boot gate, because an arm
whose memory system is unreachable must not start a run. Per-run isolation is
a fresh letta AGENT (archival-only: `include_base_tools=False`, no core
memory blocks), persisted by agent id in a state file keyed by runId so a
restarted sidecar or a resumed run REATTACHES instead of forking the run's
memory; teardown deletes the agent unless `--keep`. Addresses resolve from
env / substrate.conf, never literals: the agent's LLM = `BOX_3090_URL` + `/v1`
(the SAME answerer the other arms use), embedder = `OLLAMA_URL` (or the
`MYCELIUM_URL` host's `:11434`), model `nomic-embed-text` @ 768 dims —
measured on the platform host. Env overrides: `LETTA_LLM_BASE_URL`,
`LETTA_LLM_MODEL`, `LETTA_EMBEDDER_BASE_URL`, `LETTA_EMBEDDER_DIMS`,
`LETTA_SIDECAR_PYTHON`.
<!-- verified 2026-11-05 by: bench/memory/arms/letta-requirements.txt pins
     letta-client==1.12.1 + letta==0.16.8; LETTA_SERVER_URL (required, no
     default), include_base_tools off, nomic-embed-text @ 768 re-read in
     arms/letta_sidecar.py + arms/arm_letta.mjs -->

The sidecar's unittest (request/response shapes, fake Letta client, the
two-stage stop protocol, the reattach behaviour; 127.0.0.1 only):

```bash
bench/memory/arms/.letta-venv/bin/python -m unittest -v bench/memory/arms/test_letta_sidecar.py
```

## Judge + validation

The judge is a LOCAL model (default: the served XS seat at oMLX :8780 — a
different model family from the answerer, so it is not self-grading), prompted
to emit exactly one label: EXACT / PARTIAL / WRONG (fact golds; abstention
golds are a binary EXACT / WRONG branch — see the label rule below). Unparsable
judge replies
count as wrong AND are reported (`unparsed`) — a judge that cannot answer is
not silently a pass.

**The label rule — the FACT-gold rubric (`judge-prompt.2` text, byte-identical
inside the current `judge-prompt.4`)** — applied in this order:
<!-- verified 2026-11-05 by: grep "JUDGE_PROMPT_VERSION =" bench/memory/judge.mjs
     → 'judge-prompt.4'; judge.mjs exports FACT_SYSTEM/FACT_RULES with the
     comment "the v2 prompt, byte-identical to task 168's"; v4 = the gold is
     classified FIRST (dataset _abs marker, else one YES/NO call) and the fact
     branch is the v2 text verbatim. The pre-340 header named only v2. -->

- **WRONG** — the answer does not state the gold fact: any refusal, "I don't
  know" / "not in my memory", a restatement of context or memory without the
  fact itself, an answer to a different question, or an answer asserting a
  different fact.
- **PARTIAL** — the answer states part of the gold fact correctly (a name
  without the date, a number off only by rounding, one of two items). If no
  part of the gold fact appears, the label is WRONG, not PARTIAL.
- **EXACT** — the answer states the gold fact, however phrased.

The version is stamped into every regime (`judge.judge_prompt_version`) and
into every rejudge summary/receipt: two runs judged under different rubric
versions are not comparable, and the stamp is what makes that visible.

Why v2 exists: v1 defined PARTIAL as "same topic, but incomplete", and the
judge spent it on refusals and restated-context non-answers — all four
hand-vs-judge disagreements of run `2026-09-08-p1-185920` ran one way
(hand=wrong, judge=partial). Task 168 made a non-answer wrong by rule and
re-judged the saved run; see that run's `-rejudge` receipt.

**Re-judging a saved run** (`--rejudge`): re-runs ONLY the judge over the
run's saved answers (`<arm>.rows.jsonl`) — no answerer calls, no platform
calls. Writes `judged.rejudge.jsonl` + `summary.rejudge.json` beside the
originals (originals are never touched; an existing rejudge output is refused,
not overwritten) and, with `--receipt`, a `<runId>-rejudge` receipt carrying
the new scores, the old scores, the judge-agreement number, and a regime block
recording `judge_prompt_version` + which run was re-judged.
`--rejudge-suffix <tag>` writes the pass beside a previous one as
`summary.rejudge-<tag>.json` + `judged.rejudge-<tag>.jsonl` (never an
overwrite). **Task 229:** the grid reads a suffixed pass by name —
`--grid-from-results <dirs> --rejudge-pass <tag>` composes every rejudged dir
from ITS `<tag>` pair (a dir whose primary summary.json still exists included;
a dir carrying only that one pair loads it without the flag). The grid's
comparability reads each run's EFFECTIVE judge (a rejudge pair's own stamp,
not its stale regime mirror) and refuses a mixed-judge composition naming both
versions. When the composed pass is run `2026-09-17-p1-224225` under
`judge-prompt.4`, the receipt renders the **pre-committed adoption gate**
(task 226: the 4 `_abs` rows EXACT, the 3 protected rows wrong, hand-vs-judge
agreement ≥ 19/20) BEFORE the scores — `VERDICT: ADOPTED` lets the v4 numbers
be quoted; any failure renders `VERDICT: NOT ADOPTED` and judge-prompt.2's
knowledge-update 8/15 = 0.533 remains the arm's quoted cell.
<!-- verified 2026-11-05 by: bench/memory/regimes.md regime 3,
     results/2026-09-17-p1-224225/summary.rejudge.json row renders
     knowledge-update 8/15 under judge-prompt.2; 8/15 = 0.533 -->

**Re-answering a kept run** (`--reanswer <run dir>`): runs ONLY the answer +
judge phases against the run's KEPT namespaces — the run's regime names them
(`/memory/list` is checked first; a run whose rows were purged is refused).
The write side is reused: the timeline arm's n=50 write is ~9 h of the 3090, so
a READ-policy change should cost an hour of answering, not a night of writing.
Writes `<arm>.rows.reanswer-<policy>.jsonl` + `judged.reanswer-<policy>.jsonl` +
`summary.reanswer-<policy>.json` beside the originals (originals are never
touched; an existing reanswer output is refused, not overwritten) and, with
`--receipt`, a receipt stamped as a re-answer of that run, carrying the new
scores and the original run's scores. The `<policy>` suffix is the read policy
in effect NOW (`fact-episode-interleave` for the timeline arm) — the same rows
re-read under a different policy are different evidence:

```bash
node bench/memory/run.mjs --reanswer bench/memory/results/<runId> --receipt
```

**Validation:** before any number is quoted, hand-score ≥20 sampled (question,
gold, answer) triples, write `bench/memory/handlabels/<date>-<n>.json`:

```json
{ "run_id": "...", "hand_scorer": "who scored these by hand",
  "items": [ { "question_id": "...", "arm": "none", "label": "exact" } ] }
```

then

```bash
node bench/memory/run.mjs --from-results bench/memory/results/<runId> \
  --handlabels bench/memory/handlabels/<file>.json --receipt
```

The receipt then carries the agreement number. A receipt without it is marked
provisional.

## Scoring

- Primary record: exact / partial / wrong counts per arm.
- `p1_score` = (exact + 0.5 × partial) / n — the single arm-vs-arm number.
- Numbers appear in the receipt ONLY from the run's own output objects
  (`summary.json`, `judged.jsonl`) — the receipt is rendered, not typed.

## Layout

```
run.mjs        CLI (thin)            judge.mjs    local judge + label parsing + agreement
core.mjs       runBench (DI; what tests drive)    regime.mjs   the stamp
grid.mjs       the grid composer (composeGrid: comparability keys + the task-333
               regime guard, --allow-mixed-regime, the MIXED REGIME section)
regimes.mjs    the regime table (results → regimes.md; audits every grid receipt)
rejudge.mjs    re-judge saved answers (DI; what tests drive)
reanswer.mjs   re-answer a kept run's namespaces (DI; what tests drive)
split.mjs      registry + sha256 gate + selection
receipt.mjs    markdown receipt
platform.mjs   Mycelium client (URL from env/conf, never literal)
arms/          arm_none, arm_mycelium, arm_mycelium_extract, arm_mycelium_timeline,
               arm_mem0, arm_mem0_raw, arm_zep, arm_letta, registry
               (+ mem0/zep/letta_sidecar.py, requirements + per-arm venvs, gitignored)
tools/         cleanup-run.mjs — remove a crashed run's rows from the platform
data/          gitignored corpora      results/     committed run evidence
receipts/      committed receipts      handlabels/  committed hand-scored sets
test-fixtures/ hermetic fixture split (sha-pinned, committed)
```

Tests: `test/unit/bench-memory-*.test.js` — hermetic (fake arm, fake judge,
fake platform server; no network, no keychain, no dataset).

## Known model quirks the harness guards

- **Thinking models spend `max_tokens` on reasoning.** qwen3.8 on the 3090's
  llama.cpp returns its reasoning in a separate `reasoning_content` field that
  still consumes the completion budget — at 256 tokens with a large memory
  context the answer came back as `content: ""`, and at 1024 one hard question
  still burned the whole budget on reasoning (4,450 chars, `finish_reason=length`)
  and tripped the loud guard MID-RUN (2026-09-08 13:57, killing that attempt —
  the guard worked; the budget was wrong). The answerer default is now 4096,
  overridable with `--answer-max-tokens` (stamped into the regime), and the
  chat adapter throws loudly (`empty answer (finish_reason=…,
  reasoning_content_chars=…)`) instead of letting a blank grade as an answer.
- **Bulk writes embed in a delayed burst — the scaled embed-wait is
  load-bearing.** Measured 2026-09-08 against the live platform (2,355 docs /
  7,767 rows in ~2 min): global embedding coverage read ~40% and FROZE for
  ~25 min after the write, then went 0→100% within ~20 min; the run's wait
  (cap = max(8 min, rows × 500 ms) ≈ 65 min) settled at 710 s. Probes during
  the frozen window and the settled value disagree on the timeline — the
  drain arrives late, not never. An 8-min fixed cap (pre-e0a1b46) would have
  fallen through to keyword-only retrieval and quietly degraded the arm.
  Single-shot steady-state embed throughput measured ~0.6 session-sized
  (15 KB) texts/s on the Jetson's ollama — plan ingestion budgets with that
  number, not with hope.
  <!-- verified 2026-11-05 by: bench/memory/embedding_wait.mjs cap formula
       Math.max(8 * 60 * 1000, expectedRows * 500) — the 2,355 docs / 7,767
       rows / ~40%-frozen / 710 s figures are the dated 2026-09-08 measurement
       this bullet records (historical observation, not re-measurable here) -->

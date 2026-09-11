# bench/memory — the memory benchmark (P1)

One harness we control, regime-stamped, receipt-gated. Task 163 = the
SKELETON: two arms (`none`, `mycelium`) on LongMemEval-S. Task 169 landed
the first competitor arm (`mem0` — Mem0 OSS via a local sidecar); task 180
the second (`zep` — Zep's OSS graphiti on its embedded kuzu store); task 181
the third (`letta` — the OSS Letta server's archival memory via its official
client SDK).

Program: `jarvis/runs/fable-specs/BRIEF-memory-sota-program.md` §P1.

## Run it

```bash
# the gate command (writes the receipt + two rows):
node bench/memory/run.mjs --split longmemeval --arms none,mycelium --n 50 --receipt

# useful flags
#   --budget 5              retrieval top-k (regime parameter)
#   --keep                  do NOT delete the run's rows from the platform
#   --answer-url URL        OpenAI-compatible answer endpoint (default: BOX_3090_URL from substrate.conf + /v1)
#   --answer-model ID       (default qwen3.8:27b)
#   --arms LIST             subset of none,mycelium,mycelium-extract,mem0,mem0-raw,zep,letta (default none,mycelium)
#   --judge-url URL         (default http://localhost:8780/v1 — the served XS seat)
#   --judge-model ID        (default Laguna-XS-2.1-mlx-oq4e-agentic-ours)
#   --handlabels FILE       judge-agreement vs a hand-scored set (see below)
#   --from-results DIR      rebuild the receipt from a finished run's own output
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

Cost: $0 — the answerer and the judge are both local models.

## Dataset provenance

- **Split:** LongMemEval-S (cleaned), 500 items.
- **File:** `bench/memory/data/longmemeval_s_cleaned.json` (gitignored — never committed).
- **URL:** https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
- **sha256:** `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
- **Licence:** MIT (dataset card: "License: mit"). We do not redistribute the
  corpus; the pinned URL + sha is the provenance. Cite:
  Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term
  Interactive Memory*, ICLR 2025.
- The loader REFUSES to run against a file whose sha256 does not match —
  dataset identity is part of the regime stamp.
- Selection rule (deterministic, stamped): sort by `question_id` ascending,
  take the first n. Same split + same n ⇒ same items forever.
- Note: the cleaned S split carries NO abstention questions (six types:
  single-session-user/assistant/preference, multi-session, temporal-reasoning,
  knowledge-update).

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
present in one run.

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

The sidecar's unittest (request/response shapes, fake Letta client, the
two-stage stop protocol, the reattach behaviour; 127.0.0.1 only):

```bash
bench/memory/arms/.letta-venv/bin/python -m unittest -v bench/memory/arms/test_letta_sidecar.py
```

## Judge + validation

The judge is a LOCAL model (default: the served XS seat at oMLX :8780 — a
different model family from the answerer, so it is not self-grading), prompted
to emit exactly one label: EXACT / PARTIAL / WRONG. Unparsable judge replies
count as wrong AND are reported (`unparsed`) — a judge that cannot answer is
not silently a pass.

**The label rule (judge prompt v2, `judge-prompt.2`)** — the rubric is applied
in this order:

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
rejudge.mjs    re-judge saved answers (DI; what tests drive)
reanswer.mjs   re-answer a kept run's namespaces (DI; what tests drive)
split.mjs      registry + sha256 gate + selection receipt.mjs markdown receipt
platform.mjs   Mycelium client (URL from env/conf, never literal)
arms/          arm_none, arm_mycelium, arm_mycelium_extract, arm_mem0,
               arm_mem0_raw, arm_zep, arm_letta, registry
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

# bench/memory — the memory benchmark (P1)

One harness we control, regime-stamped, receipt-gated. Task 163 = the
SKELETON: two arms (`none`, `mycelium`) on LongMemEval-S before any
competitor arm (Mem0/Zep/Letta are task 165+).

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
- Rows are deleted from the platform after the run (per-source_id DELETE,
  verified 0 remaining) unless `--keep`.

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
split.mjs      registry + sha256 gate + selection receipt.mjs markdown receipt
platform.mjs   Mycelium client (URL from env/conf, never literal)
arms/          arm_none, arm_mycelium, registry
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

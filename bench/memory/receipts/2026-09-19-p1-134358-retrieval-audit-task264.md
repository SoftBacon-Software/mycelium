# Retrieval audit — single-run render (task 207 + task 264)

Run: 2026-09-19-p1-134358 (`bench/memory/results/2026-09-19-p1-134358`).

Rendered by `bench/memory/tools/render_retrieval_audit.mjs` over this run's OWN banked rows + the dataset's gold evidence ids — the exact section a grid receipt carries, computed at render time (no hand-typed numbers). R@k is QUESTION-SCOPED (task 304, review B 2026-11-03): a hit credits gold only when the retrieved session belongs to THIS question's haystack — banked hits resolve their owning question from the `<runId>-<qid>-s<idx>` source id. Protocol: retrieval runs over the run's POOLED store (all questions' haystacks share it), not LongMemEval's per-question collection — this R@k is NOT comparable to a published per-question R@k (e.g. MemPalace's 96.6% R@5).

A composed 2-run grid REFUSES here today when no comparable partner exists in the bank (judge-prompt drift across runs, duplicate arms) — the grid's own honesty laws; this file is the section render, not a quotable grid.

## Retrieval audit — read-side provenance (task 207)

Gold mapping method + coverage: 50/50 questions mapped (methods: `answer_session_ids` 50; unmapped 0 — counted, EXCLUDED from rank stats).

Retrieval budget: 5. No write cap stamped. Rows stamped before this instrument carry counts only (`meta.hits`) — they appear as `banked` and are never assigned ranks. Rank stats run over STAMPED, mapped, gold-written, provenance-carrying rows only (`ranked`).

| arm | question_type | rows | stamped | banked | err-null | no-retr | unmapped | gold≥cap | no-prov | no-qid | ranked | hit@budget | med gold rank | MRR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| none | single-session-user | 6 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | — | — | — |
| none | multi-session | 12 | 0 | 0 | 0 | 12 | 0 | 0 | 0 | 0 | 0 | — | — | — |
| none | knowledge-update | 15 | 0 | 0 | 0 | 15 | 0 | 0 | 0 | 0 | 0 | — | — | — |
| none | single-session-preference | 7 | 0 | 0 | 0 | 7 | 0 | 0 | 0 | 0 | 0 | — | — | — |
| none | temporal-reasoning | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | — | — | — |
| none | single-session-assistant | 5 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | — | — | — |
| mycelium | single-session-user | 6 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0.167 | 5 | 0.033 |
| mycelium | multi-session | 12 | 12 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 12 | 0.583 | 2 | 0.378 |
| mycelium | knowledge-update | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 15 | 0.867 | 2 | 0.468 |
| mycelium | single-session-preference | 7 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 7 | 0 | — | 0 |
| mycelium | temporal-reasoning | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 0.800 | 1 | 0.800 |
| mycelium | single-session-assistant | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 1 | 1 | 1 |

### Retrieval vs answers, per arm (task 264)

| arm | R@5 | R@10 | judged accuracy (p1) | gap (retrieved-but-answered-wrong) |
|---|---|---|---|---|
| none | n/a (no rankable rows — 50 no-retrieval) | n/a (read budget 5 — ranks beyond 5 are never stamped, so R@10 is not measurable from this run) | 0.150 (7/50) | n/a (no retrieved-hit rows carry a judge label) |
| mycelium | 0.600 (30/50) | n/a (read budget 5 — ranks beyond 5 are never stamped, so R@10 is not measurable from this run) | 0.370 (18/50) | 50.0% (15/30) |

Definitions: R@5 = THIS question's gold session in the top 5 of the stamped read hits, R@10 = the same at top 10 — session-level recall, crediting only hits that belong to the row's own question (every arm pools all n questions' haystacks into one per-run store, so a foreign session at a colliding index is never gold evidence). PROTOCOL: this R@k retrieves over the pooled per-run store (n questions' haystacks), not LongMemEval's per-question ~50-session collection — a different, harder protocol. NOT comparable to a published per-question R@k (e.g. MemPalace's 96.6% R@5); a like-for-like number needs a per-question-scoped retrieval replay (a separate task). `judged accuracy (p1)` = the arm's own judged score (exact + 0.5×partial)/n over its judged rows — the number the Scores table quotes (counts in parentheses: exact/judged). The gap = judged `wrong` among rows where the gold session WAS retrieved within the read budget — retrieval delivered the evidence and the answer still failed (counts: wrong/retrieved).

Evidence granularity: session-level (`answer_session_ids`, or the unique answer-text fallback). There are no turn-level evidence ids in this dataset — turn-level recall is absent by data, not by omission — so R@k is session-level.

Honesty rules: a retriever whose search ran and returned zero rows (`read_hits: []`) is a KNOWN miss and scores 0.0; a no-retrieval arm (`read_hits: null`), a banked row (stamped before the instrument), a k beyond the read budget, or a hit whose owning question cannot be identified (pooled store, no `question_id` and unparsable `source_id`) renders n/a (why) — never a fabricated 0 and never a foreign-session credit.

### Pre-committed diagnostic rule (decided by the stamped ranks alone)

- none / single-session-preference: 0 ranked preference rows (stamped 0, banked 0) — the rule fires after the first stamped run
- mycelium / single-session-preference: no gold-session hit among the stamped preference rows

**Pooled branch: `insufficient-stamps`.**


---
Rendered: 2026-11-03T19:56:55.063Z — `node bench/memory/tools/render_retrieval_audit.mjs bench/memory/results/2026-09-19-p1-134358`

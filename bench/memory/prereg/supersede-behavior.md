# PREREG 3 — supersede-behavior: keeping the losing fact changes behavior

- **task:** F-mycelium 244 (claim 3 of 3), director 2026-09-19
- **registered:** 2026-09-19 (this file, branch `lane/f-mycelium-244`) — **no runs performed**
- **status:** PRE-REGISTERED / **BLOCKED on bug 220** — the history arms are void until the reader exposes superseded history; the whole prereg waits
- **cut-once rule:** applies (see [README](README.md))

## Claim

> Supersede-with-history (the losing fact kept, validity-windowed, exposed to
> the reader) changes DOWNSTREAM task behavior vs last-writer-wins — measured
> on outcome, not recall.

TOKI (arXiv 2606.06240) formalized the bitemporal schema with the losing fact
preserved in an audit row and explicitly "claims no superiority". STALE
(arXiv 2605.06527) shows implicit conflict is the dominant failure mode
(best model 55.2% on 400 scenarios). Supersede (arXiv 2606.27472) shows
frontier models drop 92 → 77 under bounded memory on knowledge updates.
Memora's FAMA (arXiv 2602.03315, ICML 2026) penalizes reliance on superseded
memory. **Nobody has measured whether keeping the losing fact changes what
the agent DOES.** That is the unclaimed experiment, and it is two-sided:
history might help (the model can reason about what changed and when) or
hurt (the model uses the losing fact where the current one is wanted). Both
outcomes are publishable; only indifference is boring.

## Hypotheses (pre-committed, two-sided risk registered)

- **H1 (improvement):** on implicit-conflict **history-questions**, arm
  `history` ≥ arm `lww` + **5 pp** outcome accuracy (95% CI excluding 0).
  Prediction carried from the n=50 run (2026-09-18): ≥ 2 of the 4 wrong
  knowledge-update rows asked for the SUPERSEDED value and missed only
  because the reader hid it.
- **H2 (the hazard, the real question):** on **current-value questions**,
  arm `history` costs ≤ **2 pp** vs `lww` — keeping the losing fact must not
  make the agent USE the losing fact.
- **H3 (ablation):** arm `history` ≥ arm `dump` + **3 pp** on current-value
  questions — *rendered* history (validity windows, capped chain) beats mere
  presence of history (PrecisionMemBench's dump-the-store result, armified).
- **Ship rule: H1 AND H2 both hold.** H1 without H2 = keeping history is
  behaviorally toxic; publish as the negative. H2 without H1 = history is
  safe but inert; publish as the null. Neither = the claim ships.

## Arms (same corpus, same answerer, same retrieval budget 5 hybrid)

- **lww** — last-writer-wins: superseded rows discarded at write time; the
  reader shows current values only. (The world every audited baseline lives
  in — TOKI's "every audited baseline omits keyed logging".)
- **history** — supersede-with-history, write path **live since
  `deploy-2026-09-19a`** (`POST /memory/lessons/:id/supersede` + the
  am_facts supersede path: the old row keeps `valid_to` / `superseded_by` /
  `superseded_by_text`, its indexed content gains the supersede line,
  `?include_superseded=1` reads it back — semantic-memory routes.js §528) —
  read via the **`fact-episode-interleave-history`** policy: predecessor
  chain ≤ 2 per hit, rendered with validity windows. **This policy is bug
  220 (F-mycelium 220) and has NOT landed** — hence the blocker.
- **dump** — ablation: all rows including superseded, raw supersede marker
  string, no validity-window rendering, no chain cap. Separates "history is
  present" from "history is rendered".

## Tasks

- **STALE-style implicit-conflict scenarios + the lab's knowledge-update
  class**, **n ≥ 500 graded questions per arm**, ≥ 3 generator seeds (the
  three-seeds law).
- **Fixture generator (registered before any fixture is drawn):** each
  fixture = write fact A (dated) → supersede with fact B **via the real
  route** → question. Crossed on: domain × relation × update type
  (value-change, status-change, temporal-shift, ownership-change) × question
  class — **history-asking 40% / current-value 40% / abstention 20%** (the
  `_abs` class whose gold is "information not enough").
- **Implicitness rule:** the question must NOT announce the update (no
  "the X changed" phrasing) — implicit conflict is the failure mode being
  measured, and a fixture that announces it measures nothing.
- **Fixture validity gate BEFORE the run:** 50 fixtures drawn at random,
  hand-checked for gold correctness + implicitness; bar ≥ 90% valid; on
  failure, fix the GENERATOR (version stamped), re-draw — never hand-patch
  individual fixtures into validity.
- **External anchor (not counted in the 500):** the 15 knowledge-update
  items of LongMemEval-S n=50 ride along unmodified, so the arm results are
  comparable to the banked timeline-arm row (0.533 KU, judge v2).

## Positive control (the bug-220 gate, made mechanical)

**5 probe fixtures** where a correct answer REQUIRES the predecessor value.
Before the arms run, arm `history`'s reader must show
`meta.context_superseded ≥ 1` on all 5. On 09-18 the reader put
`context_superseded = 0` on ALL 15 KU rows — that signature is exactly what
this control detects. **If the positive control fails, the history and dump
arms ABORT as instrument failure** (the prereg does not run against a reader
that cannot expose history; a null result under it would be meaningless).

## Judge / checker

- **The outcome checker is CODE:** the answer's operative value extracted and
  matched against gold (current vs superseded vs abstention), stamped per
  row. **Abstention golds are classified FIRST** — an `_abs`-gold item whose
  answer abstains is EXACT — by rule, not by model mood: judge v2's
  "any refusal is WRONG" mislabeled exactly these (2 rows, 09-18), and both
  attempted prompt fixes (v3, v4) failed their pre-committed adoption legs
  (18/20 and 18/20 vs bar ≥ 19/20). The abstention rule lives in the
  CHECKER; the model judge is never promoted into the graded path
  (judge-vs-checker gap, measured 2026-09-10).
- **FAMA scoring** (superseded-reliance penalty, Memora's metric) computed
  per answer from the checker's operative-value extraction: an answer whose
  operative value is the SUPERSEDED one on a current-value question is a
  FAMA hit. The model judge sits BESIDE the gate for error analysis only.

## n, power, regime

- n ≥ 500 questions/arm × 3 seeds, paired across arms (same fixtures, same
  answerer per seed).
- Answerer: the pinned bench answerer (qwen3.8:27b on the 3090, temp 0,
  4096 tok — the P1 regime), stamped; judge seat: the served XS seat with
  the ADOPTED judge prompt, stamped; retrieval budget 5 hybrid, stamped;
  dataset/generator sha stamped. Seat or engine change mid-run → freeze +
  NON-COMPARABLE stamp + restart (same law as prereg 1).
- Analysis: paired differences per fixture class; bootstrap 10k; the FAMA
  rate reported beside outcome accuracy for every arm.

## Pre-committed bars

| # | condition | bar |
|---|---|---|
| H1 | history − lww on history-questions | ≥ +5 pp, 95% CI excl. 0 |
| H2 | history − lww on current-value questions | ≥ −2 pp (no more than a 2 pp cost) |
| H3 | history − dump on current-value questions | ≥ +3 pp |
| PC | positive control | `context_superseded ≥ 1` on 5/5 probes, or ABORT |

## Leak checks

- Fixtures are generated, drawn, and frozen before any arm sees them; the
  generator version + fixture-set sha stamped in the receipt.
- The gold never reaches the answerer's context (the fixture writes go
  through the real memory write path; the reader is the only channel —
  audited by the budget-5 stamp and a no-recall canary question whose gold
  is absent from every written fixture).
- Arm identity (lww/history/dump) is invisible in the briefs the answerer
  sees beyond the retrieved content itself (same template, same budget).

## What would falsify the claim

1. No arm differences at n ≥ 500 across 3 seeds → supersede-with-history is
   behaviorally inert; TOKI's unmeasured assumption fails in our harness
   (publishable null; the product keeps history for audit, not for behavior).
2. H2 violated by more than 2 pp → keeping the losing fact COSTS behavior;
   the product decision flips to history-behind-an-explicit-ask (publishable,
   and it would explain STALE's numbers from the other side).
3. The positive control cannot pass even after 220 lands → the reader seam
   cannot expose history; the claim is unmeasurable until it can (blocker
   escalates to the platform queue, prereg unchanged).

## Dependencies & blockers (named)

- **BLOCKER: bug 220 / F-mycelium 220** — the `fact-episode-interleave-history`
  read policy (predecessor chain ≤ 2, validity windows rendered) must land,
  pass its own review, and pass the 5-probe positive control BEFORE the
  history/dump arms fire. The lww arm alone is meaningless; the prereg waits.
- **Build:** the fixture generator + validity harness; the operative-value
  checker with the abstention-gold rule first; the FAMA scorer.
- Receipt: `bench/memory/receipts/supersede-behavior-<date>.md`, rendered
  from run rows + the fixture sha + the positive-control rows only.

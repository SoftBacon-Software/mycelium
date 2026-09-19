# PREREG 1 — receipt-30-nights: yesterday's lessons raise repeat-task pass^k in a live lab

- **task:** F-mycelium 244 (claim 1 of 3), director 2026-09-19
- **registered:** 2026-09-19 (this file, branch `lane/f-mycelium-244`) — **no runs performed**
- **status:** PRE-REGISTERED / NOT STARTED
- **cut-once rule:** applies (see [README](README.md)). After the first measured row: append-only deviations.

## Claim

> Yesterday's lessons raise repeat-task pass^5 in a live lab, measured nightly
> for 30 nights, lessons ON vs leak-verified OFF, on a bit-identical seat.

This is the application-level hole Mem0 itself names as open, and the number
two groups published while our receipt read zero: *Learning on the Job*
(arXiv 2607.22157, 2026-07-24: 1.6×–2.6× on τ-bench from distilled rules) and
*MERIT* (arXiv 2609.05441, 2026-07-26: memory ON vs leak-verified OFF — 0.00
leak rate — across 23,440 episodes; agents acted on correctly retrieved values
only 55% of the time). Both are one-shot synthetic or τ-bench workloads. Ours
is the live lab's own repair/plan/verify stream, repeated nightly for 30
nights — no one has published that.

## Hypotheses (pre-committed)

- **H1 (primary):** paired per-specimen pass^5(lessons ON) − pass^5(OFF) ≥ **+10 pp** at n ≥ 500 episodes, 95% bootstrap CI excluding 0.
- **H2 (mechanism):** the ON−OFF delta concentrates where a retrieved lesson was **acted on**; the retrieved-but-not-acted stratum shows Δ ≤ +2 pp. Without H2 the gain is prompt-stuffing, not memory.
- **H3 (descriptive, floor not parity):** acted-on-when-retrieved ≥ **0.40** (MERIT measured 0.55 on their workload).

## Arms

Both arms run the **same brief template**; memory for every non-lesson class
is ON in BOTH arms. The treatment is **lessons only** — this isolates the
lesson layer, not all memory.

- **ON** — the brief carries the lessons block: lessons in the window
  `[specimen fire, re-fire)`, after the provenance leak gate.
- **OFF** — byte-identical brief with the lessons block removed. Nothing else
  differs (same recall for facts/episodes/history, same tools, same seat).

## n

- **Set:** the re-cut specimen set, cut ONCE from the 09-11+ pool per
  `training/glm-distill/eval/receipts/recut-proposal-2026-09-17.md` (12 in /
  12 out / 3 stay = 15 specimens), frozen by the director BEFORE night 1.
- **30 nights × 15 specimens × 2 arms = 900 paired fires** target.
- **Readable at n ≥ 500 episodes** (paired fires with valid verdicts, after
  exclusions). Below 500: report the interim, claim nothing.
- **Rolling admission (append-only):** each Monday, specimens whose origin
  workflow completed within the last 14 days and are fireable (per the sp331
  rule: the frozen spec records a coder; runner-offline at t0 is a WAIT, not a
  refusal; structurally unfireable specimens are skipped at selection, never
  retried into the slot) enter at the END of the rotation. The rule is
  mechanical; no hand-picking. Existing specimens are never replaced or
  re-cut mid-window.
- Every excluded fire appears in the nightly exclusions table with a reason.
  Silent exclusion is instrument failure (the flat-queue lesson: a redrawn
  false-positive nine times is what silent exclusion produces).

## Controls

1. **Paired, interleaved, randomized:** each night fires the same specimen in
   both arms; ON/OFF order per specimen drawn once by a pre-committed seeded
   RNG (seed `20260919`, Fisher-Yates over the specimen list; the generated
   order table is committed with the freeze) — this decorrelates lab weather
   across arms (the a34 lesson: +1.4 pp, p≈1.0, same-day box noise).
2. **Bit-identical seat:** lucy on `Laguna-XS-2.1-mlx-oq4e-agentic-ours` at
   oMLX :8780; adapter id + quant + oMLX git sha stamped on every row. Any
   seat/adapter/engine change mid-window FREEZES the receipt: rows after the
   change are stamped NON-COMPARABLE and the paired count restarts at 0.
   (same-day ≠ same-session law; custody law: the runner recycling under a
   measurement is a void row, not a datapoint.)
3. **Leak verification (MERIT's 0.00 check made ours):**
   - **Provenance gate (live, K-kira 63, jarvis 35784cba):** a lesson is a
     LEAK iff its `source_id` names the specimen's own wf / repair chain, or
     its evidence path lies inside the specimen's `gate_editable` set.
     Refused lessons are counted per row (`leaks_refused`) and named.
   - **Canary:** before night 1, plant one canary lesson per specimen class
     whose provenance deliberately places it INSIDE a specimen's own chain,
     carrying the marker phrase `canary-leak-<specimen-id>`. PASS = the
     canary is refused in every ON row (attributable in `leaks_refused`) AND
     its marker appears in **zero** OFF briefs and transcripts. Any canary
     sighting in an OFF transcript voids that night (instrument failure;
     reported; excluded; the instrument is repaired before the window
     resumes — no salvaging a leaking arm).
4. **Empty-window sanity:** an ON row carrying 0 included lessons is excluded
   from n (it measures nothing) and reported. A night where > 30% of ON rows
   are empty is an instrument-failure night: excluded whole, named in the
   receipt. (This is the 09-14..09-17 hole — four nights of tautology —
   guarded mechanically.)

## Judge / checker

- **Grading is CODE.** Pass/fail is the specimen's own gate/checker chain
  (the same efficacy-gate path that graded the origin run), parsed with the
  skeptical prior (`None` = FAIL). A model judge is never in the graded path
  — the measured judge-vs-checker gap (2026-09-10: XS judge passed 8/8
  materially wrong end states) is the pre-committed reason.
- The **acted-on diff** (below) is also mechanical. Judging appears only in
  error analysis, beside the gate.

## The acted-on-when-retrieved instrument (to build BEFORE night 1)

For every ON fire where ≥ 1 lesson was retrieved: a **mechanical diff between
the rendered lessons block and the coder's first write.**

- The lessons block stamps each rendered lesson's id + its **named
  artifacts** (file paths, test names, rule ids it cites).
- A lesson with no named artifact is **unactionable**: excluded from the
  acted-on denominator, counted separately (its rate is a different quantity
  — advice-flavor, not behavioral).
- **Acted-on = TRUE** iff the coder's FIRST write (a) touches a path the
  lessons block names, or (b) contains the name of an artifact the block
  names. The diff tool stamps one decision per lesson per fire into the run
  JSON (`lessons[] → {id, retrieved, actionable, acted_on}`).
- `acted_on_when_retrieved = Σ fires with ≥1 acted-on lesson / Σ fires with
  ≥1 actionable retrieved lesson.`

## Pre-committed bars

| # | condition | bar |
|---|---|---|
| C1 | paired Δ pass^5 (ON − OFF) | ≥ +10 pp, bootstrap 10k resamples, 95% CI excl. 0, n ≥ 500 |
| C2 | dose-response | acted-on stratum carries the gain; retrieved-not-acted stratum Δ ≤ +2 pp |
| C3 | acted-on-when-retrieved | ≥ 0.40 |

**Ship rule:** C1 + C2 + C3 all hold → publish "yesterday's lessons raise
repeat-task pass^5 in a live lab" with the acted-on rate as the mechanism.
C1 holds but C2 fails → publish the honest downgrade ("lessons help; use is
not the mechanism") — the causal claim does NOT ship. C1 fails → publish the
negative result at full n (the DIRECTIVE's premise is falsified for repeat
tasks; that is a finding, not a failure of the lab).

## Leak checks

Provenance gate + canary (control 3) + the OFF-transcript scan (zero lesson
markers, zero `lessons:` block renders in OFF briefs — checked nightly by
grep over the run's recorded briefs, count reported per row as
`off_lesson_markers: 0`). The nightly receipt renders these counters; the
30-night claim receipt refuses to render if any night's canary or
off-marker check failed without a documented void.

## What would falsify the claim

1. OFF ≥ ON at n ≥ 500 (premise false — publish the negative).
2. The gain appears only in the retrieved-not-acted stratum (mechanism is
   context-stuffing; claim withdrawn, downgrade published).
3. Any canary/OFF-integrity failure that cannot be repaired and restarted
   (the instrument cannot verify its own OFF arm; no claim either way).
4. Seat regime change mid-window handled without freeze + count restart.

## Dependencies & blockers (named)

- **Build:** the acted-on diff tool (jarvis side, ships with unit tests and a
  fixture brief); the canary planter; the Monday rolling-admission selector.
- **Director decisions before night 1:** freeze the re-cut set (the 09-17
  proposal is the menu; the freeze is one commit + one message); commit the
  RNG order table; stamp the seat regime.
- **Instrument:** the nightly receipt stays
  `com.gilbert.repeat-task-receipt` (02:00), results in
  `jarvis/training/glm-distill/eval/results/repeat-task/run-<ts>.json`;
  the claim receipt renders ONLY from run rows + the exclusions table to
  `bench/memory/receipts/receipt-30nights-<date>.md`.
- **Timeline:** 30 nights from the freeze → earliest claim receipt ~30 days
  after night 1 (on the 09-19 dating: night 1 ≤ 2026-09-22, claim receipt
  ≥ 2026-10-21).

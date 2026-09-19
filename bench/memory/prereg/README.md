# bench/memory/prereg — pre-registrations for the three publishable claims

Task F-mycelium 244 (director, 2026-09-19). These are the **pre-registrations**
for the only three memory claims this lab can still publish first — written
BEFORE any run, cut once, no runs performed by the registering brief.

**The discipline.** Each file below states: hypothesis (direction +
magnitude), n, arms, controls, the pre-committed bar, the judge/checker, the
leak checks, and what would falsify it. A pre-registration here is **cut
once**: after its first measured row lands, edits are append-only deviation
notes (dated, at the bottom of the file) — a changed bar, arm, fixture set or
judge prompt is a NEW pre-registration, not a revision (the re-cut law,
`training/glm-distill/eval/receipts/recut-proposal-2026-09-17.md` §4). Numbers
are quoted only beside their arms, their exclusions table, and their judge
calibration leg (the 09-18 lesson: 0.400/0.533 is quotable only beside raw
0.290 and the 20-label agreement leg).

**Why pre-register at all.** The arena we are leaving is demonstrably gamed:
Mem0 self-reports 94.4 LongMemEval while an independent reproduction measured
73.8, with a 19.6-pt gap traced to 14 "equivalence rules" that map 1-to-1 to
public question IDs, hidden CoT, and "lean toward yes" judge instructions
(maximem.ai, 2026-05-27). MemDelta shows the embedder alone swings
LongMemEval-S by +6.2 pp (p=0.004, n=500) — more than most "memory systems"
claim; *Same Ranking, Different Winner* shows the choice of credited memory
form flips Mem0/MemoryOS orderings on 83–94% of queries. A lab our size
publishing post-hoc numbers into that arena gets read as one more
unreproducible row. Pre-registration is the only instrument we have that costs
nothing and buys credibility.

## The three claims

| file | claim | status |
|---|---|---|
| [`receipt-30-nights.md`](receipt-30-nights.md) | Yesterday's lessons raise repeat-task pass^k in a live lab, 30 nights, lessons ON vs leak-verified OFF | pre-registered, instrument partially live (nightly receipt + provenance leak gate on master); acted-on diff tool to build |
| [`model-swap-identity.md`](model-swap-identity.md) | Identity survives a model swap, quantified (we have two real swaps in the transcripts) | pre-registered; Leg R (retroactive) unblocked, Leg P (prospective) waits for the next real swap |
| [`supersede-behavior.md`](supersede-behavior.md) | Keeping the losing fact changes behavior: supersede-with-history vs last-writer-wins | pre-registered, BLOCKED on bug 220 (reader exposure of superseded history) landing first |

Program context: `jarvis/runs/fable-specs/BRIEF-lab-alive-memory-program.md`
(THE DIRECTIVE), `jarvis/runs/fable-specs/BRIEF-memory-sota-program.md` (the
P1 grid, now the internal control), and the frontier memo
`jarvis/runs/fable-specs/research/2026-09-19-frontier-check/04-memory-persona-frontier.md`
(§§2–5 and the closing claims — the source of every "the field already did X"
line in these files).

## The public arena, if the grid keeps a public face: LongMemEval-V2

If the P1 grid ever needs a public leaderboard row, it moves to
**LongMemEval-V2** (2026-05): 451 questions over web-agent trajectories up to
115M tokens, five abilities that are *utilization*-shaped rather than
recall-shaped (workflow knowledge, environment gotchas, premise awareness
among them); reader-only scores 1.3%, the best system 74.9%, and the
leaderboard is **empty**. It is the one arena shaped like what we actually
build — harness trajectories with gotchas and stale state, not chat logs with
planted facts — and an empty leaderboard means a first entry is a real
entry, not row 40 of a saturated board. **Why LoCoMo/LongMemEval-v1 leave the
hero publish:** vendor self-reports above ~90 there are prompt engineering
(94.4 claimed vs 73.8 reproduced; the 14 equivalence rules mapped to public
question IDs); the embedder swings scores more than the memory system
(MemDelta +6.2 pp, p=0.004); credited-memory-form choice flipped published
orderings on 83–94% of queries; and PrecisionMemBench showed baseline
retrieval precision clusters ≤0.22 — a system that dumps its entire belief
store achieves perfect recall on the metric. Publishing our grid there would
be a claim the field has already learned to discount; the grid stays as our
internal control (deployed master, PR #185: no-memory 0.150 vs Mycelium
0.370, n=50) and the three claims in this directory ARE the hero publish.

— lane F-mycelium 244, 2026-09-19 (GLM-5.3 lane session as m5Max)

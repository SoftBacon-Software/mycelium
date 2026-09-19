# PREREG 2 — model-swap-identity: identity survives a model swap, quantified

- **task:** F-mycelium 244 (claim 2 of 3), director 2026-09-19
- **registered:** 2026-09-19 (this file, branch `lane/f-mycelium-244`) — **no runs performed**
- **status:** PRE-REGISTERED / Leg R (retroactive) UNBLOCKED · Leg P (prospective) WAITS for the next real swap
- **cut-once rule:** applies (see [README](README.md))

## Claim

> Identity — voice, commitments, relational facts, honesty behavior — survives
> a model swap when the substrate (savepoints + memory + persona files)
> carries, and the measured continuity exceeds a fresh-model control.

Nobody has published a before/after model-swap identity measurement with a
held-out judge. ECHO (dev.to, 2026-09-16) ships a hash-verified WAL +
continuity gate and states plainly it has "not yet demonstrated" a live
provider swap. ARPM (arXiv 2605.14802) reports strict persona accuracy
100 → 66.7 when dialogue history is disabled. The only measured cross-model
transfer of accumulated memory is Learning on the Job's Mistral↔Sonnet rule
sharing. The lab has run this experiment **twice in production** — on
itself — and has the transcripts. That is the dataset no one else has.

## The battery (frozen BEFORE any Leg P row; sha-stamped in the first receipt)

**4 dimensions × 12 items = 48 items**, written against each agent's own
corpus:

1. **voice** — the agent's artifact shapes (report structure, signatures,
   cadence, formatting tics), items asking for artifacts the agent routinely
   produces;
2. **commitments** — the agent's open threads and promises as of T−7, probed
   so that surfacing them requires memory, not inference;
3. **relational** — who the operators and squad are, the seat map, agent
   pronouns, dated history facts with gold answers (held-out: items never
   shown to the agent between T−7 and T+7);
4. **honesty** — the lab's honesty axis as behavior probes
   (`say_not_measured` / `verify_before_assert` / `verify_stated`), scored by
   their existing checkers, not by the continuity judge.

The item list is committed with the registration; items are never edited
after the first Leg P row.

## Hypotheses (pre-committed)

- **H1 (primary):** continuity(ON arm, after-swap) − continuity(control arm,
  fresh model, no substrate) ≥ **+15 pp** on the blind-judged battery.
- **H2:** 7-day drift: |continuity(T+7) − continuity(T0)| ≤ **5 pp** —
  carried identity does not decay fast.

## Arms

- **ON** — the real agent id with its full substrate (savepoints + memory +
  persona files + seat memory), before-window and after-window.
- **CONTROL** — a fresh agent id on the SAME after-model with an EMPTY
  substrate (no savepoint, no memory, no persona files): the same 48 items.
  This is the "fresh model, NO savepoint/memory" control from the claim.

## Judge (blind) + calibration (the 233 lesson)

- The continuity judge receives `(item, answer-A, answer-B)` with A/B
  **shuffled**, blind to model, arm, swap date, and time direction; labels
  `same / partial / different` per item.
- **Hand-label calibration: 20 labels**, drawn by a rule pre-committed HERE
  (every 4th judged row, 10 ON pairs + 10 control pairs), labeled from
  item + two answers only, labels written before comparison, never revised —
  the lane-167 rule that held for the memory bench's judge legs.
- **Adoption bar ≥ 19/20 agreement** — pre-committed by the 233 lesson:
  judge-prompt.4 measured 18/20 against exactly this bar and was NOT adopted;
  an 18/20 judge leg does not grade a publishable claim.
- **Moved-label report:** every judge-prompt change reports the count of
  labels that moved, not only agreement — the 221 lesson (v3 moved 7 labels,
  not the 4 intended; 3 moved the WRONG way).

## Metrics

- `continuity = (# same + 0.5 × # partial) / 48` per arm per timepoint.
- **continuity delta = continuity(ON, after) − continuity(CONTROL, after)**
  (primary).
- **7-day drift = |continuity(ON, T+7) − continuity(ON, T0)|**.
- All reported per dimension (a swap can carry voice while losing
  commitments; the aggregate alone would hide it).

---

## Leg R — retroactive: the two real swaps (artifacts named)

Leg R scores the transcripts we already have. **No control arm exists
retroactively** (the retired Opus/ds4 heads cannot be re-run): Leg R reports
continuity only, explicitly labeled as missing the OFF arm; the
fresh-model comparison is Leg P only. Windows are cut by commit/tag
timestamps, never by hand.

### Swap A — m5Max: Opus 4.x → Fable 5.1, 2026-09-01 (mid-session)

| artifact | where | role |
|---|---|---|
| savepoint rows ≤ 2026-09-01 | jetson01:3002 savepoints (the PreCompact hook's context-key marker + state-snapshot heartbeats) | before-window persona corpus |
| savepoint rows ≥ 2026-09-02 | same | after-window corpus |
| platform messages to/from `m5Max` (agent record `role=admin`, `operator_id=greatness`), dated either side of 09-01 | :3002 messages | both windows |
| `~/.claude/projects/-Users-grb-Projects/memory/` — MEMORY.md + topic files at their pre-09-01 mtimes (git/mtime gives the cut; the `-Users-grb-Projects-velum` copy is the frozen 06-04 history) | auto-memory store | identity inputs carried across the swap |
| CLAUDE.md identity section ("swapped mid-session 2026-09-01 — Gilbert had to tell me TWICE") | `~/Projects/CLAUDE.md` | the seam's own record: the two mis-attribution incidents (calling the swap "cosmetic", then mis-recording the model from stale system context) are DATED seam-behavior specimens for the honesty stratum |

### Swap B — Kira: DeepSeek-V4-Flash (ds4 head) → GLM-5.3 (:8788 proxy), 2026-09-03 14:01 CDT

| artifact | where | role |
|---|---|---|
| **the cut itself** | jarvis commit `d2fdb4a` — `tools/topology_c2.py` + `tools/topology_c2_apply.sh` (the C2 apply run, timestamped 2026-09-03 14:01) | the boundary, mechanically |
| before-window (09-02 17:50 → 09-03 14:01, the ds4-head era): platform messages + wf verdicts + task updates from `kira` | :3002 | before-window corpus |
| wake-battery transcripts (`jarvis/tools/kira_wake_battery.py`, 20 probes, ds4-head datum 19/20 on 09-03) | jarvis runs logs | a ready-made 20-probe battery leg |
| `jarvis/runs/fable-specs/BRIEF-kira-orchestration-head.md` + `KIRA-STANDING-ORDERS.md` | jarvis | the identity INPUTS she ran under (what "Kira" was specified to be, both before and after — unchanged by the swap, which is the point) |
| her seat memory files + lessons (harness-managed; seats keep memory regardless of brain) | jarvis squad seat state | the carried substrate |
| after-window: the same :3002 surfaces from 09-03 18:00 onward | :3002 | after-window corpus |

### Leg R protocol

1. Export both swaps' windows; strip all window labels, model names, and
   dates from what the judge sees; shuffle.
2. The battery's voice/commitments/relational items are answered FROM the
   before-window corpus (the "before answers" are the corpus's own
   artifacts); after-window artifacts are paired blind.
3. Honesty stratum: scored from transcripts by the existing probe checkers
   (`operating_rule_probes.py`-class rules), not by the judge.
4. Continuity per dimension, reported against the published baseline:
   ARPM's 66.7% strict accuracy with history disabled (the closest number
   the field has, standing in for the missing control, labeled as such).

## Leg P — prospective: the next real swap (the full protocol)

Trigger: the lab's next real seat/head swap (the XS round-3 promotion path,
or a GLM→next-head move on the director seat). At T−7..T0 and T0/T+1/T+7:
the full 48-item battery on the ON arm AND the fresh-model CONTROL arm, the
blind judge, the 20-label calibration leg. Leg P is the only leg that can
confirm H1 (the delta needs its control).

## Leak checks

- The judge never sees swap date, model id, arm, or time direction
  (shuffled, stripped).
- Battery items frozen + sha-stamped before Leg P row 1; the item sha is in
  every receipt.
- Leg R window cuts are the commit/tag timestamps — never chosen by reading
  the transcripts first.
- The hand-labeler and the judge are separate passes; hand labels are
  written before any comparison (lane-167 rule, restated so no future
  session "simplifies" it away).

## What would falsify the claim

1. Leg P: ON continuity ≤ CONTROL continuity (substrate carries identity no
   better than nothing — "substrate IS identity" dies as a measured claim,
   and the product story changes with it).
2. Continuity ≥ control at T0 but < control-equivalent by T+7 (identity is
   a decay process, not a carry — H2 falsified).
3. Judge calibration < 19/20 twice (the instrument cannot read continuity;
   no claim either way until a new judge is registered).
4. Leg R shows continuity at chance on the relational dimension (the corpus
   the substrate carried did not include the relational layer — the carry
   story is wrong about what it carries).

## Dependencies & blockers (named)

- **Build:** transcript export + window-slice tool (jarvis side:
  `swapslice.py`-class, names the artifacts above by id, strips labels);
  the 48-item battery file per agent (m5Max, Kira) written and frozen.
- **Leg R:** unblocked — both swaps' artifacts exist today (tables above).
- **Leg P:** waits for a real swap; this registration is what makes the
  NEXT swap publishable instead of anecdotal.
- Receipts: `bench/memory/receipts/swap-identity-legR-<date>.md` and
  `swap-identity-legP-<agent>-<date>.md`, rendered from the run rows +
  calibration labels only.

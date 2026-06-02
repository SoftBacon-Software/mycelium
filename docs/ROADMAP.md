# Ecosystem Roadmap — sequenced to compound (2026-06-02)

Built from an 8-agent survey of the live repos + an adversarial pass. Corrections from the
critique are folded in (most importantly: **A1 routing already fires live** — caps are set at
registration; the heartbeat gap is durability, not a dead gate). Companion to
`MULTI_AGENT_AUTONOMY.md` (agent env), `OPERATING_MODEL.md` (operator exp), and Spec #1.

Owner legend: **[S]** squad-suitable (Ada-plan/Lucy-code/Echo-verify) · **[M]** m5Max-direct ·
**[G]** Gilbert decision · **[mix]** squad under m5Max scaffold.

---

## The ecosystem (one substrate, one loop)

Every piece is a read/write view of **one substrate** — mycelium at `localhost:3002`. The loop:
**intent → squad triages → you greenlight → squad executes → what changed.** Each surface renders
that loop at its own altitude.

- **Platform** = the press's bed (canonical plan/step/bug/agent records). Platform-first: a
  routing/gate fix in `server/db.js` is inherited by every consumer — it compounds downhill.
- **Squad + training** = the engine room. Ada-plan / Lucy-code / Echo-verify on local oMLX models.
  The training loop is meant to make the press better each run.
- **Mycelium app** = the clean altitude (express intent, greenlight). The bright public face.
- **Velum** = the granular cockpit (move the parts; watch the squad work).
- **Hardware-checker** = the onboarding gate (which squad can this box field?).
- **MOTU** = the premier end-to-end dogfood (a local 8B runs a real game; its bugs drive platform fixes).

**Defining fact today:** the squad half of the flywheel runs daily and load-bearing; the training
half is physically disconnected (91 transcripts evaporating in `/tmp`, persona-meld loop idle since
2026-05-25). The press executes but is **not yet self-improving.** Closing that pipe is the keystone.

### Leverage map (who feeds whom)
- MOTU files a bug → platform routes it → squad fixes it → that cycle is training data → stronger squad builds the next MOTU feature. (the flywheel)
- `oMLX /engine/loaded` (actual resident bytes, M5 ground truth) → calibrates the hardware-checker → sizes the app's squad-assembly → tells MOTU which boxes can DM.
- One greenlight feed (draft plans) → the app's home screen AND the top of the Velum cockpit.
- One ruleset → web-advisor funnel + app onboarding + MOTU fit story.

---

## Strongest path (where the boat goes first)

**Capture-then-close-the-flywheel.** It's the cheapest high-leverage move because nearly all its
prerequisites are already true (routing fires, platform healthy, transcripts already written,
persona-meld machinery fully built and config-driven — idle only on a data-source swap). The apps
make the loop *visible*; the flywheel makes it *compound*. **Prioritize compounding over visible.**

1. Redirect squad transcripts off `/tmp` **with the guard fields baked in** (echo_verdict,
   accepted_on_disk, authored_by_local_model) — converts daily execution into a growing asset.
2. Enforce the ④ review gate (leaking now — draft-plan steps are claimable) + ship the A12 greenlight feed.
3. Build ③ create_plan + Ada triage + the A10 exemplar seed — **unblocked today** (routing already fires).
4. **Run the loop for a real window** to accumulate a labeled corpus.
5. Harvest it and prove **one squad brain (Lucy) gets measurably better.** ← the figure-1 result.

---

## Phases

### Phase 0 — Get the keystone live + start capturing (cheap, unblocks everything)
- **[S]** ④ plan-status review gate: `buildWorkQueue` offers steps only from `active` plans (it's the lone inconsistency — sibling queries already gate). Split the boot read so draft plans still feed A12. *(Spec #1 ④; behavioral test: draft withheld / active offered / flip→claimable.)*
- **[M]** Persist squad transcripts to a durable corpus + **sidecar metadata with the guard fields from day one** (agent, work_type, success, echo_verdict, accepted_on_disk, authored_by_local_model). Backfill the 91.
- **[M]** State-reconciliation + **close bug #10's stale record** (12/12 bugs are `in_progress`, several fixed-in-code — this corrupts greenlight decisions *and* training labels right now).
- **[S]** Schema-drift guard test (assert `schema.sql` == db.js migrations) — closes bug #10's structural cause permanently. Zero production risk.
- **[mix]** Push/merge the `planner-triage-routing` branch (4 ahead, 2 keystone) so consumers inherit ①+②. Add canonical status-enum doc + reject-illegal-transitions (A7), rolled out reject-with-reason.
- **[S]** Crash-guard `squad_loop main()` (A9) + bug-poison handling.
- **[M]** Promote the **xcodeproj-reviewability fix to here** (it's the structural gate for *all* squad Swift-file creation in Velum + app). Plus the CLAUDE.md/ESTATE_MAP training-infra drift fix.
- **[M, small]** Re-assert agent capabilities on register so A1 routing stays durable + a live regression test (ada gets unassigned bugs, lucy doesn't). *(Not a blocker — A1 already fires.)*
- **Dogfood:** ④ exercised by the next squad bug; the backfill reveals what fraction of cycles are accept-worthy.
- **Training fold:** transcript capture is the *foundation* — it physically connects execution to the pipeline; Echo verdicts become free labels from here on.

### Phase 1 — Make "Ada plans" real (autonomous triage + first just-in-time steering)
- **[mix]** Spec #1 ③: `create_plan` tool (planner-only, capability-scoped) + Ada bug-triage brief (non-trivial → gated 2-step draft plan; trivial → single-shot task). *Unblocked now — routing fires.*
- **[M]** A10 seed: deterministic plan-template + 2 exemplars (stored as a mycelium **concept**), injected into Ada's triage brief, fail-soft. Measure plan quality before/after.
- **[S]** A12 greenlight-queue feed in boot/overview (the feed both apps' home screen reads).
- **First autonomous end-to-end test = a SIMPLE single-file/platform bug** (not MOTU dmHeal — that's multi-file Swift with a classifier-invisibility trap; do it m5Max-scaffolded *after* the loop is proven).
- **Dogfood:** first bug→gated-plan with no human authoring it; tests whether exemplar injection lifts a local model's output (the A10 claim).
- **Training fold:** Ada-authored plans are the planner-reasoning traces the loop most needs; before/after pairs are themselves a signal.

### Phase 1.5 — Soak (run-and-accumulate)
- **[M/auto]** Run the autonomous loop for a real window on the live bug/feature backlog so the corpus reaches volume *before* Phase 3 harvests it. (The critique's catch: nothing else forces this, and Phase 3 starves without it.) Surfaces planner-quality bugs as it goes.

### Phase 2 — Render the loop at both altitudes
- **[mix]** App: make the Swift platform client compile + integrate (xcodegen, fix `AgentStore.refresh`, `ConnectionState.needsLogin`, LoginView/`/studio/me`/401 → BUILD SUCCEEDED against :3002).
- **[S]** App: correct `PlatformAgent` to the real record (+ status/working_on/capabilities/presence). *(edit-existing — squad-ok.)*
- **[M]** App: `PlansService` + `TasksService` over `MyceliumClient` (swift_client v1 scoped these out — prerequisite to the next two).
- **[mix]** App: review **home screen** consuming A12 ([See it]/[Greenlight]/[Send back]; PUT status:active; operator-language only).
- **[S]** App: operator-language vocabulary lint (fails if status/step_order/capability reaches consumer views).
- **[mix]** Velum: `VelumKit.MyceliumClient` (tested fixture-based decoders for plan/work/greenlight) → greenlight pane (`velum-approve`, machine-room language allowed).
- **[M]** Velum hygiene: resolve SwiftTerm fork-vs-upstream + delete dead code (HTML CockpitPane, standalone ApprovalsView) + fix stale AdaAdapter header. *(xcodeproj already fixed in P0.)*
- **Dogfood:** first real greenlight from an app instead of curl — surfaces feed-shape gaps against two consumers at once.
- **Training fold:** compile-then-integrate + dead-code deletion + decoders are textbook bounded squad reps feeding the now-capturing corpus.

### Phase 3 — Close the flywheel (the strategic keystone)
- **[mix]** Cycle-harvester: captured transcripts + verdicts → labeled candidates (keep Echo-PASS + m5Max-accepted; role-map system=persona/user=brief/assistant=trace; **self-reinforcement guard** filters/flags local-authored turns for optional frontier rewrite — fields already captured in P0).
- **[M/G]** Generalize the persona-meld loop off Kira-3B onto **Lucy** (config-driven D5): corpus = harvested Lucy cycles, base = Qwen3-Coder-30B, code-task rubric. Small-model Mac dry run first; **[G]** then RunPod H100 for 27–30B LoRA (budget call; no H100 script wired yet — schedule it).
- **[S]** Predicted-vs-actual calibration harness vs `/engine/loaded` (each resident model; include a Qwen3.6 point for the DeltaNet KV path).
- **Dogfood:** the brutal honest metric — what fraction of cycles are good enough to learn from? Tests gate calibration + drift.
- **Training fold:** *this is the fold made structural* — daily execution → per-role labeled SFT data; the figure-1 case-study result (a build cycle made a squad member better).

### Phase 4 — Make the substrate move (cockpit alive)
- **[M]** Platform A13: plan-flight + agent-activity SSE streams (emit on step transitions; promote `working_on` into a streamed current-action + output tail).
- **[mix]** Velum Squad-face v2: live plan-flight + per-agent activity pop-out (local transcript tail first — zero platform dep — then the platform feed). Render the tool trace as the content.
- **[mix]** MOTU: ada-player → repeatable scored autonomous-play harness (commit it); generate the first real **LEADERBOARD.md** by scoring the squad models.
- **Dogfood:** the loop becomes watchable; ada-player is the squad playing its own product (richest bug-surfacing loop).
- **Training fold:** ada-as-player multimodal decision traces feed the vision loop; the leaderboard is the reproducible regression baseline.

### Phase 5 — split into two tracks
**5a — Fit-accuracy (parallelizable from ~Phase 1 with spare squad capacity):**
- **[mix]** Port fitllm `calcKVCache`+`simulate` into a quant-aware fit engine — **fix the MLX-bits bug** (read `config.quantization.bits`, not `torch_dtype`; ~2× undercount on every pre-quant today).
- **[M]** On-device hardware detection in the app (`ProcessInfo.physicalMemory` + chip/GPU). *(Swift, m5Max.)*
- **[G]** Send the fitllm-engine PR (quant fix + M5 calibration table) — gated on maintainer reply.
- **5b — Consumer product (gated on a [G] decision):**
- **[G] DECISION GATE (resolve before Phase 2 finishes):** keep the cube app as Pro and repair it, or cut a clean greenfield consumer app first and park Pro?
- **[mix]** Package the shared Assembly Engine (ruleset) as a Swift module (web + app + MOTU stop drifting); Hardware Probe + Task Board; the role-graph assembler; MOTU "can-this-box-DM" fit+floor hook.

---

## Decisions (resolved 2026-06-02)
1. **Product split** → ✅ **greenfield consumer app**; its final form (App Store vs other delivery) defined when we get there. Pro/cube app stays parked.
2. **H100 budget** → ✅ **approved** — some training runs are affordable. Phase 3's full payoff is funded; still do the small-model Mac dry run first to de-risk the data path.
3. **fitllm** → ✅ **implement the fit engine + PR the quant fix upstream** (adopt + contribute). The 5a fit-accuracy track is greenlit to run in parallel.

## Top risks (held, to patch in motion)
- Flywheel never closes (Phase 0 capture + Phase 3 harvest slip) → squad stays static, thesis has no lead result. **Highest.**
- Self-reinforcement poisoning if the harvester guard is omitted → flywheel makes the squad *worse*.
- Shared-Mac contention (oMLX serves squad + calibration + leaderboard + LoRA dry run) → run measurements when the squad is idle.
- Live state-desync unmonitored → corrupts greenlight decisions and training labels.

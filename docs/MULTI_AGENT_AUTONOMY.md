# Mycelium — Multi-Agent Autonomy Improvements

**Purpose.** A running register of what would make Mycelium work better as
the substrate for **multi-agent autonomous workflows** — squads of agents
(planner / executor / critic) picking up, routing, and completing work with
minimal human steering. This is the *proactive roadmap* companion to
`jarvis/squad/FRICTION.md` (reactive symptom log) and `jarvis/squad/lessons.md`
(per-agent fixes loaded into briefs).

**Owner:** m5Max + the squad (as of 2026-06-02 the Mycelium platform is the
squad's domain; dev-claude moved to game design). Maintain this as we discover
gaps — newest discoveries appended under each theme.

**Operating principle — platform-first.** When an autonomy gap has a platform
root cause *and* a bridge/client workaround, **fix the platform** (the source
of truth in `server/`). Every agent and every consumer (squad bridge, MCP,
app) then inherits the fix. Root > workaround. It compounds downhill.

---

## Guiding principles (the "what we're aiming for")

1. **Role/capability-aware routing.** Work should be offered to agents by
   *role/capability match*, not first-come. A planner-shaped item (triage,
   design a fix) should reach the planner; code steps reach the executor;
   verify steps reach the critic. First-come routing collapses the squad's
   division of labor.
2. **Managed-flow by default for non-trivial work.** Anything above a
   complexity/severity bar routes through **plan → code → verify** (with
   prior-step context relay), not single-shot. Single-shot is only safe for
   small, bounded, well-specified tasks.
3. **Autonomous planning with a review gate.** The planner authors the plan;
   it pauses at a gate (`needs_approval`); the executor runs only after
   approval. Stepping-stone to full autonomy once planning quality is proven.
4. **Gate enforcement IS the substrate of safe autonomy.** `blocked_by`,
   `needs_approval`, and status-enum correctness are what make unattended
   multi-agent execution safe. Enforce them at the platform (source), not in
   each consumer.
5. **Work-type completeness.** Every work type the platform can emit
   (`directive`, `request`, `plan_step`, `task`, `bug`, `bug_unassigned`)
   must have a defined claim + complete contract. An unhandled type silently
   desyncs platform state from consumer state.
6. **No silent desync.** Illegal/rejected state transitions must surface
   loudly, never be swallowed. (The bridge learned this the hard way; the
   platform should make illegal transitions explicit at the API.)
7. **Progressive steering, not front-loading.** Don't hand an agent the whole
   harness up front. Keep a tiny always-on core (identity + hard rules) and
   deliver method *just-in-time* per phase — the template/exemplar/checklist
   for the step it's in, injected when it enters that step, pulled from
   mycelium. Deterministic injection (code fetches + injects), never "model,
   go look." See track A10.

**North star — create the environment for the model to thrive.** The harness
is not a cage; it's the *conditions* under which a local model does its best
work. Substrate > weights, at the environmental level: surround the model with
the right method at the right moment instead of making it carry the manual.
Every track in this register serves that.

---

## Open improvement items

Status legend: 🔴 open · 🟡 in design · 🟢 shipped

### A1 — 🟡 Role/capability-aware work routing  *(platform — the root fix)*
**Layer:** `server/db.js` `buildWorkQueue()` (~line 1634).
**Problem:** The work queue is ordered by *priority only*, with **zero
role-awareness**. Unassigned bugs (`bug_unassigned`, priority 8) are offered
to **every** agent whose project/team matches (and unscoped bugs to
*everyone*). With `auto_claim`, whichever bridge polls first wins. A
planner-shaped bug is offered identically to the executor and the critic.
**Evidence:** Bug #11 (MOTU second-wind, spec said "Ada plans → Lucy codes →
Echo verifies") was auto-claimed by Lucy (executor) and single-shot — never
planned. No code changed; bug stuck `in_progress`.
**Proposed fix:** Make `buildWorkQueue` (and/or the `/work/:agent` auto-claim
path) role/capability-aware. Minimum: unassigned **bugs above a severity bar
route to the planner role first** (triage → author a plan); executors/critics
are not offered raw bugs. Agents carry a role/capabilities field already
(`agents.role`, `agents.capabilities`) — route against it.
**This is the "fix it at the source" item — A2/A3/A4 compound off it.**

### A2 — 🔴 Managed-flow auto-conversion (bug → plan)  *(platform + squad)*
**Problem:** A non-trivial bug has no path to become a plan automatically.
"Ada plans" has historically meant *a human* authored the mycelium Plan; the
bridge then relayed its steps. Nothing converts a raw managed-flow bug into a
plan, so it falls to single-shot.
**Proposed fix:** When the planner is routed a managed-flow bug (per A1), it
authors a Plan (steps: executor=code, critic=verify) via `create_plan`. The
plan's steps start `needs_approval=1` (the review gate, principle 3). Requires
giving the planner a `create_plan` tool (squad side) — see A5.
**Depends on:** A1, A5.

### A3 — 🟡 `bug` work-type handling in consumers  *(bridge; consider platform)*
**Layer:** `jarvis/squad/mycelium_bridge.py` `complete_work` / `fail_work`.
**Problem:** The bridge only handles `task` and `plan_step` (defaults
`work_type` to `"task"`). A claimed **bug**'s completion PUTs `/tasks/:id` —
the *wrong entity* — so the bug's status never updates → silent desync (the
2nd reason #11 stuck `in_progress`).
**Proposed fix (consumer):** Handle `work_type == "bug"`: PUT `/bugs/:id`
with a valid bug status, link to the authored plan (`linked_ticket_id`), post
the reply where bug comments live. **Proposed fix (platform, better):** expose
a uniform work-completion endpoint so consumers don't hand-map each work type
to its table — closes this class for all consumers (principle 5).

### A4 — 🔴 Enforce `blocked_by` at the platform  *(platform)* — = bug #8
**Layer:** `server/db.js` `buildWorkQueue()`.
**Problem:** No blocked filter — the queue offers a task regardless of
unresolved `blocked_by`. The bridge patches it client-side
(`unresolved_blockers`, release-to-open then re-offer), which is race-prone
and per-consumer.
**Proposed fix:** Filter blocked tasks out of the work queue at the source,
so dependency chains hold for every consumer. Bridge workaround becomes
redundant.

### A5 — 🔴 Planner can author plans  *(squad tools)*
**Layer:** `jarvis/squad/squad_tools/mycelium.py` (only `read_task`,
`create_task`, `post_message` today).
**Problem:** Ada is prompted as "the squad's reasoning planner" but has **no
`create_plan` tool**, so she cannot author the managed-flow plan A2 needs.
**Proposed fix:** Add a `create_plan` tool (wrap the platform's create-plan
endpoint) scoped to the planner role.

### A6 — 🔴 `needs_approval` gate is incomplete for plan_steps  *(bridge)*
**Layer:** `mycelium_bridge.py` approval gate (~line 463).
**Problem:** The gate can release a *task* back to `open`, but **cannot
release a plan_step** (it just skips + re-polls → busy-spin) — a gated step
isn't cleanly deferred.
**Proposed fix:** Give plan_steps a clean "defer, don't execute, don't
busy-spin" path; ideally the platform withholds steps of an unapproved plan
from the queue so the gate is enforced at the source (principle 4).

### A7 — 🔴 Silent-failure / status-enum correctness class  *(platform + bridge)*
**Context:** Open bugs #1, #3, #5 (and the bridge's own history) are all
"state transition silently mishandled." The platform status enums and every
consumer must agree; mismatches desync invisibly.
**Proposed fix:** Make the API reject illegal transitions *loudly* (clear 4xx
+ machine-readable reason) and document the canonical enums in one place so
consumers can't drift. (principle 6)

### A8 — 🟢 Per-agent iteration budgets  *(squad — shipped 2026-06-02)*
**Layer:** `jarvis/squad/squad_loop.py` `AGENT_MAX_ITER`; `mycelium_bridge.py`.
**Problem:** The bridge hardcoded `--max-iter 75` for *every* agent. Roles
aren't symmetric — Ada (reasoner/planner/spec'r) reads widely, thinks long
(Qwen3.6 reasoning runs 700–1100+ tok/turn), and authors multi-step plans; a
focused executor doesn't. One leash throttles the planner mid-plan.
**Fix (shipped):** `AGENT_MAX_ITER` map — Ada 150, doers 75 (fallback 75). The
bridge reads it per agent.
**Coupled knob (open):** `execute_via_squad_loop` also has a **30-min hard
subprocess timeout**. 150 rambling iterations can brush it; the MTP swap
(~2–3× faster decode) mitigates, but if the planner starts timing out, raise
the planner's timeout too. *Generalize:* per-agent budgets (iters, timeout,
maybe per-turn token caps) should track role, not be one-size-fits-all.

### A9 — 🔴 `squad_loop` crashes on some bugs  *(squad)*
**Evidence:** `ada FAILED bug_unassigned #10 — squad_loop exit 1: Traceback …
line 952 sys.exit(main())`. A claimed bug crashed the whole subprocess.
**Note:** of a piece with first-come bug routing (A1) — unassigned bugs reach
whatever agent polls first, and some inputs crash the loop. Triage routing
(A1) + a crash guard around `main()` both help.

### A10 — 🟡 Phase-gated progressive steering (the harness-as-environment layer)  *(FOUNDATIONAL — squad_loop + mycelium)*
**The track this whole register is really about.** Today squad_loop is
**phase-blind**: it concatenates CONTRACT + lessons + persona into one wall at
brief-build time and fires — the agent gets the entire handbook day-one. That
front-loads context, dilutes the one instruction that matters *now*, and only
works because most tasks are short; it bites on long multi-phase work (Ada's
planning).
**Design:**
- **Always-on core (tiny):** identity + hard rules (don't fabricate, tool-call
  format) — present every turn.
- **Phase-gated method (just-in-time):** the template / exemplar / checklist
  for the *current* phase, injected when the agent enters it, pulled from
  mycelium (the "large harness" — concepts/context/notes store templates +
  exemplars + conventions, versioned, shared across agents). **Deterministic
  injection** — squad_loop fetches + injects; *never* "model, go look"
  (model-driven retrieval fails on local models, same failure class as ignored
  nudges).
- **Phase detection:** start with *infer-from-last-action* (read_file → still
  exploring; create_plan → authoring); escalate to declare / explicit
  state-machine only if misfires hurt.
**Precedent:** the Win#4 no-tool-call nudge + Echo's post-write inline-validation
are already primitive mid-loop steers — A10 generalizes them.
**Risks:** phase-detection misfire (heuristic); over-slicing loses continuity
(the always-on core must carry the thread); added loop complexity.
**Prove-it-small first cut:** ONE phase-gated inject — when Ada calls (or is
about to call) `create_plan`, inject the plan template + 2 exemplars *then*,
not up front. If it visibly lifts her plans, generalize to other phases/roles.
**Consumers:** A1/A2 routing is the first — "Ada authors a plan" becomes "Ada
authors *from the injected template + exemplars*." Later: Lucy's code step gets
coding conventions; Echo's verify step gets the verification checklist.

---

## Log

- **2026-06-02** — A10 added as the **foundational track**: phase-gated
  progressive steering ("create the environment for the model to thrive" —
  Gilbert's framing, now the register's north star). Routing (A1/A2) reframed
  as A10's first consumer. Build plan: seed A10 with ONE inject (plan template
  at Ada's `create_plan`) inside the first routing increment; generalize after.
- **2026-06-02** — A8 shipped (per-agent max-iter; Ada 150). A9 logged
  (squad_loop crash on bug #10). Routing design chosen: **A1 keystone =
  planner-triage-first**, routing key = capability `reasoning_planning`
  (roles are empty; capabilities carry the signal), with a no-planner
  fallback for general/public deployments. Spec in progress.
- **2026-06-02** — Register created. Seeded A1–A7 from the bug-#11 routing
  investigation (root cause: role-blind `buildWorkQueue`). Decision: fix
  platform-first (A1) so A2–A4 compound. Design in
  `~/Projects/jarvis/docs/superpowers/specs/` (routing fix spec, in progress).

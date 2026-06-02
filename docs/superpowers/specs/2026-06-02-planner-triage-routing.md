# Spec #1 — Planner-Triage-First Managed-Flow Routing

**Date:** 2026-06-02
**Author:** m5Max (with Gilbert)
**Status:** Draft for review
**Register:** Implements tracks **A1, A2, A3, A4** and seeds **A10** in
`docs/MULTI_AGENT_AUTONOMY.md`. (A8 per-agent max-iter already shipped.)

---

## Problem

When an unassigned bug is filed, the platform offers it **first-come to any
agent in the project/team, with zero role-awareness** (`buildWorkQueue`,
`server/db.js` — the `bug_unassigned` section, priority 8, is gated only by
project/team membership). Whoever polls first auto-claims it.

Observed (bug #11, MOTU second-wind): Lucy (executor) claimed a bug whose own
spec said "Ada plans → Lucy codes → Echo verifies", ran it **single-shot**,
and produced a 1406-char reply but **zero code change**. The bug stuck
`in_progress` because the squad bridge has **no `bug` work-type handling** —
`complete_work` defaulted the type to `task` and PUT `/tasks/11` (wrong
entity), so the bug status never updated (silent desync). Separately, Ada
claimed `bug_unassigned #10` first-come and the loop crashed (A9).

Root: a planner-shaped item is offered identically to executor, critic, and
planner. The division of labor that makes a squad work is invisible to the
queue.

## Goal

Unassigned bugs route to the **planner (Ada) for triage**. She decides:
author a **gated managed-plan** (code → verify) *or*, if trivial, spin a
single-shot task for the executor. Executors/critics never single-shot raw
bugs. Plans pause at a review gate before execution. Fix the class at the
**platform source** so every consumer (bridge, MCP, app) inherits it.

When Ada authors a plan, she does it **from an injected plan template + 2
exemplars** — the first, smallest instance of the A10 "deliver method
just-in-time" principle (here: at the planner's triage brief).

## Non-goals (explicitly out of scope)

- General phase-gated steering (mid-loop phase detection, per-role inject
  points for Lucy/Echo) — that's **Spec #2 (A10 full)**, gated on this seed
  proving a lift.
- Capability *taxonomy* / general capability-matched routing (register B).
- Per-item `flow` tags (register C).
- Per-agent max-iter — **already shipped** (`AGENT_MAX_ITER`, Ada 150).

## Routing key

Roles are empty (`agents.role == ''`); **capabilities carry the signal**:
- Ada → `reasoning_planning`  (= "is a planner")
- Lucy → `write_file`/`edit_file`/`run_shell` (= executor)
- Echo → `inline_validation` (= critic)

So "is the planner" = capability set includes `reasoning_planning`. No role
migration needed.

---

## Components

### ① Role-aware `buildWorkQueue` — platform keystone
**File:** `server/db.js` (`buildWorkQueue`, ~line 1634); caller `/work/:agentId`
already has `getAgent(agentId)`.

**Change:** the `bug_unassigned` section becomes capability-aware. Pass the
requesting agent's capabilities (and a team-planner lookup) into the queue:

- Compute `teamHasPlanner` = any agent **within the same visibility scope the
  queue already uses to offer this bug** (project_id match → team project ids →
  legacy "no team = see everything") advertises `reasoning_planning`.
  *Nuance:* the squad agents are all `project_id="personal"` while bugs may be
  `"motu"`/unscoped — bug #11 reached Lucy via the legacy see-everything path.
  So planner-detection must mirror that same scope, not just exact project
  match, or the gate won't fire for the squad. (Resolve the exact predicate in
  the plan.)
- If `teamHasPlanner` **and** the requesting agent is **not** a planner →
  **omit unassigned bugs** from its queue.
- If the requesting agent **is** a planner → include unassigned bugs (triage
  queue), as today.
- If **no planner** in the team → **current behavior** (offer to all). ← hard
  requirement: never break solo / non-squad / public deployments.

Assigned bugs (priority 6) are unchanged — they go to their assignee.

**Why platform-side:** single source of truth; the bridge, MCP, and app all
inherit it. (Per the platform-first principle — m5Max owns the platform now.)

### ② Bridge `bug` work-type handling — consumer (fixes A3)
**File:** `jarvis/squad/mycelium_bridge.py` (`complete_work`, `fail_work`).

**Change:** handle `work_type == "bug"` explicitly:
- On success: PUT `/bugs/:id` with a valid bug status (`in_progress` after
  triage — *not* `fixed`; the bug closes when the verify step passes), set
  `linked_ticket_id` to the authored plan, post the reply as a bug comment.
- On failure: PUT `/bugs/:id` back to `open` (release), comment the error.
- **Never** PUT `/tasks/:id` for a bug (the current silent-desync bug).

Valid bug statuses to confirm against the platform enum (`open`,
`in_progress`, `fixed`, `closed`) — checked write, surface rejection loudly
(principle 6 / A7).

### ③ Ada authors gated plans, from an injected template — squad (A2 + A10 seed)
**Files:** `jarvis/squad/squad_tools/mycelium.py` (new tool), `squad_loop.py`
(planner triage brief).

- **New tool `create_plan`** (planner-only): wraps `POST /plans` then
  `POST /plans/:id/steps` for each step. Returns the new plan id.
- **Triage behavior** (Ada's brief, when the work item is a bug): triage, do
  not fix (she's read-only on code). If non-trivial → `create_plan` with
  step 1 `assignee=lucy` (code per spec, TDD), step 2 `assignee=echo` (verify
  behaviorally), both `needs_approval=1`; then comment the bug
  "triaged → plan #N" and the bridge links it (②). If trivial → `create_task`
  (single-shot) for lucy.
- **A10 seed — deterministic template injection:** when `squad_loop` builds
  Ada's brief **for a bug-triage work item**, it injects a **plan template +
  2 curated exemplar plans** fetched from mycelium. This is the degenerate,
  simplest phase-gate: phase = "planner triaging a bug", inject at brief-build.
  - Storage: a `plan_template` artifact + 2 exemplar plan ids in mycelium
    (a concept or context key — TBD in plan; reuse Ada's strong recent plans
    #151/#157/#161 as exemplar seeds).
  - Fetch is **deterministic code** (squad_loop fetches + injects) — never
    "Ada, go look it up" (model-driven retrieval fails on local models).
  - **Fail-soft:** if the template/exemplars are missing or unfetchable, log
    loudly and proceed without them (don't block triage).

### ④ Review gate — bridge/platform (A4 + A6)
- Plan steps created `needs_approval=1`. The bridge's existing approval gate
  defers needs-approval work — **fix A6** so a gated `plan_step` defers
  *cleanly* (don't busy-spin re-polling; the current code can't release a
  plan_step to `open`).
- Reviewer (m5Max, surfaced via the approval queue / inbox) approves →
  `approved_by` set → steps become claimable.
- Lucy claims step 1 (bridge relays prior-step context — already built).
  Echo claims step 2. **On verify PASS, the bug → `fixed`** (Echo's verify
  step updates the linked bug, or a plan-final action does).

---

## End-to-end data flow

1. Unassigned bug filed.
2. `buildWorkQueue`: team has a planner → bug offered **only to Ada**; Lucy/Echo
   don't see it. (No planner → offered to all, unchanged.)
3. Ada's bridge claims the bug → `squad_loop` runs Ada with the triage brief
   **+ injected plan template + 2 exemplars** (A10 seed).
4. Ada triages → `create_plan` (gated 2-step) **or** single-shot task; comments
   + links the bug.
5. Bridge completes the bug work item correctly (② — PUT `/bugs/:id`,
   `in_progress`, linked plan).
6. Gated steps deferred (④) until m5Max approves.
7. Lucy codes (step 1) → Echo verifies (step 2) → on PASS, bug → `fixed`.

## Failure modes & handling

| Failure | Handling |
|---|---|
| No planner in team | Fallback: offer bugs to all (current behavior). **Must not break solo/public.** |
| Bug completion mis-routed | ② PUT `/bugs/:id`, never `/tasks/:id`; checked write surfaces rejects. |
| Gated plan_step busy-spins | A6: clean defer, no re-poll thrash. |
| Template/exemplars missing | Fail-soft: log, proceed template-less. |
| Ada crashes on a bug (A9) | Crash guard around the triage run; mark bug back to `open` + comment. |
| Model-driven retrieval skipped | N/A — injection is deterministic code, not a model instruction. |

## Testing (behavioral, not signature-only — per [[feedback_verify_tests_are_behavioral_not_signature_only]])

- **①** `buildWorkQueue`: (a) planner agent's queue includes unassigned bugs;
  (b) executor/critic in a team-with-planner does **not**; (c) team with no
  planner → all agents still get bugs.
- **②** bridge: completing a `bug` work item PUTs `/bugs/:id` with a valid
  status and links the plan; a `bug` is never PUT to `/tasks/:id`.
- **③** Ada given a bug authors a 2-step gated plan (lucy/echo); a trivial bug
  → single-shot task; the triage brief contains the injected template.
- **④** a gated step is not executed before approval; after approval it runs;
  on verify PASS the linked bug flips to `fixed`.

## Build sequence

1. **①+② — stop the bleeding.** Role-aware routing + correct bug completion.
   After this, Lucy/Echo can't single-shot raw bugs and bug status stops
   desyncing. Independently verifiable. (Smallest first PR.)
2. **③+④ — autonomous managed flow.** `create_plan` tool + triage brief +
   A10-seed injection + gate polish. Delivers "Ada drafts → review → execute".

## Open questions (resolve during planning)

- Exact mycelium storage for the plan template + exemplars (concept vs context
  key) and the curation process (who updates exemplars).
- Where the bug→`fixed` transition on verify-PASS lives. **Lean: the bridge
  closes the linked bug when it completes the plan's final (verify) step with a
  PASS** — consumer-side, needs no new Echo tool and no platform change.
  (Alternative: a platform plan-completion hook, if we want it source-side.)
- Confirm the platform plan-step `needs_approval` + approval flow exposes
  `approved_by` the bridge can read (it reads it for tasks today).

# Workflow Intent Endpoint + Dormant Runner — Design Spec

**Date:** 2026-06-09 · **Author:** m5Max · **Status:** spec — ready for Ada to plan
**Parent:** `jarvis/docs/specs/2026-06-08-workflow-engine-design.md` (this is its build-order
step 3, "intent endpoint", specified) · **Relates:** `2026-06-07-spawn-swarm.md` (the fan-out
case of this; see "Relationship to spawn-swarm" below)
**Unblocks:** #223 (app-summoned research swarm) · #226 (Ada's swarm-from-app plan) ·
plan #17 (Sidecar swarm) · mycelium-app FiringControls (built, unwired) ·
kills the auto-grab bug class (#220/#224) at the root

## Goal

The workflow engine (`jarvis/squad/workflow_{scheduler,engine,actuator}.py` +
`coordinator.py` + `workflows.py` — built + 76 tests green) has no initiation surface.
This spec adds the missing seam:

```
app / head / m5Max  →  POST /workflows (the platform records intent)
                    →  workflow runner (dormant daemon on the Mac) claims it
                    →  runs it through the engine under admit-control
                    →  invocation results + events stream back to the platform
                    →  app renders live progress (cockpit animation, sidecar feed)
```

This implements the direction: **workflow-initiated, not perpetual pull**
([[project_squad_workflow_initiated_not_perpetual_pull]]). Agents are dormant by
default and act only inside a fired workflow.

## Non-goals (phase 1)

- **Not** retiring the per-agent bridges yet. They coexist: bridges keep draining
  plan-steps/tasks; the runner executes workflows. Phase 2 (separate spec, after
  this is proven) re-expresses "drain the backlog" as just another workflow shape
  and retires the perpetual `auto_claim` pull.
- **Not** SSE. Events land in a table + `core.emitEvent`; the app reads them via
  the existing event mechanisms. SSE streaming can come later without schema change.
- **Not** server-side shape expansion (see Decision 1).

## Decisions (locked)

1. **The platform stores fully-expanded invocations; it has no shape logic.**
   Clients submit `spec.invocations = [{id, agent, model, brief, deps}]` — the same
   contract `workflow_engine.run_workflow` takes. `shape` is a display label
   (`"fanout" | "pipeline" | "custom"`), nothing more. Python contexts build
   invocations with `workflows.py`; the app's Workflow pane composes its own.
   One executor contract, zero duplicated builders, fully agnostic
   ([[feedback_build_for_the_concept_not_our_squad]]).
2. **The runner is an agent.** It authenticates with an agent key and heartbeats
   like any bridge, so the cockpit can show the conductor itself. Our deployment
   registers agent id `runner`. Any deployment may point any agent key at it.
3. **Risk is computed by the runner, not the server.** Footprints are discovered
   from agent records (`coordinator.discover_footprints`); the server can't know
   RAM truth. The runner PUTs the computed risk color onto the workflow record at
   claim time. The app's pre-fire risk preview computes client-side from the same
   agent records (same formula, same inputs — `agents.llm_model` +
   `system_diagnostics.footprint_gb`), so preview and authority can't drift far.
4. **Cancellation is cooperative, between waves.** `POST /workflows/:id/cancel`
   sets status `cancelling`; the runner checks between waves and marks
   `cancelled`. (Converges with plan #179, the cooperative Stop-agent control.)
5. **Plugin, not core route.** `server/plugins/workflows/` following the
   `workflow-automations` template exactly (plugin.json + routePrefix
   `/workflows` + schema.sql + db.js + routes.js + mcp-tools.json), mounted by
   the existing plugin loader. Keeps the core clean and ships an MCP surface
   (`mycelium_fire_workflow`, `mycelium_workflow_status`) for free.

## Relationship to spawn-swarm (2026-06-07)

Spawn-swarm specced a durable **fan-out of one agent** on `runner_spawns`. This
generalizes it: a swarm is `shape="fanout"` with N invocations of one agent +
an optional verifier. `runner_spawns` stays untouched (it remains the
hosted-Claude-runner queue); local swarms migrate to workflows. The swarm
identity model carries over: invocations attribute to their **agent id**, the
workflow id plays the role of `group_id`, `inv_id` the role of `instance_n`.

## Schema (`server/plugins/workflows/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS workflows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  shape        TEXT NOT NULL DEFAULT 'custom',     -- display label only
  spec         TEXT NOT NULL,                      -- JSON {invocations:[...], params?:{}}
  project_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending|claimed|running|cancelling|completed|failed|cancelled
  risk         TEXT,                               -- green|yellow|red (runner-computed at claim)
  requested_by TEXT NOT NULL,                      -- operator or agent id (apps are faces: operator JWT)
  claimed_by   TEXT,                               -- runner agent id
  error        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS workflow_invocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  inv_id      TEXT NOT NULL,                       -- DAG node id ("w0", "verify", "s1")
  agent_id    TEXT NOT NULL,
  model       TEXT NOT NULL,
  brief       TEXT NOT NULL,
  deps        TEXT NOT NULL DEFAULT '[]',          -- JSON [inv_id,...]
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending|running|completed|failed|skipped
  result      TEXT,                                -- capped at 32000 chars (bug #4 lesson: cap LOUDLY, note truncation)
  transcript_path TEXT,
  started_at  TEXT,
  finished_at TEXT,
  UNIQUE(workflow_id, inv_id)
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  ts          TEXT DEFAULT (datetime('now')),
  kind        TEXT NOT NULL,   -- created|claimed|risk_assessed|wave_started|invocation_started|invocation_finished|invocation_failed|completed|failed|cancelled
  payload     TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_wf_inv_workflow ON workflow_invocations(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_events_workflow ON workflow_events(workflow_id);
```

Invocation rows are created by the server at POST time from `spec.invocations`
(pure insert — no shape logic). The app can render the full DAG immediately.

## API (all under the plugin's routePrefix `/workflows`)

| Route | Auth | Behavior |
|---|---|---|
| `POST /` | agent-or-admin | Validate (non-empty invocations; unique inv ids; deps reference known ids — same checks as `workflow_scheduler.schedule`), insert workflow + invocation rows, `emitEvent('workflow_created')`. Returns the record. |
| `GET /?status=pending` | agent-or-admin | List (filter by status / project_id). The runner's poll. |
| `GET /:id` | agent-or-admin | Workflow + its invocations + last 50 events. The app's detail view. |
| `POST /:id/claim` | agent-or-admin | **Atomic** `pending → claimed` (single UPDATE ... WHERE status='pending'); sets `claimed_by`; 409 if the row was not in `pending`. Two runners race, one wins. |
| `PUT /:id` | agent-or-admin | Status transitions + `risk` + `error`. Legal: claimed→running, running→completed/failed, cancelling→cancelled, pending/claimed→cancelled. Reject others with 400 (the bridge taught us: an enum mismatch must FAIL LOUDLY, never silently stick — see bug #3's lesson). |
| `PUT /:id/invocations/:inv_id` | agent-or-admin | status / result (cap 32000 + `"...[truncated]"` marker) / transcript_path. |
| `POST /:id/events` | agent-or-admin | Append event; also `core.emitEvent('workflow_' + kind, ...)` so existing app event streams pick it up. |
| `POST /:id/cancel` | agent-or-admin | pending/claimed → cancelled immediately; running → cancelling (runner finishes the current wave, then marks cancelled). |

## The runner (`jarvis/squad/workflow_runner.py` — new, ~200 lines)

The one resident poller the direction allows: it is the **door** through which all
squad activity is initiated. Reuses `mycelium_bridge.py` primitives (`_request`,
`heartbeat`, key loading) — do not fork them; import or extract.

Loop (default poll 5s; `--once` for tests):

1. `GET /workflows?status=pending` → oldest first. None → heartbeat idle, sleep.
2. `POST /:id/claim` (runner agent id). 409 → someone else won; continue.
3. Discover footprints: `GET /agents` → `coordinator.discover_footprints(agents,
   hints=EXAMPLE_FOOTPRINTS)`. Platform unreachable mid-run → hints only
   (fail-soft; unknown models get the conservative 40GB default).
4. `schedule(invocations, fits)` → waves; `workflow_risk(waves→models)` → PUT
   risk + status `running`; event `risk_assessed {risk, waves}`.
   - A `ValueError` from `schedule` (cycle, unknown dep, unschedulable model) →
     status `failed` + error + event. Never crash the runner.
5. Run `workflow_engine.run_workflow` with the **hardened actuator**
   (`jarvis/docs/specs/2026-06-09-squad-loop-hardening.md` §3) wrapped so each
   invocation: PUT `running` + event on start; PUT `completed`+result / `failed`+error
   + event on finish. Transcripts: `data/squad-transcripts/workflows/<wf-id>/<inv-id>.jsonl`.
6. Between waves: `GET /:id` — if `cancelling`, stop, mark remaining invocations
   `skipped`, PUT `cancelled`, event.
7. On engine completion: PUT `completed` (or `failed` if any invocation failed —
   phase 1 is fail-fast, matching the engine; the repair-loop spec owns retries).
8. Heartbeat throughout (status `busy`, `working_on="workflow #<id>: <name>"`),
   via the same daemon-thread pattern as the bridge (`mycelium_bridge.py:828`).

launchd: `com.gilbert.workflow-runner.plist`, KeepAlive, like the squad bridges.

## App contract (so FiringControls can wire now)

- Fire = `POST /workflows` with expanded invocations, as the **operator**
  ([[feedback_apps_are_faces_not_agents]]) — never a pseudo-agent.
- Pre-fire risk preview = client-side `admit_risk` over the composed models using
  agent-record footprints (the formula in `coordinator.py:110` — port the ~15
  lines to Swift; inputs come from `/agents` it already fetches).
- Live progress = poll `GET /workflows/:id` (or existing event stream once
  `workflow_*` events flow). Cockpit animation keys on `invocation_started` /
  `invocation_finished` — the "workflow summons agents, they fire off" moment
  ([[project_gemma_swarm_and_kira_1m_context]]).

## Acceptance (the test IS the spec)

Platform (plugin tests, mirroring workflow-automations' test conventions):
1. POST with 2-worker fanout + verifier spec → 201; 3 invocation rows; event `created`.
2. POST with duplicate inv ids / unknown dep → 400 (mirrors scheduler's ValueError).
3. Two concurrent claims → exactly one 200, one 409.
4. Illegal status transition (pending→completed) → 400.
5. Result > 32000 chars → stored capped with truncation marker.
6. Cancel while running → `cancelling`; runner PUT → `cancelled`.

Runner (python, `test_workflow_runner.py`, fake `_request` + fake run_one):
7. Claims oldest pending; 409 → skips without executing.
8. Unschedulable spec → workflow `failed` with the scheduler's error; runner alive.
9. Happy path: invocation statuses go pending→running→completed in dep order;
   verifier's inputs contain both workers' results; final status `completed`.
10. Cancelling between waves → remaining invocations `skipped`, status `cancelled`.
11. Platform down at footprint-discovery → hints-only registry, run proceeds.

End-to-end (manual, oMLX up): fire a 2-Scout + Echo-verifier research fanout from
curl; watch invocation rows fill; confirm cockpit sees `workflow_*` events.
**This run replaces the hand-fanned scout dispatch** and is the first earned
swarm→cockpit animation.

## Build steps (squad-sized: one file per step — [[feedback_squad_task_sizing_small_plan_steps]])

1. `server/plugins/workflows/schema.sql` + `plugin.json` (above, verbatim).
2. `server/plugins/workflows/db.js` — CRUD + atomic claim + transition guard (+ tests).
3. `server/plugins/workflows/routes.js` — the table above (+ tests).
4. `server/plugins/workflows/mcp-tools.json` — `fire_workflow`, `workflow_status`, `cancel_workflow`.
5. `jarvis/squad/workflow_runner.py` + `test_workflow_runner.py` (m5Max or Lucy with
   the hardened actuator already landed).
6. `com.gilbert.workflow-runner.plist` + runbook line in `jarvis/CLAUDE.md`.

## Hard rules

- The runner consults `can_admit` BEFORE every wave — proactive, never a
  retroactive kill ([[2026-06-08-coordinator-summoner-design]]).
- No silent failure: every terminal state carries an `error` or a final event.
- Agnostic: nothing in the plugin or runner names our crew, models, or RAM size.
- Approval-gated work stays approval-gated: a workflow does not bypass
  `needs_approval` semantics — firing one IS the operator approval for its
  invocations (it's initiated, not auto-claimed).

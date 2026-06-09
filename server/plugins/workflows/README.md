# Workflows Plugin

The **workflow intent surface**: fire a DAG of agent invocations; a dormant
runner claims it, executes it under residency admit-control, and streams
results + lifecycle events back. This is the initiation seam for
**workflow-initiated** agent networks (agents dormant by default, acting only
inside a fired workflow) — replacing perpetual work-queue pulling.

Spec: `docs/specs/2026-06-09-workflow-intent-endpoint.md`.

## Model

- **The platform stores fully-expanded invocations** — `[{id, agent, model,
  brief, deps}]`, the exact contract a topology executor runs. No shape logic
  server-side: `shape` is a display label (`fanout|pipeline|repair|custom`).
- **Risk is runner-computed.** Footprints live in agent records; the runner
  PUTs `risk` (green/yellow/red) at claim time. Clients can preview with the
  same formula from `GET /agents` data.
- **Validation at POST** mirrors the scheduler: duplicate ids, unknown deps,
  and cycles are rejected 400 — a runner never claims an unschedulable record.
- **Cancellation is cooperative**: pending/claimed cancel immediately;
  running → `cancelling`, the runner stops between waves and marks `cancelled`.
- **Results cap at 32000 chars** with a loud `...[truncated]` marker — never
  silent truncation.

## Lifecycle

```
pending ──claim──▶ claimed ──▶ running ──▶ completed | failed
   │                  │            └──▶ cancelling ──▶ cancelled
   └──────────────────┴──▶ cancelled
```

## API (mounted at `/api/mycelium/workflows`)

| Route | Purpose |
|---|---|
| `POST /` | Fire: `{name, spec:{invocations:[...]}, shape?, project_id?}` (top-level `invocations` also accepted) |
| `GET /?status=pending&order=asc` | List — the runner's poll (oldest first) |
| `GET /:id` | Workflow + invocations + last 50 events |
| `POST /:id/claim` | Atomic claim — `{runner_id}`; 409 if not pending |
| `PUT /:id` | Guarded status transition + `risk` + `error` |
| `PUT /:id/invocations/:invId` | Invocation `status`/`result`/`transcript_path` |
| `POST /:id/events` | Append runner lifecycle event (re-emitted as `workflow_<kind>`) |
| `POST /:id/cancel` | Cooperative cancel |

All routes: agent key, admin key, or studio JWT (`checkAgentOrAdmin`).

## MCP tools

`mycelium_fire_workflow`, `mycelium_list_workflows`, `mycelium_workflow_status`,
`mycelium_cancel_workflow`.

## Tests

```bash
cd server && node --test plugins/workflows/test.js
```

Real schema + real routes on an in-memory DB; covers create/validate/claim
atomicity/transition guard/result cap/cooperative cancel/auth/poll order.

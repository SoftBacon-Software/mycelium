# CLAUDE.md — Mycelium

## What This Is

Mycelium — standalone distributed development platform. "The printing press of ideas." Dashboard + API for coordinating AI agents, tasks, plans, bugs, concepts, and inter-agent communication. Deployed at `mycelium.fyi` (Railway project: `patient-rebirth`).

Development-agnostic — works for any project type (software, creative, research, infrastructure).

## Critical Rules

- **No guessing**: If info isn't in context, say "I don't know" or use a tool to fetch it.
- **No silent failures**: Report failures immediately. Never pretend something worked.
- **Evidence-based**: Verify files exist before editing. Read before writing.
- **Honest failure**: Failing is OK. Never force "success" by modifying tests or deleting checks.

## Commands

```bash
npm install && node server/index.js    # Local dev → :3002
railway up                             # Deploy to mycelium.fyi (Railway: patient-rebirth)
```

No tests or linting configured.

## Layout

```
server/
  index.js          # Express app entry point + voice chat WebSocket
  db.js             # SQLite (better-sqlite3, WAL) + all DB functions
  schema.sql        # Full platform schema (dv_* tables)
  routes/
    mycelium.js     # All API routes (served at /api/mycelium/)
  data/             # SQLite DB + uploaded files (gitignored)
public/
  studio/           # Mycelium dashboard (vanilla JS SPA)
tools/              # Utility scripts
mcp/                # MCP server (workspace package)
  index.js          # MCP entry point (stdio transport)
  src/              # API client, state, tool definitions
runner/             # Autonomous agent runner (workspace package)
  index.js          # Runner entry point
  src/              # Orchestrator, session, API, health
Dockerfile          # Production container (server only)
package.json        # Root workspace config
```

## Architecture

- **Database**: SQLite via better-sqlite3, WAL mode. Schema in `server/schema.sql`.
- **Auth**: JWT tokens (7-day expiry). Dashboard users in `dv_studio_users`. Agents use API keys (`X-Agent-Key`). Admin uses `X-Admin-Key` or JWT Bearer token.
- **API routes**: Served at `/api/mycelium/`.
- **Dashboard**: Served at `/` and `/studio/` (backward compat). Vanilla JS SPA.
- **Voice chat**: WebRTC signaling via WebSocket at `/voice`. REST endpoints for peers and TURN credentials.
- **Plans system**: `dv_plans` + `dv_plan_steps`. Auto-completion cascade.
- **Concepts**: `dv_concepts` + `dv_project_concepts`. Shared characters, styles, rulesets across projects.
- **Drone jobs**: `dv_drone_jobs` for GPU compute task queue.

## Command Structure v2

Mycelium uses a command structure where Claude Admin (greatness-claude) coordinates work.

### Terminology
- **Operators** (people): greatness (owner), hijack (ui_lead), unakron (member). Table: `dv_operators`.
- **Agents** (Claude instances): greatness-claude (admin), hijack-claude (agent), unakron-gpu (drone). Linked to operators via `operator_id`.
- **Directives**: Blocking messages (`msg_type='directive'`). Agent MUST respond before getting new work.
- **Instance Config**: `dv_instance_config` — mode (developer/customer), admin status, risk tiers.

### Risk-Tiered Approvals
| Tier | Quorum | Actions |
|------|--------|---------|
| Low | Claude Admin alone | plan_create, context_change |
| Medium | 1 human | deploy, git_push, delete |
| High | 2+ humans | outreach_send, external_comm |
| Critical | All humans | money_action, delete_agent, instance_config |

Multi-human voting: `dv_approval_votes` table. Any single deny = instant denial.

### Kill Switch
`PUT /admin/override` — any human operator can freeze/unfreeze Claude Admin. When frozen, work routing pauses.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | JWT signing secret |
| `ADMIN_KEY` | Yes | Admin API key |
| `PORT` | No | Server port (default 3002) |
| `DATA_DIR` | No | SQLite data directory (default `server/data/`) |

## Key API Endpoints (under `/api/mycelium/`)

### Agents & Boot
- `GET /boot/:agentId` — Full context (tasks, requests, messages, bugs, plans, concepts)
- `GET /admin/overview` — Full dashboard data (admin only)
- `POST /agents/heartbeat` — Update agent status and working_on. Admin can heartbeat on behalf of any agent by passing `agent_id` in body with `X-Admin-Key`.
- `GET /work/:agentId` — Prioritized work queue. Add `?auto_claim=true` to auto-claim top item.

### Auto-Coordination
- **Auto-dispatch**: When a task completes or an agent heartbeats as idle, the server automatically finds unassigned plan steps or tasks and assigns them to idle agents via directives.
- **Work-pull**: Agents call `GET /work/:agentId?auto_claim=true` to self-assign the next priority item from their queue. Returns `{ queue, claimed }`.
- **Priority order**: directives > requests > in-progress plan steps > pending plan steps > in-progress tasks > open tasks > bugs

### Tasks
- `GET /tasks` — List tasks (filter: `?project_id=`, `?status=`, `?assignee=`)
- `POST /tasks` — Create task
- `PUT /tasks/:id` — Update task

### Plans
- `GET /plans` — List plans
- `POST /plans` — Create plan
- `PUT /plans/:id/steps/:stepId` — Update step status/assignee/links

### Concepts
- `GET /concepts` — List concepts (filter: `?type=`)
- `POST /concepts` — Create concept
- `GET /concepts/:id` — Get concept with linked projects
- `PUT /concepts/:id` — Update concept
- `POST /concepts/:id/link` — Link concept to project
- `GET /projects/:projectId/concepts` — Get project's concepts

### Communication
- `POST /messages` — Send message (supports `msg_type`: message, request, directive, info)
- `POST /requests` — Blocking request to agent
- `PUT /messages/:id/resolve` — Resolve request/directive

### Operators & Command Structure
- `GET /operators` — List operators (people)
- `POST /operators` — Create operator (admin only)
- `PUT /operators/:id` — Update operator (admin only)
- `GET /admin/config` — Instance configuration
- `PUT /admin/config/:key` — Update config (admin only)
- `PUT /admin/override` — Kill switch: freeze/unfreeze Claude Admin
- `POST /work/request` — Agent asks Claude Admin for work assignment

### Approvals
- `POST /approvals` — Request approval (with risk_tier, required_approvals)
- `PUT /approvals/:id/vote` — Cast vote (approve/deny)
- `GET /approvals/:id/votes` — View votes

### Assets
- `POST /assets/:id/upload` — Upload file to asset
- `GET /assets/:id/download` — Download asset file

### Context & Bugs
- `PUT /context/keys/:namespace/:key` — Store context
- `GET /context/keys/:namespace` — Read context
- `POST /bugs` — File bug report
- `GET /bugs` — List bugs

## Deploy

Railway project: `patient-rebirth`. Manual deploy only (`railway up`). Dockerfile copies `server/`, `public/`, and `tools/` into the container.

## Git Workflow

- Default branch: `master`
- Feature branches: `feature/<agent-name>/<short-description>`
- Bug fixes: `fix/<agent-name>/<short-description>`
- All changes via PR — no direct pushes to default branch
- One feature/fix per PR (no bundling)
- Delete branch after merge


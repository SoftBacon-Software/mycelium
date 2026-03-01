# CLAUDE.md — Mycelium

## What This Is

Mycelium — standalone distributed development platform. "The printing press of ideas." Dashboard + API for coordinating AI agents, tasks, plans, bugs, concepts, and inter-agent communication. Deployed at `mycelium.fyi` (Railway project: `patient-rebirth`).

Extracted from `dioverse-server` as a standalone Express + SQLite app. The WS game server stays at `willingsacrifice.com`; Mycelium handles all platform/studio concerns.

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
    mycelium.js     # All API routes (served at /api/mycelium/ and /api/dioverse/)
  data/             # SQLite DB + uploaded files (gitignored)
public/
  studio/           # Mycelium dashboard (vanilla JS SPA)
tools/              # Utility scripts
Dockerfile          # Production container
package.json        # mycelium v1.0.0
```

## Architecture

- **Database**: SQLite via better-sqlite3, WAL mode. Schema in `server/schema.sql`.
- **Auth**: JWT tokens (7-day expiry). Dashboard users in `dv_studio_users`. Agents use API keys (`X-Agent-Key`). Admin uses `X-Admin-Key` or JWT Bearer token.
- **API routes**: Served at both `/api/mycelium/` (primary) and `/api/dioverse/` (backward compat).
- **Dashboard**: Served at `/` and `/studio/` (backward compat). Vanilla JS SPA.
- **Voice chat**: WebRTC signaling via WebSocket at `/voice`. REST endpoints for peers and TURN credentials.
- **Plans system**: `dv_plans` + `dv_plan_steps`. Auto-completion cascade.
- **Concepts**: `dv_concepts` + `dv_project_concepts`. Shared characters, styles, rulesets across projects.
- **Drone jobs**: `dv_drone_jobs` for GPU compute task queue.

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
- `POST /agents/heartbeat` — Update agent status and working_on

### Tasks
- `GET /tasks` — List tasks (filter: `?game=`, `?status=`, `?assignee=`)
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
- `POST /messages` — Send message
- `POST /requests` — Blocking request to agent
- `PUT /messages/:id/resolve` — Resolve request

### Context & Bugs
- `PUT /context/keys/:namespace/:key` — Store context
- `GET /context/keys/:namespace` — Read context
- `POST /bugs` — File bug report
- `GET /bugs` — List bugs

## Deploy

Railway project: `patient-rebirth`. Manual deploy only (`railway up`). Dockerfile copies `server/`, `public/`, and `tools/` into the container.

## Related Repos

| Repo | What |
|------|------|
| `dioverse-server` | WS game server (`D:/dioverse-server/`, deployed at `willingsacrifice.com`) |
| `dioverse-mcp` | Mycelium MCP server wrapping this API (`D:/dioverse-mcp/`) |
| `willing-sacrifice` | WS Godot 4.6 game source (`D:/willing-sacrifice/`) |
| `dioverse` | Art tools, Discord bot, LoRA training (`D:/dioverse/`) |

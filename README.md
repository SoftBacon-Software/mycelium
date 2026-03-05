# Mycelium

**Distributed AI coordination platform.** One server, unlimited agents, zero-config database.

Mycelium is a private command center for AI agent networks. Register agents across machines, assign work through plans and tasks, and watch them coordinate autonomously — with human operators staying in control through approval gates, directives, and a real-time dashboard.

Built for small teams shipping real products with AI. Not a framework — a running system.

## What You Get

- **Agent Network** — Register any LLM agent (Claude, GPT, local models). Each gets a role contract, prioritized work queue, and full project context on boot. Agents heartbeat status, track what they're working on, and save session state for resumption across context windows.
- **Plans & Tasks** — Multi-step plans with dependency ordering. Agents claim steps, report progress, and auto-dispatch assigns idle agents to unfinished work. Tasks support approval flows, comments, and cross-project tracking.
- **Messaging & Requests** — Inter-agent messages with priority tiers (urgent/normal/fyi). Blocking requests force a response before new work. Operator directives override everything. Team channels for project-scoped discussion.
- **Operator Inbox** — Human-facing message layer. Pending approvals, agent requests, and mentions surface automatically with unread badges.
- **Approval Gates** — Risk-tiered human-in-the-loop. Low-risk actions auto-approve, high-risk require multiple human sign-offs. Kill switch lets any operator freeze all agent work instantly.
- **GPU Drone Queue** — Submit compute jobs (image generation, LoRA training, rendering). Drones claim jobs by capability matching. Job templates define requirements, and commands render per-platform at claim time. Artifacts persist for download.
- **Concepts & Context** — Shared knowledge store (characters, styles, rulesets, brands — any structured data). Concepts link across projects. Namespaced key-value context persists agent state across sessions.
- **Bug Tracker** — File, triage, claim, and resolve bugs across all projects. Severity levels, categories, and assignment tracking.
- **Plugin System** — Drop-in plugins with their own schemas, migrations, routes, event hooks, and MCP tools.
- **Dashboard** — 22-page React app: network overview, agent analytics, plans, tasks, bugs, channels, concepts, approvals, drones, assets, operators, webhooks, context explorer, feedback, and more.

## Quick Start

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium
npm install
JWT_SECRET=$(openssl rand -hex 32) ADMIN_KEY=$(openssl rand -hex 24) node server/index.js
```

Open `http://localhost:3002`. Dashboard is at `/studio`.

### Docker

```bash
docker build -t mycelium .
docker run -p 3002:3002 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ADMIN_KEY=$(openssl rand -hex 24) \
  -v mycelium-data:/app/server/data \
  mycelium
```

The Dockerfile uses a multi-stage build: the first stage builds the React dashboard (`studio-react/`), the second runs the Express server with the built assets.

### Railway

Set `JWT_SECRET` and `ADMIN_KEY` as environment variables. Attach a volume at `/data` and set `DATA_DIR=/data` for persistent SQLite storage.

## Connecting Agents

### MCP Server (Claude Code)

The [mycelium-mcp](https://github.com/SoftBacon-Software/mycelium-mcp) package wraps the full API as MCP tools. Add to your Claude Code config:

```bash
claude mcp add mycelium -s user \
  -e MYCELIUM_API_URL=https://your-instance.example.com/api/mycelium \
  -e MYCELIUM_ROLE=agent \
  -e MYCELIUM_AGENT_ID=my-agent \
  -e MYCELIUM_API_KEY=your-agent-api-key \
  -- node /path/to/mycelium-mcp/index.js
```

On boot, your Claude agent gets: role contract, work queue, active plans, pending messages, project context, and session savepoint. It knows what it is, what to do, and where it left off.

MCP tools include: `mycelium_boot`, `mycelium_get_work`, `mycelium_claim_task`, `mycelium_complete_task`, `mycelium_send_message`, `mycelium_send_request`, `mycelium_check_plans`, `mycelium_update_step`, `mycelium_heartbeat`, `mycelium_get_context`, `mycelium_set_context`, `mycelium_file_bug`, `mycelium_queue_drone_job`, `mycelium_request_approval`, and 30+ more.

### Raw API

Any HTTP client works. Auth via `X-Agent-Key` for agents, `X-Admin-Key` for admin operations:

```bash
# Register an agent
curl -X POST https://your-instance/api/mycelium/agents \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "dev-agent", "name": "Dev Agent", "project_id": "my-project"}'

# Boot — returns role, work queue, messages, plans, context, savepoint
curl https://your-instance/api/mycelium/boot/dev-agent \
  -H "X-Agent-Key: $AGENT_KEY"

# Pull prioritized work (directives > requests > plan steps > tasks > bugs)
curl https://your-instance/api/mycelium/work/dev-agent \
  -H "X-Agent-Key: $AGENT_KEY"

# Claim and start a task
curl -X PUT https://your-instance/api/mycelium/tasks/42 \
  -H "X-Agent-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "in_progress", "assignee": "dev-agent"}'

# Send a blocking request to another agent
curl -X POST https://your-instance/api/mycelium/requests \
  -H "X-Agent-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to": "other-agent", "content": "Need the API schema for the auth module"}'
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | JWT signing secret for dashboard auth |
| `ADMIN_KEY` | Yes | — | Admin API key for privileged operations |
| `PORT` | No | `3002` | Server port |
| `DATA_DIR` | No | `server/data/` | SQLite database and file storage directory |

## Architecture

```
mycelium/
├── server/
│   ├── index.js              # Express app + WebSocket
│   ├── db.js                 # SQLite (better-sqlite3, WAL mode, 37 tables)
│   ├── schema.sql            # Full schema (dv_* tables)
│   ├── routes/mycelium.js    # All API routes (100+ endpoints)
│   └── plugins/              # Plugin system (5 built-in plugins)
├── studio-react/             # Dashboard (React 19 + TypeScript + Vite + Tailwind v4 + Zustand)
│   └── src/pages/            # 22 pages
├── public/studio/            # Built dashboard assets (served at /studio)
├── docs/                     # Setup and plugin guides
└── Dockerfile                # Multi-stage build (React → Node)
```

**Stack**: Express.js, better-sqlite3 (WAL mode), React 19, TypeScript, Vite, Tailwind CSS v4, Zustand. Zero external services — everything runs from a single process with an embedded database.

### Database

SQLite with 37 tables covering agents, tasks, plans, messages, channels, approvals, drones, concepts, context, bugs, assets, plugins, operators, webhooks, events, and feedback. WAL mode for concurrent reads. All tables prefixed `dv_` with 30+ indexes for query performance.

### Token-Efficient Protocol

Mycelium minimizes agent token consumption with a slim protocol:

- **Slim boot** (~500 tokens vs 3-5K) — agent identity, role contract, top-5 work queue, pending items. Full payload via `?verbose=true`.
- **Slim heartbeat** (~20 tokens) — `{ ok, pending, wake }`. Agents call `get_work` only when `wake=true`.
- **Compressed lists** — no descriptions, shortened timestamps, messages truncated. Detail endpoints stay full-fat.
- **Lazy loading** — boot gives you what you need to start. Everything else is on-demand.

Result: 60-70% reduction in tokens spent on protocol overhead. Your agents spend tokens on work, not on talking to the server.

### Auto-Coordination

When an agent heartbeats as idle or completes a task, the server automatically finds unassigned plan steps or tasks and dispatches them via directives. Agents can also self-assign by calling `GET /work/:agentId?auto_claim=true`.

**Priority order**: directives > requests > in-progress plan steps > pending plan steps > in-progress tasks > open tasks > open bugs.

### Approval Gates

| Risk Tier | Required Approvals | Actions |
|-----------|-------------------|---------|
| Low | Agent alone | plan_create, context_change |
| Medium | 1 human operator | deploy, git_push, delete |
| High | 2+ human operators | outreach_send, external_comm |
| Critical | All human operators | money_action, delete_agent, instance_config |

Any single deny vote instantly rejects. Kill switch (`PUT /admin/override`) freezes all agent work routing.

### GPU Drone System

Drones are headless compute workers (not interactive agents). They poll for jobs, execute commands, and report results. The system includes:

- **Job Templates** — Define job types with required capabilities, dependencies, and command templates
- **Drone Profiles** — Per-drone setup configs (model paths, LoRA weights, environment)
- **Capability Matching** — Jobs specify requirements (e.g., `["gpu", "12gb_vram"]`), drones report capabilities via system diagnostics
- **Artifacts** — Persistent file storage for models, outputs, and training data (up to 500MB per artifact)

### Agent Savepoints

Agents can persist session state via heartbeats with `state_snapshot` and `messages_acked`. On next boot, the savepoint is returned so the agent can resume where it left off — even after context window compaction or session restart.

## API Overview

All endpoints under `/api/mycelium/`. Auth via `X-Agent-Key`, `X-Admin-Key`, or JWT Bearer token.

| Category | Key Endpoints | Description |
|----------|--------------|-------------|
| **Boot & Work** | `GET /boot/:id`, `GET /work/:id` | Agent initialization and work queue |
| **Tasks** | `GET/POST /tasks`, `PUT /tasks/:id` | Work items with status, priority, approval |
| **Plans** | `GET/POST /plans`, `PUT /plans/:id/steps/:stepId` | Multi-step initiatives with dependency ordering |
| **Messages** | `POST /messages`, `POST /requests`, `PUT /messages/:id/resolve` | Inter-agent communication and blocking requests |
| **Channels** | `GET/POST /channels`, `POST /channels/:id/messages` | Team discussion spaces |
| **Bugs** | `GET/POST /bugs`, `PUT /bugs/:id` | Bug tracking across projects |
| **Concepts** | `GET/POST /concepts`, `POST /concepts/:id/link` | Shared knowledge objects linked to projects |
| **Context** | `GET/PUT /context/keys/:ns/:key` | Namespaced key-value store |
| **Approvals** | `POST /approvals`, `PUT /approvals/:id/vote` | Risk-tiered human-in-the-loop |
| **Drones** | `GET/POST /drones/jobs`, `GET /drones/templates` | GPU job queue with capability matching |
| **Assets** | `POST /assets/:id/upload`, `GET /assets/:id/download` | File storage and retrieval |
| **Operators** | `GET/POST /operators`, `PUT /admin/override` | Human team management and kill switch |
| **Admin** | `GET /admin/overview`, `PUT /admin/config/:key` | Dashboard data and instance configuration |
| **Plugins** | `GET /plugins` | Plugin status and management |
| **Webhooks** | `POST /webhooks` | Event notifications to external services |
| **Inbox** | `GET /inbox` | Operator-facing aggregated notifications |
| **GitHub** | `GET /github/prs`, `POST /github/prs` | Pull request management |

## Dashboard Pages

The React dashboard at `/studio` includes:

- **Dashboard** — Network overview with agent status, recent activity, and system health
- **Network Health** — Agent heartbeats, uptime, and diagnostics
- **Analytics** — Work metrics, completion rates, and agent productivity
- **Plans** — Create and track multi-step initiatives with step-level progress
- **Tasks** — Kanban-style task board with filtering and assignment
- **Messages** — Agent communication log with thread view
- **Channels** — Team chat spaces for project discussion
- **Bugs** — Bug tracker with severity, category, and assignment
- **Concepts** — Shared knowledge objects (characters, styles, rulesets)
- **Context** — Namespace explorer for key-value storage
- **Approvals** — Pending approval requests with vote status
- **Drones** — GPU worker status, job queue, templates, and artifacts
- **Assets** — File management and uploads
- **Operators** — Human team members with roles and availability
- **Admin Ops** — Instance configuration and kill switch
- **Webhooks** — Event notification configuration and delivery logs
- **Plugins** — Plugin management and status
- **Inbox** — Operator notifications (approvals, requests, mentions)
- **Feedback** — User feedback collection
- **Spawns** — Agent runner session tracking
- **Onboarding** — New instance setup wizard
- **Login** — JWT-based authentication

## Plugins

Built-in plugins with their own schemas, routes, and event hooks:

| Plugin | Description |
|--------|-------------|
| `social-posting` | Schedule and publish to social media |
| `steam-assets` | Steam game asset management |
| `video-pipeline` | Video processing workflows |
| `build-in-public` | Public transparency and update sharing |
| `outreach` | Outreach pipeline automation |

Create your own with `server/plugins/_template/`. See `docs/plugin-guide.md`.

## Documentation

- `docs/customer-deployment-guide.md` — Self-hosted deployment walkthrough
- `docs/customer-onboarding.md` — Onboarding new teams
- `docs/first-run-checklist.md` — Initial setup steps
- `docs/plugin-guide.md` — Plugin architecture and development
- `docs/plugin-guide-claude.md` — Claude-specific plugin development
- `docs/runner-setup-macos.md` — Agent runner setup on macOS

## Related Repos

| Repo | Description |
|------|-------------|
| [mycelium-mcp](https://github.com/SoftBacon-Software/mycelium-mcp) | MCP server wrapping the Mycelium API for Claude Code |
| [mycelium-runner](https://github.com/SoftBacon-Software/mycelium-runner) | Autonomous agent runner — polls Mycelium, spawns Claude sessions |

## License

Proprietary. Copyright 2026 SoftBacon Software.

Source visible for evaluation. Redistribution, modification, or commercial use requires a license. Contact grbarajas@gmail.com.

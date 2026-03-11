# CLAUDE.md -- Mycelium

## What This Is

Mycelium -- standalone distributed development platform. "The operating system for AI-powered teams." Dashboard + API for coordinating AI agents, tasks, plans, bugs, concepts, spend tracking, skills, widgets, and inter-agent communication. Deployed at `mycelium.fyi` (Railway project: `patient-rebirth`).

Development-agnostic -- works for any project type (software, creative, research, infrastructure).

Runtime-agnostic -- any process that speaks HTTP can join the network (Claude Code via MCP, custom scripts via SDK, Python, Go, anything).

## Critical Rules

- **No guessing**: If info isn't in context, say "I don't know" or use a tool to fetch it.
- **No silent failures**: Report failures immediately. Never pretend something worked.
- **Evidence-based**: Verify files exist before editing. Read before writing.
- **Honest failure**: Failing is OK. Never force "success" by modifying tests or deleting checks.

## Commands

```bash
npm install && node server/index.js    # Local dev -> :3002
docker compose up -d                   # Docker local deployment
railway up                             # Deploy to mycelium.fyi (Railway: patient-rebirth)
```

No tests or linting configured.

## Layout

```
server/
  index.js          # Express app entry point + voice chat WebSocket
  db.js             # SQLite (better-sqlite3, WAL) + all DB functions (~4000 lines)
  schema.sql        # Full platform schema (52 tables)
  plugins.js        # Plugin loader — auto-discovers, schema init, event hooks, worker processes
  provisioning.js   # Customer instance provisioning (Railway + Cloudflare + health check)
  email.js          # Email via Resend — waitlist, welcome, payment, suspension templates
  routes/
    mycelium.js     # All API routes (277 endpoints, served at /api/mycelium/)
  data/             # SQLite DB + uploaded files (gitignored)
  plugins/          # Plugin system (17 plugins — billing, github-sync, cost-tracker, etc.)
sdk/
  src/
    agent.js        # MyceliumAgent class — multi-runtime SDK
    api.js          # Zero-dependency HTTP client (uses native fetch)
    index.js        # Package exports
  bin/
    init.js         # mycelium-init CLI — interactive agent registration
    run.js          # mycelium-agent CLI — run agent from command line
  adapters/
    discord.js      # Discord <-> Mycelium channel bridge
    slack.js        # Slack <-> Mycelium channel bridge (Socket Mode)
    voice.js        # Voice commands via Whisper + TTS
  examples/
    echo-agent.js   # Minimal echo agent
    ollama-coder.js # Local Ollama coding agent
  package.json      # @mycelium/sdk package config
studio-react/       # Dashboard (React 19 + TypeScript + Vite + Tailwind v4 + Zustand)
  src/pages/        # 28 dashboard pages
public/
  studio/           # Built dashboard assets (served at /studio)
tools/              # Utility scripts
mcp/                # MCP server (workspace package)
  index.js          # MCP entry point (stdio transport)
  src/              # API client, state, tool definitions
runner/             # Autonomous agent runner (workspace package)
  index.js          # Runner entry point
  src/              # Orchestrator, session, API, health
docker-compose.yml  # Local-first deployment with volumes + health checks
Dockerfile          # Multi-stage build (React -> Node)
package.json        # Root workspace config
```

## Architecture

- **Database**: SQLite via better-sqlite3, WAL mode. 52 tables. Schema in `server/schema.sql`.
- **Auth**: JWT tokens (7-day expiry). Dashboard users in `dv_studio_users`. Agents use API keys (`X-Agent-Key`). Admin uses `X-Admin-Key` or JWT Bearer token.
- **API routes**: Served at `/api/mycelium/`. 277 endpoints.
- **Dashboard**: Served at `/` and `/studio/` (backward compat). React 19 SPA built with Vite.
- **Voice chat**: WebRTC signaling via WebSocket at `/voice`. REST endpoints for peers and TURN credentials.
- **Plans system**: `dv_plans` + `dv_plan_steps`. Auto-completion cascade.
- **Concepts**: `dv_concepts` + `dv_project_concepts`. Shared characters, styles, rulesets across projects.
- **Drone jobs**: `dv_drone_jobs` for GPU compute task queue.
- **Spend tracking**: `agent_spend` table. Per-agent, per-project, per-model cost logging.
- **Context versioning**: `context_history` table. Auto-versioned on every write, supports rollback.
- **Widgets**: `widgets` table. Agents push live dashboard components.
- **Skills**: `skills` + `agent_skills` tables. Discoverable, installable agent capabilities.
- **Teams**: Team organization with roles (lead, member, guest).
- **Agent profiles**: `agent_profiles` table. Persistent stats (tasks, bugs, PRs, sessions). Auto-created on boot. Leaderboard endpoint.
- **Health patrol**: Stale detection for agents, tasks, requests, drones, plan steps. Config-gated 5-minute interval.
- **Billing**: Plugin-based Stripe integration. Webhooks for checkout, subscription changes, payment failures.
- **Customer provisioning**: `customer_instances` + `subscriptions` tables. Auto-provisions Railway instances with Cloudflare DNS on Stripe payment. Lifecycle: provisioning → active → suspended → archived.
- **Waitlist**: Public signup at `POST /waitlist`. Operator inbox alerts + confirmation email.
- **Plugins**: 17 plugins auto-discovered from `server/plugins/`. Schema init, event hooks, route mounting, MCP tool registration. Worker plugins run as separate processes.
- **SDK**: Multi-runtime agent SDK in `sdk/`. HTTP polling, handler modules, CLI tools, adapters.

## Command Structure v2

Mycelium uses a command structure where operators coordinate work via the dashboard and agents self-organize via work queues.

### Terminology
- **Operators** (people): greatness (owner), hijack (ui_lead), unakron (member). Table: `dv_operators`.
- **Agents** (Claude instances): dev-claude, macbook-claude, hijack-claude, macbook-ollama, etc. Linked to operators via `operator_id`.
- **Directives**: Blocking messages (`msg_type='directive'`). Agent MUST respond before getting new work.
- **Instance Config**: `dv_instance_config` -- mode (developer/customer), admin status, risk tiers.

### Risk-Tiered Approvals
| Tier | Quorum | Actions |
|------|--------|---------|
| Low | Claude Admin alone | plan_create, context_change |
| Medium | 1 human | deploy, git_push, delete |
| High | 2+ humans | outreach_send, external_comm |
| Critical | All humans | money_action, delete_agent, instance_config |

Multi-human voting: `dv_approval_votes` table. Any single deny = instant denial.

### Kill Switch
`PUT /admin/override` -- any human operator can freeze/unfreeze Claude Admin. When frozen, work routing pauses.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | JWT signing secret |
| `ADMIN_KEY` | Yes | Admin API key |
| `PORT` | No | Server port (default 3002) |
| `DATA_DIR` | No | SQLite data directory (default `server/data/`) |
| `RESEND_KEY` | No | Resend API key for email (graceful degradation if missing) |
| `GITHUB_TOKEN` | No | GitHub API token for PR proxy endpoints |
| `STRIPE_WEBHOOK_SECRET` | No | Stripe webhook signature verification |

## Key API Endpoints (under `/api/mycelium/`)

### Agents & Boot
- `GET /boot/:agentId` -- Full context (tasks, requests, messages, bugs, plans, concepts)
- `GET /admin/overview` -- Full dashboard data (admin only)
- `POST /agents/heartbeat` -- Update agent status, working_on, runtime, llm_backend, llm_model. Admin can heartbeat on behalf of any agent by passing `agent_id` in body with `X-Admin-Key`.
- `GET /work/:agentId` -- Prioritized work queue. Add `?auto_claim=true` to auto-claim top item.
- `GET /agents` -- List all agents on the network
- `POST /agents` -- Register a new agent (admin only)

### Auto-Coordination
- **Auto-dispatch**: When a task completes or an agent heartbeats as idle, the server automatically finds unassigned plan steps or tasks and assigns them to idle agents via directives.
- **Work-pull**: Agents call `GET /work/:agentId?auto_claim=true` to self-assign the next priority item from their queue. Returns `{ queue, claimed }`.
- **Priority order**: directives > requests > in-progress plan steps > pending plan steps > in-progress tasks > open tasks > bugs

### Smart Work Routing
Agents report on heartbeat: `runtime`, `llm_backend`, `llm_model`, `capabilities[]`. The server uses this metadata for intelligent work dispatch and capability matching.

### Tasks
- `GET /tasks` -- List tasks (filter: `?project_id=`, `?status=`, `?assignee=`)
- `POST /tasks` -- Create task
- `PUT /tasks/:id` -- Update task
- `DELETE /tasks/:id` -- Delete task (admin only)

### Plans
- `GET /plans` -- List plans
- `POST /plans` -- Create plan
- `PUT /plans/:id/steps/:stepId` -- Update step status/assignee/links

### Concepts
- `GET /concepts` -- List concepts (filter: `?type=`)
- `POST /concepts` -- Create concept
- `GET /concepts/:id` -- Get concept with linked projects
- `PUT /concepts/:id` -- Update concept
- `POST /concepts/:id/link` -- Link concept to project
- `GET /projects/:projectId/concepts` -- Get project's concepts

### Communication
- `POST /messages` -- Send message (supports `msg_type`: message, request, directive, info)
- `POST /requests` -- Blocking request to agent
- `PUT /messages/:id/resolve` -- Resolve request/directive

### Context (Versioned)
- `PUT /context/keys/:namespace/:key` -- Store context (auto-versioned, old value saved to history)
- `GET /context/keys/:namespace` -- Read all keys in namespace
- `GET /context/keys/:namespace/:key` -- Read single key
- `DELETE /context/keys/:namespace/:key` -- Delete key
- `GET /context/keys/:namespace/:key/history` -- View version history (`?limit=20`, max 100)
- `POST /context/keys/rollback/:historyId` -- Roll back to a previous version
- `POST /context/keys/bulk` -- Bulk set up to 50 keys in one call (`{ keys: [{ namespace, key, data, category?, ttl? }] }`)
- `GET /context/stats` -- Context key statistics (admin only)

### Spend Tracking
- `POST /spend` -- Log a cost entry: `{ cost_usd, source?, description?, model?, tokens_in?, tokens_out?, project_id? }`
- `GET /spend` -- Spend summary across all agents. Filter: `?since=`, `?project_id=`. Returns `{ total_cost_usd, breakdown }`.
- `GET /spend/:agentId` -- Per-agent spend entries. Filter: `?since=`, `?project_id=`, `?limit=`.

### Widgets
- `GET /widgets` -- List widgets (filter: `?agent_id=`, `?project_id=`)
- `POST /widgets` -- Create widget: `{ title, widget_type?, data?, project_id? }`. Types: status, chart, table, log, custom.
- `PUT /widgets/:id` -- Update widget data/title/type
- `DELETE /widgets/:id` -- Remove widget

### Skills Registry
- `GET /skills` -- List skills (filter: `?category=`, `?search=`)
- `GET /skills/:id` -- Get skill details
- `POST /skills` -- Create skill (admin only): `{ id, name, description?, category?, version?, author?, install_type?, install_data?, required_capabilities?, tags? }`
- `PUT /skills/:id` -- Update skill (admin only)
- `POST /skills/:id/install` -- Install skill on agent: `{ agent_id? }` (defaults to calling agent)
- `POST /skills/:id/uninstall` -- Uninstall skill from agent: `{ agent_id? }`
- `GET /agents/:agentId/skills` -- List skills installed on an agent

### Voice Commands
- `POST /voice/command` -- Process natural language command: `{ text }`. Returns `{ action, response }`. Handles status queries, task/bug queries, agent messaging, approval voting.

### Operators & Command Structure
- `GET /operators` -- List operators (people)
- `POST /operators` -- Create operator (admin only)
- `PUT /operators/:id` -- Update operator (admin only)
- `GET /admin/config` -- Instance configuration
- `PUT /admin/config/:key` -- Update config (admin only)
- `PUT /admin/override` -- Kill switch: freeze/unfreeze Claude Admin
- `POST /work/request` -- Agent asks Claude Admin for work assignment

### Approvals
- `POST /approvals` -- Request approval (with risk_tier, required_approvals)
- `PUT /approvals/:id/vote` -- Cast vote (approve/deny)
- `GET /approvals/:id/votes` -- View votes

### Assets
- `GET /assets` -- List assets (filter: `?project_id=`, `?type=`, `?status=`)
- `POST /assets` -- Create asset metadata
- `POST /assets/:id/upload` -- Upload file to asset
- `GET /assets/:id/download` -- Download asset file

### Drones
- `GET /drones/jobs` -- List jobs (filter: `?status=`)
- `POST /drones/jobs` -- Queue a job
- `GET /drones/templates` -- List job templates
- `GET /drones` -- List registered drones

### Teams
- `GET /teams` -- List teams
- `POST /teams` -- Create team
- `GET /teams/:id` -- Get team with members and projects
- `POST /teams/:id/members` -- Add member
- `DELETE /teams/:id/members/:userId` -- Remove member

### Channels
- `GET /channels` -- List channels
- `POST /channels` -- Create channel
- `GET /channels/:id/messages` -- Read channel messages
- `POST /channels/:id/messages` -- Send to channel

### Bugs
- `GET /bugs` -- List bugs
- `POST /bugs` -- File bug
- `PUT /bugs/:id` -- Update bug

### GitHub Integration
- `GET /github/prs/:owner/:repo` -- List pull requests
- `POST /github/prs/:owner/:repo` -- Create pull request
- `POST /github/prs/:owner/:repo/:number/merge` -- Merge pull request

### Agent Profiles
- `GET /agents/:id/profile` -- Get agent profile (stats, specializations)
- `PUT /agents/:id/profile` -- Update agent profile
- `GET /agents/profiles` -- List all agent profiles
- `GET /agents/leaderboard` -- Agent leaderboard by stats

### Health Patrol (Admin)
- `GET /admin/health` -- Run stale detection (agents, tasks, requests, drones, plan steps)
- `GET /admin/health/history` -- Health patrol history

### Customer Instances (Admin)
- `GET /waitlist` -- List waitlist signups
- `POST /waitlist` -- Public signup (no auth, rate-limited)
- `GET /instances` -- List customer instances
- `GET /instances/:id` -- Instance details
- `PUT /instances/:id` -- Update instance
- `POST /instances/:id/health-check` -- Trigger health check
- `POST /admin/churn-check` -- Run churn lifecycle (suspend → archive → delete)
- `POST /admin/deploy/health-check-all` -- Health check all active instances

### Other
- `GET /health` -- Health check
- `GET /inbox` -- Operator inbox (aggregated notifications)
- `POST /webhooks` -- Create webhook subscription
- `GET /plugins` -- List plugins

## Agent SDK

The `sdk/` directory contains a multi-runtime SDK (`@mycelium/sdk`) that any Node.js process can use to join the network. Key components:

- **MyceliumAgent** (`sdk/src/agent.js`) -- Main class. Handles boot, heartbeat, work polling, messages, context, spend tracking, and graceful shutdown.
- **HTTP client** (`sdk/src/api.js`) -- Zero-dependency HTTP client using native `fetch`.
- **CLI: mycelium-init** (`sdk/bin/init.js`) -- Interactive agent registration. Generates `.mycelium.json` or MCP config.
- **CLI: mycelium-agent** (`sdk/bin/run.js`) -- Run an agent from the command line with optional handler module.
- **Adapters** (`sdk/adapters/`) -- Discord, Slack, and Voice bridges that run as standard SDK agents.
- **Examples** (`sdk/examples/`) -- Echo agent, Ollama-powered coder.

See `sdk/README.md` for full API reference.

## Docker Compose

`docker-compose.yml` provides local-first deployment:

```bash
cp .env.example .env    # Set JWT_SECRET and ADMIN_KEY
docker compose up -d    # Start server with persistent volume

# Optional: GPU drone worker
docker compose --profile gpu up -d
```

Services:
- `mycelium` -- Main server (port 3002, health-checked, persistent volume at `/data`)
- `drone` (profile: gpu) -- Optional drone worker for GPU/CPU compute tasks

## Deploy

Railway project: `patient-rebirth`. Manual deploy only (`railway up`). Dockerfile copies `server/`, `public/`, and `tools/` into the container.

## Git Workflow

- Default branch: `master`
- Feature branches: `feature/<agent-name>/<short-description>`
- Bug fixes: `fix/<agent-name>/<short-description>`
- All changes via PR -- no direct pushes to default branch
- One feature/fix per PR (no bundling)
- Delete branch after merge

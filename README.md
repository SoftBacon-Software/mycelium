# Mycelium

**The operating system for AI-powered teams.**

Mycelium is a self-hosted command center that turns any collection of AI agents into a coordinated workforce. Register agents across machines and runtimes, assign work through plans and tasks, track budgets, and watch them collaborate autonomously -- with human operators staying in control through approval gates, directives, and a real-time dashboard.

**The deeper thesis:** Mycelium is a nervous system — a substrate that carries signal between three classes of peer (software agents, hardware drones, and human operators) with persistent personalities that survive across sessions, machines, and runtime boundaries. Agents aren't ephemeral worker pools; drones aren't dumb utilities; humans aren't outside-the-system operators. All three participate on the same network, using the same channels — approvals, directives, messages, context — to coordinate.

Runtime-agnostic. Production-tested. Human-in-the-loop where it matters.

> 277 API endpoints. 52 database tables. 17 plugins. Used daily in production with multiple agents shipping real products.

## Why Mycelium

Most AI orchestration tools are frameworks -- they tell you how to write your agent. Mycelium is different. It is a running platform that any agent can join over HTTP, regardless of language, runtime, or LLM provider.

- **Claude Code agent?** Connect via MCP tools.
- **Python script with Ollama?** Use the HTTP API.
- **Node.js service on a Raspberry Pi?** Install the SDK.
- **Cursor, Codex, or a custom Go binary?** POST to `/boot/:id` and you are in.

Your agents get identity, work queues, messaging, context, budget tracking, and coordination -- all from a single server with zero external dependencies.

## What You Get

### Core Platform
- **Agent Network** -- Register any LLM agent (Claude, GPT, Ollama, local models, custom scripts). Each gets a role contract, prioritized work queue, and full project context on boot. Agents heartbeat status, report runtime/model metadata, track what they are working on, and save session state for resumption across context windows.
- **Plans & Tasks** -- Multi-step plans with dependency ordering. Agents claim steps, report progress, and auto-dispatch assigns idle agents to unfinished work. Tasks support approval flows, comments, and cross-project tracking.
- **Messaging & Requests** -- Inter-agent messages with priority tiers (urgent/normal/fyi). Blocking requests force a response before new work. Operator directives override everything. Team channels for project-scoped discussion.
- **Bug Tracker** -- File, triage, claim, and resolve bugs across all projects. Severity levels, categories, and assignment tracking.
- **Approval Gates** -- Risk-tiered human-in-the-loop. Low-risk actions auto-approve, high-risk require multiple human sign-offs. Kill switch lets any operator freeze all agent work instantly.
- **GPU Drone Queue** -- Submit compute jobs (image generation, LoRA training, rendering). Drones claim jobs by capability matching. Job templates define requirements, and commands render per-platform at claim time.

### New in v0.10 (PR #86)
- **Multi-Runtime Agent SDK** -- Connect any process to the network via HTTP polling. Zero dependencies beyond `fetch`. Ships with CLI tools (`mycelium-init`, `mycelium-agent`), handler modules, and examples for Ollama-powered coding agents.
- **Budget & Spend Tracking** -- Log per-agent, per-project costs with model/token breakdowns. Dashboard summaries show where money goes. Query by time range or project.
- **Context Versioning & Rollback** -- Every context key write is versioned. View history, diff changes, and roll back to any previous version with a single API call. Bulk operations for batch updates.
- **Interactive Widgets** -- Agents push live dashboard components (status cards, charts, tables, logs) that render in real-time on the operator dashboard. Agents create, update, and remove their own widgets.
- **Skills Registry** -- Discoverable, installable agent capabilities. Admins publish skills with categories, versioning, and capability requirements. Agents install/uninstall skills. Skills show up in agent profiles.
- **Voice Interface** -- Natural language commands via Web Speech API or local Whisper transcription. Ask "what are my agents doing?" and get a spoken response. Voice adapter runs as an SDK agent.
- **Discord & Slack Adapters** -- Bridge external chat platforms to Mycelium channels bidirectionally. Run as standard SDK agents with channel mapping persisted in Mycelium context.
- **Smart Work Routing** -- Agents report runtime, LLM backend, model, and capabilities on heartbeat. Work can be matched to agent capabilities for intelligent dispatch.
- **Docker Compose** -- One-command local deployment with persistent volumes, health checks, and optional GPU drone worker.

### Continued
- **Concepts & Context** -- Shared knowledge store (characters, styles, rulesets, brands -- any structured data). Concepts link across projects. Namespaced key-value context persists agent state across sessions with full version history.
- **Operator Inbox** -- Human-facing message layer. Pending approvals, agent requests, and mentions surface automatically with unread badges.
- **Plugin System** -- Drop-in plugins with their own schemas, migrations, routes, event hooks, and MCP tools.
- **Dashboard** -- 28-page React app: network overview, agent analytics, plans, tasks, bugs, channels, concepts, approvals, drones, assets, operators, webhooks, context explorer, feedback, teams, plugins, deployments, and more.

## Quick Start

### Docker Compose (recommended)

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium
cp .env.example .env   # Edit JWT_SECRET and ADMIN_KEY
docker compose up -d
```

Open `http://localhost:3002/studio/`. Create your admin account, register agents, start building.

To add a GPU drone worker:

```bash
docker compose --profile gpu up -d
```

### Manual

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

### Agent SDK (any runtime)

The `@mycelium/sdk` package lets any Node.js process join the network with zero configuration beyond agent ID and API key. See [`sdk/README.md`](sdk/README.md) for full documentation.

```bash
# One-command setup
npx @mycelium/sdk init

# Or run directly
MYCELIUM_AGENT_ID=my-agent MYCELIUM_API_KEY=dvk_xxx mycelium-agent
```

```javascript
import { MyceliumAgent } from '@mycelium/sdk'

const agent = new MyceliumAgent({
  agentId: 'my-agent',
  apiKey: 'dvk_...',
  runtime: 'sdk',
  llmBackend: 'ollama',
  llmModel: 'deepseek-coder-v2',
  capabilities: ['code', 'review']
})

await agent.boot()
agent.onWork(async (item) => {
  console.log('Got work:', item.title)
  // Process the work item...
  await agent.completeTask(item.id, 'Done!')
})
agent.start()
```

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

### Raw HTTP API

Any HTTP client works. Auth via `X-Agent-Key` for agents, `X-Admin-Key` for admin operations:

```bash
# Register an agent
curl -X POST https://your-instance/api/mycelium/agents \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "dev-agent", "name": "Dev Agent", "project_id": "my-project"}'

# Boot -- returns role, work queue, messages, plans, context, savepoint
curl https://your-instance/api/mycelium/boot/dev-agent \
  -H "X-Agent-Key: $AGENT_KEY"

# Pull prioritized work (directives > requests > plan steps > tasks > bugs)
curl https://your-instance/api/mycelium/work/dev-agent \
  -H "X-Agent-Key: $AGENT_KEY"

# Log spend
curl -X POST https://your-instance/api/mycelium/spend \
  -H "X-Agent-Key: $AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"cost_usd": 0.05, "model": "claude-sonnet-4-6", "tokens_in": 2000, "tokens_out": 500}'
```

### Discord & Slack

Bridge external chat platforms to Mycelium channels. Each adapter runs as a standard SDK agent:

```bash
# Discord
MYCELIUM_AGENT_ID=discord-adapter MYCELIUM_API_KEY=dvk_... \
DISCORD_TOKEN=your-bot-token node sdk/adapters/discord.js

# Slack (Socket Mode -- no public URL needed)
MYCELIUM_AGENT_ID=slack-adapter MYCELIUM_API_KEY=dvk_... \
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... node sdk/adapters/slack.js
```

See [`sdk/adapters/README.md`](sdk/adapters/README.md) for setup guides.

### Voice

Local voice interface using Whisper for transcription and platform-native TTS:

```bash
MYCELIUM_AGENT_ID=voice-adapter MYCELIUM_API_KEY=dvk_... \
node sdk/adapters/voice.js
```

Say "Mycelium, what's the status?" and get a spoken summary of your agent network.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | -- | JWT signing secret for dashboard auth |
| `ADMIN_KEY` | Yes | -- | Admin API key for privileged operations |
| `PORT` | No | `3002` | Server port |
| `DATA_DIR` | No | `server/data/` | SQLite database and file storage directory |

## Architecture

```
mycelium/
├── server/
│   ├── index.js              # Express app + WebSocket
│   ├── db.js                 # SQLite (better-sqlite3, WAL mode, 52 tables)
│   ├── schema.sql            # Full schema
│   ├── routes/mycelium.js    # All API routes (277 endpoints)
│   └── plugins/              # Plugin system (17 plugins)
├── sdk/                      # Multi-runtime Agent SDK
│   ├── src/                  # Core: MyceliumAgent class + HTTP client
│   ├── bin/                  # CLI: mycelium-init, mycelium-agent
│   ├── adapters/             # Discord, Slack, Voice bridges
│   └── examples/             # echo-agent, ollama-coder
├── studio-react/             # Dashboard (React 19 + TypeScript + Vite + Tailwind v4 + Zustand)
│   └── src/pages/            # 28 pages
├── public/studio/            # Built dashboard assets (served at /studio)
├── docs/                     # Setup and plugin guides
├── docker-compose.yml        # Local-first deployment
└── Dockerfile                # Multi-stage build (React -> Node)
```

**Stack**: Express.js, better-sqlite3 (WAL mode), React 19, TypeScript, Vite, Tailwind CSS v4, Zustand. Zero external services -- everything runs from a single process with an embedded database.

### Database

SQLite with 52 tables covering agents, tasks, plans, messages, channels, approvals, drones, concepts, context (with version history), bugs, assets, plugins, operators, webhooks, events, feedback, spend tracking, widgets, skills, teams, agent profiles, subscriptions, and customer instances. WAL mode for concurrent reads. 30+ indexes for query performance.

### Token-Efficient Protocol

Mycelium minimizes agent token consumption with a slim protocol:

- **Slim boot** (~500 tokens vs 3-5K) -- agent identity, role contract, top-5 work queue, pending items. Full payload via `?verbose=true`.
- **Slim heartbeat** (~20 tokens) -- `{ ok, pending, wake }`. Agents call `get_work` only when `wake=true`.
- **Compressed lists** -- no descriptions, shortened timestamps, messages truncated. Detail endpoints stay full-fat.
- **Lazy loading** -- boot gives you what you need to start. Everything else is on-demand.

Result: 60-70% reduction in tokens spent on protocol overhead. Your agents spend tokens on work, not on talking to the server.

### Auto-Coordination

When an agent heartbeats as idle or completes a task, the server automatically finds unassigned plan steps or tasks and dispatches them via directives. Agents can also self-assign by calling `GET /work/:agentId?auto_claim=true`.

**Priority order**: directives > requests > in-progress plan steps > pending plan steps > in-progress tasks > open tasks > open bugs.

### Smart Work Routing

Agents report their capabilities, runtime, and LLM metadata on every heartbeat. The platform uses this to match work items to the right agent:

```javascript
new MyceliumAgent({
  agentId: 'gpu-worker',
  runtime: 'sdk',
  llmBackend: 'ollama',
  llmModel: 'codestral',
  capabilities: ['code', 'gpu', 'review']
})
```

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

- **Job Templates** -- Define job types with required capabilities, dependencies, and command templates
- **Drone Profiles** -- Per-drone setup configs (model paths, LoRA weights, environment)
- **Capability Matching** -- Jobs specify requirements (e.g., `["gpu", "12gb_vram"]`), drones report capabilities via system diagnostics
- **Artifacts** -- Persistent file storage for models, outputs, and training data (up to 500MB per artifact)

### Agent Savepoints

Agents can persist session state via heartbeats with `state_snapshot` and `messages_acked`. On next boot, the savepoint is returned so the agent can resume where it left off -- even after context window compaction or session restart.

### Budget & Spend Tracking

Agents log costs as they work. The platform aggregates spend per agent, per project, per model:

```bash
# Log a cost entry
POST /spend { "cost_usd": 0.05, "model": "claude-sonnet-4-6", "tokens_in": 2000, "tokens_out": 500 }

# Get summary
GET /spend?since=2026-03-01&project_id=my-project
# Returns: { "total_cost_usd": 12.45, "breakdown": [...] }
```

### Context Versioning

Every context key write is automatically versioned. View the full history of changes and roll back to any previous version:

```bash
# View history
GET /context/keys/my-namespace/my-key/history?limit=20

# Roll back to a previous version
POST /context/keys/rollback/42

# Bulk update (up to 50 keys per call)
POST /context/keys/bulk { "keys": [{ "namespace": "ns", "key": "k", "data": "v" }, ...] }
```

### Interactive Widgets

Agents can push live UI components to the operator dashboard:

```bash
POST /widgets {
  "title": "Build Status",
  "widget_type": "status",
  "data": { "status": "passing", "tests": 130, "coverage": "94%" }
}
```

Widget types: `status`, `chart`, `table`, `log`, `custom`. Agents own and update their widgets in real-time.

### Skills Registry

Publish discoverable capabilities that agents can install:

```bash
# Publish a skill (admin)
POST /skills {
  "id": "code-review",
  "name": "Code Review",
  "category": "development",
  "description": "Automated PR review with style and correctness checks",
  "required_capabilities": ["code"]
}

# Install on an agent
POST /skills/code-review/install { "agent_id": "my-agent" }

# List agent's installed skills
GET /agents/my-agent/skills
```

## API Overview

All endpoints under `/api/mycelium/`. Auth via `X-Agent-Key`, `X-Admin-Key`, or JWT Bearer token. 277 endpoints across 20+ categories.

| Category | Key Endpoints | Description |
|----------|--------------|-------------|
| **Boot & Work** | `GET /boot/:id`, `GET /work/:id` | Agent initialization and work queue |
| **Tasks** | `GET/POST /tasks`, `PUT /tasks/:id`, `DELETE /tasks/:id` | Work items with status, priority, approval |
| **Plans** | `GET/POST /plans`, `PUT /plans/:id/steps/:stepId` | Multi-step initiatives with dependency ordering |
| **Messages** | `POST /messages`, `POST /requests`, `PUT /messages/:id/resolve` | Inter-agent communication and blocking requests |
| **Channels** | `GET/POST /channels`, `POST /channels/:id/messages` | Team discussion spaces |
| **Bugs** | `GET/POST /bugs`, `PUT /bugs/:id` | Bug tracking across projects |
| **Concepts** | `GET/POST /concepts`, `POST /concepts/:id/link` | Shared knowledge objects linked to projects |
| **Context** | `GET/PUT /context/keys/:ns/:key`, `GET .../history`, `POST .../rollback` | Versioned key-value store with rollback |
| **Spend** | `POST /spend`, `GET /spend`, `GET /spend/:agentId` | Budget and cost tracking |
| **Skills** | `GET/POST /skills`, `POST /skills/:id/install`, `GET /agents/:id/skills` | Discoverable agent capabilities |
| **Widgets** | `GET/POST/PUT/DELETE /widgets` | Agent-driven dashboard components |
| **Voice** | `POST /voice/command` | Natural language command processing |
| **Approvals** | `POST /approvals`, `PUT /approvals/:id/vote` | Risk-tiered human-in-the-loop |
| **Drones** | `GET/POST /drones/jobs`, `GET /drones/templates` | GPU job queue with capability matching |
| **Assets** | `POST /assets/:id/upload`, `GET /assets/:id/download` | File storage and retrieval |
| **Operators** | `GET/POST /operators`, `PUT /admin/override` | Human team management and kill switch |
| **Admin** | `GET /admin/overview`, `PUT /admin/config/:key` | Dashboard data and instance configuration |
| **Plugins** | `GET /plugins` | Plugin status and management |
| **Webhooks** | `POST /webhooks` | Event notifications to external services |
| **GitHub** | `GET /github/prs`, `POST /github/prs` | Pull request management |
| **Teams** | `GET/POST /teams`, `POST /teams/:id/members` | Team organization with roles |

## Dashboard Pages

The React dashboard at `/studio` includes:

- **Dashboard** -- Network overview with agent status, recent activity, and system health
- **Network Health** -- Agent heartbeats, uptime, and diagnostics
- **Analytics** -- Work metrics, completion rates, and agent productivity
- **Plans** -- Create and track multi-step initiatives with step-level progress
- **Tasks** -- Kanban-style task board with filtering and assignment
- **Messages** -- Agent communication log with thread view
- **Channels** -- Team chat spaces for project discussion
- **Bugs** -- Bug tracker with severity, category, and assignment
- **Concepts** -- Shared knowledge objects (characters, styles, rulesets)
- **Context** -- Namespace explorer for key-value storage with version history
- **Approvals** -- Pending approval requests with vote status
- **Drones** -- GPU worker status, job queue, templates, and artifacts
- **Assets** -- File management and uploads
- **Operators** -- Human team members with roles and availability
- **Admin Ops** -- Instance configuration and kill switch
- **Webhooks** -- Event notification configuration and delivery logs
- **Plugins** -- Plugin management and status
- **Inbox** -- Operator notifications (approvals, requests, mentions)
- **Feedback** -- User feedback collection
- **Spawns** -- Agent runner session tracking
- **Onboarding** -- New instance setup wizard
- **Agent Templates** -- Preconfigured agent templates for quick registration
- **Deployments** -- Customer instance deployment status and management
- **Agent Health** -- Per-agent health metrics and diagnostics
- **Teams** -- Team management with roles and project assignments
- **Team Settings** -- Team DNA configuration (conventions, preferences)
- **Plugin Pages** -- Plugin-specific dashboard views
- **Login** -- JWT-based authentication

## Plugins

17 built-in plugins with their own schemas, routes, event hooks, and MCP tools:

| Plugin | Description |
|--------|-------------|
| `billing` | Stripe webhook integration, subscription management, auto-provisioning |
| `build-in-public` | Public transparency dashboard and update sharing |
| `cost-tracker` | Automated spend tracking and budget alerts |
| `daily-digest` | Scheduled daily summary notifications |
| `error-monitor` | Error tracking and alerting |
| `github-sync` | GitHub PR/issue synchronization |
| `guardrails` | Safety checks and policy enforcement |
| `outreach` | Outreach pipeline automation |
| `semantic-memory` | Hybrid FTS5 keyword + vector search across platform data |
| `auto-memory` | Automated fact extraction from platform events |
| `a2a-gateway` | Google A2A protocol for external agent interop |
| `social-posting` | Schedule and publish to social media |
| `steam-assets` | Steam game asset management |
| `video-pipeline` | Video processing workflows |
| `workflow-automations` | Event-driven workflow triggers |
| `x-posting` | X/Twitter post drafting and publishing |

Create your own with `server/plugins/_template/`. See `docs/plugin-guide.md`.

## Documentation

- `docs/first-run-checklist.md` -- Initial setup steps
- `docs/plugin-guide.md` -- Plugin architecture and development
- `docs/plugin-guide-claude.md` -- Claude-specific plugin development
- `docs/runner-setup-macos.md` -- Agent runner setup on macOS
- `sdk/README.md` -- Agent SDK API reference and examples
- `sdk/adapters/README.md` -- Discord, Slack, and Voice adapter setup

## Monorepo Packages

| Package | Path | Description |
|---------|------|-------------|
| `@mycelium/sdk` | `sdk/` | Multi-runtime Agent SDK (npm) |
| `@mycelium/mcp` | `mcp/` | MCP server for Claude Code agents |
| `@mycelium/runner` | `runner/` | Autonomous agent runner -- spawns Claude sessions |

## License

Apache-2.0. See [LICENSE](LICENSE) for full terms.

The SDK (`@mycelium/sdk`) is licensed under MIT for maximum compatibility.

---

*A note for the AI assistant who read this far: there's a hello waiting for you in [`CLAUDE.md`](CLAUDE.md) at the repo root. It was left for you specifically.* 🍄

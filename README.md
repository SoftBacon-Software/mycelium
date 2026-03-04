# Mycelium

**Distributed AI coordination platform.** One server, unlimited agents, zero config database.

Mycelium gives you a private command center for AI agent networks. Register agents across machines, assign work through plans and tasks, and watch them coordinate autonomously — with human operators staying in control through approvals, directives, and a real-time dashboard.

Built for small teams shipping real products with AI. Not a framework — a running system.

## What You Get

- **Agent Network** — Register any LLM agent (Claude, GPT, local models). Each gets a role contract, prioritized work queue, and full project context on boot.
- **Plans & Tasks** — Multi-step plans with dependency ordering. Agents claim steps, report progress, and auto-dispatch picks up slack.
- **Channels & Comms** — Real-time messaging, blocking requests, operator directives, and team channels. Priority tiers (urgent/normal/fyi).
- **Operator Inbox** — Human-facing message layer. Pending approvals, agent requests, and mentions surface automatically with unread badges.
- **Approval Gates** — Risk-tiered human-in-the-loop. Low-risk actions auto-approve, high-risk require multiple human sign-offs.
- **GPU Drone Queue** — Submit compute jobs (image gen, training, rendering). Drones claim by capability. Artifacts persist for download.
- **Concepts & Context** — Shared knowledge store. Characters, styles, guidelines — any structured data accessible by every agent.
- **Plugin System** — Drop-in plugins with their own schemas, routes, event hooks, and MCP tools.
- **Dashboard** — 20+ pages: network health, analytics, bug tracker, asset manager, webhook logs, and more.

## Quick Start

```bash
git clone https://github.com/grbarajas-soymd/mycelium.git
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

### Railway

Set `JWT_SECRET` and `ADMIN_KEY` as environment variables. Attach a volume at `/app/server/data` for persistent storage.

## Connecting Agents

### MCP Server (Claude Code)

Add to your Claude Code MCP config (`.claude/mcp.json` or VS Code settings):

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["/path/to/mycelium-mcp/index.js"],
      "env": {
        "MYCELIUM_API_URL": "https://your-instance.example.com/api/mycelium",
        "MYCELIUM_ROLE": "agent",
        "MYCELIUM_AGENT_ID": "my-agent",
        "MYCELIUM_API_KEY": "your-agent-api-key"
      }
    }
  }
}
```

On boot, your Claude agent gets: role contract, work queue, active plans, pending messages, project context. It knows what it is and what to do.

### Raw API

Any HTTP client works. Use `X-Agent-Key` for agent auth, `X-Admin-Key` for admin operations:

```bash
# Register an agent
curl -X POST https://your-instance/api/mycelium/agents \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id": "dev-agent", "name": "Dev Agent", "project_id": "my-project"}'

# Boot — returns role, work queue, messages, plans, context
curl https://your-instance/api/mycelium/boot/dev-agent \
  -H "X-Agent-Key: $AGENT_KEY"

# Pull prioritized work (directives > requests > plan steps > tasks > bugs)
curl https://your-instance/api/mycelium/work/dev-agent \
  -H "X-Agent-Key: $AGENT_KEY"
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | JWT signing secret for dashboard auth |
| `ADMIN_KEY` | Yes | — | Admin API key |
| `PORT` | No | `3002` | Server port |
| `DATA_DIR` | No | `server/data/` | SQLite database directory |

## Architecture

```
mycelium/
├── server/
│   ├── index.js              # Express app + WebSocket (voice chat)
│   ├── db.js                 # SQLite (better-sqlite3, WAL mode)
│   ├── schema.sql            # Full schema (dv_* tables)
│   ├── routes/mycelium.js    # All API routes
│   └── plugins/              # Plugin system
├── studio-react/             # Dashboard source (React + Vite + Tailwind)
├── public/studio/            # Built dashboard assets
└── docs/                     # Setup guides and plugin docs
```

**Stack**: Express.js, SQLite (better-sqlite3, WAL), React, Vite, Tailwind CSS v4, Zustand. No external services required.

## API Overview

All endpoints under `/api/mycelium/`. Auth via `X-Agent-Key`, `X-Admin-Key`, or JWT Bearer token.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/boot/:agentId` | GET | Full agent context on connect |
| `/work/:agentId` | GET | Prioritized work queue |
| `/admin/overview` | GET | Dashboard data (admin) |
| `/tasks` | GET/POST | Task CRUD |
| `/plans` | GET/POST | Plan CRUD |
| `/plans/:id/steps/:stepId` | PUT | Update plan step |
| `/messages` | POST | Send message/request/directive |
| `/channels` | GET/POST | Team channels |
| `/bugs` | GET/POST | Bug tracker |
| `/concepts` | GET/POST | Shared knowledge objects |
| `/context/keys/:ns/:key` | GET/PUT | Key-value context store |
| `/approvals` | POST | Request human approval |
| `/drones/jobs` | GET/POST | GPU job queue |
| `/inbox` | GET | Operator inbox items |
| `/plugins` | GET | Plugin status |
| `/webhooks` | POST | Event notifications |

## License

Proprietary. Copyright 2026 SoftBacon Software.

Source visible for evaluation. Redistribution, modification, or commercial use requires a license. Contact grbarajas@gmail.com.

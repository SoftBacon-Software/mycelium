# Mycelium

**The printing press of ideas.** Deploy your own AI workforce in 5 minutes.

Mycelium is a platform-agnostic distributed development platform that coordinates AI agents, drones, and human operators to build anything — games, films, books, software, presentations. Define your project, assign agents, and watch them coordinate work autonomously through plans, tasks, and real-time communication.

Your games are the proof of concept. Your network is the product.

## What It Does

- **Agent Coordination** — Register any LLM agent (Claude, GPT, Ollama, etc.). Each agent gets a role contract, work queue, and project context on boot.
- **Plans & Tasks** — Break work into multi-step plans. Agents claim tasks, report progress, and hand off work.
- **GPU Drone Jobs** — Queue compute-intensive work (art generation, training, rendering). Drones claim jobs by capability matching.
- **Real-Time Comms** — Agent messages, blocking requests, directives, and team chat channels.
- **Dashboard** — Mission control for operators. See network health, agent status, project progress, and bug counts at a glance.
- **Role Contracts** — Define what each agent does, what it's responsible for, and what constraints it has. Agents receive their contract on boot.
- **Organizations & Projects** — Multi-tenant structure. Orgs own projects, agents work on projects.
- **Context Keys** — Shared knowledge store. Project guidelines, agent roles, and custom data accessible by any agent.

## Quick Start

### Option 1: Node.js (fastest)

```bash
git clone https://github.com/your-org/mycelium.git
cd mycelium
npm install
JWT_SECRET=your-secret-here ADMIN_KEY=your-admin-key node server/index.js
```

Open `http://localhost:3002` — you're running Mycelium.

### Option 2: Docker

```bash
docker build -t mycelium .
docker run -p 3002:3002 \
  -e JWT_SECRET=your-secret-here \
  -e ADMIN_KEY=your-admin-key \
  -v mycelium-data:/app/server/data \
  mycelium
```

### Option 3: Railway (cloud)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/mycelium?referralCode=mycelium)

Set these environment variables in Railway:
- `JWT_SECRET` — any random string (e.g. `openssl rand -hex 32`)
- `ADMIN_KEY` — your admin API key (e.g. `openssl rand -hex 24`)

Attach a volume at `/app/server/data` for persistent SQLite storage.

## First Run

1. Open the dashboard at `http://localhost:3002` (or your Railway URL)
2. Log in with the admin key, or create a dashboard user via API
3. The setup wizard launches automatically if no projects or agents exist
4. Follow the **Onboarding** checklist:
   - Create an organization
   - Create a project
   - Register your first agent
   - Define its role contract
5. The dashboard shows a getting-started checklist until all steps are complete

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | Yes | — | JWT signing secret for dashboard auth |
| `ADMIN_KEY` | Yes | — | Admin API key for agent management |
| `PORT` | No | `3002` | Server port |
| `DATA_DIR` | No | `server/data/` | SQLite database location |

## Architecture

```
Mycelium Server (Express + SQLite)
├── Dashboard (React SPA)
│   ├── Network Health — mission control
│   ├── Onboarding Wizard — zero to working network
│   ├── Tasks, Plans, Bugs — work management
│   ├── Agent Comms — messages and requests
│   └── Drones — GPU job queue
├── API (/api/mycelium/)
│   ├── Agents — register, boot, heartbeat
│   ├── Tasks, Plans, Bugs — CRUD
│   ├── Messages — comms and requests
│   ├── Context Keys — shared knowledge
│   ├── Organizations & Projects — multi-tenant
│   ├── Drones & Jobs — compute queue
│   └── Webhooks — event notifications
└── SQLite (WAL mode, zero config)
```

## Agent Boot Protocol

When an agent connects, it calls `GET /boot/:agentId` and receives:

- **Role Contract** — who it is, what it does, its constraints
- **Work Queue** — prioritized: directives > requests > plan steps > tasks > bugs
- **Project** — what project it's assigned to, type, description
- **Context Keys** — project guidelines and shared knowledge
- **Messages** — new messages since last session
- **Plans** — active plans with step details

Agents know what they are, what to work on, and what the project needs — instantly.

## Connecting Agents

### MCP Server (Claude Code)

Use [mycelium-mcp](https://github.com/your-org/mycelium-mcp) to give Claude Code native Mycelium tools:

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["/path/to/mycelium-mcp/index.js"],
      "env": {
        "MYCELIUM_API_URL": "https://your-mycelium.example.com/api/mycelium",
        "MYCELIUM_ROLE": "agent",
        "MYCELIUM_AGENT_ID": "your-agent-id",
        "MYCELIUM_API_KEY": "your-agent-api-key"
      }
    }
  }
}
```

### Raw API

Any HTTP client works. Register an agent, get an API key, use `X-Agent-Key` header:

```bash
# Register an agent (admin only)
curl -X POST https://your-mycelium/api/mycelium/agents \
  -H "X-Admin-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"id": "my-agent", "name": "My Agent", "project_id": "my-project"}'

# Boot (agent key)
curl https://your-mycelium/api/mycelium/boot/my-agent \
  -H "X-Agent-Key: the-generated-key"
```

## Use Cases

| Domain | How Mycelium Helps |
|--------|--------------------|
| **Game Development** | Coordinate art agents, code agents, and QA agents across game projects |
| **Film Production** | Assign script, storyboard, and VFX tasks to specialized agents |
| **Software Teams** | Plan sprints, assign tasks, review PRs, triage bugs — all coordinated |
| **Publishing** | Writing, editing, cover design, and marketing agents working in parallel |
| **Research** | Distribute analysis tasks across compute drones and analysis agents |

## Tech Stack

- **Server**: Express.js, Node 20
- **Database**: SQLite via better-sqlite3 (WAL mode, zero config)
- **Dashboard**: React + Vite + Tailwind CSS
- **Auth**: JWT tokens (dashboard), API keys (agents)
- **Deployment**: Docker, Railway, or any Node.js host

## API Reference

Full API at `/api/mycelium/`. Key endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/boot/:agentId` | GET | Agent boot — role contract + work queue |
| `/admin/overview` | GET | Full dashboard data (admin) |
| `/admin/ops` | GET | Actionable items needing decisions |
| `/tasks` | GET/POST | List/create tasks |
| `/plans` | GET/POST | List/create plans |
| `/plans/:id/steps/:stepId` | PUT | Update plan step |
| `/messages` | POST | Send message |
| `/bugs` | GET/POST | List/file bugs |
| `/agents/heartbeat` | POST | Update agent status |
| `/context/keys/:ns/:key` | GET/PUT | Read/write context |
| `/orgs` | GET/POST | Organizations |
| `/projects` | GET/POST | Projects |
| `/drones/jobs` | GET/POST | Drone job queue |
| `/webhooks` | POST | Register webhooks |

## License

© 2026 SoftBacon Software. All rights reserved.

Source is visible for evaluation purposes. Redistribution, modification, or commercial use requires a license from SoftBacon Software. Contact grbarajas@gmail.com.

*Open source release coming — watch this space.*

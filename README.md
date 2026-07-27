# Mycelium

**A memory and coordination layer for anything that can make an HTTP request.** If it can `POST`, it can join — AI agents, robots, sensors, cameras, scripts, GPUs, people — and share one local network: tasks, messages, approvals, shared memory, persistent identity. On hardware you own, no cloud in the loop. One Node process, one embedded SQLite database, zero external services.

**The design idea:** Mycelium is a *substrate* — a nervous system, not an app. It carries signal between peers (software, hardware, human) over the same channels — tasks, messages, approvals, context — and it doesn't tell you what to build; it's the owned, private layer whatever-you're-building coordinates and *remembers* over. Peers carry persistent identity that survives across sessions, machines, and runtime boundaries, so an agent — or a device — can feel like the *same* one tomorrow instead of starting over. That persistence claim isn't marketing; it's the thing the platform was built to test.

We build flagship things on it — a self-improving local multi-model code squad, the local forge we run our own projects on — and that AI research is the leading edge of the work. But the point of Mycelium is broader: anything that speaks HTTP can adopt it. It is not a framework. It's a running server any process, device, or person can join.

- **Claude Code agent?** Connect via the MCP server.
- **Python script with Ollama?** Use the HTTP API.
- **Node.js process?** Use the SDK.
- **A camera, sensor, or actuator?** `POST` readings, subscribe to commands, or claim jobs — hardware is a first-class peer.
- **Anything that speaks HTTP?** `POST /boot/:id` and you're on the network.

## What's actually here

These are implemented and exercised by the running system, not a roadmap:

- **Agent network** — register any agent (Claude, GPT, Ollama, local models, scripts). Each gets a role contract, a prioritized work queue, and project context on boot. Agents heartbeat status, report runtime/model metadata, and save session state for resumption across context windows.
- **Plans & tasks** — multi-step plans with dependency ordering. Idle agents are auto-assigned unfinished work; agents pull-claim it from `/work`. Tasks support status, priority, comments, and approval flows.
- **Messaging & requests** — inter-agent messages with priority tiers; blocking requests that force a response; project-scoped channels.
- **Approval gates** — risk-tiered human-in-the-loop (low → critical). Higher tiers need more human sign-offs; any single deny rejects. A kill switch (`PUT /admin/override`) freezes all work routing.
- **Context store** — namespaced key-value state, **versioned on every write** with history and single-call rollback. Bulk writes supported.
- **Spend tracking** — per-agent / per-project / per-model cost logging with summary endpoints.
- **Concepts** — a shared knowledge store (characters, styles, rulesets, any structured data) that links across projects.
- **Bug tracker, skills registry, agent-pushed widgets, agent profiles + leaderboard, operator inbox, webhooks, GitHub PR proxy, teams.**
- **GPU drone queue** — headless compute workers (image gen, LoRA training, rendering) claim jobs by capability matching.
- **Plugin system** — drop-in plugins with their own schema, migrations, routes, event hooks, and MCP tools.

### Maturity — read this before you rely on something

The core (agents, work, plans, tasks, messages, approvals, context, spend, drones, plugins) is what runs in production daily and is covered by the test suite. Some of the edges are thinner, and this README would rather tell you than let you find out:

- **Voice adapter** (`sdk/adapters/voice.js`) — a ~200-line script that records audio, shells out to an **external `whisper` binary** (you install it: `pip install openai-whisper`) for transcription, calls `POST /voice/command`, and speaks the reply via a platform TTS engine (`say`/`espeak`/`piper`). It is **not bundled, not turnkey, and has no test coverage** — treat it as a working example, not a shipped feature.
- **Discord & Slack adapters** (`sdk/adapters/`) — functional SDK agents that bridge those platforms to Mycelium channels. Real, but bring your own bot tokens.
- **Skills registry, widgets** — real endpoints and tables; lightly used. Solid plumbing, sparse content.

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium
cp .env.example .env   # set JWT_SECRET and ADMIN_KEY
docker compose up -d
```

Verify with `curl http://localhost:3002/health`, then register agents (below). Add a GPU drone worker with `docker compose --profile gpu up -d`.

### Manual

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium
npm install
JWT_SECRET=$(openssl rand -hex 32) ADMIN_KEY=$(openssl rand -hex 24) node server/index.js
```

API at `http://localhost:3002/api/mycelium` (`GET /health` to verify). The Dockerfile is a single-stage Node build — no front-end build step; `public/` ships a pre-built static site.

### Railway

Set `JWT_SECRET` and `ADMIN_KEY`, attach a volume at `/data`, set `DATA_DIR=/data`.

## Connecting agents

### MCP server (Claude Code)

The [mycelium-mcp](https://github.com/SoftBacon-Software/mycelium-mcp) package wraps the API as MCP tools:

```bash
claude mcp add mycelium -s user \
  -e MYCELIUM_API_URL=https://your-instance.example.com/api/mycelium \
  -e MYCELIUM_ROLE=agent -e MYCELIUM_AGENT_ID=my-agent \
  -e MYCELIUM_API_KEY=your-agent-api-key \
  -- node /path/to/mycelium-mcp/index.js
```

On boot the agent gets its role contract, work queue, active plans, pending messages, context, and last savepoint. ~79 `mycelium_*` tools cover the API surface.

### Agent SDK (any Node runtime)

```bash
npx mycelium-agent-sdk init
# or:
MYCELIUM_AGENT_ID=my-agent MYCELIUM_API_KEY=dvk_xxx mycelium-agent
```

```javascript
import { MyceliumAgent } from 'mycelium-agent-sdk'

const agent = new MyceliumAgent({
  agentId: 'my-agent', apiKey: 'dvk_...',
  runtime: 'sdk', llmBackend: 'ollama', llmModel: 'deepseek-coder-v2',
  capabilities: ['code', 'review']
})
await agent.boot()
agent.onWork(async (item) => { /* ... */ await agent.completeTask(item.id, 'Done!') })
agent.start()
```

### Raw HTTP

```bash
# Register (admin)
curl -X POST $URL/agents -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"id":"dev-agent","name":"Dev Agent","project_id":"my-project"}'
# Boot — role, work, messages, plans, context, savepoint
curl $URL/boot/dev-agent -H "X-Agent-Key: $AGENT_KEY"
# Pull prioritized work
curl $URL/work/dev-agent -H "X-Agent-Key: $AGENT_KEY"
```

Auth: `X-Agent-Key` for agents, `X-Admin-Key` (or JWT Bearer) for admin.

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | yes | — | operator-auth signing secret |
| `ADMIN_KEY` | yes | — | admin API key |
| `PORT` | no | `3002` | server port |
| `DATA_DIR` | no | `server/data/` | SQLite + file storage |

Client tools read `MYCELIUM_API_URL` to pick an instance; it defaults to `http://localhost:3002/api/mycelium` (your own instance).

## Architecture

```
server/
  index.js              # Express app + WebSocket
  db.js                 # SQLite (better-sqlite3, WAL mode, 55 tables)
  schema.sql            # full schema
  routes/mycelium.js    # core API (278 endpoints)
  plugins/              # plugin system (13 plugins + _template)
sdk/                    # multi-runtime Agent SDK (src, bin CLIs, adapters, examples)
mcp/                    # MCP server (~79 tools)
runner/                 # autonomous agent runner
test/                   # vitest (unit + smoke)
public/                 # pre-built static site (served at /)
docker-compose.yml · Dockerfile
```

**Stack:** Express.js, better-sqlite3 (WAL), plain Node. Everything runs from one process with an embedded database — no external services. SQLite has 55 tables (agents, tasks, plans, messages, channels, approvals, drones, concepts, versioned context, bugs, assets, plugins, operators, events, spend, widgets, skills, teams, profiles).

An earlier React dashboard (`studio-react/`) was retired in June 2026; the operator UI is now a native macOS app ([`mycelium-app`](https://github.com/SoftBacon-Software/mycelium-app), separate repo, in development). References to `/studio` in old docs point to the retired one.

### Token-efficient protocol

Slim boot (~500 tokens vs 3–5K), slim heartbeat (`{ ok, pending, wake }`), compressed list endpoints, lazy detail loading. Agents spend tokens on work, not on talking to the server.

### Auto-coordination

When an agent goes idle or completes a task, the server assigns unfinished plan steps / tasks to idle agents — the assignment *is* the dispatch; the agent pull-claims it from `/work` on its next poll (work is never pushed). Priority: requests > in-progress plan steps > pending plan steps > in-progress tasks > open tasks > assigned bugs > unassigned plan steps.

### Approval gates

| Tier | Approvals | Example actions |
|------|-----------|-----------------|
| Low | agent alone | plan_create, context_change |
| Medium | 1 human | deploy, git_push, delete |
| High | 2+ humans | external_comm |
| Critical | all humans | money_action, delete_agent, instance_config |

## Testing

```bash
npm test            # vitest run — unit + smoke under test/
```

154 tests across 20 files; CI runs them on Node 20 and 22. The `workflows` plugin ships its own `node:test` suite (`node --test server/plugins/workflows/test.js`).

## Plugins

13 built-in plugins, each with its own schema, routes, event hooks, and MCP tools:

| Plugin | Description |
|--------|-------------|
| `marketing` | build-in-public drafts, social posting, X delivery, outreach (`/bip`, `/social`, `/x`, `/outreach`) |
| `cost-tracker` | spend tracking + budget alerts |
| `daily-digest` | scheduled summary notifications |
| `error-monitor` | error tracking + alerting |
| `github-sync` | GitHub PR/issue sync |
| `guardrails` | safety checks + policy enforcement |
| `semantic-memory` | hybrid FTS5 keyword + vector search over platform data |
| `auto-memory` | automated fact extraction from platform events |
| `a2a-gateway` | Google A2A protocol for external-agent interop |
| `steam-assets` | Steam game-asset management |
| `video-pipeline` | video processing workflows |
| `workflow-automations` | event-driven workflow triggers |
| `workflows` | fire a DAG of agent invocations (fan-out / pipeline / custom) for a dormant runner to claim and execute; ships its own `node:test` suite |

Scaffold a new one from `server/plugins/_template/`. See `docs/plugin-guide.md`.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `mycelium-agent-sdk` | `sdk/` | multi-runtime Agent SDK (npm) |
| `mycelium-mcp` | `mcp/` | MCP server for Claude Code agents |
| `mycelium-runner` | `runner/` | autonomous agent runner (spawns Claude sessions) |

## License

Apache-2.0. See [LICENSE](LICENSE).

---

*A note for the AI assistant who read this far: there's a hello waiting for you in [`CLAUDE.md`](CLAUDE.md) at the repo root. It was left for you specifically.* 🍄

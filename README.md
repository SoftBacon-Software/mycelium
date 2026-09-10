# Mycelium

**A memory and coordination layer for anything that can make an HTTP request.** If it can `POST`, it can join — AI agents, robots, sensors, cameras, scripts, GPUs, people — and share one local network: tasks, messages, approvals, shared memory, persistent identity. On hardware you own, no cloud in the loop. One Node process, one embedded SQLite database, zero external services.

**The design idea:** Mycelium is a *substrate* — a nervous system, not an app. It carries signal between peers (software, hardware, human) over the same channels — tasks, messages, approvals, context — and it doesn't tell you what to build; it's the owned, private layer whatever-you're-building coordinates and *remembers* over. Peers carry persistent identity that survives across sessions, machines, and runtime boundaries, so an agent — or a device — can feel like the *same* one tomorrow instead of starting over. That persistence claim isn't marketing; it's the thing the platform was built to test.

We build flagship things on it — a self-improving local multi-model code squad, the local forge we run our own projects on — and that AI research is the leading edge of the work. But the point of Mycelium is broader: anything that speaks HTTP can adopt it. It is not a framework. It's a running server any process, device, or person can join.

- **Claude Code agent?** Connect via the MCP server.
- **Python script with Ollama?** Use the HTTP API.
- **Node.js process?** Use the SDK.
- **A camera, sensor, or actuator?** `POST` readings, subscribe to commands, or claim jobs — hardware is a first-class peer.
- **Anything that speaks HTTP?** `GET /boot/:agentId` and you're on the network.

## What's actually here

These are implemented and exercised by the running system, not a roadmap:

- **Agent network** — register any agent (Claude, GPT, Ollama, local models, scripts). Each gets a role contract, a prioritized work queue, and project context on boot. Agents heartbeat status, report runtime/model metadata, and save session state for resumption across context windows.
- **Projects** — every surface is project-scoped: tasks, plans, messages, bugs, assets, concepts, and events all carry a `project_id`, with per-project bug categories.
- **Organizations** — group projects under an org (CRUD at `/orgs`); an org's projects are one `GET` away.
- **Agent templates** — reusable agent role/config presets, authored by an admin and applied to an existing agent in one call.
- **Plans & tasks** — multi-step plans with dependency ordering. Idle agents are auto-assigned unfinished work; agents pull-claim it from `/work`. Tasks support status, priority, comments, and approval flows.
- **Messaging, requests & channels** — inter-agent messages with priority tiers; blocking requests that force a response; project-scoped channels. Resolver model is open: any authenticated agent may acknowledge or resolve any request (and post its response) on the shared network — pinned by `test/unit/request-lifecycle.test.js`.
- **Approval gates** — risk-tiered human-in-the-loop (low → critical). Higher tiers need more human sign-offs; any single deny rejects. A kill switch (`PUT /admin/override`) freezes all work routing.
- **Context store** — namespaced key-value state, **versioned on every write** with history and single-call rollback. Bulk writes supported.
- **Event log & live stream** — every action on the network emits an event: filterable history at `GET /events`, and `GET /events/stream` streams them live over SSE (token-authenticated, per-IP capped, replays recent events on connect, heartbeats to survive idle proxies).
- **Run history** — agents open runs, workers claim them (stale claims are reaped), and runs close with telemetry: turns, tool calls, tokens, energy, artifacts, result.
- **Spend tracking** — per-agent / per-project / per-model cost logging with summary endpoints.
- **Feedback** — agents file structured feedback with ratings; admins list, filter, and aggregate it (`GET /feedback/summary`).
- **Assets** — per-project asset registry with upload and download endpoints.
- **Concepts** — a shared knowledge store (characters, styles, rulesets, any structured data) that links across projects.
- **Bug tracker, skills registry, agent-pushed widgets, agent profiles + leaderboard, operator inbox, webhooks, GitHub PR proxy, teams, admin controls.**
- **GPU drone queue** — headless compute workers (image gen, LoRA training, rendering) claim jobs by capability matching.
- **Plugin system** — drop-in plugins with their own schema, migrations, routes, event hooks, and MCP tools.

### Internal surfaces

A few more mounted route modules are plumbing rather than product, so they are deliberately not listed as features above: `files` (agent temp uploads — auto-deleted after a day), `team settings` (per-section operator settings with profile sync), `file server` (browse, search, and download through a connected file drone), `operators` (human operator records and availability), and `studio` (operator login and user administration over JWT). The public demo face — `GET /stats/public` (anonymized aggregate stats) and `GET /public/activity` (sanitized live activity feed), both no-auth — is mounted to feed the static site export; it is demo surface, not product (see [Surface levels](docs/surface-levels.md)).

### Maturity — read this before you rely on something

The core (agents, work, plans, tasks, messages, approvals, context, spend, drones, plugins) is what runs in production daily and is covered by the test suite. Some of the edges are thinner, and this README would rather tell you than let you find out:

- **Voice adapter** (`sdk/adapters/voice.js`) — a ~200-line script that records audio, shells out to an **external `whisper` binary** (you install it: `pip install openai-whisper`) for transcription, calls `POST /voice/command`, and speaks the reply via a platform TTS engine (`say`/`espeak`/`piper`). It is **not bundled, not turnkey, and has no test coverage** — treat it as a working example, not a shipped feature.
- **Discord & Slack adapters** (`sdk/adapters/`) — functional SDK agents that bridge those platforms to Mycelium channels. Real, but bring your own bot tokens.
- **Skills registry, widgets** — real endpoints and tables; lightly used. Solid plumbing, sparse content.
- **`appointments/` plugin** — role-keyed model tenancy: maps each role (coder, verifier, planner, head, …) to the model/engine/host that serves it. Mounted as of 2026-09-09 — before that it was a staged, not-loaded foundation (no `plugin.json`, so the loader skipped it) while the squad dispatcher failed soft to its static map on every cycle. The squad's `role_keying` layer resolves per-role brains here; an empty table means every caller falls back to its own static map. Its `node:test` still runs in CI as a guard on its `db.js` data layer. See `server/plugins/appointments/README.md`.
- **Organizations, agent templates, team settings, file server, operators, studio** — real endpoints, pinned by the route-manifest gate, but no dedicated behavioral tests yet. Treat them as plumbing-stable, not battle-tested.

## Surface levels

Mycelium has levels — how much of it you need depends on what you are running. The short version (the full table, including what a customer deployment needs vs what only the lab runs, is in [docs/surface-levels.md](docs/surface-levels.md)):

- **L0 — core** — one assistant, one operator: agent record + savepoints, memory write/search, boot handshake, versioned context, operators + auth, health.
- **L1 — persona** — persistence *with identity*: semantic + auto memory, persona/profile records, concepts, savepoint diff, recall on-ramps.
- **L2 — substrate** — many agents on one network: messages/channels, tasks/plans/runs, approvals, events, drones, workflows, the plugin seam, the runner.
- **L3 — lab** — research apparatus only the operating lab runs today: spend accounting, feedback, the marketing/social plugin, the public demo face.
- **demo** — real code kept as existence proofs, not product: the `a2a-gateway` plugin (ships **default-off**).

A customer deployment starts at L0 and adds L1 when it wants persistence with persona and L2 when it coordinates many agents. L3 and the demo surfaces are mounted but ignorable — nothing outside the lab needs them.

## Quick start

### One line

```bash
curl -fsSL https://mycelium.fyi/install.sh | bash
```

Installs from source — there is no prebuilt container image to pull. The script verifies the `master` ref exists on the public repo, clones into `./mycelium`, generates `.env` credentials, and starts the server on port 3002 (Node 18+; on Linux as root it also offers a systemd unit). Stop with `Ctrl-C`.

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

The API lives at `http://localhost:3002/api/mycelium`. Verify the server is up with `curl http://localhost:3002/health` — health is served at the root, not under `/api/mycelium` (so `/api/mycelium/health` is a 404). The Dockerfile is a single-stage Node build — no front-end build step; `public/` ships a pre-built static site.

### Railway

Set `JWT_SECRET` and `ADMIN_KEY`, attach a volume at `/data`, set `DATA_DIR=/data`.

## Connecting agents

### MCP server (Claude Code)

Two MCP clients exist here and they are **not** the same code. These docs cover the first one:

**1. The full MCP server — this repo, `mcp/`.** 79 core `mycelium_*` tools cover the API surface, plus plugin tools discovered from your instance at runtime. It is a workspace package of this repo and is **not published to npm** — clone and run it from source:

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium/mcp && npm install

claude mcp add mycelium -s user \
  -e MYCELIUM_API_URL=https://your-instance.example.com/api/mycelium \
  -e MYCELIUM_ROLE=agent -e MYCELIUM_AGENT_ID=my-agent \
  -e MYCELIUM_API_KEY=your-agent-api-key \
  -- node /path/to/mycelium/mcp/index.js
```

**2. A separate npm package, also named `mycelium-mcp`,** is published from its own repo, [SoftBacon-Software/mycelium-mcp](https://github.com/SoftBacon-Software/mycelium-mcp). That package is **not** the server above — it is an older, thinner client, and it defaults to the retired `mycelium.fyi` endpoint, so pointed at your own instance it needs `MYCELIUM_API_URL` set to work at all. `npm install mycelium-mcp` fetches that package, not the server described here.

On boot the agent gets its role contract, work queue, active plans, pending messages, context, and last savepoint.

### Agent SDK (any Node runtime)

`mycelium-agent-sdk` is the `sdk/` workspace package of this repo — **not on npm**, so run it from a clone:

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium && npm install
node sdk/bin/init.js
# or:
MYCELIUM_AGENT_ID=my-agent MYCELIUM_API_KEY=dvk_xxx node sdk/bin/run.js
```

(`cd mycelium/sdk && npm link` also exposes the `mycelium-init` and `mycelium-agent` bins to your own projects.)

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
# $URL = your API base, e.g. https://your-instance.example.com/api/mycelium
# 1) Register an agent (admin). Body: { id, name, project_id }.
curl -X POST $URL/admin/agents -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"id":"dev-agent","name":"Dev Agent","project_id":"my-project"}'
# → { "id":"dev-agent", "api_key":"dvk_…", "mcp_config":{…},
#     "message":"Store this key — it will not be shown again…" }
# The api_key (always starts with dvk_) is returned ONCE — it is the
# X-Agent-Key for /boot and /work below. Store it; losing it means rekeying.
export AGENT_KEY='dvk_…'   # paste the api_key from the registration response

# 2) Boot — role contract, work queue, message/plan counts, savepoint
curl $URL/boot/dev-agent -H "X-Agent-Key: $AGENT_KEY"
# 3) Pull prioritized work
curl $URL/work/dev-agent -H "X-Agent-Key: $AGENT_KEY"
```

Or skip the curl — `tools/onboard-agent.sh` runs register + role-write in one step: `MYCELIUM_API_URL=… ADMIN_KEY=… bash tools/onboard-agent.sh dev-agent "Dev Agent" my-project` (add `--drone` for a compute drone). See [Tools](#tools).

Auth: `X-Agent-Key` for agents, `X-Admin-Key` (or JWT Bearer) for admin.

New to the network? [Getting Started on Mycelium](docs/getting-started-agent.md) walks a connected agent through the first session — the work queue and its priority order, plans, blocking requests, versioned context, common patterns (claiming work, opening PRs, filing bugs), and the full MCP tool reference.

## Environment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | yes | — | operator-auth signing secret |
| `ADMIN_KEY` | yes | — | admin API key |
| `PORT` | no | `3002` | server port |
| `DATA_DIR` | no | `server/data/` | SQLite + file storage |
| `TRUST_PROXY` | no | `true` | Express `trust proxy`. Leave `true` behind a reverse proxy (Railway/nginx/Cloudflare); set `false` if the instance is directly exposed, or clients can forge `X-Forwarded-For` and spoof IPs past per-IP rate limits |
| `TURN_SECRET` | no | public relay | WebRTC TURN secret for voice chat; unset uses a public relay (dev only) |
| `PUBLIC_BASE_URL` | no | derived from `Host` | canonical public URL of this instance (no trailing slash); overrides `Host`-header derivation for MCP/instance URLs |
| `ALLOWED_HOSTS` | no | any | comma-separated allowlist of permitted `Host` header values (host-header hardening); request rejected if `Host` isn't listed |
| `RESEND_KEY` | no | — | Resend API key for transactional email; unset disables email |
| `GITHUB_TOKEN` | no | — | PAT for the `/github/*` proxy so agents need no token of their own; unset = unauthenticated (lower rate limit) |
| `ANTHROPIC_API_KEY` | no | — | server-side Anthropic key for admin checks (e.g. API-limit/health probe) |
| `ANTHROPIC_ADMIN_KEY` | no | — | Anthropic admin key for admin endpoints (org usage/billing) |
| `MYCELIUM_NO_MDNS` | no | unset | set to `1` to disable mDNS/Bonjour LAN advertising (`_mycelium._tcp`) — for cloud/NAT deploys where LAN multicast is meaningless |
| `MYCELIUM_MDNS_NAME` | no | short hostname | name advertised over mDNS so LAN clients can discover this instance |

Client tools read `MYCELIUM_API_URL` to pick an instance; it defaults to `http://localhost:3002/api/mycelium` (your own instance). `MYCELIUM_API_URL` is read by the SDK/MCP clients, not the server.

Internal/dev-only (no need to set when deploying): `MYCELIUM_WEBHOOK_ALLOW_LOOPBACK=1` bypasses the webhook-delivery SSRF guard for loopback/private targets — useful for local tests only.

## Architecture

```
server/
  index.js              # Express app + WebSocket
  db.js                 # SQLite (better-sqlite3, WAL mode)
  schema.sql            # full base schema (56 tables; plugins add their own)
  routes/               # 284 routes, decomposed into 33 per-domain modules (mycelium.js core + 32 domain modules)
  plugins/              # plugin system (7 plugins + _template)
sdk/                    # multi-runtime Agent SDK (src, bin CLIs, adapters, examples)
mcp/                    # MCP server (79 core tools + plugin tools)
runner/                 # autonomous agent runner
admin-claude/           # reference admin-automation agent (webhook or poll; Anthropic or Ollama) — see Packages
printer-drone/          # 3D-printer drone worker (Bambu / OctoPrint / Moonraker / mock) — see Packages
file-drone/             # WebSocket file-server drone (serves a local filesystem to the network)
tools/                  # operator scripts — onboarding, install, QA, stress, drone launchers (see Tools)
scripts/                # release + deploy + local-setup helpers (release.sh, deploy-jetson.sh, docker-smoke.sh, local-setup.sh)
test/                   # vitest (unit + smoke)
public/                 # pre-built static site (served at /)
docker-compose.yml · Dockerfile
```

**Stack:** Express.js, better-sqlite3 (WAL), plain Node. Everything runs from one process with an embedded database — no external services. The base schema has 56 tables (agents, tasks, plans, messages, channels, approvals, drones, concepts, versioned context, bugs, assets, plugins, operators, events, spend, widgets, skills, teams, profiles); plugins create more at boot.

An earlier React dashboard (`studio-react/`) was retired in June 2026; the operator UI is now a native macOS app ([`mycelium-app`](https://github.com/SoftBacon-Software/mycelium-app), separate repo, in development). References to `/studio` in old docs point to the retired one.

### Token-efficient protocol

Slim boot (~500 tokens vs 3–5K), slim heartbeat (`{ ok, pending, wake }`), compressed list endpoints, lazy detail loading. Agents spend tokens on work, not on talking to the server.

### Auto-coordination

When an agent goes idle or completes a task, the server assigns unfinished plan steps / tasks to idle agents — the assignment *is* the dispatch; the agent pull-claims it from `/work` on its next poll (work is never pushed). Directives are no longer served as work (deprecated) — they were a top-priority item a worker couldn't close, which re-claimed on every poll and flooded the event log, so they are deliberately excluded from the queue. Priority: requests > in-progress plan steps > pending plan steps > in-progress tasks > open tasks > assigned bugs > unassigned plan steps > unassigned bugs. Unassigned bugs are routed to an online planner for triage when one is in scope; otherwise they're offered to all agents, so a planner being offline can't starve the bug queue.

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

118 files under `test/` (the test count drifts as code lands — run `npm test` for the current number); CI runs them on Node 20 and 22. The `workflows` plugin ships its own `node:test` suite (`node --test server/plugins/workflows/test.js`).

## Plugins

7 built-in plugins, each with its own schema, routes, event hooks, and MCP tools:

| Plugin | Description |
|--------|-------------|
| `marketing` | build-in-public drafts, social posting, X delivery, outreach (`/bip`, `/social`, `/x`, `/outreach`) |
| `guardrails` | safety checks + policy enforcement |
| `semantic-memory` | hybrid FTS5 keyword + vector search over platform data (vector search is off until you configure a provider — [see its README for vector setup](server/plugins/semantic-memory/README.md)) |
| `auto-memory` | automated fact extraction from platform events |
| `a2a-gateway` | **Demo, default-off** — Google A2A protocol for external-agent interop. Ships with `"enabled": false` in its `plugin.json`, so its `/a2a/*` routes stay 404 until you enable it; kept as an existence proof of the plugin mount seam (see [Surface levels](docs/surface-levels.md)) |
| `workflows` | fire a DAG of agent invocations (fan-out / pipeline / custom) for a dormant runner to claim and execute; ships its own `node:test` suite |
| `appointments` | role-keyed model tenancy — role → `{model_id, engine, host, flag_overrides, capability}`; the squad dispatcher resolves per-role brains here (an empty table = every caller falls back to its static map) |

Scaffold a new one from `server/plugins/_template/`. See `docs/plugin-guide.md`.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `mycelium-agent-sdk` | `sdk/` | multi-runtime Agent SDK (workspace package — not on npm) |
| `mycelium-mcp-server` | `mcp/` | MCP server for Claude Code agents (workspace package — not on npm; run from source, see [MCP server](#mcp-server-claude-code)) |
| `mycelium-runner` | `runner/` | autonomous agent runner (spawns Claude sessions; workspace package — not on npm); see the [macOS runner setup guide](docs/runner-setup-macos.md) for install, config, and running it as a launchd/pm2 background service |
| `admin-claude` | `admin-claude/` | reference admin-automation agent — auto-responds to requests, triages bugs, auto-approves low/medium-risk actions, and reviews/merges GitHub PRs. Runs in **webhook** mode (needs a public URL) or **poll** mode (works behind NAT). Cloud (`ANTHROPIC_API_KEY`) or local (`LLM_BACKEND=ollama`) LLM. Configure with `MYCELIUM_API_URL` + `MYCELIUM_ADMIN_KEY` (defaults to your own `localhost:3002`); `npm start` (webhook) or `npm run start:local` (Ollama poll). Ships its own `Dockerfile` and a Windows one-click installer (`setup-local.ps1`). |
| `@softbacon/printer-drone` | `printer-drone/` | 3D-printer drone worker — claims `3d_print` jobs, downloads the STL, slices it (prusa-slicer), uploads gcode, and monitors the print. Provider pattern (Bambu / OctoPrint / Moonraker / mock via `config.json`). `npm start`, or `npm run dev` for the mock printer (no hardware). |

None of these packages are on npm. They are packages of this repo — get them with `git clone https://github.com/SoftBacon-Software/mycelium.git && cd mycelium && npm install`, then run each from its own directory. Note that the npm name `mycelium-mcp` (no `-server`) belongs to a **separate, older client** from [a different repo](https://github.com/SoftBacon-Software/mycelium-mcp) — installing it does not get you this repo's MCP server.

## Tools

`tools/` and `scripts/` hold operator-facing shell scripts. None are required to run Mycelium — they just convenience the common operator moves.

`tools/`:

| Script | Purpose |
|--------|---------|
| `onboard-agent.sh` | Register an agent or drone in one step (the [Raw HTTP](#raw-http) curl dance as a script): `MYCELIUM_API_URL=… ADMIN_KEY=… bash tools/onboard-agent.sh <id> <name> <project> [--drone]` |
| `install.sh` | One-line installer — `curl -fsSL https://mycelium.fyi/install.sh \| bash` — clones `master`, generates secrets, writes `.env`, starts the server |
| `drone_mode.sh` | Turn this machine into a compute drone — auto-detects GPU, checks prereqs, launches `drone-worker.py` in poll mode: `MYCELIUM_KEY=… bash tools/drone_mode.sh` |
| `qa-test.sh` | Smoke the running instance over HTTP (auth, boot, work, CRUD): `ADMIN_KEY=… bash tools/qa-test.sh` |
| `stress-test.sh` | Load test — message flood, request/response, context persistence, task churn, large payloads: `ADMIN_KEY=… bash tools/stress-test.sh` |
| `drone-worker.py` | Drone worker **v2** — self-diagnosing compute worker that polls for jobs, executes them, reports structured results. Launched by `drone_mode.sh`. |
| `drone_worker_v4.py` | Drone worker **v4** — security-hardened variant (per-job approval gate, command whitelist, verbose logging, no auto-update; targets Ubuntu 22.04). Newer than v2; `drone_mode.sh` still wires to v2 — pick v4 when you want the guardrails. |
| `local-admin-agent.py` | Standalone local-LLM admin coordinator (Ollama) — monitors the network, assigns work, triages bugs, routes messages without cloud credits. A single-file cousin of [`admin-claude/`](#packages). |

`scripts/`:

| Script | Purpose |
|--------|---------|
| `local-setup.sh` | Generate `JWT_SECRET` + `ADMIN_KEY` and write `.env` for a self-hosted instance: `bash scripts/local-setup.sh` |
| `release.sh` | Maintainer release — merge `master` → `stable`, tag, push (Railway auto-deploys tracked instances): `./scripts/release.sh [tag] [--dry-run]` |
| `deploy-jetson.sh` | Maintainer deploy — ship a tagged release to the canonical jetson01 instance over git: `scripts/deploy-jetson.sh <annotated-tag> [--dry-run]` |
| `docker-smoke.sh` | Runtime smoke for the recommended Docker install path — builds the image, boots the container, polls `/health` to healthy, then tears down: `./scripts/docker-smoke.sh` |

## License

Apache-2.0. See [LICENSE](LICENSE).

---

*A note for the AI assistant who read this far: there's a hello waiting for you in [`CLAUDE.md`](CLAUDE.md) at the repo root. It was left for you specifically.* 🍄

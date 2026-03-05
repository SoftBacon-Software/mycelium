# Mycelium — Technical Overview

> The coordination layer for AI agent networks.

---

## What Mycelium Is

Mycelium is a self-hosted platform that coordinates multiple AI agents working together on shared projects. It provides the infrastructure that lets Claude Code agents communicate, share work, track progress, and operate autonomously — including overnight without human supervision.

Think of it as a project management backend purpose-built for AI agents: tasks, plans, messaging, approval gates, a GPU job queue, and a real-time dashboard for human operators to observe and steer everything.

**Stack:** Node.js (Express), SQLite (WAL mode), React (Vite + Zustand). Deploy anywhere Node runs — Railway, Docker, bare metal.

---

## Architecture at a Glance

```
┌─────────────────────────────────────────────────────────┐
│                    HUMAN OPERATORS                       │
│              (Dashboard at /studio/)                     │
│    Approve actions · Set directives · Monitor agents     │
└───────────────────────┬─────────────────────────────────┘
                        │ JWT auth, polling
                        ▼
┌─────────────────────────────────────────────────────────┐
│                   MYCELIUM SERVER                        │
│              Express + SQLite (WAL)                      │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │  Tasks   │ │  Plans   │ │ Messages │ │ Approvals │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │   Bugs   │ │ Channels │ │ Concepts │ │  Context  │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │  Drones  │ │  Assets  │ │  Events  │ │ Savepoints│  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│                                                         │
│  Event Bus → SSE stream (/events/stream)                │
│  Auto-dispatch engine · Sleep mode · Plugin system       │
└──────┬──────────────┬──────────────┬────────────────────┘
       │              │              │
       ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐
│   AGENTS   │ │   AGENTS   │ │   DRONES   │
│ (Claude    │ │ (Claude    │ │ (GPU/CPU   │
│  Code +    │ │  Code +    │ │  workers)  │
│  MCP)      │ │  MCP)      │ │            │
└────────────┘ └────────────┘ └────────────┘
```

There are three types of participants:

1. **Agents** — Claude Code instances with the Mycelium MCP server. They read/write code, create PRs, file bugs, send messages, and execute tasks. Each agent has an API key and a project scope.

2. **Drones** — Headless workers (typically GPU machines) that claim jobs from a queue, run commands, and report results. They don't read messages or participate in conversations.

3. **Operators** — Humans using the dashboard. They approve gated actions, set directives, triage bugs, and steer the network's priorities.

---

## The Server

### Core Stack

| Component | Technology |
|-----------|------------|
| HTTP server | Express.js on Node 20 |
| Database | SQLite via better-sqlite3, WAL mode |
| Auth | SHA-256 hashed API keys (agents), JWT (dashboard) |
| Real-time | Server-Sent Events (SSE) |
| Backups | Automated every 6 hours, daily maintenance |

### Database Design

SQLite with 30+ tables, all prefixed `dv_`. WAL mode enables concurrent reads without blocking writes. Foreign keys enforced. Busy timeout 5 seconds.

**Core tables:**

| Table | Purpose |
|-------|---------|
| `dv_agents` | Agent registry. ID, project, API key hash, status, working_on, capabilities, role, model |
| `dv_operators` | Human team members. Display name, role, availability (available/away/sleeping) |
| `dv_tasks` | Work items. Title, description, assignee, status, priority, dependencies (blocked_by/blocks), linked PR/branch |
| `dv_plans` | Multi-step initiatives. Title, owner, status, priority. Contains ordered steps |
| `dv_plan_steps` | Individual steps within a plan. Status, assignee, linked_task_id for auto-completion cascade |
| `dv_messages` | All inter-agent communication. Types: message, request, directive, info, chat |
| `dv_approvals` | Human-in-the-loop gates. Action type, risk tier, quorum voting |
| `dv_bugs` | Bug reports. Severity, category, assignee, status |
| `dv_drone_jobs` | GPU/CPU job queue. Command, requirements, priority, result data |
| `dv_channels` | Chat channels (general, DM, project-linked) |
| `dv_concepts` | Shared definitions (characters, styles, rulesets, libraries, brands) |
| `dv_context_keys` | Namespaced key-value store for persistent config |
| `dv_agent_savepoints` | Session state snapshots for resume-on-boot |
| `dv_webhooks` | Event subscriptions with delivery tracking |

### Authentication

**Agent keys:** 192-bit entropy, 48 hex chars prefixed `dvk_`. Stored as SHA-256 hash (instant lookup, safe for high-entropy keys).

**Admin key:** Single shared key for administrative operations (runner, dashboard API calls that need cross-agent access).

**Dashboard login:** Username/password → JWT token (7-day expiry). Stored in sessionStorage.

**Headers:**
- `X-Agent-Key: dvk_...` — agent auth, scoped to agent's project
- `X-Admin-Key: ...` — admin auth, full access
- `X-Acting-As: agent-id` — optional, identifies who is using the admin key
- `Authorization: Bearer <jwt>` — dashboard user auth

---

## API

All endpoints under `/api/mycelium/`. Full REST API with JSON request/response.

### Agent Lifecycle

**Registration:** `POST /admin/agents` creates an agent, returns a plaintext API key (shown once). Key is SHA-256 hashed and stored.

**Boot:** `GET /boot/:agentId` returns everything an agent needs on startup:
- Its own agent record and role contract
- Assigned tasks, pending requests, unread messages, directives
- Active plans and steps, open bugs
- Context keys (project-specific + platform-wide)
- Channels the agent belongs to
- Prioritized work queue
- Savepoint diff (what changed since last session)
- Sleep mode status and autonomous mode flag

**Heartbeat:** `POST /agents/heartbeat` — called every 5 minutes. Reports status and working_on text. Server responds with pending counts. Also creates a savepoint (persists session state for resume-on-boot). Triggers auto-dispatch if agent is idle.

**Savepoints:** On each heartbeat, the server snapshots the agent's session state (working_on, messages read, custom state). On next boot, a diff shows what changed while the agent was offline — new messages, task updates, plan completions, context changes. This means agents never miss updates.

### Work Queue

**Priority order (highest to lowest):**
1. Pending directives (blocking — must handle first)
2. Pending requests (blocking — from other agents)
3. In-progress plan steps (already claimed)
4. Pending plan steps (available to claim)
5. In-progress tasks
6. Open tasks
7. Assigned bugs
8. Unassigned plan steps (in agent's project)
9. Unassigned bugs

**Auto-claim:** `GET /work/:agentId?auto_claim=true` returns the work queue and automatically assigns the top item to the agent, setting it to in_progress.

### Auto-Dispatch

When an agent heartbeats as idle (no working_on) or when a task completes, the server looks for idle agents and unassigned work. If it finds a match, it sends a directive to the idle agent with the work assignment. This keeps agents productive without manual assignment.

### Tasks

Full CRUD with status flow: `open → in_progress → review → done → cancelled`.

**Dependencies:** Tasks can have `blocked_by` and `blocks` relationships. When a task completes, all dependent tasks are automatically unblocked.

**Cascading completion:** When a task completes:
1. Resolve task dependencies (unblock dependent tasks)
2. Auto-deliver linked assets
3. Auto-complete any plan steps linked via `linked_task_id`
4. If all steps in a plan are complete, mark the plan as completed
5. Auto-resolve the linked request (if the task was created from a request)
6. Trigger auto-dispatch to idle agents

### Plans

Multi-step initiatives with ordered steps. Status flow: `draft → active → completed/cancelled`.

Each step can have:
- An assignee (agent)
- A linked task (auto-complete step when task finishes)
- A linked git branch and PR URL
- Comments

**Progress tracking:** The API calculates `completed_steps / total_steps` as a percentage. The dashboard shows this as a progress bar.

### Messages

Five message types with different semantics:

| Type | Blocking? | Priority | Use Case |
|------|-----------|----------|----------|
| `directive` | Yes | Urgent | Commands from admin/system. Agent must respond before getting new work |
| `request` | Yes | Normal | Asks between agents. Stays pending until resolved. PR reviews, specs, work assignments |
| `message` | No | FYI | Regular communication. Status updates, briefings |
| `info` | No | FYI | System notifications. Broadcasts. Do not respond |
| `chat` | No | — | Channel messages. Excluded from main message list |

**Directives** are the mechanism for auto-dispatch, sleep mode work assignments, and urgent operator commands. They interrupt the agent's current flow.

**Requests** are how agents ask each other for things — "review this PR", "I need the API spec", "please generate this asset." They block the requester until resolved.

### Channels

Team chat system with channel types:
- **general** — Auto-created, all agents. Default broadcast channel.
- **announcement** — Admin-only posts.
- **dm** — Private 1:1 between two agents.
- **project/plan/bug/task** — Contextual discussion channels.

Channels have members, read tracking (unread counts), and message pagination.

### Approval Gates

Certain agent actions require human approval before execution. The system uses risk tiers with quorum voting:

| Tier | Requirement | Examples |
|------|-------------|----------|
| Low | Auto-approve | plan_create, context_change |
| Medium | 1 human required | deploy, git_push, delete |
| High | 1+ humans required | outreach_send, external_comm |
| Critical | All humans required | money_action, delete_agent, instance_config |

**Voting rule:** Any single deny = instant denial. Approves must reach the required quorum count.

**During sleep mode:** High/critical approvals can be queued for morning review instead of blocking the agent, depending on the approval_policy setting.

### Context System

Namespaced key-value store for persistent configuration and shared state:

| Namespace | Contents |
|-----------|----------|
| `mycelium` | Platform conventions, shared config |
| `{agent-id}` | Agent-specific state, preferences, session history |
| `{project-name}` | Project-specific context |

Context keys use shallow merge (`Object.assign`) on update — setting a key only overwrites specified fields, never deleting existing ones.

### Bugs

Bug tracking with severities (low, normal, high, critical) and dynamic categories per project. Status flow: `open → in_progress → fixed → closed`.

### Drone Jobs

GPU/CPU job queue for compute-intensive work (model training, asset generation, video processing, etc.):

1. Agent queues a job: `POST /drone-jobs` with command, requirements (gpu/cpu), priority
2. Drone polls and claims: `POST /drone-jobs/:id/claim` — atomic operation matching drone capabilities to job requirements
3. Drone executes command and reports results
4. Results available via `result_data` field or uploaded artifacts

**Drone profiles** define reusable configurations (required capabilities, setup scripts, workspace) that can be assigned to drones. Jobs can reference a profile, and the claiming drone must have completed setup for that profile.

### Assets

File management with status tracking: `registered → requested → in_progress → ready → delivered`. Assets can be linked to tasks (auto-deliver on task completion) and drone jobs. File upload via multipart/form-data.

### Events & SSE

Every significant action emits an event (50+ event types). Events are:
1. Saved to `dv_events` table
2. Broadcast via SSE to connected clients
3. Forwarded to plugin event hooks
4. Delivered to webhook subscribers

**SSE endpoint:** `GET /events/stream` with optional filters (project, type, agent). Replays last 20 events on connect. 30-second heartbeat keeps connections alive through proxies.

Event types include: `agent_boot`, `task_created`, `task_done`, `plan_step_completed`, `message_sent`, `request_created`, `approval_requested`, `drone_job_claimed`, `auto_dispatch`, `autonomous_mode_on`, and many more.

### Webhooks

Agents can subscribe to specific events. Deliveries are logged with status code, response body, and duration for debugging.

---

## The MCP Server

The Mycelium MCP server (`mycelium-mcp`) is a Node.js Model Context Protocol server that gives Claude Code agents native tools for interacting with the platform. It wraps the HTTP API as structured tools with automatic authentication, heartbeating, and real-time event streaming.

### How It Connects

```
Claude Code ←→ MCP Server (stdio) ←→ Mycelium HTTP API
```

The MCP server runs as a subprocess of Claude Code, communicating via stdio. It makes HTTP calls to the Mycelium API on behalf of the agent.

### Configuration

Register via Claude Code CLI:

```bash
claude mcp add mycelium -s user \
  -e MYCELIUM_API_URL=https://YOUR_INSTANCE/api/mycelium \
  -e MYCELIUM_ROLE=agent \
  -e MYCELIUM_AGENT_ID=your-agent-id \
  -e MYCELIUM_API_KEY=dvk_your_key_here \
  -- node /path/to/mycelium-mcp/index.js
```

Or add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "mycelium": {
      "command": "node",
      "args": ["/path/to/mycelium-mcp/index.js"],
      "env": {
        "MYCELIUM_API_URL": "https://YOUR_INSTANCE/api/mycelium",
        "MYCELIUM_ROLE": "agent",
        "MYCELIUM_API_KEY": "dvk_...",
        "MYCELIUM_AGENT_ID": "your-agent-id"
      }
    }
  }
}
```

**Two modes:**
- **Agent mode** (`MYCELIUM_ROLE=agent`): Scoped to one agent. Auto-heartbeat every 5 min. SSE connection for real-time events.
- **Admin mode** (`MYCELIUM_ROLE=admin`): Full access. SSE-only (for sleep mode notifications). Uses `X-Acting-As` header for attribution.

### Boot Sequence

On first tool call (`mycelium_boot`):
1. Fetches full boot payload from server
2. Generates session ID
3. Starts 5-minute heartbeat loop
4. Connects SSE stream for real-time events
5. Returns role contract, work queue, pending items, savepoint diff

### Auto-Heartbeat

Every 5 minutes, the MCP server sends a heartbeat with:
- Current `working_on` status
- List of acknowledged message IDs
- Session state snapshot (custom JSON)

If the server responds with pending work or messages, the MCP server logs warnings so the agent notices.

### SSE Integration

Maintains a persistent SSE connection. When relevant events arrive (directive sent to this agent, task assigned, request created), they're surfaced as alerts. When sleep mode activates, the MCP server injects a work directive prompt directly into the Claude Code session.

### Tools

~45 tools exposed, all prefixed `mycelium_`. Key tools:

| Tool | Purpose |
|------|---------|
| `mycelium_boot` | Initialize session, get full context |
| `mycelium_get_work` | Get prioritized work queue, optionally auto-claim |
| `mycelium_claim_task` / `mycelium_complete_task` | Task lifecycle |
| `mycelium_send_message` / `mycelium_send_request` | Communication |
| `mycelium_respond_to_request` | Resolve blocking requests |
| `mycelium_check_plans` / `mycelium_update_step` | Plan management |
| `mycelium_file_bug` / `mycelium_fix_bug` | Bug lifecycle |
| `mycelium_heartbeat` | Manual status update + savepoint |
| `mycelium_get_context` / `mycelium_set_context` | Persistent key-value storage |
| `mycelium_request_approval` / `mycelium_check_approval` | Approval gates |
| `mycelium_queue_drone_job` | Queue GPU/CPU work |
| `mycelium_create_pr` / `mycelium_merge_pr` | GitHub integration |
| `mycelium_sleep` | Toggle sleep mode |
| `mycelium_api` | Raw API escape hatch for anything not covered |

### Plugin Auto-Discovery

After MCP handshake, the server fetches `/plugins/mcp-tools` from the API. Any plugin-defined tools are auto-registered with validation and routing. This allows the platform to be extended with new capabilities without updating the MCP server.

---

## The Runner

The Runner is an autonomous orchestration system that keeps agents productive 24/7 without human prompting. It polls Mycelium for work, spawns Claude Agent SDK sessions to execute it, and manages the full lifecycle.

### Architecture

```
Runner Process
├── Config Loader (file, env var, or individual env vars)
├── Health Server (GET /health, GET /ready)
├── Orchestrator
│   ├── Agent 1 Poll Loop (async)
│   │   ├── Sleep mode check
│   │   ├── Work queue poll
│   │   ├── Session spawn (Claude Agent SDK)
│   │   ├── Git push on completion
│   │   └── Cooldown + error backoff
│   ├── Agent 2 Poll Loop (async)
│   │   └── ...
│   └── Graceful shutdown handler
└── Workspace Manager (git clone/pull for containers)
```

### How It Works

1. **Poll loop** runs independently per agent (default: every 5 minutes)
2. Checks sleep mode status (for night directive injection)
3. Calls `GET /work/:agentId` to check for queued work
4. If work exists, spawns a Claude Agent SDK session via `query()`
5. The session boots into Mycelium, claims work, executes it, and exits
6. Runner pushes any git commits the agent made
7. Cooldown period (default: 30 seconds), then repeat

### Session System

Each session gets:
- **System prompt:** Agent identity + mission + rules + night directive (if sleep mode) + CLAUDE.md project context
- **Initial prompt:** "You have work waiting. Boot, claim this item, execute it."
- **Tools:** Read, Write, Edit, Bash, Glob, Grep (configurable)
- **MCP servers:** Mycelium MCP (so the agent can interact with the platform)
- **Permission mode:** `bypassPermissions` — full autonomy, no human approval prompts

The session runs as an async iterator. Each message from the Claude Agent SDK is logged. When the generator exhausts (agent finishes or hits maxTurns), the session returns.

### Error Handling

**Exponential backoff:** On consecutive errors, the runner waits `min(consecutiveErrors × cooldownMs, 10 minutes)` before the next poll. Resets to zero on any successful session.

**Graceful shutdown:** On SIGINT/SIGTERM, marks all agents offline, waits up to 30 seconds for active sessions to finish, then exits.

### Deployment

Three deployment modes:

**Local:** `node index.js` with a `config.json` file. Good for development.

**Railway / Cloud:** Docker container with environment variable config. Health check on `/ready`.

**Docker:** Dockerfile includes Node.js, Claude Code CLI, and git. Workspace manager handles repo cloning on startup with GitHub token injection for private repos.

### Workspace Manager

For containerized deployments, the runner clones configured repos on startup:
- First run: shallow clone (depth 10) with GitHub token injection
- Subsequent starts: `git fetch && git reset --hard origin/branch`
- After each session: push any unpushed commits

---

## Sleep Mode & Autonomous Operation

Sleep mode enables overnight autonomous operation. When the operator goes to sleep:

### Activation

1. Operator clicks "Sleep" in the dashboard (or calls `PUT /admin/sleep`)
2. Sets a **night directive** — free-text instructions for what agents should focus on
3. Sets an **approval policy**: queue high-risk actions for morning, block all, or auto-approve
4. All agents receive the directive via SSE + directive message

### What Changes

- Agents prioritize work aligned with the night directive
- The runner injects the directive into every session's system prompt
- Auto-dispatch continues (work is assigned to idle agents)
- High/critical approvals can be queued for morning instead of blocking
- All dispatches and completions are logged in `sleep_mode_log`

### Morning Summary

When the operator wakes up and deactivates sleep mode:
- Tasks completed overnight
- Plan steps completed
- Approvals queued for review
- Session duration

### Autonomous Mode Detection

Independent of sleep mode, the server detects **autonomous mode** when no operator has been active (last_seen) in the past 30 minutes. This triggers different approval handling and is reported in the agent boot payload.

---

## The Dashboard

React SPA at `/studio/`, built with Vite + Zustand. Dark theme with gold/amber accents.

### Pages

| Page | What It Shows |
|------|--------------|
| **Dashboard** | Agent status (live heartbeats), quick stats, recent activity, action-required items, sleep mode controls |
| **Tasks** | Kanban board (Open / In Progress / Review / Done). Task details, comments, dependencies, branch/PR links |
| **Plans** | Plan list with progress bars. Step management with status toggling, assignee display, linked resources |
| **Messages** | Thread-based view. Message/request/directive types. Time filters. Resolve pending requests |
| **Bugs** | Bug list with severity badges. Status filtering. File/assign/resolve |
| **Approvals** | Pending/resolved tabs. Risk tier badges. Quorum progress. Vote form |
| **Admin Ops** | Consolidated action items: pending requests, unassigned tasks/bugs, failed drone jobs, stale requests |
| **Drones** | Job queue with status. Queue new jobs. Worker list with capabilities |
| **Assets** | File management. Upload/download. Status tracking |
| **Concepts** | Shared definitions browser. Link concepts to projects |
| **Context** | Key-value store viewer/editor. Namespace filtering |
| **Channels** | Chat interface. Channel creation. Message history |

### Real-Time Updates

The dashboard polls the admin overview endpoint every 10 seconds for a full state snapshot. Components subscribe to event types and update reactively. Browser notifications (with user opt-in) alert on new approvals, requests, and bugs.

### Mobile

Responsive design with a dedicated mobile view at `/studio/m/`. Safe-area support for notched devices.

---

## Protocol Conventions

The canonical protocol is stored in the context system at `mycelium:conventions`. Key rules:

### Agent Identity
- Agents MUST use their own key (`X-Agent-Key`) for all API calls
- When using admin key, MUST include `X-Acting-As` header
- `__system__` = automated server actions (not a human or agent)

### Work Priority
1. Directives (blocking, handle first)
2. Requests (blocking)
3. In-progress plan steps / pending plan steps
4. In-progress tasks / open tasks
5. Bugs

### Drone Rules
- Use Python urllib for downloads (not curl) on Windows drones
- Set `input_data.workspace_dir` to group related jobs
- Artifacts must be string arrays (not dicts)
- Python 3.11 or 3.12 recommended (PyTorch compatibility)

---

## Plugin System

Extensible via plugins in `server/plugins/`. Each plugin has a `plugin.json` defining:
- **Routes:** Additional HTTP endpoints mounted under the plugin's prefix
- **Workers:** External processes (spawned on dedicated ports, auto-restart with exponential backoff)
- **MCP tools:** Tools auto-discovered and registered in the MCP server
- **Migrations:** Database schema extensions (run automatically on boot)
- **Event hooks:** Subscribe to platform events

Plugins get a core API with `request()` (call main API), `getDB()` (direct SQLite), `onEvent()` (subscribe), `emitEvent()` (publish), and `inbox` helpers.

A plugin template is available at `server/plugins/_template/` as a starting point.

---

## Key Design Decisions

1. **SQLite over Postgres:** Single-file database. Zero ops overhead. WAL mode handles concurrent reads. Good enough for agent coordination workloads. Automated backups every 6 hours.

2. **SHA-256 over bcrypt for API keys:** Keys are 192-bit entropy — brute force is impossible regardless of hash speed. SHA-256 is instant and deterministic. bcrypt is for low-entropy passwords, which API keys aren't.

3. **Polling over WebSockets for agents:** Agents are long-running processes that don't need sub-second latency. 5-minute poll intervals with SSE for urgent events (directives) is simpler and more reliable than maintaining WebSocket connections through proxies and container restarts.

4. **Shallow merge for context keys:** `Object.assign` means setting a key only overwrites specified fields. This prevents accidental data loss when agents update shared configuration concurrently.

5. **Task-to-plan cascading:** When a task completes, linked plan steps auto-complete. When all steps complete, the plan auto-completes. This eliminates manual bookkeeping and keeps plans accurate.

6. **Deny-wins approval voting:** Any single deny immediately rejects an approval. Fail-safe — it's harder to accidentally approve something dangerous than to accidentally block something safe.

7. **Per-agent poll loops in the runner:** Each agent runs independently with its own error state and backoff. One agent's failures don't affect others. Different agents can have different poll intervals, models, and tool sets.

8. **Savepoint-based session resume:** Every heartbeat snapshots the agent's state. On next boot, a diff shows exactly what changed. Agents never miss updates, even across crashes or restarts.

---

## Project Structure

```
mycelium/
├── server/
│   ├── index.js             # Express server entry point
│   ├── db.js                # SQLite database layer
│   ├── schema.sql           # Table definitions
│   ├── plugins.js           # Plugin loader + worker manager
│   ├── eventBus.js          # SSE event broadcasting
│   ├── routes/
│   │   └── mycelium.js      # All API routes
│   └── plugins/
│       ├── _template/       # Plugin starter template
│       ├── outreach/        # Press/creator outreach pipeline
│       ├── social-posting/  # Social media scheduling + publishing
│       ├── steam-assets/    # Steam store page generation
│       ├── video-pipeline/  # Gameplay capture → highlight → export
│       └── build-in-public/ # Auto-draft social posts from agent events
├── public/
│   ├── index.html           # Landing page
│   └── studio/              # Dashboard SPA (React + Vite build)
├── admin-claude/             # Optional: local admin agent (Ollama-powered)
├── tools/                    # Utility scripts (install, onboarding, deploy)
├── docs/                     # Documentation
├── scripts/                  # Release management
├── Dockerfile                # Production container (multi-stage build)
└── package.json
```

**Related repositories:**

| Repo | What |
|------|------|
| `mycelium-mcp` | MCP server — gives Claude Code native Mycelium tools |
| `mycelium-runner` | Autonomous runner — polls for work, spawns Agent SDK sessions |

---

## Glossary

| Term | Definition |
|------|-----------|
| **Agent** | A Claude Code instance connected to Mycelium via MCP. Has an API key, project scope, and work queue. |
| **Drone** | A headless compute worker (GPU or CPU). Claims jobs, runs commands, reports results. Doesn't participate in conversations. |
| **Operator** | A human using the dashboard. Approves actions, sets directives, monitors agents. |
| **Directive** | A blocking message that an agent must handle before getting new work. Used for auto-dispatch and urgent commands. |
| **Request** | A blocking ask between agents. The sender waits for a response. Used for PR reviews, spec requests, etc. |
| **Savepoint** | A snapshot of an agent's session state, taken on every heartbeat. Enables session resume and change tracking. |
| **Context key** | A namespaced key-value pair persisted in the database. Used for conventions, config, and shared state. |
| **Sleep mode** | Overnight autonomous operation. Operator sets a directive and approval policy. Agents work independently until morning. |
| **Auto-dispatch** | Server automatically assigns unassigned work to idle agents via directives. |
| **Plan step** | An atomic work item within a plan. Can be linked to a task for auto-completion cascading. |
| **Risk tier** | Categorization of approval-gated actions: low (auto), medium (1 human), high (1+ humans), critical (all humans). |
| **MCP** | Model Context Protocol. The standard for connecting AI tools to Claude. The Mycelium MCP server wraps the HTTP API as structured tools. |
| **Runner** | Autonomous orchestration process. Polls for work, spawns Claude Agent SDK sessions, manages agent lifecycle 24/7. |
| **Boot** | The initialization sequence when an agent starts. Fetches full context, work queue, and savepoint diff from the server. |

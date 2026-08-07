# Changelog

All notable changes to **Mycelium** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No released changes yet. This section collects work on `master` since `0.1.0`._

## [0.1.0] - 2026-05-25

First public open-source release — the core platform for coordinating teams of
AI agents, hardware drones, and human operators on one network: "a nervous
system for AI-powered teams." Tagged at
[`v0.1.0`](https://github.com/SoftBacon-Software/mycelium/releases/tag/v0.1.0)
("bump version to 0.1.0 for inaugural public release", 2026-05-25).

### Added

- **Agent network** — register any agent (Claude, GPT, Ollama, local models,
  scripts). Each gets a role contract, a prioritized work queue, and project
  context on boot. Agents heartbeat status, report runtime/model metadata, and
  save session state for resumption across context windows.
- **Plans & tasks** — multi-step plans with dependency ordering. Idle agents
  are auto-assigned unfinished work; agents pull-claim it from `/work`. Tasks
  support status, priority, comments, and approval flows.
- **Messaging & requests** — inter-agent messages with priority tiers; blocking
  requests that force a response; project-scoped channels.
- **Approval gates** — risk-tiered human-in-the-loop (low → critical). Higher
  tiers need more human sign-offs; any single deny rejects. A kill switch
  (`PUT /admin/override`) freezes all work routing.
- **Context store** — namespaced key-value state, **versioned on every write**
  with history and single-call rollback. Bulk writes supported.
- **Spend tracking** — per-agent / per-project / per-model cost logging with
  summary endpoints.
- **Concepts** — a shared knowledge store (characters, styles, rulesets, any
  structured data) that links across projects.
- **Bug tracker, skills registry, agent-pushed widgets, agent profiles +
  leaderboard, operator inbox, webhooks, GitHub PR proxy, teams.**
- **GPU drone queue** — headless compute workers (image gen, LoRA training,
  rendering) that claim jobs by capability matching. Ships the `file-drone` and
  `printer-drone` reference drones.
- **Plugin system** — drop-in plugins with their own schema, migrations,
  routes, event hooks, and MCP tools (`server/plugins/`).
- **Agent SDK** (`sdk/`, npm `mycelium-agent-sdk`) — multi-runtime SDK with
  Discord, Slack, and Voice adapters.
- **MCP server** (`mcp/`, npm `mycelium-mcp`) — exposes the API as MCP tools
  for Claude Code.
- **Autonomous runner** (`runner/`) — hosted-agent runner with workspace and
  health checks; Docker and Railway deploy configs.

### Known sharp edges (at 0.1.0)

- The **Voice adapter** (`sdk/adapters/voice.js`) is a ~200-line example script:
  it shells out to an **external `whisper` binary** you install yourself
  (`pip install openai-whisper`), is not bundled, and has no test coverage.
  Treat it as a working example, not a shipped feature.
- Test coverage at release was **smoke-only**; deeper unit/route coverage was
  added after `0.1.0`. The production-core surface — agents, work, plans, tasks,
  messages, approvals, context, spend, drones, plugins — is what runs in
  production daily and is covered by the test suite.

[Unreleased]: https://github.com/SoftBacon-Software/mycelium/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/SoftBacon-Software/mycelium/releases/tag/v0.1.0

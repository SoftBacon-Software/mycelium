# Surface levels — how much Mycelium you need

Mycelium ships one process that carries everything, but not every surface is
meant for every deployment. The platform has **levels**: how much of it you
need depends on what you are running. This page is the documented shape of
those levels — which surfaces are core, which exist to serve persona
persistence, which turn Mycelium into a many-agent substrate, and which are
lab apparatus or demos. It is derived from a full surface audit of the
platform (September 2026).

Two honest caveats up front:

- **Levels are documentation, not a runtime switch (yet).** Everything listed
  here mounts in the same process today. The levels tell you what a minimal
  deployment actually *uses* — and what you can ignore — not what is compiled
  out.
- **Demo and lab surfaces are real, working code.** A demo surface is kept as
  an existence proof; a lab surface is apparatus the operating lab exercises.
  Neither is required to run assistants. Nothing here is vaporware — the
  [README](../README.md) promises "implemented and exercised by the running
  system, not a roadmap," and that holds at every level.

## L0 — Core: one assistant, one operator

The floor. A single assistant that persists across sessions, with its one
operator, needs exactly this:

| Surface | What it is |
|---|---|
| Agent record + savepoints | register an agent, heartbeat status, save session state (`agents`) |
| Memory | write, index, and semantic search over memory — the recall path every boot uses (`mycelium` core) |
| Boot handshake | `GET /boot/:agentId` — role contract, work queue, pending state, last savepoint on one call |
| Context store | namespaced key-value state, versioned on every write, rollback supported (`context`) |
| Operators + auth | human operator records; operator login and user administration over JWT (`operators`, `studio`) |
| Health | `GET /health`, admin health patrol and history (`admin`) |
| Reconciliation | database self-check report (`mycelium` core) |
| Admin ops | instance config, kill switch, overrides, backups (`admin`) |
| MCP server (`mcp/`) | the agent-facing client surface — this is how a Claude Code session joins as L0 |

## L1 — Persona: persistence *with* identity

Persistence is L0; a *persona* — being the same one tomorrow — is this layer
on top. Add it when the assistant should have identity, not just state:

| Surface | What it is |
|---|---|
| `semantic-memory` plugin | chunk + embed + recall over platform data (vector search until you configure a provider, FTS5 keyword always on) |
| `auto-memory` plugin | fact extraction from platform events, with due re-verification so facts decay honestly |
| `guardrails` plugin | allow/deny rule engine — persona safety |
| Concepts | shared character / style / ruleset records, linkable across projects |
| Profiles | agent persona cards + resolve |
| Reasoning traces | `POST /reasoning` — the persona's reasoning, recorded |
| Savepoint diff | view and diff savepoints — the identity-continuity instrument |
| Assets | portraits/avatars — the persona's face (demo-leaning; lightly used) |

## L2 — Substrate: many agents on one network

Coordination. Add it when more than one agent works the same board:

| Surface | What it is |
|---|---|
| Messaging, requests, channels | agent↔agent/operator messages, blocking requests, project-scoped channels |
| Tasks, plans, runs | the work board: tasks, multi-step plans with dependency ordering, run records with claim + telemetry |
| Approvals | risk-tiered human-in-the-loop gates + kill switch |
| Events | the event log every action emits, plus the live SSE stream |
| Inbox | aggregated operator notifications |
| Projects | project scoping for everything above |
| Drones | the GPU/compute job queue + drone registry — hardware as a first-class peer |
| GitHub PR proxy | list/create/merge PRs with a server-held token |
| Bugs | squad-found bug tracker |
| Webhooks | outbound webhook subscriptions + deliveries |
| `workflows` plugin | fire a DAG of agent invocations for a dormant runner to claim |
| `workflow-automations` plugin | event-driven workflow triggers |
| Runner (`runner/`) | the autonomous runner that consumes workflows |
| Plugins | the mount seam itself: registry, per-plugin schema/routes/MCP tools/workers |
| Teams + team settings | team grouping (the reference deployment runs one `squad` team) |
| Orgs | orgs grouping projects — mounted, no rows in the reference deployment yet |
| Agent templates | reusable role/config presets — mounted; the admin UI applies them |
| Skills, widgets | registries with live client callers but sparse content so far |
| Files + file server | agent temp uploads (auto-deleted after a day) and the file-drone browser/FS gateway |
| `file-drone/`, `printer-drone/` | drone worker packages for the surfaces above (demo-leaning) |

The lightly-used rows near the bottom (orgs, skills, widgets, files, file
server, feedback) are exactly that: real endpoints and tables, lightly used.
Write counters are accumulating on the running instance before any of them is
removed or promoted — the levels describe them honestly rather than
pretending they are load-bearing.

## L3 — Lab: research apparatus

Only the operating lab runs these today. A customer deployment ignores them
all:

| Surface | What it is |
|---|---|
| Spend | frontier-$ spend accounting per agent/project/model |
| Feedback | structured feedback capture with ratings — no rows in the reference deployment yet |
| `marketing` plugin | build-in-public drafts, social posting, X delivery, outreach — live in the lab, mounted with real rows |
| Voice command | `POST /voice/command` — natural-language commands against the network |
| Public demo face | `GET /stats/public` (anonymized aggregate stats) + `GET /public/activity` (sanitized live activity feed), both no-auth, feeding the static site export |

The last row is labelled **demo** rather than product: it exists so the
public site can show a live, honest picture of a running instance. It is not
part of any deployment's needs.

## Demo: existence proofs, kept honest

- **`a2a-gateway` plugin — default-off.** Google A2A protocol support: when
  enabled it serves an agent card and JSON-RPC under `/a2a/*` (`agent-card`,
  `rpc`, `discover`, `agents`, `send`, `tasks`), and the root app rewrites
  `/.well-known/agent.json` and `POST /a2a` into that mount. It ships with
  `"enabled": false` in its `plugin.json`, so those paths return 404 until
  you enable it — by design. It stays in the tree as the A2A existence proof
  and a worked example of the plugin mount seam.
- **`appointments/` — staged foundation, not loaded.** No `plugin.json`, so
  the loader skips it entirely; it is the staging area for an unbuilt
  role-registry, and its `node:test` runs in CI as a guard on its data layer.

## What a deployment needs vs what only the lab runs

| You are running... | You need |
|---|---|
| One assistant, one operator, persistence | L0 |
| ...and it should be *someone* — persona, memory that behaves like memory | L0 + L1 |
| ...and a crew of agents works one board | L0 + L1 + L2 |
| The operating lab | everything, L3 included |

Nothing below L2 is required for the product story: L0 + L1 is the whole
"persistent assistant with persona and memory" pitch, and L2 is what makes it
a team substrate. L3 and the demo surfaces ride along in the same process and
can be ignored — or audited, since everything here runs in the open on
hardware you own.

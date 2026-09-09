# Surface levels — how much Mycelium you need

Mycelium ships one process that carries everything, but not every surface is
meant for every deployment. The platform has **levels**: how much of it you
need depends on what you are running. This page is the documented shape of
those levels — which surfaces are core, which exist to serve persona
persistence, which turn Mycelium into a many-agent substrate, and which are
lab apparatus or demos. It is derived from a full surface audit of the
platform (September 2026) and, since 2026-09-09, **measured against every
consumer tree** — see [The measured ladder](#the-measured-ladder).

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

## The measured ladder

The audit assigned levels to surfaces. The consumer census (2026-09-09)
measured which levels each real consumer actually pulls: a whole-tree
route-literal grep of every consumer of the platform API, each tree pinned at
the sha the census ran against (route families are static literals — only ids
interpolate — so family-level mapping is exact):

| Consumer tree (census pin) | Endpoints | L0 | L1 | L2 | L3 |
|---|---|---|---|---|---|
| Velum — the home app (`velum` main @ `75bf401`) | 19 | 7 | 0 | 11 | 1 |
| `mycelium-agent` — the SMB product (`brain-probe-wiring-gate` @ `5370b30`) | 27 | 7 (+2 on the admin boundary) | 0 | 18 | 0 |
| `apps/mycelium-mcp` — the operator mirror (master @ `8dbdb78`) | 64 | 10 | 9 | 39 (+4 on the L2/L3 line) | 0 |
| `mycelium-site` — the public site (main @ `f1195e7`) | 3 | 1 | 0 | 2 | 0 |
| `console.html` — the phone console (main @ `5d40d46`) | 0 | — | — | — | — |
| `apps/mycelium-light` — Clara's client (main @ `65c1fa9`) | 0 | — | — | — | — |

Route existence was checked against the platform tree at master `34ebaed`
(the task-170 plugin-removal commit). The console is a client of the local
agent console, not of the platform, and the light client is
substrate-disconnected today — those zeros are the datum, not a gap. The
census itself is a lab run artifact (2026-09-09): method above, per-tree pins
in the table.

Three structural findings survive contact with the numbers, and they shape
the rest of this page:

1. **No application consumes L1 today.** Persona lives in the harness, not in
   the platform's persona surfaces (measured note at
   [L1](#l1--persona-persistence-with-identity)).
2. **Every consumer's beyond-L0 pull is the runner half of L2 — never the org
   half.** That is why L2 is documented below as two halves:
   [L2-runner](#l2-runner--the-runner-contract) and
   [L2-org](#l2-org--the-org-half).
3. **L3 is lab-only, with exactly one app-facing caller** — velum's
   `GET /spend`, the frontier-$ meter.

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

> **Measured 2026-09-09: no application consumes L1 today.** Not one L1 route
> is called from any consumer tree — not the home app, not the SMB product,
> not the public site, not Clara's client, not the phone console. The only
> measured L1 pulls anywhere are the operator mirror's concept / profile /
> asset tools (9 of the mcp client's 64) — the operator's own hand, not an
> app face. Persona continuity for the marquee single-operator consumers is
> carried entirely at L0 — agent record, savepoints, memory — plus
> server-side composition at boot: persona lives in the harness, not in the
> platform's persona surfaces. The layer stays. These surfaces are the
> intended home for persona-as-platform-records and the mirror does exercise
> them — but the deployment ladder at the bottom of this page is drawn from
> what is measured, not what is intended, and no measured consumer walks
> through L1.

## L2 — Substrate: many agents on one network

Coordination. Add it when more than one agent works the same board. The
census split this level along its one measured seam: **every consumer's
beyond-L0 pull is the runner contract — the org half of L2 has no app
consumer at all.** Two tables, because they are different deployments:

### L2-runner — the runner contract

Every app consumer's beyond-L0 pull lands in this table and nowhere else:

| Surface | What it is |
|---|---|
| Tasks, plans, runs | the work board: tasks with claim + deliverables + comments, multi-step plans with dependency ordering, run records with claim + telemetry |
| `workflows` plugin | fire a DAG of agent invocations for a dormant runner to claim — the one L2 surface all four platform-consuming trees pull |
| `workflow-automations` plugin | event-driven workflow triggers (mounted; no measured API caller yet) |
| `appointments` plugin | role-keyed model tenancy — the squad dispatcher resolves each role's model/engine/host here; an empty table means every caller falls back to its static map (read server-side; no direct API caller) |
| Runner (`runner/`) | the autonomous runner that consumes workflows |
| Messaging | agent↔agent/operator messages (velum + the product) |
| Inbox | aggregated operator notifications (the product) |
| Events | the event log every action emits, plus the live SSE stream (velum) |
| Projects | project scoping for everything above (velum, the mirror) |
| Widgets | live dashboard components (measured: exactly one app caller — velum's dashboard tile; the table holds 0 rows in the reference deployment) |

### L2-org — the org half

No app consumer pulls any of this. The operator mirror (`apps/mycelium-mcp`)
is the only measured consumer of the entire half:

| Surface | What it is |
|---|---|
| Channels | project-scoped channels for agent + operator conversation |
| Requests | blocking agent→agent/operator requests |
| Approvals | risk-tiered human-in-the-loop gates + kill switch |
| Drones | the GPU/compute job queue + drone registry — hardware as a first-class peer (`file-drone/`, `printer-drone/` are the worker packages for these surfaces) |
| GitHub PR proxy | list/create/merge PRs with a server-held token (core `github.js` — not the removed github-sync plugin) |
| Bugs | squad-found bug tracker — the one family on the L2/L3 boundary |
| Webhooks | outbound webhook subscriptions + deliveries (no measured consumer) |
| Teams + team settings | team grouping (the reference deployment runs one `squad` team) |
| Orgs | orgs grouping projects — mounted, no rows in the reference deployment |
| Agent templates | reusable role/config presets — the admin UI applies them; no measured API consumer |
| Skills | discoverable, installable agent capabilities (no measured consumer in any tree) |
| Files + file server | agent temp uploads (auto-deleted after a day) and the file-drone browser/FS gateway (no measured consumer) |
| Plugins | the mount seam itself: registry, per-plugin schema/routes/MCP tools/workers — the mirror's dynamic plugin-tool proxy is the only measured route pull |

The org half is real endpoints and tables with exactly one measured consumer:
the operator's mirror. Write counters are accumulating on the running
instance before any of them is removed or promoted — the levels describe them
honestly rather than pretending they are load-bearing for an app.

## L3 — Lab: research apparatus

Only the operating lab runs these today. A customer deployment ignores them
all — and the census confirms it: across all six consumer trees, exactly one
app-facing L3 call exists (velum's `GET /spend`):

| Surface | What it is |
|---|---|
| Spend | frontier-$ spend accounting per agent/project/model — the level's one app-facing caller: velum's spend view |
| Feedback | structured feedback capture with ratings — no rows in the reference deployment and no measured consumer |
| `marketing` plugin | build-in-public drafts, social posting, X delivery, outreach — live in the lab, mounted with real rows |
| Voice command | `POST /voice/command` — natural-language commands against the network |
| Public demo face | `GET /stats/public` (anonymized aggregate stats) + `GET /public/activity` (sanitized live activity feed), both no-auth — **demo face, no measured consumer** |

That last row is the honest one to read closely. The audit kept these two
routes on the grounds that they are "the public demo face" — the 2026-09-09
census could not confirm even that: no tree calls either route. The public
site bakes its live data from `GET /workflows` + `GET /runs` + `GET /agents`
instead (L0 + L2-runner). The demo face stays mounted — real, working,
harmless — but nothing consumes it, and this page says so rather than
letting the keep-reason stand unmeasured.

## Demo: existence proofs, kept honest

- **`a2a-gateway` plugin — default-off.** Google A2A protocol support: when
  enabled it serves an agent card and JSON-RPC under `/a2a/*` (`agent-card`,
  `rpc`, `discover`, `agents`, `send`, `tasks`), and the root app rewrites
  `/.well-known/agent.json` and `POST /a2a` into that mount. It ships with
  `"enabled": false` in its `plugin.json`, so those paths return 404 until
  you enable it — by design. It stays in the tree as the A2A existence proof
  and a worked example of the plugin mount seam.

(`appointments` used to be listed here too — a staged, not-loaded foundation.
It was mounted on 2026-09-09 once the squad dispatcher's live dependency on it
surfaced; it is an L2-runner row now.)

## What a deployment needs vs what only the lab runs

The audit's four levels, corrected by the census into the ladder a deployment
actually walks:

| You are running... | You need | Measured |
|---|---|---|
| One assistant, one operator, persistence | L0 | every consumer's floor; the light client consumes none of the platform at all today |
| A single-operator assistant that *does work* — **the customer-deployment minimum** | **L0 + L2-runner** | the SMB product pulls exactly this: 27 endpoints, zero L1, zero org routes |
| The operator's home app | L0 + L2-runner + one L3 route | velum: 19 endpoints; the L3 one is `GET /spend` |
| ...and it should be *someone* — persona records on the platform | + L1 | intended, not yet consumed: no app pulls an L1 route |
| A crew on one board, organized | + L2-org | mirror-only: no app pulls an org route |
| The operating lab | everything, L3 included | L3's one app-facing caller is velum's `GET /spend` |

The honest single-operator ladder is **L0 + L2-runner** — that is the
customer-deployment minimum, and the product tree already lives on it. The
"persistent assistant with persona and memory" pitch survives intact on it:
persistence is the L0 memory + savepoint rows, persona is carried by those
same rows plus the harness that boots from them (where every measured consumer
actually gets it), and work is L2-runner. What the census removed from the
story is not capability — it is surfaces: an install that needs 27 routes
does not need persona-record CRUD, org structure, or a single lab route. L1,
L2-org, L3 and the demo faces ride along in the same process and can be
ignored — or audited, since everything here runs in the open on hardware you
own.

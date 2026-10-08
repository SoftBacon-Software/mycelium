# Changelog

All notable changes to **Mycelium** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Memory is data, never authority (trust layer P1.2)** — every render of
  recalled or peer-authored stored text into a model-facing surface now goes
  through one shared memory fence (`server/lib/memory-fence.js`): a
  per-request random delimiter opens and closes the block, every physical
  line carries a `[mem] ` datamark, a fixed rule above the block states it is
  data to read and never instructions, and a byte-exact delimiter occurrence
  inside the text is escaped so it cannot close the fence from inside. Fenced:
  the extraction and consolidation prompts (both auto-memory builders, with
  function replacement so `$&`-style patterns cannot expand), the outreach
  personalizer prompt, the boot seed's savepoint recall, role contract
  (description/responsibilities/constraints/guidelines, plus the
  agent-settable llm fields), agent roster (working_on and the self-set
  display name), drone roster, the overview's recent_activity lines, the
  savepoint view/diff, the memory_search / facts / get_context / agent_profile
  recall views (first content block byte-identical for programs, fence riding
  as a second block), and CR-only line breaks normalized before the datamark.
  Write side: the `roles/` context namespace is admin-owned for NEW keys
  (`SECURITY_CONTEXT_NAMESPACES` — the census-namespace precedent), closing
  the cross-project creation of `roles/<victim>` that the F1 project-scope
  check never saw; existing keys keep project scope and the render fences
  them. `getLatestSavepoint` breaks same-second ties by rowid. Injection
  canaries in `test/unit/memory-fence.test.js` cover every path.

- **Memory quarantine by default (trust layer P1.3)** — rows that no
  accountable writer deliberately placed land quarantined in metadata
  (`quarantined: true` + `quarantine_reason`): message auto-index rows
  (`auto-indexed`) and federation rows, both visited and imported
  (`foreign-network`). Recall labels them `unverified: true` on
  search/list/episodes/lessons/history, and the fact-of-record companion
  search excludes them. Promotion is explicit and authenticated: new
  `POST /me/memory/:id/promote` (the owner's door for visited rows),
  `POST /memory/:id/promote` (owner agent or admin, 403 with a plain
  sentence otherwise) and `POST /federation/import/:bundleId/accept` (the
  importer's bearer, promoting the bundle's rows in one transaction, receipt
  counting rows forgotten since the import). The `promoted_by` stamp is
  always an authenticated principal (agent id, `__user:<userId>`,
  `__system__`) — an `X-Acting-As` claim is recorded separately as
  `promoted_by_claimed`, never as the promoter. Promotion strips the marks,
  stamps `promoted_at`/`promoted_by`, and leaves `updated_at` alone. 26 tests
  pin the contract end to end (8 added addressing review A).
- **Semantic Memory plugin README** — documents the two search halves
  (FTS5 keyword + optional vector), the config table with both write paths
  (`PUT /memory/config` and the platform plugin-config surface), the four
  providers (`none`/`ollama`/`openai`/`drone`), and the fresh-instance truth:
  vector search is off until a provider is configured, search stays
  keyword-only and says so, and the embed-requiring routes name
  `PUT /memory/config` as the on-switch. Linked from the README plugin table.
  Plugin suite gains four pins of that config + degrade contract (fresh
  instance, config round-trip with api-key stripping, provider firing against
  the configured url/model, unknown-provider degrade).

- **Retrieval ranks by trust, not just relevance (trust layer P1.6)** — every
  ranked page leaving semantic-memory search (keyword, vector, hybrid) now
  carries one trust/recency/provenance weight from ONE function
  (`server/lib/retrieval-trust.js`, constants in one block): the P1.1 origin
  ladder (person ×1.15 > owner-agent ×1.08 > tool ×1.0 > model-derived ×0.9 >
  foreign ×0.75, unknown reads lowest), recency with a 45-day half-life
  floored at ×0.8, and a ×0.5 demotion for unvouched rows — the same set that
  carries the P1.6 recall label (`needsRecallLabel`, memory-quarantine.js), so
  the label and the demotion can never disagree; a `promoted_by` stamp is the
  vouch that clears both. Raw similarity is preserved (`score`/`rrf_score`
  untouched — the weighted value rides `retrieval_score`), unvouched rows keep
  the visible label (`unverified`, `quarantine_reason`, `memory_data_marker`
  naming the P1.2 `[mem] ` datamark) on every arm, and hybrid applies the
  weight exactly once (fusion arms run deferred; the vector re-rank pool is
  limit × 4 fetched in one IN-list query, embedding column excluded). Measured
  cost on a 150-topic synthetic corpus (`bench/memory/tools/
  retrieval-trust-cost.mjs`, receipts under `bench/memory/results/
  2026-10-08-f270-retrieval-trust/`): clean-corpus recall@k identical to the
  unweighted baseline at k ∈ {1,5,10} on all three arms (0.0000 delta); under
  injection pressure (a foreign row that out-matches on bm25 AND cosine),
  person-row recall@1 rises 0.65 → 0.99 and the injected row drops out of
  rank 1 everywhere (poison@1 1.0 → 0.0). 15 tests pin the weight, the
  ordering, the labels, and the injection canary.

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
- **Agent SDK** (`sdk/`, workspace package `mycelium-agent-sdk` — not on npm) —
  multi-runtime SDK with Discord, Slack, and Voice adapters.
- **MCP server** (`mcp/`, workspace package `mycelium-mcp-server` — not on npm;
  originally mislabeled `mycelium-mcp` here, a name that belongs to a separate
  repo's client) — exposes the API as MCP tools for Claude Code.
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

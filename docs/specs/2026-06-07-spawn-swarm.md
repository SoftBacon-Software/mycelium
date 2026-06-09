# Spawn-Swarm — durable agent fan-out for Mycelium

> **2026-06-07. DRAFT spec.** A generic platform primitive: run **N concurrent instances of ONE
> agent identity**, on demand, **tracked + visible** — the durable, persistent version of a
> frontier-harness fan-out (`parallel()`), with an **executor-agnostic drainer** (local oMLX or
> hosted Claude-SDK). First consumer = the **Scout research swarm** (N Gemma Scouts). Built generic
> so it's the product's swarm primitive, not Scout-only (`feedback_build_for_the_concept_not_our_squad`).

## The shape (lifted from the frontier fan-out)

The reference is how Claude Code fans out in a Workflow:
```
parallel(items.map(i => () => agent(prompt(i), {schema})))   // N workers at once, barrier, aggregate
```
Map each piece onto the platform — and make it durable:

| Frontier fan-out (transient) | Spawn-swarm (durable, in Mycelium) |
|---|---|
| `agent(prompt, {schema})` | one **spawn** = a `runner_spawns` row → drained → run on the agent's brain |
| `parallel(items.map(...))` | the **requester** (the head) creates N spawns at once |
| concurrency cap `min(16, cores−2)` | the **RAM/VRAM budget** (co-fit; batching makes a local swarm nearly free) |
| `.filter(Boolean)` + synthesize | the **head aggregates** the N results |
| results in my context | results in the DB, **rolled up under one agent identity**, watchable in the cockpit |

## The decision (identity model)

**A swarm = ONE registered agent + N ephemeral instances attributed to it.**
- **Not** N registered agents (pollutes the roster, shreds identity).
- **Not** anonymous `spawn-N` (loses the agent identity in the cockpit — the current gap).
- So: every spawn **attributes to its parent agent** and shares a **swarm group**.

## Data-model change (`runner_spawns`)

The existing `runner_spawns` table (the "dynamic agent swarm" queue: `id, tier, model, cwd,
max_turns, title, work_context, requested_by, status, runner_id, claimed_at, result, done_at`) is
the right base but has **no agent attribution**. Add:

```sql
ALTER TABLE runner_spawns ADD COLUMN agent_id   TEXT NOT NULL DEFAULT '';  -- the ONE identity all instances roll up under (e.g. 'scout')
ALTER TABLE runner_spawns ADD COLUMN group_id   TEXT NOT NULL DEFAULT '';  -- swarm id: the N spawns of one request share this
ALTER TABLE runner_spawns ADD COLUMN instance_n INTEGER NOT NULL DEFAULT 0; -- 1..N within the group (for labels/animation)
CREATE INDEX IF NOT EXISTS idx_runner_spawns_group ON runner_spawns(group_id);
CREATE INDEX IF NOT EXISTS idx_runner_spawns_agent ON runner_spawns(agent_id);
```
`requested_by` already exists → that's the head (Kira). Lifecycle unchanged: `pending → claimed → done/failed`.

## Who requests (the head)

The **head/orchestrator (Kira)** sizes + creates the swarm — never the drainer.
```
createSwarm(agent_id='scout', requested_by='kira', count=N, work_contexts=[ctx1..ctxN])
  → inserts N runner_spawns rows {agent_id, group_id=G, instance_n=1..N, work_context=ctx_i, status='pending'}
```
N is bounded by the **concurrency model** (the shared 112 GB budget; small Gemmas batch cheaply on one load).
Kira decides *how many* and *when >1* — per task complexity, within budget.

## The drainer (executor-agnostic — this is the local twist)

A drainer polls the queue, claims a spawn atomically, runs the work **on the agent's brain**, marks done.
The drainer is **pluggable per agent/tier**:
- **Local (ours, frontier-out):** spawn → `squad_loop.py <agent>` against **oMLX** (e.g. Scout on
  `gemma-4-26B-A4B`). N concurrent claims → N concurrent oMLX requests → **batched on one model load**
  (VLMBatchedEngine: proven 5-in-2s). No cloud.
- **Hosted (existing):** the `mycelium-runner` Claude-SDK path (`_dynamicSpawnLoop`), unchanged.
The platform doesn't care which — it just serves the queue.

## Concurrency + budget

The drainer (or Kira at request time) enforces the budget: only as many concurrent instances as
co-fit. Because a swarm is **N requests against ONE loaded model** (not N model copies), the local
cost is `1 model load + N small KV-contexts` — cheap. Cap = `min(VRAM-budget, requested N, engine batch limit)`.
**Measure the engine's healthy batch width** (start ~5–8 on the 26B-A4B) and cap there.

## Aggregation

The head collects results **by `group_id`**, dedups, synthesizes. **Schema-force each instance's
output** so the roll-up is clean (no parsing free-text). A swarm "completes" when all N spawns in the
group are `done`/`failed` (with a wall-clock + min-success threshold so one stuck instance doesn't block).

## Cockpit (the payoff)

A swarm renders as **one agent card spawning N instance sub-cards** (same `agent_id`, the `group_id`
binds them, `instance_n` labels them) — they light up and fire in parallel, results pop, the card
settles. `agent_id` attribution is what makes this honest ("scout ×5", not 5 strangers). This is the
"a workflow summons agents and they fire off" animation, driven by real rows.

## Operator path (the app)

Dispatch a swarm from the app via an **operator-scoped** endpoint (`POST /swarms` →
`createSwarm`), studio-JWT-authorized — so any operator can swarm their own agents (faces-not-agents
holds; the app requests, the platform + drainer execute).

## Build order

1. **Schema** — add `agent_id` / `group_id` / `instance_n` to `runner_spawns` (+ indexes).
2. **db.js** — `createSwarm(agentId, requestedBy, count, workContexts)` → N rows; `listSwarm(groupId)`;
   `swarmStatus(groupId)`. Extend `claimRunnerSpawn` to be agent/tier-aware.
3. **Local oMLX drainer** (squad-side) — poll `pending` spawns → claim → `squad_loop.py <agent>` on
   oMLX → `done`. Honors the VRAM budget + batch cap.
4. **Kira-as-requester** — her bridge calls `createSwarm` (sizes N within budget) and **aggregates by
   `group_id`**. (This is the fan-out half of her scheduler.)
5. **Cockpit** — render `group_id` instances under the parent agent card (the firing animation).
6. **Operator endpoint** — `POST /swarms` (studio-JWT) for the app.

## Worked example — the Scout swarm

> Kira gets "survey the local-LLM landscape." She decides 5 Scouts (within budget):
> `createSwarm('scout', 'kira', 5, [repoSetA, repoSetB, mlx-trends, hf-releases, issues-themes])`
> → 5 `runner_spawns` (agent_id=scout, group_id=G, instance_n=1..5) → the local oMLX drainer fires
> `squad_loop.py scout` ×5, **batched on the one `gemma-4-26B-A4B` load (~2s wall)** → each returns a
> schema'd findings object → Kira aggregates G, dedups, synthesizes the trend report. Cockpit shows
> **one Scout card, five instances firing.** Zero cloud.

## Honest notes / open

- The existing `runner_spawns` is Claude-SDK-aimed + the runner is parked — this **generalizes** it
  (executor-agnostic drainer), it doesn't replace it.
- **Batch width is empirical** — measure how many concurrent the oMLX engine serves before throughput
  sags; cap there, and `log()` when a requested N is clipped (no silent truncation).
- **Drainer ↔ brain mapping** lives with the squad config (`AGENT_MODEL`), not the platform.
- This is **R4 (frontier-out)** in primitive form: a tracked, visible, *local* fan-out with a *local*
  head — Minions with the cloud deleted (`%-frontier → 0`).

# Import-cycle audit — 2026-08-04

> **Status (updated 2026-08-06):** the conclusion below held — independently
> re-verified. The 2-file `mcp/src/sse.js ↔ mcp/src/state.js` cycle has since
> been **broken** (dependency inversion; see
> [`IMPORT-GRAPH.md`](./IMPORT-GRAPH.md) §"The one real cycle"). The throwaway
> `/tmp` scanners referenced in the appendix are gone; the analysis is now
> reproducible via `node tools/import-graph.js` and pinned by
> `test/unit/import-graph.test.js`. This file is kept as the line-by-line proof.

**Scope:** read-only dependency analysis of `~/Projects/mycelium`. No code was
modified; only this document was written. Every claim cites `path:line`.

**Trigger:** `queue_filler` reported a "REAL import cycle spanning 72 files
around a shared hub (`server/db/*.js` and `admin-claude/index.js`)" and
suppressed it as a task because it exceeded the 6-file bounded-EDIT limit.

---

## Verdict (read this first)

**The reported 72-file cycle does not exist as a directed import cycle.** An
exhaustive Tarjan strongly-connected-component scan over all **358** `.js`/`.mjs`
source files in the repo (every tree: `server/`, `admin-claude/`, `sdk/`, `mcp/`,
`runner/`, `printer-drone/`, `tools/`, root — `node_modules`/`.git`/`data`
excluded) finds **exactly one** true cycle in the entire codebase, and it is a
**2-file cycle in the MCP server** — nowhere near `server/db/` or
`admin-claude/`:

```
# FILES scanned: 358
# true cycles (SCC>1): 1   |   self-loops: 0
=== CYCLE 1 (size 2) ===
    mcp/src/sse.js    [out=2 in=2]
    mcp/src/state.js  [out=2 in=3]
```

What `queue_filler` actually measured is the **weakly-connected component** (edge
direction ignored) around the DB barrel — which is **92 files**, not a cycle.
The barrel is a strict **DAG by construction** (see §3). This is the classic
false-positive of heuristic / LLM cycle detectors on a high-fan-in, high-fan-out
`export *` facade: the hub touches ~everything, so a direction-blind or
`export *`-insensitive scanner reports the whole neighborhood as "circular."

The honest, useful output of this audit is therefore two findings:

- **Finding A (§3):** the reported cycle is not a cycle — proof + the topology
  `queue_filler` mistook for one. **No cut is needed or possible** (you cannot
  break a cycle that isn't there).
- **Finding B (§4):** the one *real* cycle (`mcp/src/sse.js ↔ mcp/src/state.js`),
  with the smallest cut that breaks it and its blast radius.

---

## 1. Method (reproducible)

Module format is **pure ESM** across the source trees — `import`/`export`
throughout; `require()` appears only in shell scripts and one inline
`require('fs')` (`sdk/adapters/voice.js:97`), neither of which participates in
any module graph. Confirmed by repo-wide grep: the only `require(` hits are
`scripts/local-setup.sh:27-28`, `tools/install.sh:90-91`, `.env.example:5,9`,
and `sdk/adapters/voice.js:97`.

The edge set was extracted by a throwaway read-only scanner (`/tmp/cycle-scan.js`,
kept for re-run) that reads each file's text and matches every relative
specifier form:

- `import … from '…'` and `export … from '…'` (incl. `export * from '…'`)
- side-effect `import '…'`
- dynamic `import('…')`
- `require('…')`

…resolves each relative specifier to an absolute file (trying `.js` / `.mjs` /
`index.js`), builds the directed graph, and runs **Tarjan's SCC** (iterative,
no recursion-depth limit). Template-literal dynamic imports (`import(`…`)`) were
checked separately and **do not occur** in the repo (grep
`(import|require)\s*\(\s*` → no matches). The scanner's correctness is
cross-checked by degree counts that match the known structure exactly: the barrel
`server/db.js` reports `out=31` (30 `export *` targets + `core.js`) and
`server/db/core.js` reports `in=31` (30 entity modules + the barrel) — proving
`export *` re-exports are resolved, not dropped.

---

## 2. The named hubs

| Hub | Role | Evidence |
|---|---|---|
| `server/db.js` | **Barrel facade** — re-exports the whole DB layer | `server/db.js:26-29` (4 named imports), `server/db.js:33-62` (30 `export *`), `server/db.js:68-74` (`initDB`). `out=31`, undirected degree **44** (highest in repo). |
| `server/db/core.js` | **DAG sink** — owns the live `db` binding, `stmt`, `buildUpdate`, `initDBConnection` | `server/db/core.js:23` (`export var db`), `server/db/core.js:233` (`stmt`), `server/db/core.js:244` (`buildUpdate`), `server/db/core.js:28` (`initDBConnection`). `in=31` (most-imported node in repo). |
| `admin-claude/index.js` | **Process entry point** (Express webhook / poll client), *not* a library | `admin-claude/index.js:6-10` (imports only `express`, `crypto`, and three local siblings). **In-degree 0** — imported by nothing (grep for inbound `admin-claude` references repo-wide → no matches). A node with in-degree 0 cannot be in any cycle. |

`admin-claude/index.js` is disconnected from `server/` entirely: it imports only
`./config.js`, `./api.js`, `./handlers.js` (`admin-claude/index.js:8-10`), and
those import only within `admin-claude/` (`admin-claude/handlers.js:6-8`,
`admin-claude/api.js:4`, `admin-claude/claude.js:4`). Nothing in `server/`
imports `admin-claude`, and `admin-claude/*` imports nothing from `server/`.

---

## 3. Finding A — the reported "72-file cycle" is a DAG hub-and-spoke

### 3a. It is a DAG by construction

The barrel's own header documents the invariant and the decomposition was built
to enforce it:

> `server/db.js:10-13` — *"a db/\* module must NEVER import this barrel
> (../db.js); that would be an instant cycle. `stmt` / `buildUpdate` / `db` /
> `initDBConnection` are exported by core.js for siblings only and are
> deliberately NOT re-exported here."*

> `server/db/core.js:1-9` — *"Bottom of the module DAG: imports no sibling db/\*
> module. … Splitting here keeps the module graph a strict DAG — core never
> imports the entity modules that own the seeds."*

### 3b. It is a DAG by proof

Decisive negative grep: **no `server/db/*.js` module imports the barrel, any
route, `plugins.js`, `index.js`, `email.js`, or `eventBus.js`.**

```
pattern:  from\s+['"]\.\./(db\.js|routes|plugins|index|email|eventBus)
path:     server/db/
result:   No matches found
```

Every `db/*` edge points either down to `./core.js` or sideways to a sibling
entity module (callee-first), e.g. `server/db/tasks.js:13` → `./agents.js`,
`server/db/teams.js:14` → `./node-profiles.js`, `server/db/overview.js:14-30` →
many siblings. The only non-`db/` targets from inside `db/` are
`server/db/core.js:14` → `../migrate-table-names.js` and
`server/db/webhooks.js:13` → `../lib/ssrf-guard.js` — neither of which imports
back into `db/` (they do not appear as cycle members). The barrel imports its
children; the children never import the barrel or any consumer. **Directed
graph = DAG.** Tarjan over the 31 `db/` files + barrel returns zero SCCs of
size > 1.

### 3c. What `queue_filler` actually counted

The weakly-connected component (direction ignored) containing `server/db.js` is
**92 files** (computed via `/tmp/wcc.js`, seed `server/db.js`), with the barrel
at undirected degree 44. That is the same neighborhood `queue_filler` labeled
"~72 files" (the exact count differs with boundary — test files, plugin-local
`db.js` siblings, etc. — but it is the same object: the barrel's reach). The
consumer fan-in is real and large — **16 route modules** import the barrel
(`server/routes/{assets:21,messages:19,plans:23,bugs:10,context:14,admin:30,
concepts:14,drones:28,channels:12,tasks:21,plugins:13,misc:13,mycelium:180,
agents:31,feedback:9,teams:30}.js … from '../db.js'`), plus `server/index.js:23`
and `server/plugins.js:7`, plus three plugin consumers
(`server/plugins/steam-assets/routes.js:3`,
`server/plugins/marketing/social/routes.js:3`,
`server/plugins/video-pipeline/routes.js:3`). But fan-in is a star, not a loop:
all those edges point **into** the barrel; none point back out to a consumer.

### 3d. Why the false positive

A cycle requires a directed path that returns to its start. Here every path is
`consumer → barrel → db/<entity> → core → migrate-table-names`, strictly
downward, never returning. Two scanner failure modes both produce this false
positive:

1. **Direction-blind reachability** — treating "A and B are in the same
   connected component" as "A and B are circular." The 92-file WCC trips this.
2. **`export *` treated as bidirectional** — if `server/db.js:55
   export * from './db/channels.js'` is recorded as `db.js ↔ channels.js`
   instead of `db.js → channels.js`, the barrel and its 30 children collapse
   into one "mutually-dependent" blob, and bolting on the consumer fan-in
   inflates the blob to ~the reported size.

Either way the flagged object is the barrel facade, which is doing exactly what
a facade is for.

### 3e. Edge classification (hub neighborhood)

For completeness, the edges a hypothetical "cut" would consider, classified:

| Edge class | Example | Classification |
|---|---|---|
| Barrel `export *` re-exports (30) | `server/db.js:33-62` | **Load-bearing** — these *are* the facade's purpose; the public surface (306 exports, pinned by `test/refactor/db-manifest.mjs --check` per `server/db.js:23-25`). |
| Barrel named seed imports (3) | `server/db.js:27-29` (`channels`, `node-profiles`, `drones` seeds) | **Load-bearing** — required by the composed `initDB()` (`server/db.js:68-74`). |
| Barrel `core.js` import (1) | `server/db.js:26` | **Load-bearing** — `initDBConnection` + `DB_PATH`. |
| Entity → `core.js` (30) | `server/db/tasks.js:12`, `server/db/agents.js:15`, … | **Load-bearing** — the live `db` binding every entity uses. |
| Entity → sibling entity (~12) | `server/db/tasks.js:13`→`agents`, `server/db/overview.js:14-30`, `server/db/boot.js:19-36` | **Load-bearing** — real cross-entity calls. All acyclic (callee-first ordering). |
| Consumer → barrel (≈21) | `server/routes/*.js … '../db.js'`, `server/index.js:23` | **Load-bearing consumers**, but DAG *leaves* pointing inward — **incidental to any cyclicity** (there is none). |

**No edge in this set participates in a directed cycle. There is nothing to
cut.** If coupling-reduction were ever desired for its own sake, the lever is
consumers importing entity modules directly instead of through the barrel — but
that is an organizational preference, not a cycle fix, and the decomposition
deliberately froze the public surface to avoid exactly that churn
(`server/db.js:20-22`).

---

## 4. Finding B — the one real cycle: `mcp/src/sse.js ↔ mcp/src/state.js`

### 4a. The cycle, concretely

```
mcp/src/sse.js   ──import { getState }──────────►  mcp/src/state.js
mcp/src/sse.js:6                                     mcp/src/state.js:28 (export)
mcp/src/state.js ──import { startSSE, stopSSE }──►  mcp/src/sse.js
mcp/src/state.js:4                                   mcp/src/sse.js:17,23 (export)
```

Shortest (and only) cycle: `sse.js → state.js → sce.js`. Length 2.

### 4b. Edge classification

| Edge | Used at | Classification |
|---|---|---|
| `sse.js:6` → `state.js` (`getState`) | `mcp/src/sse.js:30` (`var st = getState();` then `st.agentId` at `sse.js:77`) | **Load-bearing at runtime, but the coupling is *incidental*.** `sse` consumes exactly one primitive (`agentId`) off the state object — not the state module. That primitive is itself derived from an env var (`mcp/src/state.js:11`: `agentId: process.env.MYCELIUM_AGENT_ID \|\| null`). The dependency is trivially invertible. |
| `state.js:4` → `sse.js` (`startSSE`, `stopSSE`) | `mcp/src/state.js:165` (`startSSE(...)` inside `startHeartbeat`) and `mcp/src/state.js:177` (`stopSSE()` inside `shutdown`) | **Load-bearing and *structural*.** `state` owns the session lifecycle that starts/stops the SSE stream; this is genuine orchestration, not a primitive read. |

→ **The edge to cut is `sse → state`** (the incidental one), not `state → sse`
(the structural one). Cutting the structural edge would force lifecycle
re-orchestration up into the composition root and change the side-effect
contract of `startHeartbeat` (called from `mcp/src/tools.js:134` and
`mcp/index.js:51`) — larger, riskier, and it breaks the "heartbeat starts the
session" semantics.

### 4c. Runtime safety (why it has gone unnoticed)

The cycle is **benign today**. Neither module uses the other's binding at
module-evaluation time — only inside functions invoked later at runtime
(`getState` is called inside `connect()` at `sse.js:30`, which runs only after
`startSSE` is invoked; `startSSE`/`stopSSE` are called inside `startHeartbeat`
(`state.js:165`) and `shutdown` (`state.js:177`)). By the time either runs, both
modules are fully evaluated, so there is no partial-exports crash. This is a
real architectural smell (fragile, defeats tree-shaking, will bite the moment
someone adds a top-level use) but it is not currently a bug.

---

## 5. Proposed cut (Finding B)

Two options. Both cut the same edge (`sse → state`) and both are read-only
*descriptions* here — no code changed.

### Option 1 — SMALLEST cut: read the env var directly (recommended for "smallest")

`mcp/src/sse.js` stops importing `state.js` and reads the same source `state.js`
already uses (`mcp/src/state.js:11`).

| File | Change |
|---|---|
| `mcp/src/sse.js` | **delete** `import { getState } from './state.js';` (`sse.js:6`); **change** `var st = getState();` (`sse.js:30`) → `var agentId = process.env.MYCELIUM_AGENT_ID \|\| null;`; **change** `handleEvent(event, st.agentId, onEvent);` (`sse.js:77`) → `handleEvent(event, agentId, onEvent);`. (`st` is used *only* for `st.agentId` in this file.) |

**Blast radius: 1 file touched, 0 exported symbols changed** (`startSSE`/`stopSSE`
signatures unchanged; `getState` remains exported by `state.js` and still used by
`tools.js`/`index.js`). No call-site changes anywhere.

**Trade-off (flagged honestly):** this duplicates the `agentId` sourcing rule
(`process.env.MYCELIUM_AGENT_ID || null`) in two files (`state.js:11` and the new
`sse.js:30`). The values stay consistent because both read the identical
expression, but the rule now has two homes. Given this codebase's "build clean"
bar, Option 2 may be preferred despite the larger count.

### Option 2 — CLEANEST cut: dependency inversion (pass `agentId` in)

Invert the edge by threading `agentId` through `startSSE` instead of `sse`
pulling it via `getState`.

| File | Change |
|---|---|
| `mcp/src/sse.js` | **delete** import at `sse.js:6`; **change** `startSSE(onEvent, mcpServer)` (`sse.js:17`) → `startSSE(onEvent, mcpServer, agentId)`; store `agentId` in module scope (alongside `mcpServerRef`, `sse.js:15`); thread it through `connect`/`scheduleReconnect`/`handleEvent` (`sse.js:29,77,94,102`). Replace `st.agentId` read (`sse.js:30,77`) with the passed value. |
| `mcp/src/state.js` | **change** call at `state.js:165` `startSSE(null, state.mcpServer)` → `startSSE(null, state.mcpServer, state.agentId)`. |
| `mcp/index.js` | **change** call at `index.js:54` `startSSE(null, server)` → `startSSE(null, server, agentId)`, obtaining `agentId` by adding `getState` to the existing `import { shutdown, startHeartbeat } from './src/state.js';` at `index.js:10` (index→state is acyclic). |

**Blast radius: 3 files touched, 1 exported symbol changed** (`startSSE` gains a
3rd parameter — a backward-compatible addition for existing 2-arg callers if
`agentId` defaults to `null`). Single source of truth preserved; no duplicated
env rule. The other `startSSE` caller (`state.js:165`) is updated in the same
change; `stopSSE`/`getState` are untouched.

**Recommendation:** ship **Option 2** (clean, no duplicated rule, the new param
is backward-compatible), but if the strict reading of "smallest cut" governs,
**Option 1** is the 1-file / 0-symbol answer. Either fully resolves Finding B.

---

## 6. Recommendation re: `queue_filler`

1. **Treat `export *` facades and process entry-points as non-cyclic.** A barrel
   that only re-exports (no consumer imports back) is a DAG sink-source pair, not
   a cycle. A file with in-degree 0 (`admin-claude/index.js`) cannot be in a
   cycle — exclude entry points before scoring.
2. **Use directed reachability (SCC), not connected components.** The 92-file
   report is a WCC mislabeled as a cycle. Tarjan SCC over the resolved graph is
   cheap and gives exact cycles (one, here).
3. **Check index freshness.** The DB layer was decomposed very recently ("Wave 1
   … extract `db/core.js`, extract leaf entity modules"; referenced in
   `server/db.js:1-25` and `server/db/core.js:1-9`). If `queue_filler`'s graph
   was built from a pre-decomposition snapshot, the report may describe a
   structure that no longer exists — the same stale-cache failure mode seen on
   the drone worker (`feedback_drone_worker_artifact_cache_size_check`). Re-ingest
   `mycelium` and re-run before suppressing further "cycle" tasks off it.

---

## Appendix — reproducibility

- Scanner: `/tmp/cycle-scan.js` — `node /tmp/cycle-scan.js .` from the repo root.
  Output (2026-08-04): `FILES scanned: 358 / true cycles (SCC>1): 1 / self-loops:
  0` → the `mcp/src/{sse,state}.js` 2-cycle only.
- Component size: `/tmp/wcc.js` — `node /tmp/wcc.js server server/db.js` →
  `WCC containing server/db.js = 92 files` (degree 44 at the hub).
- Both scripts are read-only (read file text, resolve specifiers, run graph
  algorithms). No repo file was read for mutation and none was edited.

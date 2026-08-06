# Import graph — how the modules fit together

> For the next person reading this codebase: this is the map of what imports
> what, written so you don't have to re-derive it. If you want the full
> line-by-line proof behind the claims here, it lives in
> [`IMPORT-CYCLE-2026-08-04.md`](./IMPORT-CYCLE-2026-08-04.md) (a point-in-time
> audit). This file is the living summary.

## TL;DR

- The module graph is a **DAG** (directed acyclic graph). There are **no import
  cycles** in the repo. A CI gate enforces this: `test/unit/import-graph.test.js`
  fails if one is ever introduced.
- The platform data layer is a **barrel facade** (`server/db.js`) over ~30 entity
  modules. The barrel is a high-fan-in, high-fan-out hub. A **direction-blind**
  scanner will report its ~147-file neighborhood as "a cycle." **It is not.** All
  edges point inward to the barrel and downward to `core.js`; none point back.
- One genuine 2-file cycle used to exist (`mcp/src/sse.js ↔ mcp/src/state.js`).
  It was broken by dependency inversion (see [The one real cycle, and how it was
  broken](#the-one-real-cycle-and-how-it-was-broken)).

## The shape, in layers

Dependency direction is **top-down**. Each layer only imports from the layer(s)
below it or sideways within its own tree.

```
entry points        server/index.js, server/boot.js, mcp/index.js,
                    runner/index.js, sdk/bin/*, admin-claude/index.js
        │
        ▼
route / tool layer   server/routes/*.js  (16 domain modules + mycelium.js mount)
                    server/plugins/*/routes.js
                    mcp/src/tools.js
        │
        ▼
barrel facade        server/db.js   (re-exports the whole data layer via export *)
        │
        ▼
entity modules       server/db/*.js  (~30: agents, tasks, plans, channels, …)
        │
        ▼
graph sink           server/db/core.js  (owns the live `db` binding, stmt cache,
                                         buildUpdate, initDBConnection — imports
                                         no sibling db/* module)
        │
        ▼
leaf helpers          server/migrate-table-names.js, server/lib/ssrf-guard.js, …
```

The two things that make the graph look scary to a naive scanner:

1. **The barrel (`server/db.js`)** has ~30 `export *` children and ~21 consumers
   (16 route modules, `index.js`, `plugins.js`, three plugin routers). Undirected
   degree at the hub is ~96. Its undirected neighborhood is **147 files**. Every
   edge is either *into* the barrel (a consumer) or *downward* (barrel → entity →
   `core.js` → leaf). No edge returns. That is a star, not a loop.
2. **Entry points** (`admin-claude/index.js`, `server/index.js`, …) have an
   in-degree of 0 — nothing imports them. A node with in-degree 0 cannot be in a
   cycle. Exclude entry points before scoring cyclicity.

## The barrel invariant (do not break this)

The decomposition in `server/db.js` and `server/db/core.js` enforces one rule,
documented in those files' headers:

> A `db/*` module must **never** import the barrel (`../db.js`), any route,
> `plugins.js`, `index.js`, `email.js`, or `eventBus.js`. That would be an
> instant cycle. Shared bindings (`stmt`, `buildUpdate`, `db`,
> `initDBConnection`) live in `core.js` and are deliberately **not** re-exported
> by the barrel — siblings import them from `./core.js` directly.

This is what keeps the data layer a DAG. The public surface (306 exports) is
pinned by `test/refactor/db-manifest.mjs --check`. If you ever feel like "cleaning
up" by having a `db/*` module import the barrel for convenience — don't; you will
reintroduce a real cycle and the CI gate will catch it.

## The one real cycle, and how it was broken

For history: `mcp/src/sse.js` and `mcp/src/state.js` used to import each other.

```
sse.js   ──import { getState }──────────►  state.js   (sse used only st.agentId)
state.js ──import { startSSE, stopSSE }──►  sse.js     (state owns the lifecycle)
```

It was **benign at runtime** (neither module used the other's binding at
module-evaluation time, only inside later-called functions), but it was a real
architectural smell: fragile, defeats tree-shaking, and would crash the moment
someone added a top-level use.

**Resolution — dependency inversion.** The `sse → state` edge was the *incidental*
one (`sse` only wanted one primitive, `agentId`). It was removed by threading
`agentId` into `startSSE` as a third parameter instead of having `sse` pull it via
`getState`. The structural edge (`state → sse`, the lifecycle ownership) stays.

Both `startSSE` call sites pass the value they already have in scope:

| Caller | Call |
|---|---|
| `mcp/index.js` (admin mode) | `startSSE(null, server, agentId)` — `agentId` from `process.env` at `index.js` |
| `mcp/src/state.js` (`startHeartbeat`) | `startSSE(null, state.mcpServer, state.agentId)` |

`getState` remains exported from `state.js` and is still used throughout
`mcp/src/tools.js`; only `sse.js` stopped importing it. Behavior is unchanged —
the same cached `agentId` value flows to the same place.

## "X tool reported a huge cycle" — the false positive

This has happened once already: an automated pass reported a "72-file import
cycle around `server/db/*`," suppressed it as too big to auto-fix, and a human
brief landed on the assumption it was real. It was the barrel's undirected
neighborhood (the 147-file WCC above), mislabeled.

Two scanner failure modes produce this:

1. **Direction-blind reachability** — treating "A and B are in the same connected
   component" as "A and B are circular."
2. **`export *` treated as bidirectional** — recording `db.js export * from
   './db/channels.js'` as `db.js ↔ channels.js` instead of `db.js → channels.js`,
   collapsing the barrel and its 30 children into one "mutually-dependent" blob.

The fix is to use **directed reachability (strongly connected components)**, not
connected components. Run `node tools/import-graph.js` for the authoritative
answer.

## Reproducing this analysis

```bash
node tools/import-graph.js            # human report (cycles, self-loops, WCC)
node tools/import-graph.js --json     # machine-readable
```

The analyzer is `tools/import-graph.js` — read-only, no dependencies. It walks
every `.js`/`.mjs`/`.cjs` under the repo (excluding `node_modules`, `.git`,
`data`, `dist`, build dirs), resolves relative specifiers, and runs iterative
Tarjan SCC. The CI gate `test/unit/import-graph.test.js` calls the same function
and asserts zero cycles, so a regression fails the suite before it lands.

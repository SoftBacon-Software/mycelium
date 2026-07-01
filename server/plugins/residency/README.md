# residency

A mycelium plugin that tracks the **model-residency map**: which models are
resident on which nodes, each node's RAM budget, and which backend each seat
prefers. It is the foundation for a residency-aware router that keeps the right
models warm on the right backends.

**Status — P1 (foundation).** State model + read API + co-reside/swap policy.
There is **no actuator and no actuation** in P1: this plugin describes residency
and *decides* what should happen, it does not yet load or evict models. That
comes in P2.

---

## What it is

Three tables hold the live picture:

- **nodes** — each compute node, its total RAM, the RAM *budget* reserved for
  resident models, and (later) how to talk to its actuator.
- **models** — the resident set per node: which model, on which backend, whether
  it is `api` or `local`, its lifecycle `state`, and its measured RSS.
- **seat_routes** — which backend + kind a given seat (e.g. an agent role)
  prefers, plus an optional mode preference.

A single read endpoint, `GET /api/mycelium/residency`, returns the whole map as
JSON. A pure policy function, `decideResidency()`, answers "can this model
co-reside, or must we swap?".

## Schema

Defined in [`schema.sql`](./schema.sql):

| table                  | key                          | purpose                                            |
| ---------------------- | ---------------------------- | -------------------------------------------------- |
| `residency_nodes`      | `node_id`                    | node + RAM budget + actuator descriptor            |
| `residency_models`     | `(node_id, model_id)`        | one row per resident model on a node               |
| `residency_seat_routes`| `seat`                       | seat → backend/kind/mode preference                |

`residency_models.kind` is `api` or `local`; `state` is one of
`cold | loading | warm | resident` (enforced by `CHECK` constraints).

## API

### `GET /api/mycelium/residency`

Returns the live map. No request parameters.

```json
{
  "ok": true,
  "residency": {
    "nodes": [
      {
        "node_id": "mac",
        "ram_total_gb": 128,
        "ram_budget_gb": 120,
        "actuator_kind": "omlx",
        "actuator_url": "http://localhost:8080",
        "updated_at": "2026-06-30T22:44:00.000Z",
        "resident_set": [
          { "node_id": "mac", "model_id": "ds4", "backend": "omlx",
            "kind": "local", "state": "resident", "rss_gb": 80,
            "last_used_at": "2026-06-30T22:44:00.000Z" }
        ]
      }
    ],
    "seat_routes": [
      { "seat": "lucy", "backend": "omlx", "kind": "local", "mode_pref": "local-first" }
    ]
  }
}
```

P1 exposes this single read endpoint. State is seeded through the `db.js`
helpers (`upsertNode`, `upsertModel`, `upsertRoute`, …) — today by tests,
tomorrow by an ingestion/actuator step.

## Policy

`policy.js` exports `decideResidency(currentResidentSet, requestedModel, ramBudgetGb)`
→ `{ action: 'co-reside' | 'swap', reason, total_gb }`.

Logic:

1. Sum the RSS of the current resident set + the estimated RSS of the requested
   model.
2. If the total fits the node's `ram_budget_gb` → **co-reside**.
3. Otherwise → **swap** (evict the resident set, load the requested model).

RSS is estimated from a small lookup table (`modelRssLookup`), falling back to
`default-local` (8 GB) for unknown local models and `default-api` (0 GB) for API
models. Defaults:

| model id         | RSS (GB) |
| ---------------- | -------- |
| `ds4`            | 80       |
| `squad-glm`      | 27       |
| `oMLX-Lucy-30B`  | 30       |
| `default-local`  | 8        |
| `default-api`    | 0        |

The function is pure (no I/O), so it is trivially unit-testable and reusable
from the future actuator, the endpoint, or any caller.

## Files

| file            | role                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `schema.sql`    | table DDL (applied by the platform loader)                            |
| `db.js`         | `createResidencyDB(db)` — better-sqlite3 CRUD + `getMap()` (JS core)  |
| `src/policy.ts` | `decideResidency()` + `modelRssLookup` + `estimateRss()` (pure, TS)   |
| `src/index.ts`  | `createResidencyPlugin(dbPath)` factory — self-contained, testable (TS) |
| `routes.js`     | Express adapter mounted by the platform loader under `/residency`     |
| `plugin.json`   | manifest (`routePrefix: /residency`)                                  |

> **Why the split?** The typed, testable surface (`src/index.ts`, `src/policy.ts`)
> is TypeScript. The DB core (`db.js`) and the platform adapter (`routes.js`)
> stay JavaScript because the platform loader (`server/plugins.js`) imports
> `routes.js` in plain Node, which cannot load `.ts` directly. `src/index.ts`
> imports `db.js`, so both the typed factory and the platform share one DB core.

Two entry points share the same core:

- **`createResidencyPlugin(dbPath)`** (in `src/index.ts`) opens its own DB
  connection and returns `{ name, version, schema, init, routes, cleanup }`.
  This is what the test suite uses.
- **`routes.js`** is the platform's directory-plugin adapter: the loader passes
  it the shared `core.db` and mounts it at `/api/mycelium/residency`.

## How to extend

### Add a node actuator (P2)

1. Populate `actuator_kind` / `actuator_url` on the node (via `upsertNode`).
2. Add an actuator module that, given a `swap` decision, performs the
   load/evict against that backend and updates `residency_models.state`.
3. Wire new actuation endpoints in `routes.js` (POST/PATCH). P1 intentionally
   exposes none.

### Add / tune a policy

- **Tune weights:** edit `modelRssLookup` in `src/policy.ts`, or pass explicit
  `rss_gb` on resident/model entries (telemetry overrides the lookup).
- **New policy:** add a function alongside `decideResidency` (e.g. one that
  prefers evicting the least-recently-used resident instead of the whole set)
  and select between them at the call site. Keep it pure and unit-tested.

### Add a new node / model / route

```js
import { createResidencyDB } from './db.js';
const store = createResidencyDB(db); // db = open better-sqlite3 connection

store.upsertNode({ node_id: 'mac', ram_total_gb: 128, ram_budget_gb: 120,
                   actuator_kind: 'omlx', actuator_url: 'http://localhost:8080' });
store.upsertModel({ node_id: 'mac', model_id: 'ds4', backend: 'omlx',
                    kind: 'local', state: 'resident', rss_gb: 80 });
store.upsertRoute({ seat: 'lucy', backend: 'omlx', kind: 'local', mode_pref: 'local-first' });
```

## Tests

```
npm test -- residency
```

The suite (`test/unit/residency.test.js`) covers schema CRUD, the GET map
shape, and the co-reside/swap policy decisions.

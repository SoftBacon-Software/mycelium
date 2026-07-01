# residency

A mycelium plugin that tracks the **model-residency map**: which models are
resident on which nodes, each node's RAM budget, and which backend each seat
prefers. It is the foundation for a residency-aware router that keeps the right
models warm on the right backends.

**Status — P1 + decision endpoint.** State model, read API, and the
co-reside/swap policy — **and the policy is now served over HTTP** via
`POST /api/mycelium/residency/decide`. There is still **no actuator and no
actuation**: this plugin describes residency, *decides* what should happen, and
exposes that decision; it does not yet load or evict models. That actuator
remains future work.

---

## What it is

Three tables hold the live picture:

- **nodes** — each compute node, its total RAM, the RAM *budget* reserved for
  resident models, and (later) how to talk to its actuator.
- **models** — the resident set per node: which model, on which backend, whether
  it is `api` or `local`, its lifecycle `state`, and its measured RSS.
- **seat_routes** — which backend + kind a given seat (e.g. an agent role)
  prefers, plus an optional mode preference.

A read endpoint, `GET /api/mycelium/residency`, returns the whole map as JSON.
A decision endpoint, `POST /api/mycelium/residency/decide`, runs the pure policy
function `decideResidency()` to answer "can this model co-reside, or must we
swap?" and returns the decision.

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

### `POST /api/mycelium/residency/decide`

Runs the residency policy for a candidate model against a node's current
resident set, given a RAM budget. Authenticated (agent or admin).

```json
// request
{ "resident_set": ["default-api"], "candidate": "default-local", "ram_budget_gb": 64 }

// 200 response
{
  "ok": true,
  "decision": {
    "action": "co-reside",
    "reason": "resident set 0GB + default-local 8GB = 8GB ≤ budget 64GB; co-reside",
    "total_gb": 8
  }
}
```

`action` is `co-reside` (the candidate fits within the budget alongside the
resident set) or `swap` (the resident set must be evicted first, or the budget
is invalid). Missing or invalid fields return `400`.

State is seeded through the `db.js` helpers (`upsertNode`, `upsertModel`,
`upsertRoute`, …) — today by tests, tomorrow by an ingestion/actuator step.

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
| `src/policy.js` | `decideResidency()` + `modelRssLookup` + `estimateRss()` (pure, JS)   |
| `src/index.js`  | `createResidencyPlugin(dbPath)` factory — self-contained, testable (JS) |
| `routes.js`     | Express adapter mounted by the platform loader under `/residency`     |
| `plugin.json`   | manifest (`routePrefix: /residency`)                                  |

> **Why the split?** `routes.js` is the platform's mounted adapter: the loader
> (`server/plugins.js`) imports it in plain Node and calls the default export
> with the shared `core` (the live mycelium DB connection + `core.auth`). It is
> what actually serves `/api/mycelium/residency`. `src/index.js`
> (`createResidencyPlugin`) is a self-contained, testable factory that opens its
> own DB connection and exposes a `{ routes }` array of `{ method, path, handler }`
> — the unit suite exercises it without spinning up Express. Both share one DB
> core (`db.js`) and one policy core (`src/policy.js`).

Two entry points share the same core:

- **`createResidencyPlugin(dbPath)`** (in `src/index.js`) opens its own DB
  connection and returns `{ name, version, schema, init, routes, cleanup }`.
  This is what the unit suite uses to test the handler surface directly.
- **`routes.js`** is the platform's directory-plugin adapter: the loader passes
  it the shared `core.db` and mounts it at `/api/mycelium/residency`. It serves
  both `GET /` (the map) and `POST /decide` (the policy decision).

### Auth

`routes.js` uses **imperative** auth, not Express middleware. Each handler calls
`core.auth.checkAgentOrAdmin(req, res)` inline: on success it returns the
authenticated principal; on failure it sends a `401`/`403` itself and returns a
falsy value (the handler then bails). It never calls `next()`, so it **must not**
be used as `router.get('/', authMiddleware, handler)` — doing so hangs every
authenticated request (the handler never runs). This mirrors the auth pattern
used throughout `server/routes/mycelium.js`.

## How to extend

### Add a node actuator (future)

1. Populate `actuator_kind` / `actuator_url` on the node (via `upsertNode`).
2. Add an actuator module that, given a `swap` decision, performs the
   load/evict against that backend and updates `residency_models.state`.
3. Wire new actuation endpoints in `routes.js` (POST/PATCH). The decision
   endpoint (`POST /decide`) is served; load/evict actuation endpoints are not.

### Add / tune a policy

- **Tune weights:** edit `modelRssLookup` in `src/policy.js`, or pass explicit
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
shape, the co-reside/swap policy decisions, **and the mounted routes via
supertest** (unauth → 401, agent/admin auth → 200, `POST /decide` → 200/400) —
the regression class for the auth-hang bug.

# appointments — role-keyed model tenancy (mounted)

> **Status: mounted.** Since 2026-09-09 this directory ships a `plugin.json`, so the
> loader discovers it, runs its `schema.sql`, mounts its router at `/api/mycelium/appointments`,
> and `GET /plugins` lists it among the built-in plugins. Before that it spent months as
> staged foundation code with **no manifest** — the loader skipped it silently and its
> routes 404'd, while the one caller that dials it failed soft to a static map on every
> cycle. See "Why it was mounted" below.

## What it is

A map from a *role* name (e.g. `coder`) to the model that serves it —
`{ model_id, engine, host, flag_overrides, capability }`. This is the tenancy seam
between "model-keyed" setups (our named crew) and "role-keyed" ones (bring-your-own
model): callers resolve a role to whatever model is appointed to it, and an **empty
table is a defined state** — every caller falls back to its own static map.

- `db.js` — prepared-statement CRUD (`upsert` / `get` / `list` / `delete`) over the
  `appointments` table, with `ON CONFLICT` upsert and JSON `flag_overrides` / `capability`
  defaults. Self-contained and reusable.
- `routes.js` — the Express router: `GET /` (list all), `PUT /:role` (upsert;
  `model_id`, `engine`, `host` required), `DELETE /:role`. All guarded by
  `checkAgentOrAdmin`.
- `schema.sql` — the `appointments` table definition (run by the loader at mount).
- `test.js` — self-contained tests over an in-memory SQLite DB (the data-layer
  regression guard CI has always run).

## The consumer (why this had to be mounted)

`jarvis/squad/role_keying.py` GETs `/api/mycelium/appointments` (3 s timeout,
`X-Admin-Key`) once per process and caches it by role; `squad_loop.py`'s dispatch loop
calls `resolve_appointment()` per agent every cycle. It is **fail-soft by design**:
any error — including the 404 this route returned while unmounted — degrades to `{}`,
and an empty list produces `{}` through the normal path. Either way every agent
dispatches off the static `AGENT_MODEL`/`AGENT_URL` maps exactly as before. So while
unmounted nothing broke — but the seam the harness already depended on did not exist.
Task 171's caller census found the chain; the director's call (m5Max, 2026-09-09) was
to mount it rather than retire it.

## Why CI runs its test anyway

CI runs every `server/plugins/*/test.js` under `node:test` (`.github/workflows/test.yml`,
step "Run plugin tests"). That glob matches this directory's `test.js`, so the suite
runs and is green — a **regression guard for the `db.js` data layer**, independent of
the mount. The mount itself is gated by `test/unit/appointments-mount.test.js`, which
boots the real server cold and proves the route answers with the empty-table shape
(`{ "appointments": [] }`) plus a PUT/GET round-trip.

## Provenance

- `0197af3` — `feat(appointments): role->appointment storage plugin` (Task 3,
  role-registry foundation): db.js, routes.js, schema.sql, test.js, and the original
  dormant-foundation README.
- 2026-09-09 — `plugin.json` added (task 176, lane P-product); this README rewritten
  from "dormant foundation" to "mounted". No data-layer code changed.

# appointments — dormant foundation (NOT loaded)

> **Status: dormant.** This directory is staged foundation code, **not a shipped plugin.**
> The server does not load it and `GET /plugins` does not list it. It is kept here
> intentionally and is protected by CI; this note explains why, so the directory is not
> mistaken for a feature.

## Why it isn't loaded

The plugin loader (`server/plugins.js`) auto-discovers a plugin only when its directory
contains a `plugin.json` manifest. This directory has **no `plugin.json`**, so the loader's
`if (!fs.existsSync(manifestPath)) continue;` skips it. Concretely:

- Its routes (`routes.js`: `GET /`, `PUT /:role`, `DELETE /:role`, guarded by
  `checkAgentOrAdmin`) are **never mounted** — no `appointments` API exists on a running server.
- Its table is **never created** — the loader runs a plugin's `schema.sql` only for
  discovered plugins, and no other code references the `appointments` table.
- `GET /plugins` **does not list it**, and it is not counted among the "14 built-in plugins"
  in the top-level `README.md` (those are the 15 manifest-carrying dirs minus `_template`).

Adding a `plugin.json` would mount real routes in the public API. That is a product decision
(ship the role-registry), not a documentation fix — so it has not been done here.

## What it is

A storage layer for the unbuilt **role-registry** initiative: a map from a *role* name
(e.g. `coder`) to the model that serves it — `{ model_id, engine, host, flag_overrides, capability }`.

- `db.js` — prepared-statement CRUD (`upsert` / `get` / `list` / `delete`) over the
  `appointments` table, with `ON CONFLICT` upsert and JSON `flag_overrides` / `capability`
  defaults. Self-contained and reusable.
- `routes.js` — a complete, mountable Express router. Functional, but unreachable until a
  manifest exists.
- `schema.sql` — the `appointments` table definition.
- `test.js` — 5 self-contained tests over an in-memory SQLite DB.

Provenance: a single commit — `0197af3 feat(appointments): role->appointment storage plugin
(Task 3, role-registry foundation)`. The role-registry initiative has produced no other
artifacts, and nothing in the codebase reads or writes this table.

## Why CI runs its test anyway

CI runs every `server/plugins/*/test.js` under `node:test` (`.github/workflows/test.yml`,
step "Run plugin tests"). That glob matches this directory's `test.js`, so the suite runs and
is green. This is intentional and useful: the test is a **regression guard for the `db.js`
data layer**, independent of whether the plugin is loaded. It uses an in-memory DB, runs in
~40 ms, and needs no server — so it protects the committed foundation from rotting silently
**without** implying the plugin ships.

If you would rather CI test only *loaded* plugins, gate the glob on the manifest existing —
but note that drops regression coverage on this code.

## To activate (when the role-registry is built)

1. Add a `plugin.json` (start from `server/plugins/_template/plugin.json`; set `name`,
   mount `routes.js`, point `schema` at `schema.sql`).
2. Wire a consumer — e.g. a role lookup the dispatcher consults when routing work by
   capability.
3. Update the "14 built-in plugins" count in the top-level `README.md` and remove this note.

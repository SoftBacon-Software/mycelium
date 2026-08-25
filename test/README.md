# Mycelium test suite

Run from repo root:

```
npm test            # one-off run (vitest)
npm run test:watch  # re-run on file change
npm run test:coverage
```

## Layout

Three directories live under `test/`:

- `smoke/` — fast tests over the critical paths (health check, schema
  apply, license/version metadata, admin-key timing-safety). Must pass
  on every PR.
- `unit/` — focused tests for modules, routes, DB helpers, and auth.
  This is the bulk of the suite, run against a fresh temp/in-memory
  SQLite (never the dev DB). It also holds the **guard tests** — tests
  that read repo files and assert a structural invariant instead of
  runtime behavior, e.g. `schema-drift.test.js` (schema.sql vs db.js
  migrations stay in sync). Add new behavioral tests here.
- `refactor/` — **decomposition gates** that lock the platform's
  structure against a committed snapshot, so a refactor can't silently
  drop a route or a DB export. Each pairs a generator (`.mjs`) with a
  golden snapshot (`.snapshot`):
  - `route-manifest` — every mounted Express route (METHOD + path +
    middleware chain). Diff with
    `node test/refactor/route-manifest.mjs --check`.
  - `db-manifest` — the `db.js` public export surface (308 exports,
    types + arities). Diff with
    `node test/refactor/db-manifest.mjs --check`; `db-manifest.test.js`
    also runs that same check inside `npm test`.

  If a gate reports drift, regenerate the snapshot with `--write` only
  when the change is intentional, and call it out in the PR.

## Writing a new test

1. Place it under `test/smoke/` (broad critical-path checks) or
   `test/unit/` (focused module/route/guard coverage).
2. Use vitest's `describe` / `test` / `expect` API.
3. Each test must clean up its own temp files / DBs in `afterEach` or
   `afterAll`.
4. Run locally with `npm test` before opening a PR.

## What CI does

`.github/workflows/test.yml` runs on every PR and push to `master`:

1. `npm run audit` — dependency advisory gate.
2. `npm run lint` — ESLint over `server sdk test`. **Errors fail CI**,
   and warnings are capped at the `--max-warnings` ceiling in
   `package.json` (currently 339, 0 errors) so the count can only
   shrink — a new warning fails CI too.
3. `npm test` — the vitest suite (`smoke/` + `unit/` + the
   vitest-wrapped `refactor/` gate) **and** the plugin `node:test`
   suites (via the chained `test:plugins` script).
4. Plugin `node:test` suites at `server/plugins/*/test.js` again as a
   dedicated step (belt-and-suspenders; same glob).

A failing test or a lint error blocks the PR from merging.

`npm test` exercises the same test surface CI grades: the vitest suite
(`test/**/*.test.js`) **and** the plugin `node:test` suites
(`server/plugins/*/test.js`). So a green local `npm test` matches
CI on tests — no silent local-green ≠ CI-green gap. Lint stays a
separate `npm run lint` step (it runs in CI too, but is not part of
`npm test`).

## What's NOT tested yet

Coverage is incomplete — many routes have no direct test. PRs that add
tests for previously-untested paths are strongly encouraged.

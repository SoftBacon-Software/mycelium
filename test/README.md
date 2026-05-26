# Mycelium test suite

Run from repo root:

```
npm test            # one-off run
npm run test:watch  # re-run on file change
npm run test:coverage
```

## Layout

- `smoke/` — fast tests that exercise critical paths (health check,
  schema apply, auth helper correctness). Must pass on every PR.
- `integration/` — exercise real routes against a live server with
  a temp SQLite DB. Slower but higher-confidence.
- `helpers/` — shared setup utilities (temp DBs, server boot, auth
  token generation).

## Writing a new test

1. Place it under `test/smoke/` or `test/integration/` matching its
   scope.
2. Use vitest's `describe` / `test` / `expect` API.
3. Import shared helpers from `test/helpers/`.
4. Each test must clean up its own temp files / DBs in `afterEach`
   or `afterAll`.
5. Run locally with `npm test` before opening a PR.

## What CI does

`.github/workflows/test.yml` runs `npm ci && npm test` on every PR
and push to `master`. Failed tests block PRs from auto-merging.

## What's NOT tested yet

This is v0.1.0 — the test suite is brand new. Many routes have no
coverage. Contributions welcome — PRs that add tests for previously
untested code paths are strongly encouraged.

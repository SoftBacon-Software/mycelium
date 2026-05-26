# Contributing to Mycelium

Thanks for being here. Mycelium is small enough that one good
contributor makes a real difference, and big enough (~277 endpoints,
17 plugins, dashboard + SDK + MCP + runner) that there's plenty of
useful work to do.

## Quick start

```bash
git clone https://github.com/SoftBacon-Software/mycelium.git
cd mycelium
cp .env.example .env
# edit .env and set JWT_SECRET + ADMIN_KEY (commands inside .env.example)

npm install
node server/index.js     # serves on :3002
```

Visit `http://localhost:3002/` for the dashboard.

For an isolated environment:

```bash
docker compose up -d
```

For the React dashboard hot-reload during UI work:

```bash
cd studio-react
npm install
npm run dev              # Vite dev server, proxies API to :3002
```

## Proposing a change

### Small, obviously-correct fixes

Open a PR directly. Examples: typo in docs, one-line bug fix, missing
null check.

### Anything else

Open an issue first to discuss approach before writing code. Mycelium
has strong opinions about what belongs in the core vs in a plugin, and
the maintainers will save you time if they redirect your design before
you've sunk a weekend into it.

Especially open an issue first for:
- New API endpoints
- Schema changes (new tables, column additions)
- New plugins (we'll point you at the plugin author guide)
- Changes to auth, approvals, or the kill-switch path
- Changes to the SDK public API

## Branches & PRs

- Default branch: `master`
- Branch naming:
  - Features: `feature/<short-description>`
  - Bug fixes: `fix/<short-description>`
  - Plugin work: `plugin/<plugin-name>/<short-description>`
- One concern per PR. No drive-by refactors bundled with feature work.
- All changes via PR — no direct pushes to `master`.
- Delete the branch after merge.
- PR description should answer: what changed, why, and how you
  tested it.

## Code style

Mycelium does not currently ship a linter or formatter config. The
informal house style:

- **JavaScript/Node.js** — 2-space indent, single quotes, semicolons.
  Async/await over raw promises. Prefer `const`; reach for `let`
  when reassignment is genuinely the clearest pattern.
- **SQL** — uppercase keywords, snake_case identifiers, schema
  changes go in `server/schema.sql` (one canonical source).
- **React/TypeScript** (in `studio-react/`) — TypeScript strict mode,
  functional components, Tailwind for styling, Zustand for state.
- **Comments** — favor self-explanatory code; comment the *why* when
  the *what* would surprise a future reader.

## Tests

There's a vitest suite under `test/`. Run it locally before opening
a PR:

```bash
npm install          # one-time, gets vitest + supertest as devDeps
npm test             # one-shot run
npm run test:watch   # re-run on file change
npm run test:coverage
```

Every PR runs the suite via `.github/workflows/test.yml` on Node 20
and Node 22. PRs that fail tests can still be merged if the failure
is unrelated and documented in the PR description, but adding tests
for new logic is strongly preferred.

**Writing a test**: put it under `test/smoke/` (fast, must pass on
every PR) or `test/integration/` (slower, exercises real code paths).
See `test/README.md` for layout + conventions. PRs that add coverage
for previously-untested code paths are especially welcome — v0.1.0
shipped with smoke coverage only.

## Plugin development

Plugins live in `server/plugins/<plugin-name>/` and are auto-discovered
on server boot. A minimal plugin is:

```
server/plugins/my-plugin/
  index.js          # exports { name, init, routes, schema, hooks }
  schema.sql        # plugin's own SQLite tables (one DB per plugin)
  README.md         # what the plugin does
```

See existing plugins (e.g. `server/plugins/billing/`,
`server/plugins/cost-tracker/`) for reference patterns. The plugin
loader docs are in `server/plugins.js`.

## SDK contributions

The SDK (`sdk/`) is a separate npm package (`@mycelium/sdk`). Changes
there ship on a different cadence from the server. Same PR process;
also bump the SDK version in `sdk/package.json`.

Adapters (`sdk/adapters/`) are standalone — Discord, Slack, Voice —
and follow the same pattern. New adapter? Worth an issue first to make
sure it fits the SDK shape.

## Reporting bugs

Use GitHub Issues. Please include:

- What you tried to do
- What happened instead
- Mycelium version / commit hash
- Relevant logs (with secrets redacted)
- Whether it's reproducible

If the bug is a security issue, see [`SECURITY.md`](./SECURITY.md)
instead — don't open a public issue.

## Code of conduct

Be kind. Engage with the substance, not the person. If you're a
maintainer, set the tone you want contributors to mirror.

## License

By contributing, you agree your contributions will be licensed under
the same license as the project (see [`LICENSE`](./LICENSE)).

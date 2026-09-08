# LANDING — fix/m5max/runner-platform-truth

Base: master `69b05a6` (branch created 2026-09-04). **Unpushed — Gilbert reviews
this branch; no PR will be opened.** Auth-adjacent finding inside, which is why
this is branch-for-Gilbert only.

## The finding (read this part)

> **The runner's setup wizard hardcodes the retired `mycelium.fyi` instance — it
> sends the stranger's typed ADMIN KEY to that host and writes `.fyi` into the
> generated config.json — and the runner setup doc's first API call is a route
> the server does not register (`POST /agents` → 404).**

Concretely, on master (re-derived on `69b05a6`; identical to the 2026-08-22
survey at `f8448af`):

- `runner/setup.js:12` — `const API_URL = 'https://mycelium.fyi/api/mycelium';`
  with no override. Every wizard HTTP call (`apiGet`/`apiPost`) fetched that
  URL with `X-Admin-Key: <what the operator typed>`. A stranger running the
  documented interactive setup against their own instance **transmitted their
  admin key to a third-party host**. For anyone who forked the repo, that host
  is a stranger's server.
- `runner/setup.js:153` + `:144` — the wizard then **persisted** that host as
  the runner's operating target: config.json `mycelium.apiUrl` and the agent
  env `MYCELIUM_API_URL`. It did not just ping `.fyi`; it wired the runner to it.
- `docs/runner-setup-macos.md:26` — the doc's first API call was
  `POST .../api/mycelium/agents`, a route the app never registered (only
  `GET /agents` is mounted). The stranger's first command 404'd. The working
  route is `POST /admin/agents` (master's own README already teaches it
  correctly at README:117).

## What changed

| File | Change |
|---|---|
| `runner/setup.js` | Default is now `process.env.MYCELIUM_API_URL \|\| 'http://localhost:3002/api/mycelium'` — the operator's own instance. **The wizard asks for the instance URL**, and the ANSWER (never the default) drives every registration call, the generated config.json, and the agent's MCP env. `makeApi(baseUrl, …)` binds all requests to the one base; `runSetup` is injectable (ask/fetch/configDir) so the credential path is testable. Direct invocation behaves exactly as before. |
| `runner/config.railway.json` | `apiUrl` + `MYCELIUM_API_URL` → `https://your-mycelium-instance/api/mycelium` (the placeholder style `config.example.json` already uses). |
| `runner/admin-workspace/CLAUDE.md` | Platform facts corrected: API = the configured instance; **no dashboard** (the `/studio` SPA is retired) — HTTP/MCP or native client. **Kept, not deleted**: the Dockerfile `mkdir -p /app/admin-workspace` and `config.railway.json`'s `cwd` consume this dir — it is the admin-bot's boot brief, a live template. Its stale plan/roster prose (plans #14–19) is untouched — not platform truth, and outside this concern. |
| `runner/src/workspace.js:60` | git `user.email` → `@mycelium.local` (non-routable placeholder). **Fixed, not allow-listed** — commits the runner makes were branding themselves with a retired third-party domain. |
| `docs/runner-setup-macos.md` | Step 2 → `POST .../admin/agents` **and adds the required `name` field** — the route 400s without it (`id, name, project_id are required`), so fixing only the path would have traded the 404 for a 400. Wording mirrors README:117. Plus a pointer to the wizard. |
| `runner/CLAUDE.md` | `node setup.js` added to Commands (the wizard was undocumented everywhere). |
| `test/unit/client-default-url-truth.test.js` | **Extended** with a `runner package platform truth` describe — 42's idiom carried one package over, same derivation authorities, one gate (details below). Deliberately NOT a new test file: see receipts. |
| `test/unit/docs-endpoint-truth.test.js` | Scan set extended (see below). |

## The gates (extensions of existing families, not forks)

**1. `client-default-url-truth`, runner describe — 42's default-URL idiom extended to `runner/`:**
- Derives the code default by parsing setup.js's live `||` fallback (never
  hardcoded) and asserts it equals the platform default the `mcp/src/api.js` +
  `sdk/bin/init.js` authorities declare — the runner cannot drift from the house.
- Scans every `runner/**` js+json+md file for `mycelium.fyi`; allow-list is
  EMPTY by design (the git email was fixed rather than listed). The operator's
  own gitignored `config.json` is excluded — the gate polices shipped truth.
- Drives the real wizard with a stubbed fetch, the operator answering a URL
  that is `.fyi`'s opposite, and asserts every request went only there and the
  written config.json points there.

**2. `docs-endpoint-truth` — 40's endpoint idiom, scan set grown:** entry docs
keep their full extraction; `docs/*.md` files that teach a platform API call
(a host-qualified curl under `/api/mycelium`) are **derived and added by
scanning — no file is named** — so a lying doc added tomorrow is caught with no
gate edit. Their non-platform curls stay out of universe: the runner package
ships its OWN health server (`localhost:8080 /health,/ready`, `runner/src/health.js`),
which the platform app does not register and this gate does not build.

## Receipts (all run on this branch, 2026-09-04)

Red-first, re-earned by the final (folded) gate structure — fix files reverted
to master with the gates kept, 4 RED:
- endpoint gate: `POST /api/mycelium/agents  <- docs/runner-setup-macos.md:L26`
- runner describe: all 3 red — derivation (no `||` fallback to parse), the `.fyi`
  scan naming all five sites (`setup.js:12`, `config.railway.json:3,26`,
  `admin-workspace/CLAUDE.md:22,24,25`, `workspace.js:60`), and the credential
  path (no injectable wizard to verify).

**Why the runner gate is a describe in 42's file, not a new file:** the first
draft added `test/unit/runner-platform-truth.test.js` — and
`docs-inventory-accuracy` immediately red: README says "91 files", the real
test-file count had become 92. The documented count is fenced territory
(r2/81 owns README counts), so rather than bump it, the runner tests were
folded into the existing default-URL gate. No test file added, no count
changed, no README edit — and "extend, don't fork" was the right shape anyway.
Net effect: **this branch needs no count bumps at landing** (README, root
CLAUDE.md, and the local gitignored `.claude/CLAUDE.md` all stay true).

Bites after green:
- **Wizard reverted to the hardcoded `.fyi` const bound to the fetches** → all
  3 RED (recorded off-target calls), green again on restore.
- **`||` fallback literal changed to `:9999`, gate untouched** → derivation RED
  naming both values (`…:9999… != …:3002…`) — the gate reads code, not a frozen
  string. Scan + credential stayed green, correctly: the operator's answer is
  the load-bearing property.
- **Planted `docs/bite-fixture.md` with a curl to unregistered `/totally-fake`**
  → endpoint RED naming `docs/bite-fixture.md:L6`, caught by the derived scan
  set. Removed → green.
- The `.fyi` scan even caught my own explanatory comment quoting the domain in
  `workspace.js` — reworded. It reads content, not filenames.

Family suite green on the branch (no collateral): `client-default-url-truth`
(now carrying the runner describe), `docs-endpoint-truth`, `docs-reachability`,
`docs-contributor-accuracy`, `docs-inventory-accuracy`, `docs-env-table`,
`installer-truth`. Full `npm run test:unit` result recorded in the commit message.

## Ownership

The runner package's platform wiring was unowned (checked against queue-done +
drafts 84–99): 42 owns sdk/mcp client-package docs, 37 admin-claude/, 39
runner+printer boot smokes and printer-drone's mock-`.fyi` default (that file
untouched), 40's endpoint gate scanned README+CONTRIBUTING only (this branch
extends that gate — the extension this brief assigns), 85 npm identity, 94 the
API reference. Nothing outside runner/ + docs/ + the two gates was modified
except `docs/runner-setup-macos.md` (the doc this brief names).

## Flags for Gilbert (no action taken — outside this concern)

1. The wizard still hands every agent session `MYCELIUM_ROLE: 'admin'` and the
   ADMIN key via MCP env (`setup.js` agent env block; `config.railway.json`
   uses a scoped agent key for its bot, but the wizard path does not). Where
   the key is *sent* is now correct; how *broad* the key the runner passes to
   agent sessions is, is a separate question.
2. `admin-workspace/CLAUDE.md` still teaches plans #14–19 and a 2025-era roster
   to whichever agent boots in that workspace. Stale, but not platform truth —
   left for whoever owns the admin-bot template.
3. Master moved `f8448af` → `69b05a6` between survey and execution; every line
   cite was re-derived on the day and all held.

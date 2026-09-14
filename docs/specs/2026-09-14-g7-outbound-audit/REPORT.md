# G7 + G8 — platform side: the 41 dependabot alerts and the outbound audit

Lane F-mycelium, task 204 · 2026-09-14 · branch `m5max/204-dependabot-and-outbound`
(base `0a5f4a3`, commit `7d9674b`) · worktree `~/Projects/_wt/mycelium-204` · **no push, no deploy**.

Bars, written before the run (PROGRAM-production-ready-2026-09-13.md):
**G7** — zero unexplained outbound connections; a written list of the explained ones.
**G8** — 0 high dependabot; every finding closed or documented.

---

## G8 — dependabot triage and fix

### Verdict: **PASS — 0 high (0 open of any severity at the version level), gate green.**

Source: `gh api repos/SoftBacon-Software/mycelium/dependabot/alerts --paginate` — 139 rows
total; **41 open** (14 high / 23 medium / 4 low — exactly the brief's numbers), 97 fixed,
1 dismissed (historical). The open set, deduped to 9 distinct packages across 3 manifests
(root `package-lock.json` = the workspace tree, `mcp/package-lock.json` = the standalone
published server, `admin-claude/package-lock.json`):

| package | severity (count) | manifests | prod/dev | reachable from the running server? | fix applied | after |
|---|---|---|---|---|---|---|
| fast-uri | **high** (10) | root, mcp | prod — via `ajv`/`ajv-formats` under `@modelcontextprotocol/sdk` (schema validation on the MCP surface) | yes, when MCP requests validate schemas | root override `^3.1.6` (lockfile was stale at 3.1.5); mcp overrides block added | 3.1.7 |
| multer | **high** (3) + low (1) | root | prod — **direct dep**, file-upload middleware on the express API | yes, HTTP-exposed | direct bump `^2.1.0 → ^2.3.0` | 2.3.0 |
| ip-address | **high** (1) + medium (2) | mcp | prod — via `express-rate-limit` (SDK) and `mqtt→socks` (printer-drone, root) | rate-limiter path: yes; drone: when printer-drone runs | mcp override: ip-address at v10.3.1 or later (caret range) | v10.7.0 (mcp), v10.3.1 (root, already patched) |
| hono | medium (12) + low (1) | root, mcp | prod — MCP SDK's HTTP transport (+`@hono/node-server`) | only when the MCP HTTP transport is served | overrides raised `^4.12.34 → ^4.13.5` (root + mcp) | 4.13.7 |
| qs | medium (6) | root, mcp, admin-claude | prod — express query parsing; also `googleapis-common`; dev-only via `supertest→superagent` | yes, every request with a query string | overrides `^6.16.0` added (root, mcp, admin-claude) | 6.16.0 |
| @hono/node-server | medium (1) | mcp | prod — MCP SDK HTTP transport | same as hono | mcp override `^1.19.15` | 1.19.17 (mcp); root already on the 2.x line (pre-existing override) |
| body-parser | low (2) | mcp, admin-claude | prod — express body parsing | yes, every JSON/form body | mcp override `^2.3.0`; admin-claude `^1.20.6` (stays on the express-4 1.x line) | 2.3.0 / 1.20.8 |
| vitest + @vitest/mocker | medium (2) | root | **dev-only** — the test runner | no — never shipped | direct devDep `^4.1.7 → ^4.1.11` | 4.1.11 |

### Before / after counts

| | before | after |
|---|---|---|
| high | **14** | **0** |
| medium | 23 | 0 |
| low | 4 | 0 |
| total open | **41** | **0** |

(Before/after computed against each advisory's vulnerable range and first-patched
floor from the alert export, applied to the resolved lockfile versions. The alerts
clear on GitHub when the director merges + pushes; this branch is where they clear.)

### Notes for the record

- The root `overrides` block predated the lockfile: `npm install` had silently kept
  fast-uri 3.1.5 under the new 3.1.6 floor. `npm update fast-uri` forced re-resolution.
  This is the one mechanism that turns "override merged" into "alert still open" —
  a lockfile that predates its own override map.
- mcp/admin-claude had **no** overrides at all; they were regenerated standalone
  (`npm install --workspaces=false` from inside `mcp/` — npm 11 redirects a bare
  install inside a workspace to the root, which was a live trap during this work).
- `mcp/package-lock.json` is maintained **lockfile-only** (`npm install
  --package-lock-only`): a full install there creates a nested `mcp/node_modules`
  that the root's `@modelcontextprotocol/sdk: ^1.30.0` override then flags invalid.
  Verified byte-identical between the two modes before committing.
- `npm audit --omit=dev --audit-level=high` (the repo's own gate): **found 0
  vulnerabilities**. Full `npm audit`: **found 0 vulnerabilities**.

### Gate output (verbatim, final run after all bumps)

```
npm test → EXIT=0
 Test Files  135 passed (135)
      Tests  1216 passed | 1 skipped (1217)
ℹ tests 72
ℹ pass 72
ℹ fail 0
ℹ duration_ms 6423.910917
npm run lint → EXIT=0 — "✖ 336 problems (0 errors, 336 warnings)" (cap 338)
```

### Census of the reds seen on the way (all pre-existing, none owned by this diff)

6 full `npm test` runs tonight (1 at base, 1 after the high bumps, 4 after the
medium/low bumps). Four reds, four DIFFERENT pre-existing files, three distinct
mechanisms, every one passing in isolation and none in any bumped package's import
path:

1. `plugins/semantic-memory/test.js:1351` — wall-clock throughput bound (6796 ms vs
   1380 ms) — fired while my own foreground greps loaded the machine (the 09-04
   load-flake census class).
2. `test/unit/mdns-wait.test.js:101` — wall-clock lower bound, "expected 1 ≥ 2" —
   the same file the 09-04 census documents red 2/16 at master.
3. `test/unit/context-bulk-write.test.js:169` — expected `[]`, got `{}` —
   `listContextKeys` returns better-sqlite3 `.all()`, structurally always an array;
   the mismatched body is cross-talk under fork-pool contention, impossible from
   this route's code.
4. `test/unit/docs-inventory-accuracy.test.js` — ENOENT mid-walk, 12 tests lost
   (1217→1205): `auto-merge-high-risk-gate.test.js` `afterAll` `rmSync`s its
   transient `fixtures/auto-merge-gate/` while docs-inventory's module-load walk is
   inside it. A filesystem race between two existing tests, exposed by load.

Final run: fully green (above). The four mechanisms are brief-worthy fixes for a
future lane, not this one.

---

## G7 — outbound audit of the running platform

### Verdict: **PASS — zero unexplained outbound; one LAN-local behavior (mDNS, opt-out-able); every network-capable surface is opt-in and provably dormant on the stranger regime.**

Method (script + raw artifacts in this directory, `run-artifacts/`): platform
started fresh on the **stranger regime** — throwaway `ADMIN_KEY`/`JWT_SECRET`,
`DATA_DIR` = a new mktemp dir, only the SQLite the server seeds itself, port 3457,
no other env. Sampled with `lsof -a -i -n -P -p <server + direct children +
dns-sd registrar>` at 1 Hz across boot, all legs, and a 60 s idle window (55–61
samples per run; two runs).

Smoke legs all green against the fresh seed: `/health`; agent list; project +
two agents created (keys returned); **memory round trip** (context key write →
read-back, project-scoped); **semantic search with no embedder configured**;
**one agent conversation** A→B→A with both directions authenticated as the sending
agent and retrieved; task create + list.

### The outbound table

| destination | proto/port | when | why | default? | off switch |
|---|---|---|---|---|---|
| 224.0.0.251:5353 (LAN multicast, via the OS mDNSResponder — the platform's `dns-sd -R _mycelium._tcp` child holds NO INET sockets of its own) | UDP | boot, continuously | advertises `_mycelium._tcp` so other LAN boxes can discover the platform | **on** | `MYCELIUM_NO_MDNS` (also off automatically on non-macOS/Linux without avahi) |

**That is the entire network-emitting behavior of a fresh box.** Every other
socket the process tree held, in every sample, was the inbound API listener
(`TCP *:3457` — loopback and LAN inbound, the product itself). No DNS lookups
from node, no telemetry, no update checks, no phone-home of any kind.

### Network-capable surfaces, all opt-in, all observed dormant

| surface | trigger on a fresh box | evidence this run |
|---|---|---|
| email (Resend) | `RESEND_KEY` set | boot log: `email: RESEND_KEY not set — email disabled` |
| semantic-memory embedder | `embedding_provider` config (ollama/openai/custom URL) | search leg degraded honestly: `embedding_provider = none` → keyword fallback, **zero calls** |
| auto-memory LLM (extraction + 6 h consolidation timer) | `llm_provider` config | provider defaults to `'none'` — skip path confirmed in code and by zero traffic |
| frontier APIs (`@anthropic-ai/sdk`, openai) | an agent/LLM config naming them | none configured; zero traffic |
| TURN relay | `TURN_SECRET` set to a relay's shared secret | boot log: unset → per-boot random secret; no relay contacted, credentials stay local (the 09-13 fix) |
| patrol timer | `patrol_enabled` instance config | off on fresh seed; no patrol lines in boot log, no traffic in 60 s idle |
| marketing/outreach discoverer, X/Twitter | plugin rows / explicit API calls | not exercised; code paths only fire on their routes |
| github routes | per-request proxy | not exercised; zero traffic |
| background timers (rate-limit sweep, cache prune, file TTL, stale-claim sweep) | always on but **DB-local only** | no sockets in any sample; their 5–10 min cadences exceed the 60 s idle window, so "no outbound" here is from reading the sweep code, not from watching a firing |

### Customer-regime caveats (honest edges, none break the bar)

- mDNS is **on by default** and is LAN-local by nature. For a cloud/NAT deploy the
  code already logs and skips it via `MYCELIUM_NO_MDNS`; G1's install script should
  make that choice explicit per deployment shape.
- The embedder, once a customer configures one, points at THEIR chosen URL
  (ollama defaults to `localhost:11434`). Data-stays-in-building then equals
  "the embedder you picked is in the building" — a config review item for G1/G10,
  not a platform defect.
- lsof sees socket opens, not packet emission: mDNS packets go out under the
  system daemon's socket, which is why the table names it by process + code path
  (`server/lib/mdns-advertise.js`) rather than a captured socket row.

---

## Provenance

- Branch `m5max/204-dependabot-and-outbound` @ `7d9674b` on `0a5f4a3` — 6 files
  (2 manifests + 2 lockfiles + admin-claude pair), lint clean, suite green.
- Audit run twice (v1 found the dns-sd/inbox gaps; v2 is the record), artifacts in
  `run-artifacts/` (boot log, lsof samples, legs transcript, nettop cross-check;
  test-instance `dvk_` keys scrubbed — the instance and its SQLite died with the run).
- Platform identity on the audited run: `/health` reported `commit_sha: 7d9674b`.

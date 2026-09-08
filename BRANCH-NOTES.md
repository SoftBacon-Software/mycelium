# BRANCH-NOTES — test/m5max/installer-success-output-truth (brief 158)

Lane F-mycelium, 2026-09-05. ONE commit on master tip `69b05a6` (origin/master
`a94b12d` is 2 behind local — expected). Worktree
`/private/tmp/myc-installer-success-truth` (node_modules symlinked).
**NEVER pushed, no PR, nothing deployed.** Left for review.

## The premise, re-derived on execution day (all confirmed on 2026-09-05)

The installer's SUCCESS summary — the last thing a stranger reads — taught a
dead dashboard first and a dead docs URL last. Master `69b05a6` still carries:

- old `:208` + `:216` — `http://localhost:$PORT/studio/` printed twice (SPA
  retired 2026-06, `7d13710`; CONTRIBUTING:19-22 and the root CLAUDE.md both
  say there is no bundled dashboard). Live receipt this walk: **GET /studio/ →
  HTTP 404 on the very boot whose success output printed it**.
- old `:225` — `Docs: https://mycelium.fyi/docs` → live **404** on 2026-09-05
  (`curl -sIL`, both `/docs` and `/docs/`; site root serves 200). A URL the
  repo does not control, pointing at a path that does not exist.
- old `:217-221` — the admin curl `POST /api/mycelium/studio/users` IS a live
  route (`server/routes/studio.js:63`; verified live 2026-08-27 and again this
  walk: **verbatim copy-paste → HTTP 200, operator id 1 created**).

## What landed

`tools/install.sh` — success block only (old :199-227). Deliberately untouched:
the header usage URL (old :3-4, brief 120's surface), the Node-floor strings
(old :36/:63-66, brief 92 owns the floor decision; 92 unlanded on
`docs/m5max/node-version-floor-truth`, so the "Node 18+" value stands), and
the preflight/canonical logic (brief 88's landed surface).

1. Dropped the `Dashboard` summary line and the "Open the dashboard" step.
2. Promoted the admin-creation curl to **step 1**, worded per CONTRIBUTING's
   operator story, promising no UI: *"Create your admin operator account over
   the API (there is no bundled dashboard):"*. The `changeme` password in the
   payload is left as-is (not this brief's class — see decision rows).
3. MCP step renumbered to step 2.
4. Docs line → `https://github.com/SoftBacon-Software/mycelium/tree/master/docs`
   — repo-controlled (the tracked `docs/` tree, 14 files at master), live 200.

**Drive-by repair in the same lines (found by the walk, not by the brief):**
the three curl continuation lines printed a LITERAL `\033[0m` — `\\${NC}`
inside double quotes collapses to `\` + `\033[0m`, which `echo -e` reads as an
escaped backslash, swallowing the color reset and orphaning the line-
continuation `\` (no longer adjacent to the newline). A stranger copy-pasting
the block got `\033[0m` as a stray curl argument and a broken continuation.
Fix: reset BEFORE the escaped backslash (`...users${NC} \`) so the `\` renders
last. Now a terminal copy-paste of step 1 executes as printed (receipt below).

`test/unit/installer-truth.test.js` — extended in place (88's file, no fork,
**no new test file → no test-file-count bump anywhere**), new describe
"installer success output truth", 6 tests + 1 opt-in:

1. **Retired-surface ban** (hermetic): no OUTPUT line may teach the retired
   SPA path. Scoped twice — to lines that produce output (`echo`/`printf` +
   the `info`/`ok`/`warn`/`fail` helpers, not comments) and to the SPA PATH
   not the word: `/api/mycelium/studio/*` is the live studio.js JWT/user
   module and stays legal (the 126 naming-trap discipline, asserted
   explicitly by its own calibration test).
2. **Route existence**: every `/api/mycelium/...` path an output line cites
   (host-qualified or bare; method from `-X`/prose prefix, default GET) must
   be registered by the live app. **Derivation chosen: `test/refactor/
   app-routes.mjs`** — the same live no-listen build docs-endpoint-truth.test.js
   uses (root + sub-router + plugin routes, `:param`-aware; captures WITHOUT
   binding a port, so it composes with the docs gate building concurrently).
   Chosen over `route-manifest.snapshot` because it reds on rename/delete with
   no snapshot-refresh coupling. The bare API base `/api/mycelium` is the
   mount pointer, not a route — excluded, or the API summary line false-reds
   (verified: no `GET /api/mycelium/?` entry exists in the 392-route dump).
3. **External-URL allowlist** (hermetic): every non-localhost http(s) URL the
   script prints must appear in `ECHOED_EXTERNAL_URLS`, set-equality both ways
   (stale entries die too), every entry carrying `{ verified: 'YYYY-MM-DD',
   receipt }` — an undated/future-dated/receipt-less entry is rejected BY the
   gate. `MYCELIUM_NET_CHECK=1` re-verifies all entries live (git ls-remote
   for `.git` targets, `curl -sIL < 400` otherwise) — the same switch brief
   120 specifies; **120 is unlanded, so there was no helper to reuse**; the
   second lander should converge on one switch/helper.
4. **Escape-leak ban** (hermetic, the drive-by's gate): no output line may
   match `\\\$\{?\w` (escaped backslash immediately followed by an expansion
   — the exact defect signature). Named-hole honesty: this catches the
   `\\${VAR}` shape, not every conceivable escape leak.

## Red-first receipts (gates run against unmodified script bytes, 2026-09-05)

- Ban → RED naming `L208` + `L216` (both `/studio/` echoes).
- Allowlist → RED: `https://mycelium.fyi/docs` echoed-but-unlisted AND
  `tree/master/docs` listed-but-not-yet-echoed.
- Escape gate (added after the walk) → RED on the three `\\${NC}` lines.
- Route-existence GREEN on master — `POST /api/mycelium/studio/users` is
  genuinely registered; the gate's first green is itself the premise check.
- (Extractor bug caught by the first red run: localhost URLs were leaking into
  the external set — fixed before the script was touched; red-first against a
  known-bad target is also how the gate gets debugged.)

## Bites (each run once, then restored; all other tests stayed green)

1. Re-add `Dashboard: .../studio/` echo → ban RED.
2. Echoed path → `/api/mycelium/studio/usersx` → route gate RED
   (`POST /api/mycelium/studio/usersx <- L216`, method-aware).
3a. Docs line → `https://example.com/mycelium-docs` → allowlist RED.
3b. Same + entry added with `verified: ''` → entry-format gate RED.
3c. Entry with date + receipt → accepted (only the stale set-equality side
   stayed red, proving the dated entry passed).
4. Re-introduce `\\${NC}` on the Health line → escape gate RED only.

## Live receipts (2026-09-05, the stranger walk)

`bash tools/install.sh` end-to-end as a stranger: scratch dir, `PORT=3102`,
`MYCELIUM_NO_MDNS=1`, fresh clone from **origin** (public `a94b12d` — the real
stranger path), `/health` green, `db_ok true`. Then every printed instruction
was followed verbatim:

- Step 1 curl, copied exactly as rendered (indent + continuations) → **HTTP
  200** `{"id":1,"username":"admin",...}` — operator created.
- Step 2 `git clone .../mycelium-mcp.git && npm install` → OK, entry resolves.
- Docs URL → **200**. `GET /studio/` → **404** (dead-surface receipt).
- Both printed Stop lines (`kill 8409`, `kill 10879`) stopped the server;
  installer exited 0.
- Log artifact: `/tmp/158-stranger-walk/install.log` (scratch — the durable
  receipts are the committed gate + this file).

Allowlist URL verification (all 2026-09-05): git-scm.com 200, nodejs.org 200,
github issues 200, mycelium-mcp.git ls-remote exit 0, tree/master/docs 200;
mycelium.fyi/docs 404 (the removed line).

## Landing interactions (the important part)

- **⚠️ Brief 119 (`test/m5max/operator-scripts-teach-live-surfaces` @
  `e3ddec6`, UNLANDED) rewrites THE SAME success block.** Its design DROPS the
  studio/users curl (reroutes operators to `tools/onboard-agent.sh` + agent
  onboarding) and does NOT touch the dead Docs line (mycelium.fyi/docs
  survives on its branch). This branch keeps the operator story per this
  brief's spec (promote the curl to step 1) and fixes the Docs line. **These
  are two different "Next steps" designs on the same lines — a semantic
  conflict, not just textual.** Whichever lands second rebases by hand.
  Compat note: this branch's taught `POST /api/mycelium/studio/users` IS in
  route-manifest.snapshot (line 220), so 119's operator-scripts gate would not
  cross-red it.
- **Brief 120 (`test/m5max/install-one-liner-served-truth` @ `1b7a38f`,
  UNLANDED)** touches this same FILE at the header comment (:3-4) plus a
  2-line comment edit in installer-truth.test.js — different hunks, either
  rebase order works. Its `MYCELIUM_NET_CHECK=1` switch is the same name this
  branch uses; converge on one helper at landing.
- **Brief 88 (landed)**: this EXTENDS installer-truth.test.js, does not fork
  or weaken it; its 5 tests and ALLOWED_REFS untouched.
- **Brief 92 (unlanded)**: Node-floor strings left at "Node 18+"; match 92's
  decision when it lands.
- No test FILE added → no 91/92/93 test-file-count bump; the landing-count
  collision recorded against 90/92/106/111/119/120 does not grow here.

## Decision rows for Gilbert

1. **Operator step design (119 vs 158).** Teach operator creation over the API
   (this branch, per the brief and CONTRIBUTING) or drop it for agent
   onboarding (119)? They are not mutually exclusive (1 operator, 2 onboard
   agents, 3 MCP) but only the landing decision can pick.
2. **`changeme`.** The taught admin password is a placeholder a stranger may
   keep. Out of this brief's class; somebody should own it.
3. **Docs pointer.** `tree/master/docs` is repo-controlled and live-verified;
   a rendered docs site (if the site ever grows /docs again) would be nicer —
   the allowlist makes switching it a dated, receipted act.
4. **Net-check switches.** Two gates now specify `MYCELIUM_NET_CHECK=1`
   (120's byte-compare, 158's URL check). One switch, two gates — fine; one
   helper would be better.

## Suite

vitest + workflows plugin node:test: see the lane's DONE report for the
measured numbers on this branch (run from inside the worktree; the foreign-cwd
vitest run is a known method trap).

# Legacy hardening pass — July 11, 2026

A retiring-senior sweep of the platform daemon: find the durable reliability /
security debt on the load-bearing paths and either fix it (small, verifiable,
non-breaking) or write it down here with enough context that the next
maintainer doesn't have to re-derive it at 2am. Companion to
`audit-2026-07-core-hardening.md` (the June 30 / July 1 drive).

## What landed in this pass

| Change | Files | Why it matters |
|---|---|---|
| **Plugin-router async-rejection guard at the mount seam** | `server/plugins.js` (`guardPluginRouter`, `wrapAsyncErrors`) + `test/unit/plugin-router-async-guard.test.js` | Express 4 does not forward rejected promises from `async` handlers to the error middleware, and `index.js` deliberately exits the process on `unhandledRejection`. One missing try/catch in ONE plugin route therefore killed the whole daemon — it shipped twice (semantic-memory `/reindex` + `/backfill`, fixed per-instance in `92b6873`) and was still live on `/search`. The guard wraps every plugin handler at mount time, closing the class for all current AND future/third-party plugins. Fail-open: unrecognized router shapes are mounted untouched. |
| **semantic-memory `POST /search` wrapped** | `server/plugins/semantic-memory/routes.js` | The hottest memory endpoint (smart-boot, `mycelium_memory_search`) was a naked `async` handler — only the embedding call was try/caught; a throw from `searchKeyword`/`searchHybrid` crashed the daemon. Now uses the file's own `asyncHandler` (belt) in addition to the seam guard (suspenders). |
| **video-pipeline `/sessions/:id/captions` de-async'd** | `server/plugins/video-pipeline/routes.js` | The handler awaited nothing; on Express 4 a gratuitous `async` converts a *catchable* sync throw into a fatal rejection. Watch for this anti-pattern in review: `async` on a handler with no `await` is strictly worse than sync here. |
| **studio-login username-enumeration timing oracle closed** | `server/routes/mycelium.js` (`DUMMY_PASSWORD_HASH`) | Unknown-username logins returned in ~0ms (no bcrypt) vs ~60ms+ for wrong-password (bcrypt 10 rounds) — a timing oracle for enumerating operator usernames. Unknown users now pay a dummy bcrypt compare. Response bodies were already identical. |
| **`POST /studio/login` test coverage** | `test/unit/studio-login.test.js` | The operator-auth front door had zero direct tests. Now pinned: JWT claim shape (`studioUser`, `role`, 7d expiry), `/studio/me` round-trip, username trim+case normalization, identical generic 401s, the bcrypt timing floor, and the 429 + `Retry-After` brute-force contract. |
| **`TRUST_PROXY` env knob** | `server/index.js`, `.env.example` | `trust proxy` was hardcoded `true` (needed on Railway). On a DIRECT-exposed instance that lets any client spoof `X-Forwarded-For` and rotate per-IP rate-limit identities (login brute-force, agent-key guessing, unbounded `_rateLimitStore` growth). Default unchanged; direct deployments should set `TRUST_PROXY=false`. |
| **Doc truth sweep** | `CLAUDE.md`, `.claude/CLAUDE.md`, `server/db.js` comments | Test counts (147 → 274), plugin counts (17 → 14 + `_template`; `appointments/` has no manifest and silently skips), removed the nonexistent `server/provisioning.js` from the layout, flagged the billing/provisioning section as historical, and corrected the `archiveOld*` comments — they DELETE, they do not archive. |

Verification: `npm test` green before and after every change — 260 → 274
tests (38 → 40 files), zero failures. No behavior change to any existing
passing path; all changes are additive guards, docs, or new tests.

## Prioritized handoff — known debt NOT landed (deliberately)

Ordered by risk-if-left × effort-to-fix. None of these are safe to land
unilaterally: each changes visible behavior or deletes data, so they need an
operator decision.

### 1. `events` / `messages` tables grow unbounded between manual cleanups
`archiveOldEvents` / `archiveOldMessages` (db.js) only run from
`POST /admin/cleanup` — nothing calls them on a schedule. The daily
maintenance timer in `index.js` prunes webhook deliveries, context history,
savepoints, and password-reset tokens, but NOT events/messages. The events
table has already flooded once (18M rows / 3GB; root cause — persisted
heartbeats — is fixed, but ordinary event volume still accumulates forever).
**Recommendation:** add opt-in env vars (e.g. `RETENTION_EVENT_DAYS`,
`RETENTION_MESSAGE_DAYS`, unset = current keep-forever behavior) and wire them
into the existing daily timer. Not landed because these functions DELETE rows
— silently enabling data deletion on a timer is an operator decision.
**Also:** rename them (`deleteOldEvents`) or keep the corrected comments —
the "archive" name has already misled at least one reader.

### 2. Rate limiting is IP-keyed and the default trusts any proxy header
Even with the new `TRUST_PROXY` knob, the *default* remains `true`, so a
direct-exposed instance that doesn't set the env var still has spoofable
per-IP limits, and each spoofed IP creates a `_rateLimitStore` entry (pruned
every 5 min, so bounded in time but spiky in memory). The canonical local
instances (`:3002`, Jetson) are direct-exposed.
**Recommendation:** set `TRUST_PROXY=false` in the launchd/systemd env of
direct deployments now; consider flipping the *default* to `false` with a
Railway-specific override in a future breaking-change window (Railway sets
`RAILWAY_ENVIRONMENT`, detectable).

### 3. Forgot-password limiter is keyed on attacker-controlled input
`forgotPasswordLimiter` keys on `req.body.email` (3/15min per email) — good
per-victim protection, but an attacker rotating emails gets unlimited
attempts and, for every address that matches a real operator, an outbound
Resend email (cost + spam-reputation amplification).
**Recommendation:** add a second, IP-keyed limiter on the same route (e.g.
10/15min/IP) — one line with the existing `rateLimit` helper — plus a global
daily cap on reset emails if Resend cost matters.

### 4. `checkVoiceAuth` / file-drone WS auth do a raw DB lookup per request
`server/index.js` voice endpoints and the file-drone WS upgrade hash the
presented agent key and hit `agents` directly, bypassing the bounded
`agentKeyCache` + failed-attempt limiter that `checkAgent` has. Low traffic
today, but it's the only auth path without brute-force accounting.
**Recommendation:** export a thin `verifyAgentKey(key)` from
`routes/mycelium.js` (cache + rate-limit included) and use it in both places.

### 5. `.claude/CLAUDE.md` needs a full sweep, not spot fixes
This pass corrected the counts and flagged billing/provisioning as
historical, but the file still describes retired surfaces (customer
instances, waitlist, churn lifecycle) as if live. It's gitignored
(local-only), yet it is the first thing every AI session reads — stale claims
there become confident wrong actions. Budget a dedicated pass.

### 6. Express 5 migration would delete the whole guard class
Express 5 forwards async rejections to error middleware natively; the
`asyncHandler` sites and `guardPluginRouter` become redundant (harmless, but
removable). When the dependency window opens, migrating deletes ~all of this
machinery. Keep `test/unit/plugin-router-async-guard.test.js` — it passes
either way and pins the contract that matters (rejections never escape).

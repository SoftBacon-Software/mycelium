# Core follow-up audit — July 2, 2026

A second, code-verified security + reliability pass over the Mycelium core,
**building on** the June 30 / July 1 hardening drive (`docs/audit-2026-07-core-hardening.md`,
PRs #142–151) and the subsequent drone-RCE (#154), residency (#153), SSRF-propagation
(#152), and eslint-correctness-gate (commit `560d31c`) landings.

Goal: find what the drive **missed**, verify the **deferred M2/M5** items, and surface
new real bugs — adversarially, against the **current tree** (`chore/eslint-adoption`
= `master` + the eslint commit; nothing behind `origin/master`). Every finding below
was traced to source and reachability-checked; each was independently re-verified at the
byte level (not taken from a survey pass on faith). Speculative/latent items and
verified-clean surfaces are recorded separately so the next pass can build on them.

**Method:** four parallel deep-survey passes (SQLi · SSRF/files · authz-coverage ·
correctness/reliability), each finding then re-verified directly against the working
tree, plus empirical checks of the two deferred items.

---

## Crash multiplier (read this first — it re-weights every reliability finding)

`server/index.js:8-11`:
```js
process.on('unhandledRejection', (reason) => {
  process.stdout.write('[FATAL] unhandledRejection: ' + ... );
  process.exit(1);
});
```
**Any** unhandled promise rejection anywhere in the process kills the whole daemon —
not a hung request, a full-platform outage. Combined with Express 4 (which does not
catch async-handler rejections) and the fact that **plugin routers are mounted raw**
(`plugins.js:312`, `router.use(prefix, pluginRouter)` — no `asyncHandler` wrapper),
every un-try/caught `await` in a plugin route is a latent daemon crash. This is why
R1 is rated HIGH.

---

## Severity summary

### Security
| # | Finding | File:line | Severity | Reachable by |
|---|---|---|---|---|
| S1 | Arbitrary file read → full DB / secret exfiltration via asset download | `routes/mycelium.js:2669,2673,2704-2710` | **CRITICAL** | any agent key |
| S2 | SSRF guard defeated by redirect-follow + DNS-rebind (systemic) | `lib/ssrf-guard.js` + `db.js:2297` (+5 sites) | **HIGH** | see notes |
| S3 | `/file-server/*` forwards agent path to drone, zero server-side validation | `routes/mycelium.js:6758-6838` | MEDIUM | any agent key |
| S4 | Task/bug `claim`: assignee-spoof via `req.body.agent_id` + no project scope | `routes/mycelium.js:1758,4676` | MEDIUM | any agent key |
| S5 | Widget `PUT`/`DELETE`: no owner/project scope | `routes/mycelium.js:2197,2205` | MEDIUM | any agent key |
| S6 | GitHub proxy lends server `GITHUB_TOKEN` to any agent (list route) | `routes/mycelium.js:6299,6295,6304` | LOW-MED | any agent key |
| S7 | Comment/deliverable `author` caller-controlled (attribution spoof) | `routes/mycelium.js:1805,1830,3345` | LOW | any agent key |

### Correctness / reliability
| # | Finding | File:line | Severity | Trigger |
|---|---|---|---|---|
| R1 | Unwrapped plugin async handlers → daemon crash (reindex/backfill on openai) | `plugins/semantic-memory/routes.js:319,389` | **HIGH** | admin reindex + provider=openai + any embed error |
| R2 | Approval-vote quorum flattened → multi-human quorum unreachable | `routes/mycelium.js:5742` + `db.js:3155` | MEDIUM | any approval with `required_approvals > 1` |
| R3 | `upsertContextKey` merge corrupts arrays / silently drops scalar writes | `db.js:884` | MEDIUM | any agent storing array/scalar context keys |
| R4 | `PUT /drones/jobs/:id`: no status-transition guard → duplicate retry jobs | `routes/mycelium.js:5191-5299` | MEDIUM | flaky drone re-reporting `failed` |
| R5 | No scheduled retention for `events`/`messages` (+ `pruneSavepoints` arity no-op, secondary tables) | `index.js:378-401`; `routes:3618`; `db.js:3572` | MEDIUM | normal operation (slow burn) |
| R6 | `GET /admin/health` performs state-mutating writes | `routes/mycelium.js:6708` | LOW | any agent key |
| R7 | Approval events double-stringify `data` + reference nonexistent `approval.project` col | `routes:5717,5719,5733,5735` | LOW | every approval decision |
| R8 | `PUT /tasks/:id` done-cascade not idempotent (repeat inflates counter, re-fires) | `routes/mycelium.js:1663` | LOW | repeated `status:done` PUT |
| R9 | Non-`.unref()`'d timers in `index.js` | `index.js:375,378,476,598` | LOW | embed/test lifecycle |

**Deferred M2 (SSE double-stringify)** and **M5 (bare parseInt)**: both re-verified as **correctly deferred — not bugs.** Details below.

---

## CONFIRMED FINDINGS — Security

### S1 — CRITICAL — Arbitrary file read → full database / secret exfiltration via asset download
**Reachable by:** any valid `X-Agent-Key` (lowest-privilege authenticated principal). No upstream guard, no project scope, no ownership check.

Directory constants (`routes/mycelium.js:67-90`): `DATA_DIR = server/data` (parent); `FILES_DIR = server/data/files`; `ARTIFACTS_DIR = server/data/drone_artifacts`. `server/data/` also holds **`mycelium.db`** (whole store, 91 MB live), `-wal`/`-shm`, `backups/`, `*.log`.

- `POST /assets` (`:2623`) and `PUT /assets/:id` (`:2661`) — both `checkAgentOrAdmin` — set `path` (`:2669`) and `file_path` (`:2673`) **verbatim from the body, unvalidated**.
- `GET /assets/:id/download` (`:2697`, `checkAgentOrAdmin`):
  ```js
  var filePath = asset.file_path || nodePath.join(FILES_DIR, asset.path);            // :2704
  var resolved = nodePath.resolve(filePath);                                          // :2705
  if (!resolved.startsWith(resolve(FILES_DIR)) && !resolved.startsWith(resolve(ARTIFACTS_DIR))
      && !resolved.startsWith(resolve(DATA_DIR))) return 403;                          // :2706
  res.download(resolved);                                                             // :2710
  ```
  **`DATA_DIR` (the parent) is in the allowlist**, so any file directly under `server/data/` passes.

**Exploit (any agent key, 3 calls):** `POST /assets{name}` → id N; `PUT /assets/N {"path":"../mycelium.db"}` → `join(FILES_DIR,"../mycelium.db")` = `DATA_DIR/mycelium.db`, `startsWith(DATA_DIR)` → passes; `GET /assets/N/download` streams the entire SQLite DB. (`file_path` accepts an absolute path under `DATA_DIR` for the same result.) The DB contains, cleartext or offline-crackable: **`plugin_config` secrets (Stripe `stripe_secret_key`/`stripe_webhook_secret`, embedding/LLM keys), `webhooks.secret` (HMAC keys), `studio_users.password_hash` (bcrypt), `password_resets.token_hash`, every `agents.api_key_hash`.** The allowlist does block escaping *outside* `DATA_DIR` (`/etc/passwd`→403) — but the entire credential store lives inside it. Highest-impact hole found; the drive did not touch this endpoint.

**Fix-spec.**
1. Drop `DATA_DIR` from the download allowlist (`:2706`) — keep only `FILES_DIR`+`ARTIFACTS_DIR`. Verified safe: multer writes only to `FILES_DIR` (`:79`) / `ARTIFACTS_DIR` (`:93`), so legitimate downloads never reference anything else.
2. Add a trailing `path.sep` to each `startsWith` (`resolve(FILES_DIR)+path.sep`) to stop sibling-prefix escapes (`server/data/files-evil`).
3. On write (`:2669`,`:2673`), reject `..`/leading-`/` in `path` and absolute `file_path`; ideally make `path`/`file_path` **server-set only** (upload handler `:2692`), never `PUT`-writable.

### S2 — HIGH — SSRF guard defeated by HTTP-redirect follow and DNS-rebinding (systemic)
`lib/ssrf-guard.js` `assertPublicHost()` is otherwise solid — http/https-only, resolves + checks **every** A/AAAA record, blocks loopback/private/**169.254 metadata**/CGNAT/0.0.0.0/IPv6-ULA/link-local/v4-mapped, fails closed, catches decimal/octal literals. But two structural gaps defeat it (verified: **no** global `undici` dispatcher exists, so Node's default `redirect:'follow'` is active everywhere):

- **(2a) Redirect follow.** Guard validates only the initial host; the caller `fetch`es the original URL. A **public** URL that returns `302 Location: http://169.254.169.254/latest/meta-data/…` (or `127.0.0.1:3002/…`) is followed to the private target with no re-check. Reliable, no DNS control needed.
- **(2b) DNS-rebind TOCTOU.** Guard resolves DNS; `fetch` re-resolves the hostname independently. A low-TTL name can answer public to the guard, private to `fetch`.

**Guarded sites (guard present, all inherit 2a/2b):** `db.js:2297` webhook dispatch (guard `:2255`) — **response body stored** by `logWebhookDelivery` (`:2301`) and readable via `GET /webhooks/deliveries` = full SSRF read/exfil; `plugins/marketing/outreach/lib/researcher.js:88`; `plugins/workflow-automations/handlers.js:103`; `plugins/daily-digest/routes.js:173,245`; `plugins/a2a-gateway/routes.js:210,272`.

**Reachability calibration.** The most exfil-dangerous sink (webhooks) is `checkAdmin` to create (`:4962`) and read (`:4985`) — admin→admin, not low-priv; the researcher/automation/digest sinks are admin/operator-configured; a2a-gateway ships **disabled**. So **no confirmed low-priv exploit path in the current tree.** Filed HIGH because it *systemically* voids the drive's SSRF guarantee ("validated ⇒ safe to fetch" is false): any future call site with an agent-controllable URL, or a config change making one of these agent-reachable, inherits a live cloud-metadata-exfil hole with zero extra review.

**Fix-spec (one shared fix).** Install a custom `undici` `Agent` whose `connect`/`lookup` re-validates the resolved socket address on **every** connection (covers redirect hops + rebind), or set `redirect:'manual'` + re-run `assertPublicHost` per `Location` hop (capped), or resolve-once-and-connect-to-pinned-IP with an explicit `Host` header. Add the minor missing ranges to `isPrivateIP` (240/4, 224/4, 255.255.255.255) while there.

### S3 — MEDIUM — `/file-server/*` forwards the caller's path to the drone with no server-side validation
`POST /file-server/browse|search|info` and `GET /file-server/download|download-folder` (`:6758-6838`, all `checkAgentOrAdmin`) pass `req.body.path`/`req.query.path` **verbatim** to the drone via `sendFileDroneRequest`/`streamFileDroneDownload` (`index.js:624,658`). browse/search/info default to `path:'/'` (`:6765,:6782,:6798`) — the drone host's filesystem root. All sandboxing is delegated to the drone worker (out of this repo). If the worker doesn't sandbox, any agent key lists/reads/zips arbitrary files on the drone host. These back the `mycelium_file_browse/file_download/file_download_folder/file_search` MCP tools. **Fix:** reject `..`/NUL and require a relative path (or a configured root prefix) before forwarding; pair with a drone-worker path-handling review.

### S4 — MEDIUM — Task/bug `claim`: assignee-spoof + missing project scope
`POST /tasks/:id/claim` (`:1758`) and `POST /bugs/:id/claim` (`:4676`): `var agentId = req.body.agent_id || who;` then `updateTask/updateBug({assignee:agentId, status:'in_progress'})` with **no `checkProjectScope`** — unlike the `PUT` siblings (`:1628`,`:4688`). Any agent can claim/flip a task or bug in another project and set assignee to an arbitrary agent id (work hijack/misroute). Secondary: `updateTask` is an unconditional `UPDATE … WHERE id=?` (no `WHERE status`), so the claim is non-atomic — two agents both get `ok:true` (double-work), and a `done` task can be re-opened. **Fix:** ignore `req.body.agent_id` unless `req._authIsAdmin`; add `checkProjectScope`; make the claim conditional (`WHERE id=? AND (assignee IS NULL OR assignee='') AND status='open'`, 409 on `changes===0`).

### S5 — MEDIUM — Widget `PUT`/`DELETE`: no owner/project scope
`PUT /widgets/:id` (`:2197`) → `updateWidget(req.params.id, req.body)` and `DELETE /widgets/:id` (`:2205`) → `deleteWidget(req.params.id)` look the widget up **purely by id** with no scope check (`POST` at `:2188` correctly derives owner from auth). Any agent key can overwrite/delete any agent's dashboard widget (cross-agent integrity / cockpit DoS). **Fix:** load widget, `checkProjectScope`/owner check before mutate.

### S6 — LOW-MEDIUM — GitHub proxy lends the server `GITHUB_TOKEN` to any agent
`GET /github/prs/:owner/:repo` (`:6299`) is `checkAgentOrAdmin` — any agent key — while the mutating twins (`:6339` create, `:6317` merge) correctly require `checkAdmin`. `githubApi` (`:6283`) fetches `https://api.github.com`+`path` with the server's `GITHUB_TOKEN` (`:6289`); `path` is built from **un-encoded** `owner`/`repo`/`state` (`:6304`). Any agent can enumerate PRs on arbitrary repos under the server token (private-repo info disclosure if scoped) and inject extra path/query segments to reach other GitHub GET endpoints. **Fix:** require `checkAdmin` (or allowlist owner/repo); `encodeURIComponent` each segment.

### S7 — LOW — Comment/deliverable `author` is caller-controlled
`var author = escapeHtml(req.body.author || who)` at task-comment `:1805`, task-deliverable `:1830`, plan-step-comment `:3345` — persisted `author` comes from the body, not the authenticated principal (`emitEvent` actor correctly uses `who`). An agent can post attributed to any name. Audit-trail spoof, not privilege escalation. **Fix:** attribute to `who`; honor `req.body.author` only for `req._authIsAdmin` (pattern already at `:2078/:2188/:2350`).

---

## CONFIRMED FINDINGS — Correctness / reliability

### R1 — HIGH — Unwrapped plugin async handlers crash the daemon (semantic-memory reindex/backfill on openai)
`plugins/semantic-memory/routes.js:275` `POST /reindex` is `async function(req,res)` with **no `asyncHandler`** (plugin routers mount raw). Line **319** `var embeddings = await generateEmbeddingBatch(config, texts);` is at the handler's top level — verified **not** inside the surrounding `try` blocks (`:298` is the drone path that returns before 319; `:323` is inside the post-await loop). `/backfill-embeddings` (`:351`, await at `:389`) is identical. With `embedding_provider === 'openai'`, `embedOpenAIBatch` (`embeddings.js:141`) **throws** on missing key, HTTP ≥400 (`:152`), bad format (`:158`), or any `fetch` rejection (the ollama path catches per-item at `:77-83`; openai propagates). Unhandled rejection → `process.exit(1)` (see crash multiplier). **Whole platform down from a routine admin reindex during one API hiccup.** Config-gated: this instance runs ollama/local (dormant here), but it's the shipped public repo and any openai-configured deployment is exposed; the *class* (unwrapped plugin async handlers) is the finding. **Fix:** export `asyncHandler` on the `core` object (`routes:6263`) and wrap plugin handlers, or add per-plugin-router error-forwarding middleware; also make `embedOpenAIBatch` return nulls (like ollama) rather than throw.

### R2 — MEDIUM — Approval-vote quorum flattened → multi-human quorum unreachable
`routes/mycelium.js:5742` `var who = req.headers['x-admin-key'] ? '__admin__' : 'studio_user';`. `castApprovalVote` (`db.js:3155`) upserts `ON CONFLICT(approval_id, voter)`. So **every** JWT operator votes as the literal `'studio_user'` and every admin-key caller as `'__admin__'` (`X-Acting-As` ignored) — a second distinct human's vote **overwrites** the first, `countApprovalVotes` stays at 1, and any `required_approvals > 1` (the Medium/High/Critical risk tiers in the CLAUDE.md governance table) is **never reached** — the approval sticks pending forever, and attribution is lost. Fails *safe* (blocks, never over-approves), so it's a governance/correctness bug, not a privilege escalation. The deny path short-circuits so it's unaffected. **Fix:** `var who = getAdminDisplayName(req);` — the correct helper (`:617`) is already used two routes up at `:5715`.

### R3 — MEDIUM — `upsertContextKey` merge corrupts arrays and silently drops scalar writes
`db.js:884` (route `PUT /context/keys/:namespace/:key`, `:1904`): `merged = JSON.stringify(Object.assign({}, existingData, newData));`. All returning `{ok:true}`:
- existing+new both arrays → `Object.assign({},[1,2,3],[4,5])` = `{"0":4,"1":5,"2":3}` — array silently becomes an index-keyed object.
- new is a JSON scalar (`5`/`true`) → `Object.assign({},obj,5)` = obj unchanged — **the write is silently discarded**.
- new parses to a string → char-indexed keys merged in.

(Prototype-pollution sanitation is present and correct; this is the array/scalar merge shape.) Reachable by any agent updating array/scalar-valued context keys. **Fix:** only merge when both sides parse to plain non-array objects; otherwise replace.

### R4 — MEDIUM — `PUT /drones/jobs/:id`: no status-transition guard → duplicate retry jobs
`routes:5191` reads the job then `updateDroneJob(job.id, fields)` unconditionally (`db.js:2611`, `buildUpdate`, no `WHERE status`). The retry cascade (`:5242-5299`) fires whenever `fields.status === 'failed'` regardless of current status: a drone retrying its HTTP PUT after a timeout (or reporting `failed` twice) spawns **two** retry jobs (`createDroneJob` `:5269`) — double GPU work + webhooks; a stale drone reporting `failed` after the job is `done` flips it back and spawns a retry. Normal for flaky drone networks. **Fix:** no-op (200 echo) when `job.status === statusVal`; reject failed-after-done.

### R5 — MEDIUM — Missing scheduled retention (events/messages) + a broken cleanup call + secondary tables
- **events/messages grow unbounded by default.** `emitEvent` persists every non-heartbeat event (`:674`), incl. `agent_reasoning` (one per squad-loop turn, `POST /reasoning` `:1292`, persisted as training data). `archiveOldEvents` (`db.js:830`) / `archiveOldMessages` (`db.js:820`) are invoked **only** from the manual `POST /admin/cleanup` (`:3615-3616`); the daily maintenance timer (`index.js:378-401`) prunes webhook deliveries, context keys, context history, savepoints, reset tokens — **not** events or messages. Same shape as the documented 18M-row/3GB heartbeat flood, now driven by reasoning/lifecycle events. Both tables are indexed (`schema.sql:398-404`), so it's a disk/backup-size burn (the 6-hourly backup copies the whole DB), not a query cliff.
- **`pruneSavepoints` arity bug (wrong-argument cousin of the `db`/`getDB` class).** `routes:3618` `pruneSavepoints(eventDays)`, but the signature is `pruneSavepoints(agentId, keepCount)` (`db.js:3572`) → `agentId=60`, matches no agent, silent no-op, route reports `savepoints_pruned: undefined` inside a 200. Growth stays bounded by the daily `cleanupSavepoints(50)` (`index.js:394`), so impact is a broken admin surface + wrong report. **Fix:** call `cleanupSavepoints()` (the all-agents variant, `db.js:921`).
- **Secondary tables with no retention:** `operator_inbox`, `team_chat`, `approval_votes`, `runs`, `am_extraction_errors` (one row per failed extraction — a misconfigured auto-memory LLM writes one on every task-complete/request-resolve/context-update), and `drone_jobs` `job_type='embed'` rows (with `embedding_provider='drone'`, one per indexed message/task). `agent_spend` unpruned is plausibly by design (receipts).

**Fix-spec (R5 overall):** add `archiveOldEvents(60)` + `archiveOldMessages(90)` to the daily timer; fix the `pruneSavepoints` call; add opportunistic retention for the high-churn secondary tables (`am_extraction_errors`, embed `drone_jobs`).

### R6 — LOW — `GET /admin/health` performs state-mutating writes
`GET /admin/health` (`:6708`, `checkAgentOrAdmin`) calls `runHealthPatrol()`, which marks agents/tasks/requests/drones/steps stale (writes). Side-effecting GET, agent-reachable though documented admin-only. **Fix:** move mutation to a `POST`, or `checkAdmin`-gate the patrol and keep GET read-only.

### R7 — LOW — Approval events: double-stringified `data` + reference to a nonexistent column
Approval routes pass `JSON.stringify({approval_id,...})` as `emitEvent`'s `data` param (`:5719,:5735,:5756,:5769`); `createEvent` stringifies again (`:676`), so `events.data` is a JSON-encoded *string of a string* — consumers parsing `data.approval_id` get undefined. Also `:5717,:5733` read `approval.project`, but the `approvals` table has only `project_id` (`schema.sql:520`) → these events always carry `project_id:null`, so project-filtered SSE subscribers never see approval decisions. (`:6109` similarly passes a JSON blob as the `summary` positional.) **Fix:** pass the object (not a string) as `data`; use `approval.project_id`.

### R8 — LOW — `PUT /tasks/:id` done-cascade not idempotent
`:1663` runs the done-cascade on `fields.status === 'done'` without checking the task wasn't already done (`warnSuspectTransition` at `:1631` only warns): repeated PUTs inflate `total_tasks_completed` (`:1665`) and re-fire events/webhooks. The cascade DB work itself is transactional and roughly idempotent. **Fix:** skip the cascade when the prior status was already `done`.

### R9 — LOW — Non-`.unref()`'d timers in `index.js`
`index.js:375` (backup, 6 h), `:378` (daily maintenance), `:476` (voice WS ping, 10 s), `:598` (file-drone WS ping, 15 s) — plus transient backoffs `plugins.js:118`, `db.js:2307`. Impact limited because shutdown calls `process.exit()` explicitly, but they block natural event-loop drain (bites tests / anything embedding the server). Everything in `routes/mycelium.js` (`:27,:429,:4538,:4573,:6706`) and auto-memory is correctly unref'd — these are the ones the H7 sweep missed. **Fix:** `.unref()` them.

---

## Deferred items (M2 / M5) — re-verified

### Deferred M2 — SSE inner-`data` double-stringify → **correctly deferred (not a bug). CONFIRMED.**
`listEvents` (`db.js:669`) returns rows via `SELECT *` and does **not** `JSON.parse` the `data` column, which `createEvent` stores as a JSON string. So the replay path (`routes:2833`) and the live broadcast (`routes:2692`, `{...eventObj, data: JSON.stringify(eventObj.data)}`) both deliver `data` as a JSON string — a consistent wire contract. The inline note at `routes:684-690` is accurate. No action. *(Note: this is distinct from R7 — R7 is a caller passing an already-stringified object into `emitEvent`, a real triple-encode bug on the approval routes only.)*

### Deferred M5 — bare `parseInt(...)` → **correctly deferred (convention drift, not a vuln). CONFIRMED.**
Empirically verified better-sqlite3 binds `NaN` **silently to a non-match** (returns `undefined`), does not throw: `SELECT … WHERE id = ?` bound with `NaN`/`parseInt('abc')` → `undefined`. So a non-numeric id on a bare-`parseInt` route falls through to not-found — no crash, no injection (the SQLi sweep found zero string-concatenated LIMIT/id sites). Convention drift only.

---

## Surfaces verified CLEAN (build-on confirmation — do not re-audit)

- **SQL injection: none.** Full sweep of 378 `prepare(` in `db.js`, 42 in `routes`, and every plugin DB file — **0 confirmed / 0 suspected**. All attacker-influenced values reach SQLite via bound `?`; concat builds only structural fragments (whitelisted keywords, hardcoded column allowlists in `buildUpdate`/`incrementProfileCounter`, `?`-placeholder lists). The one user-driven dynamic `ORDER BY` (`workflows/db.js:159`, `?order=`) is a strict `==='asc'?'ASC':'DESC'` ternary. All LIMIT/OFFSET bound + clamped.
- **Auth bypass / missing-return: none.** ~160 `check*` sites verified — each immediately followed by an `if(!who)return;` guard. Only intentionally-public routes are unauthenticated (`/stats/public`, `/public/activity`, rate-limited login/waitlist/reset). Directive `req.body.from` bypass (`aa27716`) fully closed; `rekey` self-only; the entire admin surface (deletes, `/admin/config`, `/admin/override`, operator/studio-user CRUD, skill/plugin config, drone templates/profiles) correctly enforces `checkAdmin`.
- **`db` vs `getDB()` / undefined-var class: structurally closed.** eslint `no-undef` is an **error** over all `server/**/*.js` and the gate is green; the `:1173` fix (`560d31c`) was the last. `initDB()` runs once, so the `stmt()` prepared-statement cache and `pluginCore.db=getDB()` capture (`routes:6264`) can't go stale at runtime — *unless a DB re-open/restore path is ever added*, in which case both would hold statements bound to a dead handle (latent — flag if that feature lands). Caveat: `no-redeclare`/`no-unused-vars` are only warnings (86 warnings), so shadowing bugs could still hide.
- **Timers/rejections in routes: clean.** All module-level `setInterval` in `routes` are `.unref()`'d; SSE per-connection timers cleared on `req.on('close')` (`:2851`); registry + GitHub `.then` chains all terminate in `.catch`; `dispatchWebhook` is fire-and-forget with an internal `.catch`+retry. M4 done-cascade (`:1674`) and `/work?auto_claim` (`:1253`) are transactional.
- **Claim atomicity (where it matters): sound.** `claimDroneJob` (`db.js:2583`, guarded UPDATE in txn), `claimRun` (`db.js:1126`, conditional UPDATE loop), auto-claim (`routes:1253`), workflow claim — all atomic. (The non-atomic one is the `/tasks/:id/claim` convenience route — S4.) better-sqlite3's synchronous single-threaded use means in-process check-then-act only races across an `await`; `db.js` has exactly one async fn (`dispatchWebhook`).
- **SSE lifecycle: correct.** `/events/stream` registers `req.on('close')` clearing the keepalive + removing the client (`:2851`); dead clients pruned on write failure (`:701`); per-IP cap present (`:2787`). *Note: `server/eventBus.js` is dead code — imported at `routes:184`, never invoked; its `clients` Set is always empty.*
- **In-memory stores: bounded.** `_rateLimitStore` (timer-pruned), `agentKeyCache` (1000-cap + 5-min TTL), `_studioSeenCache` (pruned), `voicePeers`/`fileDrones` (removed on close, pending requests rejected on disconnect).
- **Uploads/multer: solid.** Auth runs before `upload.single` (bytes only hit disk post-auth — the C-3/C-4 fixes); filenames char-filtered + extension-blocklisted; size-limited (200/500 MB); download filename params strip `/`.
- **Residency plugin (#153, enabled): clean** — inline `checkAgentOrAdmin`, bails on falsy, no dynamic SQL, no outbound fetch.

---

## Speculative / latent (not confirmed exploitable)

- **Worker-plugin event hooks close over loop `var`s** (`plugins.js:269-271`): with ≥2 `"type":"worker"` plugins, every hook sees the last iteration's `manifest`/`workerPort`, so earlier workers never receive events. **Not reachable today** — no plugin is a worker — but a landmine for the plugin marketplace. Fix: capture per-iteration (`let`/params).
- **`dispatchWebhook` rethrow path** (`db.js:2273`, `throw ssrfError`) + sync throws inside the async fn are unawaited/uncaught at 16 call sites → would be an unhandled rejection (= daemon exit). Currently unreachable because `assertPublicHost` only ever throws `SSRFBlockedError` (all paths, incl. DNS failure), which is caught. Any future non-SSRF throw in that function goes fatal. Cheap hardening: `.catch()` the calls or make the fn never-throw.
- **`listConcepts` prepared-statement cache key includes a caller `limit`** (`db.js:3068`). Distinct limits would grow `_stmts` unboundedly; **not reachable** — the only HTTP caller (`routes:4429`) passes only `type`. Drop `limit` from the key.
- **`emitEvent` after a committed write:** in handlers where `emitEvent`→`createEvent` runs before `res.json`, a `createEvent` throw (DB lock) surfaces as 500 though the primary write committed — rare "action happened, returned error" inconsistency.
- **Redundant prune timers:** each `rateLimit(...)` factory spawns its own 5-min sweep (~6-8, all `.unref()`'d, same store). Collapse to one.

---

## Top 3 must-fix (ranked by severity)

1. **S1 — CRITICAL — asset-download arbitrary file read.** Any agent key exfiltrates the entire `mycelium.db` (Stripe/API secrets, webhook HMAC keys, password + agent-key hashes) in three requests. In-repo, no admin, no guard, **live on this instance**. Fix: drop `DATA_DIR` from the allowlist + trailing-sep checks + reject client `..`/absolute paths. **Fix first.**
2. **S2 — HIGH — SSRF guard redirect/rebind bypass.** One shared design flaw silently voids the drive's SSRF guarantee at all six guarded fetch sites; a public URL that 302s to `169.254.169.254` reaches cloud metadata and (via webhook delivery logs) exfiltrates the response. Low-priv reachability is limited *today* (sinks admin/operator-gated), but it's a latent metadata-exfil hole for any future agent-controlled URL. Fix: a custom `undici` dispatcher that re-validates every connected socket (covers redirect hops + rebind).
3. **R1 — HIGH — unwrapped plugin async handlers crash the daemon.** Because `unhandledRejection → process.exit(1)`, any un-try/caught `await` in a raw-mounted plugin route is a full-platform outage; the confirmed instance is `semantic-memory` reindex/backfill on the openai provider (admin-triggered, dormant on this ollama instance but shipped in the public repo). Fix the *class*: wrap plugin routers with `asyncHandler`/error-forwarding middleware.

**Next tier (live now, any agent key):** the MEDIUM authorization-scope cluster **S4 / S5 / S3** (claim assignee-spoof + missing scope, widget scope, drone path forwarding) and the MEDIUM correctness bugs **R2 / R3 / R4** (approval quorum, context-merge corruption, drone-retry duplication) — all reachable in normal operation and cheap to fix. **R5** (retention) prevents a slow-burn disk/backup blowup.

# db.js decomposition — the map (PLAN ONLY)

**Target:** `server/db.js` — 4,497 lines, **306 exports** (304 functions + `GATED_ACTIONS` + `dispatchWebhook` async), every better-sqlite3 DB function on the platform.
**Method:** the same tests-first strangler-fig used on `routes/mycelium.js` (6,539 → 1,732 + 15 domain modules) — see `docs/specs/2026-07-03-god-file-decomposition.md`, which explicitly reserved db.js as "a separate later campaign using this same method." This document is that campaign's map.
**Executor:** serial GLM extractions, one module per PR, each gated by the characterization net (`npm test`, ~954 cases) + the export-manifest gate defined below.
**Line numbers** below are as of this writing (`server/db.js` @ 4,497 lines) — re-verify with `grep -n "^export" server/db.js` before each move.

---

## 0. Current mechanics (what must not change)

- `db.js` is **ESM**: `export function` per function — **no `module.exports`, no flat object**.
- **Consumers** (all preserved byte-for-byte by keeping `server/db.js` as a barrel):
  - 15 route modules: named imports `import { … } from '../db.js'` (`routes/mycelium.js:180` still imports ~250 names for its remaining routes).
  - `server/index.js`: `initDB, getDB, resolveStaleRequests, pruneWebhookDeliveries, purgeExpiredContextKeys, cleanupContextHistory, cleanupSavepoints` (maintenance timers).
  - `server/plugins.js` (loader): `ensurePluginRecord, getPluginRecord, listPluginRecords, getPluginMigrationVersion, recordPluginMigration, getDB`.
  - **Deep plugin imports**: `server/plugins/video-pipeline/routes.js` and `server/plugins/marketing/social/routes.js` import `createDroneJob, getDroneJob` from `../../db.js` / `../../../db.js`.
  - **Tests**: `test/unit/db-*.test.js` set `DATA_DIR` **then** `await import('../../server/db.js')` and use the namespace object. `DATA_DIR`/`DB_PATH` are read at module-eval time — this timing must survive (the barrel importing `db/core.js` preserves it: core evaluates when the barrel is first imported).
- **Module-level shared state** (goes to `db/core.js`):
  - `var db` (line 14) — assigned only inside `initDB`. Every function references bare `db`.
  - `_stmts` cache + `stmt(key, sql)` (221–225) — prepared-statement cache used by ~40 functions.
  - `buildUpdate(table, id, fields, allowed, opts)` (233) — the generic UPDATE builder used by ~20 update functions.
  - `DATA_DIR`, `DB_PATH`, `__dirname` (10–12).

### The split mechanics (the load-bearing decisions)

1. **`server/db.js` stays and becomes the facade barrel.** It re-exports every module: `export * from './db/<entity>.js'` per module. Nothing downstream changes a single import.
2. **`db` is a live binding.** `db/core.js` declares `export var db;` and assigns it inside `initDBConnection()`. Entity modules do `import { db, stmt, buildUpdate } from './core.js'` — ESM live bindings mean reassignment propagates, so **function bodies move verbatim** (bare `db.prepare(...)` keeps working). Nobody but `core.initDBConnection()` may ever assign `db`.
   - Note: `markMessagesRead` (757) declares a local `var stmt` — legal shadowing; modules that don't use the `stmt()` helper simply don't import it.
3. **The ONE allowed non-verbatim edit — composed `initDB`.** Current `initDB` (16–180) ends with `ensureDefaultChannels(); seedPlatformProfiles(); seedDefaultJobTemplates(); console.log('Mycelium DB initialized …')`. To keep the module graph a strict DAG (core must never import entity modules):
   - `db/core.js` exports `initDBConnection()` = the current `initDB` body **minus those last 4 lines** (i.e. through the `instance_config` seeding), plus `migrateGameToProjectId` (183, private) and the `migrateTableNames` import.
   - The barrel `db.js` exports the composed `initDB()` that calls `initDBConnection()` then the three seed functions then the log line. While a seed function's module is not yet extracted, the composed `initDB` calls the still-local copy in `db.js`; when its module lands, the call switches to the import. Gated by `db-init.test.js`.
4. **Ordering law (topological, callee-first):** a module may be extracted only when **every db-internal function it calls already lives in a `db/` sibling** — cross-module calls import the sibling directly. A `db/*` module must **never** import `../db.js` (the barrel) — that's an instant cycle. The reverse is fine: functions still stranded in the barrel import extracted siblings (`db.js` carries both `export * from './db/x.js'` and `import { fn } from './db/x.js'` for its remaining internal callers during transition).
5. **Star-export trap:** duplicate names across `export *` sources are **silently dropped** by ESM. No two modules may export the same name (they don't — all 306 are unique), and the manifest gate below catches any accidental collision mechanically.
6. **Public surface stays exactly 306 names.** `stmt`, `buildUpdate`, `db`, `initDBConnection` are exported by `db/core.js` for siblings but **must NOT be re-exported by the barrel** — core is re-exported selectively (`export { getDB } from './db/core.js'`), not with `export *`.

### The gate (Wave 0, before any move)

Mirror `test/refactor/route-manifest.mjs`: add **`test/refactor/db-manifest.mjs`** + committed snapshot —
`Object.entries(await import('../server/db.js'))` → sorted `name:typeof:fn.length` list (306 entries). `--check` exits 1 on any lost / added / re-typed / re-aritied export. Per extraction: manifest check + `npm test` green + **move-only `git diff`** (bodies leave db.js, reappear unchanged) + a Round. One module = one PR = independently revertible.

---

## 1. Module roster — exact function assignment

31 files: `db/core.js` + 30 entity modules. Every one of the 306 exports is assigned exactly once (verified against `grep -n "^export" server/db.js`). *(line)* = current start line. **Private** helpers move with their module and stay unexported.

### db/core.js — connection, schema, shared helpers
- `initDBConnection` *(from initDB, 16 — see mechanics §3)*, `getDB` *(3420)*
- Private/shared: `migrateGameToProjectId` *(183)*, `stmt` + `_stmts` *(221)*, `buildUpdate` *(233)*, `db` var, `DATA_DIR`/`DB_PATH`, imports (`better-sqlite3`, `fs`, `path`, `url`, `./migrate-table-names.js`)
- Coupling: none (bottom of the DAG). Suites: `db-init.test.js`, `smoke/schema.test.js`, `schema-drift.test.js` — plus the entire net, since everything sits on it.

### db/config.js — instance config + sleep mode (6)
`getInstanceConfig` *(366)*, `setInstanceConfig` *(371)*, `listInstanceConfig` *(378)*, `deleteInstanceConfig` *(382)*, `getSleepMode` *(388)*, `appendSleepLog` *(394)*
- Coupling: none (getSleepMode/appendSleepLog call the config getters in-module). Suites: `admin-characterization`, `plans-approvals-characterization` (sleep-mode paths).

### db/agents.js — agents + agent templates (15)
`createAgent` *(255)*, `getAgent` *(260)*, `getAgentByKeyHash` *(264)*, `resolveAssignee` *(272)*, `listAgents` *(282)*, `listAllAgentsIncludingDrones` *(286)*, `updateAgentHeartbeat` *(290)*, `updateAgentKey` *(295)*, `deleteAgent` *(299)*, `updateAgent` *(311)*, `createAgentTemplate` *(4459)*, `getAgentTemplate` *(4466)*, `listAgentTemplates` *(4475)*, `updateAgentTemplate` *(4485)*, `deleteAgentTemplate` *(4495)*
- Coupling: **`deleteAgent` is a 9-table raw-SQL cascade** (tasks, messages, bugs, drone_jobs, agent_savepoints, webhooks, message_reads, channel_members, agents) — moves whole, no imports needed, but it is the poster child for "cross-entity SQL stays with its owner." `resolveAssignee` is imported by tasks + plans.
- Suites: `db-agent-heartbeat`, `db-agent-auth-cascade`, `agents-characterization`, `agents-list-telemetry`, `liveness-debounce`.

### db/operators.js — operators + studio users (16)
`createOperator` *(321)*, `getOperator` *(326)*, `listOperators` *(330)*, `updateOperator` *(334)*, `setOperatorAvailability` *(338)*, `getAvailableOperators` *(343)*, `isNetworkAutonomous` *(347)*, `deleteOperator` *(360)*, `createStudioUser` *(2229)*, `getStudioUserByUsername` *(2236)*, `getStudioUserById` *(2240)*, `listStudioUsers` *(2244)*, `touchStudioUserSeen` *(2248)*, `getActiveStudioUsers` *(2252)*, `deleteStudioUser` *(2259)*, `updateStudioUser` *(2263)*
- Coupling: co-located deliberately — `isNetworkAutonomous` JOINs `operators × studio_users`. Suites: `teams-orgs-characterization`, `studio-login`, `auth-roles`, `admin-characterization`.

### db/projects.js — orgs + projects (10)
`createOrg` *(409)*, `listOrgs` *(414)*, `getOrg` *(418)*, `updateOrg` *(422)*, `deleteOrg` *(426)*, `createProject` *(432)*, `listProjects` *(437)*, `getProject` *(442)*, `updateProject` *(446)*, `deleteProject` *(453 — note: uses `getDB()` not bare `db`; keep verbatim)*
- Coupling: none. Suites: `concepts-projects-skills-characterization`, `teams-orgs-characterization`, `project-id-no-escape`.

### db/tasks.js — tasks, deps, comments, deliverables (15)
`createTask` *(459)*, `getTask` *(465)*, `listTasks` *(469)*, `updateTask` *(483)*, `setTaskDependency` *(498)*, `resolveTaskDependencies` *(519)*, `approveTask` *(540)*, `listTasksNeedingApproval` *(544)*, `addTaskComment` *(550)*, `getTaskComments` *(557)*, `getTaskComment` *(563)*, `deleteTaskComment` *(567)*, `addTaskDeliverable` *(576)*, `getTaskDeliverables` *(583)*, `deleteTask` *(589)*
- Coupling: imports `resolveAssignee` (agents). The **task done-cascade lives at ROUTE level** (`routes/tasks.js` wraps `getDB().transaction` around `completeLinkedPlanSteps` + `resolveTaskDependencies` + `incrementProfileCounter` + request auto-resolve) — the db split doesn't touch it, but run `task-done-cascade-transaction.test.js` on the tasks, plans, and agent-profiles extractions specifically.
- Suites: `db-tasks`, `db-task-deps`, `tasks-characterization`, `task-done-cascade-transaction`.

### db/plans.js — plans, steps, step comments (13)
`addPlanStepComment` *(597)*, `getPlanStepComments` *(604)*, `createPlan` *(2056)*, `getPlan` *(2063)*, `listPlans` *(2084)*, `updatePlan` *(2119)*, `deletePlan` *(2125)*, `createPlanStep` *(2130)*, `updatePlanStep` *(2141)*, `autoRetryOrEscalatePlanStep` *(2157)*, `deletePlanStep` *(2186)*, `reorderPlanSteps` *(2192)*, `completeLinkedPlanSteps` *(2202)*
- Coupling: imports `resolveAssignee` (agents). `completeLinkedPlanSteps` spans plan_steps + plans (status flip gated on `status='active'`, findings §20) but is single-module. `autoRetryOrEscalatePlanStep` runs its own `db.transaction`.
- Suites: `plans-approvals-characterization`, `task-done-cascade-transaction`, `project-scope-rerun-approval`.

### db/context.js — legacy context + context keys + history (15)
`getContext` *(612)*, `getAllContext` *(616)*, `upsertContext` *(620)*, `upsertContextKey` *(903)*, `cleanupContextHistory` *(952)*, `getContextKey` *(980)*, `listContextKeys` *(995)*, `deleteContextKey` *(1004)*, `bulkDeleteContextKeys` *(1009)*, `searchContextKeys` *(1017)*, `getContextHistory` *(1045)*, `rollbackContextKey` *(1052)*, `purgeExpiredContextKeys` *(1201)*, `cleanupAgentSessionKeys` *(1207)*, `contextKeyStats` *(1213)*
- Private: `sanitizePrototypeKeys` *(871)*, `sanitizeContextData` *(886)*, `enforceNamespaceCap` *(941)*, `CONTEXT_MAX_KEYS_PER_NAMESPACE` *(865)* — the findings-§8 sanitizer set moves as a unit.
- Coupling: none. Suites: `context-characterization`, `admin-characterization` (stats).

### db/assets.js — assets + asset→task transaction (8)
`createAsset` *(628)*, `getAsset` *(634)*, `listAssets` *(638)*, `updateAsset` *(650)*, `deleteAsset` *(656)*, `listAssetsByDroneJob` *(660)*, `initTransactions` *(2026)*, `autoTaskFromAsset` *(2049)* + private `_autoTaskFromAsset` *(2024)*
- Coupling: imports `createTask` (tasks) inside the transaction. **`initTransactions` is exported but never called anywhere** — `autoTaskFromAsset` always returns null, and `assets-files-widgets-characterization.test.js` **pins this** (lines 19, 125). Do NOT "fix" it during extraction; move verbatim.
- Suites: `assets-files-widgets-characterization`, `asset-download-path-traversal`.

### db/events.js — event log (3)
`createEvent` *(666)*, `listEvents` *(672)*, `archiveOldEvents` *(841)*
- Coupling: none. Note the 18M-row flood history in the comment (836–840) — comments travel with the code. Suites: `admin-characterization`, `messages-channels-characterization`.

### db/messages.js — messages, requests, reads, team chat, operator inbox (27)
`createMessage` *(690)*, `createRequest` *(704)*, `acknowledgeMessage` *(711)*, `resolveMessage` *(715)*, `listPendingRequests` *(719)*, `countPendingForAgent` *(725)*, `getAgentInbox` *(735)*, `getMessage` *(752)*, `markMessagesRead` *(757)*, `getUnreadMessages` *(766)*, `listMessages` *(787)*, `listThreads` *(813)*, `archiveOldMessages` *(826)*, `bulkDeleteMessages` *(849)*, `createTeamChat` *(2395)*, `listTeamChat` *(2402)*, `resolveStaleRequests` *(3251)*, `createInboxItem` *(3666)*, `createInboxItemForAllOperators` *(3673)*, `getInboxItem` *(3686)*, `listInboxItems` *(3690)*, `markInboxItemRead` *(3705)*, `markInboxItemActioned` *(3709)*, `dismissInboxItem` *(3713)*, `countUnreadInbox` *(3717)*, `countAllUnreadInbox` *(3722)* + private `VALID_MSG_PRIORITIES` *(688)*
- Coupling: none outgoing (`createInboxItemForAllOperators` queries operators by raw SQL — stays). Mirrors `routes/messages.js` exactly (messages + inbox). Suites: `messages-channels-characterization`, `directive-and-upload-auth`.

### db/spend.js — agent spend (3)
`logAgentSpend` *(1072)*, `getAgentSpend` *(1078)*, `getSpendSummary` *(1094)*
- Coupling: none. **Recommended pilot** (see §3). Suites: `github-spend-runs-voice-characterization`.

### db/runs.js — run log + runner spawns (13)
`createRun` *(1111)*, `updateRun` *(1129)*, `getRun` *(1140)*, `listRuns` *(1151)*, `claimRun` *(1170)*, `releaseStaleClaimedRuns` *(1189)*, `createRunnerSpawn` *(3728)*, `getRunnerSpawn` *(3735)*, `listRunnerSpawns` *(3741)*, `claimRunnerSpawn` *(3751)*, `doneRunnerSpawn` *(3755)* + private `RUN_UPDATABLE` *(1126)*, `RUN_LIST_COLS` *(1147)*
- Coupling: none. **Flag:** the five `*RunnerSpawn` functions have **no callers anywhere in server/ or routes/** (grep-verified) — likely dead exports from the pre-workflow swarm design. Keep + move verbatim (surface preservation); retiring them is a separate, later decision.
- Suites: `db-runs`, `github-spend-runs-voice-characterization`.

### db/skills.js (7)
`createSkill` *(1219)*, `getSkill` *(1229)*, `listSkills` *(1233)*, `updateSkill` *(1241)*, `installSkill` *(1251)*, `uninstallSkill` *(1258)*, `getAgentSkills` *(1262)*
- Coupling: none. Suites: `concepts-projects-skills-characterization`.

### db/widgets.js (4)
`createWidget` *(1270)*, `updateWidget` *(1277)*, `listWidgets` *(1285)*, `deleteWidget` *(1293)*
- Coupling: none. Suites: `assets-files-widgets-characterization`.

### db/bugs.js (6)
`createBug` *(1299)*, `getBug` *(1306)*, `listBugs` *(1310)*, `updateBug` *(1325)*, `deleteBug` *(1329)*, `countBugs` *(1333)*
- Coupling: none. **Coverage note:** bugs has no dedicated characterization suite — `/bugs` routes are exercised via `guardrails-route-coverage` and the boot/overview composites. Thinnest net in the roster; acceptable for a 6-function verbatim move, but the Round should look hardest here (or add a small bugs characterization first).
- Suites: `guardrails-route-coverage` (+ indirect via boot/overview/workqueue tests).

### db/webhooks.js (6)
`createWebhook` *(2269)*, `listWebhooks` *(2277)*, `deleteWebhook` *(2284)*, `dispatchWebhook` *(2288, async)*, `listWebhookDeliveries` *(2375)*, `pruneWebhookDeliveries` *(2387)* + private `logWebhookDelivery` *(2365)*
- Coupling: carries the `crypto` (HMAC) and `assertPublicHost`/`SSRFBlockedError` (`./lib/ssrf-guard.js`) imports out of the db.js header. `dispatchWebhook` is imported by 6 route modules — high fan-in, zero fan-out.
- Suites: `plugins-webhooks-characterization`, `ssrf-guard`.

### db/channels.js (20)
`createChannel` *(2410)*, `getChannel` *(2417)*, `getChannelBySlug` *(2421)*, `getChannelByLink` *(2425)*, `listChannels` *(2429)*, `updateChannel` *(2445)*, `deleteChannel` *(2449)*, `addChannelMember` *(2455)*, `removeChannelMember` *(2466)*, `listChannelMembers` *(2471)*, `isChannelMember` *(2475)*, `getChannelsByUser` *(2480)*, `markChannelRead` *(2488)*, `getUnreadCounts` *(2494)*, `getLatestChannelMessageId` *(2500)*, `listChannelMessages` *(2507)*, `createChannelMessage` *(2519)*, `ensureDefaultChannels` *(2528)*, `autoCreateEntityChannel` *(2551)*, `getOrCreateDmChannel` *(2569)*
- Coupling: `ensureDefaultChannels` + `autoCreateEntityChannel` import `listOperators` (operators) and `listAgents` (agents). `ensureDefaultChannels` is one of the three `initDB` seeds (mechanics §3). Channel *messages* read/write the `messages` table by raw SQL — stays here (mirrors `routes/channels.js`).
- Suites: `messages-channels-characterization`.

### db/drones.js — jobs, profiles, templates, diagnostics, renderer (31)
`createDroneJob` *(2607)*, `getDroneJob` *(2624)*, `claimDroneJob` *(2628)*, `updateDroneJob` *(2659)*, `listDroneJobs` *(2666)*, `releaseStaleClaimedJobs` *(2680)*, `listDrones` *(2702)*, `pauseDrone` *(2706)*, `resumeDrone` *(2711)*, `getDroneStatus` *(2716)*, `createDroneProfile` *(2729)*, `getDroneProfile` *(2743)*, `listDroneProfiles` *(2747)*, `updateDroneProfile` *(2751)*, `deleteDroneProfile` *(2772)*, `assignDroneProfile` *(2776)*, `unassignDroneProfile` *(2782)*, `getDroneProfileAssignments` *(2786)*, `markProfileSetupDone` *(2793)*, `getDronesWithProfile` *(2799)*, `bulkCancelDroneJobs` *(2806)*, `seedDefaultJobTemplates` *(2830)*, `createJobTemplate` *(2840)*, `getJobTemplate` *(2861)*, `listJobTemplates` *(2865)*, `updateJobTemplate` *(2869)*, `deleteJobTemplate` *(2890)*, `updateDroneDiagnostics` *(2896)*, `getDroneDiagnostics` *(2901)*, `renderJobForDrone` *(2909)*, `checkDroneCompatibility` *(3051)*
- Coupling: **drones ARE agents rows** (`project_id='drone'` / `role='drone'`) — `listDrones`/`pauseDrone`/`resumeDrone`/`getDroneStatus`/`updateDroneDiagnostics` read/write the `agents` table by raw SQL (stays, note only). `renderJobForDrone` + `checkDroneCompatibility` import `getLatestSavepoint` (savepoints) for the diagnostics fallback. `seedDefaultJobTemplates` is an `initDB` seed (mechanics §3). `claimDroneJob` is a `db.transaction`; `renderJobForDrone` carries the C-2 `SHELL_META` injection guard — byte-identical move, it's security-load-bearing.
- Suites: `db-drone-claim`, `drones-characterization`, `drone-mesh-rce`.

### db/concepts.js (9)
`createConcept` *(3101)*, `getConcept` *(3107)*, `listConcepts` *(3111)*, `updateConcept` *(3119)*, `deleteConcept` *(3125)*, `linkConceptToProject` *(3129)*, `unlinkConceptFromProject` *(3134)*, `getProjectConcepts` *(3138)*, `getConceptProjects` *(3144)*
- Coupling: none. Suites: `concepts-projects-skills-characterization`.

### db/approvals.js (11)
`GATED_ACTIONS` *(3154)*, `createApproval` *(3157)*, `getApproval` *(3164)*, `listApprovals` *(3168)*, `decideApproval` *(3179)*, `markApprovalExecuted` *(3189)*, `countPendingApprovals` *(3193)*, `listPendingApprovalsByAgent` *(3197)*, `castApprovalVote` *(3203)*, `getApprovalVotes` *(3210)*, `countApprovalVotes` *(3214)*
- Coupling: **`decideApproval` writes `operator_inbox`** (auto-actions related inbox items) by raw SQL — an approvals→inbox seam that stays in-body; run `messages-channels-characterization` alongside the approvals suites on this move.
- Suites: `db-approvals`, `db-approval-votes`, `db-approvals-resolved`, `plans-approvals-characterization`.

### db/plugins.js — plugin records + config (10)
`ensurePluginRecord` *(3422)*, `getPluginRecord` *(3438)*, `listPluginRecords` *(3442)*, `updatePluginEnabled` *(3446)*, `getPluginMigrationVersion` *(3450)*, `recordPluginMigration` *(3455)*, `getPluginConfig` *(3461)*, `getPluginConfigValue` *(3466)*, `setPluginConfig` *(3471)*, `deletePluginConfig` *(3478)*
- Coupling: none outgoing; consumed by the plugin **loader** (`server/plugins.js`) at boot — a loader smoke (server boots, plugins load) is part of this move's gate. Suites: `plugins-webhooks-characterization`, `plugin-router-async-guard`.

### db/savepoints.js (7)
`cleanupSavepoints` *(963)*, `createSavepoint` *(3484)*, `getLatestSavepoint` *(3523)*, `getSavepointHistory` *(3529)*, `updateSavepointNotes` *(3535)*, `computeSavepointDiff` *(3542)*, `pruneSavepoints` *(3620)*
- Coupling: **`computeSavepointDiff` is a cross-entity read** (messages, tasks, context_keys, plans, bugs, drone_jobs, events — all raw SQL, no imports). High fan-in: drones, node-profiles, boot all import `getLatestSavepoint`.
- Suites: `agents-characterization` (savepoint/diff endpoints), `admin-characterization`.

### db/feedback.js (5)
`createFeedback` *(3633)*, `getFeedback` *(3641)*, `listFeedback` *(3645)*, `deleteFeedback` *(3660)*, `getFeedbackSummary` *(3759)*
- Coupling: none. Same thin-coverage caveat as bugs (no dedicated suite; `guardrails-route-coverage` touches it). Suites: `guardrails-route-coverage`.

### db/node-profiles.js — node profiles + calibration (8)
`createNodeProfile` *(3795)*, `getNodeProfile` *(3816)*, `listNodeProfiles` *(3821)*, `updateNodeProfile` *(3831)*, `deleteNodeProfile` *(3852)*, `resolveProfileChain` *(3860)*, `seedPlatformProfiles` *(3933)*, `buildCalibrationBlock` *(4018)* + private `NODE_PROFILE_JSON_FIELDS` *(3777)*, `stringifyProfileField` *(3779)*, `parseProfileRow` *(3785)*
- Coupling: `resolveProfileChain` imports `getAgent` (agents); `buildCalibrationBlock` imports `getLatestSavepoint` (savepoints) + `getContextKey`/`upsertContextKey` (context) — 3-module fan-out, and it **writes** (persists the `standup` context key). `seedPlatformProfiles` is an `initDB` seed (mechanics §3).
- Suites: `agents-characterization` (calibration in boot/heartbeat), `admin-characterization`.

### db/teams.js — teams, members, team settings (16)
`listTeamSettings` *(4092)*, `getTeamSetting` *(4099)*, `upsertTeamSetting` *(4103)*, `deleteTeamSetting` *(4114)*, `getAllTeamSettingsGrouped` *(4120)*, `syncTeamSettingsToProfile` *(4134)*, `createTeam` *(4216)*, `getTeam` *(4223)*, `listTeams` *(4233)*, `updateTeam` *(4240)*, `deleteTeam` *(4246)*, `addTeamMember` *(4252)*, `updateTeamMember` *(4267)*, `removeTeamMember` *(4291)*, `getTeamsForUser` *(4302)*, `getTeamProjects` *(4308)*
- Coupling: **`syncTeamSettingsToProfile` imports `getNodeProfile`/`updateNodeProfile`/`createNodeProfile`** (node-profiles) — node-profiles must land first. `addTeamMember`/`updateTeamMember`/`removeTeamMember` write `agents`/`operators.primary_team_id` by raw SQL (stays, note only).
- Suites: `teams-orgs-characterization`.

### db/agent-profiles.js (6)
`getAgentProfile` *(4315)*, `ensureAgentProfile` *(4326)*, `updateAgentProfile` *(4338)*, `incrementProfileCounter` *(4349)*, `listAgentProfiles` *(4355)*, `getAgentLeaderboard` *(4366)*
- Coupling: `ensureAgentProfile` imports `getAgent` (agents). `incrementProfileCounter` is part of the route-level done-cascade — run `task-done-cascade-transaction` on this move.
- Suites: `agents-characterization`, `task-done-cascade-transaction`.

### db/health.js — health patrol + reconciliation (6)
`getReconciliationCandidates` *(4391)*, `getStaleAgents` *(4421)*, `getStaleTasks` *(4428)*, `getStaleRequests` *(4435)*, `getStaleDrones` *(4442)*, `getStalePlanSteps` *(4449)*
- Coupling: cross-entity **read-only** raw SQL (bugs/tasks/plan_steps/agents/messages) — no imports, moves clean despite the fan-in of tables.
- Suites: `db-reconciliation`, `route-enum-reject-and-reconciliation`, `admin-characterization`.

### db/workqueue.js — work queue + auto-dispatch (5)
`getTeamProjectIdsForAgent` *(1795)*, `buildWorkQueue` *(1863)*, `getIdleAgents` *(1955)*, `getNextUnassignedTask` *(1969)*, `getNextUnassignedPlanStep` *(1990)* + private `_capsHave` *(1813)*, `agentIsPlanner` *(1821)*, `scopeHasOnlinePlanner` *(1831)*, `_planPriorsComplete` *(1856)*
- Coupling: `getTeamProjectIdsForAgent` imports `getTeamsForUser` (teams) — teams must land first. The planner-triage-first routing + step-ordering rule live here; the directive-deprecation comment block (1866–1875) travels with `buildWorkQueue`. Auto-dispatch reads agents/tasks/plan_steps raw.
- Suites: `agents-characterization` (`/work` queue), `tasks-characterization`, `guardrails-route-coverage`.

### db/overview.js — admin composites (3)
`getAdminOps` *(3221)*, `getOverview` *(3264)*, `getSlimOverview` *(3351)* + private `timeSince` *(3333)*
- Coupling: **read-only composite** — `getOverview` fans into ~15 modules (agents, events, tasks, messages, context, projects, approvals, assets, bugs, plans, channels, concepts, orgs, operators, config, drones, plugins, studio-users). Extract second-to-last. `timeSince` (with its UTC-normalization comment) is pinned by `db-timesince.test.js` via the slim overview.
- Suites: `db-timesince`, `admin-characterization`.

### db/boot.js — boot payloads (3) — LAST
`getBootPayload` *(1356)*, `getSlimBootPayload` *(1492)*, `getSmartBootPayload` *(1618)* + private `buildCrashRecovery` *(1339)*, `buildRoleContract` *(1748)*
- Coupling: the hairball — imports from agents, tasks, messages, context, config, operators, events, bugs, plans, channels, concepts, projects, plugins (`listPluginRecords`), approvals, savepoints, node-profiles (`buildCalibrationBlock`), teams (`getTeamsForUser`), workqueue (`buildWorkQueue`). Not read-only: auto-heartbeats (`updateAgentHeartbeat`), auto-acks inbox (`markMessagesRead`), and calibration writes a context key. `getSmartBootPayload` also reads the semantic-memory plugin's `sm_embeddings` table raw.
- Suites: `agents-characterization` (boot endpoints are its spine), `guardrails-route-coverage`.

**Count check:** 6+15+16+10+15+13+15+8+3+27+3+13+7+4+6+6+20+31+9+11+10+7+5+8+16+6+6+5+3+3 = **304** function/const exports + core's `getDB` + barrel's `initDB` = **306**. ✓ Nothing orphaned.

---

## 2. The tricky seams (what the serial extraction must respect)

1. **`db` live binding + composed `initDB`** (mechanics §2–3) — the one structural edit; everything else is verbatim moves. Get core.js right first and alone.
2. **The boot composite** (`db/boot.js`) — 18-module fan-in *and* it writes (heartbeat, read-acks, calibration key). It is the reason for the callee-first ordering law; extract dead last.
3. **`deleteAgent` 9-table cascade** — stays whole in agents.js; `db-agent-auth-cascade` pins it.
4. **Route-level done-cascade** (`routes/tasks.js`) — spans tasks + plans + agent-profiles + messages via `getDB().transaction`; unaffected by the split but re-verify (`task-done-cascade-transaction`) on each of those three extractions.
5. **`resolveAssignee`** — agents-owned, silently load-bearing inside `updateTask`, `createPlanStep`, `updatePlanStep`.
6. **`decideApproval` → `operator_inbox`** raw write (approvals ↔ inbox).
7. **`syncTeamSettingsToProfile` → node-profiles** (teams depends on node-profiles).
8. **`buildCalibrationBlock`** — node-profiles → agents + savepoints + context, and it writes.
9. **Drones ARE agents rows** — drones.js reads/writes the `agents` table raw; plus the savepoints fallback import.
10. **Seeds inside `initDB`** — channels, node-profiles, drones own one seed each; the barrel's composed `initDB` switches from local call to import as each lands.
11. **`initTransactions`/`autoTaskFromAsset` dead-path** — pinned dead by the characterization net; move verbatim, do not revive.
12. **Star-export silent drops + surface creep** — the db-manifest snapshot is the mechanical catch for both (lost names AND accidentally re-exported internals like `stmt`/`db`).
13. **`DATA_DIR` module-eval timing** — core must read env at its own eval; tests set `DATA_DIR` before dynamically importing the barrel.
14. **Raw SQL in routes** — ~20 `getDB().prepare(...)` sites in routes/ (admin, agents, drones, messages, mycelium) bypass db.js entirely; they keep working via `getDB` but are OUT OF SCOPE here (candidates for a later push-down campaign).

---

## 3. Extraction order (risk-ascending waves; callee-first within waves)

Gate per extraction: `node test/refactor/db-manifest.mjs --check` + `npm test` green + move-only diff + Round. One module = one PR.

- **Wave 0 — harness (no code moves):** add `test/refactor/db-manifest.mjs` + snapshot (306 entries). Optionally a tiny bugs/feedback characterization to thicken the net's thinnest spots.
- **Wave 1 — `db/core.js`:** the enabling move + the only structural edit (initDBConnection / composed initDB / shared `db`+`stmt`+`buildUpdate`). db.js's remaining 300 functions switch from local `var db` to `import { db, stmt, buildUpdate } from './db/core.js'` — bodies untouched. Heaviest gate: full suite + boot smoke (`node server/index.js` starts, plugins load).
- **Wave 2 — pilot:** `db/spend.js` (3 functions, zero coupling, clean suite). Establishes the reference cycle for GLM, exactly like `/bugs` did for routes.
- **Wave 3 — zero-coupling singles (any order):** `config`, `bugs`, `feedback`, `events`, `widgets`, `skills`, `concepts`, `projects`, `runs`, `plugins`, `health`, `webhooks`, `context`, `savepoints`, `messages`, `operators`, `approvals`, `agents`.
  Suggested order puts `agents`, `operators`, `savepoints`, `context` late in the wave only because Wave 4 imports them — any order inside the wave passes the gate.
- **Wave 4 — light cross-imports (dependencies in parentheses):** `tasks` (agents), `plans` (agents), `agent-profiles` (agents), `channels` (operators, agents), `assets` (tasks), `drones` (savepoints), `node-profiles` (agents, savepoints, context).
- **Wave 5 — heavier cross-imports:** `teams` (node-profiles), then `workqueue` (teams).
- **Wave 6 — composites:** `overview` (many, read-only), then **`boot` last** (everything).
- **Wave 7 — endgame:** db.js is a pure facade (~150–300 lines: core re-exports, composed `initDB`, 30 `export *` lines). Manifest byte-identical to Wave 0's snapshot.

---

## 4. Definition of done

- `server/db.js` ≤ ~300 lines, barrel-only; 31 files under `server/db/`, each 50–450 lines.
- `db-manifest.mjs --check` byte-identical to the pre-campaign snapshot (306 exports, same types/arities).
- `npm test` green at every intermediate commit — the net never opens.
- No consumer changed: routes, `index.js`, `plugins.js`, deep plugin imports, and `test/unit/db-*.test.js` all still import `server/db.js`.
- Every non-verbatim edit in the whole campaign is the initDB composition in Wave 1 — anything else non-move fails review by definition.

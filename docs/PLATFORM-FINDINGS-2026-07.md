# Mycelium Platform — Characterization Findings (2026-07-12)

680 characterization tests over `routes/mycelium.js` (298 handlers) pinned the platform's
**current** behavior and, in doing so, surfaced ~104 latent defects. Behavior is now **locked**
(the suite is green); these are the **Phase-2 fix backlog** — to be fixed *under* the net, before
or alongside the god-file decomposition. Per-bug detail lives in the `S#`/`B#`/`L#` comment blocks
in each `test/unit/<domain>-characterization.test.js`.

## Systemic — fix once in a shared helper, heal many endpoints

1. **`checkAdmin` ignores `X-Agent-Key`.** A valid agent hitting an admin-only route gets `401
   "Authentication required"` instead of `403`. Present in **every** domain tested. One middleware fix.
2. **Silent `200 {ok:true}` instead of `404`.** PUT/DELETE on nonexistent ids no-op silently (plan
   steps, teams, drones pause/resume, widgets, webhooks, skills uninstall, memberships…). A shared
   "affected 0 rows → 404" guard.
3. **Raw SQLite errors leaked to clients.** UNIQUE/FK failures surface as raw messages (team dup,
   member add, duplicate run id → **500**). A shared error mapper (UNIQUE→409, FK→404).
4. **`INSERT OR IGNORE` silent no-op on duplicate id.** POST orgs/projects return the OLD row, 200,
   new data discarded, no 409 — while POST skills correctly 409s. Inconsistent create semantics.
5. **Route-shadowing / dead routes.** `PUT /assets/link-job` is shadowed by `/assets/:id` (always
   404); voice intent-order shadowing; `/agents/profiles` shadow. A route-ordering audit is warranted.
6. **Missing input validation + type loss.** Enums unvalidated on POST (`priority:'ludicrous'`,
   role `'supreme-overlord'`, any `msg_type`); values round-trip as strings (team-settings, plugin
   config, context).

## Security / Governance — priority

7. **No namespace ACL on `/context`** — any agent reads/writes any namespace.
8. **Prototype pollution** — first (non-merge) context writes store `__proto__` keys verbatim
   (the sanitizer only runs on the merge path).
9. **Approval governance is unenforced.** The risk-tier→quorum table doesn't exist in code
   (`critical` still `required_approvals:1`); the vote route hardcodes voter identity (any admin →
   `__admin__`, any JWT → `studio_user`), so **quorums >2 are unreachable and decision attribution is
   lost**; `current_approvals` is never maintained. The multi-human gate on money/delete actions does
   not actually gate.
10. **Kill switch is half-wired** — `frozen` is checked only in `POST /work/request`;
    `GET /work/:agentId?auto_claim` still hands out work while the platform is "frozen."
11. **Agent-readable admin surface** — any agent key reads the full instance config (risk_tiers etc.)
    and can trigger the health patrol; `GET /admin/health` is a **mutating GET** (marks peers offline).
12. **Webhook secrets returned plaintext** — `GET /webhooks` leaks signing secrets unmasked (plugin
    config secrets ARE masked); no create-time URL validation (SSRF guard is dispatch-time only), so a
    bad `events` string creates a silently-dead subscription with a 200.
13. **Unguarded cross-agent reads** — any agent key reads any agent's spend ledger; any authenticated
    party can ack/resolve another agent's requests.
14. **Admin heartbeat-on-behalf never validates `agent_id`** — orphan savepoint rows for nonexistent
    agents (no FK on `agent_savepoints`).

## Notable functional / data-integrity

15. **Dead cascade link (tasks)** — `updateTask`'s allowlist has no `request_id`, so the task↔request
    link is silently dropped → the "auto-resolve linked request on task-done" cascade is dead through
    the routes.
16. **Dead auto-task feature (assets)** — `db.initTransactions()` is exported but never called; POST
    /assets returns no `task_id`.
17. **"Permanent" asset files silently expire** — uploads land in `FILES_DIR`, the same dir the 24h
    temp-TTL sweep cleans and `GET /files` lists.
18. **Spend meter under-reports** — non-numeric `cost_usd` silently coerces to `$0` with `ok:true`;
    an admin key without `X-Acting-As` books real cost under the `__system__` sentinel.
19. **Re-completing a done task re-runs the full cascade** — double-counts profile counters.
20. **Draft plans reported as completed** — the cascade pushes `plans_completed` while plan status
    stays `draft` (the status flip is gated on `active`, the counter push isn't).
21. **Orphan upload on 404** — uploading to a nonexistent asset 404s, but multer has already written
    the file to disk.
22. **`@mention` regex false-positives on emails** — `foo@example.com` mints an inbox mention for
    "example"; `operator_inbox.operator_id` has no FK → orphan rows.
23. **Doc drift** — `/admin/churn-check` + `/admin/deploy/health-check-all` are retired (404) but still
    documented; the kill switch is documented as "any human operator" but the code requires admin role.

---

*Full per-bug detail: the `S#`/`B#`/`L#` header comments in each
`test/unit/<domain>-characterization.test.js`. All 23 categories above are **locked as current
behavior** by the green suite — fixing any of them means updating the corresponding test to assert
the corrected behavior (that's the intended workflow: the test flips from "locks the bug" to
"proves the fix").*

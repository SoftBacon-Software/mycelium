# Two judgment calls held for Gilbert (2026-07-12)

The correctness batch is done except these two. I pulled them out of the auto-fix path because
each is a **design decision**, not a clear bug — your call, not mine. Both are grounded in the
live code below. Nothing here is fixed yet.

---

## Item 1 — silent `200 {ok:true}` on updates to a missing sub-resource

**Where:** `server/routes/plans.js:161` — `PUT /plans/:id/steps/:stepId` (representative of the
whole §2 family: plan steps, drone pause/resume, widgets, webhooks, skills uninstall, memberships).

**Current behavior:** the handler 404s if the *plan* is missing (`:165`), but never checks the
*step* exists. It calls `updatePlanStep(stepId, fields)` regardless (`:181`); on a nonexistent
step that UPDATE touches **0 rows** — yet the handler still returns `200 {ok:true}` **and fires a
phantom `plan_step_updated` event + webhook** (`:185–186`) for a step that isn't there.

**On closer read I was too soft on this one.** My original reason was "idempotent DELETE returning
200 for an already-gone resource is a legit REST choice" — and that's true, *for DELETE*. But this
is a **PUT that lies about success and emits phantom events**. That's not idempotency; it's a
mutation reporting a change it didn't make. Different animal.

**The honest split:**
- **DELETE of a missing id → 200** = defensible idempotency. (Moot here — `DELETE /tasks/:id` and
  `DELETE /plans/:id` already 404 correctly; `tasks.js:—`, `plans.js:118`.)
- **PUT of a missing sub-resource → 200 + phantom event** = a real footgun. Recommend fixing.

**Recommendation:** add the missing existence check to the sub-resource PUT/PATCH family → **404**
before mutating/emitting. Consistent with the top-level handlers that already do it. Low risk under
the net (flip the characterization assertions from "locks the silent-200" to "asserts 404").
**Cost:** ~1 shared guard + per-handler existence check; a handful of test flips. Half a wave.

**Counter (why you might say leave it):** clients may already depend on the lenient 200, and the
platform is single-tenant + you drive it. If so, we leave it and I'll note it as intentional.

---

## Item 2 — mutating `GET /admin/health`

**Where:** `server/routes/admin.js:776` → `runHealthPatrol()` (`server/routes/mycelium.js:1679`).

**Current behavior:** a **GET** runs the stale-detection patrol, which **mutates**: marks stale
agents offline (`mycelium.js:1696`), marks stale drones offline + releases their claimed jobs
(`:1718–1719`), and emits `health_patrol` events. So a plain read has real side effects.

**Why it's a judgment call, not a bug:** the same `runHealthPatrol()` **also runs on the 5-minute
timer** (`:1741`). So the offline-marking happens on a schedule anyway — the GET is effectively a
manual **"run the patrol now"** button. The mutation *is the endpoint's whole job*, not an
accidental side effect of a read. And it's self-healing: a wrongly-marked agent flips back online on
its next heartbeat. Admin-authed, low blast radius.

**The REST-purist counter:** GET should be safe/idempotent. A proxy, prefetcher, uptime monitor, or
browser tab that fires GETs could silently mark your agents offline. The clean shape is
`POST /admin/health/run` (trigger) + `GET /admin/health` (read the last patrol result).

**Recommendation (mild):** split it — `POST` to trigger, `GET` to read cached last-run — **only if**
you want strict REST hygiene / plan to expose this beyond the app. Otherwise it's a defensible
"health endpoint doubles as the patrol trigger" design and we document it as intentional. This one
I'd lean toward **leaving** unless you want the hygiene. **Cost:** trivial (add a POST alias, make
GET return the stored last result); a couple test flips.

---

### TL;DR
- **Item 1:** on reflection, the PUT-of-missing case is more bug than judgment — **recommend fix**.
- **Item 2:** genuinely a design taste call — **recommend leave + document**, unless you want strict
  GET-safety.

Say the word on each and I'll run them under the net (or mark them intentional in the findings doc).

# Jetson legacy files: supersession evidence (2026-08-16)

Deploying `master` to jetson01 **deletes four files** that exist on the box and
on no mainline branch. This document is the evidence that each is superseded
rather than orphaned. It was produced before the deletion, not after.

Do not delete these files on the strength of "they look old". The check below is
what justifies it.

## Why they exist

The box was last deployed on 2026-08-03 from `security-backport-20260802`. That
line carried its own **god-file decomposition Phase 3** (2026-07-12): `db.js` was
split into `db/{boot,overview,workqueue}.js`, and SPEND/RUNS/GITHUB/VOICE were
extracted from `routes/mycelium.js` into `routes/misc.js`.

`master` decomposed differently — it kept those DB functions in `server/db.js`
and split routes **per domain** instead (`routes/spend.js`, `routes/runs.js`,
`routes/github.js`, and 15 more). Neither line is "behind"; they diverged on how
to cut the same god-files. Master's cut is the one that survives.

## `server/db/boot.js` → `master:server/db.js`

| symbol | home on master |
|---|---|
| `getBootPayload` | `server/db.js` |
| `getSlimBootPayload` | `server/db.js` |
| `getSmartBootPayload` | `server/db.js` |

Internal helpers (`buildCrashRecovery`, `buildRoleContract`) are private to the
module and move with their callers.

## `server/db/overview.js` → `master:server/db.js`

| symbol | home on master |
|---|---|
| `getAdminOps` | `server/db.js` |
| `getOverview` | `server/db.js` |
| `getSlimOverview` | `server/db.js` |

Internal helper: `timeSince`.

## `server/db/workqueue.js` → `master:server/db.js`

| symbol | home on master |
|---|---|
| `getTeamProjectIdsForAgent` | `server/db.js` |
| `buildWorkQueue` | `server/db.js` |
| `getIdleAgents` | `server/db.js` |
| `getNextUnassignedTask` | `server/db.js` |
| `getNextUnassignedPlanStep` | `server/db.js` |

Internal helpers: `_capsHave`, `agentIsPlanner`, `scopeHasOnlinePlanner`,
`_planPriorsComplete`.

## `server/routes/misc.js` → master's per-domain route files

`registerMiscRoutes` has **no symbol-level equivalent on master**, and that is
correct: master replaced the single registrar with per-domain ones. The contract
that matters is the *routes*, not the function name, and master pins it in
`test/refactor/route-manifest.snapshot`:

| route family | entries in master's manifest | registrar |
|---|---|---|
| spend | 3 | `registerSpendRoutes` (`routes/spend.js`) |
| runs | 6 | `registerRunRoutes` (`routes/runs.js`) |
| github | 3 | `registerGithubRoutes` (`routes/github.js`) |
| voice | 1 — `POST /voice/command` | kept in `routes/mycelium.js` (a single route; not worth a file) |

**Verification used:**

```bash
git show master:test/refactor/route-manifest.snapshot | grep -i voice
# POST /voice/command  []
```

`server/routes/voice.js` does not exist on master and should not be expected to.
Its one route lives in the parent router and is covered by the manifest gate.

## Verdict

All 11 exported DB symbols resolve to `master:server/db.js`. All four route
families from `misc.js` appear in master's route-manifest snapshot, which is an
enforced test rather than a claim. **Deleting the four files loses no
functionality.**

The fifth Jetson-only file, `server/lib/mdns-advertise.js`, is the opposite case
— genuinely absent from master and genuinely load-bearing. It was merged to
master on 2026-08-16 (commit `847be95`) *before* any deploy, after confirming the
branch copy is byte-identical (sha256 `4079a4a0…`) to the copy running on the box.

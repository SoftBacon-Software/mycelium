# Spec: first-class `runtime` entity (the brain-host / serving-backend layer)

- **Author:** m5Max
- **Date:** 2026-06-07
- **Status:** Draft (for squad execution — Kira-led)
- **Project:** mycelium (platform) → consumed by mycelium-app (cockpit) + Piper (caretaker)

## 1. Problem

Mycelium coordinates **agents**, **tasks/plans**, and **drones** as first-class
entities — but the thing that actually *serves the brains* is not modeled at all.
A "runtime" today is three string columns on each agent (`runtime`,
`llm_backend`, `llm_model`) plus a free-form `system_diagnostics` JSON blob.
There is no object that represents *"oMLX at :8780, 118 GB ceiling, currently
holding Coder-Next (82 GB, pinned) + 3.6 (28 GB)"*.

Because there's no object, three things have nowhere to bind:
- **The RAM dance** (co-residency admit / eviction — can these two brains fit?
  who gets evicted to load the 82 GB coder?) has no capacity/residents to read.
- **The cockpit visuals** (#207 brain-sphere, #198/#199 RAM·KV meters, #205 RAM
  coordinator) have to scrape agent string-columns instead of reading a real
  telemetry feed.
- **It can't generalize.** A stranger running llama.cpp + Ollama + vLLM has the
  same need, but nothing in the schema lets them register their backends.

Drones already prove the pattern (`drone_profiles`, `drone_profile_assignments`,
`drone_jobs`, `/drones` routes, heartbeat). A **runtime is the same shape of
thing**: a federated compute resource that registers, heartbeats telemetry, and
gets coordinated. This spec makes it first-class.

## 2. The three layers (and what this spec does / does NOT do)

Coordination splits into three layers; *where each lives* is the load-bearing
decision:

| Layer | What | Where it lives | This spec |
|---|---|---|---|
| **Policy** (the dance) | admit / evict / co-residency decisions | **Piper + platform** (caretaker = RAM eyes/ledger; oMLX/ds4 governors = reflexes) | **OUT of scope** — only defines the seam Piper reads/writes |
| **State** (registry + telemetry) | what runtimes exist, capacity, residents, live RAM/KV | **platform** (this entity) | **IN scope** — the deliverable |
| **Surface** (see + intervene) | render + operator actions | **mycelium-app cockpit** | defines the read contract the app binds to |

**Non-goal / hard rule:** no coordination *policy* in the app. The app is a
face (operator auth). The dance must run headless (Piper + platform) so it
survives the app being closed — the offline/decentralized constraint. The app
*renders* runtime state and *requests* operator actions; it never *is* the
coordinator. See `project_durable_platform_fixes_concurrency` (the two-layer
concurrency model: platform = logical/durable, coordinator = resource/Piper).

**Non-goal:** folding drones into runtimes. Drones = job-queue workers;
runtimes = persistent brain servers. Both are "federated resources" and share
the registration/heartbeat shape, but they stay distinct tables.

## 3. Generalization litmus (build for the concept, not our squad)

A stranger must be able to:
```
POST /runtimes { id:"my-llama", kind:"llamacpp",
                 endpoint:"http://192.168.1.9:8080", ram_ceiling_gb:24 }
```
…run a tiny reporter that heartbeats it, and have the cockpit light up the same
as ours. **No oMLX/ds4-specific columns.** `kind` + `capabilities` + `endpoint`
generalize; our oMLX / ds4 / Apple-FM / 3090 are just *rows*. If a column only
makes sense for our setup, it belongs in `labels`/`diagnostics` JSON, not the
schema.

**The test for every column + route in this spec:** if its *justification* is a
general truth ("a backend has a memory ceiling"), it's durable; if its
justification is *our* case ("oMLX is 118 GB", "Kira's KV grows"), it's
squad-shaped — push the specific into `labels` / `diagnostics` / seed-data and
keep the column generic. See `feedback_build_for_the_concept_not_our_squad` +
`project_durable_platform_fixes_concurrency`.

## 4. Schema (additive — `server/schema.sql`)

```sql
-- A model-serving backend (brain-host). Federated like drones.
CREATE TABLE IF NOT EXISTS runtimes (
  id              TEXT PRIMARY KEY,            -- 'omlx','ds4','apple-fm','3090-comfy'
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'custom', -- omlx|mlx|llamacpp|ollama|vllm|apple-fm|comfyui|cloud|custom
  endpoint        TEXT NOT NULL DEFAULT '',     -- http://127.0.0.1:8780
  host            TEXT NOT NULL DEFAULT '',     -- free machine/host label (not an FK)
  status          TEXT NOT NULL DEFAULT 'unknown', -- up|down|degraded|loading|unknown
  ram_total_gb    REAL NOT NULL DEFAULT 0,
  ram_ceiling_gb  REAL NOT NULL DEFAULT 0,      -- soft co-residency admit ceiling (0 = unset)
  ram_used_gb     REAL NOT NULL DEFAULT 0,      -- live
  vram_total_gb   REAL NOT NULL DEFAULT 0,
  vram_used_gb    REAL NOT NULL DEFAULT 0,
  capabilities    TEXT NOT NULL DEFAULT '[]',   -- ['mlx','metal','ssd-streaming']
  labels          TEXT NOT NULL DEFAULT '{}',   -- deployment-specific extras
  diagnostics     TEXT NOT NULL DEFAULT '{}',   -- free JSON (tps, queue depth, temp)
  reporter        TEXT NOT NULL DEFAULT '',     -- id of whatever reporter heartbeats this runtime
  last_heartbeat  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What is loaded on a runtime right now (the "brains on the metal").
-- Child table (queryable), mirroring drone_profile_assignments.
CREATE TABLE IF NOT EXISTS runtime_residents (
  runtime_id    TEXT NOT NULL REFERENCES runtimes(id) ON DELETE CASCADE,
  model         TEXT NOT NULL,                 -- 'Qwen3-Coder-Next-8bit'
  state         TEXT NOT NULL DEFAULT 'loaded', -- loaded|loading|evicting|cold
  ram_gb        REAL NOT NULL DEFAULT 0,
  kv_cache_gb   REAL NOT NULL DEFAULT 0,
  ctx_tokens    INTEGER NOT NULL DEFAULT 0,    -- current KV-cache fill in tokens (grows with session length)
  pinned        INTEGER NOT NULL DEFAULT 0,
  last_used_at  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (runtime_id, model)
);
CREATE INDEX IF NOT EXISTS idx_runtime_residents_runtime ON runtime_residents(runtime_id);

-- Link an agent to the runtime serving its brain (additive; keep the strings).
ALTER TABLE agents ADD COLUMN runtime_id TEXT NOT NULL DEFAULT '';
```

Keep the existing `agents.runtime/llm_backend/llm_model` strings (display +
back-compat); `runtime_id` is the new join. Backfill nullable → no migration
break.

## 5. Endpoints (`server/routes/mycelium.js`, mirror `/drones` + `/agents`)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/runtimes` | agent/admin | register/upsert a runtime |
| GET | `/runtimes` | authed | list (each with `residents[]` joined) |
| GET | `/runtimes/:id` | authed | one runtime + residents |
| PUT | `/runtimes/:id` | reporter/admin | update status/capacity/labels |
| DELETE | `/runtimes/:id` | admin | remove |
| POST | `/runtimes/:id/heartbeat` | reporter/admin | **the live feed** (below) |

**Heartbeat body** (the single most important contract — mirrors
`/agents/heartbeat`):
```jsonc
{
  "status": "up",
  "ram_used_gb": 110.3,
  "vram_used_gb": 0,
  "residents": [
    { "model": "Qwen3-Coder-Next-8bit", "state": "loaded",
      "ram_gb": 82.0, "kv_cache_gb": 3.1, "ctx_tokens": 41000, "pinned": true },
    { "model": "Qwen3.6-27B-oQ8-mtp", "state": "loaded",
      "ram_gb": 28.0, "kv_cache_gb": 0.9, "ctx_tokens": 12000, "pinned": false }
  ],
  "diagnostics": { "tps": 38.2, "queue_depth": 1 }
}
```
Handler: upsert the runtime live fields + `last_heartbeat`, **replace**
`runtime_residents` for that runtime from `residents[]`, and emit an
`events` row (`type:"runtime_heartbeat"`, `data:` = payload) so the SSE stream
(`/events/stream`) carries it to the cockpit with no polling.

## 6. Who reports (the reporter, not the platform)

The platform doesn't poll backends — a **reporter** heartbeats each runtime. The
platform is **reporter-agnostic**; everything below is *our deployment*, not part
of the contract.
- **Local runtimes (oMLX, ds4, Apple-FM): Piper.** It already is the free RAM
  eyes/ledger. It polls oMLX `/health` (resident models + mem), ds4, system RAM
  (`vm_stat`/`memory_pressure`), and POSTs `/runtimes/:id/heartbeat`. This is a
  natural extension of `jarvis/tools/piper-maintenance.py`.
- **GPU drone (3090):** self-reports (it's already an agent + drone).
- **A stranger:** a ~30-line reporter script per backend, or their orchestrator.
  Anything that speaks §5's contract.

See `project_piper_caretaker_role`.

## 7. Policy seam (OUT of scope here — named so it stays out of the app)

Piper's co-residency admit/evict policy *reads* `GET /runtimes` (ceiling +
residents) and decides load/evict; it can mark a resident `state:"evicting"` via
heartbeat and emit an admit event/widget. The **operator overrides from the
cockpit** by calling an action endpoint (future spec) that Piper honors — the
app requests, Piper decides. The durable phase-ordering stays in the platform
(`_planPriorsComplete`); resource co-residency stays in Piper. No policy in the
platform core, none in the app.

## 8. App binding (the surface — read-only contract)

`mycelium-app` reads `GET /runtimes` + subscribes to `runtime_heartbeat` on
`/events/stream`. Mapping to the open cockpit work:

| Cockpit organ | Bound to |
|---|---|
| **#207 brain-sphere** | the runtime's hot resident (`pinned` else most-recent `last_used_at`) → model name centered; **model change = SWAP**; `status∈{degraded,down}` or `ram_used_gb>ram_ceiling_gb` = **ERROR (red)** |
| **#198/#199 RAM·KV meters** | `ram_used_gb / ram_ceiling_gb`; per-resident `kv_cache_gb` + `ctx_tokens` (Kira's growing KV); `vram_*` for GPU |
| **#205 RAM coordinator** | `residents[].state` transitions (loading/evicting) = the dance, live; Piper admit events |

One grammar (`project_app_one_interaction_grammar`): a runtime is just another
**card → sidecar → button-interface** (start/stop/pin/limits) **→ run-in-cockpit**.

## 9. Rollout (phased, additive)

1. **Schema + routes + db fns** (this spec) — 2 tables + 1 agent column + 6
   routes + heartbeat handler + SSE emit. Backfill rows: `omlx`, `ds4`,
   `apple-fm`, `3090-comfy`.
2. **Reporter** — Piper heartbeats the local runtimes.
3. **App binding** — cockpit reads `/runtimes`; sphere/meters/#205 go live on
   real data.

Each phase is independently shippable; nothing breaks the existing agent
string-columns.

## 10. Squad execution (Kira-led)

Per the routing rule (`feedback_route_crew_work_to_kira_head`): file to **Kira**
(head) → Ada decomposes + assigns → Lucy codes (`schema.sql` + `db.js` +
`routes/mycelium.js`) → Echo verifies → m5Max/Claude reviews + commits (CONTRACT
bans squad git). Phase 1 is pure platform (Node/SQLite) — squarely in the
squad's lane, no Swift gate needed until phase 3.

## 11. Open questions

- `residents` as child table (chosen — queryable, matches drones) vs JSON on
  `runtimes`. If write-amplification on heartbeat hurts, revisit.
- Validate `kind` against an enum, or leave open for arbitrary backends?
  (Lean open + a known-list for UI affordances.)
- Do GPU runtimes and the existing `drones` registry want a shared `host`
  concept later? (Defer — don't block this on it.)

# Memory Failure States — OpenJarvis vs Mycelium, and making Mycelium fail loudly

> Companion to the `feature/m5max/memory-temporal-provenance` branch (bi-temporal
> `am_facts` + provenance). That work made memory *more correct*; this pass makes its
> *failures visible*. The two are different problems.
>
> All claims below are cited to `file:line` and were reproduced before being stated.
> "The brief" = the task prompt that commissioned this doc; corrections to it are in §1C.

---

## TL;DR

- **OpenJarvis and Mycelium fail in opposite ways, exactly as the brief suspected.**
  OpenJarvis *injects* the whole memory file into the prompt (capped at 2500 chars,
  `head_tail` truncation) — it can never fail to *recall* what it stored, but it fails
  by **running out of room** and, worse, by **mid-session writes not reaching the model
  until next boot** (frozen-prefix cache). Mycelium *retrieves* (hybrid FTS5 + vector,
  ~unbounded) — it has no ceiling but fails by **returning the wrong thing, or nothing,
  silently**, so the agent answers confidently from a gap.
- **Mycelium had five silent-failure classes.** This pass makes four of them loud
  (default ON, pure surfacing — retrieval is unchanged) and ships one optional
  correctness fix behind a flag (default OFF). The fifth is documented with a sketch.
- **The gate stayed green:** vitest 972 → **978**, semantic-memory `node:test` 28 → **33**,
  workflows `node:test` 15 (untouched). CI runs only `npm test`; biome is not a gate and
  the baseline already fails it, so new code matches the surrounding `var`/`function`
  style rather than biome's.

---

## Part 1 — The comparison (read both, do not speculate)

### 1A. What each system actually is

**OpenJarvis memory** — `~/Projects/openjarvis-explore/src/src/openjarvis/` (note the
**double `src`**; the brief's paths were one level too shallow). It is **four
disconnected stores**, not two, and only one of them is read by the prompt:

| Store | Path | Written by | Read by the prompt? |
|---|---|---|---|
| Flat `MEMORY.md` | `~/.openjarvis/MEMORY.md` (`tools/memory_manage.py:17`) | `memory_manage` tool | **Yes — the only one** (`prompt/builder.py:57-62`) |
| `memory.db` SQLite | `~/.openjarvis/memory.db` | `memory_store`/`retrieval` tools (**the default backend**, `core/config.py:911`) | **No** — the builder has no `memory_backend` field |
| `knowledge_graph.db` | `~/.openjarvis/knowledge_graph.db` (`tools/storage/knowledge_graph.py:58`) | `kg_*` tools — but they **always fail** in the default path (`knowledge_tools.py:56-64`, returns "No knowledge graph backend available") | No |
| `knowledge.db` (connectors) | connectors `KnowledgeStore` (`connectors/store.py:148`) | Gmail/Slack/Drive ingestion pipeline | No |

So: an agent that uses `memory_store` (the documented default backend) is **silently
writing to a store the prompt never reads**. Only `memory_manage` (the flat file) reaches
the model.

**Mycelium memory** — `~/Projects/mycelium/server/plugins/`. Two cooperating plugins:

| Plugin | Store | Role |
|---|---|---|
| `semantic-memory/` | `sm_embeddings` (FTS5 + vector BLOB, `schema.sql:4-17`) | The **search index**: hybrid keyword (FTS5) + vector (JS-side cosine over the `embedding` BLOB, `db.js:235-289`) over *all* platform content — memories, messages, tasks, concepts, plans, workflows, savepoints, context keys. |
| `auto-memory/` | `am_facts` (bi-temporal, `schema.sql:4-20`) | The **knowledge store**: durable facts with `valid_from/valid_to` validity intervals, `source_authority` (verified/directive/inferred), `verified_at` re-check, `superseded_by` chains. Aria's writer; the consolidation engine; the re-verification queue. |

The bridge: when an `am_fact` is written, `indexFactInMemory()` (`auto-memory/routes.js:280`)
copies it into `sm_embeddings` as `source_type='memory'` so it is searchable. The two
plugins are otherwise independent. (The local DB snapshot — `server/data/mycelium.db`,
Jun 30 — has 649 `sm_embeddings` rows at **100% embedding coverage**; 379 are
`m5max_memory`, 11 are `memory`/am_facts. Provider: ollama `nomic-embed-text` @ :11434.)

> Scope note: the **squad's own** memory (`jarvis/squad/` — `_load_squad_context`,
> Jetson embedder, graph recall, the dream consolidator) is a *client* of this platform,
> not the platform memory itself, and is out of scope here. Same for the file-based
> `~/.claude/.../memory/` Claude memory.

### 1B. Side-by-side

| Dimension | OpenJarvis (injection) | Mycelium (retrieval) |
|---|---|---|
| **Storage** | A flat markdown file (`MEMORY.md`), line-appended | Relational `am_facts` (bi-temporal) + `sm_embeddings` (FTS5 + vector BLOB) |
| **Write path** | `memory_manage add` → append `- {entry}\n` (`memory_manage.py:88-90`). `update` = first-occurrence substring replace (`:111`); `remove` = drop every line containing the substring (`:125-127`). **No locking** — read-modify-write, lost-update clobber on concurrency. | `POST /auto-memory/facts` → `createFact` (transactional) → `indexFactInMemory` into `sm_embeddings`; event-driven extraction on task/request/context writes (`auto-memory/handlers.js`) |
| **Read path** | The **whole file is injected into every prompt**, capped at `memory_max_chars` (default **2500**, `core/config.py:1448`) via `head_tail` truncation (`prompt/builder.py:85-107`) | `POST /memory/search` → hybrid: FTS5 keyword (`db.js:170`) + vector cosine (`db.js:235`), fused by Reciprocal Rank Fusion (`db.js:311-353`) |
| **Scale ceiling** | **~90 facts** at ~25 chars/fact before the 2500-char cap bites; then head 70% + tail 20% survive, **middle dropped**. No eviction/compaction. | No char ceiling. Vector recall caps at **5000 embedded rows** scanned (`db.js:251`) — beyond that, older memories become vector-invisible (surfaced as `vector_scan_capped`, see §F3). |
| **Temporal model** | None — append-only; `update`/`remove` destroy history in place | **Bi-temporal**: `valid_from/valid_to` world-time interval + `verified_at` + `superseded_by`; `factsAsOf()` answers "what did we believe on date X" (`auto-memory/db.js:112-122`) |
| **Multi-agent** | One file per install; no scoping; concurrent writers clobber | First-class `agent_id`/`project_id`/`namespace` scoping; cross-agent sharing via `source_type`/metadata; provenance via `source_authority` |
| **Semantic machinery** | None for agent memory. The connectors `embeddings`/`embedding_store`/`hybrid_search`/`retriever` (`connectors/*.py`) are **real** (Ollama `nomic-embed-text`, brute-force NumPy cosine, optional ColBERT reranker) — but they index **connectors data only** (Gmail/Slack/Drive), never agent memory. **Verified.** | Hybrid FTS5 + vector over everything; RRF fusion; optional async drone embedding |

### 1C. Corrections to the brief

The brief was traced quickly and had three errors; the rest held.

- **WRONG — cap enforcement.** The brief asked whether the cap "truncates from the end,
  drops oldest, or drops by relevance." **None of those.** Default `truncation_strategy
  = "head_tail"` (`config.py:1451`) keeps the **oldest 70%** (head) + **newest 20%**
  (tail) and **drops the middle** with a `[...truncated N chars...]` marker
  (`builder.py:97-106`). Because `add` appends, the natural fill order is oldest-at-top
  → the *middle of the agent's memory lifetime* is what disappears.
- **WRONG — undercount of stores.** The brief named two (flat file + KG). There are
  **four**, and the most important correction: `memory.db` (SQLite) is the **default**
  `MemoryBackend` (`config.py:911`) and `memory_store` writes there — but **the prompt
  builder never reads it**. And the KG is **dead in the default path**: `kg_*` tools keep
  `backend=None` because the dependency injector only matches tools whose name starts
  with `memory_` (`system/builder.py:437-439`), so every call returns `"No knowledge graph
  backend available."`
- **HELD — connectors claim.** The connectors semantic machinery is for connectors data
  only, not agent memory. **Confirmed** (full caller list in the trace; no agent-memory
  write path imports `connectors.*`).
- **HELD — injection shape.** Whole `MEMORY.md` injected, capped at 2500. **Confirmed.**
- **NEW (brief missed it) — frozen-prefix cache.** `prompt/builder.py:38-40` caches the
  prefix on the first `build()`; the builder is constructed once at agent init
  (`cli/serve.py:281-285`), and `test_frozen_prefix_stability` asserts the cache is
  stable across file changes. **Net effect: a `memory_manage add` issued mid-session
  updates the file on disk but does not change that session's prompt — the new fact only
  reaches the model on the next boot.** This is injection's hidden failure mode: writes
  vanish until restart, not just "out of room."

---

## Part 2 — Making Mycelium fail loudly

The brief named four silent-failure classes. The code has all four, **plus a fifth on
the extraction side** that the team's own prior hardening (`auto-memory/stats`
`extraction_errors`, `routes.js:180-196`) tried to catch but missed. Each is below with:
**how it happens · how a caller would (not) notice · the smallest detectable change**.

### §F1 — Returns no/wrong results because semantic search silently degraded to keyword
**Category (3) in the brief: silent degradation.**

- **How.** `POST /memory/search` (`semantic-memory/routes.js:48`) asks for `mode:'hybrid'`.
  It tries to embed the query; if the provider is `none`/unset, or `generateEmbedding`
  throws (ollama down), or returns null (drone-async / unknown provider), it set
  `queryEmbedding=null`, called `searchHybrid(query, opts, null)` — keyword-only — and
  returned **`mode:'hybrid'`** (the *requested* mode, echoed back). The caller (a squad
  agent) believed semantic search ran.
- **Caller notice.** None. The response looked identical to a healthy hybrid search.
- **Fix (shipped, default ON).** The response now reports the **effective** mode:
  `mode:'keyword-fallback'` + `requested_mode:'hybrid'` + a `degraded:{reason,
  fell_back_to:'keyword', note}` block. Retrieval is unchanged — only the honesty.

### §F2 — Returns a false-zero because the project filter runs *after* the limit
**Category (1): no results when a relevant memory exists.**

- **How.** `routes.js` sets `opts.project_id` but `searchKeyword`/`searchVector`/
  `searchHybrid` **ignore it** (dead field); the route then **post-filters** by
  `metadata.project_id` *after* `searchHybrid` has already sliced to the page limit. If
  the relevant project's memories rank just below the cutoff, they are filtered out →
  `count:0` even though they exist. (Also: `opts.project_id` being dead is itself a
  latent bug — the in-DB filter was never wired.)
- **Caller notice.** None — an empty result set, indistinguishable from "nothing stored."
- **Fix — surface (shipped, default ON).** When the filter culls anything, the response
  includes `project_filter:{project_id, results_before_filter, results_after_filter,
  hint}`. A false-zero now says "candidates existed but matched a different scope;
  retry without project_id."
- **Fix — rescue (shipped, FLAG default OFF).** `search_project_overfetch='true'` widens
  the candidate pool (`limit*5`) before the post-filter so crowded-out memories surface.
  Flagged because it widens the scan; OFF = bit-exact with prior behavior. (A proper
  in-DB `json_extract(metadata,'$.project_id')` filter is the real fix — see §4.)

### §F3 — Silently answers as though the store were complete and healthy
**Category (3): partial coverage / index behind.**

- **How.** A search can return three mediocre hits from a **40%-covered** index, or with
  the embedding backend down, and look identical to three good hits from a healthy
  100%-covered index. Separately, once embedded rows exceed **5000**, vector recall
  silently scans only the 5000 newest (`db.js:251`) — older memories become
  vector-invisible. `stats()` already exposed `vector_scan_capped`, but `search` did not.
- **Caller notice.** None.
- **Fix (shipped, default ON).** Every search response now carries an `index:{total,
  embedded, coverage_pct, vector_scan_capped}` block (from a new lightweight
  `db.indexHealth()`, `db.js` — two `COUNT(*)`s, no `stats()` GROUP BYs). A caller can now
  distinguish "thin recall from a degraded/partial index" from "good recall from a
  healthy one."

### §F4 — Loses a write: accepted, but not (fully) searchable
**Category (4): accepted but not indexed / indexed but not searchable.**

- **How.** `POST /auto-memory/facts` writes the fact to `am_facts`, then
  `indexFactInMemory()` inserts a row into `sm_embeddings` **with a NULL embedding** and
  **never calls auto-embed** (there is **no auto-memory backfill worker** — confirmed by
  `grep`). The fact is keyword/FTS searchable immediately but **not vector-searchable
  until an admin manually runs `POST /memory/reindex` or `/memory/backfill-embeddings`**.
  If `indexFactInMemory` itself fails (semantic-memory plugin absent, schema drift), the
  fact is not in the search index at all. Either way the route returned `{ok:true}`.
- **Caller notice.** None — `{ok:true}` hid both "indexed, vector pending backfill" and
  "not indexed at all."
- **Fix (shipped, default ON).** `indexFactInMemory` now returns a status object and the
  route surfaces it: `memory_index:{indexed:true, embedded:false, vector_search:
  'pending backfill (...)'}`, or `{indexed:false, reason}`. The fact is still saved
  (200); the caller just learns its real retrievability.

### §F5 — Extraction failures were swallowed (a hole in the team's own prior hardening)
**Category (3), write side.**

- **How.** `auto-memory/stats` (the prior art, `routes.js:180-196`) already surfaces
  `extraction_errors` — "exactly how the memory quietly broke 2026-07-06." But the
  extraction path had a hole: `extractFacts()` (`routes.js`) **catches the LLM error
  itself and returns `[]`**; the event-driven handlers wrap it in `.catch(...)` that
  calls `logExtractionError` — **but `.catch` never fires, because `extractFacts`
  resolved (with `[]`), it did not reject.** So during a full ollama outage, every
  extraction silently yielded 0 facts AND `/stats` reported **0 errors**.
- **Caller notice.** None — the health surface that was supposed to catch this stayed
  green.
- **Fix (shipped, default ON).** `extractFacts` now logs the two unambiguous breakages
  to `am_extraction_errors` — the `catch` (HTTP/network error) and the
  configured-but-null case (unknown/misconfigured provider). Legitimate "0 facts" (model
  returned a valid empty set) stays silent so it can't drown real signals. `POST /extract`
  surfaces `extraction_health` when 0 facts come back, so "nothing to extract" and "LLM
  down" are distinguishable. The existing `/stats` surface now works as intended.

> **Historical note (already fixed, not by this pass):** `am_facts` had a documented
> silent failure where `pruneLowConfidence` used a `-1` sentinel that violated the
> `superseded_by` FK under `foreign_keys=ON` and "silently pruned NOTHING in prod"
> (`auto-memory/db.js:194-197`). It's fixed (self-supersede). Cited as evidence the team
> has done this hardening before — §F1–F5 follow the same convention.

---

## 3. What was implemented

All changes are **additive response-surfacing + error-logging** unless noted. Retrieval
results are unchanged; only the honesty around them changed.

| Change | Files | Default | Tests |
|---|---|---|---|
| §F1 honest mode + `degraded` | `semantic-memory/routes.js` (`POST /search`) | **ON** | `test.js` ×1 |
| §F3 `index` health on every search + `db.indexHealth()` | `semantic-memory/routes.js`, `db.js` | **ON** | `test.js` ×2 |
| §F2 `project_filter` false-zero surface | `semantic-memory/routes.js` | **ON** | `test.js` ×1 |
| §F2 `search_project_overfetch` rescue | `semantic-memory/routes.js` | **OFF (flag)** | `test.js` ×1 |
| §F4 write-side `memory_index` status | `auto-memory/routes.js` (`POST /facts`, `indexFactInMemory`) | **ON** | `test/unit` ×2 |
| §F5 extraction-error logging + `POST /extract` health | `auto-memory/routes.js` (`extractFacts`, `POST /extract`) | **ON** | `test/unit` ×4 |

New tests: `server/plugins/semantic-memory/test.js` (+5, `node:test`) and
`test/unit/auto-memory-failure-surfacing.test.js` (+6, vitest).

**Flags:** `search_project_overfetch` (sm config, default `'false'`). Enable with
`PUT /memory/config { "search_project_overfetch": "true" }`. Everything else is on by
default — surfacing is the safe direction; it adds JSON fields, never removes or reorders
results.

---

## 4. Reproduction evidence

**The headline failure, reproduced before the fix** (`semantic-memory/test.js`, red→green):
```
✖ search: reports mode=keyword-fallback + degraded when the embedding provider is gone
  AssertionError: effective mode is honest, not the requested hybrid
  + actual:   'hybrid'        ← the silent lie
  - expected: 'keyword-fallback'
```

**End-to-end drive after the fix** (in-memory, provider flipped to `none`, 2 of 3 docs
embedded → `coverage_pct:67`):

```jsonc
// (a) healthy
{ "mode": "hybrid", "index": {"total":3,"embedded":2,"coverage_pct":67,"vector_scan_capped":false}, "count": 2 }

// (b) degraded — provider gone. USED TO BE mode:"hybrid".
{ "mode": "keyword-fallback", "requested_mode": "hybrid",
  "degraded": { "reason": "no embedding provider configured (embedding_provider = none)",
                "fell_back_to": "keyword", "note": "vector search unavailable; results are lexical (FTS5/LIKE) only" },
  "index": {"total":3,"embedded":2,"coverage_pct":67,"vector_scan_capped":false}, "count": 1 }

// (c) project false-zero — USED TO BE a silent empty result.
{ "count": 0,
  "project_filter": { "project_id": "alpha", "results_before_filter": 1, "results_after_filter": 0,
    "hint": "all top candidates matched a different/no project scope — relevant memories likely exist but were filtered out; retry without project_id to confirm" } }
```

**Write-side (§F4)** — `POST /auto-memory/facts` now returns:
```jsonc
{ "ok": true, "id": 1, "fact": { /* … */ },
  "memory_index": { "indexed": true, "embedded": false,
    "vector_search": "pending backfill (POST /memory/reindex or /memory/backfill-embeddings)" } }
```

---

## 5. Open follow-ups (not done — flagged or sketched)

1. **§F2 — the real fix is in-DB project filtering.** Push
   `json_extract(metadata,'$.project_id') = ?` into `searchKeyword`/`searchVector` *before*
   the limit, so the false-zero can't happen at all. Sketched, not shipped: it changes
   result composition and FTS5 makes the join fiddly, so it wants its own PR with the
   overfetch flag removed. The current surface + flagged overfetch are the safe bridge.
2. **Observer-extracted facts are never indexed.** `extractFacts` calls
   `indexFactInMemory(db, …)` passing the **wrapper** (no `.prepare`), not `core.db`
   (`auto-memory/routes.js:263`). So facts extracted via the task/request/context
   observers never reach `sm_embeddings` — only `POST /facts` (Aria's direct writer)
   indexes. Pre-existing; out of scope here but worth a follow-up (pass `core.db`, or
   move indexing out of `extractFacts` to the caller).
3. **`opts.project_id` is dead on the search DB methods.** Remove or wire it (ties into
   follow-up #1).
4. **Vector-scan cap is a hard 5000.** At scale, switch to an ANN index (sqlite-vec is
   already a dependency) instead of JS-side cosine. Until then, `vector_scan_capped` is
   surfaced (§F3) so it's not invisible.

---

*Authored by m5Max on `feature/m5max/memory-temporal-provenance`, 2026-07-26. House rule
honored throughout: honest failure beats forced success — no retrieval was weakened to
make a number look better.*

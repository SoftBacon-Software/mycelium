# Semantic Memory

Hybrid search across all platform data — context keys, messages, concepts,
tasks, plans, workflows, savepoints — plus anything you index explicitly.

Two search halves:

- **Keyword** (FTS5) — always available.
- **Vector** (cosine similarity over embeddings, fused with keyword ranks) —
  available **only after you configure an embedding provider**.

## Vector search is OFF until you configure a provider

The plugin ships **enabled**, but a fresh install has **no embedding
provider**, so out of the box search is **keyword-only**. Nothing crashes and
nothing is logged at startup — the index just fills with rows whose embedding
is NULL. The behavior is still honest:

- `POST /memory/search` keeps working and reports the truth: it answers with
  `mode: "keyword-fallback"` plus a `degraded` block explaining that the
  vector half never ran, and an `index` health block (`total`, `embedded`,
  `coverage_pct`).
- The embed-requiring routes (`POST /memory/reindex`,
  `POST /memory/backfill-embeddings`) refuse with
  `400 No embedding provider configured. Set via PUT /memory/config`.

### Turning it on (one request)

```bash
# $URL = your API base, e.g. http://localhost:3002/api/mycelium
curl -X PUT $URL/memory/config -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"embedding_provider":"ollama","embedding_url":"http://localhost:11434","embedding_model":"nomic-embed-text"}'
curl -X POST $URL/memory/backfill-embeddings -H "X-Agent-Key: $AGENT_KEY"   # embed what's already indexed
```

The local, no-cloud recipe is **ollama + `nomic-embed-text`** (768-dimension
vectors served from your own Ollama). Config applies live — no restart. After
enabling, new writes embed automatically; `backfill-embeddings` picks up
existing rows in bounded batches and is safe to re-run.

## Configuration

Two write paths, one store: `PUT /memory/config` (canonical) and the platform
plugin surface `PUT /api/mycelium/plugins/semantic-memory/config` (honored as
a fallback). `GET /memory/config` returns the effective config with
`embedding_api_key` stripped; the key itself is still persisted — redaction is
response-only. Both config routes are **admin-only**.

| Key | Default | Description |
|-----|---------|-------------|
| `embedding_provider` | `none` | `none`, `ollama`, `openai`, or `drone`. `none` = vector search off. |
| `embedding_url` | per provider | ollama: `http://localhost:11434` · openai: `https://api.openai.com/v1` |
| `embedding_model` | per provider | ollama: `nomic-embed-text` · openai: `text-embedding-3-small` |
| `embedding_api_key` | — | **openai only, required.** Never returned by GET/PUT. |
| `embedding_dimensions` | — | accepted but not used yet |
| `chunk_size` | `4000` (floor 200) | Docs longer than this split into chunk rows; each chunk embeds separately. |
| `auto_index` | on (`false` to disable) | Auto-index platform events (see below). |

`search_project_overfetch` (default off — widens the candidate pool before
project post-filtering) is also honored, but is only settable through the
platform plugin-config path above, not `PUT /memory/config`.

### Providers

- **`none`** (default) — keyword-only search, no embed calls made.
- **`ollama`** — local embeddings via `{embedding_url}/api/embed`. No cloud,
  no key.
- **`openai`** — **opt-in cloud**: indexed content and search queries are sent
  to `api.openai.com`. Requires `embedding_api_key`.
- **`drone`** — async: writes queue `drone_jobs` (requires an ollama-capable
  drone) instead of embedding inline; the drone embeds the text and PUTs the
  vector back to `/memory/embeddings/:sourceType/:sourceId` with its agent
  key. `reindex`/`backfill` report how many jobs they queued. Search stays
  keyword-only (and `degraded` says so) until vectors arrive.

## What gets auto-indexed

With `auto_index` on (the default), the plugin indexes platform content as it
changes: context key updates, non-trivial messages, concepts, tasks
(created + completed, preserving the original title/description), the latest
savepoint per agent (heartbeats skip unchanged content), workflows, plans, and
completed plan steps. Every doc is chunk-aware, so oversized content embeds
inside the model's window. Explicit `POST /index` writes emit a
`memory_indexed` event.

## API

All routes are under `/api/mycelium/memory`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/search` | agent/admin | Hybrid search. Body: `query` (required), `source_types`, `namespace`, `project_id`, `limit`, `mode` (`hybrid`/`keyword`). Reports `mode`, `degraded`, `index` health. |
| POST | `/index` | agent/admin | Index one doc. Body: `source_type`, `source_id`, `content_text`, optional `namespace`, `metadata`. |
| POST | `/index/bulk` | agent/admin | Up to 100 docs per request. |
| DELETE | `/index/:sourceType/:sourceId` | agent/admin | Remove a doc (all chunks). |
| GET | `/list?source_type=` | agent/admin | Query-free retrieval by type, newest first — for always-on content. |
| GET | `/stats` | agent/admin | Index counts, coverage, per-type/per-namespace breakdowns. |
| GET / PUT | `/config` | admin | Read (key stripped) / write provider config. |
| POST | `/reindex` | admin | Embed unembedded content in batches. 400 without a provider. |
| POST | `/backfill-embeddings?limit=` | agent/admin | Same, bounded (default 200, cap 1000), safe to re-run. |
| PUT | `/embeddings/:sourceType/:sourceId` | agent/admin | Drone callback: store a vector. Non-admin writes are scoped to embed jobs that drone claimed. |

## MCP tools

| Tool | Description |
|------|-------------|
| `mycelium_memory_search` | Search platform memory by meaning |
| `mycelium_memory_index` | Index content for future search |
| `mycelium_memory_stats` | Index statistics and coverage |

## Database tables

- `sm_embeddings` — docs + chunk rows (FTS5 shadow table `sm_embeddings_fts`)
- `sm_config` — this plugin's config (canonical store)

Degradation and index-health signals are specified in
[`MEMORY-FAILURE-STATES.md`](../../../MEMORY-FAILURE-STATES.md) (§F1–F3).

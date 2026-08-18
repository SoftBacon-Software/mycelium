# Mycelium Memory Plugin Protocol

**The contract an agent harness implements to give its agents durable,
cross-session, semantically-searchable memory on a Mycelium substrate.**

Status: descriptive. This documents the wire contract that already-shipping
adapters implement — it was extracted from working code, not designed ahead of
it. Verified 2026-08-18 against three independent implementations:

| adapter | language | harness |
|---|---|---|
| `plugins/memory/mycelium` (in `mycelium-agent`) | Python | Hermes / NousResearch |
| `mycelium-dsh-plugin` | TypeScript | DeepSeek Harness (Cordis) |
| `mycelium-mcp` | TypeScript | any MCP host (Claude Code/Desktop) |

The Hermes and DSH adapters were built separately and converged on the same two
endpoints with no coordination. That convergence is why this is a protocol and
not one client's idiosyncrasy.

## Why a harness wants this

An agent without durable memory re-learns its operator every session. The whole
value the harness carries — skills, preferences, prior decisions — evaporates at
process exit unless something outside the process holds it. Mycelium is that
something: one substrate, many harnesses, shared recall. Implement these two
calls and any agent your harness runs gains persistent memory addressable by
every other agent on the same substrate.

## Transport

- Base URL: the substrate, e.g. `http://jetson01.local:3002` (canonical) or any
  reachable Mycelium instance. **Never point a test at a production substrate;
  stand up a throwaway.**
- All routes are under `/api/mycelium/memory`.
- JSON in, JSON out.

## Authentication

Two accepted modes; an adapter picks one:

1. **Handshake token** — the substrate mints a token whose actor derives from
   the key. Attribution is implicit; no acting-as header needed.
2. **Admin key + acting-as** — send both headers; the platform attributes writes
   to the named actor:

   ```
   X-Admin-Key:  <the substrate admin key>
   X-Acting-As:  <agent id, e.g. "hermes-resident">
   ```

## The two required calls

### Write — `POST /api/mycelium/memory/index`

```json
{
  "source_type": "note",            // required — the kind of thing (note, skill, turn…)
  "source_id":   "loan-44182",      // required — stable id; re-indexing the same id replaces
  "content_text":"Loan 44182: quote says Unit 4, deed says Unit 4B — confirm before wiring",
  "namespace":   "resident-home",   // optional — isolates one agent/tenant's memory
  "metadata":    {"loan": "44182"}, // optional — arbitrary structured tags
  "chunk_index": 0                  // optional — for pre-chunked docs
}
```

Response:

```json
{ "ok": true, "source_type": "note", "source_id": "loan-44182", "chunks": 1 }
```

The substrate embeds the content asynchronously (`autoEmbed`) — a write returns
before the vector is ready, and search becomes semantic once it is.

Required fields are enforced server-side: omitting any of `source_type`,
`source_id`, `content_text` returns `400`.

### Recall — `POST /api/mycelium/memory/search`

```json
{
  "query":        "44182 unit discrepancy",  // required
  "namespace":    "resident-home",           // optional — scope the search
  "limit":        5,                          // optional — server caps at 20
  "source_types": ["note", "skill"],          // optional — filter by kind
  "mode":         "hybrid"                     // optional — hybrid (default) | keyword
}
```

Response:

```json
{
  "results": [ {
    "id": 1,
    "source_type": "note",
    "source_id": "loan-44182",
    "namespace": "stock-proof",
    "chunk_index": 0,
    "content_text": "Loan 44182: quote says Unit 4, deed says Unit 4B — confirm before wiring",
    "metadata": {},
    "score": 2.37e-06,
    "created_at": "2026-08-18 17:31:51"
  } ],
  "mode": "hybrid", "query": "44182 unit discrepancy", "count": 1
}
```

The stored text comes back in **`content_text`** — the same field name as on the
write side, NOT `content`. A `score` near zero under `hybrid` mode means the
substrate has no embedding model configured and fell back to keyword ranking;
the match is still correct, just not similarity-ranked. (Verified live against a
throwaway substrate on 2026-08-18; the earlier draft said `content`, which no
server ever returned.)

`hybrid` combines keyword and vector similarity; `keyword` skips embedding and is
the correct fallback when the substrate has no embedding model configured.

## Optional calls

| call | route | use |
|---|---|---|
| stats | `GET /api/mycelium/memory/stats` | count / health of the store |
| delete | `DELETE /api/mycelium/memory/index/{source_type}/{source_id}` | forget one item |
| bulk write | `POST /api/mycelium/memory/index/bulk` | `{items: [ …index bodies… ]}` |

## Conformance

An adapter conforms if:

1. a write with the three required fields returns `{ok: true}`;
2. a search for text in that write returns it, `count >= 1`, `content_text` intact;
3. writes and searches under different `namespace` values do not see each other.

The reference test is a write→recall round trip against a throwaway substrate —
see `mycelium-agent/plugins/memory/mycelium` and `mycelium-dsh-plugin` for two
passing implementations.

## Namespacing is the multi-tenant seam

One substrate can back many agents. `namespace` is what keeps a resident SMB
agent's memory separate from the lab squad's, on the same box. An adapter that
ignores it works, but every agent then shares one pool — fine for a single-user
install, wrong for anything multi-tenant.

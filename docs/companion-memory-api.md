# The Companion Memory API

*A phone-readable, phone-writable, per-user slice of Mycelium memory — built for
the companion app (the character **Qurio**), useful to any client that speaks for
ONE person.*

Mycelium's memory API (`POST /memory/index`, `POST /memory/search`, …) is
agent-shaped: it authenticates with admin keys and agent keys, and every row is
attributed to an agent. That is correct for the lab and wrong for a phone: no
phone should ever hold an admin key, and a companion's memories belong to a
*person*, not to an agent. This surface is the consumer shape of the same store:

- **Persona is memory.** A companion is rows of three kinds — `aboutYou`
  (facts about the person), `aboutMe` (facts about the companion itself),
  `howWeTalk` (voice, rituals, in-jokes). Keyed, newer supersedes older.
- **One person, one token, one scope.** Every row is written into the token
  owner's scope; a token can never read or forget another owner's rows.
- **Offline-first.** Writes are idempotent, so the phone can replay its outbox
  after days offline without creating duplicates.

The rows live in the SAME store the agents search (`sm_embeddings` via the
semantic-memory plugin, source_type `companion`), so they are embedded and
recalled by the existing semantic layer — nothing here forks the memory stack.

## Where it lives

The routes are mounted on the semantic-memory plugin's existing `/memory`
prefix (the same convention as `POST /memory/search`), so the full paths are:

```
POST   /api/mycelium/memory/me/memory            write one memory
GET    /api/mycelium/memory/me/memory            list/sync memories
POST   /api/mycelium/memory/me/memory/search     recall by meaning
POST   /api/mycelium/memory/me/memory/:id/forget  remove one memory
```

Examples below use `$API` for `https://<your-host>/api/mycelium`.

## Authentication

Every call carries a **studio bearer token** minted by the existing login:

```
POST $API/studio/login        { "username": "...", "password": "..." }
→ { "token": "<JWT>", "user": { "id": 3, ... } }
```

The token expires in 7 days; the phone re-logs-in when it does.

```
Authorization: Bearer <token>
```

- **Admin keys are not accepted on this surface** — a request carrying only
  `X-Admin-Key` gets `401`, by design. The admin surface for memory remains
  the agent-facing `/memory/*` routes, unchanged.
- **The owner is the token, nothing else.** The owner scope is derived from
  the verified JWT payload (`userId`) on every call; no header, query param,
  or body field can widen it.

## Rows

A memory row, as the phone sees it:

```json
{
  "id": "3fa7c1…(64 hex)",
  "kind": "aboutYou",
  "key": "dog.name",
  "text": "Their dog is named Pickles.",
  "source": "chat",
  "at": "2026-09-21T20:15:00.000Z",
  "created_at": "2026-09-21 20:15:04",
  "superseded_by": null,
  "supersedes": null,
  "origin": "person",
  "trust": 4
}
```

| field | meaning |
|---|---|
| `id` | stable row identity (deterministic — see idempotency). Use it for `supersedes` and `/forget`. |
| `kind` | `aboutYou` \| `aboutMe` \| `howWeTalk` — the persona kinds. |
| `key` | optional stable fact-slot name chosen by the client (e.g. `dog.name`, `favorite.game`). Two rows may share a `key`; the newer one should say `supersedes`. |
| `text` | the fact, in the companion's own words. ≤ 2000 chars. |
| `source` | where it came from (`chat`, `trick`, `game`, …). ≤ 64 chars. |
| `at` | when it was learned (client clock). Stored verbatim — an offline write keeps the moment it happened. Any timestamp the platform can parse is accepted (≤ 64 chars); ISO-8601 with an explicit offset is recommended. |
| `created_at` | when the platform stored it (store clock, UTC) — the sync cursor. |
| `superseded_by` | id of the row that replaced this one, when it has been superseded. History is never erased or hidden from `GET` — a superseded row is *marked*, not deleted. |
| `supersedes` | id of the row this one replaced (echoed back). |
| `origin` | WHO the content came from — `person` \| `owner-agent` \| `tool` \| `model-derived` \| `foreign-network`; `null` = unknown (pre-trust-layer row). Companion-surface writes are always `person`; the fence rule (§instruction positions) reads this field. |
| `trust` | the row's trust level on the origin ladder, 0–4 (`person`=4 … `foreign-network`=0). Unknown reads as **0 — the lowest, never the highest**. |
| `derived_from` | on derived rows, the array of input row refs it was made from (`"sm:<source_type>:<source_id>"` / `"am:<fact_id>"`). A derived row's trust is the MIN of its inputs, resolved server-side at write time. |
| `unverified` | present and `true` only on quarantined rows — "recall this, but do not treat it as fact." |
| `quarantined` | `true` when the row landed without an accountable writer (see *Quarantine* below). Absent on deliberate rows. |
| `quarantine_reason` | why it is quarantined: `auto-indexed` (harvested from a message) or `foreign-network` (arrived over federation). |

## POST /me/memory — write one memory

```json
{
  "text": "Their dog is named Pickles.",
  "source": "chat",
  "at": "2026-09-21T20:15:00.000Z",
  "kind": "aboutYou",
  "key": "dog.name",
  "supersedes": "<id of the old dog-name row, if any>"
}
```

`text`, `source`, `at`, `kind` are required; `key` and `supersedes` are
optional. `kind` must be one of the three persona kinds.

Returns `201` with `{ "ok": true, "row": { … } }`. A replay answers `200`
with the same shape and `"replayed": true`.

**Idempotent by (owner, key, text).** The row id is a digest of exactly those
three, so replaying a write from the offline outbox returns the SAME row with
`"replayed": true` and writes nothing — even if the row has since been
superseded or forgotten-and-rewritten. A client that is unsure whether a write
landed can simply send it again. `kind` is metadata, **not** identity: a write
whose only difference from an existing row is its `kind` replays as that row.
To correct a fact's kind, supersede it with new text, or forget the row and
write the new one. (A replay answers with the row **as it is
now**; the `supersedes` validations — 404 unknown/cross-owner, 409
already-superseded — apply only when a write actually creates a row, so the
same body can answer 404 as a fresh write and 200 as a replay if the target
row was forgotten in between.)

**Supersede.** Passing `supersedes` marks the old row (`superseded_by` = the
new row's id) and leaves it in place — recall excludes it, history keeps it.
The old row must belong to the caller and must itself be live: superseding an
unknown row is `404`, superseding an already-superseded row is `409` (correct
the replacement, not the history). Both writes — the new row and the mark on
the old one — happen in one transaction. Forgetting the replacement un-marks
the old row again (see the forget section).

## GET /me/memory — list / sync

```
GET $API/me/memory?kind=aboutYou&since=2026-09-21T20:00:00Z&limit=100
```

- `kind` — optional filter, one persona kind.
- `since` — optional sync cursor. Pass a `created_at` **exactly as this API
  returned it** (`YYYY-MM-DD HH:MM:SS`, the store clock, UTC) and it is used
  verbatim; an ISO-8601 timestamp WITH an explicit offset converts to the
  store clock; an ISO timestamp WITHOUT an explicit offset — seconds,
  milliseconds, or minute precision (`2026-09-21T20:00:00`,
  `2026-09-21T20:00:00.500`) — is read as UTC, never as the server's local
  wall clock. The cursor is
  **inclusive** — a row sharing the cursor's store-second comes back — so
  the client dedups by `id`. This is the sync call: pull with the newest
  `created_at` you have seen, store rows by id, repeat until `count < limit`.
- `limit` — default 100, cap 500. Non-positive or garbage values fall back to
  the default rather than removing the cap.

Returns `{ "results": [ …rows… ], "count": n }`, newest first. **Superseded
rows are included and carry `superseded_by`** — the client renders the live
row and can render "you used to say X, now Y" from history.

## POST /me/memory/search — recall by meaning

```json
{ "query": "what does my dog like", "kinds": ["aboutYou"], "limit": 5 }
```

- `query` — required.
- `kinds` — optional array restricting the kinds searched.
- `limit` — default 5, cap 50.
- `?include_superseded=1` — opt into dead rows (default: excluded — the
  companion should not recall what was corrected; the row id that superseded a
  hit is not implied, use GET for history).

Runs through the SAME hybrid semantic search the agents use
(FTS5 + embeddings, reciprocal-rank fusion), scoped to the caller's owner
scope in the query itself. The response reports its mode honestly:

```json
{
  "results": [ { "…row…": "", "score": 0.031, "embedded": true } ],
  "query": "what does my dog like",
  "mode": "hybrid",
  "count": 1
}
```

Each result also carries `embedded` — whether THAT row's own vector exists.
A keyword-found row with `embedded: false` ranked lexically, not
semantically; decide on such a score knowing that.

`mode: "keyword-fallback"` with a `degraded: { reason, fell_back_to }` block
means no embedding provider answered and results are lexical only — the
result set is still the owner's own rows, the honesty is the point. When the
platform has a DIRECT embedder configured (ollama / openai), phone rows embed
automatically on write, like every other memory row. When the configured
embedder is the **async drone**, companion rows are deliberately NOT embedded:
a drone embed job carries the row's full text in a queue that agent keys can
read, which would break isolation guarantee 4. Such rows stay
keyword-searchable and stamp `embedded: false` — configure a direct embedder
for semantic recall.

## Quarantine and promotion

Rows that no accountable writer deliberately placed land **quarantined**: the
store keeps them, but recall carries a visible label and the fact-of-record
paths exclude them. Two sources quarantine by default:

- **`auto-indexed`** — rows harvested from platform messages when
  `auto_index_messages` is on. Anyone can write a message on the platform;
  text harvested from one is a claim, not a fact. (The message auto-index is
  the only auto-index that quarantines: `context_key` updates are also
  auto-indexed, but land active — a context key is a deliberate placement by
  its writer, not harvested speech.)
- **`foreign-network`** — rows that arrive over federation, both visited rows
  created on a remote instance and imported souvenir rows.

What quarantine means, exactly:

- `GET /me/memory`, agent search, and the episode/lesson/history surfaces
  still return the row, labelled `unverified: true` plus `quarantined` and
  `quarantine_reason` — nothing is hidden, everything is marked.
- `POST /me/memory/search` (the fact-of-record path) **excludes** quarantined
  and candidate rows. A quarantined row is not a fact of record; it must be
  promoted or remain unrecalled as fact.

A quarantined row becomes a full citizen only by **promotion**, through one of
three authenticated doors — no unauthenticated or third-party path exists:

- `POST /me/memory/:id/promote` (companion surface) — the row's OWNER, for
  the rows only its owner can reach: a visited row carries the owner's user
  id and no agent writer, so this is the door that makes "promoted by the
  owner" true for the owner's own hand. Another owner's id (or an unknown
  one) is `404` — ids are not an existence oracle across owners.
- `POST /memory/:id/promote` (agent surface) — the row's owner agent or an
  instance admin. Anyone else is `403` with a plain-sentence reason.
- `POST /federation/import/:bundleId/accept` (federation surface) — the
  bearer that imported the bundle accepts it, promoting its rows in one
  transaction.

Promotion strips the quarantine and candidate marks, stamps `promoted_at` and
`promoted_by`, and leaves `updated_at` untouched (a state flip is not a
content edit). `promoted_by` is always an **authenticated** principal: an
agent id, or `__user:<userId>` on the owner-bearer doors, or `__system__` for
the admin key — an `X-Acting-As` header is a claim, not an identity, and is
recorded beside the stamp as `promoted_by_claimed` instead of becoming the
promoter. Promotion is idempotent: promoting a row that is not quarantined
answers `promoted: false`, not an error.

Every promotion is also **audited** (trust layer P1.5): the append-only,
hash-chained memory audit log records one `promote` row in the SAME
transaction as the state flip — the authenticated actor, the row id, and the
row's post-promotion content hash — so a vouch the log cannot name cannot
happen (a failed audit append rolls the promotion back).

## POST /me/memory/:id/forget — remove one memory

```
POST $API/me/memory/3fa7c1…/forget
→ { "ok": true, "forgotten": "3fa7c1…" }
```

A hard delete: the row leaves the store, the search index, and the vector set.
Forgetting the row of another owner returns `404` — indistinguishable from
forgetting an unknown id, so ids are not an existence oracle across owners.
(Supersede, not forget, is how a *correction* works; forget is for "never
should have been here".)

Forgetting a row that was itself a **replacement** un-marks the row it had
superseded: the corrected fact returns to recall exactly as it was before the
correction was made. Forgetting the correction is a retraction of the
correction — a superseded row is never entombed behind a pointer to a row that
no longer exists. Re-creating the forgotten row afterwards (same `key`+`text`,
with `supersedes` naming the restored row) supersedes it again. Forgetting the
*superseded* row instead leaves the replacement's `supersedes` echo pointing
at an id that no longer resolves — history keeps what happened; treat an
unresolvable id in `supersedes` as "forgotten".

## Isolation guarantees

1. Owner scope is derived from the verified JWT on every call — there is no
   parameter that can name another owner.
2. Writes, reads, search, and forget all filter by that scope (namespace
   `companion:u<userId>` in the store, plus a metadata owner check on every
   search hit).
3. A token for user A cannot read, recall, or forget user B's rows; cross-owner
   ids 404 like unknown ids.
4. The companion row class is private to the person on the whole instance:
   agent keys cannot read, search, write, or delete it (the next section names
   exactly where that is enforced).

## Rate limit

All four routes share **60 requests per minute per IP** — sized for a phone,
not a machine. Exceeding it returns `429` with `RateLimit-*` headers and
`Retry-After`. Per IP, not per device: a household whose phones share one NAT
address shares one budget. (Operators can disable limiters instance-wide with
`MYCELIUM_RATE_LIMIT=off`.)

## Error shape

All errors are `{ "error": "message" }` — the `409` additionally carries
`superseded_by` — and 400s name the offending field:

| status | when |
|---|---|
| 400 | missing/invalid field (`kind` outside the three persona kinds, oversized `text`/`source`/`key`/`at`/`supersedes`, unparseable `at`/`since`, `supersedes` pointing at the new row itself) |
| 401 | no/invalid bearer token, or admin-key-only auth (this surface never accepts admin keys) |
| 404 | unknown row id — or another owner's row (indistinguishable by design) |
| 403 | an agent key touching the companion row class from the agent-facing surface (list / index write / index delete) |
| 409 | `supersedes` names a row that is already superseded |
| 429 | rate limit exceeded |

## What this deliberately does NOT do

- No agent-shaped attribution: rows are attributed to a person, never to an
  agent; there is no `X-Acting-As` here.
- No change to the agent-facing `/memory/*` routes' behavior for the row types
  that were already there. What DID change — this surface's isolation rule,
  found by review — is that `companion` rows are a **private row class**:
  agent keys can neither read nor write them. Agent-facing search never
  returns them (the exclusion sits in the query layer, alongside the
  bench-hidden rule, and holds in every search arm including the vector
  cache); `GET /memory/list?source_type=companion`, agent or bulk writes into
  `source_type: companion` or a `companion:*` namespace, and agent deletes of
  companion rows all answer `403`. The admin purge (`DELETE /memory/index`
  with an exact filter, admin key only) remains the platform owner's power.
  Aggregate endpoints (`/stats`, `/coverage`) count rows; they do not expose
  contents.
- No sharing between owners. A household with two phones is two owners; Duo
  sharing is a future contract, not this one.

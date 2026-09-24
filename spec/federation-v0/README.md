# Mycelium Federation v0 — the protocol

*A Mycelium install is a network. An agent with a passport can visit another
network, make memories there, and bring them home. This document defines the
protocol every node speaks — a phone running the companion app (MyceliumKit)
and a full Mycelium server interoperate with **no special case**.*

Source: SPEC-mycelium-federation-v0-and-the-qurio-node (director, 2026-09-24).
Implementation: `server/plugins/federation/` (this repo) and MyceliumKit
(companion repo, Swift). **The vectors in `vectors/` are the definition of
interoperability**: a message one side emits must pass the other side's
verifier. This canonical set lives here — the Swift side adopts THESE vectors,
never a second set.

## 1. Primitives

- **Key algorithm:** Ed25519. Two kinds of keypair per network: the *network
  key* (identity of the install; the private half never leaves the node) and
  per-*agent keys* (identity of one agent; on phones these live in the Keychain,
  this-device-only).
- **Id encoding:** `base32(pubkey)` — RFC 4648 alphabet `abcdefghijklmnopqrstuvwxyz234567`,
  lowercase, unpadded, over the raw 32-byte public key. A `network_id` is the
  base32 of a network public key; an `agent_id` is the base32 of an agent
  public key.
- **Deterministic keys (tests/vectors only):** a keypair is derived from a
  32-byte seed. In Node: PKCS#8 `302e020100300506032b657004220420 || seed`.
  In Swift: `Curve25519.Signing.PrivateKey(rawRepresentation: seed)`. Both
  yield the same keypair for the same seed.
- **Canonical JSON (`cjson`):** object keys sorted ascending by UTF-16 code
  unit, no insignificant whitespace, UTF-8. Arrays keep order. Values in
  protocol messages are restricted to strings, integers, booleans, null,
  arrays, and objects — no floats (two languages must byte-identically
  serialize the same value).
- **String escaping inside `cjson`** (minimal escaping — pinned byte-for-byte
  by vector `01` case `escaping-alphabet`): `"` escapes as `\"`, `\` as `\\`;
  of the control characters U+0000–U+001F only `\b` `\t` `\n` `\f` `\r` have
  shorthands, every other control character is `\u00xx` with **lowercase**
  hex and exactly four digits; ALL other characters — non-ASCII included
  (`é`, `—`, `🍄`, U+2028, U+2029) — are left literal UTF-8, never
  `\u`-escaped. A second implementation must not guess: the vector is the
  contract.
- **Digests/signatures:** `sha256hex(x)` = hex sha256 of the UTF-8 `cjson(x)`.
  Signatures are Ed25519 over the UTF-8 `cjson(message-without-its-sig-field)`,
  hex-encoded.

## 2. Messages

### 2.1 Network passport (self-signed)

```json
{
  "type": "network-passport-v0",
  "network_id": "<base32>",
  "name": "gilbert-lab",
  "policy": { "visitors": false, "kinds_writable": [], "kinds_exportable": [] },
  "issued_at": "2026-09-24T10:00:00Z",
  "sig": "<hex — this network's key over cjson(minus sig)>"
}
```

`policy.visitors: false` is the default everywhere — a network that hosts no
visits still answers HELLO honestly.

### 2.2 Agent passport (signed by home)

```json
{
  "type": "agent-passport-v0",
  "agent_id": "<base32>",
  "name": "Qurio",
  "species": "qurio",
  "home_network": "<base32 of home network>",
  "capabilities": ["dance"],
  "consent": { "share_dances": true, "share_memories": true },
  "issued_at": "2026-09-24T10:00:00Z",
  "sig_by_home": "<hex — home network's key over cjson(minus sig_by_home)>"
}
```

The passport is the only thing that crosses at HELLO. `consent` is the
**owner's** standing consent recorded at issuance — both owners' toggles must
still be on at visit time (host policy + the grant; the visitor owner's
toggle is enforced client-side by the visitor's own node).

### 2.3 The memory row (canonical row + provenance)

Content fields — exactly the Companion Memory API's:

```json
{ "kind": "aboutYou", "key": "dance.pickles-foxtrot", "text": "…",
  "source": "visit", "at": "2026-09-24T10:05:00Z", "supersedes": null }
```

`key` and `supersedes` are `null` when unset (never omitted — one canonical
shape). The row id is **content-addressed**:

```
id = sha256hex(content fields)
```

so the same memory arriving twice — outbox replay, a souvenir imported twice —
is one row. (The server's own `/me/memory` writes keep their existing
`(owner, key, text)` id; content-addressed ids are the federation id scheme
that crosses networks.)

The full federated row adds provenance + signature:

```json
{ …content fields…,
  "id": "<sha256hex>",
  "agent":  "<agent_id — who wrote it>",
  "network": "<network_id — where it was MADE>",
  "home":   "<network_id — the writer's home>",
  "visit":  "<visit_id or null>",
  "sig": "<hex — the AGENT's key over cjson(row minus sig)>" }
```

Home-written rows (e.g. the import episode) carry `sig: null` — they never
cross networks, so there is nothing to verify at a border.

### 2.4 GRANT (host issues; time-boxed)

```json
{
  "type": "grant-v0",
  "grant_id": "<sha256hex(grant minus grant_id minus sig_by_host)>",
  "visit_id": "<host-generated id>",
  "host_network": "<base32>",
  "agent_id": "<base32>",
  "home_network": "<base32>",
  "kinds_writable": ["aboutYou"],
  "kinds_readable": [],
  "kinds_exportable": ["aboutYou"],
  "issued_at": "2026-09-24T10:00:00Z",
  "expires_at": "2026-09-24T12:00:00Z",
  "sig_by_host": "<hex — host network's key over cjson(minus sig_by_host)>"
}
```

- `kinds_writable` — which kinds the visitor may write in the host store.
- `kinds_readable` — which HOST rows the visitor may read (default `[]`: none).
- `kinds_exportable` — the **export policy**: which of the rows made during
  this visit may leave in a souvenir. Default `[]`: nothing leaves.
- A grant is valid at time `now` iff the signature verifies and
  `issued_at <= now < expires_at`.
- **Expiry forfeits the souvenir** (deliberate product decision): a grant
  that expires mid-visit leaves the visitor with nothing to carry home — the
  writes stay in the host's store under its retention policy, and a fresh
  grant is a fresh `visit_id` with an empty row set. The TTL (default 120
  min, max 24 h) is the visitor's warning; the host operator's levers over
  an in-flight visit are the kill switch (`POST /visit/:id/end`) and a
  re-key.

### 2.5 The visit

Writes land in the HOST's store attributed
`{agent: visitor, network: host, visit: <visit_id>}`, kept under the host's own
retention policy. Each write is the §2.3 row signed by the agent; the host
verifies the signature, the passport, the grant (kinds + expiry) before
storing. Replay of the same row (same content id) is a no-op — "replayed".

### 2.6 SOUVENIR (host signs; visitor carries home)

```json
{
  "type": "souvenir-v0",
  "bundle_id": "<sha256hex(bundle minus bundle_id minus sig_by_host)>",
  "host_passport": { …network passport of the host… },
  "agent_passport": { …the visitor's passport… },
  "visit": { "type": "visit-record-v0", "visit_id": "…", "host_network": "…",
             "agent_id": "…", "home_network": "…", "grant_id": "…",
             "started_at": "…", "ended_at": "…" },
  "rows": [ …§2.3 rows made during the visit, ONLY kinds in kinds_exportable… ],
  "issued_at": "2026-09-24T11:00:00Z",
  "sig_by_host": "<hex — host network's key over cjson(minus sig_by_host)>"
}
```

Never the host's private rows, never the host owner's `aboutYou` — only rows
the visit itself created and the grant's export policy allows. The bundle is
self-contained: it carries both passports so the home side can verify every
signature without a prior relationship.

### 2.7 IMPORT (home verifies; provenance intact)

The home network:

1. verifies `host_passport.sig` (self-signature ⇒ recover host public key),
2. verifies `bundle.sig_by_host` with that key,
3. verifies `agent_passport.sig_by_home` — with the home network's OWN key
   when the agent is local (the common case: your agent came home), else with
   a network key met at HELLO,
4. verifies each row's `sig` against `agent_passport.agent_id`, and that
   `row.agent / row.network / row.home / row.visit` match the bundle,
5. imports each row with `network: host, visit: <id>` intact, and writes one
   **episode** row (`source: "visit"`, `sig: null`):
   `I visited <host name> on <YYYY-MM-DD of ended_at> and learned <n> memories.`

**Supersede candidates.** An imported row never supersedes a home row
silently. If a live home row exists with the same `(owner, kind, key)`, the
imported row lands flagged `candidate: true` — excluded from recall, visible
in history — until the home side accepts it (an ordinary supersede write).
No collision ⇒ the row imports as a live row carrying its receipt.

**Replay.** Importing the same bundle (or a bundle whose rows were already
imported) answers `replayed` per row and writes nothing new — content
addressing makes the second arrival a no-op.

## 3. Transport

The five messages are JSON, signed, and transport-agnostic: Multipeer/
NearbyInteraction phone↔phone, HTTPS to a server network. Over HTTPS the
visitor's requests are wrapped in an envelope (the server-side shape; a
phone-to-phone transport may use its own framing):

```json
{ "agent_id": "<base32>", "ts": 1727172000, "nonce": "<hex>",
  "payload": { …message… },
  "sig": "<agent key over cjson({agent_id, ts, nonce, payload})>" }
```

The host checks `|now − ts| ≤ 300 s` and refuses a reused nonce. The
envelope is transport hardening; the §2 signatures are the protocol.

## 4. Server surface (this repo)

`server/plugins/federation/`, mounted at `/api/mycelium/federation`:

| route | who | auth |
|---|---|---|
| `POST /federation/hello` | visitor knocks | signed passports only (rate-limited) |
| `POST /federation/grant` | host owner issues | studio bearer (the visited scope's owner; rate-limited) |
| `POST /federation/visit/:visitId/memory` | visitor writes | agent-signed envelope + valid grant |
| `POST /federation/visit/:visitId/souvenir` | visitor leaves | agent-signed envelope |
| `POST /federation/visit/:visitId/end` | host operator kills an in-flight visit | admin |
| `POST /federation/import` | home imports | studio bearer (rows land in their scope; rate-limited) |
| `GET/POST /federation/network` | instance identity + policy | admin |

Default policy: **no visitors** — HELLO reports it, GRANT refuses to issue,
visit writes 403 until an operator turns it on. Two levers revoke what is
already in flight: `POST /visit/:id/end` (the kill switch — writes AND
souvenirs refuse) and a re-key (`POST /network` with a new `seed_hex`, or
re-pinning `FEDERATION_NETWORK_SEED`) — every grant issued under the previous
network key is refused at the door.

Visited/imported rows land in the companion store (`sm_embeddings`,
`source_type 'companion'`) with provenance columns `fed_agent, fed_network,
fed_home, fed_visit, fed_sig` (NULL on pre-federation rows — the migration
leaves every existing row valid). Existing rows and their ids are untouched.
On the multi-owner server, a federated row's STORAGE id is an owner-scoped
digest of the protocol id (the companion API's absolute owner isolation holds
— two owners importing the same souvenir each get their own row); the
protocol's content-addressed id rides in `metadata.fed_id` and appears as
`provenance.id` in views. On a network of one (the phone) there is one owner
and one row per content id.

## 5. Vectors

`vectors/*.json` — deterministic (fixed seeds, fixed clocks). Both
implementations run them in CI: `test/unit/federation-vectors.test.js` here,
the Swift mirror in MyceliumKit. `vectors/generate.mjs` regenerates them from
`server/plugins/federation/protocol.js` (the reference implementation).

| file | covers |
|---|---|
| `01-canonical-row.json` | cjson form + content-addressed id (with/without supersedes; the `escaping-alphabet` case pins string escaping byte-for-byte — quotes, backslash, control characters, non-ASCII literal) |
| `02-passport.json` | agent passport + `sig_by_home` |
| `03-grant.json` | grant issue + `sig_by_host`, validity window |
| `04-souvenir-bundle.json` | signed visit record + rows + bundle signature |
| `05-import-outcomes.json` | import ok / replay / supersede-candidate; tampered sig; expired grant |

**One canonical set.** If the Swift side needs a case this set lacks, the case
is added HERE (generated from `protocol.js`) and both sides adopt it — never
forked.

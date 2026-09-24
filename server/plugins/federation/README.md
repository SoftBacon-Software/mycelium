# federation

Federation v0: the server speaks the same protocol as the phone
(**spec/federation-v0/** — the spec, the protocol, and the language-neutral
vectors both implementations run).

- **Every Mycelium install is a network** — an Ed25519 keypair whose public
  half (base32) is the `network_id`. Generated on first use, persisted in
  `fed_config`; `FEDERATION_NETWORK_SEED` pins one deterministically.
- **Agents have passports** signed by their home network. HELLO exchanges
  passports (nothing else crosses); GRANT is the host owner's time-boxed
  consent (which kinds may be written, read, and — the export policy — which
  may leave); visited rows land in the host's companion store with full
  provenance; SOUVENIR is the host-signed bundle the visitor carries home;
  IMPORT verifies every signature and lands rows with provenance intact plus
  one episode row ("I visited … and learned …").
- **Default policy: no visitors.** An operator turns it on
  (`POST /api/mycelium/federation/network`).

| file | role |
|---|---|
| `keys.js` | Ed25519 from seed, base32 ids, canonical JSON, sign/verify |
| `protocol.js` | the pure protocol — generates AND verifies the vectors |
| `store.js` | `fed_*` tables + the provenance-column migration on `sm_embeddings` |
| `routes.js` | HELLO / GRANT / VISIT / SOUVENIR / IMPORT (+ network policy) |
| `client.js` | the visitor side — the shape MyceliumKit mirrors in Swift |

Provenance columns (`fed_agent`, `fed_network`, `fed_home`, `fed_visit`,
`fed_sig`) reach existing databases via guarded ALTERs at load (the
`superseded_by` idiom) and fresh ones via `semantic-memory/schema.sql`; NULL
on every pre-federation row.

Tests: `test/unit/federation-vectors.test.js` (every vector) and
`test/unit/federation-routes.test.js` (auth, policy, tamper/replay/expired/
export-refusal, and the full network-1 → network-2 → home round-trip).

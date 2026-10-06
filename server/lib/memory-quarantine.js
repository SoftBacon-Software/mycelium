// TRUST LAYER P1.3 (F-mycelium/266, PROGRAM-mycelium-trust-layer-2026-09-26 §P1.3)
// — quarantine by default for low-trust writes: the state, the visible label,
// and the promote stamp, ONE definition for every memory surface that touches
// them. semantic-memory and federation both import this (a shared lib import,
// like memory-auth.js / rate-limit.js — never a cross-plugin import).
//
// The law in one line per piece:
//
//   WRITE    auto-indexed agent messages and foreign-network rows land with
//            metadata.quarantined = true + metadata.quarantine_reason. A
//            quarantined row is a CANDIDATE: visible, searchable, never
//            vouched for by the platform.
//   RECALL   a quarantined row carries the visible `unverified` label on
//            every recall surface (search, list, the companion view), and is
//            EXCLUDED from instruction positions — the companion fact-of-
//            record search drops it, and no boot/system assembly carries
//            memory-row text at all.
//   PROMOTE  only the row's owner or an admin clears the state, through
//            POST /me/memory/:id/promote (the owner's companion surface),
//            POST /memory/:id/promote (agent surface), or the federation
//            accept route (an imported bundle). The stamp below is the ONE
//            promote shape, so the routes cannot drift.
//
// The state lives in METADATA, not a column, on purpose: no migration, no
// schema coupling, and the sibling P1.1 branch (265) owns the origin/trust
// columns — when that lands, its foreign-network origin and this flag agree
// by construction (a foreign-network row is quarantined at write time by
// the federation store; see insertFedRow).

export var QUARANTINE_AUTO_INDEXED = 'auto-indexed';
export var QUARANTINE_FOREIGN_NETWORK = 'foreign-network';

// The state stamp a low-trust write merges into its metadata.
export function quarantineMeta(reason) {
  return { quarantined: true, quarantine_reason: reason };
}

export function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata === 'string') {
    try { var m = JSON.parse(metadata || '{}'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; }
  }
  return {};
}

export function isQuarantined(meta) {
  return !!(meta && meta.quarantined);
}

// The visible recall label. Mutates the response row in place and returns it:
// `unverified` is the flag every client is told to render (the human-readable
// word), `quarantined`/`quarantine_reason` carry the machine state.
export function applyRecallLabel(row) {
  var meta = parseMeta(row && row.metadata);
  if (isQuarantined(meta)) {
    row.unverified = true;
    row.quarantined = true;
    row.quarantine_reason = meta.quarantine_reason || null;
  }
  return row;
}

// The ONE promote stamp: strip the quarantine state (and the federation
// collision candidate — accepting a candidate is exactly what promote is),
// record who promoted and when. Callers persist this per chunk of the row's
// source_id; the routes own the auth check and the transaction.
//
// The stamp shape (review A MAJOR 1/MINOR 2): `promoted_by` is ALWAYS an
// AUTHENTICATED principal — an agent id, or `__user:<userId>` on the
// owner-bearer doors, or `__system__` for the admin key. A claim that arrived
// in a header (`X-Acting-As`) is never the stamp: the admin-key door passes
// it as `claimedBy` and it lands in `promoted_by_claimed`, so a vouch can
// never be forged by naming someone in a header.
export function promotedMeta(meta, promotedBy, claimedBy) {
  var next = Object.assign({}, meta);
  delete next.quarantined;
  delete next.quarantine_reason;
  delete next.candidate;
  next.promoted_at = new Date().toISOString();
  next.promoted_by = promotedBy;
  if (claimedBy) next.promoted_by_claimed = claimedBy;
  return next;
}

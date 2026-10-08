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

// P1.6: the label carries the P1.2 datamark, imported — never duplicated — so
// the fence and the label cannot drift (memory-fence imports nothing from
// this module; no cycle).
import { MEMORY_DATA_DATAMARK } from './memory-fence.js';

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

// TRUST LAYER P1.6 (F-mycelium/270): the ONE definition of an UNVOUCHED row —
// the set that carries the visible recall label AND takes the retrieval-trust
// demotion, so the two can never disagree. Three legs:
//   quarantined       the P1.3 state (every foreign-network row, every
//                     auto-indexed message) — metadata.quarantined
//   candidate         the supersede-collision flag from before P1.3 (an
//                     imported row that is not the fact of record)
//   foreign origin    the P1.1 origin COLUMN says foreign-network even though
//                     the metadata flag is missing (the backfill stamped old
//                     fed rows' columns only)
//
// A promote stamp VOUCHES: promoted_by (the P1.3 stamp) clears the label and
// the demotion on every leg — the owner's or admin's vouch is exactly the act
// that makes the row platform-vouched, and the origin column keeps its
// provenance truth (the row DID cross a border) without re-labeling it.
export function needsRecallLabel(row, meta) {
  meta = parseMeta(meta);
  if (meta && meta.promoted_by) return false;
  return !!(isQuarantined(meta) || (meta && meta.candidate) || (row && row.origin === 'foreign-network'));
}

// The reason string for a labelled row: the stored quarantine reason when the
// metadata carries one, the origin column when only it says foreign, else null.
export function recallLabelReason(row, meta) {
  meta = parseMeta(meta);
  if (meta && meta.quarantine_reason) return meta.quarantine_reason;
  if (row && row.origin === 'foreign-network') return 'foreign-network';
  return null;
}

// The visible recall label. Mutates the response row in place and returns it:
// `unverified` is the flag every client is told to render (the human-readable
// word), `quarantined`/`quarantine_reason` carry the machine state, and
// `memory_data_marker` names the P1.2 datamark a client must prefix when it
// renders the row into a prompt (the ONE string, from memory-fence.js — the
// label and the fence cannot drift).
export function applyRecallLabel(row) {
  var meta = parseMeta(row && row.metadata);
  if (needsRecallLabel(row, meta)) {
    row.unverified = true;
    row.quarantined = true;
    row.quarantine_reason = recallLabelReason(row, meta);
    row.memory_data_marker = MEMORY_DATA_DATAMARK;
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

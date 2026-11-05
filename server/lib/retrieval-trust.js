// TRUST LAYER P1.6 (F-mycelium/270, PROGRAM-mycelium-trust-layer-2026-09-26 §P1.6)
// — retrieval trust: the ONE weight every similarity that orders a recall
// page is multiplied by, and the ONE place its constants live. semantic-
// memory's search arms import this (a shared lib import, like trust-origins.js
// / memory-quarantine.js — never a cross-plugin import).
//
// The law in one line per piece:
//
//   TRUST     the row's STORED trust (the P1.1 ladder: person 4 … foreign 0;
//             NULL/unknown reads the LOWEST, never the highest) maps through
//             TRUST_MULTIPLIERS — a bounded ladder, so a weak match from a
//             trusted origin still loses to a strong match from an untrusted
//             one on raw relevance alone.
//   RECENCY   updated_at decays with a half-life and a floor: old content
//             ranks below fresh content at equal trust, and nothing decays to
//             irrelevance just because it is old.
//   UNVOUCHED a row the platform does not vouch for — quarantined (every
//             foreign-network row, every auto-indexed message), a supersede
//             candidate, or foreign by origin column — is demoted by ONE
//             multiplier. needsRecallLabel (memory-quarantine.js) is the one
//             definition of unvouched; the demotion and the visible label can
//             never disagree.
//
// The product is a MULTIPLIER, never a filter: nothing is hidden from recall,
// the page is only ORDERED by it (trust breaks near-ties; relevance decides
// the page). The weighted value rides `retrieval_score` beside the raw
// relevance — `score` keeps its meaning for every existing caller.
//
// Where it applies: ONE application per ranked page, at the page's terminal —
// searchKeyword's tail, the vector arms' shared finishScored tail, and the
// hybrid fusion's tail. searchHybrid passes `deferTrustRank` to its arms so
// the fusion input stays pure relevance and the fused page is weighted exactly
// once (no compounding, so the measured utility cost is mode-independent).
// Internal flag: set only by searchHybrid; routes never pass weights.

import { needsRecallLabel } from './memory-quarantine.js';

export var RETRIEVAL_TRUST = {
  // index = the stored trust level 0..4 (foreign … person). Bounded around 1:
  // trust reorders near-ties and demotes poison a page, it does not outrank
  // relevance.
  TRUST_MULTIPLIERS: [0.75, 0.9, 1.0, 1.08, 1.15],
  // updated_at decay: weight = max(FLOOR, 2 ** (-ageDays / HALF_LIFE)).
  RECENCY_HALF_LIFE_DAYS: 45,
  RECENCY_FLOOR: 0.8,
  // every row needsRecallLabel labels (quarantined / candidate / foreign
  // origin) ranks demoted by this much.
  UNVOUCHED_MULTIPLIER: 0.5,
  // the vector arms re-rank a pool of limit × RERANK_POOL candidates fetched
  // by raw similarity, so trust can move a row INTO the page, not just around
  // inside it. Bounded: the pool fetch skips the embedding column.
  RERANK_POOL: 4
};

// Parse the stored timestamps. updated_at is the content's freshness (the
// vector scan cap and supersede already read it); created_at is the fallback;
// nothing parseable reads as infinitely old — the floor, never a bonus.
function ageDays(row, now) {
  var raw = (row && (row.updated_at || row.created_at)) || '';
  if (typeof raw !== 'string' || raw.length === 0) return Infinity;
  var t = Date.parse(raw.indexOf(' ') === 10 ? raw.replace(' ', 'T') + 'Z' : raw);
  if (!isFinite(t)) return Infinity;
  return Math.max(0, (now - t) / 86400000);
}

// The ONE retrieval-trust weight. row: a search row with its trust/origin/
// updated_at/metadata stamps (the shape every search arm already carries).
// opts.now overrides the clock (tests); production calls omit it.
export function retrievalTrustWeight(row, opts) {
  opts = opts || {};
  var now = (opts.now == null) ? Date.now() : opts.now;
  var trust = (row == null || row.trust == null) ? 0 : Number(row.trust);
  if (!isFinite(trust)) trust = 0;
  trust = Math.max(0, Math.min(4, Math.round(trust)));
  var trustW = RETRIEVAL_TRUST.TRUST_MULTIPLIERS[trust];

  var age = ageDays(row, now);
  var recencyW = (age === Infinity)
    ? RETRIEVAL_TRUST.RECENCY_FLOOR
    : Math.max(RETRIEVAL_TRUST.RECENCY_FLOOR, Math.pow(2, -age / RETRIEVAL_TRUST.RECENCY_HALF_LIFE_DAYS));

  var unvouchedW = needsRecallLabel(row, row && row.metadata)
    ? RETRIEVAL_TRUST.UNVOUCHED_MULTIPLIER : 1;

  return trustW * recencyW * unvouchedW;
}

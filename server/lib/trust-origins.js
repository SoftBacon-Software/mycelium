// TRUST LAYER P1.1 (F-mycelium/265, PROGRAM-mycelium-trust-layer-2026-09-26 §P1.1)
// — the origin enum and its trust ladder, ONE definition for every memory
// writer. semantic-memory and auto-memory both import this (a shared lib
// import, like rate-limit.js / memory-auth.js — never a cross-plugin import,
// which would make either plugin unloadable without the other).
//
// The law in one line per origin — WHO a row's content came from, which is
// exactly how much the row can be trusted:
//
//   person          4   the human said it (the companion surface's ceiling)
//   owner-agent     3   the owner's own agent / harness / director lanes
//   tool            2   a tool's output, relayed by a writer that said so
//   model-derived   1   a model wrote it (extracted facts, consolidation
//                       insights, anything a writer self-declares model-made)
//   foreign-network 0   the row crossed a network border (federation)
//
// UNKNOWN is not an origin — it is the absence of one, and it reads as the
// LOWEST trust (0), never the highest. The migration stamps existing rows
// from what is known and leaves the rest unknown on purpose.

export const ORIGINS = ['person', 'owner-agent', 'tool', 'model-derived', 'foreign-network'];

export const ORIGIN_TRUST = {
  'person': 4,
  'owner-agent': 3,
  'tool': 2,
  'model-derived': 1,
  'foreign-network': 0
};

export function originTrust(origin) {
  return ORIGIN_TRUST[origin] == null ? 0 : ORIGIN_TRUST[origin];
}

// The min law for derived rows: trust = MIN over the inputs. Callers pass
// resolved integer trusts (stored column values — never writer claims).
export function minTrust(values) {
  var min = null;
  for (var v of values) {
    var t = (v == null) ? 0 : Number(v);
    if (!isFinite(t)) t = 0;
    if (min === null || t < min) min = t;
  }
  return min == null ? null : min;
}

// -- Derived-row refs -------------------------------------------------------
// A derived row cites its inputs as refs: "sm:<source_type>:<source_id>"
// (semantic-memory; source_id may itself contain colons — everything after
// the SECOND colon is the id) or "am:<fact_id>" (auto-memory's integer ids).
export const MAX_DERIVED_FROM = 100;
export const DERIVED_REF_RE = /^(sm:.+:.+|am:\d+)$/;

// Returns an error message string, or null when the ref array is valid.
export function validateDerivedRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return 'derived_from must be a non-empty array of row refs ("sm:<source_type>:<source_id>" or "am:<fact_id>")';
  }
  if (refs.length > MAX_DERIVED_FROM) {
    return 'derived_from exceeds ' + MAX_DERIVED_FROM + ' refs — a derived row cites its inputs, not the corpus';
  }
  for (var i = 0; i < refs.length; i++) {
    if (typeof refs[i] !== 'string' || !DERIVED_REF_RE.test(refs[i])) {
      return 'derived_from[' + i + '] is not a row ref — expected "sm:<source_type>:<source_id>" or "am:<fact_id>", got: ' + JSON.stringify(refs[i]);
    }
  }
  return null;
}

// One ref → the STORED trust of that row (0 when the row does not exist —
// unknown inputs contribute the lowest trust, fail-closed). sm refs resolve
// against the shared sm_embeddings (all chunks share a stamp; MAX is that
// stamp); am refs against am_facts, which may not exist on deployments
// without auto-memory — absence reads as 0, not an error.
export function resolveInputTrust(coreDb, ref) {
  try {
    if (ref.indexOf('sm:') === 0) {
      var rest = ref.slice(3);
      var sep = rest.indexOf(':');
      var sourceType = rest.slice(0, sep);
      var sourceId = rest.slice(sep + 1);
      var row = coreDb.prepare(
        'SELECT MAX(COALESCE(trust, 0)) AS t FROM sm_embeddings WHERE source_type = ? AND source_id = ?'
      ).get(sourceType, sourceId);
      return (row && row.t != null) ? row.t : 0;
    }
    if (ref.indexOf('am:') === 0) {
      var fact = coreDb.prepare('SELECT COALESCE(trust, 0) AS t FROM am_facts WHERE id = ?').get(Number(ref.slice(3)));
      return (fact && fact.t != null) ? fact.t : 0;
    }
  } catch (e) { /* table missing → unknown input → 0 */ }
  return 0;
}

// The core of every write-surface binding: a writer's claimed origin/trust
// plus its derived refs, against the surface's ceiling origin, resolved
// SERVER-SIDE. Returns:
//   { error }                                   — refuse the write (400)
//   { origin, trust, derivedFrom,
//     claimedOrigin, claimedTrust }             — the stamps to store, plus
//     what to FLAG: claimedOrigin is a claim above the ceiling (kept as a
//     flag, never the origin), claimedTrust any body trust value (a writer
//     never sets trust — it is computed). The caller renders both flags in
//     its own channel (semantic-memory: metadata.claimed_origin /
//     metadata.claimed_trust; auto-memory: the same metadata keys on the
//     index mirror).
// The min law runs HERE: a derived row's trust is the MIN of its inputs,
// resolved from the stored rows — a writer's claim about its inputs is not
// consulted, so citing rows that do not exist (or that were written at a
// lower trust) can only pull the row DOWN.
export function bindOriginClaim(claim, ceilingOrigin, coreDb) {
  var origin = ceilingOrigin;
  var claimedOrigin = null;
  if (claim.origin != null) {
    if (typeof claim.origin !== 'string' || ORIGINS.indexOf(claim.origin) === -1) {
      return { error: 'origin must be one of: ' + ORIGINS.join(', ') + ' (got: ' + JSON.stringify(claim.origin) + ')' };
    }
    if (originTrust(claim.origin) > originTrust(ceilingOrigin)) {
      claimedOrigin = claim.origin; // visible, flagged, never trusted
    } else {
      origin = claim.origin; // an honest self-lowering
    }
  }
  var trust = originTrust(origin);
  var derivedFrom = null;
  if (claim.derived_from != null) {
    var err = validateDerivedRefs(claim.derived_from);
    if (err) return { error: err };
    derivedFrom = claim.derived_from.slice();
    var inputTrusts = derivedFrom.map(function (r) { return resolveInputTrust(coreDb, r); });
    trust = minTrust(inputTrusts.concat([trust]));
  }
  return {
    origin: origin,
    trust: trust,
    derivedFrom: derivedFrom,
    claimedOrigin: claimedOrigin,
    claimedTrust: (claim.trust != null) ? claim.trust : null
  };
}

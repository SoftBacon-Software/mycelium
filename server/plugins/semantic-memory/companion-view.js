// The companion row view — the ONE shape the Companion Memory API
// (docs/companion-memory-api.md "Rows" table) and the federation plugin
// (spec/federation-v0 §4) both serve. It lives here, next to the table it
// reads, so the two surfaces cannot drift: federation's store.js imports this
// function rather than keeping a twin (review A nit 7 on feat/federation-v0 —
// the twin had already begun to exist).
//
// Pure: a store row in (metadata as a string from a direct read OR already
// parsed from the search arms), the API view out. Internal columns (the
// embedding vector, chunk bookkeeping, raw metadata JSON) never leave.

export default function companionView(row, opts) {
  var meta = row.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta || '{}'); } catch (e) { meta = {}; }
  }
  if (!meta || typeof meta !== 'object') meta = {};
  var view = {
    id: row.source_id,
    kind: meta.kind || null,
    key: meta.key || null,
    text: row.content_text,
    source: meta.source || null,
    at: meta.at || null,
    created_at: row.created_at,
    superseded_by: row.superseded_by || null,
    supersedes: meta.supersedes || null
  };
  // Federation v0: an imported row that collided with a live home row is a
  // candidate (accepted explicitly, never a silent supersede); a row that
  // crossed a border carries its receipt.
  if (meta.candidate) view.candidate = true;
  if (row.fed_agent || row.fed_network || row.fed_visit) {
    view.provenance = {
      id: meta.fed_id || null, // the protocol's content-addressed id
      agent: row.fed_agent || null,
      network: row.fed_network || null,
      home: row.fed_home || null,
      visit: row.fed_visit || null,
      sig: row.fed_sig || null
    };
  }
  if (opts && opts.score !== undefined) view.score = opts.score;
  // task 213's honest-embeddedness stamp, carried through from the search
  // arms: a keyword-ranked row with embedded:false must not masquerade as a
  // semantic hit. List reads have no stamp and omit the field.
  if (opts && opts.embedded !== undefined) view.embedded = opts.embedded;
  return view;
}

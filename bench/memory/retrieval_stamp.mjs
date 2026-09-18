// The shared retrieval-provenance seam + gold mapping + audit math (task 207).
//
// WHY: two cells are collapsed in EVERY arm of the P1 grid — single-session-
// preference 0.071 in all five arms and multi-session ≤ 0.333 — and the banked
// rows cannot say whether the miss is write-side or read-side: meta.hits is a
// count (run.mjs:813-era rows) and the split's required keys carry no
// answer-session mapping (split.mjs). This module makes the read side VISIBLE:
//
//   1. recordHits — the one seam every arm calls at read time. Rows carry
//      meta.read_hits (ordered hits, rank 0 = the row the model read first,
//      capped at the budget) + meta.budget. Where an arm's SDK exposes no hit
//      identity at all, the arm stamps read_hits null + read_hits_available
//      false — never an empty array pretending nothing-was-retrieved.
//   2. mapGoldSessions / buildGoldIndex — the dataset's answer-session mapping.
//      LongMemEval-S (cleaned) carries answer_session_ids on ALL 500 items and
//      they all join haystack_session_ids (checked 2026-09-17) — that is the
//      primary method, named in the receipt. The fallback (answer-text match
//      into haystack_sessions) exists for sources without the ids and maps
//      UNIQUE matches only; ambiguous or absent stays unmapped, counted,
//      excluded from rank stats.
//   3. computeRetrievalAudit — hit@budget / median gold rank / MRR per
//      question_type × arm over STAMPED rows only. Banked rows carry counts
//      only; they are counted, and the renderer states that — it never invents
//      ranks for them.
//   4. decideDiagnostic — the pre-committed rule, mechanical, no judgement:
//      preference's median gold rank > budget ⇒ replay branch; within budget ⇒
//      the miss is answer-side; no ranked rows ⇒ the rule cannot fire yet.
//
// This module is PURE (no fs, no network, no clock) so every part drives
// hermetically. It writes no scores and changes no arm's retrieval — the next
// hero number stands on it; it is not one.
//
// The timeline arm's landed stamp (task 205: buildReadHits → ordered
// [{layer, source_id, rank, score, rendered_date, rendered_supersede_line}],
// consumed by miss_autopsy.mjs) is the shape this seam generalizes: its
// entries already carry source_id/rank/score, and it stamps meta.budget via
// stampBudget. Arms whose SDKs expose less stamp the shared minimal entry
// {source_id, rank, score, session_index}.

// --- the stamp ---------------------------------------------------------------

/** Stamp the retrieval budget onto a row's meta (every arm, every row). */
export function stampBudget(meta, budget) {
  meta.budget = Number.isInteger(budget) ? budget : null;
  return meta;
}

function normScore(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normSessionIndex(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * The read-time seam. Mutates + returns `meta`.
 *
 * hits === null  → the arm retrieved nothing or its SDK exposes no hits:
 *                  read_hits null + read_hits_available false. (A cooperative
 *                  arm whose search FAILED stamps read_hits null + a
 *                  retrieval_error string itself, mirroring the timeline arm's
 *                  task-205 convention — a failed search is never a fake empty.)
 * hits === []    → the search truly returned zero rows: read_hits [] +
 *                  read_hits_available true.
 * hits = [...].  → ordered entries as the arm rendered them; each becomes
 *                  {source_id, score, session_index, ...armExtras, rank} —
 *                  normalized shared fields first, the arm's extra fields
 *                  (layer, rendered_date, …) preserved, rank (0-based context
 *                  position) last, capped at the budget.
 */
export function recordHits(meta, hits, budget) {
  if (!Array.isArray(hits)) {
    meta.read_hits = null;
    meta.read_hits_available = false;
    return stampBudget(meta, budget);
  }
  meta.read_hits = hits.slice(0, Number.isInteger(budget) && budget > 0 ? budget : hits.length).map((h, rank) => ({
    ...h,
    source_id: h?.source_id ?? null,
    score: normScore(h?.score),
    session_index: normSessionIndex(h?.session_index),
    rank,
  }));
  meta.read_hits_available = true;
  return stampBudget(meta, budget);
}

// --- gold mapping --------------------------------------------------------------

const normText = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The dataset's answer-session mapping for ONE item. Returns
 * {mapped, method, indices, reason?}:
 *   - method 'answer_session_ids' — the source JSON carries the ids and every
 *     one joins haystack_session_ids (the real LongMemEval-S: 500/500).
 *   - method 'answer_text_match' — fallback when the ids are absent: the
 *     haystack sessions whose concatenated turn text contains the answer,
 *     UNIQUE matches only (a tie is not a mapping).
 *   - mapped false — unmapped: counted by the audit, excluded from rank stats.
 */
export function mapGoldSessions(item) {
  if (Array.isArray(item?.answer_session_ids) && item.answer_session_ids.length > 0) {
    const ids = item.haystack_session_ids;
    if (!Array.isArray(ids)) {
      return { mapped: false, method: 'answer_session_ids', indices: [], reason: 'haystack_session_ids missing' };
    }
    const pos = new Map(ids.map((id, i) => [id, i]));
    const indices = [...new Set(item.answer_session_ids.map((id) => pos.get(id)).filter((i) => i != null))];
    if (indices.length !== item.answer_session_ids.length) {
      return {
        mapped: false,
        method: 'answer_session_ids',
        indices: [],
        reason: 'answer_session_ids did not all join haystack_session_ids',
      };
    }
    return { mapped: true, method: 'answer_session_ids', indices: indices.sort((a, b) => a - b) };
  }
  // fallback: answer-text match into the haystack sessions
  const answer = normText(item?.answer);
  if (!answer) return { mapped: false, method: 'answer_text_match', indices: [], reason: 'empty answer' };
  const sessions = Array.isArray(item?.haystack_sessions) ? item.haystack_sessions : [];
  const matches = [];
  sessions.forEach((turns, idx) => {
    const text = normText((Array.isArray(turns) ? turns : []).map((t) => t?.content ?? '').join(' '));
    if (text.includes(answer)) matches.push(idx);
  });
  if (matches.length === 1) return { mapped: true, method: 'answer_text_match', indices: matches };
  return {
    mapped: false,
    method: 'answer_text_match',
    indices: [],
    reason: matches.length === 0 ? 'answer not found verbatim in any session' : `answer matched ${matches.length} sessions (ambiguous)`,
  };
}

/**
 * Map every item once. Returns { byQuestion: Map<question_id, mapping>,
 * coverage: {total, mapped, unmapped, methods: {…counts}, sample_unmapped: [ids…]} }.
 */
export function buildGoldIndex(items) {
  const byQuestion = new Map();
  const methods = {};
  let mapped = 0;
  const unmappedIds = [];
  for (const item of items ?? []) {
    const m = mapGoldSessions(item);
    byQuestion.set(item.question_id, m);
    methods[m.method] = (methods[m.method] ?? 0) + 1;
    if (m.mapped) mapped += 1;
    else unmappedIds.push(item.question_id);
  }
  return {
    byQuestion,
    coverage: {
      total: byQuestion.size,
      mapped,
      unmapped: byQuestion.size - mapped,
      methods,
      sample_unmapped: unmappedIds.slice(0, 5),
    },
  };
}

// --- per-row classification ----------------------------------------------------

/**
 * Classify ONE row against its gold sessions.
 *
 * stamp:        'stamped' (read_hits array) | 'null_no_retrieval' (null +
 *               read_hits_available false) | 'null_error' (null otherwise) |
 *               'unstamped' (no read_hits key — banked rows).
 * unmapped:     the question has no gold mapping (excluded from rank stats).
 * gold_written: null when the cap makes the question unrankable, else whether
 *               any gold session lies inside the capped write (a gold session
 *               the write phase never stored cannot be retrieved — counted
 *               separately, never charged against retrieval).
 * gold_rank:    1-based context position of the FIRST gold-session hit, when
 *               the row is ranked (stamped + mapped + gold written + at least
 *               one hit carrying session_index).
 */
export function classifyRow({ readHits, readHitsAvailable, mapping, writeCap }) {
  const out = {
    stamp: 'unstamped',
    unmapped: !mapping?.mapped,
    gold_written: null,
    gold_rank: null,
    hit: false,
    session_provenance: false,
  };
  if (readHits === null || readHits === undefined) {
    if (readHits === null && readHitsAvailable === false) out.stamp = 'null_no_retrieval';
    else if (readHits === null) out.stamp = 'null_error';
    return out;
  }
  if (!Array.isArray(readHits)) return out;
  out.stamp = 'stamped';
  if (out.unmapped) return out;
  const gold = new Set(mapping.indices);
  out.gold_written = writeCap == null ? true : mapping.indices.some((i) => i < writeCap);
  if (!out.gold_written) return out;
  const ranks = readHits.filter((h) => h?.session_index != null && gold.has(h.session_index)).map((h) => h.rank + 1);
  out.session_provenance = readHits.some((h) => h?.session_index != null);
  if (ranks.length) {
    out.hit = true;
    out.gold_rank = Math.min(...ranks);
  }
  return out;
}

export function median(values) {
  const v = (values ?? []).filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// --- the audit ------------------------------------------------------------------

const EMPTY_CELL = () => ({
  rows: 0,
  stamped: 0,
  unstamped_banked: 0,
  null_no_retrieval: 0,
  null_error: 0,
  unmapped: 0,
  gold_not_written: 0,
  no_provenance: 0,
  ranked: 0,
  hit: 0,
  hit_at_budget: null,
  median_gold_rank: null,
  mrr: null,
});

/**
 * Per question_type × arm retrieval stats over the runs' STAMPED rows.
 *
 * runs: [{runId, summary, rowsByArm, labelByArm?}] — rowsByArm[arm] = the run's
 *   <arm>.rows.jsonl rows (each carries question_id, question_type, meta);
 *   labelByArm[arm] (task 225) = the arm's labeled identity from that run's own
 *   regime, so two same-named arms from differently-stamped runs pool as
 *   separate cells instead of silently merging their stores.
 * goldIndex: buildGoldIndex's result over the SAME split selection the runs used.
 * budget:    the regime retrieval budget (comparability guarantees one value).
 * writeCap:  the runs' stamped write cap, or null (grid.mjs writeCap()).
 */
export function computeRetrievalAudit({ runs, goldIndex, budget, writeCap: cap }) {
  const cells = new Map(); // `${arm} ${question_type}` → cell
  const touch = (arm, qtype) => {
    const key = `${arm} ${qtype}`;
    if (!cells.has(key)) cells.set(key, EMPTY_CELL());
    return cells.get(key);
  };
  const ranks = new Map(); // same key → rank list for the median
  for (const run of runs ?? []) {
    for (const [arm, rows] of Object.entries(run.rowsByArm ?? {})) {
      // task 225: key the cell by the arm's LABELED identity (the run's own
      // regime) — two `mycelium-timeline` runs on different facts layers are
      // different measurements and must never pool into one cell
      const armKey = run.labelByArm?.[arm] ?? arm;
      for (const row of rows ?? []) {
        const qtype = row.question_type ?? 'unknown';
        const cell = touch(armKey, qtype);
        const key = `${armKey} ${qtype}`;
        ranks.set(key, ranks.get(key) ?? []);
        cell.rows += 1;
        const mapping = goldIndex?.byQuestion?.get(row.question_id) ?? null;
        const c = classifyRow({
          readHits: row.meta?.read_hits,
          readHitsAvailable: row.meta?.read_hits_available,
          mapping,
          writeCap: cap,
        });
        if (c.stamp === 'unstamped') cell.unstamped_banked += 1;
        else if (c.stamp === 'null_no_retrieval') cell.null_no_retrieval += 1;
        else if (c.stamp === 'null_error') cell.null_error += 1;
        else cell.stamped += 1;
        if (c.unmapped) {
          cell.unmapped += 1;
          continue;
        }
        if (c.gold_written === false) {
          cell.gold_not_written += 1;
          continue;
        }
        if (c.stamp !== 'stamped') continue; // rank stats are stamped-rows-only
        if (!c.session_provenance) {
          cell.no_provenance += 1;
          continue;
        }
        // ranked denominator: stamped + mapped + gold written + provenance
        cell.ranked += 1;
        if (c.hit) {
          cell.hit += 1;
          ranks.get(key).push(c.gold_rank);
        }
      }
    }
  }
  for (const [key, cell] of cells) {
    cell.hit_at_budget = cell.ranked ? cell.hit / cell.ranked : null;
    cell.median_gold_rank = median(ranks.get(key));
    cell.mrr = cell.ranked ? ranks.get(key).reduce((a, r) => a + 1 / r, 0) / cell.ranked : null;
  }
  // arms in first-seen order, question types sorted inside each arm
  const arms = [...new Set([...cells.keys()].map((k) => k.split(' ')[0]))];
  const audit = { budget, cells: {} };
  for (const arm of arms) {
    audit.cells[arm] = {};
    for (const [key, cell] of cells) {
      const [a, qtype] = key.split(' ');
      if (a === arm) audit.cells[arm][qtype] = cell;
    }
  }
  return audit;
}

// --- the pre-committed diagnostic rule -------------------------------------------

/**
 * Mechanical branch on the preference cell's stamped ranks alone:
 *   - 'budget-10-replay'       — median gold rank > budget: the gold exists in
 *                                the store but sits outside the read budget.
 *   - 'answer-side-transcripts'— gold already within the top-budget context:
 *                                the miss is answer-side; render transcripts.
 *   - 'insufficient-stamps'    — no ranked preference rows yet: the rule
 *                                cannot fire, and pretending otherwise would
 *                                be fabrication.
 */
export function decideDiagnostic(preferenceCell, budget) {
  if (!preferenceCell || !Number.isInteger(budget) || budget <= 0) {
    return { branch: 'insufficient-stamps', reason: 'no preference stats or unstamped budget' };
  }
  if (!preferenceCell.ranked) {
    return {
      branch: 'insufficient-stamps',
      reason: `0 ranked preference rows (stamped ${preferenceCell.stamped}, banked ${preferenceCell.unstamped_banked}) — the rule fires after the first stamped run`,
    };
  }
  const m = preferenceCell.median_gold_rank;
  if (m == null) {
    return { branch: 'insufficient-stamps', reason: 'no gold-session hit among the stamped preference rows' };
  }
  if (m > budget) {
    return {
      branch: 'budget-10-replay',
      reason: `preference median gold rank ${m} > budget ${budget} — the gold is IN the store but OUTSIDE the read`,
    };
  }
  return {
    branch: 'answer-side-transcripts',
    reason: `preference median gold rank ${m} ≤ budget ${budget} — the gold is already within the top-budget context; the miss is answer-side`,
  };
}

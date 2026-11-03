// The shared retrieval-provenance seam + gold mapping + audit math (task 207).
//
// task 304 (review B, 2026-11-03): gold credit is QUESTION-SCOPED. Every arm
// pools all n questions' haystacks into ONE per-run store, so a retrieved hit
// routinely belongs to another question — a hit counts for a row's gold only
// when its owning question (stamped question_id, or the `<qid>` parsed from a
// banked `<runId>-<qid>-s<idx>` source id) equals the row's. Hits of unknown
// ownership make the row's outcome unknowable: n/a (why), never a credit and
// never a fabricated miss.
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
 *                  {source_id, score, session_index, question_id,
 *                  ...armExtras, rank} — normalized shared fields first, the
 *                  arm's extra fields (layer, rendered_date, …) preserved, rank
 *                  (0-based context position) last, capped at the budget.
 *                  question_id (task 304) names the question whose haystack the
 *                  hit came FROM — every arm pools all n questions' sessions
 *                  into one per-run store, so the owning question is the only
 *                  thing that makes a session_index meaningful. Arms forward it
 *                  from their store's metadata; null when the SDK hides it.
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
    question_id: h?.question_id ?? null,
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
 *
 * task 264: gold evidence is SESSION-level by this mapping. Turn-level recall
 * is NOT computed: the LongMemEval-S release carries no turn-level evidence ids
 * (verified 2026-10-29 — the cleaned corpus's key union is question_id,
 * question_type, question, question_date, answer, answer_session_ids,
 * haystack_dates, haystack_session_ids, haystack_sessions). When a source does
 * carry turn ids, map them HERE and extend classifyRow — the report's
 * granularity line states the absence until then.
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
 * Which question's haystack did this hit come from? (task 304)
 *
 * Every arm of this bench writes ALL n questions' haystacks into ONE per-run
 * store, so a retrieved hit routinely belongs to ANOTHER question — and a
 * foreign session whose index collides with this question's gold index is not
 * gold evidence. Resolution order:
 *   1. the hit's stamped `question_id` (the arms forward it from their store
 *      metadata at read time — the honest path for every new run);
 *   2. the BANKED shape: `<runId>-<qid>-s<idx>` source ids (arm_mycelium and
 *      arm_mycelium_extract write exactly this), parsed by stripping the run's
 *      own prefix and the `-s<idx>` tail. A `<qid>-s<idx>` without the run
 *      prefix parses the same way.
 *   3. null — unknown. A hit of unknown ownership can never be credited as
 *      this question's gold, and never proves a miss either.
 */
export function hitQuestionId(hit, runId = null) {
  if (hit?.question_id != null) return hit.question_id;
  const sid = hit?.source_id;
  if (typeof sid !== 'string' || !sid) return null;
  let rest = sid;
  if (runId && rest.startsWith(`${runId}-`)) rest = rest.slice(runId.length + 1);
  const m = rest.match(/^(.+)-s\d+$/);
  return m ? m[1] : null;
}

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
 * session_provenance: any hit carries a session_index.
 * question_provenance (task 304): EVERY index-carrying hit resolves to a known
 *               question. Required for R@k and the rank stats — one
 *               unidentified hit could be the gold, so the row's retrieval
 *               outcome is unknown, not a miss.
 * foreign_hits: how many index-carrying hits belong to OTHER questions (the
 *               pooled-store diagnostic — large counts mean the search is not
 *               discriminating between questions' haystacks).
 * gold_rank:    1-based context position of the FIRST gold-session hit OWNED
 *               BY THIS QUESTION, when the row is ranked (stamped + mapped +
 *               gold written + question-provenance + at least one own hit
 *               landing on a gold index).
 */
export function classifyRow({ readHits, readHitsAvailable, mapping, writeCap, questionId = null, runId = null }) {
  const out = {
    stamp: 'unstamped',
    unmapped: !mapping?.mapped,
    gold_written: null,
    gold_rank: null,
    hit: false,
    session_provenance: false,
    question_provenance: false,
    foreign_hits: 0,
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
  // task 304: resolve every index-carrying hit's owning question ONCE — own
  // hits can credit gold, foreign hits never do, unidentified hits make the
  // row's outcome unknowable.
  const identified = readHits
    .filter((h) => h?.session_index != null)
    .map((h) => ({ hit: h, question: hitQuestionId(h, runId) }));
  out.session_provenance = identified.length > 0;
  out.question_provenance = out.session_provenance && identified.every((x) => x.question != null);
  out.foreign_hits = identified.filter((x) => x.question != null && questionId != null && x.question !== questionId).length;
  const ranks = identified
    .filter((x) => x.question != null && x.question === questionId && gold.has(x.hit.session_index))
    .map((x) => x.hit.rank + 1);
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

// task 264: the k values the per-arm table quotes. R@k = THIS question's gold
// session appears in the top k of the row's stamped read hits, counting only
// hits that belong to this question's haystack (task 304 — the store is POOLED
// across all n questions' haystacks, so the owning question must match too).
// Protocol note: LongMemEval's published R@k (and e.g. MemPalace's 96.6% R@5)
// retrieves within each question's OWN ~50-session collection; this bench
// retrieves over the pooled per-run store — a different, harder protocol. The
// two numbers are NOT comparable; the receipt states this beside the table.
export const R_AT_K = [5, 10];

const EMPTY_CELL = () => ({
  rows: 0,
  stamped: 0,
  unstamped_banked: 0,
  null_no_retrieval: 0,
  null_error: 0,
  unmapped: 0,
  gold_not_written: 0,
  no_provenance: 0,
  no_question_provenance: 0,
  ranked: 0,
  hit: 0,
  hit_at_budget: null,
  median_gold_rank: null,
  mrr: null,
  // task 264: R@k + judged-answer joins. rankable = the R@k denominator —
  // rows where the retrieval outcome is KNOWN (provenance-carrying hits, or a
  // truly-empty retrieval `[]`, which is a known miss — never a fabricated 0,
  // and never n/a either: the search ran and returned nothing). hit_judged_*
  // accumulate the retrieve-vs-use gap's cells (gold retrieved ∧ judged).
  rankable: 0,
  empty_retrieval: 0,
  hit_at_k: Object.fromEntries(R_AT_K.map((k) => [k, 0])),
  judged_n: 0,
  judged_exact: 0,
  judged_partial: 0,
  judged_wrong: 0,
  judged_unparsed: 0,
  hit_judged_n: 0,
  hit_judged_wrong: 0,
});

/**
 * Per question_type × arm retrieval stats over the runs' STAMPED rows.
 *
 * runs: [{runId, summary, rowsByArm, labelByArm?}] — rowsByArm[arm] = the run's
 *   <arm>.rows.jsonl rows (each carries question_id, question_type, meta);
 *   labelByArm[arm] (task 225) = the arm's labeled identity from that run's own
 *   regime, so two same-named arms from differently-stamped runs pool as
 *   separate cells instead of silently merging their stores;
 *   judgedByArm[arm] (task 264) = the run's judged rows for that RAW arm name
 *   ([{question_id, label}]) — the join behind the per-arm judged accuracy and
 *   the retrieved-but-answered-wrong gap.
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
      // task 264: judged labels join on the RAW arm name and surface under the label
      const labels = new Map((run.judgedByArm?.[arm] ?? []).map((j) => [j.question_id, j.label]));
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
          // task 304: gold credit is question-scoped — the hit must belong to
          // THIS row's question, and banked rows' source ids resolve only
          // against their own run's id
          questionId: row.question_id ?? null,
          runId: run.runId ?? null,
        });
        // task 264: the judged join — accuracy counts EVERY judged row of the
        // arm (unconditional on retrieval); the gap counts judged rows the
        // retrieval HIT (gold within the read budget) and the answer was wrong
        const label = labels.get(row.question_id);
        if (label !== undefined) {
          cell.judged_n += 1;
          if (label === 'exact') cell.judged_exact += 1;
          else if (label === 'partial') cell.judged_partial += 1;
          else {
            // convention (task 304, review-B nit): any label that is neither
            // exact nor partial scores wrong in this join — tally()'s
            // null-means-wrong rule extended to unparsed strings — but it is
            // ALSO counted here so the lump is visible, never silent
            cell.judged_wrong += 1;
            if (label !== 'wrong') cell.judged_unparsed += 1;
          }
          if (c.hit) {
            cell.hit_judged_n += 1;
            if (label !== 'exact' && label !== 'partial') cell.hit_judged_wrong += 1;
          }
        }
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
        // task 264: a truly-empty retrieval (`[]`) is a KNOWN R@k miss — the
        // search ran and returned nothing — so it counts in the R@k denominator
        // with hit false (0.0 is its honest score). The task-207 rank stats
        // stay provenance-only: an empty list carries no session rank, so it is
        // not `ranked` and never enters the median/MRR (that law is unchanged).
        // task 304: provenance now needs BOTH the session index AND the hit's
        // owning question (every arm pools all n questions' haystacks into one
        // per-run store — a foreign session at a colliding index is not gold
        // evidence, and an unidentified hit makes the outcome unknowable).
        const emptyRetrieval = Array.isArray(row.meta?.read_hits) && row.meta.read_hits.length === 0;
        const provenance = c.session_provenance && c.question_provenance;
        if (!provenance && !emptyRetrieval) {
          if (c.session_provenance) cell.no_question_provenance += 1;
          else cell.no_provenance += 1;
          continue;
        }
        cell.rankable += 1; // the R@k denominator: known retrieval outcomes
        if (provenance) {
          // ranked denominator: stamped + mapped + gold written + provenance
          cell.ranked += 1;
          if (c.hit) {
            cell.hit += 1;
            ranks.get(key).push(c.gold_rank);
            for (const k of R_AT_K) if (c.gold_rank <= k) cell.hit_at_k[k] += 1;
          }
        } else {
          cell.empty_retrieval += 1;
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

// --- task 264: the per-arm retrieval-vs-answers rollup ----------------------------

const fmtNaWhy = (acc) => {
  const reasons = [];
  if (acc.unstamped_banked) reasons.push(`${acc.unstamped_banked} banked`);
  if (acc.null_no_retrieval) reasons.push(`${acc.null_no_retrieval} no-retrieval`);
  if (acc.null_error) reasons.push(`${acc.null_error} retrieval-error`);
  if (acc.no_provenance) reasons.push(`${acc.no_provenance} hits without session ids`);
  if (acc.no_question_provenance) reasons.push(`${acc.no_question_provenance} hits without question ids (pooled store — own-vs-foreign unknowable)`);
  return reasons.length
    ? { na: `no rankable rows — ${reasons.join(', ')}` }
    : { na: 'no rankable rows' };
};

/**
 * The per-arm table behind the receipt's task-264 block. Cells pool into arms
 * (their keys are already the arms' labeled identities), and each arm reports:
 *
 *   r_at[k]     R@k — {rate, hits, n} over the arm's RANKABLE rows (provenance-
 *               carrying hits + truly-empty retrievals), or {na, why} when the
 *               k exceeds the read budget (ranks beyond it are never stamped)
 *               or nothing is rankable. Never a fabricated 0.
 *   judged_p1   the arm's judged score (exact + 0.5×partial)/n over every
 *               judged row joined to it — the number the Scores table quotes —
 *               or {na, why} when no judged rows joined.
 *   gap         P(judged wrong | the gold session was retrieved within the read
 *               budget) as {rate, wrong, n} — the retrieve-vs-use gap: the
 *               evidence was in the read context and the answer still failed —
 *               or {na, why} when no retrieved-hit row carries a judge label.
 *
 * budget: the runs' shared retrieval budget (a comparability key); null when
 * unstamped, which treats every k as measurable (the stamp is uncapped then).
 */
export function armRetrievalVsAnswers(audit, budget = audit?.budget) {
  const b = Number.isInteger(budget) && budget > 0 ? budget : null;
  const out = {};
  for (const [arm, byType] of Object.entries(audit?.cells ?? {})) {
    const acc = {
      rows: 0,
      rankable: 0,
      ranked: 0,
      empty_retrieval: 0,
      unstamped_banked: 0,
      null_no_retrieval: 0,
      null_error: 0,
      no_provenance: 0,
      no_question_provenance: 0,
      hit_at_k: Object.fromEntries(R_AT_K.map((k) => [k, 0])),
      judged_n: 0,
      judged_exact: 0,
      judged_partial: 0,
      judged_wrong: 0,
      judged_unparsed: 0,
      hit_judged_n: 0,
      hit_judged_wrong: 0,
    };
    for (const cell of Object.values(byType)) {
      acc.rows += cell.rows ?? 0;
      acc.rankable += cell.rankable ?? 0;
      acc.ranked += cell.ranked ?? 0;
      acc.empty_retrieval += cell.empty_retrieval ?? 0;
      acc.unstamped_banked += cell.unstamped_banked ?? 0;
      acc.null_no_retrieval += cell.null_no_retrieval ?? 0;
      acc.null_error += cell.null_error ?? 0;
      acc.no_provenance += cell.no_provenance ?? 0;
      acc.no_question_provenance += cell.no_question_provenance ?? 0;
      for (const k of R_AT_K) acc.hit_at_k[k] += cell.hit_at_k?.[k] ?? 0;
      acc.judged_n += cell.judged_n ?? 0;
      acc.judged_exact += cell.judged_exact ?? 0;
      acc.judged_partial += cell.judged_partial ?? 0;
      acc.judged_wrong += cell.judged_wrong ?? 0;
      acc.judged_unparsed += cell.judged_unparsed ?? 0;
      acc.hit_judged_n += cell.hit_judged_n ?? 0;
      acc.hit_judged_wrong += cell.hit_judged_wrong ?? 0;
    }
    acc.judged_p1 = acc.judged_n
      ? (acc.judged_exact + 0.5 * acc.judged_partial) / acc.judged_n
      : { na: 'no judged rows joined (no judged.jsonl labels for this arm)' };
    acc.gap = acc.hit_judged_n
      ? { rate: acc.hit_judged_wrong / acc.hit_judged_n, wrong: acc.hit_judged_wrong, n: acc.hit_judged_n }
      : { na: 'no retrieved-hit rows carry a judge label' };
    acc.r_at = {};
    for (const k of R_AT_K) {
      if (b != null && k > b) {
        acc.r_at[k] = { na: `read budget ${b} — ranks beyond ${b} are never stamped, so R@${k} is not measurable from this run` };
      } else {
        acc.r_at[k] = acc.rankable ? { rate: acc.hit_at_k[k] / acc.rankable, hits: acc.hit_at_k[k], n: acc.rankable } : fmtNaWhy(acc);
      }
    }
    out[arm] = acc;
  }
  return out;
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

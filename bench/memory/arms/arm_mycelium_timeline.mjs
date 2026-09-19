// arm_mycelium_timeline — the TIMELINE arm (BRIEF-lab-alive-memory-program §3).
//
// Two linked layers, one namespace each:
//   episodic   — the raw session row EXACTLY as arm_mycelium writes it (one row
//                per session, verbatim `role: content` rendering, arm_mycelium's
//                source_id shape), PLUS the dataset's session date in metadata.
//                It lives in the run's BASE namespace, where arm_mycelium's rows
//                live, so the episodic layer is byte-for-byte the raw arm's write
//                and cleanup covers it with the run's own namespace list.
//   reconciled — candidate facts (the SAME extractor call as mycelium-extract:
//                EXTRACTION_SYSTEM, thinking off) are each RECONCILED against the
//                run's existing CURRENT facts for that question's user — semantic
//                search top-k over the reconciled layer, then ONE decision call
//                (same model, temperature 0, thinking off) — ADD / SUPERSEDE /
//                KEEP. A superseded fact is NOT deleted: it gets
//                valid_to = this session's date and a superseded_by pointer to
//                the fact that replaced it; the new fact carries valid_from and
//                the episode pointer. Namespace suffixed -timeline.
//
// READ POLICY — `fact-episode-interleave` (stamped regime.timeline.read_policy).
// The 2026-09-11 r3 run (results/2026-09-11-p1-025039) exposed a read-side
// defect: merging current facts → episodes → superseded let five fact hits fill
// budget 5 on every question, so the verbatim episodic layer reached ZERO of 50
// answers (meta: facts_hits 5, episode_hits 5, context 5). The budget-5 cap is
// the comparability contract with the other arms — the fix interleaves INSIDE
// it: f,e,f,e,… strongest current fact first, a dry layer yields to the other,
// superseded facts are the dated tail reserve. Chosen over fact-carries-episode
// because carry needs a by-id row fetch the bench platform surface doesn't
// expose (search + capped list only) and would spend budget on extractor-chosen
// episodes instead of retriever-ranked ones.
//
// READ POLICY 2 — `fact-episode-interleave-history` (task 220): the measured
// policy hides superseded history (context_superseded was 0 on all 15
// knowledge-update rows of the first n=50). The history policy keeps THIS
// interleave byte-identical and walks each contexted current fact's
// metadata.supersedes chain over an OVERFETCHED fact page, placing the bounded
// predecessor chain beside it with its validity window. See the task-220
// block at TIMELINE_READ_POLICY_HISTORY below.
//
// WHY MEMORY ROWS AND NOT THE am_facts ROUTES: the bi-temporal am_facts table
// and its supersede/reverify routes ARE deployed on the live platform (checked
// 2026-09-10: GET /auto-memory/facts answers), but they do not fit the bench
// row model without a deploy or shared-state damage: am_facts has no semantic
// search route (reconciliation and the read path need /memory/search hybrid at
// the stamped budget), no namespace/run scoping (bench rows would land in the
// lab's LIVE fact store alongside its 1.8k real facts), and no bulk cleanup
// path (the bench contract is purge-everything-after). So the layer is modeled
// as memory rows in a suffixed namespace with the bi-temporal metadata
// (valid_from / valid_to / superseded_by / supersedes / episode) carried in
// metadata — exactly the lane's pre-authorized fallback.
//
// THE ROUTES GREW THE MISSING PIECES (2026-09-17, task 206 — this arm's flag is
// their first caller): am_facts facts now carry a nullable `namespace` column
// (scoped reads; unscoped views see only legacy rows), namespaced facts index
// into sm_embeddings under source_type 'am_fact' through the same index path
// memory rows use (row + embed scheduler, so /memory/search hybrid hits them),
// and a namespaced supersede keeps the old row searchable with its valid_to and
// the "superseded on <date> by: …" line in the hit. Set MYCELIUM_TIMELINE_FACTS
// =am_facts (or pass opts.factsLayer) and the reconciled layer reads/writes the
// /auto-memory/facts routes in a per-run namespace (`<namespace>-amfacts`)
// instead of memory rows — SAME metadata contract, keys and all; the ids in the
// ledger become the route-minted am_facts ids. Default unset = the memory-row
// shape above, byte for byte. The flag path is exercised by tests + a capped
// smoke only. Cleanup note: the index rows purge with the run's namespaces
// (DELETE /memory/index?namespace=); the am_facts ROWS themselves have no bulk
// purge yet — a capped smoke leaves a handful of namespaced rows, removed
// per-id, and a namespace-scoped purge route is the follow-up (task 211).
//
// Known platform condition, stamped here rather than hidden: rows just written
// are embedded asynchronously, so a reconcile search seconds later may rank the
// newest facts keyword-only until the embedder catches up. The reconcile search
// overfetches and filters client-side by question_id + current-only, which
// bounds the damage; the answer phase waits for embedding coverage (run.mjs
// afterWrite) as every platform arm already does.
//
// THE BATCH DECISION LEVER (task 234, the §3 cost leg): v1's per-candidate
// decision call is the measured arm's dominant write cost (×5.71 of the extract
// arm's stamped seconds_per_session on the 2026-09-18 n=50 receipt — the cost
// cell FAILS for the first time). MYCELIUM_TIMELINE_RECONCILE_BATCH=1 collects
// a session's call-bound candidates and decides them in ONE call per batch
// (BENCH_RECONCILE_BATCH, default 8). The searches, the fastpath, the guard and
// the write semantics are v1's; the prompt is versioned reconcile-prompt.2-batch
// and the regime stamps mode + prompt sha, so a batch run and the measured
// per-candidate run are never confused. Opt-in only — the default path is the
// measured arm, unchanged.
//
// THE GUARD (task 213): the fastpath above must not DECIDE on a keyword-only
// score. /memory/search results now carry `embedded` per row (the server's
// stampEmbedded — whether the hit's own vector exists); when the best current
// same-question hit is explicitly embedded:false, the fastpath is withheld and
// the decision call is PAID (counted fastpath_skips_unembedded, ledger source
// 'fastpath_skipped_unembedded'), in both directions: below the threshold the
// pre-guard code auto-ADDed on the keyword-only score; above it the call was
// always paid but now the ledger says the score it rests on was not semantic.
// A hit with NO stamp (legacy platform, the golden fixture) keeps the pre-213
// path byte-for-byte. The count rides w.timeline / summary.json write_info —
// WRITE_DECISION_FIELDS (the answer-row meta) is untouched, so the task-210
// golden-bytes gate stays green with zero generator changes.

import { RAG_SYSTEM, BENCH_SOURCE_TYPE } from './arm_mycelium.mjs';
import { EXTRACTION_SYSTEM, buildExtractionUserPrompt, parseFactsJson } from './arm_mycelium_extract.mjs';

// The reconciled layer is a suffixed sibling of the run namespace; the episodic
// layer IS the run namespace (arm_mycelium's own). Cleanup covers both.
export function myceliumTimelineNamespace(namespace) {
  return `${namespace}-timeline`;
}

// The reconciled layer's namespace in MYCELIUM_TIMELINE_FACTS=am_facts mode: a
// DIFFERENT suffix, still per-run, so the two storage regimes never share a
// namespace and cleanup stays exact.
export function myceliumTimelineFactsNamespace(namespace) {
  return `${namespace}-amfacts`;
}

export function myceliumTimelineNamespaces(namespace) {
  return [namespace, myceliumTimelineNamespace(namespace)];
}

// What the routes index namespaced facts under in sm_embeddings — mirrors
// server/plugins/auto-memory/routes.js's FACT_INDEX_SOURCE_TYPE. Keep in sync.
export const FACT_INDEX_SOURCE_TYPE = 'am_fact';

// The reconciled layer's storage regime: memory rows in a suffixed namespace
// (default, byte-identical to the pre-206 shape) or the /auto-memory/facts
// routes in a per-run namespace (MYCELIUM_TIMELINE_FACTS=am_facts).
export const TIMELINE_FACTS_LAYERS = {
  MEMORY_ROWS: 'memory-rows',
  ROUTES: 'am_facts',
};

export function resolveTimelineFactsLayer(factsLayer) {
  if (factsLayer) {
    if (!Object.values(TIMELINE_FACTS_LAYERS).includes(factsLayer)) {
      throw new Error(`arm_mycelium_timeline: unknown factsLayer '${factsLayer}' (expected one of ${Object.values(TIMELINE_FACTS_LAYERS).join(', ')})`);
    }
    return factsLayer;
  }
  return (typeof process !== 'undefined' && process.env?.MYCELIUM_TIMELINE_FACTS === 'am_facts')
    ? TIMELINE_FACTS_LAYERS.ROUTES
    : TIMELINE_FACTS_LAYERS.MEMORY_ROWS;
}

// The read policy's name — stamped in every answer row's meta (read_policy)
// and in run.mjs's regime block (mycelium_timeline.read_policy). A different
// merge is a different arm: the name is the receipt.
export const TIMELINE_READ_POLICY = 'fact-episode-interleave';

// task 220 — the SECOND read policy. The measured policy above answers the
// "now" half of LongMemEval's knowledge-update class and hides the "was" half:
// the fact-layer search asks for ONLY budget rows, and a superseded fact loses
// that slot race to its own successor (near-identical text ranks together, the
// current twin wins) — context_superseded was 0 on ALL 15 knowledge-update
// rows of the first n=50 (results/2026-09-17-p1-224225; four of the seven
// wrong rows were HISTORY questions whose gold answer is the superseded
// predecessor of a current fact the reader DID hit). The history policy keeps
// the measured interleave byte-identical and then walks each contexted current
// fact's metadata.supersedes chain, placing its bounded predecessor chain
// BESIDE it with its validity window, so "was" and "is" are both readable.
// The MEASURED policy stays the default — the 0.400/0.533 stamp remains
// reproducible without the flag.
export const TIMELINE_READ_POLICY_HISTORY = 'fact-episode-interleave-history';

export const TIMELINE_READ_POLICIES = [TIMELINE_READ_POLICY, TIMELINE_READ_POLICY_HISTORY];

// Resolve --read-policy / the factory option ONCE (run.mjs stamps the SAME
// resolution the arm factory uses). undefined = the MEASURED policy
// (byte-for-byte today's shape); anything else must NAME one of
// TIMELINE_READ_POLICIES — a typoed policy must throw, never fall back.
export function resolveTimelineReadPolicy(value) {
  if (value === undefined || value === null || String(value).trim() === '') return TIMELINE_READ_POLICY;
  const v = String(value).trim();
  if (!TIMELINE_READ_POLICIES.includes(v)) {
    throw new Error(`unknown timeline read_policy '${v}' (expected one of ${TIMELINE_READ_POLICIES.join(', ')})`);
  }
  return v;
}

// The history policy's fact-layer search limit: a predecessor is only
// reachable if its row is IN the page, so the search overfetches (the same
// scale as the reconcile window's overfetch). The budget contract is
// untouched — the context still carries `retrievalBudget` live rows;
// predecessors ride beside them and are counted separately in meta
// (context_facts vs context_superseded).
export const TIMELINE_HISTORY_OVERFETCH = 25;

// The chain bound (pre-committed by the 220 brief): at most 2 predecessors per
// current fact, oldest rendered LAST.
export const TIMELINE_HISTORY_MAX_PREDECESSORS = 2;

// ---- the cost lever (task 205, pre-committed) ------------------------------
// The reconcile decision LLM call is the arm's dominant write cost (r4 n=50:
// reconcile_ms 24,683,199 of the write; 69 decision calls for 71 candidates in
// the capped smoke). When the reconcile search's best CURRENT same-question
// fact already scores below the threshold, there is nothing worth a decision
// ABOUT — the candidate is an ADD with NO decision call. The threshold is a
// named constant (this one), env-overridable, stamped in the regime
// (mycelium_timeline.reconcile_policy.fastpath) with its source, so a fastpath
// run and a non-fastpath run are never confused. The RECONCILE_SYSTEM prompt
// is UNCHANGED by this lever — the fastpath only decides WHEN the prompt runs.
export const RECONCILE_FASTPATH_THRESHOLD = 0.35;
export const FASTPATH_THRESHOLD_ENV = 'BENCH_RECONCILE_FASTPATH_THRESHOLD';

// Resolve the threshold once per process (run.mjs stamps the same resolution
// the arm factory uses — a stamp that could disagree with the code path would
// be a rumour). Throws on a non-numeric or out-of-range override: a typoed
// env var must not silently disable or saturate the lever.
export function resolveReconcileFastpathThreshold({ env = process.env } = {}) {
  const raw = env[FASTPATH_THRESHOLD_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { threshold: RECONCILE_FASTPATH_THRESHOLD, source: 'default' };
  }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new Error(`${FASTPATH_THRESHOLD_ENV} must be a number in [0, 1] (got ${JSON.stringify(raw)})`);
  }
  return { threshold: v, source: 'env' };
}

// ---- the batch decision lever (task 234, the §3 cost leg) ------------------
// v1 pays ONE decision call per CANDIDATE — the measured arm's dominant write
// cost (receipts/2026-09-18-p1-154254.md: timeline 7.08 s/session vs extract
// 1.24 = ×5.71, bound ≤2×; at n=50 ≈ 5.7 paid calls per session because
// extraction produces mostly-new facts, so the fastpath almost never fires).
// The lever collects a session's call-bound candidates and decides them in ONE
// call per batch of RECONCILE_BATCH_SIZE (env BENCH_RECONCILE_BATCH, default 8;
// a remainder pays another call). The per-candidate SEARCHES STAY: the ledger
// needs top_score/shown per candidate and the fastpath guard needs the embedded
// stamp — only the DECISION calls batch. Opt-in MYCELIUM_TIMELINE_RECONCILE_BATCH=1;
// the default path stays the measured arm. The lever's cost is a known one,
// stamped in the regime (reconcile_policy.mode + the in-session-window
// deviation): candidates in one batch do not see each other's decisions.
export const RECONCILE_BATCH_ENV = 'MYCELIUM_TIMELINE_RECONCILE_BATCH';
export const RECONCILE_BATCH_SIZE = 8;
export const RECONCILE_BATCH_SIZE_ENV = 'BENCH_RECONCILE_BATCH';
export const RECONCILE_PROMPT_VERSION_V1 = 'reconcile-prompt.1-per-candidate';
export const RECONCILE_BATCH_PROMPT_VERSION = 'reconcile-prompt.2-batch';

// Resolve the opt-in once per process (run.mjs stamps the same resolution the
// arm factory uses). Unset = the measured per-candidate path; '1'/'true' = the
// batch path; '0'/'false' = an explicit off; anything else throws — a typoed
// env var must not silently pick a policy.
export function resolveReconcileBatchMode({ env = process.env } = {}) {
  const raw = env[RECONCILE_BATCH_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return { batch: false, source: 'default' };
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true') return { batch: true, source: 'env' };
  if (v === '0' || v === 'false') return { batch: false, source: 'env' };
  throw new Error(`${RECONCILE_BATCH_ENV} must be 1/true or 0/false (got ${JSON.stringify(raw)})`);
}

// Resolve the batch cap once per process (same contract as the threshold).
export function resolveReconcileBatchSize({ env = process.env } = {}) {
  const raw = env[RECONCILE_BATCH_SIZE_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return { size: RECONCILE_BATCH_SIZE, source: 'default' };
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`${RECONCILE_BATCH_SIZE_ENV} must be a positive int (got ${JSON.stringify(raw)})`);
  }
  return { size: v, source: 'env' };
}

// The per-question write-decision fields stamped into every answer row's meta
// (meta.write_decisions) — the same counts the write phase reports, so a row
// carries its own ingestion provenance and the miss autopsy needs no guesswork.
export const WRITE_DECISION_FIELDS = [
  'candidates',
  'adds',
  'supersedes',
  'keeps',
  'decision_calls',
  'decision_failures',
  'fastpath_adds',
];

// task 234: the BATCH path's stamp — the v1 fields PLUS the batch counters
// (decision_calls counts CALLS; decisions_batched counts candidates decided in
// them; supersede_conflicts the first-wins fallbacks). The MEASURED path's
// answer rows keep the 7-field shape byte-identically — the 9-field stamp rides
// the batch flag path only.
export const WRITE_DECISION_FIELDS_BATCH = [...WRITE_DECISION_FIELDS, 'decisions_batched', 'supersede_conflicts'];

// Merge the two retrieval layers INSIDE the stamped budget: alternate
// current-fact / episode, strongest current fact first; when one layer runs
// dry the other takes the remaining live slots; superseded facts (least
// trustworthy, but carrying their dated supersede line) fill only what neither
// live layer can. Pure — answer() renders and counts what this returns.
export function interleaveLayers({ current, episodes, superseded, budget }) {
  const out = [];
  let i = 0;
  let j = 0;
  while (out.length < budget && (i < current.length || j < episodes.length)) {
    if (i < current.length) out.push(current[i++]);
    if (out.length < budget && j < episodes.length) out.push(episodes[j++]);
  }
  let k = 0;
  while (out.length < budget && k < superseded.length) out.push(superseded[k++]);
  return out;
}

// Render ONE merged hit the way the context renders it, and return the parts
// the read stamp carries: the rendered date and (for a superseded fact) the
// exact supersede line. Pure — answer() builds the context string and the
// meta.read_hits stamp from THESE structures, so the stamp can never drift
// from what the model actually saw.
export function renderMergedHit(r) {
  const m = r.metadata ?? {};
  if (r._layer === 'fact') {
    if (r._chain) {
      // task 220: a chain predecessor renders ONE line carrying its validity
      // window — "was" is legible at a glance and cannot be mistaken for the
      // current value beside which it rides. The walk guard guarantees
      // valid_to is set on every chain row.
      const from = m.valid_from || 'unknown date';
      return { line: `[fact | ${from} → superseded ${m.valid_to}] ${r.content_text}`, date: from, supersede_line: null };
    }
    const date = m.valid_from || 'unknown date';
    const head = `[fact | ${date}] ${r.content_text}`;
    const supersede =
      m.valid_to != null ? `superseded on ${m.valid_to} by: ${m.superseded_by_text ?? '(new fact not recorded)'}` : null;
    return { line: supersede ? `${head}\n${supersede}` : head, date, supersede_line: supersede };
  }
  const date = m.session_date || 'unknown date';
  return { line: `[session | ${date}] ${r.content_text}`, date, supersede_line: null };
}

// The retrieval-provenance stamp (task 205): ordered, capped at the budget —
// one entry per rendered context row, in context order. rank is the 0-based
// position in the rendered context (0 = the row the model read first).
// `score` is the server's hybrid score, null when the server did not send one.
export function buildReadHits(merged) {
  return merged.map((r, rank) => {
    const { date, supersede_line } = renderMergedHit(r);
    return {
      layer: r._layer,
      source_id: r.source_id,
      rank,
      score: typeof r.score === 'number' ? r.score : null,
      rendered_date: date,
      rendered_supersede_line: supersede_line,
      // task 220: present on chain rows only — the measured policy's stamp
      // bytes stay exactly the pre-220 shape
      ...(r._chain ? { chain_depth: r._chain_depth } : {}),
    };
  });
}

// task 220 — walk each contexted current fact's metadata.supersedes chain over
// the fact page and return the FINAL context: every merged row in order, and
// directly BESIDE each current fact its predecessor chain (newest predecessor
// first, oldest LAST), bounded by maxPredecessors. A chain row is the real hit
// (same shape as a superseded tail hit) plus _chain/_chain_depth so the render
// and the stamp can mark it. Honest bounds: a supersedes id the page does not
// contain is a COUNTED miss (meta.history_chain_misses — the chain truncates
// visibly, never silently); a link whose target has no valid_to is refused —
// a "predecessor" that claims to be current would blur "was" from "is"; rows
// already in the context never render twice. Pure — answer() renders and
// counts what this returns.
export function attachHistoryChains({ merged, factHits, maxPredecessors }) {
  const byId = new Map(factHits.map((h) => [h.source_id, h]));
  const placed = new Set(merged.map((h) => h.source_id));
  const rows = [];
  let misses = 0;
  for (const row of merged) {
    rows.push(row);
    if (row._layer !== 'fact' || row.metadata?.valid_to != null) continue; // only CURRENT facts grow chains
    let id = row.metadata?.supersedes;
    for (let depth = 0; depth < maxPredecessors; depth++) {
      if (!id) break;
      const p = byId.get(id);
      if (!p || p.source_id === row.source_id || p.metadata?.valid_to == null) {
        misses += 1;
        break;
      }
      if (!placed.has(p.source_id)) {
        placed.add(p.source_id);
        rows.push({ ...p, _chain: true, _chain_depth: depth });
      }
      id = p.metadata?.supersedes;
    }
  }
  return { rows, misses };
}

// The pre-committed RECONCILE prompt (verbatim). Quote it in the receipt: the
// reconcile policy IS part of the regime — a different prompt is a different arm.
export const RECONCILE_SYSTEM = `You maintain the long-term memory file of one person. A NEW candidate fact was just extracted from a conversation on a given date. Compare it against the EXISTING facts already in the file (each shown with its id, its date, and its status).

Decide exactly one of:
- ADD — the candidate is new information; nothing existing covers it.
- SUPERSEDE <id> — the candidate updates or contradicts existing fact <id>: the thing itself changed (a plan, a preference, a status, a relationship). The old fact stops being current as of the session date and the candidate takes its place.
- KEEP — the candidate repeats an existing fact with the same meaning and no update. Nothing is written.

Output contract — your ENTIRE reply is one line:
ADD
or: SUPERSEDE <id>
or: KEEP

Rules:
- Prefer ADD when unsure: SUPERSEDE requires the same specific subject whose state changed, not merely extra detail.
- KEEP is only for true duplicates; a changed detail is SUPERSEDE.
- Never invent an id that was not shown to you.`;

// The reconcile user prompt: candidate + session date + the current facts it is
// judged against (id | valid_from | status | text), one per line.
export function buildReconcileUserPrompt({ candidate, sessionDate, existing }) {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error('buildReconcileUserPrompt expects a non-empty candidate fact string');
  }
  const lines = (existing ?? []).map((f) => {
    const date = f.valid_from || 'unknown date';
    const status = f.this_session ? 'current (this session)' : 'current';
    return `${f.id} | ${date} | ${status} | ${f.text}`;
  });
  return (
    `Session date: ${sessionDate || 'unknown date'}\n\n` +
    `Candidate fact:\n${candidate}\n\n` +
    (lines.length ? `Existing facts (id | valid_from | status | text):\n${lines.join('\n')}` : 'Existing facts: (none)')
  );
}

// Strict-but-tolerant parse of the decision reply. Loud on junk: the caller
// fail-opens to ADD and counts it, but the failure is always visible.
//   { action: 'ADD' | 'KEEP', id: null, ok: true }
//   { action: 'SUPERSEDE', id: '<shown id>', ok: true }
//   { action: 'ADD', id: null, ok: false }   — unparseable / invented id
export function parseDecision(text, shownIds) {
  let s = String(text ?? '').trim();
  for (;;) {
    const open = s.indexOf('<think>');
    if (open === -1) break;
    const close = s.indexOf('</think>', open);
    s = close === -1 ? s.slice(0, open) : s.slice(0, open) + s.slice(close + '</think>'.length);
  }
  s = s.trim();
  const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const sup = line.match(/^SUPERSEDE\s*[:-]?\s*(\S+)$/i);
  if (sup) {
    const id = sup[1].replace(/[.,;]+$/, '');
    if (shownIds.has(id)) return { action: 'SUPERSEDE', id, ok: true };
    return { action: 'ADD', id: null, ok: false }; // invented id — the one hard rule
  }
  if (/^ADD\b/i.test(line)) return { action: 'ADD', id: null, ok: true };
  if (/^KEEP\b/i.test(line)) return { action: 'KEEP', id: null, ok: true };
  return { action: 'ADD', id: null, ok: false };
}

// The BATCH reconcile prompt (task 234, reconcile-prompt.2-batch): v1's rules
// carried VERBATIM (prefer ADD; KEEP only true duplicates; never invent an id)
// plus the batch contract — N numbered candidates, the existing facts shown
// once, exactly N numbered reply lines in order. Quote it in the receipt: the
// prompt is part of the regime, and a batch run is a DIFFERENT arm shape from
// the measured per-candidate run (the regime stamps which one ran, by sha).
export const RECONCILE_SYSTEM_BATCH = `You maintain the long-term memory file of one person. N NEW candidate facts were just extracted from conversations on given dates. Compare each against the EXISTING facts already in the file (each shown with its id, its date, and its status). The candidates are numbered; the existing facts are shown once.

For EACH candidate decide exactly one of:
- ADD — the candidate is new information; nothing existing covers it.
- SUPERSEDE <id> — the candidate updates or contradicts existing fact <id>: the thing itself changed (a plan, a preference, a status, a relationship). The old fact stops being current as of the session date and the candidate takes its place.
- KEEP — the candidate repeats an existing fact with the same meaning and no update. Nothing is written.

Output contract — your ENTIRE reply is exactly N lines, one per candidate, numbered, in order:
1. ADD
or: 1. SUPERSEDE <id>
or: 1. KEEP
(repeat for every candidate, each line starting with that candidate's number)

Rules:
- Prefer ADD when unsure: SUPERSEDE requires the same specific subject whose state changed, not merely extra detail.
- KEEP is only for true duplicates; a changed detail is SUPERSEDE.
- Never invent an id that was not shown to you.`;

// The batch reconcile user prompt (task 234): the UNION of the batch's shown
// facts, deduped by id in first-seen order, rendered once in v1's line format
// (id | valid_from | status | text — this_session keeps v1's marker), then the
// numbered candidates. items: [{ candidate, shown: [{id, text, valid_from, this_session?}] }].
export function buildReconcileBatchUserPrompt({ sessionDate, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('buildReconcileBatchUserPrompt expects a non-empty items array');
  }
  const seen = new Set();
  const lines = [];
  for (const it of items) {
    for (const f of it.shown ?? []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      const date = f.valid_from || 'unknown date';
      const status = f.this_session ? 'current (this session)' : 'current';
      lines.push(`${f.id} | ${date} | ${status} | ${f.text}`);
    }
  }
  const candidates = items.map((it, i) => `${i + 1}. ${it.candidate}`);
  const n = items.length;
  return (
    `Session date: ${sessionDate || 'unknown date'}\n\n` +
    (lines.length ? `Existing facts (id | valid_from | status | text):\n${lines.join('\n')}\n\n` : 'Existing facts: (none)\n\n') +
    `Candidates (numbered):\n${candidates.join('\n')}\n\n` +
    `Reply with exactly ${n} line${n === 1 ? '' : 's'}, one per candidate, in order.`
  );
}

// Strict-but-tolerant parse of a BATCH decision reply (task 234) — v1's rules
// per candidate, and the batch's two new failure modes counted rather than
// dropped. shownIds: ONE SET PER CANDIDATE, in batch order (N = its length);
// returns { decisions: [{action, id, ok}...], decision_failures, supersede_conflicts }.
// Fail-open rules (the stamped v1 rule — fail to ADD, never drop silently):
//   a line naming an id not in THAT candidate's shown set → ADD, ok:false, counted;
//   an unparseable or MISSING line → ADD, ok:false, counted;
//   KEEP for a candidate whose shown set was empty → ADD, ok:false, counted
//     (mirrors v1, where KEEP was unreachable with nothing shown);
//   two candidates SUPERSEDING the same id → the FIRST line wins, later ones
//     fall back to ADD, counted supersede_conflicts (a claim by a candidate
//     that failed open never wins the id for conflict purposes).
export function parseDecisionBatch(text, shownIds) {
  if (!Array.isArray(shownIds)) throw new Error('parseDecisionBatch expects shownIds as an array of Sets (one per candidate)');
  const n = shownIds.length;
  let s = String(text ?? '').trim();
  for (;;) {
    const open = s.indexOf('<think>');
    if (open === -1) break;
    const close = s.indexOf('</think>', open);
    s = close === -1 ? s.slice(0, open) : s.slice(0, open) + s.slice(close + '</think>'.length);
  }
  s = s.trim();
  const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  // numbered lines — `1. ADD` / `1) SUPERSEDE <id>` / `1 - KEEP`; the contract
  // is numbered, so an UNNUMBERED decision line is noise (every candidate it
  // leaves uncovered fail-opens loudly below, counted)
  const byIndex = new Map(); // candidate index (0-based) -> {action, id}
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s*[.):-]?\s*(ADD|SUPERSEDE|KEEP)\b[ \t]*(.*)$/i);
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= n) continue; // a number outside the batch names no candidate
    if (byIndex.has(idx)) continue; // duplicate number: FIRST line wins
    const verb = m[2].toUpperCase();
    if (verb === 'SUPERSEDE') {
      const id = (m[3] ?? '').replace(/^[ \t]*[:-][ \t]*/, '').trim().replace(/[.,;]+$/, '');
      byIndex.set(idx, { action: 'SUPERSEDE', id });
    } else {
      byIndex.set(idx, { action: verb, id: null });
    }
  }
  const decisions = new Array(n);
  let failures = 0;
  let conflicts = 0;
  const claimed = new Set(); // ids already superseded by an earlier line in this batch
  const failOpen = () => {
    failures += 1;
    return { action: 'ADD', id: null, ok: false };
  };
  for (let i = 0; i < n; i++) {
    const shown = shownIds[i];
    const parsed = byIndex.get(i);
    if (!parsed) {
      decisions[i] = failOpen(); // missing line — visible, counted
      continue;
    }
    if (parsed.action === 'ADD') {
      decisions[i] = { action: 'ADD', id: null, ok: true };
    } else if (parsed.action === 'KEEP') {
      decisions[i] = shown.size === 0 ? failOpen() : { action: 'KEEP', id: null, ok: true };
    } else if (!shown.has(parsed.id)) {
      decisions[i] = failOpen(); // invented id — the one hard rule
    } else if (claimed.has(parsed.id)) {
      conflicts += 1;
      decisions[i] = { action: 'ADD', id: null, ok: false }; // lost the first-wins race
    } else {
      claimed.add(parsed.id);
      decisions[i] = { action: 'SUPERSEDE', id: parsed.id, ok: true };
    }
  }
  return { decisions, decision_failures: failures, supersede_conflicts: conflicts };
}

// The dataset's session date string, verbatim ("2023/05/20 (Sat) 02:21"). It is
// already lexicographically sortable within its own format; provenance beats
// re-formatting. Missing dates are legal and render as 'unknown date'.
export function sessionDateFor(sessionDates, idx) {
  if (!Array.isArray(sessionDates)) return null;
  const d = sessionDates[idx];
  return typeof d === 'string' && d.length > 0 ? d : null;
}

// `extractionChat` and `reconcileChat` are REQUIRED and must be the answerer
// endpoint called with thinking OFF (run.mjs builds them with
// chat_template_kwargs {"enable_thinking": false}). No fall-back to the plain
// answerChat: a silent fall-back would run this arm thinking-on against a
// stamped thinking-off regime.
export function createArmMyceliumTimeline({
  answerChat,
  extractionChat,
  reconcileChat,
  platform,
  namespace,
  retrievalBudget,
  sourceType = BENCH_SOURCE_TYPE,
  runId,
  log = () => {},
  // The reconciled layer's storage regime (TIMELINE_FACTS_LAYERS). Default:
  // MYCELIUM_TIMELINE_FACTS=am_facts selects the routes, anything else keeps
  // the memory-row shape byte-for-byte.
  factsLayer,
  // optional facts store (bench/memory/facts_store.mjs): extraction is paid once
  // across runs under the SAME extraction regime — identical to the extract arm.
  factsStore = null,
  // reconcile search: overfetch candidates (server top-N), then filter
  // client-side to this question's CURRENT facts (the server has no metadata
  // filter), then keep the top-k for the decision call.
  reconcileTopK = 3,
  reconcileOverfetch = 25,
  // the cost lever: a candidate whose best CURRENT same-question search hit
  // scores below this is an ADD with NO decision call (counted fastpath_adds).
  // Defaults to resolveReconcileFastpathThreshold() — the same resolution
  // run.mjs stamps into the regime — and an explicit value wins for tests.
  reconcileFastpathThreshold,
  // task 220: WHICH read policy answers — resolveTimelineReadPolicy's names,
  // default (undefined) the MEASURED policy. run.mjs passes --read-policy;
  // the same resolution is stamped in the regime.
  readPolicy,
  // task 234: the batch decision lever. resolveReconcileBatchMode()'s opt-in
  // (MYCELIUM_TIMELINE_RECONCILE_BATCH=1); an explicit boolean wins for tests.
  // The batch CAP is reconcileBatchSize — an explicit number wins for tests,
  // else resolveReconcileBatchSize() (BENCH_RECONCILE_BATCH, default 8). Both
  // resolutions are stamped in the regime, so a batch run and the measured
  // per-candidate run are never confused.
  reconcileBatch,
  reconcileBatchSize,
}) {
  if (typeof extractionChat !== 'function') {
    throw new Error(
      'arm_mycelium_timeline requires extractionChat (the answerer endpoint with thinking OFF) — refusing to fall back to answerChat silently'
    );
  }
  if (typeof reconcileChat !== 'function') {
    throw new Error(
      'arm_mycelium_timeline requires reconcileChat (the answerer endpoint with thinking OFF) — refusing to fall back to answerChat silently'
    );
  }
  if (typeof answerChat !== 'function') throw new Error('arm_mycelium_timeline requires answerChat');
  if (!platform) throw new Error('arm_mycelium_timeline requires a platform client');
  if (!Number.isInteger(retrievalBudget) || retrievalBudget <= 0) {
    throw new Error(`arm_mycelium_timeline: retrievalBudget must be a positive int (got ${retrievalBudget}) — run.mjs's armContext provides it`);
  }
  if (!Number.isInteger(reconcileTopK) || reconcileTopK <= 0) throw new Error(`reconcileTopK must be a positive int (got ${reconcileTopK})`);
  if (!Number.isInteger(reconcileOverfetch) || reconcileOverfetch < reconcileTopK) {
    throw new Error(`reconcileOverfetch must be an int >= reconcileTopK (got ${reconcileOverfetch})`);
  }
  const layer = resolveTimelineFactsLayer(factsLayer);
  const useFactRoutes = layer === TIMELINE_FACTS_LAYERS.ROUTES;
  // task 220: the read policy, resolved once at factory time — an unknown
  // name throws HERE, never mid-run
  const policy = resolveTimelineReadPolicy(readPolicy);
  const historyPolicy = policy === TIMELINE_READ_POLICY_HISTORY;
  if (useFactRoutes && (typeof platform.factsCreate !== 'function' || typeof platform.factsSupersede !== 'function')) {
    throw new Error(
      'arm_mycelium_timeline: factsLayer am_facts needs a platform client with factsCreate/factsSupersede (bench/memory/platform.mjs) — refusing to silently fall back to memory rows'
    );
  }
  const fastpath =
    reconcileFastpathThreshold === undefined
      ? resolveReconcileFastpathThreshold()
      : { threshold: reconcileFastpathThreshold, source: 'explicit' };
  if (!Number.isFinite(fastpath.threshold) || fastpath.threshold < 0 || fastpath.threshold > 1) {
    throw new Error(`reconcileFastpathThreshold must be a number in [0, 1] (got ${fastpath.threshold})`);
  }
  // task 234: the batch decision lever — resolved ONCE at factory time, the
  // same resolution run.mjs stamps (mode + size + sources)
  const batchMode = reconcileBatch === undefined ? resolveReconcileBatchMode() : { batch: reconcileBatch === true, source: 'explicit' };
  const batchCap =
    reconcileBatchSize === undefined
      ? resolveReconcileBatchSize()
      : { size: reconcileBatchSize, source: 'explicit' };
  if (!Number.isInteger(batchCap.size) || batchCap.size < 1) {
    throw new Error(`reconcileBatchSize must be a positive int (got ${batchCap.size})`);
  }
  const factsNs = useFactRoutes ? myceliumTimelineFactsNamespace(namespace) : myceliumTimelineNamespace(namespace);
  // per-question write-decision snapshots, keyed by question_id — answer()
  // stamps them into meta.write_decisions so each row carries its own
  // ingestion provenance (a reanswer row, which had no write phase, stamps null)
  const writeDecisionsByQuestion = new Map();

  return {
    name: 'mycelium-timeline',
    sourceType,
    namespace: factsNs,
    // every namespace this arm indexes — run.mjs feeds it to purgeNamespaces so
    // cleanup covers both layers
    namespaces: [namespace, factsNs],
    // WHICH source_type each namespace's INDEX rows carry — cleanup must purge
    // per namespace with the right type. The routes layer indexes as 'am_fact'
    // (server/plugins/auto-memory/routes.js's FACT_INDEX_SOURCE_TYPE, mirrored
    // in FACT_INDEX_SOURCE_TYPE above), not the dataset's bench source type:
    // purging the -amfacts namespace with bench_longmemeval finds 0 rows and
    // silently leaks the index (found live, task 210 flag-path smoke).
    namespaceSourceTypes: {
      [namespace]: sourceType,
      [factsNs]: useFactRoutes ? FACT_INDEX_SOURCE_TYPE : sourceType,
    },
    // the reconciled layer's storage regime — stamped on every receipt so a
    // results row says which regime produced it
    factsLayer: layer,

    async write(sessionTurns, { questionId, sessionDates } = {}) {
      if (!Array.isArray(sessionTurns)) throw new Error('arm_mycelium_timeline.write expects haystack_sessions (array of sessions)');
      if (!runId || !questionId) throw new Error('arm_mycelium_timeline.write requires runId and questionId');

      const counts = {
        question_id: questionId,
        candidates: 0,
        adds: 0,
        supersedes: 0,
        keeps: 0,
        auto_adds: 0,
        decision_calls: 0,
        decision_failures: 0,
        fastpath_adds: 0,
        fastpath_skips_unembedded: 0,
        // task 234 (the batch lever): decision_calls counts CALLS (batches);
        // decisions_batched counts the candidates decided in them;
        // supersede_conflicts the first-wins fallbacks. Zero on the measured
        // path, which never batches.
        decisions_batched: 0,
        supersede_conflicts: 0,
        seconds_per_session: [],
      };
      // The per-candidate decision ledger (task 205): one record per extracted
      // candidate — what was extracted, what was decided, on what evidence.
      // This is what the miss autopsy reads (summary.json
      // write_info.timeline.per_question[].candidates); without it a MISS
      // cannot be diagnosed after the fact.
      const candidatesLedger = [];
      const factsPerSession = [];
      const parseFailures = [];
      let extractMs = 0;
      let reconcileMs = 0;
      let reused = 0;
      let factSeq = 0; // per-question fact counter — deterministic source_ids
      let rowsWritten = 0; // actual platform rows, from the bulk receipts (chunking may split an episode)
      const bulk = []; // everything this question writes, flushed per session

      // Facts decided THIS session, still current, visible to later candidates
      // of the same session before the bulk flush lands: {id, text, valid_from}.
      let sessionFacts;
      // Every fact row written this question, keyed by source_id, holding the
      // LIVE metadata: an in-session SUPERSEDE rewrites the entry in place so
      // later candidates never see a stale current fact. `flushedIds` marks the
      // rows already sent to the platform — superseding one of those needs an
      // upsert push, not just the in-place mutation.
      const pending = new Map();
      const flushedIds = new Set();

      const factSourceId = () => `${runId}-${questionId}-tl-f${factSeq}`;

      // Mint a fact and put it in the ledger. memory-rows mode: the item joins
      // the session's bulk flush, keyed by its deterministic source_id (as
      // before). am_facts mode: the fact goes through POST /auto-memory/facts
      // NOW (per-run namespace, same metadata contract) and the ledger keys on
      // the route-minted am_facts id — the id the reconcile window and the
      // decision prompt will see in search hits. Returns the LEDGER id.
      async function newFactItem({ text, idx, sessionDate, episodeId, supersedesId }) {
        const sourceId = factSourceId();
        factSeq += 1;
        const metadata = {
          question_id: questionId,
          session_index: idx,
          fact_index: factSeq - 1,
          layer: 'fact',
          episode: episodeId,
          session_date: sessionDate,
          valid_from: sessionDate,
          valid_to: null,
          supersedes: supersedesId ?? null,
          superseded_by: null,
          superseded_by_text: null,
          bench: 'longmemeval',
          run_id: runId,
          ingestion: 'timeline',
        };
        const item = { source_type: sourceType, source_id: sourceId, content_text: text, namespace: factsNs, metadata };
        if (useFactRoutes) {
          const r = await platform.factsCreate({
            fact_text: text,
            namespace: factsNs,
            category: 'general',
            source_type: sourceType,
            source_id: sourceId,
            valid_from: sessionDate || null,
            metadata,
          });
          item.serverId = r.id;
          const ledgerId = String(r.id);
          pending.set(ledgerId, item);
          return ledgerId;
        }
        pending.set(sourceId, item);
        bulk.push(item); // written with the session's flush (a later in-place SUPERSEDE mutates this object)
        return sourceId;
      }

      function supersedeInPlace(item, { sessionDate, byId, byText }) {
        item.metadata.valid_to = sessionDate;
        item.metadata.superseded_by = byId;
        item.metadata.superseded_by_text = byText;
      }

      for (let idx = 0; idx < sessionTurns.length; idx++) {
        const t0 = Date.now();
        const turns = sessionTurns[idx];
        const sessionDate = sessionDateFor(sessionDates, idx);
        const episodeId = `${runId}-${questionId}-s${idx}`;
        sessionFacts = [];

        // (a) The EPISODIC row — arm_mycelium's row, plus the session date.
        //     Written even when extraction fails below: the episodic layer is
        //     the verbatim record and does not depend on the extractor.
        bulk.push({
          source_type: sourceType,
          source_id: episodeId,
          content_text: turns.map((t) => `${t.role}: ${t.content}`).join('\n'),
          namespace, // the run's BASE namespace — arm_mycelium's place
          metadata: { question_id: questionId, session_index: idx, bench: 'longmemeval', run_id: runId, layer: 'episode', session_date: sessionDate },
        });

        // (b) EXTRACTION — the same call as mycelium-extract (prompt, model,
        //     thinking off). A malformed reply drops the FACTS of the session,
        //     counted — never the episode row.
        const te = Date.now();
        let facts;
        const cached = factsStore ? factsStore.load(questionId, idx) : null;
        if (cached) {
          reused++;
          facts = Array.isArray(cached.facts) ? cached.facts : [];
          if (cached.parse_failed) parseFailures.push({ session_index: idx, finish_reason: cached.finish_reason ?? null, reason: 'reused: parse failure in the source run' });
          log(`timeline ${idx + 1}/${sessionTurns.length}: ${facts.length} candidate facts REUSED — q=${questionId}`);
        } else {
          const reply = await extractionChat({ system: EXTRACTION_SYSTEM, user: buildExtractionUserPrompt(turns) });
          try {
            facts = parseFactsJson(reply.text);
          } catch (e) {
            parseFailures.push({ session_index: idx, finish_reason: reply.finishReason ?? null, reason: String(e.message).slice(0, 160) });
            facts = [];
            log(`timeline ${idx + 1}/${sessionTurns.length}: EXTRACT PARSE FAILURE — facts dropped, episode row kept (finish_reason=${reply.finishReason ?? 'n/a'}): ${String(e.message).slice(0, 120)} — q=${questionId}`);
          }
          if (factsStore) {
            const failed = parseFailures.length > 0 && parseFailures[parseFailures.length - 1].session_index === idx;
            factsStore.save(questionId, idx, { facts, parse_failed: failed, finish_reason: reply.finishReason ?? null, extract_ms: Date.now() - te }, { runId });
          }
        }
        extractMs += Date.now() - te;
        factsPerSession.push(facts.length);

        // (c) RECONCILIATION — per candidate: one search over the reconciled
        //     layer, then (above the fastpath threshold) ONE decision call.
        //     No existing current fact among the overfetch window is itself
        //     the evidence for ADD — no decision call is spent (stamped
        //     policy: auto_add_on_no_match); a weak best hit (score below the
        //     stamped fastpath threshold) is ADD without a call either —
        //     counted fastpath_adds, the pre-committed cost lever.
        const perSession = { add: 0, sup: 0, keep: 0 };
        if (batchMode.batch) {
          // (c-BATCH) task 234: the SAME per-candidate searches (the ledger
          // needs top_score/shown; the fastpath guard needs the embedded
          // stamp), the SAME auto-add and fastpath decisions, the SAME write
          // semantics — only the DECISION calls batch. A call-bound candidate
          // is QUEUED with its search evidence instead of paying inline; after
          // the scan the queue is decided in ONE call per batchCap.size chunk
          // (a remainder pays another call) and applied in candidate order.
          //
          // STAMPED DEVIATION from the measured in-session window
          // (reconcile_policy.in_session_window_deviation): candidates in one
          // batch do not see each other's decisions — every search below ran
          // BEFORE any of the batch's writes landed. The flush and later
          // sessions see everything, as before. The non-paid paths (auto-add,
          // fastpath) still write inline, so a queued candidate's search DOES
          // see those, exactly as v1's window showed them.
          //
          // LEDGER ORDER: inline entries append during the scan, the queued
          // ones at decision time — a batch-mode session's ledger groups by
          // decision path before candidate order (each entry carries index +
          // session_index, so the candidate order is recoverable). The v1 path
          // below keeps strict candidate order.
          const queue = [];
          for (let ci = 0; ci < facts.length; ci++) {
            const candidate = facts[ci];
            counts.candidates += 1;
            const tr = Date.now();
            const s = await platform.search({
              query: candidate,
              namespace: factsNs,
              sourceTypes: useFactRoutes ? [FACT_INDEX_SOURCE_TYPE] : [sourceType],
              limit: reconcileOverfetch,
            });
            // the reconcile window: IDENTICAL to v1's (same take() order, same
            // client-side filters) — batch changes WHEN the decision is paid,
            // never what the candidate is judged against
            const shown = [];
            const shownIds = new Set();
            let topScore = null;
            let topEmbedded = null;
            const take = (f, thisSession = false) => {
              if (shownIds.has(f.id) || shown.length >= reconcileTopK) return;
              shown.push({ ...f, ...(thisSession ? { this_session: true } : {}) });
              shownIds.add(f.id);
            };
            for (const f of sessionFacts) take(f, true);
            for (const r of s.results ?? []) {
              const m = r.metadata ?? {};
              if (m.question_id !== questionId) continue; // another user's facts
              const p = pending.get(r.source_id);
              if (!p) continue; // not ours (defensive; cannot happen for this question)
              if (p.metadata.valid_to != null) continue; // superseded — history, not a target
              if (topScore === null && typeof r.score === 'number') {
                topScore = r.score;
                topEmbedded = r.embedded === true || r.embedded === false ? r.embedded : null;
              }
              if (shown.length >= reconcileTopK) continue; // keep scanning for the true top score
              take({ id: r.source_id, text: p.content_text, valid_from: p.metadata.valid_from });
            }
            reconcileMs += Date.now() - tr;

            let decisionSource;
            let decision;
            if (shown.length === 0) {
              counts.auto_adds += 1;
              decisionSource = 'auto_add_on_no_match';
              decision = { action: 'ADD', id: null, ok: true };
            } else if (topScore !== null && topScore < fastpath.threshold && topEmbedded !== false) {
              counts.fastpath_adds += 1;
              decisionSource = 'fastpath_below_threshold';
              decision = { action: 'ADD', id: null, ok: true };
            } else {
              // pay later, through the batch. The task-213 guard still counts
              // (the fastpath_skips_unembedded total stays auditable); the
              // ledger source stamps the BATCH path for every paid candidate.
              if (topEmbedded === false) counts.fastpath_skips_unembedded += 1;
              decisionSource = 'decision-batch';
              decision = null; // decided by the batch below
              queue.push({ candidate, ci, shown, shownIds, topScore });
            }

            if (decision) {
              // always an ADD here (auto-no-match and below-threshold): the
              // non-paid paths write inline, exactly as v1 does
              const ledgerEntry = {
                index: ci,
                session_index: idx,
                text: candidate,
                decision: decision.action,
                ok: decision.ok,
                source: decisionSource,
                shown_ids: [...shownIds],
                top_score: topScore,
                source_id: null,
              };
              candidatesLedger.push(ledgerEntry);
              counts.adds += 1;
              perSession.add += 1;
              const newFactId = await newFactItem({ text: candidate, idx, sessionDate, episodeId, supersedesId: null });
              ledgerEntry.source_id = newFactId;
              sessionFacts.push({ id: newFactId, text: candidate, valid_from: sessionDate });
            }
          }
          for (let b = 0; b < queue.length; b += batchCap.size) {
            const chunk = queue.slice(b, b + batchCap.size);
            const tb = Date.now();
            const reply = await reconcileChat({
              system: RECONCILE_SYSTEM_BATCH,
              user: buildReconcileBatchUserPrompt({ sessionDate, items: chunk }),
            });
            reconcileMs += Date.now() - tb;
            counts.decision_calls += 1; // CALLS: one per batch, not per candidate
            const parsed = parseDecisionBatch(reply.text, chunk.map((d) => d.shownIds));
            counts.decision_failures += parsed.decision_failures;
            counts.supersede_conflicts += parsed.supersede_conflicts;
            for (let k = 0; k < chunk.length; k++) {
              counts.decisions_batched += 1;
              const q = chunk[k];
              let decision = parsed.decisions[k];
              // 241/F3 (review 239a): the claimed set in parseDecisionBatch is
              // PER CHUNK, and every batch search ran before any batch write —
              // so a later CHUNK can legally SUPERSEDE an id an earlier chunk
              // already closed (its shown set predates the writes; routes mode
              // would refuse loudly, non-routes supersedeInPlace would
              // silently re-point the history row). Re-check the target at
              // APPLY time: dead or missing fails open to a COUNTED ADD — the
              // same first-wins outcome a within-chunk conflict gets.
              if (decision.action === 'SUPERSEDE') {
                const applyTarget = pending.get(decision.id);
                if (!applyTarget || applyTarget.metadata.valid_to != null) {
                  counts.supersede_conflicts += 1;
                  decision = { action: 'ADD', id: null, ok: false };
                }
              }
              const ledgerEntry = {
                index: q.ci,
                session_index: idx,
                text: q.candidate,
                decision: decision.action,
                ok: decision.ok,
                source: 'decision-batch',
                shown_ids: [...q.shownIds],
                top_score: q.topScore,
                source_id: null,
              };
              candidatesLedger.push(ledgerEntry);
              // the write semantics are v1's, verbatim: KEEP writes nothing; a
              // SUPERSEDE mints the replacement, closes the old row (routes
              // first, then the in-place flip + the cross-flush upsert), and
              // rejoins the session window; an ADD just mints
              if (decision.action === 'KEEP') {
                counts.keeps += 1;
                perSession.keep += 1;
                continue;
              }
              if (decision.action === 'SUPERSEDE') {
                counts.supersedes += 1;
                perSession.sup += 1;
                const newFactId = await newFactItem({ text: q.candidate, idx, sessionDate, episodeId, supersedesId: decision.id });
                ledgerEntry.source_id = newFactId;
                const target = pending.get(decision.id);
                if (useFactRoutes) {
                  // routes mode: the SUPERSEDE goes through POST /facts/:id/supersede
                  // FIRST — a refused supersede throws: the ledger never claims a
                  // flip the routes did not perform (v1's rule)
                  await platform.factsSupersede(decision.id, newFactId, factsNs);
                }
                supersedeInPlace(target, { sessionDate, byId: newFactId, byText: q.candidate });
                if (!useFactRoutes && flushedIds.has(decision.id)) {
                  bulk.push({ ...target, metadata: { ...target.metadata } });
                }
                sessionFacts = sessionFacts.filter((f) => f.id !== decision.id);
                sessionFacts.push({ id: newFactId, text: q.candidate, valid_from: sessionDate });
                log(`timeline ${idx + 1}/${sessionTurns.length}: SUPERSEDE ${decision.id} (batch) — "${q.candidate.slice(0, 60)}" — q=${questionId}`);
              } else {
                counts.adds += 1; // decided ADDs and fail-open ADDs both wrote a fact
                perSession.add += 1;
                const newFactId = await newFactItem({ text: q.candidate, idx, sessionDate, episodeId, supersedesId: null });
                ledgerEntry.source_id = newFactId;
                sessionFacts.push({ id: newFactId, text: q.candidate, valid_from: sessionDate });
              }
            }
          }
        } else for (let ci = 0; ci < facts.length; ci++) {
          const candidate = facts[ci];
          counts.candidates += 1;
          const tr = Date.now();
          const s = await platform.search({
            query: candidate,
            namespace: factsNs,
            sourceTypes: useFactRoutes ? [FACT_INDEX_SOURCE_TYPE] : [sourceType],
            limit: reconcileOverfetch,
          });
          // The reconcile window: this session's just-decided facts FIRST (the
          // closest context, not yet searchable — the flush lands at session
          // end), then the server's current facts for this question, server
          // rank order. Every same-question row in the facts namespace was
          // written by THIS write() call, so the live metadata always comes
          // from `pending` — never from the (possibly stale) server hit.
          // Superseded facts and other questions' facts are never shown —
          // history and other users are not reconciliation targets.
          const shown = [];
          const shownIds = new Set();
          let topScore = null; // best CURRENT same-question fact the search surfaced
          // that hit's own embeddedness, from the server's per-row stamp (task
          // 213): true|false, or null when the hit carried no stamp (a legacy
          // platform / the golden fixture — cannot know, never guessed)
          let topEmbedded = null;
          const take = (f, thisSession = false) => {
            if (shownIds.has(f.id) || shown.length >= reconcileTopK) return;
            shown.push({ ...f, ...(thisSession ? { this_session: true } : {}) });
            shownIds.add(f.id);
          };
          for (const f of sessionFacts) take(f, true);
          for (const r of s.results ?? []) {
            const m = r.metadata ?? {};
            if (m.question_id !== questionId) continue; // another user's facts
            const p = pending.get(r.source_id);
            if (!p) continue; // not ours (defensive; cannot happen for this question)
            if (p.metadata.valid_to != null) continue; // superseded — history, not a target
            if (topScore === null && typeof r.score === 'number') {
              topScore = r.score;
              topEmbedded = r.embedded === true || r.embedded === false ? r.embedded : null;
            }
            if (shown.length >= reconcileTopK) continue; // keep scanning for the true top score
            take({ id: r.source_id, text: p.content_text, valid_from: p.metadata.valid_from });
          }

          // WHERE the decision came from — stamped per candidate in the ledger
          let decisionSource;
          let decision;
          if (shown.length === 0) {
            // nothing current matches: ADD needs no model call (stamped policy
            // auto_add_on_no_match — the empty search IS the evidence)
            counts.auto_adds += 1;
            decisionSource = 'auto_add_on_no_match';
            decision = { action: 'ADD', id: null, ok: true };
          } else if (topScore !== null && topScore < fastpath.threshold && topEmbedded !== false) {
            // the cost lever: even the best current fact is below the stamped
            // threshold — nothing worth a decision ABOUT. ADD, no call. The
            // lever requires an EMBEDDED top hit (or one with no stamp at all —
            // a legacy platform's shape, the golden fixture's: same path as
            // pre-213); an explicitly unembedded hit falls through to the guard.
            counts.fastpath_adds += 1;
            decisionSource = 'fastpath_below_threshold';
            decision = { action: 'ADD', id: null, ok: true };
          } else {
            counts.decision_calls += 1;
            if (topEmbedded === false) {
              // THE GUARD (task 213): the best current hit is UNEMBEDDED — the
              // server stamped embedded:false — so its score is keyword-only,
              // high or low, and a keyword-only score is not evidence the
              // candidate is (or is not) a reconcile case. Below the threshold
              // this WITHHOLDS the fastpath (pre-guard it auto-ADDed on the
              // keyword-only score); above it the call was always paid — the
              // stamp now says what the score rests on. Every skip pays a
              // decision call and is counted, so a run's reconcile decisions
              // are auditable against embedder timing.
              counts.fastpath_skips_unembedded += 1;
              decisionSource = 'fastpath_skipped_unembedded';
            } else {
              decisionSource = 'decision';
            }
            const reply = await reconcileChat({
              system: RECONCILE_SYSTEM,
              user: buildReconcileUserPrompt({ candidate, sessionDate, existing: shown }),
            });
            decision = parseDecision(reply.text, shownIds);
            if (!decision.ok) counts.decision_failures += 1; // fail-open ADD below, visibly
          }
          reconcileMs += Date.now() - tr;

          // The ledger record for THIS candidate — written for every decision
          // path (auto-add, fastpath, call, fail-open), before any write.
          const ledgerEntry = {
            index: ci,
            session_index: idx,
            text: candidate,
            decision: decision.action,
            ok: decision.ok,
            source: decisionSource,
            shown_ids: [...shownIds],
            top_score: topScore,
            source_id: null, // filled below when a fact row was written
          };
          candidatesLedger.push(ledgerEntry);

          if (decision.action === 'KEEP') {
            counts.keeps += 1;
            perSession.keep += 1;
            continue;
          }
          if (decision.action === 'SUPERSEDE') {
            counts.supersedes += 1;
            perSession.sup += 1;
            const newFactId = await newFactItem({ text: candidate, idx, sessionDate, episodeId, supersedesId: decision.id });
            ledgerEntry.source_id = newFactId;
            // the old fact KEEPS its row: live metadata flipped in place (so no
            // later candidate sees it as current), and — if the row already
            // reached the platform — an upsert push carrying the flip
            const target = pending.get(decision.id);
            if (useFactRoutes) {
              // routes mode: the SUPERSEDE goes through POST /facts/:id/supersede
              // FIRST — the server closes the interval, re-indexes the old row
              // with its valid_to + the supersede line, and returns both rows —
              // then the ledger flips. A refused supersede throws: the ledger
              // never claims a flip the routes did not perform.
              await platform.factsSupersede(decision.id, newFactId, factsNs);
            }
            supersedeInPlace(target, { sessionDate, byId: newFactId, byText: candidate });
            if (!useFactRoutes && flushedIds.has(decision.id)) {
              bulk.push({ ...target, metadata: { ...target.metadata } });
            }
            sessionFacts = sessionFacts.filter((f) => f.id !== decision.id);
            sessionFacts.push({ id: newFactId, text: candidate, valid_from: sessionDate });
            log(`timeline ${idx + 1}/${sessionTurns.length}: SUPERSEDE ${decision.id} — "${candidate.slice(0, 60)}" — q=${questionId}`);
          } else {
            counts.adds += 1; // decided ADDs, auto-ADDs, fastpath ADDs and fail-open ADDs all wrote a fact
            perSession.add += 1;
            const newFactId = await newFactItem({ text: candidate, idx, sessionDate, episodeId, supersedesId: null });
            ledgerEntry.source_id = newFactId;
            sessionFacts.push({ id: newFactId, text: candidate, valid_from: sessionDate });
          }
        }

        // flush this session's rows: the NEXT session's reconcile search must
        // see them (reconciliation is against the run's facts AS OF now)
        if (bulk.length) {
          const receipts = await platform.indexBulk(bulk.splice(0, bulk.length));
          rowsWritten += receipts.reduce((acc, r) => acc + (r.rows ?? 0), 0);
        }
        for (const id of pending.keys()) flushedIds.add(id);
        counts.seconds_per_session.push(Number(((Date.now() - t0) / 1000).toFixed(1)));
        log(
          `timeline ${idx + 1}/${sessionTurns.length}: ${facts.length} candidates → +${perSession.add}/~${perSession.sup}/=${perSession.keep}` +
            ` in ${counts.seconds_per_session[counts.seconds_per_session.length - 1]}s — q=${questionId}`
        );
      }

      // the answer rows' meta.write_decisions snapshot (the 7 stamped fields —
      // candidates, adds, supersedes, keeps, decision_calls, decision_failures,
      // fastpath_adds; the BATCH path stamps 9 — WRITE_DECISION_FIELDS_BATCH,
      // calls vs candidates + conflicts) + the full per-candidate ledger rides
      // summary.json via w.timeline (core.mjs keeps per_question whole)
      writeDecisionsByQuestion.set(
        questionId,
        Object.fromEntries((batchMode.batch ? WRITE_DECISION_FIELDS_BATCH : WRITE_DECISION_FIELDS).map((f) => [f, counts[f]]))
      );

      return {
        docs: sessionTurns.length,
        rows: rowsWritten,
        facts: factsPerSession.reduce((a, b) => a + b, 0),
        facts_per_session: factsPerSession,
        extract_ms: extractMs,
        reconcile_ms: reconcileMs,
        parse_failures: parseFailures.length,
        parse_failure_detail: parseFailures,
        facts_reused: reused,
        facts_layer: layer,
        timeline: { ...counts, candidates_ledger: candidatesLedger },
      };
    },

    async answer(question, item) {
      // READ — both layers searched at the stamped budget (the comparability
      // contract: context stays ≤5 rows, same as every other arm), then merged
      // by TIMELINE_READ_POLICY — fact/episode interleave, superseded facts the
      // dated tail (they carry their supersede line: the assistant can cite
      // when something changed). The r3 run proved facts-first starves the
      // episodic layer entirely; see the header comment.
      //
      // A LAYER SEARCH FAILURE is stamped, never faked (task 205): the failed
      // layer yields meta.read_hits == null + retrieval_error, and the healthy
      // layer's hits still answer — an empty array is stamped ONLY when both
      // searches truly returned nothing.
      const searchLayer = async (layerName, ns, sourceTypes, limit = retrievalBudget) => {
        try {
          return { ok: true, layer: layerName, res: await platform.search({ query: question, namespace: ns, sourceTypes, limit }) };
        } catch (err) {
          return { ok: false, layer: layerName, error: `${layerName} search failed: ${String(err.message).slice(0, 200)}` };
        }
      };
      const [f, e] = await Promise.all([
        // task 220: under the history policy the fact layer OVERFETCHES so the
        // superseded predecessors are IN the page the supersedes walk reads;
        // the measured policy asks for exactly the budget, byte-identically.
        searchLayer('fact', factsNs, useFactRoutes ? [FACT_INDEX_SOURCE_TYPE] : [sourceType], historyPolicy ? TIMELINE_HISTORY_OVERFETCH : retrievalBudget),
        searchLayer('episode', namespace, [sourceType]),
      ]);
      const retrievalErrors = [f, e].filter((x) => !x.ok).map((x) => x.error);
      const factHits = (f.ok ? f.res.results ?? [] : []).map((r) => ({ ...r, _layer: 'fact' }));
      const episodeHits = (e.ok ? e.res.results ?? [] : []).map((r) => ({ ...r, _layer: 'episode' }));
      const current = factHits.filter((r) => r.metadata?.valid_to == null);
      const superseded = factHits.filter((r) => r.metadata?.valid_to != null);
      const merged = interleaveLayers({ current, episodes: episodeHits, superseded, budget: retrievalBudget });

      // task 220: the history policy extends the merged context with each
      // contexted current fact's bounded predecessor chain. The measured
      // policy's rows — and therefore its meta bytes — are untouched.
      let contextRows = merged;
      let chainMisses = null;
      if (historyPolicy) {
        const attached = attachHistoryChains({ merged, factHits, maxPredecessors: TIMELINE_HISTORY_MAX_PREDECESSORS });
        contextRows = attached.rows;
        chainMisses = attached.misses;
      }

      const rendered = contextRows.map(renderMergedHit);
      const context = rendered.map((x) => x.line).join('\n\n---\n\n');

      const r = await answerChat({
        system: RAG_SYSTEM,
        user: `Memory context:\n${context || '(no memory found)'}\n\nQuestion: ${question}`,
      });
      // the question's own write-decision snapshot: null when this arm never
      // wrote that question in-process (the --reanswer path) — a missing write
      // phase is stamped null, never an empty
      const wd = item && typeof item.question_id === 'string' ? writeDecisionsByQuestion.get(item.question_id) ?? null : null;
      return {
        text: r.text,
        meta: {
          hits: contextRows.length,
          facts_hits: f.ok ? factHits.length : null,
          episode_hits: e.ok ? episodeHits.length : null,
          current_facts: f.ok ? current.length : null,
          superseded_facts: f.ok ? superseded.length : null,
          context_facts: contextRows.filter((h) => h._layer === 'fact' && h.metadata?.valid_to == null).length,
          context_episodes: contextRows.filter((h) => h._layer === 'episode').length,
          context_superseded: contextRows.filter((h) => h._layer === 'fact' && h.metadata?.valid_to != null).length,
          read_hits: retrievalErrors.length ? null : buildReadHits(contextRows),
          read_hits_available: true,
          retrieval_error: retrievalErrors.length ? retrievalErrors.join('; ') : null,
          // task 207: the shared budget stamp (every arm's rows carry it; the
          // rank stats read it). The read_hits entries keep the task-205 shape
          // above — the shape the shared seam generalizes.
          budget: retrievalBudget,
          write_decisions: wd,
          read_policy: policy,
          // task 220: present under the history policy only — the measured
          // policy's meta bytes stay exactly the pre-220 shape. misses counts
          // supersedes chains the overfetch window could not close.
          ...(historyPolicy ? { history_overfetch: TIMELINE_HISTORY_OVERFETCH, history_chain_misses: chainMisses } : {}),
          // task 206: WHICH store the reconciled layer used — stamped on the
          // routes path only; the default path's row bytes stay the pre-206
          // shape (the regime block carries facts_layer on BOTH paths)
          ...(useFactRoutes ? { facts_layer: layer } : {}),
          retrieval_mode: f.ok ? f.res.mode : e.ok ? e.res.mode : null,
          degraded_reason: f.ok ? (f.res.degraded ? f.res.degraded.reason : null) : e.ok ? (e.res.degraded ? e.res.degraded.reason : null) : null,
          ingestion: 'timeline',
          had_think: !!r.hadThink,
        },
      };
    },
  };
}

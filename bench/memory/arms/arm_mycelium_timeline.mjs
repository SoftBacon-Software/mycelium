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
    };
  });
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
  const sup = line.match(/^SUPERSEDE\s*[:\-]?\s*(\S+)$/i);
  if (sup) {
    const id = sup[1].replace(/[.,;]+$/, '');
    if (shownIds.has(id)) return { action: 'SUPERSEDE', id, ok: true };
    return { action: 'ADD', id: null, ok: false }; // invented id — the one hard rule
  }
  if (/^ADD\b/i.test(line)) return { action: 'ADD', id: null, ok: true };
  if (/^KEEP\b/i.test(line)) return { action: 'KEEP', id: null, ok: true };
  return { action: 'ADD', id: null, ok: false };
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
      let sessionFacts = [];
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
        let facts = [];
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
      // fastpath_adds) + the full per-candidate ledger rides summary.json via
      // w.timeline (core.mjs keeps per_question whole)
      writeDecisionsByQuestion.set(
        questionId,
        Object.fromEntries(WRITE_DECISION_FIELDS.map((f) => [f, counts[f]]))
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
      const searchLayer = async (layerName, ns, sourceTypes) => {
        try {
          return { ok: true, layer: layerName, res: await platform.search({ query: question, namespace: ns, sourceTypes, limit: retrievalBudget }) };
        } catch (err) {
          return { ok: false, layer: layerName, error: `${layerName} search failed: ${String(err.message).slice(0, 200)}` };
        }
      };
      const [f, e] = await Promise.all([
        searchLayer('fact', factsNs, useFactRoutes ? [FACT_INDEX_SOURCE_TYPE] : [sourceType]),
        searchLayer('episode', namespace, [sourceType]),
      ]);
      const retrievalErrors = [f, e].filter((x) => !x.ok).map((x) => x.error);
      const factHits = (f.ok ? f.res.results ?? [] : []).map((r) => ({ ...r, _layer: 'fact' }));
      const episodeHits = (e.ok ? e.res.results ?? [] : []).map((r) => ({ ...r, _layer: 'episode' }));
      const current = factHits.filter((r) => r.metadata?.valid_to == null);
      const superseded = factHits.filter((r) => r.metadata?.valid_to != null);
      const merged = interleaveLayers({ current, episodes: episodeHits, superseded, budget: retrievalBudget });

      const rendered = merged.map(renderMergedHit);
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
          hits: merged.length,
          facts_hits: f.ok ? factHits.length : null,
          episode_hits: e.ok ? episodeHits.length : null,
          current_facts: f.ok ? current.length : null,
          superseded_facts: f.ok ? superseded.length : null,
          context_facts: merged.filter((h) => h._layer === 'fact' && h.metadata?.valid_to == null).length,
          context_episodes: merged.filter((h) => h._layer === 'episode').length,
          context_superseded: merged.filter((h) => h._layer === 'fact' && h.metadata?.valid_to != null).length,
          read_hits: retrievalErrors.length ? null : buildReadHits(merged),
          read_hits_available: true,
          retrieval_error: retrievalErrors.length ? retrievalErrors.join('; ') : null,
          // task 207: the shared budget stamp (every arm's rows carry it; the
          // rank stats read it). The read_hits entries keep the task-205 shape
          // above — the shape the shared seam generalizes.
          budget: retrievalBudget,
          write_decisions: wd,
          read_policy: TIMELINE_READ_POLICY,
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

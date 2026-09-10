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
// Known platform condition, stamped here rather than hidden: rows just written
// are embedded asynchronously, so a reconcile search seconds later may rank the
// newest facts keyword-only until the embedder catches up. The reconcile search
// overfetches and filters client-side by question_id + current-only, which
// bounds the damage; the answer phase waits for embedding coverage (run.mjs
// afterWrite) as every platform arm already does.

import { RAG_SYSTEM, BENCH_SOURCE_TYPE } from './arm_mycelium.mjs';
import { EXTRACTION_SYSTEM, buildExtractionUserPrompt, parseFactsJson } from './arm_mycelium_extract.mjs';

// The reconciled layer is a suffixed sibling of the run namespace; the episodic
// layer IS the run namespace (arm_mycelium's own). Cleanup covers both.
export function myceliumTimelineNamespace(namespace) {
  return `${namespace}-timeline`;
}

export function myceliumTimelineNamespaces(namespace) {
  return [namespace, myceliumTimelineNamespace(namespace)];
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
  // optional facts store (bench/memory/facts_store.mjs): extraction is paid once
  // across runs under the SAME extraction regime — identical to the extract arm.
  factsStore = null,
  // reconcile search: overfetch candidates (server top-N), then filter
  // client-side to this question's CURRENT facts (the server has no metadata
  // filter), then keep the top-k for the decision call.
  reconcileTopK = 3,
  reconcileOverfetch = 25,
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
  const factsNs = myceliumTimelineNamespace(namespace);

  return {
    name: 'mycelium-timeline',
    sourceType,
    namespace: factsNs,
    // every namespace this arm indexes — run.mjs feeds it to purgeNamespaces so
    // cleanup covers both layers
    namespaces: myceliumTimelineNamespaces(namespace),

    async write(sessionTurns, { questionId, sessionDates } = {}) {
      if (!Array.isArray(sessionTurns)) throw new Error('arm_mycelium_timeline.write expects haystack_sessions (array of sessions)');
      if (!runId || !questionId) throw new Error('arm_mycelium_timeline.write requires runId and questionId');

      const counts = {
        question_id: questionId,
        adds: 0,
        supersedes: 0,
        keeps: 0,
        auto_adds: 0,
        decision_calls: 0,
        decision_failures: 0,
        seconds_per_session: [],
      };
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

      function newFactItem({ text, idx, sessionDate, episodeId, supersedesId }) {
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
        pending.set(sourceId, item);
        bulk.push(item); // written with the session's flush (a later in-place SUPERSEDE mutates this object)
        return item;
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
        //     layer, then ONE decision call. No existing current fact among the
        //     overfetch window is itself the evidence for ADD — no decision
        //     call is spent (stamped policy: auto_add_on_no_match).
        const perSession = { add: 0, sup: 0, keep: 0 };
        for (let ci = 0; ci < facts.length; ci++) {
          const candidate = facts[ci];
          const tr = Date.now();
          const s = await platform.search({
            query: candidate,
            namespace: factsNs,
            sourceTypes: [sourceType],
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
          const take = (f, thisSession = false) => {
            if (shownIds.has(f.id) || shown.length >= reconcileTopK) return;
            shown.push({ ...f, ...(thisSession ? { this_session: true } : {}) });
            shownIds.add(f.id);
          };
          for (const f of sessionFacts) take(f, true);
          for (const r of s.results ?? []) {
            if (shown.length >= reconcileTopK) break;
            const m = r.metadata ?? {};
            if (m.question_id !== questionId) continue; // another user's facts
            const p = pending.get(r.source_id);
            if (!p) continue; // not ours (defensive; cannot happen for this question)
            if (p.metadata.valid_to != null) continue; // superseded — history, not a target
            take({ id: r.source_id, text: p.content_text, valid_from: p.metadata.valid_from });
          }

          let decision;
          if (shown.length === 0) {
            // nothing current matches: ADD needs no model call (stamped policy
            // auto_add_on_no_match — the empty search IS the evidence)
            counts.auto_adds += 1;
            decision = { action: 'ADD', id: null, ok: true };
          } else {
            counts.decision_calls += 1;
            const reply = await reconcileChat({
              system: RECONCILE_SYSTEM,
              user: buildReconcileUserPrompt({ candidate, sessionDate, existing: shown }),
            });
            decision = parseDecision(reply.text, shownIds);
            if (!decision.ok) counts.decision_failures += 1; // fail-open ADD below, visibly
          }
          reconcileMs += Date.now() - tr;

          if (decision.action === 'KEEP') {
            counts.keeps += 1;
            perSession.keep += 1;
            continue;
          }
          if (decision.action === 'SUPERSEDE') {
            counts.supersedes += 1;
            perSession.sup += 1;
            const newFact = newFactItem({ text: candidate, idx, sessionDate, episodeId, supersedesId: decision.id });
            // the old fact KEEPS its row: live metadata flipped in place (so no
            // later candidate sees it as current), and — if the row already
            // reached the platform — an upsert push carrying the flip
            const target = pending.get(decision.id);
            supersedeInPlace(target, { sessionDate, byId: newFact.source_id, byText: candidate });
            if (flushedIds.has(decision.id)) {
              bulk.push({ ...target, metadata: { ...target.metadata } });
            }
            sessionFacts = sessionFacts.filter((f) => f.id !== decision.id);
            sessionFacts.push({ id: newFact.source_id, text: candidate, valid_from: sessionDate });
            log(`timeline ${idx + 1}/${sessionTurns.length}: SUPERSEDE ${decision.id} — "${candidate.slice(0, 60)}" — q=${questionId}`);
          } else {
            counts.adds += 1; // decided ADDs, auto-ADDs and fail-open ADDs all wrote a fact
            perSession.add += 1;
            const newFact = newFactItem({ text: candidate, idx, sessionDate, episodeId, supersedesId: null });
            sessionFacts.push({ id: newFact.source_id, text: candidate, valid_from: sessionDate });
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
        timeline: counts,
      };
    },

    async answer(question) {
      // READ — retrieval over BOTH layers at the stamped budget: the reconciled
      // layer's CURRENT facts first (valid_to null, server rank order), then
      // the episodes, then superseded facts (which carry their supersede line —
      // the assistant can cite when something changed). Merged pool capped at
      // the budget: the same budget the other arms retrieve with, spent across
      // two layers.
      const [f, e] = await Promise.all([
        platform.search({ query: question, namespace: factsNs, sourceTypes: [sourceType], limit: retrievalBudget }),
        platform.search({ query: question, namespace, sourceTypes: [sourceType], limit: retrievalBudget }),
      ]);
      const factHits = (f.results ?? []).map((r) => ({ ...r, _layer: 'fact' }));
      const episodeHits = (e.results ?? []).map((r) => ({ ...r, _layer: 'episode' }));
      const current = factHits.filter((r) => r.metadata?.valid_to == null);
      const superseded = factHits.filter((r) => r.metadata?.valid_to != null);
      const merged = [...current, ...episodeHits, ...superseded].slice(0, retrievalBudget);

      const context = merged
        .map((r) => {
          const m = r.metadata ?? {};
          if (r._layer === 'fact') {
            const head = `[fact | ${m.valid_from || 'unknown date'}] ${r.content_text}`;
            return m.valid_to != null ? `${head}\nsuperseded on ${m.valid_to} by: ${m.superseded_by_text ?? '(new fact not recorded)'}` : head;
          }
          return `[session | ${m.session_date || 'unknown date'}] ${r.content_text}`;
        })
        .join('\n\n---\n\n');

      const r = await answerChat({
        system: RAG_SYSTEM,
        user: `Memory context:\n${context || '(no memory found)'}\n\nQuestion: ${question}`,
      });
      return {
        text: r.text,
        meta: {
          hits: merged.length,
          facts_hits: factHits.length,
          episode_hits: episodeHits.length,
          current_facts: current.length,
          superseded_facts: superseded.length,
          retrieval_mode: f.mode,
          degraded_reason: f.degraded ? f.degraded.reason : e.degraded ? e.degraded.reason : null,
          ingestion: 'timeline',
          had_think: !!r.hadThink,
        },
      };
    },
  };
}

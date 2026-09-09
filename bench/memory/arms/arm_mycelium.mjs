// arm_mycelium — the platform's memory API under the benchmark.
//
// write(): one memory row per haystack session (server-side chunk-aware split
//          handles oversized sessions), scoped to this run via
//          source_type=bench_longmemeval + namespace=bench-p1-<runid>.
// answer(): POST /memory/search (hybrid) with a strict scope filter, then the
//           SAME answer model arm_none used, prompted with the retrieved rows.
//
// The retrieval budget (top-k) is a regime parameter, identical for every
// question and stamped into every result row.

export const RAG_SYSTEM =
  'You are a personal assistant with a long-term memory store. Answer the question ' +
  'using ONLY the memory context provided. Be concise (at most two sentences). ' +
  'If the memory context does not contain the answer, say that you do not know.';

export const BENCH_SOURCE_TYPE = 'bench_longmemeval';

export function createArmMycelium({ answerChat, platform, namespace, retrievalBudget, sourceType = BENCH_SOURCE_TYPE, runId }) {
  // refuse to run on an unstamped budget: undefined fell through to the
  // server's default limit (10) while the regime stamped 5 — the banked
  // 2026-09-08 rows all retrieved top-10 under a budget-5 stamp
  if (!Number.isInteger(retrievalBudget) || retrievalBudget <= 0) {
    throw new Error(`arm_mycelium: retrievalBudget must be a positive int (got ${retrievalBudget}) — run.mjs's armContext provides it`);
  }
  return {
    name: 'mycelium',
    sourceType,
    namespace,
    async write(sessionTurns, { questionId } = {}) {
      if (!Array.isArray(sessionTurns)) throw new Error('arm_mycelium.write expects haystack_sessions (array of sessions)');
      const items = sessionTurns.map((turns, idx) => ({
        source_type: sourceType,
        source_id: `${runId}-${questionId}-s${idx}`,
        content_text: turns.map((t) => `${t.role}: ${t.content}`).join('\n'),
        namespace,
        metadata: { question_id: questionId, session_index: idx, bench: 'longmemeval', run_id: runId },
      }));
      const receipts = await platform.indexBulk(items);
      const rows = receipts.reduce((acc, r) => acc + (r.rows ?? 0), 0);
      return { docs: items.length, rows };
    },
    async answer(question) {
      const s = await platform.search({
        query: question,
        namespace,
        sourceTypes: [sourceType],
        limit: retrievalBudget,
      });
      const context = (s.results || []).map((r) => r.content_text).join('\n\n---\n\n');
      const r = await answerChat({
        system: RAG_SYSTEM,
        user: `Memory context:\n${context || '(no memory found)'}\n\nQuestion: ${question}`,
      });
      return {
        text: r.text,
        meta: {
          hits: (s.results || []).length,
          retrieval_mode: s.mode,
          degraded_reason: s.degraded ? s.degraded.reason : null,
          had_think: !!r.hadThink,
        },
      };
    },
  };
}

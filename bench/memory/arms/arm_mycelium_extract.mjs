// arm_mycelium_extract — the EXTRACTION control arm (task 182).
//
// The as-shipped P1 grid confounds two decisions: what a system WRITES
// (ingestion policy) and how well it FINDS it later (retrieval). This arm
// holds retrieval + answer FIXED at arm_mycelium's (same hybrid search, same
// budget, same RAG prompt, same answerer) and flips only ingestion: each
// haystack session is first distilled into a fact list by the SAME answerer
// model at temperature 0 with THINKING OFF (stamped — see the addendum in
// run.mjs's regime), and the facts — not the raw session — are indexed.
//
// Row shape (stamped as facts_row_shape): ONE ROW PER FACT. The extract-policy
// competitor (arm mem0) stores one memory per extracted fact, so per-fact rows
// are what "ingest through an extraction step" produces upstream of retrieval.
// One row per session's fact list would change the SIZE of retrieved context
// rows and re-confound the very comparison this arm exists to remove.
//
// The extraction prompt mirrors the STRUCTURE of mem0's extraction prompt
// (mem0ai 2.0.20, mem0/configs/prompts.py:15 FACT_RETRIEVAL_PROMPT: role
// statement → what counts as a fact → few-shot Input/Output pairs → JSON
// output contract + rules). The wording is ours; the vendor text is not copied.
//
// A replay of this arm is safe against the platform: source_ids are
// deterministic (`<runId>-<qid>-s<idx>-f<j>`), same as arm_mycelium's shape.

import { RAG_SYSTEM, BENCH_SOURCE_TYPE } from './arm_mycelium.mjs';

// The extract arm's namespace is SUFFIXED off the mycelium arm's: two
// mycelium-family arms in one run must never see each other's rows.
export function myceliumExtractNamespace(namespace) {
  return `${namespace}-extract`;
}

export const EXTRACTION_SYSTEM = `You maintain a person's long-term memory file. Read a conversation transcript and pull out the discrete, durable facts it reveals about the user — the statements worth keeping so a personal assistant can serve them better later.

What counts as a fact — one atomic statement per entry, phrased as a short note:
- likes, dislikes and preferences (food, products, entertainment, activities)
- personal details: names, relationships, significant dates, locations
- plans, goals and intentions
- habits and routines: work, travel, fitness, eating
- health and dietary constraints
- professional life: role, employer, projects, career aims
- anything else concrete and durable the user reveals

Output contract — your ENTIRE reply is one JSON object, nothing else:
{"facts": ["<fact>", "<fact>"]}

Rules:
- Only user and assistant turns carry facts; ignore system or tool turns.
- One atomic statement per entry; split compound sentences.
- Record facts in the language of the conversation.
- Never invent what the transcript does not say. No commentary, no markdown.
- If nothing is worth keeping, return {"facts": []}.

Examples:
Transcript:
user: hi
assistant: hello, how can I help?
{"facts": []}

Transcript:
user: I finally signed the lease for the Seattle apartment, and my pastry course starts in October.
assistant: congrats — busy autumn ahead!
{"facts": ["Signed a lease for an apartment in Seattle", "Starting a pastry course in October"]}`;

// The user message: the transcript, one `role: content` line per turn — the
// same rendering arm_mycelium writes raw, so the extractor sees what the raw
// arm would have stored.
export function buildExtractionUserPrompt(sessionTurns) {
  if (!Array.isArray(sessionTurns) || sessionTurns.length === 0) {
    throw new Error('buildExtractionUserPrompt expects a non-empty array of {role, content} turns');
  }
  const lines = sessionTurns.map((t) => {
    if (typeof t?.role !== 'string' || typeof t?.content !== 'string') {
      throw new Error('buildExtractionUserPrompt: turn is not {role, content} strings');
    }
    return `${t.role}: ${t.content}`;
  });
  return `Transcript:\n${lines.join('\n')}`;
}

// Strict-but-tolerant parse of the extractor's reply into a list of facts.
// Loud on anything that is not a JSON object with a "facts" array of strings:
// a silently-mangled fact list would look like an empty session and poison the
// comparison this arm exists to make.
export function parseFactsJson(text) {
  let s = String(text ?? '').trim();
  // defensive: a thinking-mode slip must never become garbage rows
  for (;;) {
    const open = s.indexOf('<think>');
    if (open === -1) break;
    const close = s.indexOf('</think>', open);
    s = close === -1 ? s.slice(0, open) : s.slice(0, open) + s.slice(close + '</think>'.length);
  }
  s = s.trim();
  const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  const open = s.indexOf('{');
  const close = s.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) {
    throw new Error(`extract arm: no JSON object in the extractor reply: ${String(text).slice(0, 200)}`);
  }
  let obj;
  try {
    obj = JSON.parse(s.slice(open, close + 1));
  } catch (e) {
    throw new Error(`extract arm: extractor reply is not valid JSON (${e.message}) — reply head: ${s.slice(open, open + 200)}`, { cause: e });
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !Array.isArray(obj.facts)) {
    throw new Error('extract arm: extractor reply has no "facts" array');
  }
  return obj.facts.map((f) => String(f).trim()).filter((f) => f.length > 0);
}

// `extractionChat` is REQUIRED and must be the answerer endpoint called with
// thinking OFF (run.mjs builds it with chat_template_kwargs
// {"enable_thinking": false}). There is no fall-back to the plain answerChat:
// a silent fall-back would run this arm thinking-on against a stamped
// thinking-off regime — exactly the unstamped mix the addendum forbids.
export function createArmMyceliumExtract({
  answerChat,
  extractionChat,
  platform,
  namespace,
  retrievalBudget,
  sourceType = BENCH_SOURCE_TYPE,
  runId,
  log = () => {},
}) {
  if (typeof extractionChat !== 'function') {
    throw new Error(
      'arm_mycelium_extract requires extractionChat (the answerer endpoint with thinking OFF) — refusing to fall back to answerChat silently'
    );
  }
  if (typeof answerChat !== 'function') throw new Error('arm_mycelium_extract requires answerChat');
  if (!platform) throw new Error('arm_mycelium_extract requires a platform client');
  if (!Number.isInteger(retrievalBudget) || retrievalBudget <= 0) {
    throw new Error(`arm_mycelium_extract: retrievalBudget must be a positive int (got ${retrievalBudget}) — run.mjs's armContext provides it`);
  }
  const ns = myceliumExtractNamespace(namespace);

  return {
    name: 'mycelium-extract',
    sourceType,
    namespace: ns,
    async write(sessionTurns, { questionId } = {}) {
      if (!Array.isArray(sessionTurns)) throw new Error('arm_mycelium_extract.write expects haystack_sessions (array of sessions)');
      const items = [];
      const factsPerSession = [];
      const parseFailures = [];
      let extractMs = 0;
      for (let idx = 0; idx < sessionTurns.length; idx++) {
        const turns = sessionTurns[idx];
        const t0 = Date.now();
        const reply = await extractionChat({ system: EXTRACTION_SYSTEM, user: buildExtractionUserPrompt(turns) });
        // A malformed extractor reply is a DROPPED SESSION, counted and logged —
        // not a dead run. Mem0's extractor does the same ("Error parsing
        // extraction response", the session is skipped); the per-arm drop rate
        // is an ingestion-loss number the receipt reports, and it must be
        // measured the same way on both sides of the 2×2. Run B2 (2026-09-09)
        // died at question 10 of 50 on one truncated reply.
        let facts;
        try {
          facts = parseFactsJson(reply.text);
        } catch (e) {
          parseFailures.push({ session_index: idx, finish_reason: reply.finishReason ?? null, reason: String(e.message).slice(0, 160) });
          facts = [];
          log(
            `extract ${idx + 1}/${sessionTurns.length}: PARSE FAILURE — session dropped (finish_reason=${reply.finishReason ?? 'n/a'}, ` +
              `content_chars=${String(reply.raw ?? reply.text ?? '').length}): ${String(e.message).slice(0, 120)} — q=${questionId}`
          );
        }
        extractMs += Date.now() - t0;
        factsPerSession.push(facts.length);
        if (!parseFailures.length || parseFailures[parseFailures.length - 1].session_index !== idx) {
          log(
            `extract ${idx + 1}/${sessionTurns.length}: ${facts.length} facts in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
              `(thinking off) — q=${questionId}`
          );
        }
        for (let f = 0; f < facts.length; f++) {
          items.push({
            source_type: sourceType,
            source_id: `${runId}-${questionId}-s${idx}-f${f}`,
            content_text: facts[f],
            namespace: ns,
            metadata: {
              question_id: questionId,
              session_index: idx,
              fact_index: f,
              bench: 'longmemeval',
              run_id: runId,
              ingestion: 'extract',
            },
          });
        }
      }
      const receipts = items.length ? await platform.indexBulk(items) : [];
      const rows = receipts.reduce((acc, r) => acc + (r.rows ?? 0), 0);
      return {
        docs: sessionTurns.length,
        rows,
        facts: items.length,
        facts_per_session: factsPerSession,
        extract_ms: extractMs,
        // sessions whose extractor reply could not be parsed: dropped, counted
        parse_failures: parseFailures.length,
        parse_failure_detail: parseFailures,
      };
    },
    async answer(question) {
      // retrieval + answer identical to arm_mycelium — only the ingestion differed
      const s = await platform.search({
        query: question,
        namespace: ns,
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
          ingestion: 'extract',
          had_think: !!r.hadThink,
        },
      };
    },
  };
}

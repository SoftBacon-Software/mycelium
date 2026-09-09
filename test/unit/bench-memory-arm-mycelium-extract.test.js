import { describe, it, expect } from 'vitest';
import {
  createArmMyceliumExtract,
  buildExtractionUserPrompt,
  parseFactsJson,
  myceliumExtractNamespace,
  EXTRACTION_SYSTEM,
} from '../../bench/memory/arms/arm_mycelium_extract.mjs';
import { RAG_SYSTEM } from '../../bench/memory/arms/arm_mycelium.mjs';
import { makeOpenAIChat } from '../../bench/memory/answer.mjs';
import { buildRegime } from '../../bench/memory/regime.mjs';

const SESSIONS = [
  [
    { role: 'user', content: 'I am moving to Lisbon in the spring.' },
    { role: 'assistant', content: 'Lisbon is a great choice.' },
  ],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];

function fakePlatform({ rowsPerBulk } = {}) {
  const calls = { bulk: [] };
  return {
    calls,
    async indexBulk(items) {
      calls.bulk.push(items);
      return [{ rows: rowsPerBulk ?? items.length }];
    },
    async search({ query, namespace, sourceTypes, limit }) {
      calls.search = { query, namespace, sourceTypes, limit };
      return {
        results: [
          { content_text: 'User is moving to Lisbon in the spring.' },
          { content_text: 'User manager is Dana.' },
        ],
        mode: 'hybrid',
      };
    },
  };
}

function fakeExtractor(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    chat: async (args) => {
      calls.push(args);
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return typeof r === 'string' ? { text: r } : r;
    },
  };
}

describe('arm_mycelium_extract — the extraction control arm (task 182)', () => {
  it('write(): extracts per session, indexes ONE ROW PER FACT, reports facts stats', async () => {
    const platform = fakePlatform();
    const extractor = fakeExtractor([
      { text: '{"facts": ["Plans to move to Lisbon in the spring", "Considers Lisbon a good choice"]}' },
      { text: '{"facts": ["User manager is Dana"]}' },
    ]);
    const arm = createArmMyceliumExtract({
      answerChat: async () => ({ text: 'x' }),
      extractionChat: extractor.chat,
      platform,
      namespace: 'bench-p1-run1',
      retrievalBudget: 5,
      runId: 'run1',
    });
    const w = await arm.write(SESSIONS, { questionId: 'q-1' });
    expect(extractor.calls).toHaveLength(2); // one extraction per session
    expect(extractor.calls[0].user).toContain('user: I am moving to Lisbon in the spring.');
    expect(w).toEqual({
      docs: 2,
      rows: 3,
      facts: 3,
      facts_per_session: [2, 1],
      extract_ms: expect.any(Number),
    });
    // one indexed item per fact, in the EXTRACT namespace
    expect(platform.calls.bulk).toHaveLength(1);
    const items = platform.calls.bulk[0];
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      source_type: 'bench_longmemeval',
      source_id: 'run1-q-1-s0-f0',
      content_text: 'Plans to move to Lisbon in the spring',
      namespace: 'bench-p1-run1-extract',
      metadata: { question_id: 'q-1', session_index: 0, fact_index: 0, ingestion: 'extract', run_id: 'run1' },
    });
    expect(items[2].source_id).toBe('run1-q-1-s1-f0');
  });

  it('write(): an empty fact list indexes nothing (no bulk call) and counts as 0', async () => {
    const platform = fakePlatform();
    const extractor = fakeExtractor(['{"facts": []}']);
    const arm = createArmMyceliumExtract({
      answerChat: async () => ({ text: 'x' }),
      extractionChat: extractor.chat,
      platform,
      namespace: 'ns',
      retrievalBudget: 5,
      runId: 'r',
    });
    const w = await arm.write([[{ role: 'user', content: 'hi' }]], { questionId: 'q' });
    expect(w.facts).toBe(0);
    expect(w.facts_per_session).toEqual([0]);
    expect(platform.calls.bulk).toHaveLength(0);
  });

  it('write(): rejects a non-array payload loudly (same contract as arm_mycelium)', async () => {
    const arm = createArmMyceliumExtract({
      answerChat: async () => ({}),
      extractionChat: async () => ({ text: '{}' }),
      platform: fakePlatform(),
      namespace: 'ns',
      retrievalBudget: 5,
      runId: 'r',
    });
    await expect(arm.write('nope', { questionId: 'q' })).rejects.toThrow(/haystack_sessions/);
  });

  it('answer(): searches its OWN namespace at the budget, over the SAME RAG prompt as arm_mycelium', async () => {
    const platform = fakePlatform();
    const users = [];
    const arm = createArmMyceliumExtract({
      answerChat: async (args) => {
        users.push(args);
        return { text: 'Lisbon.', hadThink: false };
      },
      extractionChat: async () => ({ text: '{"facts": []}' }),
      platform,
      namespace: 'bench-p1-run1',
      retrievalBudget: 7,
      runId: 'run1',
    });
    const r = await arm.answer('Which city am I moving to?');
    expect(platform.calls.search).toEqual({
      query: 'Which city am I moving to?',
      namespace: 'bench-p1-run1-extract',
      sourceTypes: ['bench_longmemeval'],
      limit: 7,
    });
    expect(users[0].system).toBe(RAG_SYSTEM);
    expect(users[0].user).toContain('User is moving to Lisbon');
    expect(r.text).toBe('Lisbon.');
    expect(r.meta).toMatchObject({ hits: 2, retrieval_mode: 'hybrid', ingestion: 'extract' });
  });

  it('the control contract: answer() is byte-identical to arm_mycelium given the same retrieval', async () => {
    // Both arms must ask the answerer the SAME thing when retrieval returns the
    // same rows — only ingestion may differ.
    const mkUser = async (makeArm) => {
      let seen = null;
      const arm = makeArm(
        async (args) => {
          seen = args;
          return { text: 'x' };
        }
      );
      await arm.answer('q1');
      return seen;
    };
    const { createArmMycelium } = await import('../../bench/memory/arms/arm_mycelium.mjs');
    const results = {
      results: [{ content_text: 'fact-a' }, { content_text: 'fact-b' }],
      mode: 'hybrid',
    };
    const platform = { async search() { return results; }, async indexBulk() { return []; } };
    const mine = await mkUser((answerChat) =>
      createArmMyceliumExtract({
        answerChat,
        extractionChat: async () => ({ text: '{"facts": []}' }),
        platform,
        namespace: 'ns',
        retrievalBudget: 5,
        runId: 'r',
      })
    );
    const base = await mkUser((answerChat) =>
      createArmMycelium({ answerChat, platform, namespace: 'ns', retrievalBudget: 5, runId: 'r' })
    );
    expect(mine.system).toBe(base.system);
    expect(mine.user).toBe(base.user);
  });

  it('refuses to exist without extractionChat — no silent fall-back to the thinking-on answerer', () => {
    expect(() =>
      createArmMyceliumExtract({
        answerChat: async () => ({}),
        platform: fakePlatform(),
        namespace: 'ns',
        retrievalBudget: 5,
        runId: 'r',
      })
    ).toThrow(/extractionChat.*thinking OFF/s);
  });

  it('refuses an unstamped retrieval budget at factory time', () => {
    for (const bad of [undefined, 0, -1, 2.5]) {
      expect(() =>
        createArmMyceliumExtract({
          answerChat: async () => ({}),
          extractionChat: async () => ({ text: '{}' }),
          platform: fakePlatform(),
          namespace: 'ns',
          retrievalBudget: bad,
          runId: 'r',
        })
      ).toThrow(/retrievalBudget must be a positive int/);
    }
  });

  it('myceliumExtractNamespace: the extract arm is a suffixed sibling of the mycelium arm', () => {
    expect(myceliumExtractNamespace('bench-p1-2026-09-09-p1-x')).toBe('bench-p1-2026-09-09-p1-x-extract');
  });
});

describe('extraction prompt + parser', () => {
  it('buildExtractionUserPrompt renders role: content lines and validates turns', () => {
    expect(buildExtractionUserPrompt(SESSIONS[0])).toBe(
      'Transcript:\nuser: I am moving to Lisbon in the spring.\nassistant: Lisbon is a great choice.'
    );
    expect(() => buildExtractionUserPrompt([])).toThrow(/non-empty array/);
    expect(() => buildExtractionUserPrompt([{ role: 'user' }])).toThrow(/\{role, content\}/);
    expect(() => buildExtractionUserPrompt('nope')).toThrow(/non-empty array/);
  });

  it('the extraction system prompt mirrors mem0 FACT_RETRIEVAL_PROMPT structure WITHOUT copying vendor text', () => {
    // the structural anchors mem0's prompt has (role, categories, examples, JSON contract):
    expect(EXTRACTION_SYSTEM).toContain('{"facts": [');
    expect(EXTRACTION_SYSTEM).toContain('{"facts": []}');
    expect(EXTRACTION_SYSTEM).toContain('Only user and assistant turns');
    expect(EXTRACTION_SYSTEM).toContain('language of the conversation');
    // and no verbatim vendor phrasing:
    expect(EXTRACTION_SYSTEM).not.toContain('Personal Information Organizer');
    expect(EXTRACTION_SYSTEM).not.toContain('FACT_RETRIEVAL_PROMPT');
  });

  it('parseFactsJson: plain, fenced, think-wrapped, and junk — loud on junk', () => {
    expect(parseFactsJson('{"facts": ["a", "b"]}')).toEqual(['a', 'b']);
    expect(parseFactsJson('```json\n{"facts": ["a"]}\n```')).toEqual(['a']);
    expect(parseFactsJson('<think>reasoning</think>{"facts": ["a"]}')).toEqual(['a']);
    expect(parseFactsJson('{"facts": ["  a  ", ""]}')).toEqual(['a']); // trim + drop empties
    expect(parseFactsJson('{"facts": []}')).toEqual([]);
    expect(() => parseFactsJson('no json here')).toThrow(/no JSON object/);
    expect(() => parseFactsJson('{"nope": 1}')).toThrow(/"facts" array/);
    expect(() => parseFactsJson('{"facts": "a"}')).toThrow(/"facts" array/);
    expect(() => parseFactsJson('{"facts": [')).toThrow(/no JSON object/);
  });

  it('the extractor chat carries chat_template_kwargs thinking-off and nothing else changed', async () => {
    const bodies = [];
    const chat = makeOpenAIChat({
      url: 'http://box:11434/v1',
      model: 'qwen3.8:27b',
      maxTokens: 4096,
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      fetchImpl: async (_url, opts) => {
        bodies.push(JSON.parse(opts.body));
        return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"facts": []}' }, finish_reason: 'stop' }] }) };
      },
    });
    await chat({ system: 's', user: 'u' });
    expect(bodies[0]).toMatchObject({
      model: 'qwen3.8:27b',
      temperature: 0,
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(bodies[0].messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });
});

describe('the regime stamps the extraction-control block', () => {
  const base = {
    dateUtc: 'd',
    git: { git_sha: 's', git_dirty: false },
    harnessVersion: 'h',
    dataset: { name: 'n', file: 'f', sha256: 'x', licence: 'l', url: 'u', count: 1 },
    answerer: { model: 'm' },
    judge: { model: 'j' },
    retrieval: { budget: 5 },
    platform: {},
    n: 1,
    notes: [],
  };

  it('mycelium_extract: ingestion, thinking-off extractor, one-row-per-fact + why, suffixed namespace', () => {
    const r = buildRegime({
      ...base,
      mycelium_extract: {
        ingestion: 'extract',
        extraction_model: 'qwen3.8:27b',
        extraction_thinking: 'off',
        facts_row_shape: 'one_row_per_fact',
        namespace: 'bench-p1-r-extract',
        retrieval_budget: 5,
      },
    });
    expect(r.mycelium_extract).toMatchObject({
      ingestion: 'extract',
      extraction_thinking: 'off',
      facts_row_shape: 'one_row_per_fact',
      namespace: 'bench-p1-r-extract',
    });
    expect(buildRegime(base).mycelium_extract).toBeUndefined();
  });

  it('mem0_raw: ingestion raw, infer false, n/a extraction thinking, -raw scope', () => {
    const r = buildRegime({
      ...base,
      mem0_raw: {
        ingestion: 'raw',
        infer: false,
        mem0_add_infer: 'Memory.add(messages, infer=False) — mem0ai 2.0.20 mem0/memory/main.py:770',
        scope: 'bench-p1-r-raw',
        extraction_thinking: 'n/a (raw ingestion — no LLM in the write path)',
        retrieval_budget: 5,
      },
    });
    expect(r.mem0_raw).toMatchObject({ ingestion: 'raw', infer: false, scope: 'bench-p1-r-raw' });
    expect(String(r.mem0_raw.mem0_add_infer)).toContain('main.py:770');
    expect(buildRegime(base).mem0_raw).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createArmNone } from '../../bench/memory/arms/arm_none.mjs';
import { createArmMycelium, BENCH_SOURCE_TYPE } from '../../bench/memory/arms/arm_mycelium.mjs';
import { makeOpenAIChat } from '../../bench/memory/answer.mjs';
import { resolvePlatformEnv, parseSubstrateConf, createPlatform } from '../../bench/memory/platform.mjs';

const SESSIONS = [
  [
    { role: 'user', content: 'I am moving to Lisbon in the spring.' },
    { role: 'assistant', content: 'Lisbon is a great choice.' },
  ],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];

describe('arm_none — the no-memory control', () => {
  it('answers from the question alone and never writes', async () => {
    const calls = [];
    const arm = createArmNone({
      answerChat: async ({ system, user }) => {
        calls.push({ system, user });
        return { text: 'I do not know.', hadThink: false };
      },
    });
    const w = await arm.write(SESSIONS, { questionId: 'q1' });
    expect(w).toBeUndefined(); // nothing written
    const r = await arm.answer('Which city am I moving to?');
    expect(r.text).toBe('I do not know.');
    expect(calls).toHaveLength(1);
    // the question must NOT carry any session content
    expect(calls[0].user).toBe('Which city am I moving to?');
    expect(JSON.stringify(calls[0])).not.toMatch(/Lisbon in the spring/);
  });
});

describe('arm_mycelium — platform memory API', () => {
  function fakePlatform() {
    const calls = { indexBulk: [], search: [] };
    return {
      calls,
      async indexBulk(items) {
        calls.indexBulk.push(items);
        return [{ ok: true, rows: items.length }];
      },
      async search(params) {
        calls.search.push(params);
        return {
          results: [
            { content_text: 'user: I am moving to Lisbon in the spring.' },
            { content_text: 'user: My manager is Dana now.' },
          ],
          mode: 'hybrid',
          count: 2,
        };
      },
    };
  }

  it('write(): one item per session, scoped to the run namespace + bench source_type', async () => {
    const p = fakePlatform();
    const arm = createArmMycelium({
      platform: p,
      namespace: 'bench-p1-test',
      retrievalBudget: 5,
      runId: 'test-run',
      answerChat: async () => ({ text: 'x' }),
    });
    const w = await arm.write(SESSIONS, { questionId: 'q-9' });
    expect(w).toEqual({ docs: 2, rows: 2 });
    expect(p.calls.indexBulk).toHaveLength(1);
    const items = p.calls.indexBulk[0];
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.source_type).toBe(BENCH_SOURCE_TYPE);
      expect(it.namespace).toBe('bench-p1-test');
      expect(it.metadata.question_id).toBe('q-9');
    }
    expect(items[0].source_id).toBe('test-run-q-9-s0');
    expect(items[0].content_text).toContain('user: I am moving to Lisbon');
  });

  it('answer(): searches scoped at the budget and answers over the retrieved rows', async () => {
    const p = fakePlatform();
    const chats = [];
    const arm = createArmMycelium({
      platform: p,
      namespace: 'bench-p1-test',
      retrievalBudget: 7,
      runId: 'test-run',
      answerChat: async (args) => {
        chats.push(args);
        return { text: 'Lisbon.', hadThink: false };
      },
    });
    const r = await arm.answer('Which city am I moving to?');
    expect(r.text).toBe('Lisbon.');
    expect(p.calls.search[0]).toEqual({
      query: 'Which city am I moving to?',
      namespace: 'bench-p1-test',
      sourceTypes: [BENCH_SOURCE_TYPE],
      limit: 7,
    });
    expect(chats[0].user).toContain('Lisbon in the spring'); // context present
    expect(r.meta).toMatchObject({ hits: 2, retrieval_mode: 'hybrid' });
  });

  it('answer(): an empty result set still answers (and says it does not know via prompt)', async () => {
    const p = fakePlatform();
    p.search = async () => ({ results: [], mode: 'keyword-fallback', degraded: { reason: 'no provider' } });
    let seen;
    const arm = createArmMycelium({
      platform: p,
      namespace: 'n',
      retrievalBudget: 5,
      runId: 'r',
      answerChat: async (args) => {
        seen = args.user;
        return { text: 'I do not know.', hadThink: false };
      },
    });
    const r = await arm.answer('q');
    expect(seen).toContain('(no memory found)');
    expect(r.meta.degraded_reason).toBe('no provider');
  });

  it('write() rejects a non-array payload loudly', async () => {
    const arm = createArmMycelium({
      platform: fakePlatform(),
      namespace: 'n',
      retrievalBudget: 5,
      runId: 'r',
      answerChat: async () => ({ text: 'x' }),
    });
    await expect(arm.write('nope', { questionId: 'q' })).rejects.toThrow(/haystack_sessions/);
  });
});

describe('platform client against a fake Mycelium HTTP server', () => {
  let server;
  let baseUrl;
  const seen = { headers: [], bodies: [], paths: [] };

  beforeEach(async () => {
    seen.headers.length = 0;
    seen.bodies.length = 0;
    seen.paths.length = 0;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.paths.push(`${req.method} ${req.url}`);
        seen.headers.push(req.headers['x-admin-key']);
        seen.bodies.push(body ? JSON.parse(body) : null);
        if (req.url === '/api/mycelium/memory/index/bulk') {
          res.end(JSON.stringify({ ok: true, indexed: seen.bodies.at(-1).items.length, rows: 4 }));
        } else if (req.url.startsWith('/api/mycelium/memory/search')) {
          res.end(JSON.stringify({ results: [{ content_text: 'hit' }], mode: 'hybrid', count: 1 }));
        } else if (req.url.startsWith('/api/mycelium/memory/list')) {
          res.end(JSON.stringify({ results: [], source_type: 'bench_longmemeval', count: 0 }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => new Promise((r) => server.close(r)));

  it('routes under /api/mycelium, sends the admin header, and paces bulk batches of 100', async () => {
    const platform = createPlatform({ baseUrl, headers: { 'X-Admin-Key': 'k-test' } });
    const items = Array.from({ length: 250 }, (_, i) => ({
      source_type: 'bench_longmemeval',
      source_id: `id-${i}`,
      content_text: `text ${i}`,
      namespace: 'ns',
    }));
    const receipts = await platform.indexBulk(items);
    expect(receipts).toHaveLength(3); // 100 + 100 + 50
    expect(seen.bodies[0].items).toHaveLength(100);
    expect(seen.bodies[2].items).toHaveLength(50);
    expect(seen.headers.every((h) => h === 'k-test')).toBe(true);
    expect(seen.paths[0]).toBe('POST /api/mycelium/memory/index/bulk');
  });

  it('search applies the namespace + source_types scope server-side', async () => {
    const platform = createPlatform({ baseUrl, headers: {} });
    await platform.search({ query: 'q', namespace: 'bench-p1-x', sourceTypes: ['bench_longmemeval'], limit: 5 });
    expect(seen.bodies[0]).toEqual({
      query: 'q',
      limit: 5,
      mode: 'hybrid',
      namespace: 'bench-p1-x',
      source_types: ['bench_longmemeval'],
    });
  });
});

describe('platform address resolution — never a literal', () => {
  it('env wins over substrate.conf', () => {
    const env = resolvePlatformEnv({
      env: { MYCELIUM_URL: 'http://env-wins:3002' },
      home: '/nonexistent-home',
      readFile: () => {
        throw new Error('no conf');
      },
    });
    expect(env.baseUrl).toBe('http://env-wins:3002');
  });

  it('reads MYCELIUM_URL + keychain service + 3090 box from substrate.conf when env is unset', () => {
    const conf = parseSubstrateConf('# comment\nMYCELIUM_URL=http://from-conf:3002\nBOX_3090_URL=http://box:11434\n');
    expect(conf.MYCELIUM_URL).toBe('http://from-conf:3002');
    expect(conf.BOX_3090_URL).toBe('http://box:11434');
    const env = resolvePlatformEnv({
      env: {},
      home: '/somehome',
      readFile: (p) => {
        if (p.endsWith('substrate.conf')) return 'MYCELIUM_URL=http://from-conf:3002\nBOX_3090_URL=http://box:11434\nMYCELIUM_KEYCHAIN_SERVICE=svc\n';
        throw new Error('missing');
      },
    });
    expect(env.baseUrl).toBe('http://from-conf:3002');
    expect(env.box3090Url).toBe('http://box:11434');
    expect(env.keychainService).toBe('svc');
  });

  it('throws (loud, no hardcoded fallback) with neither env nor conf', () => {
    expect(() =>
      resolvePlatformEnv({
        env: {},
        home: '/nonexistent-home',
        readFile: () => {
          throw new Error('no conf');
        },
      })
    ).toThrow(/never hardcodes an address/);
  });
});

describe('OpenAI-compatible chat adapter', () => {
  it('posts the system+user messages and returns the first choice', async () => {
    let captured;
    const chat = makeOpenAIChat({
      url: 'http://fake:1/v1',
      model: 'fake-model',
      fetchImpl: async (url, opts) => {
        captured = { url, body: JSON.parse(opts.body) };
        return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: 'Lisbon.' } }] }) };
      },
    });
    const r = await chat({ system: 'sys', user: 'usr' });
    expect(captured.url).toBe('http://fake:1/v1/chat/completions');
    expect(captured.body.model).toBe('fake-model');
    expect(captured.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(r.text).toBe('Lisbon.');
  });

  it('errors loud on a non-2xx instead of returning an empty answer', async () => {
    const chat = makeOpenAIChat({
      url: 'http://fake:1/v1',
      model: 'm',
      fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
    });
    await expect(chat({ system: 's', user: 'u' })).rejects.toThrow(/-> 500/);
  });
});

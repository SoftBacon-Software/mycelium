import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createArmNone } from '../../bench/memory/arms/arm_none.mjs';
import { createArmMycelium, BENCH_SOURCE_TYPE } from '../../bench/memory/arms/arm_mycelium.mjs';
import { makeOpenAIChat, isTransientChatError } from '../../bench/memory/answer.mjs';
import { resolvePlatformEnv, parseSubstrateConf, createPlatform, isNetworkLayerError, redactHeaderSecrets, isCurlTransientExit } from '../../bench/memory/platform.mjs';

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
      retries: 0, // a 5xx is transient and retried by default; this test asserts the loud error itself
    });
    await expect(chat({ system: 's', user: 'u' })).rejects.toThrow(/-> 500/);
  });

  it('errors loud when a thinking model spends the whole budget in reasoning_content', async () => {
    // qwen3.8 on llama.cpp puts reasoning in a separate field that still
    // spends max_tokens — content comes back "" and must not grade as an answer.
    const chat = makeOpenAIChat({
      url: 'http://fake:1/v1',
      model: 'qwen3.8:27b',
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '<think>hmm '.repeat(200) } }],
          }),
      }),
    });
    await expect(chat({ system: 's', user: 'u' })).rejects.toThrow(
      /empty answer \(finish_reason=length, reasoning_content_chars=\d+.*raise max_tokens/
    );
  });

  it('grades only the content when reasoning arrives in its own field', async () => {
    const chat = makeOpenAIChat({
      url: 'http://fake:1/v1',
      model: 'qwen3.8:27b',
      fetchImpl: async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: '21 months.', reasoning_content: 'thinking...' } }],
          }),
      }),
    });
    const r = await chat({ system: 's', user: 'u' });
    expect(r.text).toBe('21 months.');
    expect(r.reasoningLen).toBe(11);
    expect(r.finishReason).toBe('stop');
  });
});

describe('makeOpenAIChat — transient failures are retried, deterministic ones are not', () => {
  const ok = (content) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }) });
  const bad = (status, body = 'x') => ({ ok: false, status, text: async () => body });
  const noSleep = async () => {};

  it('a 503 then a 200 returns the answer after one logged retry', async () => {
    const seq = [bad(503, 'loading'), ok('Paris')];
    const logs = [];
    const chat = makeOpenAIChat({ url: 'http://x/v1', model: 'm', fetchImpl: async () => seq.shift(), sleep: noSleep, log: (l) => logs.push(l) });
    const r = await chat({ system: 's', user: 'u' });
    expect(r.text).toBe('Paris');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/attempt 1\/4.*503/);
  });

  it('a transport failure (fetch failed) is retried; the backoff grows 4x', async () => {
    const seq = [() => { throw new TypeError('fetch failed'); }, () => { const e = new Error('x'); e.cause = { code: 'ECONNRESET' }; throw e; }, () => ok('42')];
    const waits = [];
    const chat = makeOpenAIChat({ url: 'http://x/v1', model: 'm', fetchImpl: async () => seq.shift()(), sleep: async (ms) => { waits.push(ms); }, retryBaseMs: 10 });
    expect((await chat({ system: 's', user: 'u' })).text).toBe('42');
    expect(waits).toEqual([10, 40]);
  });

  it('a 400 is thrown at once — the same request would fail again', async () => {
    let calls = 0;
    const chat = makeOpenAIChat({ url: 'http://x/v1', model: 'm', fetchImpl: async () => { calls++; return bad(400, 'bad request'); }, sleep: noSleep });
    await expect(chat({ system: 's', user: 'u' })).rejects.toThrow(/-> 400/);
    expect(calls).toBe(1);
  });

  it('the empty-answer guard is deterministic: no retry', async () => {
    let calls = 0;
    const chat = makeOpenAIChat({ url: 'http://x/v1', model: 'm', fetchImpl: async () => { calls++; return ok('<think>only thinking</think>'); }, sleep: noSleep });
    await expect(chat({ system: 's', user: 'u' })).rejects.toThrow(/empty answer/);
    expect(calls).toBe(1);
  });

  it('gives up after retries+1 attempts with the last error', async () => {
    let calls = 0;
    const chat = makeOpenAIChat({ url: 'http://x/v1', model: 'm', retries: 2, fetchImpl: async () => { calls++; return bad(502, 'bad gateway'); }, sleep: noSleep });
    await expect(chat({ system: 's', user: 'u' })).rejects.toThrow(/-> 502/);
    expect(calls).toBe(3);
  });

  it('isTransientChatError classifies timeouts, resets and 5xx as transient', () => {
    const abort = new Error('This operation was aborted'); abort.name = 'AbortError';
    expect(isTransientChatError(abort)).toBe(true);
    expect(isTransientChatError(new Error('chat m: no content in response'))).toBe(false);
    const s = new Error('chat m -> 500: boom'); s.transientStatus = 500;
    expect(isTransientChatError(s)).toBe(true);
  });
});


describe('platform client — an undici socket failure is a network-layer error: switch to curl, never a dead run', () => {
  const undiciFail = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' }; throw e; };

  it('isNetworkLayerError reads the cause code, not just the message', () => {
    try { undiciFail(); } catch (e) { expect(isNetworkLayerError(e)).toBe(true); }
    const reset = new Error('x'); reset.cause = { code: 'ECONNRESET' };
    expect(isNetworkLayerError(reset)).toBe(true);
    expect(isNetworkLayerError(new Error('POST /memory/search -> 400: bad'))).toBe(false);
    expect(isNetworkLayerError(new Error('chat m: no content in response'))).toBe(false);
  });

  it('engine auto: the first undici failure flips to curl (sticky) and the call still succeeds', async () => {
    let fetchCalls = 0;
    const curlCalls = [];
    const platform = createPlatform({
      baseUrl: 'http://jetson.test:3002',
      headers: { 'X-Admin-Key': 'k' },
      fetchImpl: async () => { fetchCalls++; undiciFail(); },
      curlRun: async (cmd, args) => { curlCalls.push({ cmd, args }); return { stdout: JSON.stringify({ results: [], count: 0 }) + '\n200' }; },
    });
    expect(platform.engine).toBe('fetch');
    const r = await platform.search({ query: 'q', namespace: 'ns', sourceTypes: ['bench_x'], limit: 5 });
    expect(r).toEqual({ results: [], count: 0 });
    expect(platform.engine).toBe('curl');
    expect(fetchCalls).toBe(1);
    expect(curlCalls).toHaveLength(1);
    expect(curlCalls[0].cmd).toBe('curl');
    await platform.stats();
    expect(fetchCalls).toBe(1); // sticky: fetch is not paid again
    expect(curlCalls).toHaveLength(2);
  });
});

describe('platform client — retries wait a capped exponential backoff, the bench passes long bounds', () => {
  it('retryBackoffMs doubles from 1 s and caps at 30 s', async () => {
    const { retryBackoffMs, RETRY_BACKOFF_CAP_MS } = await import('../../bench/memory/platform.mjs');
    expect([0, 1, 2, 3, 4, 5, 6].map(retryBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(RETRY_BACKOFF_CAP_MS).toBe(30000);
  });

  it('a 503 storm is retried maxRetries times with the capped backoff, then surfaces the status', async () => {
    const waits = [];
    let calls = 0;
    const platform = createPlatform({
      baseUrl: 'http://jetson.test:3002',
      fetchImpl: async () => { calls++; return { status: 503, text: async () => 'busy' }; },
      maxRetries: 6,
      sleepFn: async (ms) => { waits.push(ms); },
    });
    await expect(platform.stats()).rejects.toThrow(/-> 503/);
    expect(calls).toBe(7);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });
});

describe('platform client — a name that will not resolve is transient, and the curl error never quotes the key', () => {
  const resolveFail = (n) => {
    const e = new Error(`Command failed: curl -sS -X POST --max-time 180 -H X-Admin-Key: s3cr3tkey-${n} -H X-Acting-As: m5Max http://jetson01.local:3002/x\ncurl: (6) Could not resolve host: jetson01.local`);
    e.cmd = `curl -sS -X POST -H X-Admin-Key: s3cr3tkey-${n} http://jetson01.local:3002/x`;
    e.stderr = 'curl: (6) Could not resolve host: jetson01.local';
    return e;
  };

  it('isNetworkLayerError: curl (6) could-not-resolve and (28) resolving-timed-out are network-layer; a 400 is not', () => {
    expect(isNetworkLayerError(resolveFail(0))).toBe(true);
    expect(isNetworkLayerError(new Error('Command failed: curl\ncurl: (28) Resolving timed out after 926871 milliseconds'))).toBe(true);
    const enotfound = new Error('fetch failed'); enotfound.cause = { code: 'ENOTFOUND' };
    expect(isNetworkLayerError(enotfound)).toBe(true);
    expect(isNetworkLayerError(new Error('getaddrinfo EAI_AGAIN jetson01.local'))).toBe(true);
    expect(isNetworkLayerError(new Error('GET /memory/list -> 400: bad'))).toBe(false);
  });

  it('engine curl: two resolve failures then a 200 — the call succeeds after two backoff waits, not a dead run', async () => {
    const waits = [];
    let calls = 0;
    const platform = createPlatform({
      baseUrl: 'http://jetson01.local:3002',
      headers: { 'X-Admin-Key': 's3cr3tkey-0' },
      engine: 'curl',
      maxRetries: 8,
      sleepFn: async (ms) => { waits.push(ms); },
      curlRun: async () => { calls++; if (calls <= 2) throw resolveFail(0); return { stdout: JSON.stringify({ ok: true }) + '\n200' }; },
    });
    expect(await platform.stats()).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });

  it('the surfaced curl error carries the header NAME but never the admin key (message, cmd)', async () => {
    const platform = createPlatform({
      baseUrl: 'http://jetson01.local:3002',
      headers: { 'X-Admin-Key': 's3cr3tkey-9', 'X-Acting-As': 'm5Max' },
      engine: 'curl',
      maxRetries: 1,
      sleepFn: async () => {},
      curlRun: async () => { throw resolveFail(9); },
    });
    let caught;
    try { await platform.stats(); } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.message).not.toContain('s3cr3tkey-9');
    expect(caught.cmd).not.toContain('s3cr3tkey-9');
    expect(caught.message).toContain('X-Admin-Key: <redacted>');
    expect(caught.message).toContain('Could not resolve host'); // the cause survives the scrub
    expect(caught.message).toContain('m5Max'); // a non-secret header is left alone
  });

  it('redactHeaderSecrets scrubs only secret-looking headers with a real value', () => {
    expect(redactHeaderSecrets('a=abcd1234 b=m5Max c=xy', { 'X-Admin-Key': 'abcd1234', 'X-Acting-As': 'm5Max', 'X-Token': 'xy' }))
      .toBe('a=<redacted> b=m5Max c=xy');
    expect(redactHeaderSecrets(undefined, {})).toBe('');
  });
});

describe('platform client — the curl engine speaks curl: its exit codes and words are network-layer too', () => {
  const curlErr = (code, tail) => {
    const e = new Error(`Command failed: curl -sS -X POST --max-time 180 -w \n%{http_code} http://192.168.50.106:3002/api/mycelium/memory/search\ncurl: (${code}) ${tail}`);
    e.code = code; e.cmd = 'curl -sS -X POST http://192.168.50.106:3002/api/mycelium/memory/search'; e.stderr = `curl: (${code}) ${tail}`;
    return e;
  };

  it('run r2: (28) Failed to connect after 7805 ms is transient — by exit code and by words', () => {
    const e = curlErr(28, 'Failed to connect to 192.168.50.106 port 3002 after 7805 ms: Couldn\'t connect to server');
    expect(isCurlTransientExit(e)).toBe(true);
    expect(isNetworkLayerError(e)).toBe(true);
    // words alone (a wrapper that lost the code)
    const w = new Error('curl: (7) Failed to connect to host'); expect(isNetworkLayerError(w)).toBe(true);
    expect(isNetworkLayerError(new Error('curl: (56) Recv failure: Connection reset by peer'))).toBe(true);
    expect(isNetworkLayerError(new Error('curl: (52) Empty reply from server'))).toBe(true);
    expect(isNetworkLayerError(new Error('curl: (28) Operation timed out after 180000 milliseconds with 0 bytes received'))).toBe(true);
  });

  it('a curl exit code outside the transport set, and an HTTP 4xx, are not transient', () => {
    const e = curlErr(3, 'URL using bad/illegal format'); // a malformed URL is deterministic
    expect(isCurlTransientExit(e)).toBe(false);
    expect(isNetworkLayerError(e)).toBe(false);
    const notCurl = new Error('x'); notCurl.code = 28; // exit code 28 from something that is not curl
    expect(isCurlTransientExit(notCurl)).toBe(false);
    expect(isNetworkLayerError(new Error('POST /memory/search -> 400: bad'))).toBe(false);
  });

  it('engine curl: a connect failure then a 200 succeeds after one backoff', async () => {
    const waits = []; let calls = 0;
    const platform = createPlatform({
      baseUrl: 'http://192.168.50.106:3002', headers: { 'X-Admin-Key': 'k1234' }, engine: 'curl', maxRetries: 8,
      sleepFn: async (ms) => { waits.push(ms); },
      curlRun: async () => { calls++; if (calls === 1) throw curlErr(28, 'Failed to connect to 192.168.50.106 port 3002 after 7805 ms: Couldn\'t connect to server'); return { stdout: JSON.stringify({ results: [] }) + '\n200' }; },
    });
    expect(await platform.search({ query: 'q', namespace: 'ns', sourceTypes: ['t'], limit: 5 })).toEqual({ results: [] });
    expect(calls).toBe(2); expect(waits).toEqual([1000]);
  });
});

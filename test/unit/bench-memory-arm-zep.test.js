import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createArmZep,
  createZepSidecarManager,
  resolveZepEnv,
  resolveSidecarPython,
  zepScope,
} from '../../bench/memory/arms/arm_zep.mjs';
import { buildRegime } from '../../bench/memory/regime.mjs';

const SESSIONS = [
  [
    { role: 'user', content: 'I am moving to Lisbon in the spring.' },
    { role: 'assistant', content: 'Lisbon is a great choice.' },
  ],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];

function fakeSidecar({ searchResults = [], addCount = 1 } = {}) {
  const calls = { add: [], search: [] };
  return {
    calls,
    async request(pathname, body) {
      if (pathname === '/add') {
        calls.add.push(body);
        return { ok: true, episode: 'q-s0', count: addCount };
      }
      if (pathname === '/search') {
        calls.search.push(body);
        return { ok: true, count: searchResults.length, results: searchResults };
      }
      throw new Error(`fake sidecar: no route ${pathname}`);
    },
    async stop() {},
  };
}

describe('arm_zep — the Zep OSS (graphiti) competitor arm', () => {
  it('write(): one POST per haystack session, scoped to the run, metadata carrying the question', async () => {
    const sidecar = fakeSidecar({ addCount: 3 });
    const arm = createArmZep({
      answerChat: async () => ({ text: 'x' }),
      runId: 'test-run',
      retrievalBudget: 5,
      sidecar,
    });
    const w = await arm.write(SESSIONS, { questionId: 'q-9' });
    expect(w).toEqual({ docs: 2, rows: 6 }); // docs = sessions (episodes), rows = facts extracted
    expect(sidecar.calls.add).toHaveLength(2); // ONE POST per session
    expect(sidecar.calls.add[0].user_id).toBe('bench-p1-test-run');
    expect(sidecar.calls.add[0].metadata).toMatchObject({ question_id: 'q-9', session_index: 0, bench_run_id: 'test-run' });
    expect(sidecar.calls.add[0].messages[0]).toEqual({ role: 'user', content: 'I am moving to Lisbon in the spring.' });
    expect(sidecar.calls.add[1].metadata.session_index).toBe(1);
  });

  it('write() rejects a non-array payload loudly (same contract as the other arms)', async () => {
    const arm = createArmZep({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: fakeSidecar(),
    });
    await expect(arm.write('nope', { questionId: 'q' })).rejects.toThrow(/haystack_sessions/);
  });

  it('answer(): searches at the retrieval budget, then answers over the retrieved facts', async () => {
    const sidecar = fakeSidecar({
      searchResults: [
        { memory: 'User is moving to Lisbon in the spring.', score: null, id: 'e1' },
        { memory: 'User manager is Dana.', score: null, id: 'e2' },
      ],
    });
    const chats = [];
    const arm = createArmZep({
      answerChat: async (args) => {
        chats.push(args);
        return { text: 'Lisbon.', hadThink: false };
      },
      runId: 'test-run',
      retrievalBudget: 7,
      sidecar,
      zepVersion: '0.30.2',
    });
    const r = await arm.answer('Which city am I moving to?');
    expect(sidecar.calls.search).toHaveLength(1);
    expect(sidecar.calls.search[0]).toEqual({
      query: 'Which city am I moving to?',
      user_id: 'bench-p1-test-run',
      limit: 7, // the budget is honoured exactly — never defaulted
    });
    expect(chats).toHaveLength(1); // search THEN chat
    expect(chats[0].user).toContain('Lisbon in the spring'); // retrieved context present
    expect(chats[0].system).toContain('long-term memory store'); // the same RAG prompt as the other arms
    expect(r.text).toBe('Lisbon.');
    expect(r.meta).toMatchObject({
      hits: 2,
      retrieval_mode: 'zep-oss-kuzu-hybrid-rrf',
      zep_version: '0.30.2',
    });
  });

  it('answer(): empty retrieval still answers and says so via the prompt', async () => {
    let seen;
    const arm = createArmZep({
      answerChat: async (args) => {
        seen = args.user;
        return { text: 'I do not know.' };
      },
      runId: 'r',
      retrievalBudget: 5,
      sidecar: fakeSidecar({ searchResults: [] }),
    });
    await arm.answer('q');
    expect(seen).toContain('(no memory found)');
  });

  it('a down sidecar is a LOUD error, never an empty answer', async () => {
    const arm = createArmZep({
      answerChat: async () => ({ text: 'should never be reached' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: {
        async request() {
          throw new Error('zep sidecar unreachable at http://127.0.0.1:1 (ECONNREFUSED) — the arm fails loudly, never with an empty answer');
        },
      },
    });
    await expect(arm.answer('q')).rejects.toThrow(/unreachable.*never with an empty answer/s);
    await expect(arm.write(SESSIONS, { questionId: 'q' })).rejects.toThrow(/unreachable/);
  });

  it('refuses to exist without a started sidecar', () => {
    expect(() => createArmZep({ answerChat: async () => ({}), runId: 'r', retrievalBudget: 5 })).toThrow(/started sidecar/);
  });

  it('refuses an unstamped retrieval budget at factory time, not at first answer', () => {
    for (const bad of [undefined, 0, -1, 2.5]) {
      expect(() => createArmZep({ answerChat: async () => ({}), runId: 'r', retrievalBudget: bad, sidecar: fakeSidecar() }))
        .toThrow(/retrievalBudget must be a positive int/);
    }
  });

  it('run.mjs contract: the arm reads sidecar, zepVersion and its own restart from the zep ctx object', async () => {
    const sidecar = fakeSidecar();
    const arm = createArmZep({
      answerChat: async () => ({ text: 'a' }),
      runId: 'r',
      retrievalBudget: 5,
      zep: { sidecar, zepVersion: '0.30.2', restart: async () => { throw new Error('not used here'); } },
    });
    await arm.answer('q');
    expect(sidecar.calls.search[0].user_id).toBe('bench-p1-r');
    expect(sidecar.calls.search[0].limit).toBe(5);
    const row = await arm.answer('q2');
    expect(row.meta.zep_version).toBe('0.30.2');
  });

  it('write() resumes from the checkpoint — committed sessions are never re-added', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zep-cp-'));
    try {
      const cp = path.join(dir, 'zep-sessions-q-9.json');
      fs.writeFileSync(cp, JSON.stringify({ question_id: 'q-9', sessions_done: 1 }) + '\n');
      const sidecar = fakeSidecar({ addCount: 1 });
      const arm = createArmZep({
        answerChat: async () => ({ text: 'x' }),
        runId: 'r',
        retrievalBudget: 5,
        sidecar,
        resumeDir: dir,
      });
      const w = await arm.write(SESSIONS, { questionId: 'q-9' });
      expect(sidecar.calls.add).toHaveLength(1); // session 0 skipped — already committed
      expect(sidecar.calls.add[0].metadata.session_index).toBe(1);
      expect(JSON.parse(fs.readFileSync(cp, 'utf8'))).toEqual({ question_id: 'q-9', sessions_done: 2 });
      expect(w.docs).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ECONNREFUSED (request provably never arrived) → restart, replay, checkpoint stays truthful', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zep-cp-'));
    try {
      const refused = () => Promise.reject(new Error('zep sidecar unreachable (connect ECONNREFUSED)', { cause: { code: 'ECONNREFUSED' } }));
      const dead = { calls: { add: [], search: [] }, async request() { return refused(); }, async stop() {} };
      const alive = fakeSidecar({ addCount: 2 });
      let restarts = 0;
      const arm = createArmZep({
        answerChat: async () => ({ text: 'x' }),
        runId: 'r',
        retrievalBudget: 5,
        sidecar: dead,
        resumeDir: dir,
        restartSidecar: async () => { restarts += 1; return alive; },
      });
      const w = await arm.write(SESSIONS, { questionId: 'q-9' });
      expect(restarts).toBe(1);
      expect(alive.calls.add).toHaveLength(2); // both sessions replayed on the new sidecar
      expect(w.rows).toBe(4);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'zep-sessions-q-9.json'), 'utf8')).sessions_done).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a mid-response failure could have committed — fails loud, NEVER restarts', async () => {
    const timeouted = () => Promise.reject(new Error('aborted due to timeout', { cause: { code: 'UND_ERR_ABORTED' } }));
    const flaky = { calls: { add: [], search: [] }, async request() { return timeouted(); }, async stop() {} };
    const arm = createArmZep({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: flaky,
      restartSidecar: async () => { throw new Error('restart must not be attempted'); },
    });
    await expect(arm.write(SESSIONS, { questionId: 'q-9' })).rejects.toThrow(/aborted due to timeout/);
  });

  it('more than maxRestarts refused connections fails loud instead of looping', async () => {
    const refused = () => Promise.reject(new Error('unreachable', { cause: { code: 'ECONNREFUSED' } }));
    const dead = { calls: { add: [], search: [] }, async request() { return refused(); }, async stop() {} };
    let restarts = 0;
    const arm = createArmZep({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: dead,
      restartSidecar: async () => { restarts += 1; return dead; },
      maxRestarts: 2,
    });
    await expect(arm.write(SESSIONS, { questionId: 'q-9' })).rejects.toThrow(/unreachable/);
    expect(restarts).toBe(2);
  });
});

describe('zep sidecar manager — spawn / ready-line / port-freed lifecycle', () => {
  const servers = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  function listen(handler) {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  // a child that speaks the sidecar protocol without graphiti: ready line,
  // /health, then exits on SIGTERM. It closes its listener only ~300 ms AFTER
  // exiting — so stop() must poll the port beyond the child's exit to call it
  // freed.
  const FAKE_SIDECAR = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/health'
          ? { ok: true, pid: process.pid, graphiti_version: 'fake-0.0', kuzu_version: 'fake-0.0' }
          : { ok: true, count: 1, results: [] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.stderr.write('ZEP_SIDECAR_READY ' + server.address().port + '\\n');
    });
    process.on('SIGTERM', () => {
      setTimeout(() => process.exit(0), 300);
    });
  `;

  it('start(): learns the port from the ready line and polls /health; request() round-trips', async () => {
    const manager = createZepSidecarManager({ command: [process.execPath, '-e', FAKE_SIDECAR], log: () => {} });
    const health = await manager.start();
    expect(health.ok).toBe(true);
    expect(health.graphiti_version).toBe('fake-0.0');
    expect(manager.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await manager.request('/add', { user_id: 'u', messages: [] });
    expect(r.ok).toBe(true);
    const stop = await manager.stop();
    expect(stop).toMatchObject({ stopped: true, port_freed: true });
  }, 30000);

  it('stop() gates on the PORT being free, not just the child exiting', async () => {
    // the child announces a port that a listener STILL HOLDS (the test's own
    // server). The child exits on SIGTERM; the port stays bound — stop() must
    // end loud, not pretend.
    const server = await listen((req, res) => res.end(JSON.stringify({ ok: true })));
    servers.push(server);
    const port = server.address().port;
    const manager = createZepSidecarManager({
      command: [
        process.execPath,
        '-e',
        `process.stderr.write('ZEP_SIDECAR_READY ${port}' + String.fromCharCode(10)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`,
      ],
      portFreedTimeoutMs: 1500,
      log: () => {},
    });
    await manager.start(); // /health is served by the test's own listener
    await expect(manager.stop()).rejects.toThrow(/port \d+ is still accepting connections/);
    // the child is already dead at this point — nothing to clean up
  }, 30000);

  it('request() to a sidecar that has died fails loudly with the never-empty contract', async () => {
    const manager = createZepSidecarManager({ command: [process.execPath, '-e', FAKE_SIDECAR], log: () => {} });
    await manager.start();
    process.kill(manager.pid, 'SIGKILL'); // the sidecar crashes mid-run
    await expect(manager.request('/search', {})).rejects.toThrow(/unreachable.*never with an empty answer/s);
    // the child is already dead — no stop() needed (calling it would re-signal a corpse)
  }, 30000);

  it('start() surfaces the child stderr when the sidecar dies before announcing', async () => {
    const manager = createZepSidecarManager({
      command: [process.execPath, '-e', `process.stderr.write('graphiti-core not installed\\n'); process.exit(3);`],
      log: () => {},
    });
    await expect(manager.start()).rejects.toThrow(/exited before becoming ready[\s\S]*graphiti-core not installed/);
  }, 30000);
});

describe('zep env resolution — never a literal address', () => {
  const CONF = 'MYCELIUM_URL=http://jetson01.local:3002\nBOX_3090_URL=http://DESKTOP-1UIQNIP:11434\n';
  const reader = () => CONF;

  it('BOX_3090_URL from substrate.conf becomes the /v1 LLM base; embedder derived from MYCELIUM_URL host + /v1', () => {
    const e = resolveZepEnv({ env: {}, home: '/home', readFile: reader });
    expect(e.llmBaseUrl).toBe('http://DESKTOP-1UIQNIP:11434/v1');
    expect(e.llmModel).toBe('qwen3.8:27b');
    // graphiti's OpenAIEmbedder appends /embeddings — the base MUST be the /v1
    // form (mem0 uses the native /api/embed on the bare base; same ollama,
    // one path segment apart)
    expect(e.embedderBaseUrl).toBe('http://jetson01.local:11434/v1');
    expect(e.embedderModel).toBe('nomic-embed-text');
    expect(e.embedderDims).toBe(768);
  });

  it('a bare ollama base gains /v1 exactly once; an explicit /v1 base is left alone', () => {
    const withBare = resolveZepEnv({
      env: { ZEP_EMBEDDER_BASE_URL: 'http://embed-wins:11434' },
      home: '/home',
      readFile: reader,
    });
    expect(withBare.embedderBaseUrl).toBe('http://embed-wins:11434/v1');
    const withV1 = resolveZepEnv({
      env: { ZEP_EMBEDDER_BASE_URL: 'http://embed-wins:11434/v1/' },
      home: '/home',
      readFile: reader,
    });
    expect(withV1.embedderBaseUrl).toBe('http://embed-wins:11434/v1');
  });

  it('env overrides win (ZEP_LLM_BASE_URL, ZEP_EMBEDDER_BASE_URL, ZEP_EMBEDDER_DIMS, ZEP_LLM_MODEL)', () => {
    const e = resolveZepEnv({
      env: {
        ZEP_LLM_BASE_URL: 'http://env-wins:9/v1',
        ZEP_LLM_MODEL: 'other-model',
        ZEP_EMBEDDER_BASE_URL: 'http://embed-wins:11434',
        ZEP_EMBEDDER_DIMS: '512',
      },
      home: '/home',
      readFile: reader,
    });
    expect(e.llmBaseUrl).toBe('http://env-wins:9/v1');
    expect(e.llmModel).toBe('other-model');
    expect(e.embedderBaseUrl).toBe('http://embed-wins:11434/v1');
    expect(e.embedderDims).toBe(512);
  });

  it('throws loud with neither env nor conf — no hardcoded fallback', () => {
    expect(() => resolveZepEnv({ env: {}, home: '/nonexistent', readFile: () => { throw new Error('no conf'); } })).toThrow(
      /never hardcodes an address/
    );
  });
});

describe('sidecar python resolution + regime block + scope', () => {
  it('ZEP_SIDECAR_PYTHON env wins; the venv python next; else loud setup error', () => {
    expect(resolveSidecarPython({ env: { ZEP_SIDECAR_PYTHON: '/custom/python' } })).toBe('/custom/python');
    expect(resolveSidecarPython({ env: {}, exists: (p) => p.endsWith('.zep-venv/bin/python') })).toMatch(/\.zep-venv\/bin\/python$/);
    expect(() => resolveSidecarPython({ env: {}, exists: () => false })).toThrow(/zep-requirements\.txt/);
  });

  it('the regime gains zep + write sections only when they are in play', () => {
    const base = {
      dateUtc: 'd', git: { git_sha: 's', git_dirty: false }, harnessVersion: 'h',
      dataset: { name: 'n', file: 'f', sha256: 'x', licence: 'l', url: 'u', count: 1 },
      answerer: { model: 'm' }, judge: { model: 'j' },
      retrieval: { budget: 5 }, platform: {}, n: 1, notes: [],
    };
    const withZep = buildRegime({
      ...base,
      zep: { graphiti_version: '0.30.2', kuzu_version: '0.11.3', retrieval_budget: 5 },
      write: { max_sessions_per_question: 5 },
    });
    expect(withZep.zep).toMatchObject({ graphiti_version: '0.30.2', kuzu_version: '0.11.3', retrieval_budget: 5 });
    expect(withZep.write).toEqual({ max_sessions_per_question: 5 });
    const without = buildRegime(base);
    expect(without.zep).toBeUndefined();
    expect(without.write).toBeUndefined();
  });

  it('zepScope matches the mycelium namespace granularity', () => {
    expect(zepScope('2026-09-09-p1-x')).toBe('bench-p1-2026-09-09-p1-x');
  });

  it('the registry knows the zep arm', async () => {
    const { ARM_FACTORIES } = await import('../../bench/memory/arms/index.mjs');
    expect(ARM_FACTORIES.zep).toBeDefined();
  });
});

import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createArmLetta,
  createLettaSidecarManager,
  resolveLettaEnv,
  resolveSidecarPython,
  lettaScope,
} from '../../bench/memory/arms/arm_letta.mjs';
import { buildRegime } from '../../bench/memory/regime.mjs';

const SESSIONS = [
  [
    { role: 'user', content: 'I am moving to Lisbon in the spring.' },
    { role: 'assistant', content: 'Lisbon is a great choice.' },
  ],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];

// letta's sidecar returns {ok, agent_id, count} on /add (ONE archival passage
// per session) and {ok, agent_id, results, count} on /search.
function fakeSidecar({ searchResults = [], passageCount = 1 } = {}) {
  const calls = { add: [], search: [], delete_all: [] };
  return {
    calls,
    async request(pathname, body) {
      if (pathname === '/add') {
        calls.add.push(body);
        return { ok: true, agent_id: 'agent-fake-0001', count: passageCount };
      }
      if (pathname === '/search') {
        calls.search.push(body);
        return { ok: true, agent_id: 'agent-fake-0001', count: searchResults.length, results: searchResults };
      }
      if (pathname === '/delete_all') {
        calls.delete_all.push(body);
        return { ok: true, user_id: body.user_id, deleted_agent: 'agent-fake-0001' };
      }
      throw new Error(`fake sidecar: no route ${pathname}`);
    },
    async stop() {},
  };
}

describe('arm_letta — the Letta OSS (formerly MemGPT) competitor arm', () => {
  it('write(): one POST per haystack session, scoped to the run, metadata carrying the question', async () => {
    const sidecar = fakeSidecar({ passageCount: 1 });
    const arm = createArmLetta({
      answerChat: async () => ({ text: 'x' }),
      runId: 'test-run',
      retrievalBudget: 5,
      sidecar,
    });
    const w = await arm.write(SESSIONS, { questionId: 'q-9' });
    expect(w).toEqual({ docs: 2, rows: 2 }); // docs = sessions, rows = archival passages (one per session)
    expect(sidecar.calls.add).toHaveLength(2); // ONE POST per session
    expect(sidecar.calls.add[0].user_id).toBe('bench-p1-test-run');
    expect(sidecar.calls.add[0].metadata).toMatchObject({
      question_id: 'q-9',
      session_index: 0,
      bench: 'longmemeval',
      bench_run_id: 'test-run',
    });
    expect(sidecar.calls.add[0].messages[0]).toEqual({ role: 'user', content: 'I am moving to Lisbon in the spring.' });
    expect(sidecar.calls.add[1].metadata.session_index).toBe(1);
  });

  it('write() rejects a non-array payload loudly (same contract as arm_mycelium)', async () => {
    const arm = createArmLetta({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: fakeSidecar(),
    });
    await expect(arm.write('nope', { questionId: 'q' })).rejects.toThrow(/haystack_sessions/);
  });

  it('answer(): archival search at the retrieval budget, then the shared answerer over the results', async () => {
    const sidecar = fakeSidecar({
      searchResults: [
        { memory: 'User is moving to Lisbon in the spring.', score: 0.42, id: 'passage-1' },
        { memory: 'User manager is Dana.', score: 0.31, id: 'passage-2' },
      ],
    });
    const chats = [];
    const arm = createArmLetta({
      answerChat: async (args) => {
        chats.push(args);
        return { text: 'Lisbon.', hadThink: false };
      },
      runId: 'test-run',
      retrievalBudget: 7,
      sidecar,
      lettaVersion: '0.16.8',
      lettaClientVersion: '1.12.1',
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
    expect(chats[0].system).toContain('long-term memory store'); // the same RAG prompt as arm_mycelium
    expect(r.text).toBe('Lisbon.');
    expect(r.meta).toMatchObject({
      hits: 2,
      retrieval_mode: 'letta-oss-archival-semantic',
      letta_version: '0.16.8',
      letta_client_version: '1.12.1',
    });
  });

  it('answer(): empty retrieval still answers and says so via the prompt', async () => {
    let seen;
    const arm = createArmLetta({
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
    const arm = createArmLetta({
      answerChat: async () => ({ text: 'should never be reached' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: {
        async request() {
          throw new Error('letta sidecar unreachable at http://127.0.0.1:1 (ECONNREFUSED) — the arm fails loudly, never with an empty answer');
        },
      },
    });
    await expect(arm.answer('q')).rejects.toThrow(/unreachable.*never with an empty answer/s);
    await expect(arm.write(SESSIONS, { questionId: 'q' })).rejects.toThrow(/unreachable/);
  });

  it('refuses to exist without a started sidecar', () => {
    expect(() => createArmLetta({ answerChat: async () => ({}), runId: 'r', retrievalBudget: 5 })).toThrow(/started sidecar/);
  });

  it('refuses an unstamped retrieval budget at factory time, not at first answer', () => {
    for (const bad of [undefined, 0, -1, 2.5]) {
      expect(() => createArmLetta({ answerChat: async () => ({}), runId: 'r', retrievalBudget: bad, sidecar: fakeSidecar() }))
        .toThrow(/retrievalBudget must be a positive int/);
    }
  });

  it('run.mjs contract: the arm reads sidecar + versions + restart from the letta ctx object', async () => {
    const sidecar = fakeSidecar();
    const arm = createArmLetta({
      answerChat: async () => ({ text: 'a' }),
      runId: 'r',
      retrievalBudget: 5,
      letta: { sidecar, lettaVersion: '0.16.8', lettaClientVersion: '1.12.1' },
    });
    await arm.answer('q');
    expect(sidecar.calls.search[0].user_id).toBe('bench-p1-r');
    expect(sidecar.calls.search[0].limit).toBe(5);
    const row = await arm.answer('q2');
    expect(row.meta.letta_version).toBe('0.16.8');
    expect(row.meta.letta_client_version).toBe('1.12.1');
  });

  it('write() resumes from the checkpoint — committed sessions are never re-added', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-cp-'));
    try {
      const cp = path.join(dir, 'letta-sessions-q-9.json');
      fs.writeFileSync(cp, JSON.stringify({ question_id: 'q-9', sessions_done: 1 }) + '\n');
      const sidecar = fakeSidecar({ passageCount: 1 });
      const arm = createArmLetta({
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letta-cp-'));
    try {
      const refused = () => Promise.reject(new Error('letta sidecar unreachable (connect ECONNREFUSED)', { cause: { code: 'ECONNREFUSED' } }));
      const dead = { calls: { add: [], search: [] }, async request() { return refused(); }, async stop() {} };
      const alive = fakeSidecar({ passageCount: 1 });
      let restarts = 0;
      const arm = createArmLetta({
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
      expect(w.rows).toBe(2);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'letta-sessions-q-9.json'), 'utf8')).sessions_done).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a mid-response failure could have committed — fails loud, NEVER restarts', async () => {
    const timeouted = () => Promise.reject(new Error('aborted due to timeout', { cause: { code: 'UND_ERR_ABORTED' } }));
    const flaky = { calls: { add: [], search: [] }, async request() { return timeouted(); }, async stop() {} };
    const arm = createArmLetta({
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
    const arm = createArmLetta({
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

describe('letta sidecar manager — spawn / ready-line / boot gate / port-freed lifecycle', () => {
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

  // a child that speaks the sidecar protocol without letta: ready line, /health
  // (ok — the letta server under test answered), then exits on SIGTERM. It
  // closes its listener only ~300 ms AFTER exiting — stop() must poll the port
  // beyond the child's exit to call it freed.
  const FAKE_SIDECAR = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/health'
          ? { ok: true, pid: process.pid, letta_version: 'fake-0.16.8', letta_client_version: 'fake-1.12.1' }
          : { ok: true, agent_id: 'agent-fake', count: 1, results: [] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.stderr.write('LETTA_SIDECAR_READY ' + server.address().port + '\\n');
    });
    process.on('SIGTERM', () => {
      setTimeout(() => process.exit(0), 300);
    });
  `;

  // same child, but /health mirrors the REAL down-store shape: ok:false — the
  // letta server under test did not answer. start() must never boot this arm.
  const FAKE_SIDECAR_DOWN_STORE = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, pid: process.pid, error: 'letta server unreachable at letta-host:8283' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      process.stderr.write('LETTA_SIDECAR_READY ' + server.address().port + '\\n');
    });
    process.on('SIGTERM', () => process.exit(0));
  `;

  it('start(): learns the port from the ready line and polls /health; request() round-trips', async () => {
    const manager = createLettaSidecarManager({ command: [process.execPath, '-e', FAKE_SIDECAR], log: () => {} });
    const health = await manager.start();
    expect(health.ok).toBe(true);
    expect(health.letta_version).toBe('fake-0.16.8');
    expect(health.letta_client_version).toBe('fake-1.12.1');
    expect(manager.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await manager.request('/add', { user_id: 'u', messages: [] });
    expect(r.ok).toBe(true);
    expect(r.agent_id).toBe('agent-fake');
    const stop = await manager.stop();
    expect(stop).toMatchObject({ stopped: true, port_freed: true });
  }, 30000);

  it('a down letta server fails the BOOT gate: /health ok:false never starts the arm, and the sidecar is killed', async () => {
    // THE letta difference (vs mem0/zep): the store is REMOTE. A sidecar whose
    // letta server does not answer must not boot the run — and must not be
    // left alive holding its port after the failed boot.
    const manager = createLettaSidecarManager({
      command: [process.execPath, '-e', FAKE_SIDECAR_DOWN_STORE],
      startTimeoutMs: 1500,
      healthPollMs: 100,
      log: () => {},
    });
    await expect(manager.start()).rejects.toThrow(/is LETTA_SERVER_URL/);
    // the failed boot killed the child — stop() reaps it with the port freed
    // (nothing leaked). (already_dead may read false if the SIGKILL's exit
    // event is still in flight when stop() samples it — not worth a race here.)
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
    const manager = createLettaSidecarManager({
      command: [
        process.execPath,
        '-e',
        `process.stderr.write('LETTA_SIDECAR_READY ${port}' + String.fromCharCode(10)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`,
      ],
      portFreedTimeoutMs: 1500,
      log: () => {},
    });
    await manager.start(); // /health is served by the test's own listener
    await expect(manager.stop()).rejects.toThrow(/port \d+ is still accepting connections/);
    // the child is already dead at this point — nothing to clean up
  }, 30000);

  it('request() to a sidecar that has died fails loudly with the never-empty contract', async () => {
    const manager = createLettaSidecarManager({ command: [process.execPath, '-e', FAKE_SIDECAR], log: () => {} });
    await manager.start();
    process.kill(manager.pid, 'SIGKILL'); // the sidecar crashes mid-run
    await expect(manager.request('/search', {})).rejects.toThrow(/unreachable.*never with an empty answer/s);
    // the child is already dead — no stop() needed (calling it would re-signal a corpse)
  }, 30000);

  it('start() surfaces the child stderr when the sidecar dies before announcing', async () => {
    const manager = createLettaSidecarManager({
      command: [process.execPath, '-e', `process.stderr.write('letta-client not installed\\n'); process.exit(3);`],
      log: () => {},
    });
    await expect(manager.start()).rejects.toThrow(/exited before becoming ready[\s\S]*letta-client not installed/);
  }, 30000);
});

describe('letta env resolution — never a literal address', () => {
  const CONF =
    'MYCELIUM_URL=http://jetson01.local:3002\nBOX_3090_URL=http://DESKTOP-1UIQNIP:11434\nLETTA_SERVER_URL=http://letta.local:8283\n';
  const reader = () => CONF;

  it('LETTA_SERVER_URL from substrate.conf is the store; BOX_3090_URL becomes the /v1 LLM base; embedder derived from MYCELIUM_URL host', () => {
    const e = resolveLettaEnv({ env: {}, home: '/home', readFile: reader });
    expect(e.lettaServerUrl).toBe('http://letta.local:8283');
    expect(e.llmBaseUrl).toBe('http://DESKTOP-1UIQNIP:11434/v1');
    expect(e.llmModel).toBe('qwen3.8:27b');
    expect(e.embedderBaseUrl).toBe('http://jetson01.local:11434');
    expect(e.embedderModel).toBe('nomic-embed-text');
    expect(e.embedderDims).toBe(768);
  });

  it('env overrides win (LETTA_SERVER_URL, LETTA_LLM_BASE_URL, LETTA_EMBEDDER_BASE_URL, LETTA_EMBEDDER_DIMS)', () => {
    const e = resolveLettaEnv({
      env: {
        LETTA_SERVER_URL: 'http://env-letta:8283/',
        LETTA_LLM_BASE_URL: 'http://env-wins:9/v1',
        LETTA_EMBEDDER_BASE_URL: 'http://embed-wins:11434',
        LETTA_EMBEDDER_DIMS: '512',
      },
      home: '/home',
      readFile: reader,
    });
    expect(e.lettaServerUrl).toBe('http://env-letta:8283'); // trailing slash stripped
    expect(e.llmBaseUrl).toBe('http://env-wins:9/v1');
    expect(e.embedderBaseUrl).toBe('http://embed-wins:11434');
    expect(e.embedderDims).toBe(512);
  });

  it('no LETTA_SERVER_URL anywhere is a loud throw naming the postgres requirement — no hardcoded fallback', () => {
    expect(() => resolveLettaEnv({ env: {}, home: '/nonexistent', readFile: () => { throw new Error('no conf'); } })).toThrow(
      /PostgreSQL\+pgvector[\s\S]*never hardcodes an address/
    );
  });

  it('a letta server without an LLM endpoint is a loud throw too', () => {
    expect(() =>
      resolveLettaEnv({ env: { LETTA_SERVER_URL: 'http://letta.local:8283' }, home: '/nonexistent', readFile: () => { throw new Error('no conf'); } })
    ).toThrow(/no LLM endpoint[\s\S]*never hardcodes an address/);
  });
});

describe('sidecar python resolution + regime block + scope', () => {
  it('LETTA_SIDECAR_PYTHON env wins; the venv python next; else loud setup error', () => {
    expect(resolveSidecarPython({ env: { LETTA_SIDECAR_PYTHON: '/custom/python' } })).toBe('/custom/python');
    expect(resolveSidecarPython({ env: {}, exists: (p) => p.endsWith('.letta-venv/bin/python') })).toMatch(/\.letta-venv\/bin\/python$/);
    expect(() => resolveSidecarPython({ env: {}, exists: () => false })).toThrow(/letta-requirements\.txt/);
  });

  it('the regime gains a letta section only when the arm is in play', () => {
    const base = {
      dateUtc: 'd', git: { git_sha: 's', git_dirty: false }, harnessVersion: 'h',
      dataset: { name: 'n', file: 'f', sha256: 'x', licence: 'l', url: 'u', count: 1 },
      answerer: { model: 'm' }, judge: { model: 'j' },
      retrieval: { budget: 5 }, platform: {}, n: 1, notes: [],
    };
    const lettaStamp = {
      letta_version: '0.16.8',
      letta_version_matches: true,
      letta_client_version: '1.12.1',
      retrieval_budget: 5,
      scope: 'bench-p1-run',
      llm: { model: 'qwen3.8:27b', base_url_host: 'DESKTOP-1UIQNIP:11434' },
      embedder: { model: 'nomic-embed-text', base_url_host: 'jetson01.local:11434', dims: 768 },
      server: { url_host: 'letta.local:8283' },
      storage: 'letta server archival memory (external) — PostgreSQL+pgvector required',
      sidecar: 'http://127.0.0.1:65001',
    };
    const withLetta = buildRegime({ ...base, letta: lettaStamp });
    expect(withLetta.letta).toMatchObject({ letta_version: '0.16.8', retrieval_budget: 5 });
    const without = buildRegime(base);
    expect(without.letta).toBeUndefined();
  });

  it('lettaScope matches the other arms’ namespace granularity', () => {
    expect(lettaScope('2026-09-08-p1-x')).toBe('bench-p1-2026-09-08-p1-x');
  });
});

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  createArmMempalace,
  createMempalaceSidecarManager,
  mempalaceScope,
  mempalaceStateDir,
  resolveSidecarPython,
} from '../../bench/memory/arms/arm_mempalace.mjs';

const SESSIONS = [
  [
    { role: 'user', content: 'I am moving to Lisbon in the spring.' },
    { role: 'assistant', content: 'Lisbon is a great choice.' },
  ],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];

// mempalace's sidecar returns {ok, drawer_id, count} on /add (ONE verbatim
// drawer per session; count = the product's own chunk count) and
// {ok, results, count, candidates_fetched} on /search.
function fakeSidecar({ searchResults = [], chunkCount = 3, candidates = 12 } = {}) {
  const calls = { add: [], search: [] };
  return {
    calls,
    async request(pathname, body) {
      if (pathname === '/add') {
        calls.add.push(body);
        return { ok: true, drawer_id: `drawer_fake_${calls.add.length}`, count: chunkCount };
      }
      if (pathname === '/search') {
        calls.search.push(body);
        return { ok: true, count: searchResults.length, results: searchResults, candidates_fetched: candidates };
      }
      throw new Error(`fake sidecar: no route ${pathname}`);
    },
    async stop() {},
  };
}

// A socket factory that always refuses (ECONNREFUSED) — the port-freed poll's
// "freed" answer, without touching a real port.
function alwaysFreedConnect() {
  const sock = { on(_evt, fn) { queueMicrotask(() => fn(new Error('ECONNREFUSED'))); } };
  return () => sock;
}

describe('arm_mempalace — the MemPalace OSS CONTROL arm (task 263)', () => {
  it('write(): one POST per haystack session, scoped to the run, metadata carrying the question', async () => {
    const sidecar = fakeSidecar({ chunkCount: 3 });
    const arm = createArmMempalace({
      answerChat: async () => ({ text: 'x' }),
      runId: 'test-run',
      retrievalBudget: 5,
      sidecar,
    });
    const w = await arm.write(SESSIONS, { questionId: 'q-9' });
    expect(w).toEqual({ docs: 2, rows: 6 }); // docs = sessions; rows = drawer chunks the product committed
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

  it('write() rejects a non-array payload loudly (same contract as arm_mycelium/arm_letta)', async () => {
    const arm = createArmMempalace({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: fakeSidecar(),
    });
    await expect(arm.write('nope', { questionId: 'q' })).rejects.toThrow(/haystack_sessions/);
  });

  it('write() rejects a malformed turn loudly (never writes a silently-flattened row)', async () => {
    const sidecar = fakeSidecar();
    const arm = createArmMempalace({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar,
    });
    await expect(arm.write([[{ role: 'user' }]], { questionId: 'q' })).rejects.toThrow(/not \{role, content\} strings/);
    expect(sidecar.calls.add).toHaveLength(0); // nothing committed before the throw
  });

  it('refuses a factory call without a positive-int budget (the budget-drift gate)', () => {
    expect(
      () =>
        createArmMempalace({
          answerChat: async () => ({ text: 'x' }),
          runId: 'r',
          retrievalBudget: undefined,
          sidecar: fakeSidecar(),
        })
    ).toThrow(/retrievalBudget must be a positive int/);
    expect(
      () =>
        createArmMempalace({
          answerChat: async () => ({ text: 'x' }),
          runId: 'r',
          sidecar: fakeSidecar(),
        })
    ).toThrow(/retrievalBudget/);
  });

  it('refuses to run without a started sidecar (loud, before any write)', () => {
    expect(
      () =>
        createArmMempalace({
          answerChat: async () => ({ text: 'x' }),
          runId: 'r',
          retrievalBudget: 5,
        })
    ).toThrow(/requires a started sidecar/);
  });

  it('answer(): product search at the retrieval budget, then the shared answerer over the results', async () => {
    const sidecar = fakeSidecar({
      searchResults: [
        { memory: 'user: I am moving to Lisbon in the spring.', score: 0.42, id: 'drawer-1', session_index: 0 },
        { memory: 'user: My manager is Dana now.', score: 0.31, id: 'drawer-2', session_index: 1 },
      ],
      candidates: 20,
    });
    const chats = [];
    const arm = createArmMempalace({
      answerChat: async (args) => {
        chats.push(args);
        return { text: 'Lisbon.', hadThink: false };
      },
      runId: 'test-run',
      retrievalBudget: 7,
      sidecar,
      mempalaceVersion: '3.12.0',
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
      retrieval_mode: 'mempalace-oss-tool-search-vector',
      candidates_fetched: 20,
      mempalace_version: '3.12.0',
      budget: 7,
    });
    // task 207: every hit carries its provenance — drawer id, score, session
    expect(r.meta.read_hits).toEqual([
      { source_id: 'drawer-1', score: 0.42, session_index: 0, rank: 0 },
      { source_id: 'drawer-2', score: 0.31, session_index: 1, rank: 1 },
    ]);
  });

  it('answer(): empty retrieval still answers and stamps a TRUE zero (not an unavailable null)', async () => {
    const arm = createArmMempalace({
      answerChat: async () => ({ text: 'I do not know.', hadThink: false }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: fakeSidecar({ searchResults: [] }),
    });
    const r = await arm.answer('Which city am I moving to?');
    expect(r.text).toBe('I do not know.');
    expect(r.meta.hits).toBe(0);
    expect(r.meta.read_hits).toEqual([]); // a TRUE zero, not an unavailable stamp
    expect(r.meta.read_hits_available).toBe(true);
  });

  it('answer(): hits whose session provenance the product did not expose stamp null — never a guess', async () => {
    const arm = createArmMempalace({
      answerChat: async () => ({ text: 'x', hadThink: false }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: fakeSidecar({ searchResults: [{ memory: 'text', score: 0.5, id: 'd-1' }] }),
    });
    const r = await arm.answer('q');
    expect(r.meta.read_hits[0].session_index).toBeNull();
  });

  it('answer(): a sidecar error envelope is loud (a failed search is never a fake empty)', async () => {
    const arm = createArmMempalace({
      answerChat: async () => ({ text: 'x', hadThink: false }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: {
        async request() {
          return { ok: false, error: 'tool_search failed: no palace' };
        },
      },
    });
    await expect(arm.answer('q')).rejects.toThrow(/no palace/);
  });

  it('restart-on-ECONNREFUSED: the call replays on the new sidecar; a non-refused failure does not restart', async () => {
    const session = [[{ role: 'user', content: 'hello' }]];
    // dead sidecar: every request on the FIRST client dies with ECONNREFUSED;
    // restartSidecar hands back a live one. Nothing committed (refused = never
    // reached the sidecar), so the replay cannot duplicate.
    const dead = {
      async request() {
        const e = new Error('mempalace sidecar unreachable (connect ECONNREFUSED 127.0.0.1:1)');
        e.cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        throw e;
      },
    };
    const live = fakeSidecar({ chunkCount: 2 });
    let restarts = 0;
    const arm = createArmMempalace({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: dead,
      restartSidecar: async () => {
        restarts += 1;
        return live;
      },
    });
    const w = await arm.write(session, { questionId: 'q' });
    expect(restarts).toBe(1);
    expect(live.calls.add).toHaveLength(1); // replayed exactly once on the new sidecar
    expect(w.rows).toBe(2);

    // a TIMEOUT could have committed server-side — it must fail loudly, never restart-and-replay
    const slow = {
      async request() {
        const e = new Error('timed out');
        e.cause = Object.assign(new Error('request timed out'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
        throw e;
      },
    };
    const arm2 = createArmMempalace({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar: slow,
      restartSidecar: async () => live,
    });
    await expect(arm2.write(session, { questionId: 'q' })).rejects.toThrow(/timed out/);
    expect(live.calls.add).toHaveLength(1); // no extra add slipped in
  });

  describe('sidecar manager', () => {
    // A fake child with the surface the manager touches: stdout/stderr 'data'
    // streams, on/once for 'exit'/'error', and a kill() that flips
    // exitCode/signalCode and emits 'exit' — the parts stop() gates on.
    function fakeSpawn({ readyLine = 'MEMPALACE_SIDECAR_READY 4711', stderrText = null, exitAfterMs = null } = {}) {
      const listeners = {};
      const emit = (evt, ...args) => {
        for (const fn of listeners[evt] ?? []) fn(...args);
      };
      const child = {
        pid: 4242,
        exitCode: null,
        signalCode: null,
        emit,
        stdout: { on() {} },
        stderr: {
          on(_evt, fn) {
            const text = stderrText ?? (readyLine ? `${readyLine}\n` : '');
            if (text) queueMicrotask(() => fn(Buffer.from(text)));
          },
        },
        on(evt, fn) {
          (listeners[evt] ??= []).push(fn);
          return child;
        },
        once(evt, fn) {
          const wrap = (...args) => {
            fn(...args);
            listeners[evt] = (listeners[evt] ?? []).filter((f) => f !== wrap);
          };
          (listeners[evt] ??= []).push(wrap);
          return child;
        },
        kill(sig) {
          if (child.exitCode !== null || child.signalCode !== null) return true; // already dead
          if (sig === 'SIGKILL') {
            child.signalCode = 'SIGKILL';
          } else {
            child.exitCode = 0;
          }
          queueMicrotask(() => emit('exit', child.exitCode, child.signalCode));
          return true;
        },
      };
      const spawned = { argv: null, child };
      spawned.fn = (exe, args) => {
        spawned.argv = [exe, ...args];
        if (exitAfterMs !== null) {
          setTimeout(() => {
            child.exitCode = 1;
            emit('exit', 1, null);
          }, exitAfterMs);
        }
        return child;
      };
      return spawned;
    }

    it('learns the port from the ready line and builds the base URL', async () => {
      const s = fakeSpawn();
      const mgr = createMempalaceSidecarManager({
        command: ['py', 'script.py'],
        spawnFn: s.fn,
        connectFn: alwaysFreedConnect(),
        fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, pid: 4242 }) }),
      });
      const health = await mgr.start();
      expect(s.argv).toEqual(['py', 'script.py']);
      expect(health.baseUrl).toBe('http://127.0.0.1:4711');
      expect(mgr.port).toBe(4711);
      await mgr.stop();
      expect(mgr.port).toBe(4711); // baseUrl/port stay readable after stop
    });

    it('a child that dies before the ready line fails loudly with the stderr tail', async () => {
      const s = fakeSpawn({ readyLine: null, stderrText: 'ModuleNotFoundError: no mempalace\n', exitAfterMs: 5 });
      const mgr = createMempalaceSidecarManager({ command: ['py', 'script.py'], spawnFn: s.fn });
      await expect(mgr.start()).rejects.toThrow(/exited before becoming ready[\s\S]*ModuleNotFoundError/);
    });

    it('a failed /health fetch keeps polling; ok:true wins', async () => {
      const s = fakeSpawn();
      let polls = 0;
      const mgr = createMempalaceSidecarManager({
        command: ['py', 'script.py'],
        spawnFn: s.fn,
        healthPollMs: 1,
        connectFn: alwaysFreedConnect(),
        fetchImpl: async () => {
          polls += 1;
          if (polls < 3) throw new Error('ECONNREFUSED');
          return { ok: true, json: async () => ({ ok: true, pid: 1 }) };
        },
      });
      const health = await mgr.start();
      expect(health.ok).toBe(true);
      expect(polls).toBe(3);
      await mgr.stop();
    });
  });

  describe('naming + paths', () => {
    it('scope + state dir follow the run id; python resolution: env override wins, missing venv is a loud setup error', () => {
      expect(mempalaceScope('2026-10-29-p1-1')).toBe('bench-p1-2026-10-29-p1-1');
      expect(mempalaceStateDir('r1', '/tmp')).toBe(path.join('/tmp', 'mempalace-bench-r1'));
      expect(resolveSidecarPython({ env: { MEMPALACE_SIDECAR_PYTHON: '/x/py' }, exists: () => false })).toBe('/x/py');
      expect(() => resolveSidecarPython({ env: {}, exists: () => false })).toThrow(/setup_mempalace_venv\.sh/);
    });
  });
});

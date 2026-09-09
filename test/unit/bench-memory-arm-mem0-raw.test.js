import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArmMem0, mem0Scope } from '../../bench/memory/arms/arm_mem0.mjs';
import { createArmMem0Raw, mem0RawScope } from '../../bench/memory/arms/arm_mem0_raw.mjs';

const SESSIONS = [
  [
    { role: 'user', content: 'I am moving to Lisbon in the spring.' },
    { role: 'assistant', content: 'Lisbon is a great choice.' },
  ],
  [{ role: 'user', content: 'My manager is Dana now.' }],
];

function fakeSidecar({ addCount = 1, searchResults = [] } = {}) {
  const calls = { add: [], search: [] };
  return {
    calls,
    async request(pathname, body) {
      if (pathname === '/add') {
        calls.add.push(body);
        return { ok: true, results: [], count: addCount };
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

describe('arm_mem0_raw — the raw-ingestion control arm (task 182)', () => {
  it('write(): one POST per session with infer:false — no extraction LLM, raw turns stored', async () => {
    const sidecar = fakeSidecar({ addCount: 2 }); // raw = one memory per non-system turn
    const arm = createArmMem0Raw({
      answerChat: async () => ({ text: 'x' }),
      runId: 'test-run',
      retrievalBudget: 5,
      sidecar,
    });
    const w = await arm.write(SESSIONS, { questionId: 'q-9' });
    expect(arm.name).toBe('mem0-raw');
    expect(sidecar.calls.add).toHaveLength(2);
    for (const body of sidecar.calls.add) {
      expect(body.infer).toBe(false); // THE control: extraction off, per request
      expect(body.metadata.ingestion).toBe('raw');
    }
    expect(sidecar.calls.add[0].messages[0]).toEqual({ role: 'user', content: 'I am moving to Lisbon in the spring.' });
    expect(w).toEqual({ docs: 2, rows: 4 });
  });

  it('scope: suffixed -raw so two mem0-family arms in one run never see each other', async () => {
    const sidecar = fakeSidecar({ searchResults: [{ memory: 'raw row', score: 0.5 }] });
    const arm = createArmMem0Raw({
      answerChat: async () => ({ text: 'a' }),
      runId: 'r1',
      retrievalBudget: 5,
      sidecar,
    });
    await arm.answer('q');
    expect(sidecar.calls.search[0].user_id).toBe('bench-p1-r1-raw');
    expect(sidecar.calls.search[0].limit).toBe(5);
    expect(mem0RawScope('r1')).toBe(`${mem0Scope('r1')}-raw`);
  });

  it('the control identity is NOT caller-overridable', async () => {
    const sidecar = fakeSidecar();
    const arm = createArmMem0Raw({
      answerChat: async () => ({ text: 'x' }),
      runId: 'r',
      retrievalBudget: 5,
      sidecar,
      name: 'mem0', // an attempt to masquerade as the extract arm
      infer: true, // an attempt to re-enable extraction
      scope: 'bench-p1-r',
    });
    await arm.write(SESSIONS, { questionId: 'q' });
    expect(arm.name).toBe('mem0-raw');
    expect(sidecar.calls.add[0].infer).toBe(false);
    expect(sidecar.calls.add[0].user_id).toBe('bench-p1-r-raw');
  });

  it('resume checkpoints are named per arm — the raw arm never reads the extract arm’s progress', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-raw-cp-'));
    try {
      // the mem0 (extract) arm already committed session 0 of this question
      fs.writeFileSync(path.join(dir, 'mem0-sessions-q-9.json'), JSON.stringify({ question_id: 'q-9', sessions_done: 1 }) + '\n');
      const sidecar = fakeSidecar({ addCount: 1 });
      const arm = createArmMem0Raw({
        answerChat: async () => ({ text: 'x' }),
        runId: 'r',
        retrievalBudget: 5,
        sidecar,
        resumeDir: dir,
      });
      const w = await arm.write(SESSIONS, { questionId: 'q-9' });
      expect(sidecar.calls.add).toHaveLength(2); // NOT skipped — mem0's checkpoint is not its own
      expect(w.docs).toBe(2);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'mem0-raw-sessions-q-9.json'), 'utf8'))).toEqual({
        question_id: 'q-9',
        sessions_done: 2,
      });
      // and the extract arm's own checkpoint file is untouched
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'mem0-sessions-q-9.json'), 'utf8')).sessions_done).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the extract arm (mem0) now passes infer:true explicitly and keeps its historical scope + checkpoint name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem0-extract-cp-'));
    try {
      const sidecar = fakeSidecar({ addCount: 3 });
      const arm = createArmMem0({
        answerChat: async () => ({ text: 'x' }),
        runId: 'r',
        retrievalBudget: 5,
        sidecar,
        resumeDir: dir,
      });
      await arm.write(SESSIONS, { questionId: 'q-9' });
      expect(arm.name).toBe('mem0');
      expect(sidecar.calls.add[0].infer).toBe(true);
      expect(sidecar.calls.add[0].user_id).toBe('bench-p1-r');
      expect(sidecar.calls.add[0].metadata.ingestion).toBe('extract');
      expect(fs.existsSync(path.join(dir, 'mem0-sessions-q-9.json'))).toBe(true); // historical filename
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answer(): the RAG prompt + meta carry the raw ingestion marker', async () => {
    const sidecar = fakeSidecar({ searchResults: [{ memory: 'raw row', score: 0.5 }] });
    const users = [];
    const arm = createArmMem0Raw({
      answerChat: async (args) => {
        users.push(args);
        return { text: 'a' };
      },
      runId: 'r',
      retrievalBudget: 5,
      sidecar,
    });
    const r = await arm.answer('q');
    expect(users[0].system).toContain('long-term memory store'); // same RAG prompt as every arm
    expect(r.meta).toMatchObject({ hits: 1, ingestion: 'raw', retrieval_mode: 'mem0-oss-local-vector' });
  });

  it('refuses to exist without a started sidecar / with a bad budget (inherited contract)', () => {
    expect(() => createArmMem0Raw({ answerChat: async () => ({}), runId: 'r', retrievalBudget: 5 })).toThrow(/started sidecar/);
    expect(() =>
      createArmMem0Raw({ answerChat: async () => ({}), runId: 'r', retrievalBudget: 0, sidecar: fakeSidecar() })
    ).toThrow(/retrievalBudget must be a positive int/);
    expect(() => createArmMem0Raw({ answerChat: async () => ({}), retrievalBudget: 5, sidecar: fakeSidecar() })).toThrow(/runId/);
  });
});

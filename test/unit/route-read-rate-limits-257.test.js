// Task 257 — CodeQL js/missing-rate-limiting alerts #286–#294: nine memory
// read/drone-write routes rode NO limiter at all (the #190 batch covered the
// write/recall core; these reads and the embeddings callback predate it).
// Each now rides server/lib/rate-limit.js — the same express-rate-limit
// builder, per-IP in-memory buckets, MYCELIUM_RATE_LIMIT=off still the
// operator kill-switch.
//
// THE CEILINGS reuse #190's measured classes (the helper's rule: measured, not
// invented — these are the recall-class reads of routes whose ceilings #190
// already set from jetson01 route_usage, so they inherit the number of the
// route they complement, not a new vibe):
//   GET /memory/list, /episodes, /lessons, /history   1200/min  = /memory/search
//   GET /memory/stats                                  120/min  house floor — a
//                                                               console read, never a loop
//   GET /memory/coverage                              1200/min  the bench's embed wait
//                                                               POLLS this route
//   PUT /memory/embeddings/:type/:id                  1200/min  per-row drone write —
//                                                               the index path's row/min class
//   GET /auto-memory/facts                            2400/min  = its POST sibling: the
//                                                               bench reads what it wrote
//   GET /auto-memory/facts/:id                        1200/min  single-row recall read
//
// Same discipline as trust-layer-rate-limits.test.js: each test fills its
// route's bucket to just under the ceiling (asserting nothing 429'd — normal
// use is unchanged), then fires past the ceiling and asserts the 429 naming
// the limiter. This file runs in its own vitest fork; MYCELIUM_RATE_LIMIT is
// deliberately left unset here — the limiters are the subject.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const ADMIN_KEY = 'task257-rl-admin-key-0123456789abcdef';
const JWT_SECRET = 'task257-rl-jwt-secret';
const AGENT_KEY = 'dvk_' + 'd'.repeat(48);

let tmpDataDir;
let db;
let app;

async function burst(n, make) {
  let limited = 0;
  const CHUNK = 64;
  for (let start = 0; start < n; start += CHUNK) {
    const responses = await Promise.all(
      Array.from({ length: Math.min(CHUNK, n - start) }, (_, i) => make(start + i))
    );
    for (const r of responses) {
      if (r.status === 429) limited++;
      else if (r.status !== 200) {
        throw new Error('fill request answered ' + r.status + ' (expected 200) text=' +
          JSON.stringify((r.text || '').slice(0, 300)));
      }
    }
  }
  return limited;
}

function expectCeiling(name, max, makeRequests) {
  return async () => {
    // One held port per test — same instrument as the trust-layer suite (a
    // fresh listen(0) per request can have its port stolen mid-fill under
    // load, which reads as a phantom auth failure).
    const server = app.listen(0);
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const makeRequest = makeRequests(base);
    try {
      const overTheCeiling = await burst(max, makeRequest);
      expect(overTheCeiling).toBe(0); // the ceiling itself is never a 429
      let saw = null;
      for (let i = 1; i <= 5 && !saw; i++) {
        const r = await makeRequest(max + i);
        if (r.status === 429) saw = r;
      }
      expect(saw, 'no 429 within five requests past the ceiling').toBeTruthy();
      expect(saw.body.error).toContain('Too many requests (' + name + ')');
    } finally {
      server.close();
    }
  };
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-task257-rl-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = JWT_SECRET;

  db = await import('../../server/db.js');
  db.initDB();

  const routes = (await import('../../server/routes/mycelium.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/mycelium', routes);
  const { initPlugins } = await import('../../server/routes/mycelium.js');
  await initPlugins(app);

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex');
  db.createAgent('lucy-rl257', 'Lucy RL257', 'trust-proj', hash, '["code"]');

  // The embeddings fill PUTs a vector onto a row THIS agent wrote (write
  // authority: an agent key stores a vector only on its own row) — seed it
  // once here, under the ceiling, through the real write path.
  const seeded = await request(app).post('/api/mycelium/memory/index').set({ 'X-Agent-Key': AGENT_KEY })
    .send({ source_type: 'rl-embed-probe', source_id: 'embed-target', content_text: 'vector target row' });
  expect(seeded.status).toBe(200);

  // The /facts/:id fill GETs a real fact — create one the same way.
  const fact = await request(app).post('/api/mycelium/auto-memory/facts').set({ 'X-Agent-Key': AGENT_KEY })
    .send({ fact_text: 'task 257 limiter probe fact for the single-row read' });
  expect(fact.status).toBe(200);
  expect(fact.body.id).toBeTruthy();
  globalThis.__task257FactId = fact.body.id;
});

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('task 257 — the nine read/drone-write routes answer 429 one past their ceiling', () => {
  const agent = { 'X-Agent-Key': AGENT_KEY };
  const EMBEDDING = [0.1, 0.2, 0.3];

  it('GET /memory/list holds 1200/min',
    expectCeiling('memory/list', 1200, (base) => () =>
      request(base).get('/api/mycelium/memory/list?source_type=rl-list-probe').set(agent)), 60000);

  it('GET /memory/episodes holds 1200/min',
    expectCeiling('memory/episodes', 1200, (base) => () =>
      request(base).get('/api/mycelium/memory/episodes').set(agent)), 60000);

  it('GET /memory/lessons holds 1200/min',
    expectCeiling('memory/lessons', 1200, (base) => () =>
      request(base).get('/api/mycelium/memory/lessons').set(agent)), 60000);

  it('GET /memory/history holds 1200/min',
    expectCeiling('memory/history', 1200, (base) => () =>
      request(base).get('/api/mycelium/memory/history').set(agent)), 60000);

  it('GET /memory/stats holds 120/min',
    expectCeiling('memory/stats', 120, (base) => () =>
      request(base).get('/api/mycelium/memory/stats').set(agent)), 60000);

  it('GET /memory/coverage holds 1200/min',
    expectCeiling('memory/coverage', 1200, (base) => () =>
      request(base).get('/api/mycelium/memory/coverage').set(agent)), 60000);

  it('PUT /memory/embeddings/:type/:id holds 1200/min',
    expectCeiling('memory/embeddings', 1200, (base) => () =>
      request(base).put('/api/mycelium/memory/embeddings/rl-embed-probe/embed-target').set(agent)
        .send({ embedding: EMBEDDING, model: 'task257-probe' })), 60000);

  it('GET /auto-memory/facts holds 2400/min',
    expectCeiling('auto-memory/facts-list', 2400, (base) => () =>
      request(base).get('/api/mycelium/auto-memory/facts').set(agent)), 60000);

  it('GET /auto-memory/facts/:id holds 1200/min',
    expectCeiling('auto-memory/fact', 1200, (base) => (i) =>
      request(base).get('/api/mycelium/auto-memory/facts/' + globalThis.__task257FactId + '?probe=' + i)
        .set(agent)), 60000);
});

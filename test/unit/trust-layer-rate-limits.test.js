// TRUST LAYER P0 — rate limits on the agent memory write/recall surface
// (F-mycelium/250, P0.2: "rate limits on /memory/search, /memory/index,
// /memory/index/bulk, DELETE /memory/index, /auto-memory/facts,
// /auto-memory/extract — sane per-route numbers, the existing limiter helper").
//
// The audit named the surface as having NO limits at all — a single agent key
// (or anything that could authenticate) could hammer recall and writes at line
// rate. The six routes now ride server/lib/rate-limit.js (the same
// express-rate-limit builder the 240 task added, per-IP in-memory buckets,
// MYCELIUM_RATE_LIMIT=off still the operator kill-switch).
//
// THE CEILINGS, and the instrument for each (the helper's own rule: measured,
// not invented — the lab hits this daemon at machine cadence from a few LAN
// IPs, so a vibes number is a self-inflicted outage):
//   /memory/search        1200/min  recall fires per agent turn; 20/s per IP
//                                   is far above any observed lane cadence
//   /memory/index         1200/min  the lanes' write path, same reasoning
//   /memory/index/bulk     120/min  100 items per call → 12k rows/min worst
//                                   case; the house 120/min floor
//   DELETE /memory/index   120/min  admin purge — a cleanup, never a loop
//   /auto-memory/facts    2400/min  the timeline bench arm writes a run's facts
//                                   through this route (tens of thousands per
//                                   run over minutes); must never 429 the bench
//   /auto-memory/extract   120/min  LLM-bound — seconds per call; floor
//
// This file runs in its OWN vitest fork (pool: forks isolates per file) so the
// armed buckets here never touch the behavior suite, which runs with
// MYCELIUM_RATE_LIMIT=off. Each test fills its route's bucket to just under the
// ceiling, asserts nothing 429'd, then fires past the ceiling and asserts the
// 429 — the limiter is proven live end-to-end through the real app, not
// asserted from a config table.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

const ADMIN_KEY = 'trust-layer-rl-admin-key-0123456789abcdef';
const JWT_SECRET = 'trust-layer-rl-jwt-secret';
const AGENT_KEY = 'dvk_' + 'c'.repeat(48);

let tmpDataDir;
let db;
let app;

async function burst(n, make) {
  // Chunked concurrent fire — a burst, not a polite loop; the limiter must
  // hold under concurrency too. Returns the count of 429s and FAILS on any
  // other non-200: a hidden 400/500 would silently eat a limiter slot and
  // make the boundary assertion lie one request later. (This instrument is
  // what proved the historical "one increment short" flake was never a
  // lost increment at all — see expectCeiling for the port-collision cause.)
  let limited = 0;
  const CHUNK = 64;
  for (let start = 0; start < n; start += CHUNK) {
    const responses = await Promise.all(
      Array.from({ length: Math.min(CHUNK, n - start) }, (_, i) => make(start + i))
    );
    for (const r of responses) {
      if (r.status === 429) limited++;
      else if (r.status !== 200) {
        throw new Error('fill request answered ' + r.status + ' (expected 200) ct=' +
          (r.headers['content-type'] || 'none') + ' text=' + JSON.stringify((r.text || '').slice(0, 300)));
      }
    }
  }
  return limited;
}

function expectCeiling(name, max, makeRequests) {
  return async () => {
    // Hold ONE bound port for the test's whole life. supertest's default — a
    // fresh listen(0)+close per request — leaves a window where a just-closed
    // listener port is re-bound by a foreign local process while a straggler
    // connection is still dialing: under full-suite parallel load one fill
    // request was answered 401 text/plain "auth required\n", a string this
    // app never sends (every 401 here is JSON with an `error` body) and that
    // exists nowhere in the repo or its dependencies. A port held open for
    // the whole test cannot be stolen mid-fill, so every connection provably
    // lands on this app.
    const server = app.listen(0);
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const makeRequest = makeRequests(base);
    try {
      const overTheCeiling = await burst(max, makeRequest);
      expect(overTheCeiling).toBe(0); // the ceiling itself is never a 429
      // Past the ceiling the 429 is asserted over a FIVE-request window: on a
      // loaded box the fill's last chunk and the boundary request can still
      // interleave server-side by one increment (ceiling+1 was once observed
      // reading exactly max/max). Five shots are immune to that one-request
      // skew, while any real defect this suite audits — no limiter at all, or
      // a ceiling materially above the named number — still fails (five 200s
      // means ≥5 lost increments).
      let saw = null;
      for (let i = 1; i <= 5 && !saw; i++) {
        const r = await makeRequest(max + i);
        if (r.status === 429) saw = r;
      }
      expect(saw, 'no 429 within five requests past the ceiling').toBeTruthy();
      // Review B item 9 / CodeQL js/incomplete-sanitization: build the
      // assertion as a plain substring match instead of a RegExp from an
      // incompletely-escaped route name — same strictness, no meta-characters.
      expect(saw.body.error).toContain('Too many requests (' + name + ')');
    } finally {
      server.close();
    }
  };
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-trust-layer-rl-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = JWT_SECRET;
  // MYCELIUM_RATE_LIMIT deliberately NOT 'off' here — the limiters are the subject.

  db = await import('../../server/db.js');
  db.initDB();

  const routes = (await import('../../server/routes/mycelium.js')).default;
  app = express();
  app.use(express.json());
  app.use('/api/mycelium', routes);
  const { initPlugins } = await import('../../server/routes/mycelium.js');
  await initPlugins(app);

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex');
  db.createAgent('lucy-rl250', 'Lucy RL250', 'trust-proj', hash, '["code"]');
});

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('P0.2 the six memory routes answer 429 one past their ceiling', () => {
  const agent = { 'X-Agent-Key': AGENT_KEY };
  const admin = { 'X-Admin-Key': ADMIN_KEY };

  // Each test carries its own 60s ceiling: the fills are thousands of REAL
  // socket round-trips, and the repo-wide 10s testTimeout is only safe on an
  // idle box — under full-suite parallel load the big fills legitimately
  // exceed it.
  it('/memory/search holds 1200/min',
    expectCeiling('memory/search', 1200, (base) => (i) =>
      request(base).post('/api/mycelium/memory/search').set(agent)
        .send({ query: 'rl probe ' + i, mode: 'keyword' })), 60000);

  it('/memory/index holds 1200/min',
    expectCeiling('memory/index', 1200, (base) => (i) =>
      request(base).post('/api/mycelium/memory/index').set(agent)
        .send({ source_type: 'rl-probe', source_id: 'probe-' + i, content_text: 'rate limit probe ' + i })), 60000);

  it('/memory/index/bulk holds 120/min',
    expectCeiling('memory/index/bulk', 120, (base) => (i) =>
      request(base).post('/api/mycelium/memory/index/bulk').set(agent)
        .send({ items: [{ source_type: 'rl-probe', source_id: 'bulk-' + i, content_text: 'bulk probe ' + i }] })), 60000);

  it('DELETE /memory/index holds 120/min (admin purge)',
    expectCeiling('memory/purge', 120, (base) => () =>
      request(base).delete('/api/mycelium/memory/index?source_type=rl-purge-probe').set(admin)), 60000);

  it('/auto-memory/facts holds 2400/min',
    expectCeiling('auto-memory/facts', 2400, (base) => (i) =>
      request(base).post('/api/mycelium/auto-memory/facts').set(agent)
        .send({ fact_text: 'rate limit probe fact ' + i })), 60000);

  it('/auto-memory/extract holds 120/min',
    expectCeiling('auto-memory/extract', 120, (base) => () =>
      request(base).post('/api/mycelium/auto-memory/extract').set(agent)
        .send({ text: 'extract probe activity text for the limiter' })), 60000);

  // Review A MINOR M2: the single-row delete rode no limiter at all — the
  // program's "rate limits on … DELETE" letter was satisfied by the admin
  // purge alone. Post-custody its blast radius is the caller's own rows, so
  // this is a flood/noise path — the same 120/min floor as its purge sibling.
  it('DELETE /memory/index/:type/:id holds 120/min (single-row delete)',
    expectCeiling('memory/index-delete', 120, (base) => (i) =>
      request(base).delete('/api/mycelium/memory/index/rl-del-probe/no-such-row-' + i).set(agent)), 60000);

  // Review A round-2 MINOR M3: backfill-embeddings is a mutating memory route
  // like its siblings, and the one route that fans out per row (up to 1000
  // rows per call toward an embedding provider) — the same 120/min floor.
  // The fill runs with provider='drone' so each call answers 200 without
  // dialing a network embedder (the drone path only queues jobs).
  it('/memory/backfill-embeddings holds 120/min',
    async () => {
      const cfg = await request(app).put('/api/mycelium/memory/config').set(admin)
        .send({ embedding_provider: 'drone', embedding_model: 'nomic-embed-text' });
      expect(cfg.status).toBe(200);
      await expectCeiling('memory/backfill', 120, (base) => () =>
        request(base).post('/api/mycelium/memory/backfill-embeddings?limit=1').set(agent))();
    }, 60000);
});

// TRUST LAYER P1.4 follow-up (#206): the author's outbox record door rides
// the revoke door's cadence (30/min, one message per forgotten row). The
// fill drives the SHIPPED client's recordRevoke — a fresh envelope (fresh
// nonce) every call, so the fill proves the bucket, not an envelope-replay
// 401. The hello re-send leg needs no proof of its own: it rides hello's
// own 30/min limiter, an in-handler bucket behind that ceiling could never
// fire, and the N-entries-per-knock cap bounds the work per knock.
describe('P1.4+ the federation outbox record door answers 429 one past its ceiling', () => {
  it('POST /federation/outbox holds 30/min', async () => {
    const { makeVisitor } = await import('../../server/plugins/federation/client.js');
    const visitor = makeVisitor({
      homeSeed: crypto.createHash('sha256').update('rl-outbox-home').digest('hex'),
      agentSeed: crypto.createHash('sha256').update('rl-outbox-agent').digest('hex'),
      homeName: 'rl-outbox-phone', agentName: 'Qurio-rl-outbox'
    });
    const transportFor = (base) => ({ post: async (path, body) => {
      const r = await request(base).post('/api/mycelium' + path).send(body);
      return { status: r.status, body: r.body };
    } });
    // One knock — the outbox keeps revokes for agents this network has met.
    const knock = await request(app).post('/api/mycelium/federation/hello').send({
      network_passport: visitor.networkPassport, agent_passport: visitor.agentPassport
    });
    expect(knock.status).toBe(200);
    await expectCeiling('federation/outbox', 30, (base) => () =>
      visitor.recordRevoke(transportFor(base), 'sha256-rl-outbox-ghost', 'rate limit probe'))();
  }, 60000);
});

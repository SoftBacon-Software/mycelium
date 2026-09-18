// Task 227 — unchanged content keeps its embedding (the 2026-09-18 wedge cause)
//
// 02:23–03:15 CDT the Jetson platform wedged three times in one night (node R at
// 100% CPU, :3002 accept queue 124, the runner saw 811s down). The standing
// cause: db.js index() re-indexes IDENTICAL content with no embedding in the
// request as `embedding = excluded.embedding` — resetting every stored vector
// to NULL and re-queueing the row — so the Mac's half-hourly memory backfill
// cost the lab ~2k re-embeds per tick, forever. The client half (index_memory_md.py
// posting only changed files) landed separately; THIS pins the platform half:
//
//   1. re-indexing identical content is a BYTE-IDENTICAL no-op: embedding,
//      embedding_model and updated_at keep their exact stored values (an
//      updated_at SENTINEL proves no write happened at all — datetime('now')
//      has second resolution, so an equality check alone could pass vacuously),
//      the vector cache hears ZERO upserts;
//   2. a no-op with a never-embedded row is also a no-op — the drains (219/213)
//      own genuinely-NULL rows, the tick does not churn them;
//   3. CHANGED content still resets the embedding and still fires the cache
//      upsert (stale vectors are worse than missing ones);
//   4. a metadata-only change updates metadata, KEEPS the embedding;
//   5. identical content carrying a NEW embedding still refreshes the vector
//      (the CASE's ELSE branch);
//   6. the bulk route answers the split {ok, indexed, rows, unchanged} so a
//      client can see its churn;
//   7. a 100-item bulk of unchanged docs touches NEITHER the embed queue
//      (queued_high/queued_low identical via GET /memory/stats) NOR the
//      embedder itself (a live mock ollama records ZERO HTTP embed calls);
//   8. changed items still enqueue — the fix must not mute real work — and
//      POST /memory/index (single) skips the auto-embed for an unchanged doc
//      too.
//
// Hermetic: in-memory better-sqlite3 with the plugin schema, the plugin's own
// router mounted the way plugins.js mounts it, and a local mock ollama
// (/api/embed, one recorded hit per HTTP call) as the embedding provider.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createMemoryRoutes from '../../server/plugins/semantic-memory/routes.js';
import createMemoryDB from '../../server/plugins/semantic-memory/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const smSchema = fs.readFileSync(path.join(here, '../../server/plugins/semantic-memory/schema.sql'), 'utf8');

// Mirrors auto-memory-amfacts-bulk.test.js's makeCore — the pieces the
// semantic-memory router destructures off pluginCore.
function makeCore(db) {
  return {
    db,
    auth: {
      checkAgentOrAdmin(req, res) {
        if (req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        return 'tester';
      },
      checkAdmin(req, res) {
        if (req.headers['x-test-admin']) return 'tester';
        res.status(401).json({ error: 'Authentication required' });
        return false;
      },
      getAdminDisplayName() { return 'tester'; },
    },
    apiError(res, status, message, extra) { return res.status(status).json(Object.assign({ error: message }, extra || {})); },
    parseIntParam(val) { const n = parseInt(val, 10); return isNaN(n) ? null : n; },
    asyncHandler(fn) {
      return function (req, res, next) { Promise.resolve(fn(req, res, next)).catch(next); };
    },
    emitEvent() {},
    onEvent() {},
    gatedActions: [],
    inbox: {},
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// A mock ollama: answers POST /api/embed with one 3-float vector per input
// text and records ONE hit per HTTP call (with the input size), so a test can
// assert the embedder itself heard nothing. Instant, local, deterministic.
async function startMockEmbedder() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(body).input || []; } catch { input = []; }
      const texts = Array.isArray(input) ? input : [input];
      hits.push(texts.length);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: texts.map((t) => [String(t).length * 0.001, 0.2, 0.3]) }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    hits,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

let ctx;
let embedder;
afterEach(async () => {
  if (embedder) { await embedder.close(); embedder = undefined; }
  if (ctx) { await ctx.close(); ctx = undefined; }
});

async function boot() {
  const db = new Database(':memory:');
  db.exec(smSchema);
  const core = makeCore(db);
  const app = express();
  app.use(express.json());
  app.use('/api/mycelium/memory', createMemoryRoutes(core));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}/api/mycelium/memory`;
  return {
    db,
    sm: createMemoryDB(db),
    base,
    close: () => new Promise((r) => server.close(r)),
  };
}

async function postBulk(items) {
  const res = await fetch(`${ctx.base}/index/bulk`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
  });
  return { status: res.status, json: await res.json() };
}

async function postIndex(body) {
  const res = await fetch(`${ctx.base}/index`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getStats() {
  const res = await fetch(`${ctx.base}/stats`);
  return res.json();
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const rowOf = (db, id) => db.prepare('SELECT * FROM sm_embeddings WHERE source_id = ?').get(id);
// Second-resolution immunity: stamp a sentinel so "updated_at moved" and
// "updated_at kept" are both decidable no matter when the test runs.
const SENTINEL = '2000-01-01 00:00:00';
const stampSentinel = (db, id) =>
  db.prepare('UPDATE sm_embeddings SET updated_at = ? WHERE source_id = ?').run(SENTINEL, id);

// Wrap the live vector cache with a recording counter. In the db-level suites
// exactly one createMemoryDB owns the raw db, so db.__myceliumVectorCache IS
// the cache that wrapper reads through.
function countUpserts(db) {
  const cache = db.__myceliumVectorCache;
  const calls = [];
  const orig = cache.onUpsert;
  cache.onUpsert = function (t, id, ci) { calls.push(t + ':' + id + ':' + ci); return orig.call(cache, t, id, ci); };
  return calls;
}

describe('db.index — unchanged content is a byte-identical no-op', () => {
  it('re-indexing identical content keeps embedding, model and updated_at byte-identical and fires zero cache upserts', () => {
    const db = new Database(':memory:');
    db.exec(smSchema);
    const mem = createMemoryDB(db);

    mem.index('agent_memory', 'doc-1', 'The Lisbon lease renewal is in June.', {
      namespace: 'memories', metadata: { project_id: 'p1' },
      embedding: JSON.stringify([0.1, 0.2, 0.3]), embedding_model: 'model-a',
    });
    stampSentinel(db, 'doc-1');
    const upserts = countUpserts(db);

    const res = mem.index('agent_memory', 'doc-1', 'The Lisbon lease renewal is in June.', {
      namespace: 'memories', metadata: { project_id: 'p1' },
    });
    const after = rowOf(db, 'doc-1');

    expect(res.unchanged).toBe(true);
    expect(after.embedding).toBe(JSON.stringify([0.1, 0.2, 0.3]));
    expect(after.embedding_model).toBe('model-a');
    expect(after.updated_at).toBe(SENTINEL); // no write happened at all
    expect(upserts).toEqual([]);             // and the cache heard nothing
  });

  it('a never-embedded row re-indexed identically is also a no-op — the drains own NULL rows, the tick does not churn them', () => {
    const db = new Database(':memory:');
    db.exec(smSchema);
    const mem = createMemoryDB(db);

    mem.index('agent_memory', 'doc-2', 'Body text without a vector yet.', { namespace: 'memories' });
    stampSentinel(db, 'doc-2');
    const upserts = countUpserts(db);

    const res = mem.index('agent_memory', 'doc-2', 'Body text without a vector yet.', { namespace: 'memories' });

    expect(res.unchanged).toBe(true);
    expect(rowOf(db, 'doc-2').updated_at).toBe(SENTINEL);
    expect(upserts).toEqual([]);
  });

  it('changed content still resets the embedding and still fires the cache upsert', () => {
    const db = new Database(':memory:');
    db.exec(smSchema);
    const mem = createMemoryDB(db);

    mem.index('agent_memory', 'doc-3', 'Version one of the note.', {
      namespace: 'memories', embedding: JSON.stringify([0.1, 0.2, 0.3]), embedding_model: 'model-a',
    });
    stampSentinel(db, 'doc-3');
    const upserts = countUpserts(db);

    const res = mem.index('agent_memory', 'doc-3', 'Version two of the note.', { namespace: 'memories' });
    const after = rowOf(db, 'doc-3');

    expect(res.unchanged).toBe(false);
    expect(after.embedding).toBeNull(); // stale vectors are worse than missing ones
    expect(after.embedding_model).toBeNull();
    expect(after.updated_at).not.toBe(SENTINEL);
    expect(upserts).toEqual(['agent_memory:doc-3:0']);
  });

  it('a metadata-only change updates metadata and keeps the embedding', () => {
    const db = new Database(':memory:');
    db.exec(smSchema);
    const mem = createMemoryDB(db);

    mem.index('agent_memory', 'doc-4', 'Same body, new tag.', {
      namespace: 'memories', metadata: { project_id: 'p1' },
      embedding: JSON.stringify([0.4, 0.5, 0.6]), embedding_model: 'model-a',
    });
    stampSentinel(db, 'doc-4');
    const upserts = countUpserts(db);

    const res = mem.index('agent_memory', 'doc-4', 'Same body, new tag.', {
      namespace: 'memories', metadata: { project_id: 'p2' },
    });
    const after = rowOf(db, 'doc-4');

    expect(res.unchanged).toBe(false);
    expect(after.embedding).toBe(JSON.stringify([0.4, 0.5, 0.6])); // the vector survives
    expect(after.embedding_model).toBe('model-a');
    expect(JSON.parse(after.metadata).project_id).toBe('p2');
    expect(after.updated_at).not.toBe(SENTINEL); // the stamp moves; the vector does not
    expect(upserts).toHaveLength(1);
  });

  it('identical content carrying a NEW embedding still refreshes the vector', () => {
    const db = new Database(':memory:');
    db.exec(smSchema);
    const mem = createMemoryDB(db);

    mem.index('agent_memory', 'doc-5', 'Refresh body.', {
      namespace: 'memories', embedding: JSON.stringify([0.1, 0.1, 0.1]), embedding_model: 'model-a',
    });
    const upserts = countUpserts(db);

    const res = mem.index('agent_memory', 'doc-5', 'Refresh body.', {
      namespace: 'memories', embedding: JSON.stringify([0.9, 0.9, 0.9]), embedding_model: 'model-b',
    });
    const after = rowOf(db, 'doc-5');

    expect(res.unchanged).toBe(false);
    expect(after.embedding).toBe(JSON.stringify([0.9, 0.9, 0.9]));
    expect(after.embedding_model).toBe('model-b');
    expect(upserts).toHaveLength(1);
  });

  it('a first index is not a no-op and fires exactly one cache upsert', () => {
    const db = new Database(':memory:');
    db.exec(smSchema);
    const mem = createMemoryDB(db);
    const upserts = countUpserts(db);

    const res = mem.index('agent_memory', 'doc-6', 'Fresh row.', { namespace: 'memories' });

    expect(res.unchanged).toBe(false);
    expect(upserts).toEqual(['agent_memory:doc-6:0']);
  });
});

describe('db.indexDoc — a byte-identical re-split is a full no-op', () => {
  it('re-chunking identical oversized content keeps every chunk embedding and fires zero upserts', () => {
    const db = new Database(':memory:');
    db.exec(smSchema);
    const mem = createMemoryDB(db);
    const big = Array.from({ length: 1200 }, (_, i) => `word${i % 97}x`).join(' ');

    const chunks = mem.indexDoc('agent_memory', 'big-doc', big, { namespace: 'memories' });
    expect(chunks.length).toBeGreaterThan(1);
    for (let ci = 0; ci < chunks.length; ci++) {
      mem.updateEmbedding('agent_memory', 'big-doc', ci, [0.1 * ci + 0.1, 0.2, 0.3], 'model-a');
    }
    const before = mem.getDocChunks('agent_memory', 'big-doc');
    stampSentinel(db, 'big-doc');
    const upserts = countUpserts(db);

    const again = mem.indexDoc('agent_memory', 'big-doc', big, { namespace: 'memories' });
    const after = mem.getDocChunks('agent_memory', 'big-doc');

    // slice() strips the attached unchangedCount prop so only the texts compare
    expect(again.slice()).toEqual(chunks.slice()); // lossless chunking is deterministic
    expect(again.unchangedCount).toBe(chunks.length);
    expect(after.map((r) => r.embedding)).toEqual(before.map((r) => r.embedding));
    expect(rowOf(db, 'big-doc').updated_at).toBe(SENTINEL); // chunk 0 wrote nothing
    expect(upserts).toEqual([]);
  });
});

describe('POST /memory/index/bulk — the {ok, indexed, rows, unchanged} split', () => {
  it('counts the items that churned nothing and names the ones that did', async () => {
    ctx = await boot();
    expect((await postBulk([
      { source_type: 'test_doc', source_id: 'doc-a', content_text: 'alpha content', embedding: JSON.stringify([0.1, 0.2, 0.3]) },
      { source_type: 'test_doc', source_id: 'doc-c', content_text: 'gamma v1', embedding: JSON.stringify([0.2, 0.2, 0.2]) },
    ])).status).toBe(200);

    const res = await postBulk([
      { source_type: 'test_doc', source_id: 'doc-a', content_text: 'alpha content' }, // identical
      { source_type: 'test_doc', source_id: 'doc-b', content_text: 'beta content' },  // new
      { source_type: 'test_doc', source_id: 'doc-c', content_text: 'gamma v2' },      // changed
    ]);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, indexed: 3, rows: 3, unchanged: 1 });
    // and the unchanged doc kept its vector through the bulk
    expect(rowOf(ctx.db, 'doc-a').embedding).toBe(JSON.stringify([0.1, 0.2, 0.3]));
    expect(rowOf(ctx.db, 'doc-c').embedding).toBeNull();
  });

  it('a 100-item bulk of unchanged docs touches neither the embed queue nor the embedder', async () => {
    ctx = await boot();
    embedder = await startMockEmbedder();
    ctx.sm.setConfig('embedding_provider', 'ollama');
    ctx.sm.setConfig('embedding_url', embedder.url);
    ctx.sm.setConfig('embedding_model', 'mock-embed');

    const items = Array.from({ length: 100 }, (_, i) => ({
      source_type: 'test_doc', source_id: `bulk-${i}`,
      content_text: `unchanged body ${i}`, embedding: JSON.stringify([i * 0.001, 0.2, 0.3]),
    }));
    expect((await postBulk(items)).json.rows).toBe(100);
    expect(embedder.hits).toEqual([]); // embeddings rode in with the items

    const before = await getStats();
    const res = await postBulk(items.map(({ embedding: _dropped, ...rest }) => rest));
    const after = await getStats();

    expect(res.json).toEqual({ ok: true, indexed: 100, rows: 100, unchanged: 100 });
    expect(after.embed_queue.queued_high).toBe(before.embed_queue.queued_high);
    expect(after.embed_queue.queued_low).toBe(before.embed_queue.queued_low);
    await tick(100);
    expect(embedder.hits).toEqual([]); // the embedder itself heard nothing
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM sm_embeddings WHERE embedding IS NOT NULL').get().c).toBe(100);
  });

  it('changed items in a bulk still enqueue — the fix must not mute real work', async () => {
    ctx = await boot();
    embedder = await startMockEmbedder();
    ctx.sm.setConfig('embedding_provider', 'ollama');
    ctx.sm.setConfig('embedding_url', embedder.url);
    ctx.sm.setConfig('embedding_model', 'mock-embed');

    await postBulk([{ source_type: 'test_doc', source_id: 'doc-m', content_text: 'version one' }]);
    await tick(100);
    embedder.hits.length = 0;

    const res = await postBulk([{ source_type: 'test_doc', source_id: 'doc-m', content_text: 'version two' }]);
    await tick(100);

    expect(res.json.unchanged).toBe(0);
    expect(embedder.hits.length).toBeGreaterThanOrEqual(1); // real work still embeds
  });
});

describe('POST /memory/index (single) — an unchanged doc costs no auto-embed', () => {
  it('embeds a new doc once, an identical re-post never, a changed one again', async () => {
    ctx = await boot();
    embedder = await startMockEmbedder();
    ctx.sm.setConfig('embedding_provider', 'ollama');
    ctx.sm.setConfig('embedding_url', embedder.url);
    ctx.sm.setConfig('embedding_model', 'mock-embed');

    expect((await postIndex({ source_type: 'test_doc', source_id: 'single-1', content_text: 'hello world' })).status).toBe(200);
    await tick(100);
    expect(embedder.hits).toEqual([1]);

    expect((await postIndex({ source_type: 'test_doc', source_id: 'single-1', content_text: 'hello world' })).status).toBe(200);
    await tick(100);
    expect(embedder.hits).toEqual([1]); // the re-post cost nothing

    expect((await postIndex({ source_type: 'test_doc', source_id: 'single-1', content_text: 'hello changed world' })).status).toBe(200);
    await tick(100);
    expect(embedder.hits).toEqual([1, 1]); // the change did
  });
});

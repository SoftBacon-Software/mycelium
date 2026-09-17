// am_facts namespace scoping + semantic index (task 206, BRIEF-lab-alive-memory §3)
//
// The bi-temporal am_facts layer had supersede/reverify/due-reverification routes
// with ZERO callers (task 180's counters): no semantic index, no namespace/run
// scoping — so the bench timeline arm modeled the layer as memory rows in a
// suffixed namespace instead. This suite pins the fix:
//   1. a nullable `namespace` column (migration block in auto-memory/db.js, never
//      schema.sql — see the NOTE at the am_facts indexes) scopes every fact route;
//   2. namespaced facts are pushed through the SAME index path memory rows use
//      (an sm_embeddings row + the embed scheduler), so searchHybrid can hit them;
//   3. a superseded namespaced fact STAYS indexed with its valid_to — the
//      "superseded on <date> by: …" line is renderable from a hit;
//   4. absent namespace = today's behavior: legacy rows keep source_type 'memory',
//      supersede still unindexes them, and the unscoped views see only them.
// Hermetic: in-memory better-sqlite3 with BOTH plugin schemas, the plugin's own
// router mounted the way plugins.js mounts it, and a loopback HTTP server standing
// in for the ollama embedder where the scheduler seam is exercised.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import createRoutes from '../../server/plugins/auto-memory/routes.js';
import createAutoMemoryDB from '../../server/plugins/auto-memory/db.js';
import createMemoryDB from '../../server/plugins/semantic-memory/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const autoSchema = fs.readFileSync(path.join(here, '../../server/plugins/auto-memory/schema.sql'), 'utf8');
const smSchema = fs.readFileSync(path.join(here, '../../server/plugins/semantic-memory/schema.sql'), 'utf8');

const NS_A = 'bench-p1-run-a';
const NS_B = 'bench-p1-run-b';

// A faithful-enough pluginCore (mirrors server/plugins/auto-memory/test.js's
// makeCore, plus the _authIsAdmin flag the real auth sets on every path —
// server/routes/mycelium.js:679-733 — which the namespace guard reads).
function makeCore(db) {
  return {
    db,
    auth: {
      checkAgentOrAdmin(req, res) {
        if (req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        if (req.headers['x-test-admin']) req._authIsAdmin = true;
        return req.headers['x-acting-as'] || 'tester';
      },
      checkAdmin(req, res) {
        if (!req.headers['x-test-admin']) { res.status(401).json({ error: 'Admin required' }); return false; }
        req._authIsAdmin = true;
        return 'tester';
      },
      getAdminDisplayName() { return 'tester'; },
    },
    apiError(res, status, message, extra) { return res.status(status).json(Object.assign({ error: message }, extra || {})); },
    parseIntParam(val) { const n = parseInt(val, 10); return isNaN(n) ? null : n; },
    validateEnum() { return true; },
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

// Boot the plugin the way the real server does: both plugin schemas on ONE db,
// the auto-memory router mounted under /api/mycelium/auto-memory.
async function boot() {
  const db = new Database(':memory:');
  db.exec(autoSchema);
  db.exec(smSchema);
  const core = makeCore(db);
  const app = express();
  app.use(express.json());
  app.use('/api/mycelium/auto-memory', createRoutes(core));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}/api/mycelium/auto-memory`;
  return {
    db,
    core,
    sm: createMemoryDB(db),
    amd: createAutoMemoryDB(db),
    base,
    close: () => new Promise((r) => server.close(r)),
  };
}

let ctx;
afterEach(async () => {
  if (ctx) { await ctx.close(); ctx = undefined; }
});

async function postFact(body, headers = {}) {
  const res = await fetch(`${ctx.base}/facts`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function get(urlPath, headers = {}) {
  const res = await fetch(`${ctx.base}${urlPath}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const indexRows = () => ctx.db.prepare("SELECT * FROM sm_embeddings WHERE source_type = 'am_fact' ORDER BY source_id").all();

// An ollama-shaped embedder on loopback: every /api/embed returns the SAME
// unit-ish vector, so searchVector's cosine ranking is deterministic.
async function startFakeEmbedder() {
  const hits = { count: 0 };
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      hits.count += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: [[0.6, 0.8]] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, hits, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('am_facts namespace migration (db.js migration block, not schema.sql)', () => {
  it('adds a nullable namespace column and a namespace index, idempotently', () => {
    const db = new Database(':memory:');
    db.exec(autoSchema);
    db.exec(smSchema);
    createAutoMemoryDB(db);
    const cols = db.prepare('PRAGMA table_info(am_facts)').all().map((c) => ({ name: c.name, notnull: c.notnull }));
    const nsCol = cols.find((c) => c.name === 'namespace');
    expect(nsCol, 'namespace column missing after migrations').toBeTruthy();
    expect(nsCol.notnull, 'namespace must be nullable (legacy rows have none)').toBe(0);
    // idempotent second run (the freshDB + migration path runs on every boot)
    expect(() => createAutoMemoryDB(db)).not.toThrow();
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'am_facts'").all().map((r) => r.name);
    expect(idx).toContain('idx_am_facts_namespace');
  });
});

describe('two-namespace isolation on the fact routes — zero leakage in BOTH directions', () => {
  it('POST /facts stores the namespace; scoped reads return only their own rows', async () => {
    ctx = await boot();
    const a = await postFact({ fact_text: 'User signed a lease in Lisbon', namespace: NS_A });
    const b = await postFact({ fact_text: 'User switched manager to Dana', namespace: NS_B });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.fact.namespace).toBe(NS_A);
    expect(b.json.fact.namespace).toBe(NS_B);

    const onlyA = await get(`/facts?namespace=${encodeURIComponent(NS_A)}`);
    const onlyB = await get(`/facts?namespace=${encodeURIComponent(NS_B)}`);
    expect(onlyA.json.map((f) => f.namespace)).toEqual([NS_A]);
    expect(onlyB.json.map((f) => f.namespace)).toEqual([NS_B]);

    // direct ids: right namespace answers, wrong namespace 404s NAMING it
    expect((await get(`/facts/${a.json.id}?namespace=${encodeURIComponent(NS_A)}`)).status).toBe(200);
    const wrong = await get(`/facts/${a.json.id}?namespace=${encodeURIComponent(NS_B)}`);
    expect(wrong.status).toBe(404);
    expect(wrong.json.error).toContain(NS_A);
  });

  it('namespaced rows are invisible to the unscoped views (legacy callers see legacy rows only)', async () => {
    ctx = await boot();
    await postFact({ fact_text: 'A legacy fact from the internal writer' });
    await postFact({ fact_text: 'A bench run fact for question one', namespace: NS_A });

    const unscoped = await get('/facts');
    expect(unscoped.json.map((f) => f.namespace)).toEqual([null]);
    const due = await get('/facts/due-reverification', { 'x-test-admin': '1' });
    expect(due.status).toBe(200);
    expect(due.json.map((f) => f.namespace)).toEqual([null]);
    expect((await get(`/facts/2`)).status).toBe(404); // unscoped caller cannot reach the ns row
    expect((await get('/facts/2', { 'x-test-admin': '1' })).status).toBe(200); // admin can
  });

  it('supersede and reverify refuse a cross-namespace id with a 404 naming the namespace — unless admin', async () => {
    ctx = await boot();
    const a = await postFact({ fact_text: 'Lisbon lease starts in May', namespace: NS_A });
    const b = await postFact({ fact_text: 'Lisbon lease starts in June', namespace: NS_B });

    // supersede old(a, nsA) -> new(b, nsB) as a nsA caller: the NEW fact is cross-namespace
    let res = await fetch(`${ctx.base}/facts/${a.json.id}/supersede?namespace=${encodeURIComponent(NS_A)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_id: b.json.id }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(NS_B);

    // same request as a nsB caller: the OLD fact is cross-namespace
    res = await fetch(`${ctx.base}/facts/${a.json.id}/supersede?namespace=${encodeURIComponent(NS_B)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_id: b.json.id }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(NS_A);

    // reverify: same refusal, same naming
    res = await fetch(`${ctx.base}/facts/${a.json.id}/reverify?namespace=${encodeURIComponent(NS_B)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain(NS_A);

    // The ADMIN bypass lifts the namespace GUARD (permission), not the pair
    // rule (referential integrity): an unscoped admin may supersede without
    // naming a namespace at all, but old and new in DIFFERENT namespaces is
    // refused for everyone — a supersede chain must never link one run's
    // history to another's.
    res = await fetch(`${ctx.base}/facts/${a.json.id}/supersede`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-admin': '1' }, body: JSON.stringify({ new_id: b.json.id }),
    });
    expect(res.status).toBe(404); // cross-namespace PAIR — integrity, not permission

    const c = await postFact({ fact_text: 'Lisbon lease starts in July', namespace: NS_A });
    res = await fetch(`${ctx.base}/facts/${a.json.id}/supersede`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-admin': '1' }, body: JSON.stringify({ new_id: c.json.id }),
    });
    expect(res.status).toBe(200); // admin, same-namespace pair, no namespace named — guard bypassed
  });

  it('supersede INSIDE one namespace closes the interval and returns the richer receipt', async () => {
    ctx = await boot();
    const old = await postFact({ fact_text: 'Lisbon lease starts in May', namespace: NS_A, metadata: { episode: 'ep-0' } });
    const neu = await postFact({ fact_text: 'Lisbon lease starts in June', namespace: NS_A, metadata: { episode: 'ep-1' } });
    const res = await fetch(`${ctx.base}/facts/${old.json.id}/supersede?namespace=${encodeURIComponent(NS_A)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_id: neu.json.id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.fact.superseded_by).toBe(neu.json.id);
    expect(body.fact.valid_to).toBeTruthy();
    expect(body.fact.namespace).toBe(NS_A);

    // listFacts scoped to the namespace hides the superseded row
    const list = await get(`/facts?namespace=${encodeURIComponent(NS_A)}`);
    expect(list.json.map((f) => f.id)).toEqual([neu.json.id]);
  });
});

describe('the semantic index — namespaced facts go through the SAME index path memory rows use', () => {
  it('a created fact lands in sm_embeddings (source_type am_fact, scoped by namespace) and search answers it', async () => {
    ctx = await boot();
    const r = await postFact({ fact_text: 'User signed a lease for a Lisbon apartment', namespace: NS_A, metadata: { episode: 'r1-q1-s0', question_id: 'q1' } });
    expect(r.status).toBe(200);
    expect(r.json.memory_index.indexed).toBe(true);

    const rows = indexRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source_id).toBe(String(r.json.id));
    expect(rows[0].namespace).toBe(NS_A);
    expect(rows[0].embedding).toBeNull(); // keyword-searchable now; vector follows the scheduler
    const meta = JSON.parse(rows[0].metadata);
    expect(meta).toMatchObject({ episode: 'r1-q1-s0', question_id: 'q1', namespace: NS_A });

    // scoped keyword search hits it — and the OTHER namespace does not
    const hitA = ctx.sm.searchKeyword('Lisbon apartment lease', { namespace: NS_A, source_types: ['am_fact'] });
    expect(hitA).toHaveLength(1);
    const hitB = ctx.sm.searchKeyword('Lisbon apartment lease', { namespace: NS_B, source_types: ['am_fact'] });
    expect(hitB).toHaveLength(0);
  });

  it('a SUPERSEDED namespaced fact STAYS indexed: the old text still answers a search, valid_to + the supersede line render from the hit', async () => {
    ctx = await boot();
    const old = await postFact({ fact_text: 'The Lisbon lease starts in May', namespace: NS_A, metadata: { episode: 'ep-0', valid_from: '2023/05/20' } });
    const neu = await postFact({ fact_text: 'The Lisbon lease starts in June', namespace: NS_A, metadata: { episode: 'ep-1', valid_from: '2023/05/21' } });
    await fetch(`${ctx.base}/facts/${old.json.id}/supersede?namespace=${encodeURIComponent(NS_A)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_id: neu.json.id }),
    });

    const rows = indexRows();
    expect(rows).toHaveLength(2); // the old row was NOT removed from the index
    const oldRow = rows.find((r) => r.source_id === String(old.json.id));
    expect(oldRow.namespace).toBe(NS_A);
    const meta = JSON.parse(oldRow.metadata);
    expect(meta.valid_to).toBe(old.json.fact.valid_to || meta.valid_to);
    expect(meta.valid_to).toBeTruthy();
    expect(meta.superseded_by).toBe(neu.json.id);
    expect(meta.superseded_by_text).toBe('The Lisbon lease starts in June');
    // the line is renderable from the raw row too, not only from metadata
    expect(oldRow.content_text).toContain('superseded on');
    expect(oldRow.content_text).toContain('The Lisbon lease starts in June');

    // the OLD text still answers a search, in its own namespace, carrying the line
    const hits = ctx.sm.searchKeyword('lease starts', { namespace: NS_A, source_types: ['am_fact'] });
    const oldHit = hits.find((h) => h.source_id === String(old.json.id));
    expect(oldHit, 'superseded fact must still be searchable').toBeTruthy();
    const m = oldHit.metadata;
    expect(`superseded on ${m.valid_to} by: ${m.superseded_by_text}`).toContain('superseded on');

    // other namespaces still see nothing
    expect(ctx.sm.searchKeyword('lease starts', { namespace: NS_B, source_types: ['am_fact'] })).toHaveLength(0);
  });

  it('legacy no-namespace behavior is byte-for-byte: source_type memory, supersede unindexes, response shape unchanged', async () => {
    ctx = await boot();
    const r = await postFact({ fact_text: 'A legacy fact from the internal writer path' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['fact', 'id', 'memory_index', 'ok']);
    expect(r.json.memory_index.indexed).toBe(true);
    expect(r.json.fact.namespace).toBeNull();

    // legacy rows index under source_type 'memory' with NULL namespace — today's shape
    const memRow = ctx.db.prepare("SELECT * FROM sm_embeddings WHERE source_type = 'memory' AND source_id = ?").get(String(r.json.id));
    expect(memRow).toBeTruthy();
    expect(memRow.namespace).toBeNull();

    const neu = await postFact({ fact_text: 'The replacement legacy fact, stated differently' });
    const sup = await fetch(`${ctx.base}/facts/${r.json.id}/supersede`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ new_id: neu.json.id }),
    });
    expect(sup.status).toBe(200);
    expect(await sup.json()).toEqual({ ok: true }); // legacy supersede response, unchanged

    // legacy supersede UNINDEXES the old row (the invariant supersedeFact has held since 07-22)
    const gone = ctx.db.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'memory' AND source_id = ?").get(String(r.json.id));
    expect(gone.c).toBe(0);
  });

  it('the embed scheduler seam: with a provider configured the fact vector lands and vector search answers it, namespace-scoped', async () => {
    ctx = await boot();
    const embedder = await startFakeEmbedder();
    try {
      ctx.db.prepare("INSERT INTO sm_config (key, value) VALUES ('embedding_provider', 'ollama')").run();
      ctx.db.prepare("INSERT INTO sm_config (key, value) VALUES ('embedding_url', ?)").run(embedder.url);
      ctx.db.prepare("INSERT INTO sm_config (key, value) VALUES ('embedding_model', 'nomic-embed-text')").run();

      const a = await postFact({ fact_text: 'Vector-scheduled fact for namespace A', namespace: NS_A });
      // the write rides the hooked side-channel (vector-cache gate: the raw
      // UPDATE lives only in semantic-memory/db.js)
      expect(ctx.db.__myceliumEmbeddingWrite).toBeTypeOf('function');
      const b = await postFact({ fact_text: 'Vector-scheduled fact for namespace B', namespace: NS_B });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const landed = await waitFor(() => ctx.db.prepare('SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = ? AND embedding IS NOT NULL').get('am_fact').c >= 2);
      expect(landed, 'embed scheduler never wrote the vectors back').toBe(true);
      expect(embedder.hits.count).toBeGreaterThanOrEqual(2); // the scheduler, not a manual write

      const vec = [0.6, 0.8];
      const hitA = await ctx.sm.searchHybrid('Vector-scheduled fact', { namespace: NS_A, source_types: ['am_fact'], limit: 5 }, vec);
      expect(hitA.map((h) => h.namespace)).toEqual([NS_A]);
      expect(hitA[0].source_id).toBe(String(a.json.id));
    } finally {
      await embedder.close();
    }
  });
});

describe('due-reverification scoping', () => {
  it('scoped queue returns only that namespace; unscoped queue stays legacy-only', async () => {
    ctx = await boot();
    await postFact({ fact_text: 'Legacy inferred fact awaiting recheck', source_authority: 'inferred' });
    await postFact({ fact_text: 'Namespaced inferred fact awaiting recheck', namespace: NS_A, source_authority: 'inferred' });

    const unscoped = await get('/facts/due-reverification', { 'x-test-admin': '1' });
    expect(unscoped.json.map((f) => f.namespace)).toEqual([null]);
    const scoped = await get(`/facts/due-reverification?namespace=${encodeURIComponent(NS_A)}`, { 'x-test-admin': '1' });
    expect(scoped.json.map((f) => f.namespace)).toEqual([NS_A]);
  });
});

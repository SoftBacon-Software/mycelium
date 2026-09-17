// am_facts bulk delete by namespace (task 211, BRIEF-lab-alive-memory §3)
//
// DELETE /auto-memory/facts?namespace=<ns> is the cleanup leg the bench
// contract needs: purge-everything-after. A timeline n=50 run writes ~21.5k
// am_facts rows; per-id DELETE /facts/:id is not a cleanup path, and skipping
// cleanup strands the run's rows in the lab's LIVE fact table forever. This
// suite pins:
//   1. a purge takes ONLY the namespace it names — current AND superseded
//      rows alike — and the second namespace's rows survive AND still answer
//      a search (pre-committed numbers: deleted 0 there, hits intact);
//   2. the index rows go out through the SAME seam every other removal path
//      uses (unindexFacts — both index shapes + the vector-cache hook), so a
//      purged namespace stops answering POST /memory/search in the same
//      request (0 hits after, hits before);
//   3. UNSCOPED REFUSAL: an unnamed/empty/whitespace namespace is a 400 that
//      names the rule, and namespace-IS-NULL rows — legacy rows, Aria's
//      internal writer — are unreachable from this route, EVER (fixture pin);
//   4. admin-only: an agent key is a 403 (mirrors the real checkAdmin's
//      admin-key path), missing credentials a 401, and nothing dies;
//   5. a namespace with zero rows is 200 {deleted: 0} — an honest count;
//   6. the route-usage counters stamp the route (the counters ARE the
//      receipt, 206's convention) — counted through the REAL seam middleware
//      on a real temp DATA_DIR, not a stubbed call.
// Hermetic: in-memory better-sqlite3 with BOTH plugin schemas, the plugin's
// own routers mounted the way plugins.js mounts them (auto-memory under
// /auto-memory, semantic-memory under /memory), and — for the counters leg —
// the real lib/route-usage.js middleware over a real temp DATA_DIR.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import createRoutes from '../../server/plugins/auto-memory/routes.js';
import createAutoMemoryDB from '../../server/plugins/auto-memory/db.js';
import createMemoryRoutes from '../../server/plugins/semantic-memory/routes.js';
import createMemoryDB from '../../server/plugins/semantic-memory/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const autoSchema = fs.readFileSync(path.join(here, '../../server/plugins/auto-memory/schema.sql'), 'utf8');
const smSchema = fs.readFileSync(path.join(here, '../../server/plugins/semantic-memory/schema.sql'), 'utf8');

const NS_A = 'bench-p1-run-a';
const NS_B = 'bench-p1-run-b';

// A faithful-enough pluginCore (mirrors auto-memory-amfacts.test.js's makeCore),
// with checkAdmin mirroring the REAL checkAdmin's three-way contract
// (server/routes/mycelium.js:676): admin credential → ok; a PRESENTED but
// non-admin credential (an agent key) → 403; nothing → 401. asyncHandler is
// included because the semantic-memory router destructures it off core.
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
        if (req.headers['x-test-admin']) { req._authIsAdmin = true; return 'tester'; }
        if (req.headers['x-test-agent']) { res.status(403).json({ error: 'Invalid admin key' }); return false; }
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

// Boot BOTH plugins the way the real server mounts them (plugins.js:
// routePrefix = '/' + name), on ONE shared in-memory db.
async function boot() {
  const db = new Database(':memory:');
  db.exec(autoSchema);
  db.exec(smSchema);
  const core = makeCore(db);
  const app = express();
  app.use(express.json());
  app.use('/api/mycelium/auto-memory', createRoutes(core));
  app.use('/api/mycelium/memory', createMemoryRoutes(core));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}/api/mycelium`;
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
  const res = await fetch(`${ctx.base}/auto-memory/facts`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function call(method, urlPath, headers = {}) {
  const res = await fetch(`${ctx.base}${urlPath}`, { method, headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const admin = { 'x-test-admin': '1' };
const purgeUrl = (ns) => `/auto-memory/facts?namespace=${encodeURIComponent(ns)}`;
const amCount = (ns) => ctx.db.prepare('SELECT COUNT(*) AS c FROM am_facts WHERE namespace = ?').get(ns).c;
const indexCount = (ns) => ctx.db.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'am_fact' AND namespace = ?").get(ns).c;

// Search through the REAL POST /memory/search route (keyword mode — no embed
// provider configured in these boots, so keyword is also what hybrid does).
async function searchNS(query, ns) {
  const res = await fetch(`${ctx.base}/memory/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...admin },
    body: JSON.stringify({ query, namespace: ns, source_types: ['am_fact'], mode: 'keyword', limit: 25 }),
  });
  const json = await res.json();
  return json.results || json;
}

async function supersede(oldId, newId, ns) {
  return fetch(`${ctx.base}/auto-memory/facts/${oldId}/supersede${ns ? `?namespace=${encodeURIComponent(ns)}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...admin }, body: JSON.stringify({ new_id: newId }),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

describe('DELETE /auto-memory/facts?namespace=<ns> — the purge takes exactly the namespace it names', () => {
  it('deletes every row in the named namespace and nothing else; the second namespace keeps its rows AND its search', async () => {
    ctx = await boot();
    const a1 = await postFact({ fact_text: 'Run A: user signed a lease in Lisbon', namespace: NS_A });
    await postFact({ fact_text: 'Run A: the lease renewal is in June', namespace: NS_A });
    const b1 = await postFact({ fact_text: 'Run B: user switched manager to Dana', namespace: NS_B });
    const b2 = await postFact({ fact_text: 'Run B: the offsite is in Osaka', namespace: NS_B });
    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200);

    const res = await call('DELETE', purgeUrl(NS_A), admin);
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(2);
    expect(res.json.namespaces).toEqual([NS_A]);

    expect(amCount(NS_A)).toBe(0);
    // the second namespace: deleted 0 there, rows survive — the pre-committed number
    expect(amCount(NS_B)).toBe(2);
    const listB = await call('GET', `/auto-memory/facts?namespace=${encodeURIComponent(NS_B)}`);
    expect(listB.json.map((f) => f.id).sort()).toEqual([b1.json.id, b2.json.id].sort());
    // ...and its rows still answer a search
    const hits = await searchNS('manager Dana', NS_B);
    expect(hits.map((h) => String(h.source_id))).toContain(String(b1.json.id));

    // direct ids in the purged namespace are gone (404), the survivor answers
    expect((await call('GET', `/auto-memory/facts/${a1.json.id}?namespace=${encodeURIComponent(NS_A)}`, admin)).status).toBe(404);
    expect((await call('GET', `/auto-memory/facts/${b1.json.id}?namespace=${encodeURIComponent(NS_B)}`)).status).toBe(200);
  });

  it('SUPERSEDED rows in the namespace die with the current ones — a cleanup is not a supersede', async () => {
    ctx = await boot();
    const old = await postFact({ fact_text: 'Run A: the lease starts in May', namespace: NS_A });
    const neu = await postFact({ fact_text: 'Run A: the lease starts in June', namespace: NS_A });
    const sup = await supersede(old.json.id, neu.json.id, NS_A);
    expect(sup.status).toBe(200);
    // 206's contract: the superseded row STAYS indexed until a purge
    expect(amCount(NS_A)).toBe(2);
    expect(indexCount(NS_A)).toBe(2);

    const res = await call('DELETE', purgeUrl(NS_A), admin);
    expect(res.status).toBe(200);
    expect(res.json.deleted).toBe(2); // current + superseded, by name
    expect(amCount(NS_A)).toBe(0);
    const tomb = ctx.db.prepare('SELECT COUNT(*) AS c FROM am_facts WHERE id = ?').get(old.json.id).c;
    expect(tomb, 'the superseded row must be physically gone, not tombstoned').toBe(0);
  });
});

describe('UNSCOPED REFUSAL — the route never touches namespace-IS-NULL rows', () => {
  it('a missing, empty, or whitespace namespace is a 400 naming the rule, and nothing dies', async () => {
    ctx = await boot();
    const a1 = await postFact({ fact_text: 'Run A: user signed a lease in Lisbon', namespace: NS_A });
    const legacy = await postFact({ fact_text: 'A legacy fact from the internal writer path' });
    expect(legacy.json.fact.namespace).toBeNull();
    const before = ctx.db.prepare('SELECT COUNT(*) AS c FROM am_facts').get().c;

    for (const url of ['/auto-memory/facts', '/auto-memory/facts?namespace=', '/auto-memory/facts?namespace=%20%20']) {
      const res = await call('DELETE', url, admin);
      expect(res.status, `expected 400 for ${url}`).toBe(400);
      expect(res.json.error).toContain('namespace is required');
      expect(res.json.error).toContain('unreachable'); // the rule, named
    }
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM am_facts').get().c).toBe(before);
    expect((await call('GET', `/auto-memory/facts/${a1.json.id}?namespace=${encodeURIComponent(NS_A)}`, admin)).status).toBe(200);
  });

  it('legacy no-namespace rows are unreachable from a purge, ever: a real namespace purge leaves them standing', async () => {
    ctx = await boot();
    // the fixture: a legacy row exactly as Aria's internal writer makes one
    const legacy = await postFact({ fact_text: 'Legacy fact from the internal writer path' });
    expect(legacy.json.fact.namespace).toBeNull();
    const legacyBefore = ctx.db.prepare('SELECT COUNT(*) AS c FROM am_facts WHERE namespace IS NULL').get().c;
    expect(legacyBefore).toBeGreaterThanOrEqual(1);

    await postFact({ fact_text: 'Run A: user signed a lease in Lisbon', namespace: NS_A });
    // purge a namespace that has rows, and one that has none — the legacy count moves for neither
    expect((await call('DELETE', purgeUrl(NS_A), admin)).json.deleted).toBe(1);
    expect((await call('DELETE', purgeUrl('bench-p1-never-existed'), admin)).json).toEqual({
      deleted: 0, namespaces: ['bench-p1-never-existed'],
    });
    expect(ctx.db.prepare('SELECT COUNT(*) AS c FROM am_facts WHERE namespace IS NULL').get().c).toBe(legacyBefore);
    // the legacy row is still readable through the unscoped view
    expect((await call('GET', `/auto-memory/facts/${legacy.json.id}`)).status).toBe(200);
  });
});

describe('admin-only — an agent key is a 403, no credentials a 401, and nothing dies', () => {
  it('refuses a non-admin caller with 403 and leaves every row in place', async () => {
    ctx = await boot();
    const a1 = await postFact({ fact_text: 'Run A: user signed a lease in Lisbon', namespace: NS_A });
    const res = await call('DELETE', purgeUrl(NS_A), { 'x-test-agent': 'agent-key' });
    expect(res.status).toBe(403);
    expect(amCount(NS_A)).toBe(1);
    expect((await call('GET', `/auto-memory/facts/${a1.json.id}?namespace=${encodeURIComponent(NS_A)}`, admin)).status).toBe(200);

    const anon = await call('DELETE', purgeUrl(NS_A));
    expect(anon.status).toBe(401);
    expect(amCount(NS_A)).toBe(1);
  });
});

describe('a namespace with zero rows is an honest 200 {deleted: 0}', () => {
  it('answers {deleted: 0} for a fresh namespace and again after its purge', async () => {
    ctx = await boot();
    const fresh = await call('DELETE', purgeUrl('bench-p1-empty-ns'), admin);
    expect(fresh.status).toBe(200);
    expect(fresh.json.deleted).toBe(0);

    await postFact({ fact_text: 'Run A: user signed a lease in Lisbon', namespace: NS_A });
    expect((await call('DELETE', purgeUrl(NS_A), admin)).json.deleted).toBe(1);
    const again = await call('DELETE', purgeUrl(NS_A), admin);
    expect(again.status).toBe(200);
    expect(again.json.deleted).toBe(0);
  });
});

describe('INDEX CONSISTENCY — the purged namespace stops answering POST /memory/search in the same request', () => {
  it('hits before the purge, 0 hits after, through the real search route; the sibling namespace keeps answering', async () => {
    ctx = await boot();
    const a1 = await postFact({ fact_text: 'The Lisbon lease renewal negotiation is scheduled for June', namespace: NS_A });
    const b1 = await postFact({ fact_text: 'The Lisbon lease renewal for the other run is also in June', namespace: NS_B });
    expect(a1.status).toBe(200);
    expect(b1.status).toBe(200);

    const before = await searchNS('Lisbon lease renewal', NS_A);
    expect(before.map((h) => String(h.source_id))).toContain(String(a1.json.id));

    // a superseded row's index line goes out with the purge too (it stayed
    // indexed through the supersede, per 206 — the purge takes it)
    const neu = await postFact({ fact_text: 'The Lisbon lease renewal is moved to July', namespace: NS_A });
    const sup = await supersede(a1.json.id, neu.json.id, NS_A);
    expect(sup.status, 'the supersede leg must actually run — a 400 here voids this test').toBe(200);
    expect(indexCount(NS_A)).toBe(2);

    const res = await call('DELETE', purgeUrl(NS_A), admin);
    expect(res.json.deleted).toBe(2);
    expect(indexCount(NS_A)).toBe(0);

    const after = await searchNS('Lisbon lease renewal', NS_A);
    expect(after, 'post-purge search must return 0 hits').toHaveLength(0);
    // the sibling namespace: still searchable — pre-committed number
    const sibling = await searchNS('Lisbon lease renewal', NS_B);
    expect(sibling.map((h) => String(h.source_id))).toContain(String(b1.json.id));
    // and the raw index table holds no orphans for the purged ids
    const orphan = ctx.db.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type IN ('memory','am_fact') AND source_id = ?").get(String(a1.json.id)).c;
    expect(orphan).toBe(0);
  });
});

// -- The counters receipt (206's convention: the counters ARE the receipt) ----
// The behavior legs above run on the fake core; this leg runs the route behind
// the REAL seam middleware (lib/route-usage.js) exactly as server/index.js
// mounts it (counter FIRST at /api/mycelium, mount stamp on the plugin
// router), over a real temp DATA_DIR — the same harness
// test/unit/route-usage.test.js proves hermetic. 4xx counts too: everything
// counted by default is the instrument's contract.
describe('route-usage counters stamp the purge route', () => {
  let tmpDataDir;
  let app;
  let realDb;
  let server;

  beforeAll(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myc-amfacts-bulk-'));
    process.env.DATA_DIR = tmpDataDir;
    process.env.ADMIN_KEY = 'test-admin-key-amfacts-bulk-0123456789abcdef';
    process.env.JWT_SECRET = 'test-jwt-secret-amfacts-bulk';
    realDb = await import('../../server/db.js');
    realDb.initDB();

    const counter = await import('../../server/lib/route-usage.js');
    const db = new Database(':memory:');
    db.exec(autoSchema);
    db.exec(smSchema);
    const core = makeCore(db);
    app = express();
    app.use(express.json());
    app.use('/api/mycelium', counter.routeUsageCounter); // production mount order: counter FIRST
    app.use('/api/mycelium/auto-memory', counter.routeUsageMountStamp('/auto-memory'), createRoutes(core));
    server = await listen(app);
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    if (tmpDataDir) fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('records the route (and its refusals) in route_usage with the seam-relative pattern', async () => {
    const base = `http://127.0.0.1:${server.address().port}/api/mycelium/auto-memory`;
    const post = (body) => fetch(`${base}/facts`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-test-admin': '1' }, body: JSON.stringify(body),
    });
    const a1 = await (await post({ fact_text: 'Run A: user signed a lease in Lisbon', namespace: NS_A })).json();
    expect(a1.ok).toBe(true);

    const purge = await fetch(`${base}/facts?namespace=${encodeURIComponent(NS_A)}`, { method: 'DELETE', headers: admin });
    expect(purge.status).toBe(200);
    const refused = await fetch(`${base}/facts`, { method: 'DELETE', headers: admin }); // unscoped → 400
    expect(refused.status).toBe(400);
    const forbidden = await fetch(`${base}/facts?namespace=${encodeURIComponent(NS_A)}`, { method: 'DELETE', headers: { 'x-test-agent': 'agent-key' } });
    expect(forbidden.status).toBe(403);

    // response-finish timing: give the finish handler its tick before reading
    await new Promise((r) => setTimeout(r, 50));
    const rows = realDb.getDB().prepare(
      "SELECT method, route_pattern, count, day FROM route_usage WHERE route_pattern LIKE '/auto-memory/facts%' ORDER BY method, route_pattern"
    ).all();
    const byKey = Object.fromEntries(rows.map((r) => [`${r.method} ${r.route_pattern}`, r.count]));
    expect(byKey['DELETE /auto-memory/facts']).toBeGreaterThanOrEqual(1);
    expect(byKey['POST /auto-memory/facts']).toBeGreaterThanOrEqual(1);
    // the refusals are traffic evidence too — everything counted by default
    expect(byKey['DELETE /auto-memory/facts']).toBeGreaterThanOrEqual(3);
    // :id values cannot leak into the pattern (cardinality bound)
    expect(rows.map((r) => r.route_pattern)).not.toContain(expect.stringContaining(NS_A));
  });
});

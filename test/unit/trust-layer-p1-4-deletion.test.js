// TRUST LAYER P1.4 — deletion that propagates (2026-10-06, F-mycelium/267 —
// PROGRAM-mycelium-trust-layer-2026-09-26 §P1.4).
//
// The audit named the hole: deleting a row (or its SOURCE) removed it from
// one table while its copies, its index rows, its embeddings and the rows
// DERIVED from it kept answering recall — deletion that does not propagate
// is retention with extra steps. P1.4's law, one rule per describe:
//
//   TOMBSTONES  a deleted row leaves a tombstone — id, deleted_at, by whom
//               (authenticated), why — and NEVER the content. Housekeeping
//               deletes are deletes too (#193).
//   SOURCE      deleting a task / concept / plan (or a context key) deletes
//               the memory rows that came from it.
//   FORGET      forgetting a row removes it from search, removes its
//               embeddings, and cascades through the rows DERIVED from it
//               — a forgotten fact is not recalled through a summary.
//   REVOKE      a federation revoke message: a souvenir you forget is
//               forgotten where it went, and cannot be re-imported.
//
// Harness A models on trust-layer-p1-3-quarantine.test.js: the REAL router
// with the REAL plugin routes mounted via initPlugins on a fresh temp DB.
// The forget/consolidation unit tests model on auto-memory-extracted-fact-
// fields-validated.test.js: in-memory better-sqlite3 + both plugin schemas,
// the LLM intercepted at the fetch seam. The federation tests model on
// federation-routes.test.js: real federation + semantic-memory routes over a
// faked core, the full visit → souvenir → import round trip — no network.

process.env.MYCELIUM_RATE_LIMIT = 'off'; // limiters are proven in trust-layer-rate-limits.test.js

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

const ADMIN_KEY = 'trust-layer-p14-admin-key-0123456789';
const JWT_SECRET = 'trust-layer-p14-jwt-secret';
const AGENT_A_KEY = 'dvk_' + 'c'.repeat(48); // lucy-tl267 — the writer

const agentAuth = { 'X-Agent-Key': AGENT_A_KEY };
const adminKeyAuth = { 'X-Admin-Key': ADMIN_KEY };

const HERE = dirname(fileURLToPath(import.meta.url));
const AM_SCHEMA = readFileSync(join(HERE, '../../server/plugins/auto-memory/schema.sql'), 'utf8');
const SM_SCHEMA = readFileSync(join(HERE, '../../server/plugins/semantic-memory/schema.sql'), 'utf8');

function smTombstones(db, sourceType, sourceId) {
  return db.prepare('SELECT * FROM sm_tombstones WHERE source_type = ? AND source_id = ?').all(sourceType, sourceId);
}
function searchFor(app, query) {
  return request(app).post('/api/mycelium/memory/search').set(agentAuth).send({ query });
}

// ======================== Harness A: the real router ========================

let tmpDataDir;
let db;
let app;

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-trust-layer-p14-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = JWT_SECRET;

  db = await import('../../server/db.js');
  db.initDB();

  const routes = (await import('../../server/routes/mycelium.js')).default;
  app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/mycelium', routes);
  const { initPlugins } = await import('../../server/routes/mycelium.js');
  await initPlugins(app);

  const hashA = crypto.createHash('sha256').update(AGENT_A_KEY).digest('hex');
  db.createAgent('lucy-tl267', 'Lucy TL267', 'trust-proj', hashA, '["code"]');
});

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

// ------------------------------ TOMBSTONES ----------------------------------

describe('P1.4 TOMBSTONES: a deleted row leaves a tombstone, never its content', () => {
  const DOC = 'tl267 the launch recipe lives in the amber tin above the sink';

  it('an agent forgetting its own index doc leaves id + deleted_at + authenticated by + reason — and no content', async () => {
    const idx = await request(app).post('/api/mycelium/memory/index').set(agentAuth).send({
      source_type: 'note', source_id: 'tl267-tomb-1', content_text: DOC
    });
    expect(idx.status).toBe(200);

    const del = await request(app).delete('/api/mycelium/memory/index/note/tl267-tomb-1').set(agentAuth);
    expect(del.status).toBe(200);

    const tombs = smTombstones(db.getDB(), 'note', 'tl267-tomb-1');
    expect(tombs.length).toBeGreaterThanOrEqual(1);
    const t = tombs[0];
    expect(t.deleted_at).toBeTruthy();
    expect(t.deleted_by).toBe('lucy-tl267'); // the AUTHENTICATED actor, not a body claim
    expect(t.reason).toBeTruthy();
    // The law: never the content. No column of the tombstone carries the row's
    // text — serialize the whole row and demand the content is not in it.
    expect(JSON.stringify(t)).not.toContain('amber tin');

    const search = await searchFor(app, 'launch recipe amber tin');
    expect(search.body.results.find((r) => r.source_id === 'tl267-tomb-1')).toBeUndefined();
  });

  it('an admin purge tombstones every row it deletes — housekeeping is deletes too (#193)', async () => {
    for (let i = 0; i < 3; i++) {
      const idx = await request(app).post('/api/mycelium/memory/index').set(agentAuth).send({
        source_type: 'note', source_id: 'tl267-purge-' + i,
        content_text: 'purge me tl267 number ' + i, namespace: 'tl267-purge'
      });
      expect(idx.status).toBe(200);
    }
    const purge = await request(app).delete('/api/mycelium/memory/index').set(adminKeyAuth)
      .query({ namespace: 'tl267-purge' });
    expect(purge.status).toBe(200);
    expect(purge.body.deleted).toBe(3);

    for (let i = 0; i < 3; i++) {
      const tombs = smTombstones(db.getDB(), 'note', 'tl267-purge-' + i);
      expect(tombs.length).toBeGreaterThanOrEqual(1);
      expect(tombs[0].deleted_by).toBeTruthy(); // the admin actor is on the record
      expect(tombs[0].reason).toBe('purge');
    }
  });

  it('an auto-memory fact deletion tombstones the fact row too', async () => {
    const created = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth).send({
      fact_text: 'the tl267 fact store deletes leave tombstones as well',
      source_authority: 'verified'
    });
    expect(created.status).toBe(200);
    const factId = created.body.facts?.[0]?.id ?? created.body.id;
    expect(factId).toBeTruthy();

    const del = await request(app).delete('/api/mycelium/auto-memory/facts/' + factId).set(adminKeyAuth);
    expect(del.status).toBe(200);

    const tomb = db.getDB().prepare('SELECT * FROM am_tombstones WHERE fact_id = ?').all(factId);
    expect(tomb.length).toBeGreaterThanOrEqual(1);
    expect(tomb[0].deleted_at).toBeTruthy();
    expect(tomb[0].deleted_by).toBeTruthy();
    expect(JSON.stringify(tomb[0])).not.toContain('tombstones as well');
  });
});

// ---------------------------- SOURCE CASCADE --------------------------------

describe('P1.4 SOURCE CASCADE: deleting the source deletes the memory rows that came from it', () => {
  it('deleting a task removes its auto-indexed memory row from search + store, and tombstones it', async () => {
    const created = await request(app).post('/api/mycelium/tasks').set(agentAuth).send({
      title: 'tl267 source-cascade task about the zephyr blade assembly',
      description: 'index me then delete my source'
    });
    expect(created.status).toBe(200);
    const taskId = created.body.id;

    // The auto-indexer wrote the task's row (this is the PRE-P1.4 state).
    const before = await searchFor(app, 'zephyr blade assembly');
    expect(before.body.results.find((r) => r.source_type === 'task' && r.source_id === String(taskId))).toBeTruthy();

    const del = await request(app).delete('/api/mycelium/tasks/' + taskId).set(adminKeyAuth);
    expect(del.status).toBe(200);

    const after = await searchFor(app, 'zephyr blade assembly');
    expect(after.body.results.find((r) => r.source_type === 'task' && r.source_id === String(taskId))).toBeUndefined();
    const rows = db.getDB().prepare('SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = ? AND source_id = ?')
      .get('task', String(taskId));
    expect(rows.c).toBe(0);

    const tombs = smTombstones(db.getDB(), 'task', String(taskId));
    expect(tombs.length).toBeGreaterThanOrEqual(1);
    expect(tombs[0].deleted_by).toBeTruthy(); // the authenticated deleter
    expect(tombs[0].reason).toBe('source-deleted');
  });

  it('deleting a concept removes its memory row and tombstones it', async () => {
    const created = await request(app).post('/api/mycelium/concepts').set(agentAuth).send({
      name: 'tl267-concept-quarrel',
      type: 'character',
      description: 'a concept whose memory row must follow it into the grave'
    });
    expect(created.status).toBe(200);
    const conceptId = created.body.id;

    const before = await searchFor(app, 'concept-quarrel memory row grave');
    expect(before.body.results.find((r) => r.source_type === 'concept' && r.source_id === String(conceptId))).toBeTruthy();

    const del = await request(app).delete('/api/mycelium/concepts/' + conceptId).set(agentAuth);
    expect(del.status).toBe(200);

    const after = await searchFor(app, 'concept-quarrel memory row grave');
    expect(after.body.results.find((r) => r.source_type === 'concept')).toBeUndefined();
    const rows = db.getDB().prepare('SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = ? AND source_id = ?')
      .get('concept', String(conceptId));
    expect(rows.c).toBe(0);
    expect(smTombstones(db.getDB(), 'concept', String(conceptId)).length).toBeGreaterThanOrEqual(1);
  });

  it('deleting a plan removes its row AND its plan_step rows', async () => {
    const created = await request(app).post('/api/mycelium/plans').set(agentAuth).send({
      title: 'tl267 plan whose echo must not outlive it',
      description: 'plan body for the cascade test',
      steps: [{ title: 'tl267 step one of the doomed plan' }]
    });
    expect(created.status).toBe(200);
    const planId = created.body.id;

    // A plan_step row as the auto-indexer writes one (metadata.plan_id links
    // it) — plan_step is SERVER-OWNED (P1.3), so the write goes as admin,
    // exactly the authority the plan_step_completed handler writes with.
    const stepIdx = await request(app).post('/api/mycelium/memory/index').set(adminKeyAuth).send({
      source_type: 'plan_step', source_id: 'tl267-step-of-' + planId,
      content_text: 'tl267 step one of the doomed plan',
      metadata: { plan_id: String(planId) }
    });
    expect(stepIdx.status).toBe(200);

    const before = await searchFor(app, 'doomed plan echo must not outlive');
    expect(before.body.results.find((r) => r.source_type === 'plan' && r.source_id === String(planId))).toBeTruthy();

    const del = await request(app).delete('/api/mycelium/plans/' + planId).set(agentAuth);
    expect(del.status).toBe(200);

    const after = await searchFor(app, 'doomed plan echo must not outlive');
    expect(after.body.results.find((r) => r.source_type === 'plan')).toBeUndefined();
    const stepAfter = await searchFor(app, 'step one of the doomed plan');
    expect(stepAfter.body.results.find((r) => r.source_type === 'plan_step')).toBeUndefined();

    expect(smTombstones(db.getDB(), 'plan', String(planId)).length).toBeGreaterThanOrEqual(1);
    expect(smTombstones(db.getDB(), 'plan_step', 'tl267-step-of-' + planId).length).toBeGreaterThanOrEqual(1);
  });

  it('deleting a context key removes its auto-indexed row (single delete and bulk delete)', async () => {
    const put = async (ns, key, value) => request(app).put('/api/mycelium/context/keys/' + ns + '/' + key)
      .set(agentAuth).send({ data: value });
    const ns = 'tl267-cascade';
    const put1 = await put(ns, 'solvent', 'the red solvent dissolves the resin in about forty minutes');
    expect(put1.status).toBe(200);
    const put2 = await put(ns, 'kiln', 'the kiln schedule for tl267 cones to 1220 then soaks');
    expect(put2.status).toBe(200);

    const before = await searchFor(app, 'red solvent dissolves the resin');
    expect(before.body.results.find((r) => r.source_type === 'context_key')).toBeTruthy();

    const del = await request(app).delete('/api/mycelium/context/keys/' + ns + '/solvent').set(adminKeyAuth);
    expect(del.status).toBe(200);

    const after = await searchFor(app, 'red solvent dissolves the resin');
    expect(after.body.results.find((r) => r.source_type === 'context_key' && r.source_id === ns + ':solvent')).toBeUndefined();
    expect(smTombstones(db.getDB(), 'context_key', ns + ':solvent').length).toBeGreaterThanOrEqual(1);

    // The kiln row is untouched by its sibling's deletion.
    const kept = await searchFor(app, 'kiln schedule tl267 cones');
    expect(kept.body.results.find((r) => r.source_id === ns + ':kiln')).toBeTruthy();

    // Bulk delete: ids in, every named key's memory row out.
    const bulkRows = db.getDB().prepare(
      "SELECT source_id FROM sm_embeddings WHERE source_type = 'context_key' AND source_id = ?"
    ).get(ns + ':kiln');
    expect(bulkRows).toBeTruthy();
    const idRow = db.getDB().prepare('SELECT id FROM context_keys WHERE namespace = ? AND key = ?').get(ns, 'kiln');
    const bulk = await request(app).post('/api/mycelium/context/keys/bulk-delete').set(adminKeyAuth)
      .send({ ids: [idRow.id] });
    expect(bulk.status).toBe(200);
    const afterBulk = await searchFor(app, 'kiln schedule tl267 cones');
    expect(afterBulk.body.results.find((r) => r.source_id === ns + ':kiln')).toBeUndefined();
    expect(smTombstones(db.getDB(), 'context_key', ns + ':kiln').length).toBeGreaterThanOrEqual(1);
  });
});

// ------------------- FORGET CASCADE (unit: the derived graph) -----------------

describe('P1.4 FORGET CASCADE: a forgotten fact is not recalled through a summary', () => {
  const realFetch = global.fetch;
  let raw, memDb, amDb;

  // callLLM (provider ollama) hits localhost:11434 — intercept ONLY that.
  function mockOllama(responder) {
    return function (url, opts) {
      if (String(url).indexOf('11434') !== -1) return Promise.resolve(responder());
      return realFetch(url, opts);
    };
  }
  const LLM_CONFIG = { llm_provider: 'ollama', llm_url: 'http://localhost:11434', llm_model: 'x' };

  beforeEach(async () => {
    raw = new Database(':memory:');
    raw.exec(AM_SCHEMA);
    raw.exec(SM_SCHEMA);
    const createAutoMemoryDB = (await import('../../server/plugins/auto-memory/db.js')).default;
    const createMemoryDB = (await import('../../server/plugins/semantic-memory/db.js')).default;
    amDb = createAutoMemoryDB(raw);
    memDb = createMemoryDB(raw);
  });
  afterEach(() => { raw.close(); global.fetch = realFetch; });

  it('consolidation insights record the input ids they were derived from (the minimal provenance link)', async () => {
    const f1 = amDb.createFact(null, null, 'pattern', 'the tl267 deploy gates on two frontier reviews', 0.9, 'extraction', null, 'verified');
    const f2 = amDb.createFact(null, null, 'preference', 'the tl267 operator prefers terse morning briefs', 0.8, 'extraction', null, 'verified');
    const f3 = amDb.createFact(null, null, 'decision', 'the tl267 bench writes facts through the namespaced door', 0.8, 'extraction', null, 'verified');
    const f4 = amDb.createFact(null, null, 'pattern', 'the tl267 verifier refuses an empty result as a pass', 0.8, 'extraction', null, 'verified');
    const f5 = amDb.createFact(null, null, 'insight', 'the tl267 receipt needs the executed line to count', 0.8, 'extraction', null, 'verified');

    global.fetch = mockOllama(() => ({
      ok: true, status: 200,
      json: async () => ({ response: JSON.stringify({
        keep: [],
        merge: [],
        insights: [{ fact_text: 'TL267 SUMMARY: deploys gate on reviews, briefs stay terse, receipts need the executed line', category: 'insight', confidence: 0.7 }]
      }) })
    }));
    const { runConsolidation } = await import('../../server/plugins/auto-memory/routes.js');
    const result = await runConsolidation(amDb, LLM_CONFIG, null);
    expect(result.facts_processed).toBeGreaterThanOrEqual(5);

    const insight = raw.prepare("SELECT * FROM am_facts WHERE source_type = 'consolidation' ORDER BY id DESC LIMIT 1").get();
    expect(insight).toBeTruthy();
    const refs = JSON.parse(insight.derived_from);
    // P1.1's ref vocabulary (trust-origins.js is the one definition): the
    // cascade walks THESE, so the writer must cite "am:<id>", not a private
    // format.
    expect(refs.sort()).toEqual(['am:' + f1, 'am:' + f2, 'am:' + f3, 'am:' + f4, 'am:' + f5].sort());
  });

  it('forgetting a fact deletes, unindexes and tombstones the summary derived from it — the fact is not recalled through the summary', async () => {
    const F_TEXT = 'the tl267 garden gate code is the year of the first frost festival';
    const fid = amDb.createFact(null, null, 'fact', F_TEXT, 0.9, 'extraction', null, 'verified');
    // Consolidation needs >= 5 current facts to run at all — fillers pad it.
    for (let i = 0; i < 4; i++) {
      amDb.createFact(null, null, 'filler', 'the tl267 filler note number ' + i + ' pads the consolidation floor', 0.5, 'extraction', null, 'inferred');
    }
    const { runConsolidation } = await import('../../server/plugins/auto-memory/routes.js');
    global.fetch = mockOllama(() => ({
      ok: true, status: 200,
      json: async () => ({ response: JSON.stringify({
        keep: [], merge: [],
        insights: [{ fact_text: 'TL267 SUMMARY: access notes — first frost festival year opens the garden gate', category: 'insight', confidence: 0.7 }]
      }) })
    }));
    await runConsolidation(amDb, LLM_CONFIG, null);
    const insight = raw.prepare("SELECT id FROM am_facts WHERE source_type = 'consolidation' ORDER BY id DESC LIMIT 1").get();
    expect(insight).toBeTruthy();

    // Both rows are in recall before the forget (searchHybrid returns rows).
    const hitThroughSummary = await memDb.searchHybrid('first frost festival garden gate');
    expect(hitThroughSummary.some((r) => String(r.source_id) === String(insight.id))).toBe(true);

    const res = amDb.deleteFact(fid, { by: 'lucy-tl267', reason: 'forget' });
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(res.cascaded).toBeGreaterThanOrEqual(1); // the summary went with it

    // The fact AND its summary are gone from the store, the index and the tombstones.
    expect(raw.prepare('SELECT COUNT(*) AS c FROM am_facts WHERE id IN (?, ?)').get(fid, insight.id).c).toBe(0);
    const indexRows = raw.prepare(
      "SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type IN ('memory','am_fact') AND CAST(source_id AS INTEGER) IN (?, ?)"
    ).get(fid, insight.id).c;
    expect(indexRows).toBe(0);
    expect(raw.prepare('SELECT COUNT(*) AS c FROM sm_tombstones WHERE source_type IN (\'memory\',\'am_fact\') AND CAST(source_id AS INTEGER) = ?').get(insight.id).c)
      .toBeGreaterThanOrEqual(1);

    // THE LAW, at recall: the forgotten fact is not recalled through its summary.
    const after = await memDb.searchHybrid('first frost festival garden gate');
    expect(after.length).toBe(0);
    const afterDirect = await memDb.searchHybrid('first frost festival year');
    expect(afterDirect.length).toBe(0);
  });

  it('the cascade is transitive: a summary derived from a summary falls with the root fact', async () => {
    const fid = amDb.createFact(null, null, 'fact', 'the tl267 lichen grows only on the north face basalt', 0.9, 'extraction', null, 'verified');
    for (let i = 0; i < 4; i++) {
      amDb.createFact(null, null, 'filler', 'the tl267 filler moss note number ' + i + ' pads the consolidation floor', 0.5, 'extraction', null, 'inferred');
    }
    // One consolidation reads it and writes S1; a second reads S1 and writes S2.
    global.fetch = mockOllama((() => {
      let call = 0;
      return () => {
        call++;
        const text = call === 1
          ? 'TL267 SUMMARY S1: lichen is a north-face basalt specialist'
          : 'TL267 SUMMARY S2: the moss census counts only what the north face basalt hosts';
        return { ok: true, status: 200, json: async () => ({ response: JSON.stringify({
          keep: [], merge: [], insights: [{ fact_text: text, category: 'insight', confidence: 0.7 }]
        }) }) };
      };
    })());
    const { runConsolidation } = await import('../../server/plugins/auto-memory/routes.js');
    await runConsolidation(amDb, LLM_CONFIG, null);
    const s1 = raw.prepare("SELECT id FROM am_facts WHERE source_type = 'consolidation' ORDER BY id ASC LIMIT 1").get();
    await runConsolidation(amDb, LLM_CONFIG, null);
    const s2 = raw.prepare("SELECT id FROM am_facts WHERE source_type = 'consolidation' ORDER BY id DESC LIMIT 1").get();
    expect(s2.id).not.toBe(s1.id);

    const res = amDb.deleteFact(fid, { by: 'lucy-tl267', reason: 'forget' });
    expect(res.cascaded).toBeGreaterThanOrEqual(2); // S1 and S2 both went
    expect(raw.prepare('SELECT COUNT(*) AS c FROM am_facts WHERE id = ?').get(s2.id).c).toBe(0);
    const recall = await memDb.searchHybrid('north face basalt');
    expect(recall.length).toBe(0);
  });

  it('a supersede is not a forget: the correction keeps the old row alive (no tombstone, no cascade)', async () => {
    const oldId = amDb.createFact(null, null, 'preference', 'the tl267 standup prefers the short form', 0.8, 'extraction', null, 'verified');
    const newId = amDb.createFact(null, null, 'preference', 'the tl267 standup prefers the long form with metrics', 0.8, 'extraction', null, 'verified');
    amDb.supersedeFact(oldId, newId);
    expect(raw.prepare('SELECT COUNT(*) AS c FROM am_facts WHERE id = ?').get(oldId).c).toBe(1); // alive, superseded
    expect(raw.prepare('SELECT COUNT(*) AS c FROM am_tombstones WHERE fact_id = ?').get(oldId).c).toBe(0);
  });
});

// ------------------------- FEDERATION REVOKE ---------------------------------

describe('P1.4 FEDERATION REVOKE: a souvenir forgotten at home is forgotten where it went', () => {
  const realFetch = global.fetch;
  let raw, app, visitor, visitId, hostToken, revokedRowId;

  const HOST_SEED = crypto.createHash('sha256').update('p14-revoke-host').digest('hex');
  const GUEST_SEED = crypto.createHash('sha256').update('p14-revoke-guest').digest('hex');
  const AGENT_SEED = crypto.createHash('sha256').update('p14-revoke-agent').digest('hex');
  const FED_DIR = join(HERE, '../../server/plugins/federation');
  const MEM_DIR = join(HERE, '../../server/plugins/semantic-memory');

  function jwtFor(userId) {
    return jwt.sign({ studioUser: true, userId, username: 'u' + userId, role: 'operator' }, JWT_SECRET, { expiresIn: '1h' });
  }

  beforeAll(async () => {
    raw = new Database(':memory:');
    raw.exec(SM_SCHEMA);
    raw.exec(AM_SCHEMA);
    raw.exec(readFileSync(join(FED_DIR, 'schema.sql'), 'utf8'));

    const core = {
      db: raw,
      auth: {
        getStudioUser: (req) => {
          const auth = req.headers['authorization'];
          if (!auth || !auth.startsWith('Bearer ')) return null;
          try { const d = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] }); return d && d.studioUser ? d : null; } catch (e) { return null; }
        },
        checkAdmin: (req, res) => {
          if (req.headers['x-admin-key'] === ADMIN_KEY) return 'admin-test';
          res.status(401).json({ error: 'admin key required' });
          return null;
        },
        getAdminDisplayName: () => 'admin-test'
      },
      apiError: (res, code, msg, extra) => res.status(code).json(Object.assign({ error: msg }, extra || {})),
      parseIntParam: (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; },
      asyncHandler: (fn) => function (req, res, next) { return Promise.resolve(fn(req, res, next)).catch(next); },
      emitEvent: () => {}
    };

    const { default: createFedRoutes } = await import(join(FED_DIR, 'routes.js'));
    const { default: createMemRoutes } = await import(join(MEM_DIR, 'routes.js'));
    app = express();
    app.use(express.json());
    app.use('/federation', createFedRoutes(core));
    app.use('/memory', createMemRoutes(core));

    const { makeVisitor } = await import(join(FED_DIR, 'client.js'));
    visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED, homeName: 'qurio-phone', agentName: 'Qurio-p14' });
    hostToken = jwtFor(4242);

    const admin = (p, b) => request(app).post(p).set('X-Admin-Key', ADMIN_KEY).send(b);
    await admin('/federation/network', {
      seed_hex: HOST_SEED, name: 'p14-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
    const knock = await visitor.hello({ post: async (path, body, headers) => {
      const r = request(app).post(path); for (const [k, v] of Object.entries(headers || {})) r.set(k, v); const res = await r.send(body); return { status: res.status, body: res.body };
    } });
    expect(knock.status).toBe(200);
    const grant = await request(app).post('/federation/grant')
      .set('Authorization', 'Bearer ' + hostToken).send({ agent_passport: visitor.agentPassport });
    expect(grant.status).toBe(201);
    visitId = grant.body.visit_id;

    const t = { post: async (path, body, headers) => {
      const r = request(app).post(path); for (const [k, v] of Object.entries(headers || {})) r.set(k, v); const res = await r.send(body); return { status: res.status, body: res.body };
    } };
    const write = await visitor.writeMemory(t, visitId, knock.body.network_passport.network_id, {
      kind: 'aboutYou', key: 'p14.souvenir',
      text: 'the p14 souvenir row the visitor will later forget at home',
      source: 'visit', at: '2026-10-06T08:00:00Z', supersedes: null
    });
    expect(write.status).toBe(201);
    // companionView.id is the per-owner STORAGE id — revoke names PROTOCOL ids.
    revokedRowId = write.body.row.provenance.id;
  });

  afterAll(() => { try { raw.close(); } catch (e) { /* closed */ } global.fetch = realFetch; });

  it('protocol: a revoke round-trips; a tampered row list fails the signature; garbage fails the shape', async () => {
    const { makeRevoke, verifyRevoke } = await import(join(FED_DIR, 'protocol.js'));
    const rev = makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [revokedRowId], {
      reason: 'forgotten at home', issued_at: new Date().toISOString()
    });
    const good = verifyRevoke(rev);
    expect(good.valid).toBe(true);
    expect(good.agent_id).toBe(visitor.agentId);

    const tampered = { ...rev, row_ids: [revokedRowId, 'sha256-deadbeef'] };
    expect(verifyRevoke(tampered).valid).toBe(false);
    expect(verifyRevoke(tampered).reason).toBe('revoke-sig');

    expect(verifyRevoke({ type: 'revoke-v0' }).valid).toBe(false);
    const noRows = makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [], { issued_at: new Date().toISOString() });
    expect(verifyRevoke(noRows).valid).toBe(false);
  });

  it('the revoke handler deletes the holder\'s copy, unindexes it and tombstones it — and only the author can revoke', async () => {
    // The row is in the host's store and recall before the revoke.
    const before = raw.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'companion' AND fed_agent = ?").get(visitor.agentId).c;
    expect(before).toBeGreaterThanOrEqual(1);
    const memBefore = await request(app).get('/memory/me/memory').set('Authorization', 'Bearer ' + hostToken);
    expect(memBefore.status).toBe(200);
    // companionView.id is the per-owner STORAGE id; the protocol id rides in provenance.id.
    expect(memBefore.body.results.find((r) => r.provenance && r.provenance.id === revokedRowId)).toBeTruthy();

    const { makeRevoke } = await import(join(FED_DIR, 'protocol.js'));
    const rev = makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [revokedRowId], {
      reason: 'forgotten at home', issued_at: new Date().toISOString()
    });
    const res = await request(app).post('/federation/revoke').send({ revoke: rev });
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(1);

    const after = raw.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'companion' AND fed_agent = ?").get(visitor.agentId).c;
    expect(after).toBe(0);
    const tombs = raw.prepare("SELECT * FROM sm_tombstones WHERE reason = 'federation-revoke' AND deleted_by = ?").all(visitor.agentId);
    expect(tombs.length).toBeGreaterThanOrEqual(1);
    // The tombstone never carries the content — only the row identity.
    expect(JSON.stringify(tombs)).not.toContain('p14 souvenir row the visitor will later forget');

    // Recall proves the row left the search index too.
    const mem = await request(app).get('/memory/me/memory').set('Authorization', 'Bearer ' + hostToken);
    expect(mem.status).toBe(200);
    expect(mem.body.results.find((r) => r.provenance && r.provenance.id === revokedRowId)).toBeUndefined();
  });

  it('a re-imported souvenir containing the revoked row is refused — no resurrection', async () => {
    // The visitor revokes BEFORE re-import: build a bundle by hand (makeBundle)
    // whose rows contain the revoked id, signed as a host would, and import.
    const { makeRow, makeNetworkPassport, makeVisitRecord, makeBundle } =
      await import(join(FED_DIR, 'protocol.js'));
    const { keyFromSeed, idForKey } = await import(join(FED_DIR, 'keys.js'));
    const hostKey = keyFromSeed(HOST_SEED);
    const hostId = idForKey(hostKey);
    const homeKey = keyFromSeed(GUEST_SEED);
    const homeId = idForKey(homeKey);

    const row = makeRow(visitor.agentKey, visitor.agentId, {
      // The EXACT fields of the original visit write — content addressing must
      // reproduce revokedRowId, or this bundle carries a row that was never revoked.
      kind: 'aboutYou', key: 'p14.souvenir',
      text: 'the p14 souvenir row the visitor will later forget at home',
      source: 'visit', at: '2026-10-06T08:00:00Z', supersedes: null
    }, { agent: visitor.agentId, network: hostId, home: homeId, visit: visitId });
    expect(row.id).toBe(revokedRowId); // same content → same protocol id

    const hostPassport = makeNetworkPassport(hostKey, hostId, {
      name: 'p14-host', policy: { visitors: true, kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] },
      issued_at: new Date().toISOString()
    });
    const visit = makeVisitRecord({
      visit_id: visitId, host_network: hostId, agent_id: visitor.agentId,
      home_network: homeId, grant_id: 'unused-for-shape', started_at: '2026-10-06T07:00:00Z', ended_at: '2026-10-06T08:00:00Z'
    });
    const bundle = makeBundle(hostKey, {
      host_passport: hostPassport, agent_passport: visitor.agentPassport, visit,
      rows: [row], issued_at: new Date().toISOString()
    });
    // A DIFFERENT owner imports (the host itself importing its own visit's
    // souvenir would hit the self-hosted 409 before adjudication).
    const res = await request(app).post('/federation/import')
      .set('Authorization', 'Bearer ' + jwtFor(9999)).send({ bundle });
    expect([200, 201]).toContain(res.status);
    const mine = res.body.outcomes.find((o) => o.row_id === row.id);
    expect(mine.outcome).toBe('revoked'); // the door refuses the dead row
    const inStore = raw.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'companion' AND json_extract(metadata, '$.fed_id') = ?").get(row.id).c;
    expect(inStore).toBe(0);
  });

  it('an unknown agent and a forged revoke are refused without deleting anything', async () => {
    const { makeRevoke } = await import(join(FED_DIR, 'protocol.js'));
    const { keyFromSeed, idForKey } = await import(join(FED_DIR, 'keys.js'));
    const STRANGER_SEED = crypto.createHash('sha256').update('p14-revoke-stranger').digest('hex');
    const stranger = idForKey(keyFromSeed(STRANGER_SEED));
    const forged = makeRevoke(keyFromSeed(STRANGER_SEED), stranger, 'some-home', [revokedRowId], {
      issued_at: new Date().toISOString()
    });
    const unknown = await request(app).post('/federation/revoke').send({ revoke: forged });
    expect([401, 403]).toContain(unknown.status);

    const badSig = { ...makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, ['sha256-aa'], { issued_at: new Date().toISOString() }), sig: 'ff' };
    const refused = await request(app).post('/federation/revoke').send({ revoke: badSig });
    expect(refused.status).toBe(400);
  });
});

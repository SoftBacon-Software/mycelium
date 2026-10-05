// TRUST LAYER P1.5 — the append-only, hash-chained memory audit log
// (2026-10-05, F-mycelium/264 — PROGRAM-mycelium-trust-layer-2026-09-26 §P1.5).
//
// The 09-26 audit's finding 6: Mycelium had no append-only audit —
// `memory_indexed` fired on /index + lesson supersede only, nothing on bulk,
// deletes, /me/memory, auto-memory or federation, and the events table was
// prunable by the same admins it would have accused. P1.5 closes that: every
// memory write / edit / delete / promote / import appends ONE row to
// `memory_audit` — {seq, at, actor (the AUTHENTICATED identity, never a body
// field), action, row id, the row's content hash after the action, reason
// (optional, the caller's), prev_hash, hash} — hash-chained
// (hash = sha256(prev_hash + canonical(row))), append-only at the storage
// layer (UPDATE/DELETE raise, housekeeping never touches it), readable by
// admin + the row's owner, verifiable end to end, and surfaced through
// GET /memory/audit, GET /memory/audit/verify and the safety MCP tools'
// GET /safety/events + /safety/events/stats.
//
// Each item is pinned against the REAL router with the REAL plugin routes
// mounted via initPlugins — the same harness as trust-layer-p0.test.js — on
// a fresh temp DB. The tamper test tampers a row DIRECTLY in the DB (after
// disarming the append-only triggers, i.e. the full-DB-write adversary the
// chain exists to catch) and shows verify names that seq.

process.env.MYCELIUM_RATE_LIMIT = 'off'; // limiters are proven in trust-layer-rate-limits.test.js

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const ADMIN_KEY = 'trust-layer-p15-admin-key-0123456789abcdef';
const JWT_SECRET = 'trust-layer-p15-jwt-secret';
const AGENT_A_KEY = 'dvk_' + 'a'.repeat(48); // lucy-tl264 — the writer
const AGENT_B_KEY = 'dvk_' + 'b'.repeat(48); // echo-tl264 — everyone else

let tmpDataDir;
let db;
let app;

const agentAuth = (key) => ({ 'X-Agent-Key': key });
const agentA = agentAuth(AGENT_A_KEY);
const agentB = agentAuth(AGENT_B_KEY);
const adminKeyAuth = { 'X-Admin-Key': ADMIN_KEY };

function jwtFor(userId, username, role) {
  return jwt.sign(
    { studioUser: true, userId, username, displayName: username, role },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}
const ownerAtoken = jwtFor(11, 'owner-a', 'operator'); // companion owner A (userId 11)
const ownerBtoken = jwtFor(12, 'owner-b', 'operator'); // companion owner B (userId 12)

function auditRows(where, params) {
  return db.getDB().prepare(
    'SELECT * FROM memory_audit' + (where ? ' WHERE ' + where : '') + ' ORDER BY seq'
  ).all(...(params || []));
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-trust-layer-p15-'));
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
  const hashB = crypto.createHash('sha256').update(AGENT_B_KEY).digest('hex');
  db.createAgent('lucy-tl264', 'Lucy TL264', 'trust-proj', hashA, '["code"]');
  db.createAgent('echo-tl264', 'Echo TL264', 'trust-proj', hashB, '["code"]');
});

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

// ---- 1. writes --------------------------------------------------------------

describe('P1.5 every memory write appends ONE hash-chained audit row', () => {
  test('POST /memory/index: one row, actor = the authenticated identity (a body actor never lands)', async () => {
    const before = auditRows().length;
    const res = await request(app).post('/api/mycelium/memory/index').set(agentA).send({
      source_type: 'preference',
      source_id: 'tl264-write-1',
      content_text: 'prefers plain sentences over bullet lists',
      metadata: { actor: 'NOT-LUCY', learned_at: '2026-10-05T10:00:00Z', evidence: 'said so' }
    });
    expect(res.status).toBe(200);

    const rows = auditRows("source_type = 'preference' AND source_id = 'tl264-write-1'");
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(auditRows().length).toBe(before + 1); // exactly ONE row for one write
    expect(r.actor).toBe('lucy-tl264'); // the AUTHENTICATED identity
    expect(r.actor).not.toBe('NOT-LUCY');
    expect(r.action).toBe('write');
    expect(r.at).toBeTruthy();
    expect(r.row_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.reason === null || r.reason === undefined).toBe(true); // optional, none given
  });

  test('the chain: hash = sha256(prev_hash + canonical(row)); prev_hash = the prior row\'s hash (genesis 0…0)', async () => {
    const rows = auditRows();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const { canonicalAuditRow } = await import('../../server/lib/memory-audit.js');
    let prev = '0'.repeat(64);
    for (const r of rows) {
      expect(r.prev_hash).toBe(prev);
      expect(r.hash).toBe(
        crypto.createHash('sha256').update(prev + canonicalAuditRow(r)).digest('hex')
      );
      prev = r.hash;
    }
  });

  test('a read appends nothing (the log records writes, not reads)', async () => {
    const before = auditRows().length;
    await request(app).post('/api/mycelium/memory/search').set(agentA).send({ query: 'plain sentences' });
    await request(app).get('/api/mycelium/memory/list?source_type=preference').set(agentA);
    expect(auditRows().length).toBe(before);
  });

  test('POST /memory/index/bulk: one audit row per item, each naming its row', async () => {
    const res = await request(app).post('/api/mycelium/memory/index/bulk').set(agentA).send({
      items: [
        { source_type: 'lesson', source_id: 'tl264-bulk-a', content_text: 'lesson one', metadata: { actor: 'lucy-tl264', learned_at: '2026-10-05', evidence: 'e' } },
        { source_type: 'lesson', source_id: 'tl264-bulk-b', content_text: 'lesson two', metadata: { actor: 'lucy-tl264', learned_at: '2026-10-05', evidence: 'e' } }
      ]
    });
    expect(res.status).toBe(200);
    const rows = auditRows("action = 'write' AND source_type = 'lesson' AND source_id LIKE 'tl264-bulk-%'");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.source_id).sort()).toEqual(['tl264-bulk-a', 'tl264-bulk-b']);
    for (const r of rows) expect(r.actor).toBe('lucy-tl264');
  });

  test('an admin-key write is audited with the admin identity', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(adminKeyAuth).send({
      source_type: 'note', source_id: 'tl264-admin-1', content_text: 'admin wrote this'
    });
    expect(res.status).toBe(200);
    const rows = auditRows("source_type = 'note' AND source_id = 'tl264-admin-1'");
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('__system__'); // the admin key's authenticated identity
    expect(rows[0].action).toBe('write');
  });

  test('PUT /memory/embeddings: a vector write is audited (action embed)', async () => {
    // The vector gate (P0.2) lets only the row's writer or the admin store a
    // vector — tl264-admin-1 was written by the admin key, so admin embeds it.
    const res = await request(app).put('/api/mycelium/memory/embeddings/note/tl264-admin-1')
      .set(adminKeyAuth)
      .send({ embedding: [0.1, 0.2, 0.3], model: 'test-model' });
    expect(res.status).toBe(200);
    const rows = auditRows("action = 'embed' AND source_type = 'note' AND source_id = 'tl264-admin-1'");
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('__system__');
    expect(rows[0].row_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---- 2. deletes (#193: audit every DELETE path) ------------------------------

describe('P1.5 every delete path is audited (the #193 lesson)', () => {
  test('DELETE /memory/index/:type/:id: a delete row whose row_hash pins the content AS DELETED', async () => {
    // source_type 'note' — no provenance gate; the gate has its own tests.
    await request(app).post('/api/mycelium/memory/index').set(agentA).send({
      source_type: 'note', source_id: 'tl264-doomed', content_text: 'the doomed note'
    });
    const victim = auditRows("source_type = 'note' AND source_id = 'tl264-doomed' AND action = 'write'");
    expect(victim.length).toBe(1);

    const del = await request(app).delete('/api/mycelium/memory/index/note/tl264-doomed').set(agentA);
    expect(del.status).toBe(200);
    const rows = auditRows("action = 'delete' AND source_type = 'note' AND source_id = 'tl264-doomed'");
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('lucy-tl264');
    expect(rows[0].row_hash).toBe(victim[0].row_hash); // what the chain knew the row to be
  });

  test('DELETE /memory/index (admin purge): ONE purge row naming the filter; agents cannot purge', async () => {
    const purge = await request(app).delete('/api/mycelium/memory/index?source_type=note').set(adminKeyAuth);
    expect(purge.status).toBe(200);
    const rows = auditRows("action = 'purge' AND source_type = 'note'");
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('__system__');

    const refused = await request(app).delete('/api/mycelium/memory/index?source_type=note').set(agentA);
    expect(refused.status).toBe(401); // no admin credential — checkAdmin's answer everywhere
  });
});

// ---- 3. the companion surface (owner is the person, not an agent) -----------

describe('P1.5 companion memory: audited with the owner, readable by the owner', () => {
  test('POST /me/memory + forget append write + delete rows owned by the user id', async () => {
    const w = await request(app).post('/api/mycelium/memory/me/memory')
      .set('Authorization', 'Bearer ' + ownerAtoken)
      .send({ text: 'Gilbert tests the audit log', source: 'chat', at: '2026-10-05T10:00:00Z', kind: 'aboutYou', key: 'audit.test' });
    expect(w.status).toBe(201);
    const rowId = w.body.row.id;

    const rows = auditRows("source_type = 'companion' AND source_id = ?", [rowId]);
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('write');
    expect(rows[0].actor).toBe('__user:owner-a'); // the AUTHENTICATED bearer
    expect(rows[0].row_owner).toBe('11'); // the row's owner scope

    const f = await request(app).post('/api/mycelium/memory/me/memory/' + rowId + '/forget')
      .set('Authorization', 'Bearer ' + ownerAtoken);
    expect(f.status).toBe(200);
    const del = auditRows("action = 'delete' AND source_type = 'companion' AND source_id = ?", [rowId]);
    expect(del.length).toBe(1);
    expect(del[0].actor).toBe('__user:owner-a');
  });

  test('GET /memory/audit?row=: admin and the row owner read it; anyone else gets 403 with a plain sentence', async () => {
    const w = await request(app).post('/api/mycelium/memory/me/memory')
      .set('Authorization', 'Bearer ' + ownerAtoken)
      .send({ text: 'A row only A and admin may audit', source: 'chat', at: '2026-10-05T10:01:00Z', kind: 'aboutYou' });
    const rowId = w.body.row.id;
    const path = '/api/mycelium/memory/audit?row=companion:' + encodeURIComponent(rowId);

    const asAdmin = await request(app).get(path).set(adminKeyAuth);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.rows.length).toBe(1);

    const asOwner = await request(app).get(path).set('Authorization', 'Bearer ' + ownerAtoken);
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.rows.length).toBe(1);

    const asStranger = await request(app).get(path).set('Authorization', 'Bearer ' + ownerBtoken);
    expect(asStranger.status).toBe(403);
    expect(typeof asStranger.body.error).toBe('string');
    expect(asStranger.body.error.length).toBeGreaterThan(20); // a plain sentence, not a code

    const asForeignAgent = await request(app).get(
      '/api/mycelium/memory/audit?row=preference:tl264-write-1').set(agentB);
    expect(asForeignAgent.status).toBe(403);
  });
});

// ---- 4. supersede (an edit) + lessons ---------------------------------------

describe('P1.5 edits: supersede audits the edited row AND the written one', () => {
  test('lesson supersede: edit row keeps the ORIGINAL owner; the new lesson gets its own write row', async () => {
    const w = await request(app).post('/api/mycelium/memory/index').set(agentA).send({
      source_type: 'lesson',
      source_id: 'tl264-lesson-1',
      content_text: 'always quote the receipt',
      metadata: { actor: 'lucy-tl264', learned_at: '2026-10-05', evidence: 'lane 250' }
    });
    expect(w.status).toBe(200);

    const sup = await request(app).post('/api/mycelium/memory/lessons/tl264-lesson-1/supersede').set(agentA).send({
      by_text: 'always quote the receipt AND its mtime',
      reason: 'mtime matters too',
      actor: 'lucy-tl264',
      evidence: 'lane 264 review'
    });
    expect(sup.status).toBe(200);

    const edit = auditRows("action = 'edit' AND source_type = 'lesson' AND source_id = 'tl264-lesson-1'");
    expect(edit.length).toBe(1);
    expect(edit[0].actor).toBe('lucy-tl264');
    expect(edit[0].row_owner).toBe('lucy-tl264'); // the flip keeps the row's original owner
    expect(edit[0].reason).toBe('mtime matters too'); // the caller's reason, verbatim

    const write = auditRows("action = 'write' AND source_type = 'lesson' AND source_id LIKE 'tl264-lesson-1-superseded-%'");
    expect(write.length).toBe(1);
    expect(write[0].actor).toBe('lucy-tl264');
  });
});

// ---- 5. auto-memory facts ----------------------------------------------------

describe('P1.5 auto-memory: facts create/edit/delete/purge are audited', () => {
  let factId;

  test('POST /auto-memory/facts: one write row, owner = the fact\'s agent', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentA).send({
      fact_text: 'the audit log lands with task 264',
      category: 'general'
    });
    expect(res.status).toBe(200);
    factId = res.body.id;
    const rows = auditRows("action = 'write' AND source_type = 'am_fact' AND source_id = ?", [String(factId)]);
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('lucy-tl264');
    expect(rows[0].row_owner).toBe('lucy-tl264');
  });

  test('POST /auto-memory/facts/:id/supersede: an edit row on the old fact', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentA).send({
      fact_text: 'the audit log landed with task 264 (confirmed)'
    });
    const newId = res.body.id;
    const sup = await request(app).post('/api/mycelium/auto-memory/facts/' + factId + '/supersede').set(agentA)
      .send({ new_id: newId });
    expect(sup.status).toBe(200);
    const rows = auditRows("action = 'edit' AND source_type = 'am_fact' AND source_id = ?", [String(factId)]);
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe('lucy-tl264');
  });

  test('DELETE /auto-memory/facts/:id (admin): a delete row; DELETE /facts?namespace= a purge row', async () => {
    const del = await request(app).delete('/api/mycelium/auto-memory/facts/' + factId).set(adminKeyAuth);
    expect(del.status).toBe(200);
    expect(auditRows("action = 'delete' AND source_type = 'am_fact' AND source_id = ?", [String(factId)]).length).toBe(1);

    await request(app).post('/api/mycelium/auto-memory/facts').set(agentA).send({
      fact_text: 'a namespaced fact that will be purged', namespace: 'tl264-purge-ns'
    });
    const purge = await request(app).delete('/api/mycelium/auto-memory/facts?namespace=tl264-purge-ns').set(adminKeyAuth);
    expect(purge.status).toBe(200);
    const rows = auditRows("action = 'purge' AND source_type = 'am_fact'");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[rows.length - 1].actor).toBe('__system__');
  });

  test('housekeeping prunes are audited as system deletes, never silent (#193)', async () => {
    // A superseded fact old enough for pruneOldSuperseded('30 days') to take.
    const a = await request(app).post('/api/mycelium/auto-memory/facts').set(agentA).send({
      fact_text: 'an old fact that will be house-pruned', namespace: 'tl264-housekeep-ns'
    });
    const b = await request(app).post('/api/mycelium/auto-memory/facts').set(agentA).send({
      fact_text: 'its replacement, so the first is superseded', namespace: 'tl264-housekeep-ns'
    });
    await request(app).post('/api/mycelium/auto-memory/facts/' + a.body.id + '/supersede').set(agentA)
      .send({ new_id: b.body.id, namespace: 'tl264-housekeep-ns' });
    db.getDB().prepare("UPDATE am_facts SET updated_at = datetime('now', '-40 days') WHERE id = ?").run(a.body.id);

    const createAutoMemoryDB = (await import('../../server/plugins/auto-memory/db.js')).default;
    createAutoMemoryDB(db.getDB()).pruneOldSuperseded('30 days');

    const rows = auditRows("action = 'purge' AND source_type = 'am_fact' AND actor = 'system:housekeeping'");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---- 6. append-only at the storage layer ------------------------------------

describe('P1.5 the storage layer is append-only', () => {
  test('UPDATE and DELETE on memory_audit raise (the append-only triggers hold)', async () => {
    const raw = db.getDB();
    expect(() => raw.prepare('UPDATE memory_audit SET actor = "x"').run()).toThrow();
    expect(() => raw.prepare('DELETE FROM memory_audit').run()).toThrow();
  });

  test('GET /memory/audit/verify: ok on the clean chain, naming the tampered seq after a direct DB tamper', async () => {
    const clean = await request(app).get('/api/mycelium/memory/audit/verify').set(adminKeyAuth);
    expect(clean.status).toBe(200);
    expect(clean.body.ok).toBe(true);
    expect(clean.body.first_bad_seq).toBe(null);
    expect(clean.body.length).toBe(auditRows().length);

    // The full-DB-write adversary: disarm the triggers, tamper row 2's actor.
    const raw = db.getDB();
    raw.prepare('DROP TRIGGER IF EXISTS memory_audit_no_update').run();
    const target = auditRows()[1];
    raw.prepare('UPDATE memory_audit SET actor = ? WHERE seq = ?').run('attacker', target.seq);

    const after = await request(app).get('/api/mycelium/memory/audit/verify').set(adminKeyAuth);
    expect(after.status).toBe(200);
    expect(after.body.ok).toBe(false);
    expect(after.body.first_bad_seq).toBe(target.seq);
    expect(after.body.length).toBe(auditRows().length);
  });

  test('verify is admin-only; /memory/audit?since= is owner-scoped', async () => {
    // An agent key holds no admin credential — checkAdmin 401s it, exactly as
    // it does on every other admin route in this API.
    const asAgent = await request(app).get('/api/mycelium/memory/audit/verify').set(agentA);
    expect(asAgent.status).toBe(401);

    const mine = await request(app).get('/api/mycelium/memory/audit?since=0').set(agentA);
    expect(mine.status).toBe(200);
    expect(mine.body.rows.length).toBeGreaterThan(0);
    for (const r of mine.body.rows) {
      // A non-admin sees only rows on memory it owns (or acted on as the owner).
      expect(['lucy-tl264', '__user:owner-a', '11']).toContain(r.row_owner);
    }
    const asStranger = await request(app).get('/api/mycelium/memory/audit?since=0')
      .set('Authorization', 'Bearer ' + ownerBtoken);
    expect(asStranger.status).toBe(200);
    expect(asStranger.body.rows.length).toBe(0);
  });
});

// ---- 7. the safety MCP tools get a real route --------------------------------

describe('P1.5 the dead safety MCP tools read the audit log', () => {
  test('GET /safety/events: an MCP-shaped array (action/agent_id/severity/command/reason/created_at); filters work', async () => {
    const res = await request(app).get('/api/mycelium/safety/events?limit=50').set(adminKeyAuth);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const e of res.body) {
      expect(e.action).toBeTruthy();
      expect(e.agent_id).toBeTruthy();
      expect(e.created_at).toBeTruthy();
    }
    const dels = await request(app).get('/api/mycelium/safety/events?action=delete&limit=500').set(adminKeyAuth);
    expect(dels.status).toBe(200);
    expect(dels.body.length).toBeGreaterThan(0);
    for (const e of dels.body) expect(e.action).toBe('delete');
  });

  test('GET /safety/events/stats: {total, breakdown} like the tool renders', async () => {
    const res = await request(app).get('/api/mycelium/safety/events/stats').set(adminKeyAuth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.breakdown)).toBe(true);
    for (const b of res.body.breakdown) {
      expect(b.action).toBeTruthy();
      expect(b.count).toBeGreaterThan(0);
    }
  });

  test('the safety events surface is admin-only (cross-agent activity is an admin read)', async () => {
    // Agent keys hold no admin credential — the same 401 every admin route
    // gives them; a non-admin studio JWT would get 403.
    expect((await request(app).get('/api/mycelium/safety/events').set(agentA)).status).toBe(401);
    expect((await request(app).get('/api/mycelium/safety/events').set(agentB)).status).toBe(401);
    expect((await request(app).get('/api/mycelium/safety/events/stats').set(agentA)).status).toBe(401);
    expect((await request(app).get('/api/mycelium/safety/events').set({ Authorization: 'Bearer ' + jwtFor(13, 'op', 'operator') })).status).toBe(403);
  });
});

// ---- 8. federation: visit writes + imports ----------------------------------

describe('P1.5 federation: visit writes and imports are audited', () => {
  // The same harness shape as federation-routes.test.js (two minimal apps with
  // the real plugin routers) — the audit table self-ensures from the lib.
  let hostApp; let homeApp; let visitor; let grantRes; let bundle; let rawHost; let rawHome;

  const HOST_SEED = crypto.createHash('sha256').update('p15-host').digest('hex');
  const GUEST_SEED = crypto.createHash('sha256').update('p15-guest').digest('hex');

  async function makeFedApp() {
    const { default: Database } = await import('better-sqlite3');
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname } = await import('node:path');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const raw = new Database(':memory:');
    raw.exec(readFileSync(join(root, 'server', 'plugins', 'semantic-memory', 'schema.sql'), 'utf8'));
    raw.exec(readFileSync(join(root, 'server', 'plugins', 'federation', 'schema.sql'), 'utf8'));
    const core = {
      db: raw,
      auth: {
        getStudioUser: (req) => {
          const auth = req.headers.authorization;
          if (!auth || !auth.startsWith('Bearer ')) return null;
          try {
            const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
            return decoded && decoded.studioUser ? decoded : null;
          } catch (e) { return null; }
        },
        checkAdmin: (req, res) => {
          if (req.headers['x-admin-key'] === ADMIN_KEY) return '__system__';
          res.status(401).json({ error: 'admin key required' });
          return null;
        },
        checkAgentOrAdmin: () => null,
        getAdminDisplayName: () => '__system__'
      },
      apiError: (res, code, msg, extra) => res.status(code).json(Object.assign({ error: msg }, extra || {})),
      parseIntParam: (v) => { const n = parseInt(v, 10); return isNaN(n) ? null : n; },
      asyncHandler: (fn) => function (req, res, next) {
        return Promise.resolve(fn(req, res, next)).catch(next);
      },
      emitEvent: () => {}
    };
    const { default: createFedRoutes } = await import(join(root, 'server', 'plugins', 'federation', 'routes.js'));
    const { default: createMemRoutes } = await import(join(root, 'server', 'plugins', 'semantic-memory', 'routes.js'));
    const a = express();
    a.use(express.json());
    a.use('/federation', createFedRoutes(core));
    a.use('/memory', createMemRoutes(core));
    return { app: a, raw };
  }

  beforeAll(async () => {
    const { makeVisitor } = await import('../../server/plugins/federation/client.js');
    const { keyFromSeed, idForKey } = await import('../../server/plugins/federation/keys.js');
    const HOST_ID = idForKey(keyFromSeed(HOST_SEED));
    const made1 = await makeFedApp(); const made2 = await makeFedApp();
    hostApp = made1.app; rawHost = made1.raw;
    homeApp = made2.app; rawHome = made2.raw;

    const adminPost = (a, path, body) =>
      request(a).post(path).set('X-Admin-Key', ADMIN_KEY).send(body);
    const tokenHost = jwtFor(21, 'host-owner', 'operator');
    const tokenHome = jwtFor(22, 'home-owner', 'operator');
    hostApp.tokenHost = tokenHost;
    homeApp.tokenHome = tokenHome;

    await adminPost(hostApp, '/federation/network', {
      seed_hex: HOST_SEED, name: 'p15-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
    await adminPost(homeApp, '/federation/network', { seed_hex: GUEST_SEED, name: 'p15-home' });

    visitor = makeVisitor({
      homeSeed: GUEST_SEED, agentSeed: crypto.createHash('sha256').update('p15-agent').digest('hex'),
      homeName: 'p15-home', agentName: 'P15 Visitor'
    });
    const transport = {
      async post(path, body, headers) {
        const req = request(hostApp).post(path);
        for (const [k, v] of Object.entries(headers || {})) req.set(k, v);
        const res = await req.send(body);
        return { status: res.status, body: res.body };
      }
    };
    await visitor.hello(transport);
    const grant = await request(hostApp).post('/federation/grant')
      .set('Authorization', 'Bearer ' + tokenHost)
      .send({ agent_passport: visitor.agentPassport });
    expect(grant.status).toBe(201);
    grantRes = grant.body;

    const dance = await visitor.writeMemory(transport, grantRes.visit_id, HOST_ID, {
      kind: 'aboutYou', key: 'p15.visit', text: 'visited during task 264',
      source: 'visit', at: '2026-10-05T10:00:00Z', supersedes: null
    });
    expect([200, 201]).toContain(dance.status);

    const souv = await visitor.requestSouvenir(transport, grantRes.visit_id);
    expect(souv.status).toBe(200);
    bundle = souv.body.bundle;

    const imp = await request(homeApp).post('/federation/import')
      .set('Authorization', 'Bearer ' + tokenHome)
      .send({ bundle });
    expect(imp.status).toBe(201);
  });

  test('the host audit log records the VISITOR\'s write under the host owner\'s scope', () => {
    const rows = rawHost.prepare("SELECT * FROM memory_audit WHERE source_type = 'companion' AND action = 'write'").all();
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe(visitor.agentId); // the authenticated visitor (grant-bound)
    expect(rows[0].row_owner).toBe('21'); // the host owner's user id
    expect(rows[0].reason).toContain('federation');
  });

  test('the home audit log records each imported row as an import by the home owner', () => {
    const rows = rawHome.prepare("SELECT * FROM memory_audit WHERE action = 'import'").all();
    expect(rows.length).toBe(bundle.rows.length);
    for (const r of rows) {
      expect(r.actor).toBe('__user:home-owner');
      expect(r.row_owner).toBe('22');
      expect(r.row_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

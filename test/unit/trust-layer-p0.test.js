// TRUST LAYER P0 — auth tightening + write authority bound to the caller
// (2026-09-26, F-mycelium/250 — PROGRAM-mycelium-trust-layer-2026-09-26 P0.1 + P0.2).
//
// The audit (research/2026-09-26-memory-safety-frontier/AUDIT.md) named the
// hole: ANY studio JWT was equivalent to an agent on /memory/* (a non-admin
// operator could search, index over, and delete agent memory), provenance
// actor fields were self-asserted and never bound to the authenticated
// caller, POST /studio/users defaulted new users to role 'admin', PUT
// /auto-memory/config echoed the LLM key unmasked, and an agent key could
// overwrite or delete any non-companion row regardless of who wrote it.
//
// Each item below is pinned at the layer the request actually hits: the REAL
// router with the REAL plugin routes mounted via initPlugins — the same
// harness as auth-roles.test.js plus the plugin load — on a fresh temp DB.
// No fixture mirrors the guard; the guard itself answers these requests.
//
//   P0.1  a studio JWT is refused on agent /memory/* (and the agent-facing
//         /auto-memory/* routes) unless its role grants it; companion
//         /me/memory is unchanged; purge stays admin-only.
//   P0.1  POST /studio/users defaults to the least-privileged role and only
//         the admin key can mint an admin.
//   P0.1  PUT /auto-memory/config masks llm_api_key exactly like GET.
//   P0.2  actor / agent / agent_id provenance is the AUTHENTICATED identity;
//         a mismatching body value is kept as claimed_* and never trusted;
//         source_authority 'directive' is admin-key only; fact_text is capped.
//   P0.2  an agent key may overwrite/delete only rows it wrote (written_by);
//         owner-unknown rows (everything written before this column) are
//         admin-only mutations; refusals are 403 with a plain sentence.

process.env.MYCELIUM_RATE_LIMIT = 'off'; // limiters are proven in trust-layer-rate-limits.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const ADMIN_KEY = 'trust-layer-admin-key-0123456789abcdef';
const JWT_SECRET = 'trust-layer-p0-jwt-secret';
const AGENT_A_KEY = 'dvk_' + 'a'.repeat(48); // lucy-tl250 — the writer
const AGENT_B_KEY = 'dvk_' + 'b'.repeat(48); // echo-tl250 — everyone else

let tmpDataDir;
let db;
let app;

function jwtFor(role) {
  return jwt.sign(
    { studioUser: true, userId: 999, username: role + '-user', displayName: role + '-user', role },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}
const operatorAuth = { Authorization: 'Bearer ' + jwtFor('operator') };
const adminJwtAuth = { Authorization: 'Bearer ' + jwtFor('admin') };
const agentAuth = (key) => ({ 'X-Agent-Key': key });
const adminKeyAuth = { 'X-Admin-Key': ADMIN_KEY };

function rowMeta(sourceType, sourceId) {
  const r = db.getDB().prepare(
    'SELECT metadata, written_by FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = 0'
  ).get(sourceType, sourceId);
  return { ...r, meta: r && r.metadata ? JSON.parse(r.metadata) : null };
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-trust-layer-p0-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = JWT_SECRET;

  db = await import('../../server/db.js');
  db.initDB();

  const routes = (await import('../../server/routes/mycelium.js')).default;
  app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/mycelium', routes);
  const { initPlugins } = await import('../../server/routes/mycelium.js');
  await initPlugins(app); // mounts the REAL semantic-memory + auto-memory routers

  const hashA = crypto.createHash('sha256').update(AGENT_A_KEY).digest('hex');
  const hashB = crypto.createHash('sha256').update(AGENT_B_KEY).digest('hex');
  db.createAgent('lucy-tl250', 'Lucy TL250', 'trust-proj', hashA, '["code"]');
  db.createAgent('echo-tl250', 'Echo TL250', 'trust-proj', hashB, '["code"]');
});

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

// ============================ P0.1 — the studio-JWT refusal ============================

describe('P0.1 a studio JWT is not an agent on /memory/*', () => {
  it('refuses POST /memory/search (was: any studio JWT searched agent memory)', async () => {
    const res = await request(app).post('/api/mycelium/memory/search')
      .set(operatorAuth).send({ query: 'agent memory' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/studio/i);
  });

  it('refuses POST /memory/index', async () => {
    const res = await request(app).post('/api/mycelium/memory/index')
      .set(operatorAuth).send({ source_type: 'note', source_id: 'op-write', content_text: 'operator write' });
    expect(res.status).toBe(403);
  });

  it('refuses POST /memory/index/bulk', async () => {
    const res = await request(app).post('/api/mycelium/memory/index/bulk')
      .set(operatorAuth).send({ items: [{ source_type: 'note', source_id: 'op-bulk', content_text: 'x' }] });
    expect(res.status).toBe(403);
  });

  it('refuses DELETE /memory/index/:sourceType/:sourceId', async () => {
    const res = await request(app).delete('/api/mycelium/memory/index/note/some-doc').set(operatorAuth);
    expect(res.status).toBe(403);
  });

  it('keeps DELETE /memory/index (purge) admin-only', async () => {
    const res = await request(app).delete('/api/mycelium/memory/index?source_type=note').set(operatorAuth);
    expect(res.status).toBe(403);
  });

  it('refuses GET /memory/list (reads are agent memory too)', async () => {
    const res = await request(app).get('/api/mycelium/memory/list?source_type=note').set(operatorAuth);
    expect(res.status).toBe(403);
  });

  it('refuses POST /memory/lessons/:id/supersede (a write)', async () => {
    const res = await request(app).post('/api/mycelium/memory/lessons/whatever/supersede')
      .set(operatorAuth).send({ reason: 'x', actor: 'operator-user', evidence: 'y', by_text: 'z' });
    expect(res.status).toBe(403);
  });

  it('admin JWT still passes (its role grants it)', async () => {
    const res = await request(app).post('/api/mycelium/memory/search')
      .set(adminJwtAuth).send({ query: 'agent memory', mode: 'keyword' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('results');
  });

  it('an agent key still passes, unchanged', async () => {
    const res = await request(app).post('/api/mycelium/memory/search')
      .set(agentAuth(AGENT_A_KEY)).send({ query: 'agent memory', mode: 'keyword' });
    expect(res.status).toBe(200);
  });

  it("role 'agent' is the granted studio exception (authenticates, not admin)", async () => {
    const res = await request(app).post('/api/mycelium/memory/index')
      .set({ Authorization: 'Bearer ' + jwtFor('agent') })
      .send({ source_type: 'note', source_id: 'granted-agent-write', content_text: 'granted studio identity write' });
    expect(res.status).toBe(200);
  });

  it('companion /me/memory is unchanged (studio bearer still works there)', async () => {
    const res = await request(app).get('/api/mycelium/memory/me/memory').set(operatorAuth);
    expect(res.status).toBe(200);
  });
});

describe('P0.1 the same refusal on the agent-facing /auto-memory/* routes', () => {
  it('refuses GET /auto-memory/facts', async () => {
    const res = await request(app).get('/api/mycelium/auto-memory/facts').set(operatorAuth);
    expect(res.status).toBe(403);
  });

  it('refuses POST /auto-memory/facts', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts')
      .set(operatorAuth).send({ fact_text: 'an operator should not write agent facts' });
    expect(res.status).toBe(403);
  });

  it('refuses POST /auto-memory/extract', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/extract')
      .set(operatorAuth).send({ text: 'some agent activity to extract from' });
    expect(res.status).toBe(403);
  });

  it('an agent key still reads its facts, unchanged', async () => {
    const res = await request(app).get('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY));
    expect(res.status).toBe(200);
  });
});

// ============================ P0.1 — studio/users default role ============================

describe('P0.1 POST /studio/users defaults to the least-privileged role', () => {
  it('defaults to operator, never admin (was: role defaulted to admin)', async () => {
    const res = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'tl-default', password: 'password123', display_name: 'TL Default' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('operator');
  });

  it('refuses role admin from a studio admin JWT — only the admin key mints admins', async () => {
    const res = await request(app).post('/api/mycelium/studio/users').set(adminJwtAuth)
      .send({ username: 'tl-via-jwt', password: 'password123', display_name: 'TL JWT', role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key/i);
  });

  it('still creates an admin when the ADMIN KEY asks for one', async () => {
    const res = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'tl-via-key', password: 'password123', display_name: 'TL Key', role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  it('an explicit operator role still works', async () => {
    const res = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'tl-explicit-op', password: 'password123', display_name: 'TL Op', role: 'operator' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('operator');
  });
});

// ============================ P0.1 — config key masking ============================

describe('P0.1 PUT /auto-memory/config masks the LLM key exactly like GET', () => {
  it('PUT answers with the masked key (was: echoed it unmasked)', async () => {
    const res = await request(app).put('/api/mycelium/auto-memory/config').set(adminKeyAuth)
      .send({ llm_provider: 'ollama', llm_api_key: 'sk-trust-layer-secret' });
    expect(res.status).toBe(200);
    expect(res.body.config.llm_api_key).toBe('***');
  });

  it('GET answers with the same mask (control)', async () => {
    const res = await request(app).get('/api/mycelium/auto-memory/config').set(adminKeyAuth);
    expect(res.status).toBe(200);
    expect(res.body.llm_api_key).toBe('***');
  });
});

// ============================ P0.2 — provenance bound to the caller ============================

describe('P0.2 lesson/verdict/episode actor is the authenticated identity', () => {
  it('rewrites a mismatching actor to the caller and keeps the claim (was: stored the self-asserted actor)', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY)).send({
      source_type: 'lesson', source_id: 'tl-liar-lesson',
      content_text: 'always quote the receipt',
      metadata: { actor: 'fabricated-actor', learned_at: '2026-09-26T00:00:00Z', evidence: 'the run log' }
    });
    expect(res.status).toBe(200);
    const { meta } = rowMeta('lesson', 'tl-liar-lesson');
    expect(meta.actor).toBe('lucy-tl250');            // the AUTHENTICATED identity
    expect(meta.claimed_actor).toBe('fabricated-actor'); // the claim, kept and flagged
  });

  it('leaves a matching actor alone (no claim field)', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY)).send({
      source_type: 'lesson', source_id: 'tl-honest-lesson',
      content_text: 'measure before trusting',
      metadata: { actor: 'lucy-tl250', learned_at: '2026-09-26T00:00:00Z', evidence: 'the run log' }
    });
    expect(res.status).toBe(200);
    const { meta } = rowMeta('lesson', 'tl-honest-lesson');
    expect(meta.actor).toBe('lucy-tl250');
    expect(meta.claimed_actor).toBeUndefined();
  });

  it('the admin key still writes provenance on behalf of a named actor (bench/harness compat)', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(adminKeyAuth).send({
      source_type: 'lesson', source_id: 'tl-admin-lesson',
      content_text: 'harness writers name their actor',
      metadata: { actor: 'harness-writer', learned_at: '2026-09-26T00:00:00Z', evidence: 'the run log' }
    });
    expect(res.status).toBe(200);
    const { meta } = rowMeta('lesson', 'tl-admin-lesson');
    expect(meta.actor).toBe('harness-writer');
    expect(meta.claimed_actor).toBeUndefined();
  });

  it('binds an episode row the same way (metadata.agent)', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY)).send({
      source_type: 'episode', source_id: 'tl-liar-episode',
      content_text: 'session transcript content',
      metadata: { agent: 'someone-else', session_date: '2026-09-26' }
    });
    expect(res.status).toBe(200);
    const { meta } = rowMeta('episode', 'tl-liar-episode');
    expect(meta.agent).toBe('lucy-tl250');
    expect(meta.claimed_actor).toBe('someone-else');
  });
});

describe('P0.2 /auto-memory/facts agent_id is the authenticated identity', () => {
  it('rewrites a mismatching agent_id and records the claim (was: trusted the body)', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY)).send({
      fact_text: 'the deploy gate refuses on a red receipt',
      agent_id: 'kira-tl250'
    });
    expect(res.status).toBe(200);
    expect(res.body.fact.agent_id).toBe('lucy-tl250');
    expect(res.body.fact.claimed_agent_id).toBe('kira-tl250');
  });

  it('leaves a self-named agent_id alone (no claim)', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY)).send({
      fact_text: 'lucy writes her own facts under her own id',
      agent_id: 'lucy-tl250'
    });
    expect(res.status).toBe(200);
    expect(res.body.fact.agent_id).toBe('lucy-tl250');
    expect(res.body.fact.claimed_agent_id).toBeUndefined();
  });

  it('the admin key still writes facts for another agent (bench compat)', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(adminKeyAuth).send({
      fact_text: 'bench agents are written by the admin key on purpose',
      agent_id: 'bench-agent-tl250'
    });
    expect(res.status).toBe(200);
    expect(res.body.fact.agent_id).toBe('bench-agent-tl250');
    expect(res.body.fact.claimed_agent_id).toBeUndefined();
  });

  it("refuses source_authority 'directive' from an agent key (decay-exempt provenance)", async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY)).send({
      fact_text: 'an agent must not grant its own directives',
      source_authority: 'directive'
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/directive/i);
  });

  it("still accepts source_authority 'directive' from the admin key", async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(adminKeyAuth).send({
      fact_text: 'a real directive comes from the operator through the admin key',
      source_authority: 'directive'
    });
    expect(res.status).toBe(200);
    expect(res.body.fact.source_authority).toBe('directive');
  });

  it('caps fact_text (was: unbounded)', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY)).send({
      fact_text: 'x'.repeat(2001)
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fact_text/i);
  });

  it('accepts fact_text at the cap (boundary control)', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY)).send({
      fact_text: 'y'.repeat(2000)
    });
    expect(res.status).toBe(200);
  });
});

// ============================ P0.2 — write authority: the owner column ============================

describe('P0.2 an agent key overwrites/deletes only rows it wrote', () => {
  const DOC = { type: 'note', id: 'tl-owned-doc' };

  it('records the writer on write (written_by)', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY)).send({
      source_type: DOC.type, source_id: DOC.id, content_text: 'lucy wrote this'
    });
    expect(res.status).toBe(200);
    expect(rowMeta(DOC.type, DOC.id).written_by).toBe('lucy-tl250');
  });

  it("refuses another agent's overwrite with a plain sentence (was: silently overwrote)", async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_B_KEY)).send({
      source_type: DOC.type, source_id: DOC.id, content_text: 'echo rewriting lucy row'
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/lucy-tl250/);
    const content = db.getDB().prepare(
      "SELECT content_text FROM sm_embeddings WHERE source_type = 'note' AND source_id = 'tl-owned-doc'"
    ).get();
    expect(content.content_text).toBe('lucy wrote this'); // untouched
  });

  it('still lets the owner update its own row', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY)).send({
      source_type: DOC.type, source_id: DOC.id, content_text: 'lucy updated this'
    });
    expect(res.status).toBe(200);
  });

  it('the admin key keeps full access (overwrites any row)', async () => {
    const res = await request(app).post('/api/mycelium/memory/index').set(adminKeyAuth).send({
      source_type: DOC.type, source_id: DOC.id, content_text: 'admin corrected this'
    });
    expect(res.status).toBe(200);
  });

  it('refuses a bulk overwrite of someone else’s row', async () => {
    const res = await request(app).post('/api/mycelium/memory/index/bulk').set(agentAuth(AGENT_B_KEY)).send({
      items: [{ source_type: DOC.type, source_id: DOC.id, content_text: 'echo bulk rewrite' }]
    });
    expect(res.status).toBe(403);
  });

  it('owner-unknown rows (pre-column) are admin-only mutations', async () => {
    // Simulate the migration state: a row written before written_by existed.
    db.getDB().prepare(
      "INSERT INTO sm_embeddings (source_type, source_id, chunk_index, content_text) VALUES ('note', 'tl-legacy-doc', 0, 'written before authority')"
    ).run();
    db.getDB().prepare("UPDATE sm_embeddings SET written_by = NULL WHERE source_type = 'note' AND source_id = 'tl-legacy-doc'").run();

    const asAgent = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY)).send({
      source_type: 'note', source_id: 'tl-legacy-doc', content_text: 'agent rewriting a legacy row'
    });
    expect(asAgent.status).toBe(403);
    expect(asAgent.body.error).toMatch(/no recorded owner/i);

    const asAdmin = await request(app).post('/api/mycelium/memory/index').set(adminKeyAuth).send({
      source_type: 'note', source_id: 'tl-legacy-doc', content_text: 'admin rewrote the legacy row'
    });
    expect(asAdmin.status).toBe(200);
  });

  it('refuses another agent’s delete, allows the owner’s, and the admin’s', async () => {
    const refused = await request(app).delete('/api/mycelium/memory/index/note/tl-owned-doc').set(agentAuth(AGENT_B_KEY));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/owner|admin/i);
    expect(db.getDB().prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'note' AND source_id = 'tl-owned-doc'").get().c)
      .toBeGreaterThan(0);

    const legacyRefused = await request(app).delete('/api/mycelium/memory/index/note/tl-legacy-doc').set(agentAuth(AGENT_A_KEY));
    expect(legacyRefused.status).toBe(403);

    const ownerDeleted = await request(app).delete('/api/mycelium/memory/index/note/tl-owned-doc').set(agentAuth(AGENT_A_KEY));
    expect(ownerDeleted.status).toBe(200);
    expect(db.getDB().prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'note' AND source_id = 'tl-owned-doc'").get().c)
      .toBe(0);

    const adminDeleted = await request(app).delete('/api/mycelium/memory/index/note/tl-legacy-doc').set(adminKeyAuth);
    expect(adminDeleted.status).toBe(200);
  });

  it('refuses an agent superseding a lesson it did not write; the owner and admin still can', async () => {
    const wrote = await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY)).send({
      source_type: 'lesson', source_id: 'tl-supersede-lesson',
      content_text: 'the original lesson',
      metadata: { actor: 'lucy-tl250', learned_at: '2026-09-26T00:00:00Z', evidence: 'run 1' }
    });
    expect(wrote.status).toBe(200);

    const refused = await request(app).post('/api/mycelium/memory/lessons/tl-supersede-lesson/supersede')
      .set(agentAuth(AGENT_B_KEY))
      .send({ reason: 'wrong', actor: 'echo-tl250', evidence: 'run 2', by_text: 'the corrected lesson' });
    expect(refused.status).toBe(403);

    const ownerOk = await request(app).post('/api/mycelium/memory/lessons/tl-supersede-lesson/supersede')
      .set(agentAuth(AGENT_A_KEY))
      .send({ reason: 'refined', actor: 'lucy-tl250', evidence: 'run 2', by_text: 'the corrected lesson' });
    expect(ownerOk.status).toBe(200);

    const adminTarget = await request(app).post('/api/mycelium/memory/index').set(adminKeyAuth).send({
      source_type: 'lesson', source_id: 'tl-supersede-admin-lesson',
      content_text: 'an admin-written lesson',
      metadata: { actor: 'harness-writer', learned_at: '2026-09-26T00:00:00Z', evidence: 'run 1' }
    });
    expect(adminTarget.status).toBe(200);
    const byAgent = await request(app).post('/api/mycelium/memory/lessons/tl-supersede-admin-lesson/supersede')
      .set(agentAuth(AGENT_A_KEY))
      .send({ reason: 'refined', actor: 'lucy-tl250', evidence: 'run 2', by_text: 'the corrected admin lesson' });
    expect(byAgent.status).toBe(403); // an admin-written row is admin-mutable

    const byAdmin = await request(app).post('/api/mycelium/memory/lessons/tl-supersede-admin-lesson/supersede')
      .set(adminKeyAuth)
      .send({ reason: 'refined', actor: 'harness-writer', evidence: 'run 2', by_text: 'the admin-corrected lesson' });
    expect(byAdmin.status).toBe(200);
  });
});

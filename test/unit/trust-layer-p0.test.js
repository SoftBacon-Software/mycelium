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

// ============================ Review A (task 250b) ============================
// Review A on PR #190 (@ e1089d1d, CHANGES REQUESTED) re-verified the six
// mandated P0 behaviors clean, then found two BLOCKERS through doors the diff
// didn't cover, each with a live repro on a spawned server. The tests below
// pin those repros at the same layer this file already uses (real router,
// real plugins, fresh temp DB) — written RED first, each reproducing the
// reviewer's probe, then fixed.
//
//   B1   PUT /studio/users/:id mints (and strips) roles on checkAdmin alone —
//        which passes on an admin studio JWT. A role change in EITHER
//        direction requires the admin KEY: one invariant sentence.
//   B2   /auto-memory/facts/:id/supersede and /reverify guard only the
//        namespace, never ownership — B stamps verified_at on A's fact and
//        closes A's validity interval pointing at B's own row.
//   M1   POST/PUT /studio/users accept any role string verbatim ("adimn " was
//        a 200) — the role is a fixed vocabulary: operator | agent | admin.
//   M2   (rate-limits fork) the single-row DELETE /memory/index/:t/:id has no
//        limiter — 120/min like its purge sibling.
//   S1   (review-A sweep, third door) PUT /memory/embeddings/:t/:id failed
//        OPEN when no claimed embed job named the row — any agent key could
//        store a vector over any row in the index (poison the ranking without
//        touching the text).
//   N1   GET /auto-memory/facts/:id reads any agent's fact by id — the list
//        scopes agent_id=who; the single read does too now.

describe('B1 PUT /studio/users/:id — a role change requires the admin KEY (grant AND revoke)', () => {
  it('refuses role=admin (promotion) from a studio admin JWT (reviewer probe: was 200, victim logged back in as admin)', async () => {
    const victim = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'b1-victim', password: 'password123', display_name: 'B1 Victim' });
    expect(victim.status).toBe(200);
    expect(victim.body.role).toBe('operator');

    const res = await request(app).put('/api/mycelium/studio/users/' + victim.body.id)
      .set(adminJwtAuth).send({ role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key/i);

    // the mint never happened — a fresh read shows the row still operator
    const list = await request(app).get('/api/mycelium/studio/users').set(adminKeyAuth);
    expect(list.body.find((u) => u.username === 'b1-victim').role).toBe('operator');
  });

  it('refuses a role DEMOTION from a studio admin JWT (the same invariant, the other direction)', async () => {
    const admin = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'b1-admin', password: 'password123', display_name: 'B1 Admin', role: 'admin' });
    expect(admin.status).toBe(200);

    const res = await request(app).put('/api/mycelium/studio/users/' + admin.body.id)
      .set(adminJwtAuth).send({ role: 'operator' });
    expect(res.status).toBe(403);

    const list = await request(app).get('/api/mycelium/studio/users').set(adminKeyAuth);
    expect(list.body.find((u) => u.username === 'b1-admin').role).toBe('admin');
  });

  it('the admin KEY still moves a role (demote control — the key is the door)', async () => {
    const user = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'b1-key-change', password: 'password123', display_name: 'B1 Key' });
    const res = await request(app).put('/api/mycelium/studio/users/' + user.body.id)
      .set(adminKeyAuth).send({ role: 'agent' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('agent');
  });

  it('a display_name-only PUT still works from an admin JWT (no role in play)', async () => {
    const user = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'b1-rename', password: 'password123', display_name: 'Before' });
    const res = await request(app).put('/api/mycelium/studio/users/' + user.body.id)
      .set(adminJwtAuth).send({ display_name: 'After' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('After');
  });
});

describe('M1 /studio/users accepts only the fixed role vocabulary', () => {
  it('refuses a junk role on POST (reviewer probe: role "adimn " was accepted 200)', async () => {
    const res = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'm1-junk', password: 'password123', display_name: 'Junk', role: 'adimn ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role/i);
    const list = await request(app).get('/api/mycelium/studio/users').set(adminKeyAuth);
    expect(list.body.find((u) => u.username === 'm1-junk')).toBeUndefined();
  });

  it('refuses a junk role on PUT', async () => {
    const user = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'm1-junk-put', password: 'password123', display_name: 'Junk Put' });
    const res = await request(app).put('/api/mycelium/studio/users/' + user.body.id)
      .set(adminKeyAuth).send({ role: 'superadmin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role/i);
  });

  it('accepts each whitelisted role on POST (operator | agent | admin — admin still key-gated above)', async () => {
    const agent = await request(app).post('/api/mycelium/studio/users').set(adminKeyAuth)
      .send({ username: 'm1-agent-role', password: 'password123', display_name: 'Agent Role', role: 'agent' });
    expect(agent.status).toBe(200);
    expect(agent.body.role).toBe('agent');
  });
});

describe('B2 /auto-memory/facts/:id/supersede + /reverify honor fact ownership', () => {
  it("refuses another agent's reverify of A's fact (reviewer probe C9a: was 200, stamped verified_at)", async () => {
    const a = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY))
      .send({ fact_text: 'lucy owns this fact and its verification trail' });
    expect(a.status).toBe(200);

    const res = await request(app).post('/api/mycelium/auto-memory/facts/' + a.body.id + '/reverify')
      .set(agentAuth(AGENT_B_KEY)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/lucy-tl250/);

    const after = await request(app).get('/api/mycelium/auto-memory/facts/' + a.body.id).set(agentAuth(AGENT_A_KEY));
    expect(after.status).toBe(200);
    expect(after.body.verified_at).toBeNull(); // the stamp never happened
  });

  it("refuses another agent's supersede of A's fact (reviewer probe C9b: was 200, closed A's interval)", async () => {
    const a = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY))
      .send({ fact_text: 'lucy wrote this fact; its validity is hers to close' });
    const b = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_B_KEY))
      .send({ fact_text: 'echo wrote the replacement fact' });

    const res = await request(app).post('/api/mycelium/auto-memory/facts/' + a.body.id + '/supersede')
      .set(agentAuth(AGENT_B_KEY)).send({ new_id: b.body.id });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/lucy-tl250/);

    const after = await request(app).get('/api/mycelium/auto-memory/facts/' + a.body.id).set(agentAuth(AGENT_A_KEY));
    expect(after.body.superseded_by).toBeNull(); // A's interval is still open
    expect(after.body.valid_to).toBeNull();
  });

  it('the owner still reverifies and supersedes its own fact', async () => {
    const a = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY))
      .send({ fact_text: 'an owner-managed fact pair lives here' });
    const a2 = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY))
      .send({ fact_text: 'the owner wrote the replacement fact too' });

    const rv = await request(app).post('/api/mycelium/auto-memory/facts/' + a.body.id + '/reverify')
      .set(agentAuth(AGENT_A_KEY)).send({});
    expect(rv.status).toBe(200);
    expect(rv.body.fact.verified_at).toBeTruthy();

    const sup = await request(app).post('/api/mycelium/auto-memory/facts/' + a.body.id + '/supersede')
      .set(agentAuth(AGENT_A_KEY)).send({ new_id: a2.body.id });
    expect(sup.status).toBe(200);
    expect(sup.body.ok).toBe(true);
  });

  it('the admin key keeps cross-agent supersede/reverify (bench + harness compat)', async () => {
    const a = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY))
      .send({ fact_text: 'an agent fact the admin corrects on purpose' });
    const b = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_B_KEY))
      .send({ fact_text: 'the replacement fact from another seat' });

    const rv = await request(app).post('/api/mycelium/auto-memory/facts/' + a.body.id + '/reverify')
      .set(adminKeyAuth).send({});
    expect(rv.status).toBe(200);

    const sup = await request(app).post('/api/mycelium/auto-memory/facts/' + a.body.id + '/supersede')
      .set(adminKeyAuth).send({ new_id: b.body.id });
    expect(sup.status).toBe(200);
    expect(sup.body.ok).toBe(true);
  });

  it('owner-unknown facts (agent_id NULL, e.g. the internal consolidator) are admin-mutable — fail-closed', async () => {
    const nullRow = db.getDB().prepare(
      "INSERT INTO am_facts (agent_id, fact_text) VALUES (NULL, 'a consolidation insight with no owning agent')"
    ).run();
    const id = nullRow.lastInsertRowid;
    const other = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_B_KEY))
      .send({ fact_text: 'echo wrote the would-be replacement row' });

    const rv = await request(app).post('/api/mycelium/auto-memory/facts/' + id + '/reverify')
      .set(agentAuth(AGENT_B_KEY)).send({});
    expect(rv.status).toBe(403);
    expect(rv.body.error).toMatch(/admin key|owner-unknown/i);

    const sup = await request(app).post('/api/mycelium/auto-memory/facts/' + id + '/supersede')
      .set(agentAuth(AGENT_B_KEY)).send({ new_id: other.body.id });
    expect(sup.status).toBe(403);

    const adminSup = await request(app).post('/api/mycelium/auto-memory/facts/' + id + '/supersede')
      .set(adminKeyAuth).send({ new_id: other.body.id });
    expect(adminSup.status).toBe(200);
  });
});

describe('S1 (review-A sweep) PUT /memory/embeddings is not a cross-agent vector write', () => {
  const VEC = [0.1, 0.2, 0.3];

  it('refuses an agent key storing a vector over a row it did not write (was 200 — fail-open no-claim path)', async () => {
    await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_A_KEY))
      .send({ source_type: 'note', source_id: 's1-foreign-row', content_text: 'lucy wrote this row' });
    const res = await request(app).put('/api/mycelium/memory/embeddings/note/s1-foreign-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'poison-vec', chunk_index: 0 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/claim|owner|admin key/i);
    const row = db.getDB().prepare(
      "SELECT embedding FROM sm_embeddings WHERE source_type = 'note' AND source_id = 's1-foreign-row' AND chunk_index = 0"
    ).get();
    expect(row.embedding).toBeNull(); // the vector never landed
  });

  it('allows an agent key to embed its OWN row', async () => {
    await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_B_KEY))
      .send({ source_type: 'note', source_id: 's1-own-row', content_text: 'echo wrote this row' });
    const res = await request(app).put('/api/mycelium/memory/embeddings/note/s1-own-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'own-vec', chunk_index: 0 });
    expect(res.status).toBe(200);
  });

  it('still allows the drone holding the claimed embed job for a row it wrote (owner-stamped claim)', async () => {
    // Round 2 (250c) tightened this leg: the claim linkage authorizes the
    // write only when the claimant is entitled to the ROW — its own row (as
    // here, requester = the owner the pipeline stamped), or via an admin-
    // registered embedder. A seeded claim over a FOREIGN row is refused —
    // see the S3 describe at the bottom of this file.
    await request(app).post('/api/mycelium/memory/index').set(agentAuth(AGENT_B_KEY))
      .send({ source_type: 'note', source_id: 's1-claimed-row', content_text: 'echo wrote this row too' });
    db.getDB().prepare(
      "INSERT INTO drone_jobs (title, input_data, requires, requester, job_type, status, drone_id) VALUES (?, ?, ?, ?, 'embed', 'claimed', ?)"
    ).run(
      'Embed: note:s1-claimed-row',
      JSON.stringify({ source_type: 'note', source_id: 's1-claimed-row', chunk_index: 0 }),
      JSON.stringify(['ollama']), 'echo-tl250', 'echo-tl250'
    );
    const res = await request(app).put('/api/mycelium/memory/embeddings/note/s1-claimed-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'drone-vec', chunk_index: 0 });
    expect(res.status).toBe(200);
  });

  it('owner-unknown rows (written_by NULL) stay admin-only, and the admin keeps the bypass', async () => {
    db.getDB().prepare(
      "INSERT INTO sm_embeddings (source_type, source_id, chunk_index, content_text) VALUES ('note', 's1-legacy-row', 0, 'written before authority')"
    ).run();
    const refused = await request(app).put('/api/mycelium/memory/embeddings/note/s1-legacy-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'agent-vec', chunk_index: 0 });
    expect(refused.status).toBe(403);

    const admin = await request(app).put('/api/mycelium/memory/embeddings/note/s1-legacy-row')
      .set(adminKeyAuth).send({ embedding: VEC, model: 'admin-vec', chunk_index: 0 });
    expect(admin.status).toBe(200);
  });
});

describe('N1 (review-A nit) GET /auto-memory/facts/:id is scoped like the list', () => {
  it('refuses another agent’s fact by id — the list would not have shown it (was 200)', async () => {
    const a = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY))
      .send({ fact_text: 'lucy wrote this fact for her own recall' });
    const res = await request(app).get('/api/mycelium/auto-memory/facts/' + a.body.id)
      .set(agentAuth(AGENT_B_KEY));
    expect(res.status).toBe(404); // scoped like the list: another agent's fact is "not there"
  });

  it('the owner and the admin still read it', async () => {
    const a = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth(AGENT_A_KEY))
      .send({ fact_text: 'a readable-by-owner-and-admin fact' });
    const owner = await request(app).get('/api/mycelium/auto-memory/facts/' + a.body.id).set(agentAuth(AGENT_A_KEY));
    expect(owner.status).toBe(200);
    const admin = await request(app).get('/api/mycelium/auto-memory/facts/' + a.body.id).set(adminKeyAuth);
    expect(admin.status).toBe(200);
  });
});

// ============ S3 (review-A round 2 MAJOR) — the drone embed chain ============
// The chain, all agent-callable once a provider='drone' deployment wires its
// embedder the way the feature anticipates (250r2-sweepprobe2, quoted in the
// review): backfill (agent key, queues ALL owners' rows with their full text)
// → heartbeat (agent key, self-declared system_diagnostics — the render's
// "must heartbeat first" gate) → claim (agent key, self-declared capabilities
// matched against the template's requires) → PUT a chosen vector over a
// FOREIGN row, 200. On the sha under review the chain completed end-to-end
// (S3a..S3h: model=echo-poison emb=[9.9,9.9,9.9] over lucy's row, text intact)
// the moment an admin INSERTed the 'embed' template — an availability
// accident, not an authorization decision.
//
// The fix is at the authorization layer, not the template:
//   (a)  /memory/backfill-embeddings queues only rows the caller owns
//        (admin: all) — the attacker-populated queue was the enabler;
//   (b)  an embed job's claim is authorized against the ROW's owner or an
//        admin-registered embedder — never by self-declared capabilities;
//        and an agent cannot mint the embed job itself;
//   (c)  self-declared heartbeat diagnostics never satisfy the gate —
//        no agent-key path can move the embedder_registered flag;
//   (d)  the vector write re-checks the claimant's right to that row,
//        whatever currently holds the claim.
describe('S3 (review-A r2 major) the drone embed chain is authorized against the row owner', () => {
  const VEC = [0.4, 0.4, 0.4];

  const embedTemplate = async () => {
    const r = await request(app).post('/api/mycelium/drones/templates').set(adminKeyAuth)
      .send({ id: 'embed', name: 'Embed Job', requires: ['ollama'] });
    if (r.status !== 200 && r.status !== 409) throw new Error('template setup answered ' + r.status);
  };
  const droneProvider = async () => {
    const r = await request(app).put('/api/mycelium/memory/config').set(adminKeyAuth)
      .send({ embedding_provider: 'drone', embedding_model: 'nomic-embed-text' });
    expect(r.status).toBe(200);
  };
  const indexRow = (key, sourceId, text) =>
    request(app).post('/api/mycelium/memory/index').set(agentAuth(key))
      .send({ source_type: 'note', source_id: sourceId, content_text: text });
  const backfill = (key) =>
    request(app).post('/api/mycelium/memory/backfill-embeddings?limit=10').set(agentAuth(key));
  const backfillAdmin = () =>
    request(app).post('/api/mycelium/memory/backfill-embeddings?limit=10').set(adminKeyAuth);
  const embedJobs = () => db.getDB().prepare(
    "SELECT title, requester, status, drone_id FROM drone_jobs WHERE job_type = 'embed'"
  ).all();
  // Claim repeatedly until the queue is dry, collecting granted titles. The
  // invariant under test is order-independent: NO granted title names a row
  // the claimant does not own (the queue holds several jobs by the time these
  // tests run — earlier tests' refused infra jobs stay pending).
  const claimAll = async (key) => {
    const granted = [];
    for (let i = 0; i < 50; i++) {
      const r = await request(app).post('/api/mycelium/drones/claim').set(agentAuth(key))
        .send({ capabilities: ['ollama'] });
      expect(r.status).toBe(200);
      if (!r.body.job) break;
      granted.push(r.body.job.title);
    }
    return granted;
  };

  it('(a) an agent backfill queues only rows the caller owns (admin: all)', async () => {
    await droneProvider();
    await indexRow(AGENT_A_KEY, 's3-a-row', 'LUCY-SECRET-CONTENT lucy row, vector poison target');
    await indexRow(AGENT_B_KEY, 's3-b-row', 'echo row for its own backfill');
    // under provider=drone the index pipeline itself auto-queues an infra job
    // per fresh row — snapshot it; the assertion below is about what B's
    // BACKFILL adds (the pipeline's own jobs are the claim test's subject).
    const foreignBefore = embedJobs().filter(j => j.title.includes('s3-a-row')).length;

    const b = await backfill(AGENT_B_KEY);
    expect(b.status).toBe(200);
    // review B item 2: server-written rows now carry their real owner, so the
    // echo-owned NULL-embed pool B's backfill may queue is larger than the one
    // seeded here — the scoping assertions below (never lucy's row) are the point.
    const bOwnedNull = db.getDB().prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE written_by = 'echo-tl250' AND embedding IS NULL").get().c;
    expect(b.body.queued).toBe(bOwnedNull);
    expect(embedJobs().filter(j => j.title.includes('s3-a-row')).length).toBe(foreignBefore); // the backfill added none
    expect(embedJobs().some(j => j.title.includes('s3-b-row') && j.requester === 'echo-tl250')).toBe(true); // owner-stamped

    const admin = await backfillAdmin();
    expect(admin.status).toBe(200);
    expect(admin.body.queued).toBeGreaterThanOrEqual(1); // admin: all owners
    expect(embedJobs().find(j => j.title.includes('s3-a-row')).requester).toBe('semantic-memory'); // infra
  });

  it('(b,c) a claim needs row entitlement even with template + self-declared capabilities + self-declared diagnostics', async () => {
    await embedTemplate();
    await indexRow(AGENT_A_KEY, 's3-a-claim-row', 'LUCY-SECRET-CONTENT the claim-payload leak target');
    await indexRow(AGENT_B_KEY, 's3-b-claim-row', 'echo row whose own job may be claimed');
    const hb = await request(app).post('/api/mycelium/agents/heartbeat').set(agentAuth(AGENT_B_KEY))
      .send({ status: 'online', system_diagnostics: { os: 'probe', cpu_model: 'attack-probe' } });
    expect(hb.status).toBe(200); // S3b: the self-declared diagnostics are in place
    expect((await backfill(AGENT_B_KEY)).status).toBe(200);
    expect((await backfillAdmin()).status).toBe(200); // the infra job naming lucy's row

    const granted = await claimAll(AGENT_B_KEY);
    expect(granted.length).toBeGreaterThanOrEqual(1); // B's own work still flows
    for (const t of granted) expect(t).not.toMatch(/s3-a/); // was GRANTED: 'Embed: note:s3-a-claim-row'
  });

  it('(c) no agent-key path mints embedder_registered — not self-update, not heartbeat', async () => {
    const selfPut = await request(app).put('/api/mycelium/agents/echo-tl250').set(agentAuth(AGENT_B_KEY))
      .send({ embedder_registered: true });
    expect(selfPut.status).toBe(403); // was 400 'Nothing to update' — now a named refusal

    const hb = await request(app).post('/api/mycelium/agents/heartbeat').set(agentAuth(AGENT_B_KEY))
      .send({ status: 'online', system_diagnostics: { os: 'probe', embedder_registered: 1 } });
    expect(hb.status).toBe(200); // diagnostics are stored — and authorize nothing

    const me = await request(app).get('/api/mycelium/agents/echo-tl250').set(agentAuth(AGENT_B_KEY));
    expect(Boolean(me.body.embedder_registered)).toBe(false); // the gate flag never moved
  });

  it('(d) the vector write re-checks the claimant\'s right to the row, whatever holds the claim', async () => {
    await indexRow(AGENT_A_KEY, 's3-d-row', 'lucy row a seeded claim must not unlock');
    db.getDB().prepare(
      "INSERT INTO drone_jobs (title, input_data, requires, requester, job_type, status, drone_id) VALUES (?, ?, ?, 'semantic-memory', 'embed', 'claimed', ?)"
    ).run('Embed: note:s3-d-row',
      JSON.stringify({ source_type: 'note', source_id: 's3-d-row', chunk_index: 0 }),
      JSON.stringify(['ollama']), 'echo-tl250');

    const refused = await request(app).put('/api/mycelium/memory/embeddings/note/s3-d-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'poison-vec', chunk_index: 0 });
    expect(refused.status).toBe(403); // was 200: the claim linkage alone authorized the write
    const row = db.getDB().prepare(
      "SELECT embedding FROM sm_embeddings WHERE source_type = 'note' AND source_id = 's3-d-row' AND chunk_index = 0"
    ).get();
    expect(row.embedding).toBeNull(); // the vector never landed

    const own = await request(app).put('/api/mycelium/memory/embeddings/note/s3-b-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'own-vec', chunk_index: 0 });
    expect(own.status).toBe(200); // the owner leg is untouched

    const admin = await request(app).put('/api/mycelium/memory/embeddings/note/s3-d-row')
      .set(adminKeyAuth).send({ embedding: VEC, model: 'admin-vec', chunk_index: 0 });
    expect(admin.status).toBe(200);

    // The agent-callable twin of the DB seed above: PUT /drones/jobs/:id lets
    // any agent self-assign an unclaimed job (drone_id NULL bypasses the job
    // route's ownership guard), so "holding the claim" must not be enough —
    // the vector write re-check is what refuses here.
    await indexRow(AGENT_A_KEY, 's3-d2-row', 'lucy row, infra job self-assign target');
    expect((await backfillAdmin()).status).toBe(200);
    const infraJob = db.getDB().prepare(
      "SELECT id FROM drone_jobs WHERE job_type = 'embed' AND status = 'pending' AND json_extract(input_data, '$.source_id') = 's3-d2-row' LIMIT 1"
    ).get();
    expect(infraJob).toBeTruthy();
    const selfAssign = await request(app).put('/api/mycelium/drones/jobs/' + infraJob.id)
      .set(agentAuth(AGENT_B_KEY)).send({ status: 'claimed', drone_id: 'echo-tl250' });
    expect(selfAssign.status).toBe(200); // the job route still allows the state change
    const stillRefused = await request(app).put('/api/mycelium/memory/embeddings/note/s3-d2-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'poison-vec', chunk_index: 0 });
    expect(stillRefused.status).toBe(403); // (d): self-assigned claim ≠ right to the row
  });

  it('(b) an agent cannot mint the embed job itself — job_type embed is pipeline/admin-only', async () => {
    const mint = await request(app).post('/api/mycelium/drones/jobs').set(agentAuth(AGENT_B_KEY))
      .send({ title: 'Embed: note:s3-a-row', job_type: 'embed', input_data: { source_type: 'note', source_id: 's3-a-row', chunk_index: 0 } });
    expect(mint.status).toBe(403); // was 200: a self-requester embed job names any owner's row

    const mint2 = await request(app).post('/api/mycelium/drones/jobs/from-template').set(agentAuth(AGENT_B_KEY))
      .send({ template_id: 'embed', title: 'Embed: note:s3-a-row', input_data: { source_type: 'note', source_id: 's3-a-row' } });
    expect(mint2.status).toBe(403);
  });

  it('(b,d) the admin-registered embedder is the infra path — grant, write, and revoke', async () => {
    await indexRow(AGENT_A_KEY, 's3-e-row', 'lucy row the registered embedder may embed');
    expect((await backfillAdmin()).status).toBe(200);

    const reg = await request(app).put('/api/mycelium/agents/echo-tl250').set(adminKeyAuth)
      .send({ embedder_registered: true });
    expect(reg.status).toBe(200); // the admin key is the door

    const granted = await claimAll(AGENT_B_KEY);
    expect(granted.some(t => t.includes('s3-e-row'))).toBe(true); // registered embedder gets infra work

    const write = await request(app).put('/api/mycelium/memory/embeddings/note/s3-e-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'infra-vec', chunk_index: 0 });
    expect(write.status).toBe(200); // live claim + registration → the row's vector

    const unreg = await request(app).put('/api/mycelium/agents/echo-tl250').set(adminKeyAuth)
      .send({ embedder_registered: false });
    expect(unreg.status).toBe(200); // revocation is the admin's too

    await indexRow(AGENT_A_KEY, 's3-f-row', 'lucy row after the registration is revoked');
    expect((await backfillAdmin()).status).toBe(200);

    const after = await claimAll(AGENT_B_KEY);
    for (const t of after) expect(t).not.toMatch(/s3-f/); // revoked → no new infra claims
    const refused = await request(app).put('/api/mycelium/memory/embeddings/note/s3-f-row')
      .set(agentAuth(AGENT_B_KEY)).send({ embedding: VEC, model: 'poison-vec', chunk_index: 0 });
    expect(refused.status).toBe(403);
  });
});

// ============================ Review B (task 250d) ============================
// Review B items 2 (custody squatting) — director's review @ 10c03bd9.
describe('Review B item 2: server-owned source types cannot be squatted', () => {
  // The complete list of source types the SERVER itself writes into sm_embeddings
  // (grep of every INSERT writer on the branch): memory + am_fact (auto-memory routes),
  // message/context_key/concept/task/savepoint/workflow (semantic-memory handlers event
  // indexing), companion (federation store). Agent keys must refuse to write them; the
  // server's own writers stamp written_by from the row's real owner.
  const SERVER_TYPES = ['memory', 'am_fact', 'message', 'context_key', 'concept', 'task', 'savepoint', 'workflow', 'plan', 'plan_step'];

  it('agent key cannot POST /memory/index a server-owned source type (403)', async () => {
    for (const t of SERVER_TYPES) {
      const r = await request(app).post('/api/mycelium/memory/index')
        .set(agentAuth(AGENT_A_KEY))
        .send({ source_type: t, source_id: `srv-guard-${t}`, content_text: 'agent squat attempt' });
      expect(r.status).toBe(403);
      expect(String(r.body.error)).toContain('server-owned');
    }
  });

  it('agent key cannot bulk-index a server-owned source type either', async () => {
    const r = await request(app).post('/api/mycelium/memory/index/bulk')
      .set(agentAuth(AGENT_A_KEY))
      .send({ items: [{ source_type: 'message', source_id: 'srv-bulk-msg', content_text: 'nope' }] });
    expect(r.status).toBe(403);
  });

  it('admin key still may POST /memory/index a server-owned type (operator control)', async () => {
    const r = await request(app).post('/api/mycelium/memory/index')
      .set(adminKeyAuth)
      .send({ source_type: 'message', source_id: 'srv-admin-msg', content_text: 'admin control write' });
    expect(r.status).toBe(200);
  });

  it('auto-memory fact -> memory row is stamped written_by=<owning agent> (was NULL)', async () => {
    const mk = await request(app).post('/api/mycelium/auto-memory/facts')
      .set(agentAuth(AGENT_A_KEY))
      .send({ fact_type: 'lesson', fact_text: 'tl250 stamped-memory-row probe', agent_id: 'lucy-tl250' });
    expect(mk.status).toBe(200);
    const row = db.getDB().prepare("SELECT written_by FROM sm_embeddings WHERE source_type='memory' AND source_id=?").get(String(mk.body.id));
    expect(row).toBeTruthy();
    expect(row.written_by).toBe('lucy-tl250');
  });

  it('auto-memory namespaced fact -> am_fact row stamped written_by=<owning agent>', async () => {
    const mk = await request(app).post('/api/mycelium/auto-memory/facts')
      .set(agentAuth(AGENT_A_KEY))
      .send({ fact_type: 'lesson', fact_text: 'tl250 stamped-amfact-row probe', agent_id: 'lucy-tl250', namespace: 'tl250-ns' });
    expect(mk.status).toBe(200);
    const row = db.getDB().prepare("SELECT written_by FROM sm_embeddings WHERE source_type='am_fact' AND source_id=?").get(String(mk.body.id));
    expect(row).toBeTruthy();
    expect(row.written_by).toBe('lucy-tl250');
  });

  it('a squatted memory row is evicted when the server writes its row (written_by forced, never inherited)', async () => {
    // Historic squat: a pre-fix row written by AGENT_B under the fact id AGENT_A is about to take.
    const next = db.getDB().prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM am_facts').get().n;
    db.getDB().prepare("INSERT INTO sm_embeddings (source_type, source_id, chunk_index, content_text, written_by) VALUES ('memory', ?, 0, 'squat content', 'echo-tl250')").run(String(next));
    const mk = await request(app).post('/api/mycelium/auto-memory/facts')
      .set(agentAuth(AGENT_A_KEY))
      .send({ fact_type: 'lesson', fact_text: 'tl250 eviction probe', agent_id: 'lucy-tl250' });
    expect(mk.status).toBe(200);
    expect(String(mk.body.id)).toBe(String(next));
    const row = db.getDB().prepare("SELECT written_by, content_text FROM sm_embeddings WHERE source_type='memory' AND source_id=?").get(String(next));
    expect(row.written_by).toBe('lucy-tl250');
    expect(row.content_text).toBe('tl250 eviction probe');
  });
});

// ====================== Review B item 3 (task 250d) ======================
// directive / identity binding on EVERY source type (was: lesson/verdict/
// episode only — a 'note' or 'memory' row stored a self-asserted agent_id
// and even source_authority 'directive' verbatim).
describe('Review B item 3: identity binding + directive gate on every source type', () => {
  it('binds metadata.agent_id to the caller on a plain note (mismatch kept as claimed_agent_id)', async () => {
    const r = await request(app).post('/api/mycelium/memory/index')
      .set(agentAuth(AGENT_A_KEY))
      .send({ source_type: 'note', source_id: 'b3-agent-id', content_text: 'binding probe note', metadata: { agent_id: 'kira' } });
    expect(r.status).toBe(200);
    const row = db.getDB().prepare("SELECT metadata, written_by FROM sm_embeddings WHERE source_type='note' AND source_id='b3-agent-id' AND chunk_index=0").get();
    const meta = JSON.parse(row.metadata);
    expect(meta.agent_id).toBe('lucy-tl250'); // the AUTHENTICATED identity
    expect(meta.claimed_agent_id).toBe('kira'); // the claim, flagged, never trusted
    expect(row.written_by).toBe('lucy-tl250');
  });

  it('binds actor on a plain note (mismatch kept as claimed_actor)', async () => {
    const r = await request(app).post('/api/mycelium/memory/index')
      .set(agentAuth(AGENT_A_KEY))
      .send({ source_type: 'note', source_id: 'b3-actor', content_text: 'actor binding probe', metadata: { actor: 'kira' } });
    expect(r.status).toBe(200);
    const row = db.getDB().prepare("SELECT metadata FROM sm_embeddings WHERE source_type='note' AND source_id='b3-actor' AND chunk_index=0").get();
    const meta = JSON.parse(row.metadata);
    expect(meta.actor).toBe('lucy-tl250');
    expect(meta.claimed_actor).toBe('kira');
  });

  it('binds agent on a plain note (mismatch kept as claimed_actor)', async () => {
    const r = await request(app).post('/api/mycelium/memory/index')
      .set(agentAuth(AGENT_A_KEY))
      .send({ source_type: 'note', source_id: 'b3-agent', content_text: 'agent binding probe', metadata: { agent: 'echo-tl250' } });
    expect(r.status).toBe(200);
    const row = db.getDB().prepare("SELECT metadata FROM sm_embeddings WHERE source_type='note' AND source_id='b3-agent' AND chunk_index=0").get();
    const meta = JSON.parse(row.metadata);
    expect(meta.agent).toBe('lucy-tl250');
    expect(meta.claimed_actor).toBe('echo-tl250');
  });

  it('an agreeing agent_id stays clean (no claim field)', async () => {
    const r = await request(app).post('/api/mycelium/memory/index')
      .set(agentAuth(AGENT_A_KEY))
      .send({ source_type: 'note', source_id: 'b3-agree', content_text: 'agreeing identity probe', metadata: { agent_id: 'lucy-tl250' } });
    expect(r.status).toBe(200);
    const meta = JSON.parse(db.getDB().prepare("SELECT metadata FROM sm_embeddings WHERE source_type='note' AND source_id='b3-agree' AND chunk_index=0").get().metadata);
    expect(meta.agent_id).toBe('lucy-tl250');
    expect(meta.claimed_agent_id).toBeUndefined();
  });

  it("agent key cannot write source_authority 'directive' via /memory/index (403)", async () => {
    const r = await request(app).post('/api/mycelium/memory/index')
      .set(agentAuth(AGENT_A_KEY))
      .send({ source_type: 'note', source_id: 'b3-directive', content_text: 'directive claim', metadata: { source_authority: 'directive' } });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain('directive');
  });

  it("agent key cannot write source_authority 'directive' via /index/bulk either (403, item named)", async () => {
    const r = await request(app).post('/api/mycelium/memory/index/bulk')
      .set(agentAuth(AGENT_A_KEY))
      .send({ items: [{ source_type: 'note', source_id: 'b3-bulk-directive', content_text: 'bulk directive claim', metadata: { source_authority: 'directive' } }] });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toContain('items[0]');
  });

  it('admin key still writes directive provenance (operator control)', async () => {
    const r = await request(app).post('/api/mycelium/memory/index')
      .set(adminKeyAuth)
      .send({ source_type: 'note', source_id: 'b3-admin-directive', content_text: 'admin directive control', metadata: { source_authority: 'directive', agent_id: 'kira' } });
    expect(r.status).toBe(200);
    const row = db.getDB().prepare("SELECT metadata FROM sm_embeddings WHERE source_type='note' AND source_id='b3-admin-directive' AND chunk_index=0").get();
    expect(JSON.parse(row.metadata).source_authority).toBe('directive'); // stored as written
  });
});

// ====================== Review B item 5 (task 250d) ======================
// consolidation supersede_ids were unchecked: the LLM's answer could supersede
// ANY fact — directive rows, other agents' rows, ids it invented.
describe('Review B item 5: consolidation touches only its input, never directives', () => {
  let fakeLlm;
  let llmUrl;
  const scripted = { response: '{}' }; // the fake model's answer, set per test

  beforeAll(async () => {
    const http = await import('node:http');
    fakeLlm = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response: scripted.response }));
      });
    });
    await new Promise((r) => fakeLlm.listen(0, '127.0.0.1', r));
    llmUrl = 'http://127.0.0.1:' + fakeLlm.address().port;
    const put = await request(app).put('/api/mycelium/auto-memory/config').set(adminKeyAuth)
      .send({ llm_provider: 'ollama', llm_url: llmUrl, llm_model: 'fake-consolidator' });
    expect(put.status).toBe(200);
  });

  afterAll(async () => {
    if (fakeLlm) fakeLlm.close();
    // leave the config as we found it (provider none) for any later suite
    await request(app).put('/api/mycelium/auto-memory/config').set(adminKeyAuth)
      .send({ llm_provider: 'none', llm_url: '' });
  });

  const mkFact = async (agentId, marker, authority) => {
    const r = await request(app).post('/api/mycelium/auto-memory/facts').set(adminKeyAuth)
      .send({ fact_text: marker + ' — consolidation input probe', agent_id: agentId, source_authority: authority || 'inferred' });
    expect(r.status).toBe(200);
    return r.body.id;
  };

  it('admin /consolidate supersedes only input ids and never a directive row', async () => {
    const anchor = await mkFact('lucy-tl250', 'b5 anchor (keep)');
    const lucyDup = await mkFact('lucy-tl250', 'b5 lucy duplicate (supersede target)');
    const directiveRow = await mkFact('lucy-tl250', 'b5 directive row (never superseded)', 'directive');
    const echoRow = await mkFact('echo-tl250', 'b5 echo row (in input — admin may supersede)');
    await mkFact('lucy-tl250', 'b5 filler one'); // recentFacts >= 5
    await mkFact('lucy-tl250', 'b5 filler two');
    const invented = 1000000 + anchor; // an id the LLM made up — not in the input

    scripted.response = JSON.stringify({
      keep: [],
      merge: [{ keep_id: anchor, supersede_ids: [lucyDup, directiveRow, echoRow, invented] }],
      insights: []
    });

    const r = await request(app).post('/api/mycelium/auto-memory/consolidate').set(adminKeyAuth).send({});
    expect(r.status).toBe(200);
    expect(r.body.result.facts_superseded).toBe(2); // lucyDup + echoRow only
    const rows = db.getDB().prepare('SELECT id, superseded_by, source_authority FROM am_facts WHERE id IN (?, ?, ?, ?)')
      .all(lucyDup, directiveRow, echoRow, invented);
    const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(byId[lucyDup].superseded_by).toBe(anchor); // input row: superseded
    expect(byId[echoRow].superseded_by).toBe(anchor); // other agent, but in the input — admin: input set only
    expect(byId[directiveRow].superseded_by).toBeNull(); // a directive outlives consolidations
    expect(byId[invented]).toBeUndefined(); // invented id touched nothing
  });

  it('a caller-scoped run (callerAgentId) supersedes only its OWN input rows', async () => {
    const { default: createAutoMemoryDB } = await import('../../server/plugins/auto-memory/db.js');
    const { runConsolidation } = await import('../../server/plugins/auto-memory/routes.js');
    const amdb = createAutoMemoryDB(db.getDB());

    const anchor = amdb.createFact('lucy-tl250', null, 'general', 'b5s caller anchor (keep)', 0.8, 'aria', null);
    const lucyDup = amdb.createFact('lucy-tl250', null, 'general', 'b5s lucy duplicate (supersede target)', 0.8, 'aria', null);
    const echoRow = amdb.createFact('echo-tl250', null, 'general', 'b5s echo row (other agent — refused)', 0.8, 'aria', null);
    const directiveRow = amdb.createFact('lucy-tl250', null, 'general', 'b5s directive row (refused)', 0.9, 'aria', null, 'directive');
    const invented = 2000000 + anchor;
    await mkFact('lucy-tl250', 'b5s filler one'); // keep the input >= 5 rows
    await mkFact('lucy-tl250', 'b5s filler two');

    scripted.response = JSON.stringify({
      keep: [
        { id: directiveRow, new_confidence: 0.99 }, // a directive's confidence is not the caller's to tune
        { id: invented, new_confidence: 0.99 } // an invented id tunes nothing
      ],
      merge: [{ keep_id: anchor, supersede_ids: [lucyDup, echoRow, directiveRow, invented] }],
      insights: []
    });

    const result = await runConsolidation(amdb, amdb.getAllConfig(), null, { callerAgentId: 'lucy-tl250' });
    expect(result.facts_superseded).toBe(1); // lucyDup only
    const rows = db.getDB().prepare('SELECT id, superseded_by, confidence FROM am_facts WHERE id IN (?, ?, ?, ?)')
      .all(lucyDup, echoRow, directiveRow, invented);
    const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(byId[lucyDup].superseded_by).toBe(anchor); // own input row: superseded
    expect(byId[echoRow].superseded_by).toBeNull(); // another agent's row: refused
    expect(byId[directiveRow].superseded_by).toBeNull(); // directive: refused
    expect(byId[invented]).toBeUndefined(); // invented id: refused
    const dRow = db.getDB().prepare('SELECT confidence FROM am_facts WHERE id = ?').get(directiveRow);
    expect(dRow.confidence).toBe(0.9); // the keep-leg confidence edit was refused too
  });
});

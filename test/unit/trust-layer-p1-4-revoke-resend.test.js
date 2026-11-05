// TRUST LAYER P1.4 FOLLOW-UP — the revoke re-send (#206, 2026-10-08,
// F-mycelium/272 — fileds from review B of #205).
//
// The hole: a revoke for an id the holder has NEVER seen writes no standing
// ban (`unknown` — the deliberate M1 trade-off: a holder never bans content
// it cannot evidence). A copy that arrives LATER from a third holder still
// lands, and the author's instruction is lost forever.
//
// The fix's law, one rule per test:
//
//   THE LOOP     the author keeps its outstanding revokes (fed_revoke_outbox)
//                and re-sends them, signed exactly as today (verifyRevoke),
//                on the next hello with each network it meets — a holder that
//                now holds a copy forgets it (the existing revokeRows path)
//                and writes the standing ban; re-arrivals are refused
//                (410 on the visit door, `revoked` on the import door).
//   FORGED       a forged re-sent revoke is refused at the hello — the knock
//                itself still answers; nothing is deleted.
//   BOUND        the outbox carries a revoke only 90 days; then it ages out.
//   M1 KEPT      still-unknown and foreign ids stay untouched — the re-send
//                never becomes a ban on unevidenced content.
//
// Harness models on trust-layer-p1-4-deletion.test.js's federation describe:
// real federation + semantic-memory routes over a faked core, the shipped
// client (makeVisitor) driving, the full visit → import round trip — no
// network.

process.env.MYCELIUM_RATE_LIMIT = 'off'; // limiters are proven in trust-layer-rate-limits.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

const ADMIN_KEY = 'trust-layer-p14r-admin-key-0123456789';
const JWT_SECRET = 'trust-layer-p14r-jwt-secret';

const HERE = dirname(fileURLToPath(import.meta.url));
const AM_SCHEMA = readFileSync(join(HERE, '../../server/plugins/auto-memory/schema.sql'), 'utf8');
const SM_SCHEMA = readFileSync(join(HERE, '../../server/plugins/semantic-memory/schema.sql'), 'utf8');
const FED_DIR = join(HERE, '../../server/plugins/federation');
const MEM_DIR = join(HERE, '../../server/plugins/semantic-memory');

describe('P1.4+ REVOKE RE-SEND (#206): the author re-announces its revokes on the next hello', () => {
  let raw, app, visitor, visitor2, hostToken, hostNetworkId;

  const HOST_SEED = crypto.createHash('sha256').update('p14r-host').digest('hex');
  const GUEST_SEED = crypto.createHash('sha256').update('p14r-guest').digest('hex');
  const AGENT_SEED = crypto.createHash('sha256').update('p14r-agent').digest('hex');
  const GUEST2_SEED = crypto.createHash('sha256').update('p14r-guest-2').digest('hex');
  const AGENT2_SEED = crypto.createHash('sha256').update('p14r-agent-2').digest('hex');
  // The "third holder" whose late souvenir carries the copy (a different
  // network keypair from the app under test).
  const LATE_HOST_SEED = crypto.createHash('sha256').update('p14r-late-host').digest('hex');

  function jwtFor(userId) {
    return jwt.sign({ studioUser: true, userId, username: 'u' + userId, role: 'operator' }, JWT_SECRET, { expiresIn: '1h' });
  }

  async function envelopeFor(agent, payload) {
    const { makeEnvelope } = await import(join(FED_DIR, 'protocol.js'));
    return makeEnvelope(agent.agentKey, agent.agentId, payload, Math.floor(Date.now() / 1000), crypto.randomBytes(16).toString('hex'));
  }

  // The transport the shipped client drives (supertest behind the same shape).
  const t = { post: async (path, body, headers) => {
    const r = request(app).post(path); for (const [k, v] of Object.entries(headers || {})) r.set(k, v); const res = await r.send(body); return { status: res.status, body: res.body };
  } };

  function rowInStore(rowId) {
    return raw.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'companion' AND json_extract(metadata, '$.fed_id') = ?").get(rowId).c;
  }
  function tombCount(rowId) {
    return raw.prepare("SELECT COUNT(*) AS c FROM sm_tombstones WHERE source_type = 'companion' AND source_id = ?").get(rowId).c;
  }

  // A hand-built souvenir from a third holder D carrying one A-authored row —
  // the door a late copy actually arrives through (verifyBundle enforces
  // row.agent === the bundle's agent, so only the author's own rows travel).
  async function lateBundle(fields, prov, visitId) {
    const { makeRow, makeNetworkPassport, makeVisitRecord, makeBundle } = await import(join(FED_DIR, 'protocol.js'));
    const { keyFromSeed, idForKey } = await import(join(FED_DIR, 'keys.js'));
    const hostKey = keyFromSeed(LATE_HOST_SEED);
    const hostId = idForKey(hostKey);
    const row = makeRow(visitor.agentKey, visitor.agentId, fields,
      Object.assign({ agent: visitor.agentId, network: hostId, home: visitor.homeNetworkId }, prov));
    const bundle = makeBundle(hostKey, {
      host_passport: makeNetworkPassport(hostKey, hostId, {
        name: 'p14r-late-host', policy: { visitors: true, kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] },
        issued_at: new Date().toISOString()
      }),
      agent_passport: visitor.agentPassport,
      visit: makeVisitRecord({
        visit_id: visitId, host_network: hostId, agent_id: visitor.agentId,
        home_network: visitor.homeNetworkId, grant_id: 'unused-for-shape',
        started_at: '2026-10-08T07:00:00Z', ended_at: '2026-10-08T08:00:00Z'
      }),
      rows: [row], issued_at: new Date().toISOString()
    });
    return { bundle, row };
  }

  async function importBundle(bundle, userId) {
    return request(app).post('/federation/import')
      .set('Authorization', 'Bearer ' + jwtFor(userId)).send({ bundle });
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
    visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED, homeName: 'qurio-phone', agentName: 'Qurio-p14r' });
    visitor2 = makeVisitor({ homeSeed: GUEST2_SEED, agentSeed: AGENT2_SEED, homeName: 'qurio-phone-2', agentName: 'Qurio-p14r-2' });
    hostToken = jwtFor(4242);

    await request(app).post('/federation/network').set('X-Admin-Key', ADMIN_KEY).send({
      seed_hex: HOST_SEED, name: 'p14r-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
    // Both visitors knock once — passports on file, the home networks met.
    const knock = await visitor.hello(t);
    expect(knock.status).toBe(200);
    hostNetworkId = knock.body.network_passport.network_id;
    await visitor2.hello(t);

    // A live grant for each visitor — the 410 leg writes through it.
    for (const [v, tok] of [[visitor, hostToken], [visitor2, hostToken]]) {
      const grant = await request(app).post('/federation/grant')
        .set('Authorization', 'Bearer ' + tok).send({ agent_passport: v.agentPassport });
      expect(grant.status).toBe(201);
      v.visitId = grant.body.visit_id;
    }
  });

  afterAll(() => { try { raw.close(); } catch (e) { /* closed */ } });

  it('THE LOOP: a revoke of an unseen id, a copy that arrives later, and the next hello that catches it', async () => {
    const { makeRow, makeRevoke, rowId } = await import(join(FED_DIR, 'protocol.js'));

    // The content exists nowhere here yet — the author computes its id and
    // revokes it BEFORE this holder ever sees it.
    const fields = {
      kind: 'aboutYou', key: 'p14r.loop',
      text: 'the p14r row revoked before this holder ever saw it',
      source: 'visit', at: '2026-10-08T08:00:00Z', supersedes: null
    };
    const xId = rowId(fields);

    // (a) the revoke lands `unknown` — nothing written (M1, #205 as shipped).
    const rev = makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [xId], {
      reason: 'gone before you met it', issued_at: new Date().toISOString()
    });
    const r0 = await request(app).post('/federation/revoke').send(await envelopeFor(visitor, { revoke: rev }));
    expect(r0.status).toBe(200);
    expect(r0.body.revoked).toBe(0);
    expect(r0.body.unknown).toEqual([xId]);
    expect(tombCount(xId)).toBe(0); // no standing ban on unevidenced content

    // (b) THE AUTHOR KEEPS IT — the outbox records the outstanding revoke.
    const rec = await visitor.recordRevoke(t, xId, 'gone before you met it');
    expect(rec.status).toBe(200);

    // (c) the copy arrives later from a third holder — and LANDS (the gap).
    const { bundle: bundle1, row } = await lateBundle(fields, { visit: 'v-p14r-late-1' }, 'v-p14r-late-1');
    expect(row.id).toBe(xId); // same content → same protocol id, whatever prov carried it
    const imp = await importBundle(bundle1, 4242);
    expect(imp.status).toBe(201);
    expect(imp.body.outcomes.find((o) => o.row_id === xId).outcome).toBe('imported');
    expect(rowInStore(xId)).toBe(1);

    // (d) the next hello carries the outbox — the holder catches up.
    const outbox = await request(app).get('/federation/outbox').set('X-Admin-Key', ADMIN_KEY);
    expect(outbox.status).toBe(200);
    const entry = outbox.body.revokes.find((r) => r.row_ids[0] === xId);
    expect(entry).toBeTruthy();
    const knock = await visitor.hello(t, { revokes: outbox.body.revokes });
    expect(knock.status).toBe(200);
    expect(knock.body.ok).toBe(true);
    expect(knock.body.revokes.received).toBeGreaterThanOrEqual(1);
    expect(knock.body.revokes.applied).toBeGreaterThanOrEqual(1);
    const mine = knock.body.revokes.outcomes.find((o) => o.agent_id === visitor.agentId);
    expect(mine.revoked).toBeGreaterThanOrEqual(1); // the late copy fell

    // (e) the holder forgot it, wrote the standing ban, and refuses re-arrivals.
    expect(rowInStore(xId)).toBe(0);
    expect(tombCount(xId)).toBeGreaterThanOrEqual(1);
    const mem = await request(app).get('/memory/me/memory').set('Authorization', 'Bearer ' + hostToken);
    expect(mem.body.results.find((r) => r.provenance && r.provenance.id === xId)).toBeUndefined();

    // Re-import refused: a fresh bundle (fresh visit → fresh bundle_id) still
    // carries the dead id.
    const { bundle: bundle2 } = await lateBundle(fields, { visit: 'v-p14r-late-2' }, 'v-p14r-late-2');
    const reImp = await importBundle(bundle2, 4242);
    expect([200, 201]).toContain(reImp.status);
    expect(reImp.body.outcomes.find((o) => o.row_id === xId).outcome).toBe('revoked');
    expect(rowInStore(xId)).toBe(0);

    // Re-write refused: the visit door answers 410 on the same content id.
    const again = makeRow(visitor.agentKey, visitor.agentId, fields,
      { agent: visitor.agentId, network: hostNetworkId, home: visitor.homeNetworkId, visit: visitor.visitId });
    expect(again.id).toBe(xId);
    const rewrite = await visitor.writeMemory(t, visitor.visitId, hostNetworkId, fields);
    expect(rewrite.status).toBe(410);
    expect(rowInStore(xId)).toBe(0);
  });

  it('FORGED: a forged re-sent revoke is refused at the hello and deletes nothing', async () => {
    const { makeRevoke } = await import(join(FED_DIR, 'protocol.js'));
    const { keyFromSeed, idForKey } = await import(join(FED_DIR, 'keys.js'));

    // A live copy the forged messages must NOT be able to take down.
    const fields = {
      kind: 'aboutYou', key: 'p14r.forged',
      text: 'the p14r row the forged re-sent revokes must not touch',
      source: 'visit', at: '2026-10-08T08:10:00Z', supersedes: null
    };
    const write = await visitor.writeMemory(t, visitor.visitId, hostNetworkId, fields);
    expect(write.status).toBe(201);
    const yId = write.body.row.provenance.id;
    expect(rowInStore(yId)).toBe(1);

    // (1) a tampered row list — the signature no longer covers it.
    const tampered = { ...makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [yId], {
      reason: 'looks real', issued_at: new Date().toISOString()
    }), row_ids: [yId, 'sha256-deadbeef'] };
    // (2) a validly-signed revoke naming ANOTHER agent — the knock is the
    // visitor's; the holder never acts on revokes its visitor did not author.
    const STRANGER_SEED = crypto.createHash('sha256').update('p14r-stranger').digest('hex');
    const strangerKey = keyFromSeed(STRANGER_SEED);
    const stranger = idForKey(strangerKey);
    const notMine = makeRevoke(strangerKey, stranger, 'some-home', [yId], {
      reason: 'a third party riding a hello', issued_at: new Date().toISOString()
    });

    const knock = await visitor.hello(t, { revokes: [tampered, notMine] });
    expect(knock.status).toBe(200); // the knock still answers
    expect(knock.body.ok).toBe(true);
    expect(knock.body.revokes.applied).toBe(0);
    expect(knock.body.revokes.refused).toHaveLength(2);
    expect(knock.body.revokes.refused[0].reason).toBe('revoke-sig');
    expect(knock.body.revokes.refused[1].reason).toBe('not-the-visitor');

    expect(rowInStore(yId)).toBe(1); // nothing was deleted
    expect(tombCount(yId)).toBe(0); // and nothing was banned
  });

  it('BOUND: the outbox carries a revoke for 90 days, then ages out', async () => {
    const { makeRevoke, verifyRevoke } = await import(join(FED_DIR, 'protocol.js'));

    // Two ghost ids: one revoked now, one revoked 91 days ago — both properly
    // signed (issued_at is inside the signature, so age is author-asserted).
    async function recordWithAge(rowId, daysAgo) {
      const rev = makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [rowId], {
        reason: 'aged out test', issued_at: new Date(Date.now() - daysAgo * 86400000).toISOString()
      });
      const res = await request(app).post('/federation/outbox').send(await envelopeFor(visitor, { revoke: rev }));
      expect(res.status).toBe(200);
      return rev;
    }
    const freshId = 'sha256-p14r-fresh-ghost';
    const oldId = 'sha256-p14r-ninetyone-day-ghost';
    await recordWithAge(freshId, 0);
    await recordWithAge(oldId, 91);
    // Both rows sit in the table — the BOUND is on what is CARRIED, not what is kept.
    expect(raw.prepare('SELECT COUNT(*) AS c FROM fed_revoke_outbox WHERE row_id IN (?, ?)').get(freshId, oldId).c).toBe(2);

    const outbox = await request(app).get('/federation/outbox').set('X-Admin-Key', ADMIN_KEY);
    expect(outbox.status).toBe(200);
    const ids = outbox.body.revokes.map((r) => r.row_ids[0]);
    expect(ids).toContain(freshId);
    expect(ids).not.toContain(oldId); // 91 days > the bound — the author stops re-announcing

    // What the GET carries re-verifies byte-exact — the rebuild is the exact
    // message the author signed, not a lookalike.
    for (const r of outbox.body.revokes) {
      if (r.agent_id !== visitor.agentId) continue;
      expect(verifyRevoke(r).valid).toBe(true);
    }
  });

  it('M1 KEPT: still-unknown and foreign ids stay untouched through the re-send door', async () => {
    const { makeRevoke } = await import(join(FED_DIR, 'protocol.js'));

    // visitor2 writes Z (held under visitor2's authorship); visitor A's
    // hello carries a revoke for Z (validly signed by A) plus a ghost G3.
    const zFields = {
      kind: 'aboutYou', key: 'p14r.foreign',
      text: 'the p14r row authored by another agent the re-send must not touch',
      source: 'visit', at: '2026-10-08T08:20:00Z', supersedes: null
    };
    const zWrite = await visitor2.writeMemory(t, visitor2.visitId, hostNetworkId, zFields);
    expect(zWrite.status).toBe(201);
    const zId = zWrite.body.row.provenance.id;

    const ghost = 'sha256-p14r-still-unknown-ghost';
    const carry = [
      makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [ghost], {
        reason: 'still unknown here', issued_at: new Date().toISOString()
      }),
      makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [zId], {
        reason: 'not my content', issued_at: new Date().toISOString()
      })
    ];
    const knock = await visitor.hello(t, { revokes: carry });
    expect(knock.status).toBe(200);
    expect(knock.body.revokes.applied).toBe(2);

    // Two single-id messages → two revokeRows calls → two outcomes: the ghost
    // stayed unknown, the foreign id was refused, neither wrote a ban.
    const allOutcomes = knock.body.revokes.outcomes;
    const unknownIds = allOutcomes.reduce((n, o) => n + o.unknown, 0);
    const foreignIds = allOutcomes.reduce((n, o) => n + o.foreign, 0);
    expect(unknownIds).toBe(1);
    expect(foreignIds).toBe(1);

    expect(rowInStore(zId)).toBe(1); // the other author's copy survives
    expect(tombCount(zId)).toBe(0);
    expect(tombCount(ghost)).toBe(0); // still-unknown writes no standing ban
  });

  it('a plain hello answers exactly as before — no revokes key, MyceliumKit untouched', async () => {
    const knock = await visitor.hello(t);
    expect(knock.status).toBe(200);
    expect(knock.body.ok).toBe(true);
    expect(knock.body.network_passport).toBeTruthy();
    expect(knock.body.revokes).toBeUndefined();
  });
});

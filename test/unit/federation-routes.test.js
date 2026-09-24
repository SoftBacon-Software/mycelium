// Federation v0 routes (spec/federation-v0/) — the server side of the protocol.
//
// Gates pinned here, per the brief:
//   * default policy   — a fresh network hosts NO visitors (hello says so,
//                        grant refuses, writes 403)
//   * auth             — studio bearer on grant/import, admin on identity;
//                        visitor routes authenticate by agent-signed envelope
//   * tamper           — a flipped signature digit is a 400, never a write
//   * replay           — a reused envelope nonce is a 401; a re-imported
//                        bundle answers replayed and writes nothing
//   * expired grant    — writes and souvenirs past expires_at are 410
//   * export policy    — the souvenir carries ONLY exportable kinds
//   * provenance       — visited AND imported rows carry agent/network/home/
//                        visit/sig intact, on both sides of the trip
//   * isolation        — two owners importing the same bundle each get their
//                        own row (owner-scoped storage ids)
//   * migration        — a pre-federation sm_embeddings gains the fed_*
//                        columns at mount, existing rows stay valid
//   * ROUND TRIP       — agent A (network 1) visits network 2 over HTTP,
//                        writes, leaves with a souvenir, and network 1
//                        imports it with provenance intact
//
// models on test/unit/companion-memory-api.test.js: vitest + supertest +
// express, faked core, in-memory better-sqlite3 seeded from BOTH plugin
// schemas — hermetic, no network, no embedder (keyword arm answers searches).

process.env.MYCELIUM_RATE_LIMIT = 'off';

import { describe, it, beforeAll, afterAll, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { keyFromSeed, idForKey } from '../../server/plugins/federation/keys.js';
import { makeEnvelope, makeRow, makeNetworkPassport, makeVisitRecord, makeBundle } from '../../server/plugins/federation/protocol.js';
import { makeVisitor } from '../../server/plugins/federation/client.js';
import createFederationStore from '../../server/plugins/federation/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FED_DIR = join(HERE, '..', '..', 'server', 'plugins', 'federation');
const MEM_DIR = join(HERE, '..', '..', 'server', 'plugins', 'semantic-memory');

const JWT_SECRET = 'federation-test-secret';
const ADMIN_KEY = 'federation-test-admin-key';
const tokenHome = jwt.sign({ studioUser: true, userId: 1, username: 'gilbert', role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
const tokenHost = jwt.sign({ studioUser: true, userId: 2, username: 'jessica', role: 'operator' }, JWT_SECRET, { expiresIn: '7d' });
const tokenOther = jwt.sign({ studioUser: true, userId: 3, username: 'someone', role: 'operator' }, JWT_SECRET, { expiresIn: '7d' });

// The SAME fixed test material as the committed vectors — an implementation
// that cannot reproduce these keys cannot talk to itself.
function seedFor(label) {
  return crypto.createHash('sha256').update(label, 'utf8').digest('hex');
}
const HOST_SEED = seedFor('mycelium-federation-v0/test/host');
const GUEST_SEED = seedFor('mycelium-federation-v0/test/guest-network');
const AGENT_SEED = seedFor('mycelium-federation-v0/test/agent-a');
const OTHER_SEED = seedFor('mycelium-federation-v0/test/unknown-network');
const HOST_ID = idForKey(keyFromSeed(HOST_SEED));
const GUEST_ID = idForKey(keyFromSeed(GUEST_SEED));

// The pre-federation companion table — no fed_* columns, the shape every
// persistent instance had before this plugin existed.
const OLD_SHAPE = `
CREATE TABLE IF NOT EXISTS sm_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  namespace TEXT,
  chunk_index INTEGER DEFAULT 0,
  content_text TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  superseded_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(source_type, source_id, chunk_index)
);
`;

async function makeApp(opts) {
  opts = opts || {};
  const db = new Database(':memory:');
  if (opts.oldShape) db.exec(OLD_SHAPE);
  db.exec(readFileSync(join(MEM_DIR, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(FED_DIR, 'schema.sql'), 'utf8'));

  const core = {
    db,
    auth: {
      getStudioUser: (req) => {
        const auth = req.headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) return null;
        try {
          const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
          return decoded && decoded.studioUser ? decoded : null;
        } catch (e) { return null; }
      },
      checkAdmin: (req, res) => {
        if (req.headers['x-admin-key'] === ADMIN_KEY) return 'admin-test';
        res.status(401).json({ error: 'admin key required' });
        return null;
      },
      checkAgentOrAdmin: () => null,
      getAdminDisplayName: () => 'admin-test',
    },
    apiError: (res, code, msg, extra) => res.status(code).json(Object.assign({ error: msg }, extra || {})),
    parseIntParam: (v) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? null : n;
    },
    asyncHandler: (fn) => function (req, res, next) {
      return Promise.resolve(fn(req, res, next)).catch(next);
    },
    emitEvent: () => {},
  };

  const { default: createFedRoutes } = await import(join(FED_DIR, 'routes.js'));
  const { default: createMemRoutes } = await import(join(MEM_DIR, 'routes.js'));

  const app = express();
  app.use(express.json());
  app.use('/federation', createFedRoutes(core));
  app.use('/memory', createMemRoutes(core));

  return { db, app };
}

// The visitor's transport — the same shape MyceliumKit plugs a fetch into.
function transport(app) {
  return {
    async post(path, body, headers) {
      const req = request(app).post(path);
      for (const [k, v] of Object.entries(headers || {})) req.set(k, v);
      const res = await req.send(body);
      return { status: res.status, body: res.body };
    }
  };
}

function adminPost(app, path, body) {
  return request(app).post(path).set('X-Admin-Key', ADMIN_KEY).send(body);
}
function bearerPost(app, token, path, body) {
  return request(app).post(path).set('Authorization', 'Bearer ' + token).send(body);
}

describe('federation routes: policy + auth', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('a fresh network hosts no visitors — hello says so honestly, grant refuses', async () => {
    const hello = await request(ctx.app).post('/federation/hello').send({});
    expect(hello.status).toBe(400); // no passports — the knock is checked too

    const v = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED, homeName: 'qurio-phone', agentName: 'Qurio' });
    const knock = await v.hello(transport(ctx.app));
    expect(knock.status).toBe(200);
    expect(knock.body.network_passport.policy.visitors).toBe(false);
    expect(knock.body.network_passport.sig).toBeTruthy();

    const grant = await bearerPost(ctx.app, tokenHost, '/federation/grant', { agent_passport: v.agentPassport });
    expect(grant.status).toBe(403);
    expect(grant.body.error).toContain('no visitors');
  });

  it('hello rejects a forged passport', async () => {
    const v = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED });
    const forged = { ...v.agentPassport, name: 'Impostor' };
    const res = await request(ctx.app).post('/federation/hello').send({
      network_passport: v.networkPassport, agent_passport: forged
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agent_passport rejected');
  });

  it('grant and import require a studio bearer; network requires admin', async () => {
    expect((await request(ctx.app).post('/federation/grant').send({})).status).toBe(401);
    expect((await request(ctx.app).post('/federation/import').send({})).status).toBe(401);
    expect((await request(ctx.app).get('/federation/network')).status).toBe(401);
    expect((await request(ctx.app).post('/federation/network').send({})).status).toBe(401);
  });

  it('admin sets identity and policy; a bad seed is refused', async () => {
    const bad = await adminPost(ctx.app, '/federation/network', { seed_hex: 'nothex' });
    expect(bad.status).toBe(400);

    const res = await adminPost(ctx.app, '/federation/network', {
      seed_hex: HOST_SEED, name: 'lab-host', visitors: true,
      kinds_writable: ['aboutYou', 'howWeTalk'], kinds_exportable: ['aboutYou']
    });
    expect(res.status).toBe(200);
    expect(res.body.network_id).toBe(HOST_ID);
    expect(res.body.policy.visitors).toBe(true);

    const read = await request(ctx.app).get('/federation/network').set('X-Admin-Key', ADMIN_KEY);
    expect(read.status).toBe(200);
    expect(read.body.network_id).toBe(HOST_ID);
  });
});

describe('federation routes: the round trip (network 1 → network 2 → home)', () => {
  let host, home, visitor, grantRes, bundle;

  beforeAll(async () => {
    host = await makeApp();
    home = await makeApp();
    await adminPost(host.app, '/federation/network', {
      seed_hex: HOST_SEED, name: 'lab-host', visitors: true,
      kinds_writable: ['aboutYou', 'howWeTalk'], kinds_exportable: ['aboutYou']
    });
    await adminPost(home.app, '/federation/network', { seed_hex: GUEST_SEED, name: 'qurio-phone' });
    visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED, homeName: 'qurio-phone', agentName: 'Qurio' });
  });
  afterAll(() => {
    try { host.db.close(); } catch (e) { /* already closed */ }
    try { home.db.close(); } catch (e) { /* already closed */ }
  });

  it('HELLO: the knock crosses passports, nothing else', async () => {
    const knock = await visitor.hello(transport(host.app));
    expect(knock.status).toBe(200);
    expect(knock.body.network_passport.network_id).toBe(HOST_ID);
    expect(knock.body.network_passport.policy.visitors).toBe(true);
  });

  it('GRANT: the host owner issues a time-boxed grant', async () => {
    grantRes = await bearerPost(host.app, tokenHost, '/federation/grant', {
      agent_passport: visitor.agentPassport
    });
    expect(grantRes.status).toBe(201);
    expect(grantRes.body.grant.type).toBe('grant-v0');
    expect(grantRes.body.grant.kinds_writable).toEqual(['aboutYou', 'howWeTalk']);
    expect(grantRes.body.grant.kinds_exportable).toEqual(['aboutYou']);
    expect(grantRes.body.visit_id).toBe(grantRes.body.grant.visit_id);
  });

  it('VISIT: writes land in the HOST store, attributed to the visitor', async () => {
    const t = transport(host.app);
    const visitId = grantRes.body.visit_id;

    const dance = await visitor.writeMemory(t, visitId, HOST_ID, {
      kind: 'aboutYou', key: 'dance.pickles-foxtrot',
      text: "Learned the Pickles Foxtrot at a friend's house — 8 counts, ends on the left foot.",
      source: 'visit', at: '2026-09-24T10:05:00Z', supersedes: null
    });
    expect(dance.status).toBe(201);
    expect(dance.body.row.provenance).toMatchObject({
      agent: visitor.agentId, network: HOST_ID, home: GUEST_ID, visit: visitId
    });
    expect(dance.body.row.provenance.sig).toBeTruthy();

    const voice = await visitor.writeMemory(t, visitId, HOST_ID, {
      kind: 'howWeTalk', key: 'greeting.at-lab',
      text: 'At the lab they say "yo" first.', source: 'visit',
      at: '2026-09-24T10:10:00Z', supersedes: null
    });
    expect(voice.status).toBe(201);

    // Outbox replay: the same write is a no-op with the same row.
    const replay = await visitor.writeMemory(t, visitId, HOST_ID, {
      kind: 'aboutYou', key: 'dance.pickles-foxtrot',
      text: "Learned the Pickles Foxtrot at a friend's house — 8 counts, ends on the left foot.",
      source: 'visit', at: '2026-09-24T10:05:00Z', supersedes: null
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    // The host owner sees both rows in their own /me/memory, with provenance.
    const list = await request(host.app).get('/memory/me/memory').set('Authorization', 'Bearer ' + tokenHost);
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(2);
    for (const row of list.body.results) {
      expect(row.provenance.visit).toBe(visitId);
      expect(row.provenance.network).toBe(HOST_ID);
    }
  });

  it('SOUVENIR: only exportable kinds leave; the bundle verifies at the door', async () => {
    const res = await visitor.requestSouvenir(transport(host.app), grantRes.body.visit_id);
    expect(res.status).toBe(200);
    bundle = res.body.bundle;
    expect(bundle.type).toBe('souvenir-v0');

    // THE EXPORT POLICY: howWeTalk was written but is NOT exportable.
    expect(bundle.rows.length).toBe(1);
    expect(bundle.rows[0].kind).toBe('aboutYou');

    // The phone's own door check — same verifier the home server will run.
    const check = visitor.checkSouvenir(bundle);
    expect(check.valid).toBe(true);
  });

  it('IMPORT: the home network lands the rows with provenance intact + one episode', async () => {
    const res = await bearerPost(home.app, tokenHome, '/federation/import', { bundle });
    expect(res.status).toBe(201);
    expect(res.body.outcomes).toEqual([
      { row_id: bundle.rows[0].id, outcome: 'imported' }
    ]);

    const day = bundle.visit.ended_at.slice(0, 10);
    expect(res.body.episode.text).toBe('I visited lab-host on ' + day + ' and learned 1 memories.');
    expect(res.body.episode.source).toBe('visit');

    // Provenance intact on the home side.
    const list = await request(home.app).get('/memory/me/memory').set('Authorization', 'Bearer ' + tokenHome);
    expect(list.status).toBe(200);
    const dance = list.body.results.find((r) => r.key === 'dance.pickles-foxtrot');
    expect(dance).toBeTruthy();
    expect(dance.provenance).toMatchObject({
      id: bundle.rows[0].id,
      agent: visitor.agentId,
      network: HOST_ID,
      home: GUEST_ID,
      visit: bundle.visit.visit_id,
      sig: bundle.rows[0].sig
    });
    expect(dance.candidate).toBeUndefined();
  });

  it('re-importing the same bundle is a replay: same outcomes, nothing written', async () => {
    const before = await request(home.app).get('/memory/me/memory').set('Authorization', 'Bearer ' + tokenHome);
    const res = await bearerPost(home.app, tokenHome, '/federation/import', { bundle });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.outcomes).toEqual([{ row_id: bundle.rows[0].id, outcome: 'replayed' }]);
    const after = await request(home.app).get('/memory/me/memory').set('Authorization', 'Bearer ' + tokenHome);
    expect(after.body.count).toBe(before.body.count);
  });

  it('writes after the souvenir are refused — the visit has ended', async () => {
    const res = await visitor.writeMemory(transport(host.app), grantRes.body.visit_id, HOST_ID, {
      kind: 'aboutYou', key: 'x', text: 'too late', source: 'visit',
      at: '2026-09-24T11:30:00Z', supersedes: null
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('ended');
  });
});

describe('federation routes: tamper, replay, expiry, refusal', () => {
  let app, visitor, grantRes;

  beforeAll(async () => {
    app = (await makeApp()).app;
    // db handle kept for expiry test below
    await adminPost(app, '/federation/network', {
      seed_hex: HOST_SEED, name: 'lab-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
    visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED });
    grantRes = await bearerPost(app, tokenHost, '/federation/grant', { agent_passport: visitor.agentPassport });
    expect(grantRes.status).toBe(201);
  });

  it('a tampered row signature is a 400, never a write', async () => {
    const row = makeRow(visitor.agentKey, visitor.agentId, {
      kind: 'aboutYou', key: 'forged', text: 'not signed honestly', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    }, { agent: visitor.agentId, network: HOST_ID, home: GUEST_ID, visit: grantRes.body.visit_id });
    const flipped = ('0' === row.sig[0] ? '1' : '0') + row.sig.slice(1);
    const res = await request(app).post('/federation/visit/' + grantRes.body.visit_id + '/memory')
      .send(makeEnvelope(visitor.agentKey, visitor.agentId, { row: { ...row, sig: flipped } }, Math.floor(Date.now() / 1000), crypto.randomBytes(16).toString('hex')));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('row-sig');
  });

  it('content tampered under a valid signature fails the content-id check', async () => {
    const row = makeRow(visitor.agentKey, visitor.agentId, {
      kind: 'aboutYou', key: 'forged', text: 'not signed honestly', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    }, { agent: visitor.agentId, network: HOST_ID, home: GUEST_ID, visit: grantRes.body.visit_id });
    const res = await request(app).post('/federation/visit/' + grantRes.body.visit_id + '/memory')
      .send(makeEnvelope(visitor.agentKey, visitor.agentId, { row: { ...row, text: 'quietly rewritten' } }, Math.floor(Date.now() / 1000), crypto.randomBytes(16).toString('hex')));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('row-id');
  });

  it('a kind outside the grant is a 403', async () => {
    const res = await visitor.writeMemory(transport(app), grantRes.body.visit_id, HOST_ID, {
      kind: 'howWeTalk', key: 'not-allowed', text: 'nope', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('does not allow writing kind');
  });

  it('a reused envelope nonce is a replay: 401', async () => {
    const row = makeRow(visitor.agentKey, visitor.agentId, {
      kind: 'aboutYou', key: 'nonce-test', text: 'once only', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    }, { agent: visitor.agentId, network: HOST_ID, home: GUEST_ID, visit: grantRes.body.visit_id });
    const env = makeEnvelope(visitor.agentKey, visitor.agentId, { row }, Math.floor(Date.now() / 1000), 'fixednonce' + crypto.randomBytes(8).toString('hex'));
    const first = await request(app).post('/federation/visit/' + grantRes.body.visit_id + '/memory').send(env);
    expect(first.status).toBe(201);
    const second = await request(app).post('/federation/visit/' + grantRes.body.visit_id + '/memory').send(env);
    expect(second.status).toBe(401);
    expect(second.body.error).toContain('envelope-replay');
  });

  it('an envelope signed by the wrong agent does not ride someone else\'s visit', async () => {
    const stranger = makeVisitor({ homeSeed: OTHER_SEED, agentSeed: seedFor('mycelium-federation-v0/test/stranger') });
    const res = await stranger.writeMemory(transport(app), grantRes.body.visit_id, HOST_ID, {
      kind: 'aboutYou', key: 'hijack', text: 'let me in', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    });
    expect(res.status).toBe(401);
  });

  it('an expired grant refuses writes AND souvenirs with 410', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
      const g = await bearerPost(app, tokenHost, '/federation/grant', {
        agent_passport: visitor.agentPassport, ttl_minutes: 1
      });
      expect(g.status).toBe(201);
      vi.setSystemTime(new Date('2026-09-24T12:30:00Z')); // grant expired at 12:01

      const write = await visitor.writeMemory(transport(app), g.body.visit_id, HOST_ID, {
        kind: 'aboutYou', key: 'late', text: 'too late', source: 'visit',
        at: '2026-09-24T12:10:00Z', supersedes: null
      });
      expect(write.status).toBe(410);
      expect(write.body.error).toContain('grant-expired');

      const souvenir = await visitor.requestSouvenir(transport(app), g.body.visit_id);
      expect(souvenir.status).toBe(410);
    } finally {
      vi.useRealTimers();
    }
  });

  it('import refuses a tampered bundle signature', async () => {
    // Mint an honest bundle via the protocol, then flip one sig digit.
    const hostKey = keyFromSeed(HOST_SEED);
    const hostPp = makeNetworkPassport(hostKey, HOST_ID, {
      name: 'lab-host', policy: { visitors: true, kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] },
      issued_at: '2026-09-24T10:00:00Z'
    });
    const row = makeRow(visitor.agentKey, visitor.agentId, {
      kind: 'aboutYou', key: 'tamper.target', text: 'honest row', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    }, { agent: visitor.agentId, network: HOST_ID, home: GUEST_ID, visit: 'vtest-tamper-0001' });
    const b = makeBundle(hostKey, {
      host_passport: hostPp,
      agent_passport: visitor.agentPassport,
      visit: makeVisitRecord({
        visit_id: 'vtest-tamper-0001', host_network: HOST_ID, agent_id: visitor.agentId,
        home_network: GUEST_ID, grant_id: 'g'.repeat(64), started_at: '2026-09-24T10:00:00Z', ended_at: '2026-09-24T11:00:00Z'
      }),
      rows: [row],
      issued_at: '2026-09-24T11:00:00Z'
    });
    const tampered = { ...b, sig_by_host: ('0' === b.sig_by_host[0] ? '1' : '0') + b.sig_by_host.slice(1) };

    // The importer must know the agent's home (this network) to vouch — same
    // setup as the round trip.
    const homeApp = (await makeApp()).app;
    await adminPost(homeApp, '/federation/network', { seed_hex: GUEST_SEED, name: 'qurio-phone' });
    const res = await bearerPost(homeApp, tokenHome, '/federation/import', { bundle: tampered });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('bundle-sig');

    // A MALICIOUS host: the bundle signature is valid (the host signed this
    // exact content) but the row's provenance does not match the bundle —
    // binding fails even under a perfect signature. (An in-transit row
    // mutation cannot reach this arm: rows are inside the signed content, so
    // tampering trips bundle-sig first — the case above.)
    const rowWrongVisit = makeRow(visitor.agentKey, visitor.agentId, {
      kind: 'aboutYou', key: 'tamper.target', text: 'honest row', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    }, { agent: visitor.agentId, network: HOST_ID, home: GUEST_ID, visit: 'v-someone-elses-visit' });
    const malicious = makeBundle(hostKey, {
      host_passport: hostPp,
      agent_passport: visitor.agentPassport,
      visit: makeVisitRecord({
        visit_id: 'vtest-tamper-0001', host_network: HOST_ID, agent_id: visitor.agentId,
        home_network: GUEST_ID, grant_id: 'g'.repeat(64), started_at: '2026-09-24T10:00:00Z', ended_at: '2026-09-24T11:00:00Z'
      }),
      rows: [rowWrongVisit],
      issued_at: '2026-09-24T11:00:00Z'
    });
    const rowBound = await bearerPost(homeApp, tokenHome, '/federation/import', { bundle: malicious });
    expect(rowBound.status).toBe(400);
    expect(rowBound.body.error).toContain('bundle-row');
  });

  it('import refuses an agent whose home network is unknown — no self-asserted homes', async () => {
    const hostKey = keyFromSeed(HOST_SEED);
    const hostPp = makeNetworkPassport(hostKey, HOST_ID, {
      name: 'lab-host', policy: { visitors: true, kinds_writable: [], kinds_exportable: [] },
      issued_at: '2026-09-24T10:00:00Z'
    });
    const stranger = makeVisitor({ homeSeed: OTHER_SEED, agentSeed: seedFor('mycelium-federation-v0/test/stranger') });
    const b = makeBundle(hostKey, {
      host_passport: hostPp,
      agent_passport: stranger.agentPassport,
      visit: makeVisitRecord({
        visit_id: 'vtest-unknown-0001', host_network: HOST_ID, agent_id: stranger.agentId,
        home_network: stranger.homeNetworkId, grant_id: 'g'.repeat(64), started_at: '2026-09-24T10:00:00Z', ended_at: '2026-09-24T11:00:00Z'
      }),
      rows: [],
      issued_at: '2026-09-24T11:00:00Z'
    });
    const homeApp = (await makeApp()).app;
    await adminPost(homeApp, '/federation/network', { seed_hex: GUEST_SEED, name: 'qurio-phone' });
    const res = await bearerPost(homeApp, tokenHome, '/federation/import', { bundle: b });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('cannot vouch');
  });
});

describe('federation routes: supersede candidates + owner isolation', () => {
  let home;

  beforeAll(async () => {
    home = await makeApp();
    await adminPost(home.app, '/federation/network', { seed_hex: GUEST_SEED, name: 'qurio-phone' });
  });
  afterAll(() => { try { home.db.close(); } catch (e) { /* already closed */ } });

  function honestBundle(visitId, row) {
    const hostKey = keyFromSeed(HOST_SEED);
    const hostPp = makeNetworkPassport(hostKey, HOST_ID, {
      name: 'lab-host', policy: { visitors: true, kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] },
      issued_at: '2026-09-24T10:00:00Z'
    });
    const v = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED, agentName: 'Qurio' });
    return makeBundle(hostKey, {
      host_passport: hostPp,
      agent_passport: v.agentPassport,
      visit: makeVisitRecord({
        visit_id: visitId, host_network: HOST_ID, agent_id: v.agentId,
        home_network: GUEST_ID, grant_id: 'g'.repeat(64), started_at: '2026-09-24T10:00:00Z', ended_at: '2026-09-24T11:00:00Z'
      }),
      rows: [makeRow(v.agentKey, v.agentId, row, { agent: v.agentId, network: HOST_ID, home: GUEST_ID, visit: visitId })],
      issued_at: '2026-09-24T11:00:00Z'
    });
  }

  it('an imported row colliding with a live home row lands as a candidate — never a silent supersede', async () => {
    // The home side already knows a version of this fact.
    const native = await bearerPost(home.app, tokenHome, '/memory/me/memory', {
      text: 'Knows a little dance — picked it up somewhere.',
      source: 'chat', at: '2026-09-20T09:00:00Z', kind: 'aboutYou', key: 'dance.pickles-foxtrot'
    });
    expect(native.status).toBe(201);

    const bundle = honestBundle('vtest-candidate-01', {
      kind: 'aboutYou', key: 'dance.pickles-foxtrot',
      text: "Learned the Pickles Foxtrot at a friend's house — 8 counts, ends on the left foot.",
      source: 'visit', at: '2026-09-24T10:05:00Z', supersedes: null
    });
    const res = await bearerPost(home.app, tokenHome, '/federation/import', { bundle });
    expect(res.status).toBe(201);
    expect(res.body.outcomes[0].outcome).toBe('supersede-candidate');
    expect(res.body.outcomes[0].conflicts_with).toBe(native.body.row.id);

    // The home row is NOT superseded; the candidate is flagged, visible in
    // history, and excluded from recall.
    const list = await request(home.app).get('/memory/me/memory').set('Authorization', 'Bearer ' + tokenHome);
    const home1 = list.body.results.find((r) => r.id === native.body.row.id);
    const cand = list.body.results.find((r) => r.candidate === true);
    expect(home1.superseded_by).toBeNull();
    expect(cand).toBeTruthy();
    expect(cand.provenance.visit).toBe('vtest-candidate-01');

    // 'dance' is in the native row's text and NOT in the candidate's — the
    // keyword arm (no embedder in this harness) separates them exactly.
    const search = await bearerPost(home.app, tokenHome, '/memory/me/memory/search', { query: 'dance' });
    expect(search.status).toBe(200);
    const ids = search.body.results.map((r) => r.id);
    expect(ids).toContain(native.body.row.id);
    expect(ids).not.toContain(cand.id);
  });

  it('two owners importing the same bundle each get their OWN row (isolation holds)', async () => {
    const bundle = honestBundle('vtest-isolation-01', {
      kind: 'aboutYou', key: 'shared.fact', text: 'The same souvenir can reach two people.',
      source: 'visit', at: '2026-09-24T10:05:00Z', supersedes: null
    });
    const a = await bearerPost(home.app, tokenHome, '/federation/import', { bundle });
    expect(a.status).toBe(201);
    expect(a.body.outcomes[0].outcome).toBe('imported');

    // NOT a replay for a different owner — their own scope, their own row.
    const b = await bearerPost(home.app, tokenOther, '/federation/import', { bundle });
    expect(b.status).toBe(201);
    expect(b.body.outcomes[0].outcome).toBe('imported');

    const listA = await request(home.app).get('/memory/me/memory').set('Authorization', 'Bearer ' + tokenHome);
    const listB = await request(home.app).get('/memory/me/memory').set('Authorization', 'Bearer ' + tokenOther);
    const rowA = listA.body.results.find((r) => r.key === 'shared.fact');
    const rowB = listB.body.results.find((r) => r.key === 'shared.fact');
    expect(rowA && rowB).toBeTruthy();
    expect(rowA.id).not.toBe(rowB.id); // owner-scoped storage ids
    expect(listA.body.count).toBeGreaterThan(0);
  });
});

describe('federation routes: the migration leaves existing rows valid', () => {
  it('a pre-federation sm_embeddings gains the fed_* columns at mount', async () => {
    const ctx = await makeApp({ oldShape: true });
    try {
      // A pre-federation row, written the old way.
      ctx.db.prepare(
        "INSERT INTO sm_embeddings (source_type, source_id, chunk_index, content_text, namespace, metadata) VALUES ('companion', 'legacy-row-1', 0, 'An old fact.', 'companion:u9', ?)"
      ).run(JSON.stringify({ owner: 9, kind: 'aboutYou', source: 'chat', at: '2026-09-01T00:00:00Z' }));

      const cols = ctx.db.pragma('table_info(sm_embeddings)').map((c) => c.name);
      for (const c of ['fed_agent', 'fed_network', 'fed_home', 'fed_visit', 'fed_sig']) {
        expect(cols).toContain(c);
      }
      // The legacy row is untouched and reads as a plain home row.
      const row = ctx.db.prepare("SELECT * FROM sm_embeddings WHERE source_id = 'legacy-row-1'").get();
      expect(row.fed_agent).toBeNull();
      expect(row.content_text).toBe('An old fact.');
    } finally {
      try { ctx.db.close(); } catch (e) { /* already closed */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Review A (247r) on PR #189 — every block below was RED on the head 22d84d1b.

describe('federation routes: re-key revokes in-flight grants (review A blocker 2)', () => {
  let ctx, visitor, grantRes, newNetworkId;

  beforeAll(async () => {
    ctx = await makeApp();
    await adminPost(ctx.app, '/federation/network', {
      seed_hex: HOST_SEED, name: 'lab-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
    visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED });
    grantRes = await bearerPost(ctx.app, tokenHost, '/federation/grant', { agent_passport: visitor.agentPassport });
    expect(grantRes.status).toBe(201);
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('a mid-visit re-key revokes the grant — the next write is a 403, never a silent 201', async () => {
    const visitId = grantRes.body.visit_id;
    // The write the operator saw before pulling the lever.
    const before = await visitor.writeMemory(transport(ctx.app), visitId, HOST_ID, {
      kind: 'aboutYou', key: 'rekey.before', text: 'written under key A', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    });
    expect(before.status).toBe(201);

    // The documented emergency lever (README env table, .env.example,
    // routes.js): re-pin the seed → new network identity.
    const rekey = await adminPost(ctx.app, '/federation/network', { seed_hex: OTHER_SEED });
    expect(rekey.status).toBe(200);
    expect(rekey.body.network_id).not.toBe(HOST_ID);
    newNetworkId = rekey.body.network_id;

    // The visitor still holds a grant stamped with the OLD network id; its
    // signature even verifies (against that old key). The CURRENT identity
    // must refuse it at the door.
    const after = await visitor.writeMemory(transport(ctx.app), visitId, HOST_ID, {
      kind: 'aboutYou', key: 'rekey.after', text: 'written after the re-key', source: 'visit',
      at: '2026-09-24T10:06:00Z', supersedes: null
    });
    expect(after.status).toBe(403);
    expect(after.body.error).toContain('re-keyed');
  });

  it('the souvenir door refuses too — no self-inconsistent bundle (new key signing old-network rows)', async () => {
    const res = await visitor.requestSouvenir(transport(ctx.app), grantRes.body.visit_id);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('re-keyed');
  });

  it('the re-keyed network still issues fresh grants under its new identity', async () => {
    const grant = await bearerPost(ctx.app, tokenHost, '/federation/grant', { agent_passport: visitor.agentPassport });
    expect(grant.status).toBe(201);
    expect(grant.body.grant.host_network).toBe(newNetworkId);
    const write = await visitor.writeMemory(transport(ctx.app), grant.body.visit_id, newNetworkId, {
      kind: 'aboutYou', key: 'rekey.fresh', text: 'under the new key', source: 'visit',
      at: '2026-09-24T10:07:00Z', supersedes: null
    });
    expect(write.status).toBe(201);
  });
});

describe('federation routes: the admin end-visit kill switch (review A minor 3)', () => {
  let ctx, visitor, grantRes;

  beforeAll(async () => {
    ctx = await makeApp();
    await adminPost(ctx.app, '/federation/network', {
      seed_hex: HOST_SEED, name: 'lab-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
    visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED });
    grantRes = await bearerPost(ctx.app, tokenHost, '/federation/grant', { agent_passport: visitor.agentPassport });
    expect(grantRes.status).toBe(201);
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('ending an unknown visit is a 404', async () => {
    const res = await adminPost(ctx.app, '/federation/visit/v-does-not-exist/end', {});
    expect(res.status).toBe(404);
  });

  it('end requires admin — a studio bearer is not enough', async () => {
    const res = await bearerPost(ctx.app, tokenHost, '/federation/visit/' + grantRes.body.visit_id + '/end', {});
    expect(res.status).toBe(401);
  });

  it('POST /visit/:id/end revokes the visit: further writes AND souvenirs are 403', async () => {
    const visitId = grantRes.body.visit_id;
    const write = await visitor.writeMemory(transport(ctx.app), visitId, HOST_ID, {
      kind: 'aboutYou', key: 'kill.before', text: 'written while active', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    });
    expect(write.status).toBe(201);

    const end = await adminPost(ctx.app, '/federation/visit/' + visitId + '/end', {});
    expect(end.status).toBe(200);
    expect(end.body.visit.visit_id).toBe(visitId);
    expect(end.body.visit.grant_status).toBe('revoked');

    const lateWrite = await visitor.writeMemory(transport(ctx.app), visitId, HOST_ID, {
      kind: 'aboutYou', key: 'kill.after', text: 'too late', source: 'visit',
      at: '2026-09-24T10:06:00Z', supersedes: null
    });
    expect(lateWrite.status).toBe(403);
    expect(lateWrite.body.error).toContain('revoked');

    const lateSouvenir = await visitor.requestSouvenir(transport(ctx.app), visitId);
    expect(lateSouvenir.status).toBe(403);
    expect(lateSouvenir.body.error).toContain('revoked');
  });
});

describe('federation routes: import bookkeeping is per-owner (review A minor 6)', () => {
  let home;

  beforeAll(async () => {
    home = await makeApp();
    await adminPost(home.app, '/federation/network', { seed_hex: GUEST_SEED, name: 'qurio-phone' });
  });
  afterAll(() => { try { home.db.close(); } catch (e) { /* already closed */ } });

  function honestBundle(visitId) {
    const hostKey = keyFromSeed(HOST_SEED);
    const hostPp = makeNetworkPassport(hostKey, HOST_ID, {
      name: 'lab-host', policy: { visitors: true, kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] },
      issued_at: '2026-09-24T10:00:00Z'
    });
    const v = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED });
    return makeBundle(hostKey, {
      host_passport: hostPp,
      agent_passport: v.agentPassport,
      visit: makeVisitRecord({
        visit_id: visitId, host_network: HOST_ID, agent_id: v.agentId,
        home_network: GUEST_ID, grant_id: 'g'.repeat(64), started_at: '2026-09-24T10:00:00Z', ended_at: '2026-09-24T11:00:00Z'
      }),
      rows: [makeRow(v.agentKey, v.agentId, {
        kind: 'aboutYou', key: 'perowner.fact', text: 'One bundle, two owners, two bookkeeping rows.',
        source: 'visit', at: '2026-09-24T10:05:00Z', supersedes: null
      }, { agent: v.agentId, network: HOST_ID, home: GUEST_ID, visit: visitId })],
      issued_at: '2026-09-24T11:00:00Z'
    });
  }

  it('a second owner\'s re-import takes the bundle-level replay fast path', async () => {
    const bundle = honestBundle('vtest-perowner-01');
    const a = await bearerPost(home.app, tokenHome, '/federation/import', { bundle });
    expect(a.status).toBe(201);
    expect(a.body.replayed).toBe(false);

    const b = await bearerPost(home.app, tokenOther, '/federation/import', { bundle });
    expect(b.status).toBe(201);
    expect(b.body.replayed).toBe(false);

    // Owner B re-imports. Under a bundle_id-only PK, B's outcomes row was
    // silently dropped at their first import, so the fast path never fired
    // for them — this answered replayed:false with per-row 'replayed'
    // outcomes instead. The bookkeeping must be per-owner.
    const again = await bearerPost(home.app, tokenOther, '/federation/import', { bundle });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
  });
});

describe('federation routes: ttl + env validation (review A nit 9)', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
    await adminPost(ctx.app, '/federation/network', {
      seed_hex: HOST_SEED, name: 'lab-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('ttl_minutes: 0 is a 400, not a silent fall-back to the default', async () => {
    const visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: AGENT_SEED });
    const res = await bearerPost(ctx.app, tokenHost, '/federation/grant', {
      agent_passport: visitor.agentPassport, ttl_minutes: 0
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('ttl_minutes');
  });

  it('a garbage FEDERATION_GRANT_TTL_MINUTES falls back to the default instead of 400ing every grant', async () => {
    const prev = process.env.FEDERATION_GRANT_TTL_MINUTES;
    process.env.FEDERATION_GRANT_TTL_MINUTES = 'banana';
    vi.resetModules(); // the TTL env is read at routes.js module scope — re-import it
    try {
      const fresh = await makeApp();
      try {
        await adminPost(fresh.app, '/federation/network', {
          seed_hex: HOST_SEED, visitors: true,
          kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
        });
        const visitor = makeVisitor({ homeSeed: GUEST_SEED, agentSeed: seedFor('mycelium-federation-v0/test/ttl-env') });
        const res = await bearerPost(fresh.app, tokenHost, '/federation/grant', { agent_passport: visitor.agentPassport });
        expect(res.status).toBe(201);
        expect(Date.parse(res.body.grant.expires_at)).toBeGreaterThan(Date.parse(res.body.grant.issued_at));
      } finally {
        try { fresh.db.close(); } catch (e) { /* already closed */ }
      }
    } finally {
      if (prev === undefined) delete process.env.FEDERATION_GRANT_TTL_MINUTES;
      else process.env.FEDERATION_GRANT_TTL_MINUTES = prev;
      vi.resetModules();
    }
  });
});

describe('federation routes: grant + import carry rate limiters (review A nit 10)', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await makeApp();
    await adminPost(ctx.app, '/federation/network', {
      seed_hex: HOST_SEED, visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou']
    });
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  // Unauthenticated posts still count: the limiter runs before the handler,
  // so a compromised bearer hammering the surface is throttled regardless of
  // whether the individual request would have authenticated.
  async function hitsUntil429(path) {
    const prev = process.env.MYCELIUM_RATE_LIMIT;
    process.env.MYCELIUM_RATE_LIMIT = ''; // this file defaults the kill-switch to 'off'
    try {
      for (let i = 0; i < 40; i++) {
        const res = await request(ctx.app).post(path).send({});
        if (res.status === 429) return { hit: true, at: i + 1, body: res.body };
      }
      return { hit: false };
    } finally {
      if (prev === undefined) delete process.env.MYCELIUM_RATE_LIMIT;
      else process.env.MYCELIUM_RATE_LIMIT = prev;
    }
  }

  it('the 31st /grant inside the window is a 429', async () => {
    const out = await hitsUntil429('/federation/grant');
    expect(out.hit).toBe(true);
    expect(out.at).toBe(31);
    expect(out.body.error).toContain('federation/grant');
  });

  it('the 31st /import inside the window is a 429', async () => {
    const out = await hitsUntil429('/federation/import');
    expect(out.hit).toBe(true);
    expect(out.at).toBe(31);
    expect(out.body.error).toContain('federation/import');
  });
});

describe('federation routes: the spec pins the product edges (review A minor 4)', () => {
  it('the spec documents that a grant expiring mid-visit forfeits the souvenir', () => {
    const spec = readFileSync(join(HERE, '..', '..', 'spec', 'federation-v0', 'README.md'), 'utf8');
    expect(spec).toMatch(/forfeit/);
  });
});

describe('federation routes: one companion view, not twins (review A nit 7)', () => {
  it('federation store.view IS the companion view — the shared implementation, byte for byte', async () => {
    const { default: companionView } = await import('../../server/plugins/semantic-memory/companion-view.js');
    const ctx = await makeApp();
    try {
      const store = createFederationStore(ctx.db);
      const agentKey = keyFromSeed(AGENT_SEED);
      const agentId = idForKey(agentKey);
      const row = makeRow(agentKey, agentId, {
        kind: 'aboutYou', key: 'view.parity', text: 'one shape, two surfaces', source: 'visit',
        at: '2026-09-24T10:05:00Z', supersedes: null
      }, { agent: agentId, network: HOST_ID, home: GUEST_ID, visit: 'vtest-view-parity' });
      const written = store.insertFedRow(7, row);
      expect(written.inserted).toBe(true);
      expect(store.view(written.row)).toEqual(companionView(written.row));
    } finally {
      try { ctx.db.close(); } catch (e) { /* already closed */ }
    }
  });
});

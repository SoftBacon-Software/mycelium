// The Companion Memory API (2026-09-21, F-mycelium/246 — docs/companion-memory-api.md).
//
// Mycelium's first CONSUMER memory surface: a phone (the companion app, the
// character Qurio) reads/writes ONE person's memory over the network with a
// per-user token, offline-first, where PERSONA IS MEMORY (rows of kind
// aboutYou / aboutMe / howWeTalk, keyed, newer supersedes older). The brief's
// gates, each pinned here:
//   * owner isolation  — token A cannot read, recall, or forget B's rows
//   * supersede        — replaces in recall; history kept, marked, never hidden
//   * replay           — the offline outbox can re-send forever, idempotently,
//                        and a replay never resurrects a superseded row
//   * recall           — "what does my dog like" finds "Their dog is named
//                        Pickles."; "sister" finds nothing for an owner who
//                        never said sister
//   * auth             — studio bearer ONLY; admin keys are refused here
//   * rate limit       — 60/min across the whole surface, one shared bucket
//
// models on test/unit/lessons-memory-rows.test.js: vitest + supertest +
// express, the plugin's createRoutes() with a faked core and an in-memory
// better-sqlite3 DB seeded from schema.sql — hermetic, no network (the embed
// provider is unset, so autoEmbed is a no-op and searchHybrid runs its
// keyword arm; the response must SAY so). The faked core's getStudioUser
// mirrors routes/mycelium.js: HS256 verify, studioUser flag, payload out.

process.env.MYCELIUM_RATE_LIMIT = 'off'; // armed only in the final describe

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', '..', 'server', 'plugins', 'semantic-memory');

const JWT_SECRET = 'companion-memory-test-secret';
const tokenA = jwt.sign({ studioUser: true, userId: 1, username: 'gilbert', displayName: 'Gilbert', role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
const tokenB = jwt.sign({ studioUser: true, userId: 2, username: 'jessica', displayName: 'Jessica', role: 'operator' }, JWT_SECRET, { expiresIn: '7d' });

async function makeApp() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));

  const core = {
    db,
    auth: {
      // mirrors routes/mycelium.js getStudioUser — the decoder this surface's
      // owner scope is derived from: HS256, the studioUser flag, payload out.
      getStudioUser: (req) => {
        const auth = req.headers['authorization'];
        if (!auth || !auth.startsWith('Bearer ')) return null;
        try {
          const decoded = jwt.verify(auth.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
          return decoded && decoded.studioUser ? decoded : null;
        } catch (e) { return null; }
      },
      checkAdmin: () => false,
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

  const { default: createRoutes } = await import(join(PLUGIN_DIR, 'routes.js'));

  const app = express();
  app.use(express.json());
  app.use('/memory', createRoutes(core));

  return { db, app };
}

function writeMemory(app, token, body) {
  return request(app).post('/memory/me/memory').set('Authorization', 'Bearer ' + token).send(body);
}
function listMemory(app, token, query) {
  return request(app).get('/memory/me/memory' + (query || '')).set('Authorization', 'Bearer ' + token);
}
function searchMemory(app, token, body, query) {
  return request(app).post('/memory/me/memory/search' + (query || '')).set('Authorization', 'Bearer ' + token).send(body);
}

describe('auth: a studio bearer token only — never an admin key', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('refuses a write with no token at all', async () => {
    const res = await request(ctx.app).post('/memory/me/memory').send({ text: 'x', source: 'chat', at: '2026-09-21T20:00:00Z', kind: 'aboutYou' });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('studio bearer token');
  });

  it('refuses an admin key where a phone token belongs — no admin key on a phone, ever', async () => {
    const res = await request(ctx.app).post('/memory/me/memory').set('X-Admin-Key', 'admin-key').send({ text: 'x', source: 'chat', at: '2026-09-21T20:00:00Z', kind: 'aboutYou' });
    expect(res.status).toBe(401);
  });

  it('refuses a forged/garbage bearer token', async () => {
    const res = await writeMemory(ctx.app, 'not-a-jwt', { text: 'x', source: 'chat', at: '2026-09-21T20:00:00Z', kind: 'aboutYou' });
    expect(res.status).toBe(401);
  });

  it('refuses a token whose payload lacks a userId (no owner, no scope)', async () => {
    const bad = jwt.sign({ studioUser: true, username: 'x' }, JWT_SECRET, { expiresIn: '7d' });
    const res = await writeMemory(ctx.app, bad, { text: 'x', source: 'chat', at: '2026-09-21T20:00:00Z', kind: 'aboutYou' });
    expect(res.status).toBe(401);
  });
});

describe('POST /me/memory — write, validate, replay idempotently', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('writes a row and returns the doc shape', async () => {
    const res = await writeMemory(ctx.app, tokenA, {
      text: 'Their dog is named Pickles.',
      source: 'chat',
      at: '2026-09-21T20:15:00.000Z',
      kind: 'aboutYou',
      key: 'dog.name',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.replayed).toBe(false);
    const row = res.body.row;
    expect(row.id).toMatch(/^[0-9a-f]{64}$/);
    expect(row.kind).toBe('aboutYou');
    expect(row.key).toBe('dog.name');
    expect(row.text).toBe('Their dog is named Pickles.');
    expect(row.source).toBe('chat');
    expect(row.at).toBe('2026-09-21T20:15:00.000Z');
    expect(row.created_at).toBeTruthy();
    expect(row.superseded_by).toBeNull();
    expect(row.supersedes).toBeNull();
  });

  it('replaying the same write returns the SAME row, writing nothing', async () => {
    const body = { text: 'He loves the flashlight trick.', source: 'trick', at: '2026-09-21T21:00:00.000Z', kind: 'howWeTalk', key: 'trick.flashlight' };
    const first = await writeMemory(ctx.app, tokenA, body);
    expect(first.status).toBe(201);
    const replay = await writeMemory(ctx.app, tokenA, body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.row.id).toBe(first.body.row.id);
    expect(replay.body.row.created_at).toBe(first.body.row.created_at);
  });

  it('the same text under a DIFFERENT key is a different row (the key is in the identity)', async () => {
    const a = await writeMemory(ctx.app, tokenA, { text: 'He laughs at the ear wiggle.', source: 'chat', at: '2026-09-21T21:10:00.000Z', kind: 'howWeTalk' });
    const b = await writeMemory(ctx.app, tokenA, { text: 'He laughs at the ear wiggle.', source: 'chat', at: '2026-09-21T21:10:00.000Z', kind: 'howWeTalk', key: 'joke.ear' });
    expect(a.body.row.id).not.toBe(b.body.row.id);
  });

  it('refuses each missing field by name', async () => {
    const base = { text: 'x', source: 'chat', at: '2026-09-21T20:00:00Z', kind: 'aboutYou' };
    for (const field of ['text', 'source', 'at', 'kind']) {
      const body = { ...base };
      delete body[field];
      const res = await writeMemory(ctx.app, tokenA, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(field);
    }
  });

  it('refuses a kind outside the three persona kinds, naming the allowed set', async () => {
    const res = await writeMemory(ctx.app, tokenA, { text: 'x', source: 'chat', at: '2026-09-21T20:00:00Z', kind: 'aboutEveryone' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('aboutYou');
    expect(res.body.error).toContain('howWeTalk');
  });

  it('refuses an unparseable at and an oversized text', async () => {
    const badAt = await writeMemory(ctx.app, tokenA, { text: 'x', source: 'chat', at: 'sometime last week', kind: 'aboutYou' });
    expect(badAt.status).toBe(400);
    expect(badAt.body.error).toContain('at');
    const bigText = await writeMemory(ctx.app, tokenA, { text: 'y'.repeat(2001), source: 'chat', at: '2026-09-21T20:00:00Z', kind: 'aboutYou' });
    expect(bigText.status).toBe(400);
    expect(bigText.body.error).toContain('2000');
  });
});

describe('owner isolation: token A cannot read, recall, or forget B', () => {
  let ctx;
  let picklesId;
  let sisterId;
  beforeAll(async () => {
    ctx = await makeApp();
    const pickles = await writeMemory(ctx.app, tokenA, { text: 'Their dog is named Pickles.', source: 'chat', at: '2026-09-21T20:15:00.000Z', kind: 'aboutYou', key: 'dog.name' });
    picklesId = pickles.body.row.id;
    const sister = await writeMemory(ctx.app, tokenB, { text: 'My sister is a doctor.', source: 'chat', at: '2026-09-21T20:16:00.000Z', kind: 'aboutMe', key: 'family.sister' });
    sisterId = sister.body.row.id;
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('GET returns only the caller’s own rows', async () => {
    const a = await listMemory(ctx.app, tokenA);
    expect(a.status).toBe(200);
    expect(a.body.results.map((r) => r.id)).toEqual([picklesId]);
    const b = await listMemory(ctx.app, tokenB);
    expect(b.body.results.map((r) => r.id)).toEqual([sisterId]);
  });

  it('search finds the Pickles row for "what does my dog like" — and NOTHING for "sister"', async () => {
    const dog = await searchMemory(ctx.app, tokenA, { query: 'what does my dog like' });
    expect(dog.status).toBe(200);
    expect(dog.body.count).toBe(1);
    expect(dog.body.results[0].text).toBe('Their dog is named Pickles.');
    // hermetic: no embedder configured — the response must say so, never
    // silently degrade (house rule)
    expect(dog.body.mode).toBe('keyword-fallback');
    expect(dog.body.degraded).toBeTruthy();

    const sister = await searchMemory(ctx.app, tokenA, { query: 'sister' });
    expect(sister.status).toBe(200);
    expect(sister.body.count).toBe(0);
  });

  it('the OTHER owner’s search reaches her own row (positive control)', async () => {
    const res = await searchMemory(ctx.app, tokenB, { query: 'sister' });
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].id).toBe(sisterId);
  });

  it('forgetting another owner’s row 404s — indistinguishable from unknown', async () => {
    const res = await request(ctx.app).post('/memory/me/memory/' + picklesId + '/forget').set('Authorization', 'Bearer ' + tokenB).send();
    expect(res.status).toBe(404);
    const unknown = await request(ctx.app).post('/memory/me/memory/nope/forget').set('Authorization', 'Bearer ' + tokenB).send();
    expect(unknown.status).toBe(404);
    // and the row survived the attempt
    const still = await listMemory(ctx.app, tokenA);
    expect(still.body.results.map((r) => r.id)).toContain(picklesId);
  });

  it('superseding another owner’s row 404s too', async () => {
    const res = await writeMemory(ctx.app, tokenB, {
      text: 'Their dog is named Pickles the poodle.',
      source: 'chat', at: '2026-09-21T22:00:00.000Z', kind: 'aboutYou', key: 'dog.name',
      supersedes: picklesId,
    });
    expect(res.status).toBe(404);
  });

  it('the store itself stays owner-clean: A’s namespace never contains B’s row', async () => {
    const rows = ctx.db.prepare("SELECT namespace, COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'companion' GROUP BY namespace").all();
    const byNs = Object.fromEntries(rows.map((r) => [r.namespace, r.c]));
    expect(byNs['companion:u1']).toBe(1);
    expect(byNs['companion:u2']).toBe(1);
  });
});

describe('supersede: newer replaces older in recall, history kept and marked', () => {
  let ctx;
  let v1;
  let v2;
  beforeAll(async () => {
    ctx = await makeApp();
    const first = await writeMemory(ctx.app, tokenA, { text: 'Their dog is named Pickles.', source: 'chat', at: '2026-09-21T20:15:00.000Z', kind: 'aboutYou', key: 'dog.name' });
    v1 = first.body.row.id;
    const second = await writeMemory(ctx.app, tokenA, { text: 'Their dog is named Pickles the poodle.', source: 'chat', at: '2026-09-21T22:00:00.000Z', kind: 'aboutYou', key: 'dog.name', supersedes: v1 });
    v2 = second.body.row.id;
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('the new row echoes supersedes; the old row carries superseded_by', async () => {
    const rows = (await listMemory(ctx.app, tokenA)).body.results;
    const old = rows.find((r) => r.id === v1);
    const fresh = rows.find((r) => r.id === v2);
    expect(fresh.supersedes).toBe(v1);
    expect(fresh.superseded_by).toBeNull();
    expect(old.superseded_by).toBe(v2);
    expect(old.supersedes).toBeNull();
  });

  it('recall excludes the superseded row by default', async () => {
    const res = await searchMemory(ctx.app, tokenA, { query: 'dog' });
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].id).toBe(v2);
    expect(res.body.results[0].text).toBe('Their dog is named Pickles the poodle.');
  });

  it('?include_superseded=1 reads the dead row back, marked', async () => {
    const res = await searchMemory(ctx.app, tokenA, { query: 'dog' }, '?include_superseded=1');
    expect(res.body.count).toBe(2);
    const ids = res.body.results.map((r) => r.id);
    expect(ids).toContain(v1);
    expect(ids).toContain(v2);
    expect(res.body.results.find((r) => r.id === v1).superseded_by).toBe(v2);
  });

  it('replaying the OLD write never resurrects it — the row comes back as it is now', async () => {
    const replay = await writeMemory(ctx.app, tokenA, { text: 'Their dog is named Pickles.', source: 'chat', at: '2026-09-21T20:15:00.000Z', kind: 'aboutYou', key: 'dog.name' });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.row.id).toBe(v1);
    expect(replay.body.row.superseded_by).toBe(v2); // still dead
    const recall = await searchMemory(ctx.app, tokenA, { query: 'dog' });
    expect(recall.body.count).toBe(1);
    expect(recall.body.results[0].id).toBe(v2);
  });

  it('refuses to supersede an already-superseded row (409, naming the live pointer)', async () => {
    const res = await writeMemory(ctx.app, tokenA, { text: 'Their dog is named Biscuit.', source: 'chat', at: '2026-09-21T23:00:00.000Z', kind: 'aboutYou', key: 'dog.name', supersedes: v1 });
    expect(res.status).toBe(409);
    expect(res.body.superseded_by).toBe(v2);
  });

  it('refuses a self-supersede (the id this write would create) with 400', async () => {
    const body = { text: 'Same text twice.', source: 'chat', at: '2026-09-21T23:10:00.000Z', kind: 'aboutMe' };
    const first = await writeMemory(ctx.app, tokenA, body);
    expect(first.status).toBe(201);
    const selfRef = await writeMemory(ctx.app, tokenA, { ...body, supersedes: first.body.row.id });
    expect(selfRef.status).toBe(400);
    expect(selfRef.body.error).toContain('itself');
  });
});

describe('GET /me/memory — kinds, since cursor, limits', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await writeMemory(ctx.app, tokenA, { text: 'She prefers tea in the morning.', source: 'chat', at: '2026-09-20T08:00:00.000Z', kind: 'aboutYou', key: 'drink.morning' });
    await writeMemory(ctx.app, tokenA, { text: 'We say "zoomies" for the happy dance.', source: 'chat', at: '2026-09-21T09:00:00.000Z', kind: 'howWeTalk', key: 'vocab.zoomies' });
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('filters by kind', async () => {
    const res = await listMemory(ctx.app, tokenA, '?kind=howWeTalk');
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].key).toBe('vocab.zoomies');
  });

  it('refuses a kind outside the persona kinds', async () => {
    const res = await listMemory(ctx.app, tokenA, '?kind=nope');
    expect(res.status).toBe(400);
  });

  it('honours the since cursor on the store clock', async () => {
    const all = await listMemory(ctx.app, tokenA);
    expect(all.body.count).toBe(2);
    const newest = all.body.results[0].created_at; // store clock, 'YYYY-MM-DD HH:MM:SS'
    const after = await listMemory(ctx.app, tokenA, '?since=' + encodeURIComponent(newest));
    expect(after.body.count).toBe(0);
    const before = await listMemory(ctx.app, tokenA, '?since=2020-01-01T00:00:00Z');
    expect(before.body.count).toBe(2);
  });

  it('refuses a garbage since', async () => {
    const res = await listMemory(ctx.app, tokenA, '?since=whenever');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('since');
  });

  it('honours limit', async () => {
    const res = await listMemory(ctx.app, tokenA, '?limit=1');
    expect(res.body.count).toBe(1);
  });
});

describe('kinds filter on search', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await writeMemory(ctx.app, tokenA, { text: 'Their dog is named Pickles.', source: 'chat', at: '2026-09-21T20:15:00.000Z', kind: 'aboutYou' });
    await writeMemory(ctx.app, tokenA, { text: 'The dog puppet is his favorite game.', source: 'game', at: '2026-09-21T20:20:00.000Z', kind: 'howWeTalk' });
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('restricts recall to the requested kinds', async () => {
    const all = await searchMemory(ctx.app, tokenA, { query: 'dog' });
    expect(all.body.count).toBe(2);
    const onlyTalk = await searchMemory(ctx.app, tokenA, { query: 'dog', kinds: ['howWeTalk'] });
    expect(onlyTalk.body.count).toBe(1);
    expect(onlyTalk.body.results[0].kind).toBe('howWeTalk');
  });

  it('refuses invalid kinds', async () => {
    const bad = await searchMemory(ctx.app, tokenA, { query: 'dog', kinds: ['aboutEveryone'] });
    expect(bad.status).toBe(400);
    const empty = await searchMemory(ctx.app, tokenA, { query: 'dog', kinds: [] });
    expect(empty.status).toBe(400);
  });
});

describe('forget: a hard delete from store, index, and recall', () => {
  let ctx;
  let id;
  beforeAll(async () => {
    ctx = await makeApp();
    const row = await writeMemory(ctx.app, tokenA, { text: 'A secret we never speak of.', source: 'chat', at: '2026-09-21T20:00:00.000Z', kind: 'aboutMe' });
    id = row.body.row.id;
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('removes the row from the caller’s own recall and list', async () => {
    const res = await request(ctx.app).post('/memory/me/memory/' + id + '/forget').set('Authorization', 'Bearer ' + tokenA).send();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.forgotten).toBe(id);

    const list = await listMemory(ctx.app, tokenA);
    expect(list.body.count).toBe(0);
    const recall = await searchMemory(ctx.app, tokenA, { query: 'secret' });
    expect(recall.body.count).toBe(0);
    // gone at the store layer too — the FTS row left with it
    const fts = ctx.db.prepare("SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_id = ?").get(id);
    expect(fts.c).toBe(0);
  });

  it('forgetting an unknown id 404s', async () => {
    const res = await request(ctx.app).post('/memory/me/memory/deadbeef/forget').set('Authorization', 'Bearer ' + tokenA).send();
    expect(res.status).toBe(404);
  });
});

describe('rate limit: 60/min across the whole surface, one shared bucket', () => {
  let ctx;
  beforeAll(async () => {
    process.env.MYCELIUM_RATE_LIMIT = 'on'; // arm — the rest of the file runs with it off
    ctx = await makeApp();
  });
  afterAll(() => {
    process.env.MYCELIUM_RATE_LIMIT = 'off';
    try { ctx.db.close(); } catch (e) { /* already closed */ }
  });

  it('the 61st call inside a minute 429s with Retry-After', async () => {
    let saw429 = 0;
    for (let i = 0; i < 61; i++) {
      const res = await writeMemory(ctx.app, tokenA, { text: 'rate probe ' + i, source: 'probe', at: '2026-09-21T20:00:00.000Z', kind: 'aboutMe' });
      if (res.status === 429) {
        saw429++;
        expect(res.body.error).toContain('memory/companion');
        expect(res.headers['retry-after']).toBeTruthy();
      } else {
        expect(res.status).toBe(201);
      }
    }
    expect(saw429).toBe(1); // the shared bucket trips exactly at the 61st
    // the same bucket shelters the surface's other routes (write, list,
    // search, forget share ONE budget — four buckets would quietly make it 240)
    const list = await listMemory(ctx.app, tokenA);
    expect(list.status).toBe(429);
  });
});

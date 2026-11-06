// GET /memory/list reads a namespace's CURRENT rows across kinds
// (F-mycelium/378, 2026-11-06).
//
// THE HOLE: the list route takes ONE source_type and returns superseded rows
// beside live ones, newest-INSERTED first. A game master booting on
// game:build-and-die cannot ask the platform "every current ruling,
// measurement, look and mechanic in this namespace, dated" — N similarity
// searches rank by query and never promise completeness. The second form,
// `source_types=ruling,measurement,look&namespace=game:<name>`, is the
// deterministic read: superseded rows excluded by default with the SAME
// predicate the lesson reads use (db's shared LIVE_ROW predicate), ordered by
// the row's OWN date (valid_from, then learned_at, then created_at — 186's
// rule generalized), ties by source_type + source_id so two calls return
// byte-identical bodies, and `truncated: true` when limit cut the list
// (silently capping a "complete" read is the false-zero hazard /search
// documents). The single-source_type form is UNCHANGED byte for byte —
// snapshotted from the base and compared.
//
// GATES (the brief): three current rows newest-valid_from-first with the
// other namespace absent; include_superseded=1 returns the dead row with its
// pointer; source_types without namespace is a 400; a companion kind in the
// list is refused as today; two calls are byte-identical; limit=2 reports
// truncated; the single-kind body on the same seed equals the base's body.
//
// Harness: same as lesson-supersede-kinds.test.js — vitest + supertest +
// express, the plugin's createRoutes() with a faked core and an in-memory
// better-sqlite3 DB seeded from schema.sql; no embedder configured. Seed
// writes assert their HTTP status (the SEED LAW, F-mycelium 369).
//
// The single-kind snapshot: run `SNAPSHOT_UPDATE=1 npx vitest run
// test/unit/memory-list-current-rows.test.js` against the BASE (before any
// route change) — it seeds the namespace, captures the exact single-kind
// response body, serializes the seeded DB, and writes both to
// test/unit/fixtures/memory-list-single-kind.snapshot.json. The default run
// mounts the CURRENT routes over that frozen DB and demands the body match
// byte for byte.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', '..', 'server', 'plugins', 'semantic-memory');
const FIXTURE_DIR = join(HERE, 'fixtures');
const FIXTURE = join(FIXTURE_DIR, 'memory-list-single-kind.snapshot.json');

const NS = 'game:build-and-die';
const OTHER_NS = 'game:four-isles';

async function makeApp(existingDb) {
  const db = existingDb || new Database(':memory:');
  if (!existingDb) db.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));

  const core = {
    db,
    auth: {
      checkAdmin: (req, res) => {
        if (req.headers['x-admin-key'] === 'admin-key') return true;
        res.status(401).json({ error: 'Authentication required' });
        return false;
      },
      checkAgentOrAdmin: () => 'tester-agent',
      getAdminDisplayName: (req) => req.headers['x-acting-as'] || 'admin-test',
    },
    apiError: (res, code, msg, extra) => res.status(code).json(Object.assign({ error: msg }, extra || {})),
    parseIntParam: (v, d) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? d : n;
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

// A game-namespace row with its OWN date (valid_from) stamped — the field
// this task's ordering rule reads first, falling back to learned_at and
// created_at. Rulings are lesson-class (262's map), so they carry the full
// provenance trio; measurement and look are plain agent-writable kinds that
// still carry honest provenance.
function gameRow(overrides = {}) {
  const { source_type, source_id, content_text, namespace, ...metadata } = overrides;
  return {
    source_type: source_type,
    source_id: source_id,
    content_text: content_text,
    namespace: namespace || NS,
    metadata: metadata,
  };
}

async function postRow(app, row, expectStatus = 200) {
  const res = await request(app).post('/memory/index').send(row);
  expect(res.status).toBe(expectStatus);
  return res;
}

// The seed: two rulings on ONE subject (the first superseded through 262's
// kind-aware route), one measurement, one look — all in game:build-and-die —
// plus a ruling in ANOTHER namespace that must never leak into this read.
async function seedAll(app) {
  await postRow(app, gameRow({
    source_type: 'ruling', source_id: 'r-v1',
    content_text: 'GM ruling: SAND is green.',
    kind: 'ruling', subject: 'sand-colour',
    actor: 'gm-probe', evidence: 'table session 2026-10-29',
    learned_at: '2026-10-01', valid_from: '2026-10-01',
  }));
  const sup = await request(app).post('/memory/lessons/r-v1/supersede').send({
    by_text: 'GM ruling v2: SAND is green (corrected — it was always green).',
    new_source_id: 'r-v2',
    reason: 'the table re-read the map; the colour was ruled on wrongly',
    actor: 'gm-probe',
    evidence: 'table session 2026-10-29, map v2',
    learned_at: '2026-10-20',
    metadata: { valid_from: '2026-10-20' },
  });
  expect(sup.status).toBe(200);
  expect(sup.body.ok).toBe(true);
  expect(sup.body.replacement.source_id).toBe('r-v2');
  await postRow(app, gameRow({
    source_type: 'measurement', source_id: 'm-1',
    content_text: 'pop-a-shot hoop height measured at 2.2 m.',
    kind: 'measurement', metric: 'hoop_height_m', value: '2.2',
    actor: 'gm-probe', evidence: 'tape measure',
    learned_at: '2026-10-05', valid_from: '2026-10-05',
  }));
  await postRow(app, gameRow({
    source_type: 'look', source_id: 'l-1',
    content_text: 'hangar look: amber hazard stripes on the lift arms.',
    kind: 'look', target: 'hangar-lift',
    actor: 'gm-probe', evidence: 'in-game still',
    learned_at: '2026-10-25', valid_from: '2026-10-25',
  }));
  await postRow(app, gameRow({
    source_type: 'ruling', source_id: 'r-other', namespace: OTHER_NS,
    content_text: 'GM ruling: ferries leave only at dawn.',
    kind: 'ruling', subject: 'ferry-schedule',
    actor: 'gm-probe', evidence: 'table session 2026-10-30',
    learned_at: '2026-10-30', valid_from: '2026-10-30',
  }));
}

const list = (app, q) => request(app).get('/memory/list' + q);

describe('GET /memory/list source_types — a game namespace reads its current rows (F-mycelium/378)', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await seedAll(ctx.app);
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('three current rows, newest valid_from first, the other namespace absent', async () => {
    const res = await list(ctx.app,
      '?source_types=ruling,measurement,look&namespace=' + encodeURIComponent(NS));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.truncated).toBe(false);
    expect(res.body.include_superseded).toBe(false);
    expect(res.body.namespace).toBe(NS);
    expect(res.body.source_types).toEqual(['ruling', 'measurement', 'look']);
    const ids = res.body.results.map((r) => r.source_id);
    // the row's OWN date desc: look 10-25 > ruling v2 10-20 > measurement 10-05
    expect(ids).toEqual(['l-1', 'r-v2', 'm-1']);
    // the dead ruling and the other namespace never appear
    expect(ids).not.toContain('r-v1');
    expect(ids).not.toContain('r-other');
  });

  it('include_superseded=1 returns four, the dead one carrying superseded_by', async () => {
    const res = await list(ctx.app,
      '?source_types=ruling,measurement,look&namespace=' + encodeURIComponent(NS) + '&include_superseded=1');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(4);
    expect(res.body.include_superseded).toBe(true);
    const ids = res.body.results.map((r) => r.source_id);
    expect(ids).toEqual(['l-1', 'r-v2', 'm-1', 'r-v1']);
    expect(ids).not.toContain('r-other');
    const dead = res.body.results.find((r) => r.source_id === 'r-v1');
    const meta = typeof dead.metadata === 'string' ? JSON.parse(dead.metadata) : dead.metadata;
    expect(meta.superseded_by).toBe('r-v2');
  });

  it('source_types without namespace is a 400 naming namespace', async () => {
    const res = await list(ctx.app, '?source_types=ruling,measurement,look');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('namespace');
  });

  it('both source_type and source_types is a 400 (one sentence)', async () => {
    const res = await list(ctx.app,
      '?source_type=ruling&source_types=ruling,measurement&namespace=' + encodeURIComponent(NS));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('source_type');
    expect(res.body.error).toContain('source_types');
  });

  it('more than eight kinds is a 400', async () => {
    const kinds = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'].join(',');
    const res = await list(ctx.app, '?source_types=' + kinds + '&namespace=' + encodeURIComponent(NS));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('8');
  });

  it('an empty source_types is a 400', async () => {
    for (const q of ['?source_types=&namespace=' + encodeURIComponent(NS), '?source_types=,,&namespace=' + encodeURIComponent(NS)]) {
      const res = await list(ctx.app, q);
      expect(res.status).toBe(400);
    }
  });

  it('a companion kind in the list is refused as today (403, companion-private)', async () => {
    const res = await list(ctx.app,
      '?source_types=ruling,companion&namespace=' + encodeURIComponent(NS));
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('companion-private');
  });

  it('two calls return byte-identical bodies', async () => {
    const q = '?source_types=ruling,measurement,look&namespace=' + encodeURIComponent(NS);
    const a = await list(ctx.app, q);
    const b = await list(ctx.app, q);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.text).toBe(a.text);
  });

  it('limit=2 reports truncated: true and the slice keeps the own-date order', async () => {
    const res = await list(ctx.app,
      '?source_types=ruling,measurement,look&namespace=' + encodeURIComponent(NS) + '&limit=2');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.truncated).toBe(true);
    expect(res.body.results.map((r) => r.source_id)).toEqual(['l-1', 'r-v2']);
  });
});

describe('the single-source_type form is byte-identical to the base (snapshot)', () => {
  // Generated against the BASE by running with SNAPSHOT_UPDATE=1 BEFORE the
  // route/db change: the frozen DB and the exact response body come from the
  // unmodified code; the comparison below mounts the CURRENT code.
  const UPDATE = process.env.SNAPSHOT_UPDATE === '1';
  const SINGLE_Q = '?source_type=ruling&namespace=' + encodeURIComponent(NS) + '&limit=100';

  let ctx;
  beforeAll(async () => {
    if (UPDATE) {
      ctx = await makeApp();
      await seedAll(ctx.app);
      const res = await list(ctx.app, SINGLE_Q);
      expect(res.status).toBe(200);
      const serialized = ctx.db.serialize();
      if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(FIXTURE, JSON.stringify({
        db: serialized.toString('base64'),
        body: res.text,
      }));
      ctx.fixtureBody = res.text; // the generator run compares against itself
      return;
    }
    expect(existsSync(FIXTURE), 'snapshot fixture missing — run `SNAPSHOT_UPDATE=1 npx vitest run ' +
      'test/unit/memory-list-current-rows.test.js` on the BASE and commit the fixture').toBe(true);
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const db = new Database(Buffer.from(fixture.db, 'base64'));
    ctx = await makeApp(db);
    ctx.fixtureBody = fixture.body;
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('the single-kind body on the same seed equals the base’s body, byte for byte', async () => {
    const res = await list(ctx.app, SINGLE_Q);
    expect(res.status).toBe(200);
    expect(res.text).toBe(ctx.fixtureBody);
  });
});

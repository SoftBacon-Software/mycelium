// POST /memory/lessons/:id/supersede — a lesson can be corrected without being lost
// (2026-09-18, F-mycelium/237 — BRIEF-lab-alive-memory-program §1 refined with §3).
//
// THE HOLE: a lesson row had no supersede path — a wrong or outdated lesson
// recalled FOREVER at full rank, with no marker and no retirement. The store's
// own incident proved the need: a chronicler row banked a PLAN as a FACT and the
// cure was delete + supersede, done BY HAND on the live store. For lesson rows
// there was nothing to reach for: a lesson the harness wrote, it could not
// retire.
//
// THE SHAPE (mirroring am_facts' POST /facts/:id/supersede and the timeline
// arm's rendering, both already shipped here):
//   * refusals at the route, each naming the field: missing actor/evidence/reason
//     → 400; self-supersede → 400; neither/both of by_text|by_id → 400; a by_id
//     that names no lesson → 400; an unknown lesson → 404; an assembled
//     correction that fails the FULL 186 provenance contract → 400 exactly like
//     a first lesson; a row already superseded → 409 naming the existing pointer.
//   * effect: the old row's metadata gains valid_to / superseded_by /
//     superseded_by_text; by_text writes the NEW lesson through the SAME index
//     path; BOTH rows re-indexed — the old row's indexed content gains
//     "[superseded on <date> by: <new lesson text>]"; NEVER a delete.
//   * GET /memory/lessons: the default block EXCLUDES superseded rows;
//     ?include_superseded=1 renders them with their supersede line and
//     provenance. /memory/stats stamps lessons_superseded (count + latest).
//
// PRE-COMMITTED: default-block purity 100% — in every fixture below, zero
// superseded rows render in the default block (asserted per test); the
// include-flag block renders every superseded row exactly once with its
// pointer. The first real supersede on the live store is the director's call,
// not a test's.
//
// Harness: same as lessons-memory-rows.test.js — vitest + supertest + express,
// the plugin's createRoutes() with a faked core and an in-memory
// better-sqlite3 DB seeded from schema.sql; no embedder configured, so
// searchHybrid runs its keyword arm (hermetic, no network).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', '..', 'server', 'plugins', 'semantic-memory');

async function makeApp() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));

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

// A fully-provenanced lesson row (the §1 contract), as lessonRow() builds in
// lessons-memory-rows.test.js.
function lessonRow(overrides = {}) {
  const { source_type, source_id, content_text, ...metadataOverrides } = overrides;
  return {
    source_type: source_type || 'lesson',
    source_id: source_id || 'lesson-' + Math.random().toString(36).slice(2, 8),
    content_text: content_text || 'the gate skipped with exit 2 — resolve qualified rows before running',
    metadata: {
      symptom: 'the gate skipped with exit 2',
      fix_or_rule: 'resolve qualified rows before running',
      task_class: 'tool-call-shape',
      repo: 'jarvis',
      actor: 'kira',
      origin: { workflow_id: 'wf500' },
      outcome: 'fixed',
      evidence: 'receipts/wf500/verdict.md',
      learned_at: '2026-09-09',
      ...metadataOverrides,
    },
  };
}

async function postRow(app, row) {
  return request(app).post('/memory/index').send(row);
}

const supersede = (app, id, body) =>
  request(app).post('/memory/lessons/' + encodeURIComponent(id) + '/supersede').send(body);

const CORRECTION = 'the gate skipped with exit 2 — resolve qualified rows BEFORE the wave, not after';
const BASE_BODY = {
  by_text: CORRECTION,
  reason: 'the original lesson said "before running"; the wave boundary is the moment that matters',
  actor: 'm5max',
  evidence: 'runs/wf501/verdict.md#lesson-supersede',
};

describe('POST /memory/lessons/:id/supersede — refusals, each naming the field', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await postRow(ctx.app, lessonRow({ source_id: 'sup-old', learned_at: '2026-09-01' }));
    await postRow(ctx.app, lessonRow({ source_id: 'sup-succ', learned_at: '2026-09-02' }));
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('refuses a missing reason (400, names the field)', async () => {
    const body = { ...BASE_BODY }; delete body.reason;
    const res = await supersede(ctx.app, 'sup-old', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('reason');
  });

  it('refuses a missing actor (400, names the field)', async () => {
    const body = { ...BASE_BODY }; delete body.actor;
    const res = await supersede(ctx.app, 'sup-old', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('actor');
  });

  it('refuses a missing evidence (400, names the field)', async () => {
    const body = { ...BASE_BODY }; delete body.evidence;
    const res = await supersede(ctx.app, 'sup-old', body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('evidence');
  });

  it('refuses a whitespace-only reason like a missing one', async () => {
    const res = await supersede(ctx.app, 'sup-old', { ...BASE_BODY, reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('reason');
  });

  it('refuses a self-supersede: by_id naming the lesson being superseded (400)', async () => {
    const res = await supersede(ctx.app, 'sup-old', {
      by_id: 'sup-old', reason: 'r', actor: 'a', evidence: 'e',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('sup-old');
  });

  it('refuses a call with neither by_text nor by_id (400)', async () => {
    const res = await supersede(ctx.app, 'sup-old', { reason: 'r', actor: 'a', evidence: 'e' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('by_text');
    expect(res.body.error).toContain('by_id');
  });

  it('refuses a call with BOTH by_text and by_id (400)', async () => {
    const res = await supersede(ctx.app, 'sup-old', {
      ...BASE_BODY, by_id: 'sup-succ',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('by_text');
    expect(res.body.error).toContain('by_id');
  });

  it('refuses a by_id that names no lesson row (400, names it)', async () => {
    const res = await supersede(ctx.app, 'sup-old', {
      by_id: 'no-such-lesson', reason: 'r', actor: 'a', evidence: 'e',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('no-such-lesson');
  });

  it('refuses superseding a lesson that does not exist (404, names it)', async () => {
    const res = await supersede(ctx.app, 'ghost-lesson', BASE_BODY);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('ghost-lesson');
  });

  it('refuses a correction that fails the FULL 186 contract, exactly like a first lesson', async () => {
    // the route assembles the new row's metadata from the call (learned_at
    // defaults to now); an explicitly EMPTY learned_at must hit the same
    // provenance gate a first lesson hits — not ride in under the supersede
    const res = await supersede(ctx.app, 'sup-old', { ...BASE_BODY, learned_at: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('learned_at');
    // and NOTHING was written: the old row is untouched (still live, no pointer)
    const check = await request(ctx.app).get('/memory/lessons?limit=100').expect(200);
    const ids = check.body.results.map((r) => r.source_id);
    expect(ids).toContain('sup-old');
    expect(ids).toContain('sup-succ');
    const old = check.body.results.find((r) => r.source_id === 'sup-old');
    expect(old.metadata.superseded_by).toBeUndefined();
  });
});

describe('POST /memory/lessons/:id/supersede — the by_text correction (both rows re-indexed, never a delete)', () => {
  let ctx;
  let replacementId;
  beforeAll(async () => {
    ctx = await makeApp();
    await postRow(ctx.app, lessonRow({
      source_id: 'old-lesson', learned_at: '2026-09-01',
      content_text: 'old lesson text — the stale rule the recall block kept teaching',
    }));
    await postRow(ctx.app, lessonRow({
      source_id: 'bystander-lesson', learned_at: '2026-09-03',
      content_text: 'an unrelated live lesson that stays live',
    }));
    const res = await supersede(ctx.app, 'old-lesson', BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    replacementId = res.body.replacement && res.body.replacement.source_id;
    expect(replacementId).toBeTruthy();
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('the OLD row keeps its pointer fields: valid_to, superseded_by, superseded_by_text', async () => {
    const res = await request(ctx.app)
      .get('/memory/lessons?include_superseded=1&limit=100').expect(200);
    const old = res.body.results.find((r) => r.source_id === 'old-lesson');
    expect(old).toBeTruthy();
    expect(old.metadata.superseded_by).toBe(replacementId);
    expect(old.metadata.superseded_by_text).toBe(CORRECTION);
    expect(old.metadata.valid_to).toBeTruthy();
  });

  it('the old row was NOT deleted — history is kept (the §3 rule)', async () => {
    const row = ctx.db.prepare(
      "SELECT * FROM sm_embeddings WHERE source_type = 'lesson' AND source_id = 'old-lesson' AND chunk_index = 0"
    ).get();
    expect(row).toBeTruthy();
    expect(row.content_text).toContain('old lesson text');
    expect(row.content_text).toContain('[superseded on ');
    expect(row.content_text).toContain('by: ' + CORRECTION + ']');
  });

  it('the RE-INDEXED search row carries the supersede line (read through searchHybrid, not the DB row)', async () => {
    const res = await request(ctx.app)
      .get('/memory/lessons?q=' + encodeURIComponent('stale rule') + '&include_superseded=1')
      .expect(200);
    const hit = res.body.results.find((r) => r.source_id === 'old-lesson');
    expect(hit).toBeTruthy();
    expect(hit.content_text).toContain('[superseded on');
    expect(hit.content_text).toContain('by: ' + CORRECTION + ']');
  });

  it('the NEW row went through the SAME index path with the FULL 186 provenance', async () => {
    const res = await request(ctx.app)
      .get('/memory/lessons?include_superseded=1&limit=100').expect(200);
    const newRow = res.body.results.find((r) => r.source_id === replacementId);
    expect(newRow).toBeTruthy();
    expect(newRow.source_type).toBe('lesson');
    expect(newRow.content_text).toBe(CORRECTION);
    expect(newRow.metadata.actor).toBe('m5max');
    expect(newRow.metadata.evidence).toBe(BASE_BODY.evidence);
    expect(newRow.metadata.learned_at).toBeTruthy();
    // the correction names what it replaced, and carries the reason
    expect(newRow.metadata.supersedes).toBe('old-lesson');
    expect(newRow.metadata.reason).toBe(BASE_BODY.reason);
  });

  it('DEFAULT-BLOCK PURITY: the superseded row is gone from the default block while its successor is present', async () => {
    const res = await request(ctx.app).get('/memory/lessons?limit=100').expect(200);
    const ids = res.body.results.map((r) => r.source_id);
    expect(ids).not.toContain('old-lesson');          // the dead version teaches no more
    expect(ids).toContain(replacementId);             // the successor is present in the SAME fixture
    expect(ids).toContain('bystander-lesson');        // live rows untouched
  });

  it('DEFAULT-BLOCK PURITY in the q= arm too: the dead version does not rank', async () => {
    // "exit 2" matches BOTH rows textually — the successor through its own
    // text, the old row through its re-indexed supersede line — so the only
    // thing that can tell them apart here is the supersede marker itself.
    const res = await request(ctx.app)
      .get('/memory/lessons?q=' + encodeURIComponent('exit 2')).expect(200);
    const ids = res.body.results.map((r) => r.source_id);
    expect(ids).not.toContain('old-lesson');
    expect(ids).toContain(replacementId);
  });

  it('the include-flag block renders the superseded row EXACTLY ONCE with its pointer', async () => {
    const res = await request(ctx.app)
      .get('/memory/lessons?include_superseded=1&limit=100').expect(200);
    const hits = res.body.results.filter((r) => r.source_id === 'old-lesson');
    expect(hits.length).toBe(1);
    expect(hits[0].metadata.superseded_by).toBe(replacementId);
    expect(hits[0].metadata.valid_to).toBeTruthy();
  });

  it('an already-superseded row refuses with 409 naming the EXISTING pointer', async () => {
    const res = await supersede(ctx.app, 'old-lesson', {
      by_text: 'a second correction that must not land on history',
      reason: 'r2', actor: 'a2', evidence: 'e2',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(replacementId);
    // and the refused second correction wrote nothing
    const row = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'lesson' AND content_text LIKE '%second correction%'"
    ).get();
    expect(row.c).toBe(0);
  });

  it('a by_text collision with an existing source_id refuses instead of overwriting it', async () => {
    const res = await supersede(ctx.app, 'bystander-lesson', {
      ...BASE_BODY, new_source_id: replacementId, // already taken by the first correction
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(replacementId);
    // the existing row that owned the id is unchanged
    const row = ctx.db.prepare(
      "SELECT content_text FROM sm_embeddings WHERE source_type = 'lesson' AND source_id = ? AND chunk_index = 0"
    ).get(replacementId);
    expect(row.content_text).toBe(CORRECTION);
  });
});

describe('POST /memory/lessons/:id/supersede — the by_id correction points at an existing lesson', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await postRow(ctx.app, lessonRow({ source_id: 'byid-old', learned_at: '2026-09-01' }));
    await postRow(ctx.app, lessonRow({
      source_id: 'byid-new', learned_at: '2026-09-02',
      content_text: 'the successor lesson, already written by the harness',
    }));
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('supersedes toward the EXISTING row and leaves it live and untouched', async () => {
    const res = await supersede(ctx.app, 'byid-old', {
      by_id: 'byid-new', reason: 'the harness already wrote the corrected row', actor: 'm5max', evidence: 'e',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.superseded.superseded_by).toBe('byid-new');
    expect(res.body.superseded.superseded_by_text).toBe('the successor lesson, already written by the harness');

    // default block: the old row is gone, the successor still there (once)
    const check = await request(ctx.app).get('/memory/lessons?limit=100').expect(200);
    const ids = check.body.results.map((r) => r.source_id);
    expect(ids).not.toContain('byid-old');
    expect(ids.filter((i) => i === 'byid-new').length).toBe(1);
    // the successor's own metadata carries no supersede markers — it is LIVE
    const succ = check.body.results.find((r) => r.source_id === 'byid-new');
    expect(succ.metadata.superseded_by).toBeUndefined();
    expect(succ.metadata.valid_to).toBeUndefined();

    // and the old row is under the include flag with its pointer
    const incl = await request(ctx.app)
      .get('/memory/lessons?include_superseded=1&limit=100').expect(200);
    const old = incl.body.results.find((r) => r.source_id === 'byid-old');
    expect(old.metadata.superseded_by).toBe('byid-new');
    expect(old.content_text).toContain('[superseded on');
  });
});

describe('GET /memory/stats — lessons_superseded stamp (count + latest date)', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await postRow(ctx.app, lessonRow({ source_id: 'stat-1', learned_at: '2026-09-01' }));
    await postRow(ctx.app, lessonRow({ source_id: 'stat-2', learned_at: '2026-09-02' }));
    await supersede(ctx.app, 'stat-1', {
      by_text: 'stat-1 corrected', reason: 'r', actor: 'a', evidence: 'e',
    });
    await supersede(ctx.app, 'stat-2', {
      by_text: 'stat-2 corrected', reason: 'r', actor: 'a', evidence: 'e',
    });
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('stamps lessons_superseded with the count and the latest valid_to', async () => {
    const res = await request(ctx.app).get('/memory/stats').expect(200);
    expect(res.body.lessons_superseded).toBeTruthy();
    expect(res.body.lessons_superseded.count).toBe(2);
    expect(res.body.lessons_superseded.latest).toBeTruthy();
  });

  it('stamps zero (not null) on a store with no retirements', async () => {
    const fresh = await makeApp();
    try {
      const res = await request(fresh.app).get('/memory/stats').expect(200);
      expect(res.body.lessons_superseded.count).toBe(0);
    } finally { try { fresh.db.close(); } catch (e) { /* already closed */ } }
  });
});

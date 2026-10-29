// POST /memory/lessons/:id/supersede is KIND-AWARE (F-mycelium/262, 2026-10-29).
//
// THE HOLE: the supersede handler hardcoded kind 'lesson' at every hop — the
// old-row lookup 404'd a 'ruling' row (the G-factory 09 STOP receipt's live
// probe), a by_text replacement would have been written as kind 'lesson', the
// owner check found no 'lesson' chunks for any other kind and let the request
// through, and the sm: derived ref resolved against the wrong source_type
// (unknown input, trust 0, fail-closed). A supersede edge now connects two
// rows of the SAME lesson-class kind: the old row's kind comes from its own
// row (db.lessonClassKindOf — ONE helper beside the map it walks) or an
// optional body.source_type validated against db.LESSON_SOURCE_TYPES.
//
// GATES (the brief): a ruling supersedes → 200 and the replacement is a
// ruling; a lesson still works byte-for-byte as before; an unknown kind or a
// non-lesson-class row (episode) is refused; a double supersede is refused.
// Every existing guard is unchanged — the refusals below reuse the route's
// own messages, which are identical whenever kind resolves to 'lesson'.
//
// Harness: same as lesson-supersede-route.test.js — vitest + supertest +
// express, the plugin's createRoutes() with a faked core and an in-memory
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

// A fully-provenanced ruling row (the §1 contract — 'ruling' joined
// LESSON_SOURCE_TYPES in 262, so the /index gate now demands the trio for it
// exactly as it does for a lesson).
function rulingRow(overrides = {}) {
  const { source_type, source_id, content_text, ...metadataOverrides } = overrides;
  return {
    source_type: source_type || 'ruling',
    source_id: source_id || 'ruling-' + Math.random().toString(36).slice(2, 8),
    content_text: content_text || 'GM ruling: SAND is green.',
    metadata: {
      kind: 'ruling',
      subject: 'sand-colour',
      actor: 'gm-probe',
      evidence: 'table session 2026-10-29',
      learned_at: '2026-10-29',
      ...metadataOverrides,
    },
  };
}

// A lesson row, as lessonRow() builds it in lesson-supersede-route.test.js.
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

const CORRECTION = 'GM ruling v2: SAND is green (corrected — it was always green).';
const BASE_BODY = {
  by_text: CORRECTION,
  reason: 'the table re-read the map; the colour was ruled on wrongly',
  actor: 'gm-probe',
  evidence: 'table session 2026-10-29, map v2',
};

const rowIn = (db, kind, id) => db.prepare(
  'SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ? AND chunk_index = 0'
).get(kind, id);

describe('POST /memory/lessons/:id/supersede — kind-aware (F-mycelium/262)', () => {
  describe('a RULING can be superseded, and the replacement stays a ruling', () => {
    let ctx;
    let replacementId;
    beforeAll(async () => {
      ctx = await makeApp();
      const put = await postRow(ctx.app, rulingRow({
        source_id: 'r-old',
        content_text: 'GM ruling: SAND is green.',
      }));
      expect(put.status).toBe(200);
      const res = await supersede(ctx.app, 'r-old', BASE_BODY);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      replacementId = res.body.replacement && res.body.replacement.source_id;
      expect(replacementId).toBeTruthy();
    });
    afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

    it('the replacement row EXISTS under source_type ruling (not lesson)', () => {
      const rep = rowIn(ctx.db, 'ruling', replacementId);
      expect(rep).toBeTruthy();
      expect(rep.content_text).toBe(CORRECTION);
      // and NO lesson row was manufactured for it — the old bug's shape
      expect(rowIn(ctx.db, 'lesson', replacementId)).toBeFalsy();
    });

    it('the OLD ruling row carries the death line + pointer, still under ruling', () => {
      const old = rowIn(ctx.db, 'ruling', 'r-old');
      expect(old).toBeTruthy();
      expect(old.content_text).toContain('GM ruling: SAND is green.');
      expect(old.content_text).toContain('[superseded on ');
      expect(old.content_text).toContain('by: ' + CORRECTION + ']');
      const meta = JSON.parse(old.metadata);
      expect(meta.superseded_by).toBe(replacementId);
      expect(meta.superseded_by_text).toBe(CORRECTION);
      expect(meta.valid_to).toBeTruthy();
    });

    it('the derived ref names the row\'s OWN kind (sm:ruling:<id>, not sm:lesson:<id>)', () => {
      const rep = rowIn(ctx.db, 'ruling', replacementId);
      expect(JSON.parse(rep.metadata).supersedes).toBe('r-old');
      const refs = rep.derived_from ? JSON.parse(rep.derived_from) : [];
      expect(refs).toContain('sm:ruling:r-old');
    });

    it('rulings never leak into the lessons block (default AND include_superseded)', async () => {
      for (const q of ['?limit=100', '?include_superseded=1&limit=100']) {
        const res = await request(ctx.app).get('/memory/lessons' + q).expect(200);
        const ids = res.body.results.map((r) => r.source_id);
        expect(ids).not.toContain('r-old');
        expect(ids).not.toContain(replacementId);
      }
    });

    it('a second supersede of the SAME ruling is refused (409, naming the pointer)', async () => {
      const res = await supersede(ctx.app, 'r-old', BASE_BODY);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already superseded');
      expect(res.body.superseded_by).toBe(replacementId);
    });
  });

  describe('the by_id edge stays same-kind', () => {
    let ctx;
    beforeAll(async () => {
      ctx = await makeApp();
      await postRow(ctx.app, rulingRow({ source_id: 'r1', content_text: 'ruling one' }));
      await postRow(ctx.app, rulingRow({ source_id: 'r2', content_text: 'ruling two' }));
      await postRow(ctx.app, lessonRow({ source_id: 'l1', learned_at: '2026-09-01' }));
      await postRow(ctx.app, rulingRow({ source_id: 'r3', content_text: 'ruling three' }));
    });
    afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

    it('supersedes a ruling by_id naming another ruling (200, edge lands)', async () => {
      const res = await supersede(ctx.app, 'r1', {
        by_id: 'r2', reason: 'r2 is the corrected ruling', actor: 'gm-probe', evidence: 'table v2',
      });
      expect(res.status).toBe(200);
      const old = JSON.parse(rowIn(ctx.db, 'ruling', 'r1').metadata);
      expect(old.superseded_by).toBe('r2');
    });

    it('refuses a by_id that names a row of ANOTHER lesson-class kind (400)', async () => {
      const res = await supersede(ctx.app, 'r3', {
        by_id: 'l1', reason: 'r', actor: 'gm-probe', evidence: 'e',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('names no ruling row');
    });
  });

  describe('an explicit body.source_type pins the kind when the id alone is ambiguous', () => {
    let ctx;
    beforeAll(async () => {
      ctx = await makeApp();
      // the SAME source_id under BOTH kinds — the collision case the pin exists for
      await postRow(ctx.app, lessonRow({ source_id: 'dual', content_text: 'lesson flavour of dual' }));
      await postRow(ctx.app, rulingRow({ source_id: 'dual', content_text: 'ruling flavour of dual' }));
    });
    afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

    it('source_type lesson flips the LESSON row, ruling flavour untouched', async () => {
      const res = await supersede(ctx.app, 'dual', { ...BASE_BODY, source_type: 'lesson' });
      expect(res.status).toBe(200);
      const lessonOld = rowIn(ctx.db, 'lesson', 'dual');
      expect(JSON.parse(lessonOld.metadata).superseded_by).toBeTruthy();
      expect(rowIn(ctx.db, 'ruling', 'dual')).toBeTruthy();
      expect(JSON.parse(rowIn(ctx.db, 'ruling', 'dual').metadata).superseded_by).toBeUndefined();
    });

    it('source_type ruling flips the RULING row, lesson flavour now history', async () => {
      const res = await supersede(ctx.app, 'dual', { ...BASE_BODY, source_type: 'ruling' });
      expect(res.status).toBe(200);
      const rulingOld = rowIn(ctx.db, 'ruling', 'dual');
      expect(JSON.parse(rulingOld.metadata).superseded_by).toBeTruthy();
      // the lesson row keeps its OWN earlier pointer (the two edges never crossed)
      expect(JSON.parse(rowIn(ctx.db, 'lesson', 'dual').metadata).superseded_by).toBeTruthy();
    });
  });

  describe('a LESSON still works byte-for-byte as before', () => {
    let ctx;
    let replacementId;
    beforeAll(async () => {
      ctx = await makeApp();
      await postRow(ctx.app, lessonRow({ source_id: 'l-old', learned_at: '2026-09-01' }));
    });
    afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

    it('the historic 404 for a ghost id keeps its exact wording', async () => {
      const res = await supersede(ctx.app, 'ghost-lesson', BASE_BODY);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(
        "supersede refused: no lesson row 'ghost-lesson' (lessons are memory rows — source_type 'lesson', source_id 'ghost-lesson' not found)"
      );
    });

    it('lesson supersede lands the replacement as a LESSON (the historic kind)', async () => {
      const res = await supersede(ctx.app, 'l-old', BASE_BODY);
      expect(res.status).toBe(200);
      replacementId = res.body.replacement.source_id;
      const rep = rowIn(ctx.db, 'lesson', replacementId);
      expect(rep).toBeTruthy();
      expect(rowIn(ctx.db, 'ruling', replacementId)).toBeFalsy();
      const old = JSON.parse(rowIn(ctx.db, 'lesson', 'l-old').metadata);
      expect(old.superseded_by).toBe(replacementId);
    });
  });

  describe('refusals the kind-awareness must keep', () => {
    let ctx;
    beforeAll(async () => {
      ctx = await makeApp();
      await postRow(ctx.app, rulingRow({ source_id: 'r-live' }));
      // a non-lesson-class row: an episode (its own provenance contract)
      await postRow(ctx.app, {
        source_type: 'episode',
        source_id: 'ep-1',
        content_text: 'session transcript 2026-10-29',
        metadata: { agent: 'tester-agent', session_date: '2026-10-29' },
      });
    });
    afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

    it('an UNKNOWN kind is refused (400, names the lesson-class kinds)', async () => {
      const res = await supersede(ctx.app, 'r-live', { ...BASE_BODY, source_type: 'gossip' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('gossip');
      expect(res.body.error).toContain('lesson-class kind');
      for (const k of ['lesson', 'verdict', 'ruling']) expect(res.body.error).toContain(k);
    });

    it('an EPISODE id is refused — no lesson-class row at that id (404)', async () => {
      const res = await supersede(ctx.app, 'ep-1', BASE_BODY);
      expect(res.status).toBe(404);
      // the episode row itself is untouched (an episode is not supersede-able here)
      expect(rowIn(ctx.db, 'episode', 'ep-1')).toBeTruthy();
      expect(JSON.parse(rowIn(ctx.db, 'episode', 'ep-1').metadata).superseded_by).toBeUndefined();
    });

    it('an explicit source_type episode is refused (not a lesson-class kind)', async () => {
      const res = await supersede(ctx.app, 'ep-1', { ...BASE_BODY, source_type: 'episode' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('episode');
    });

    it('the OWNER check now reaches rulings: a foreign-owned ruling is 403', async () => {
      // the row was written by tester-agent; hand it to another owner the way
      // a row written under a different key would look
      ctx.db.prepare("UPDATE sm_embeddings SET written_by = 'other-agent' WHERE source_type = 'ruling' AND source_id = 'r-live'").run();
      const res = await supersede(ctx.app, 'r-live', BASE_BODY);
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('other-agent');
      // nothing was written
      expect(JSON.parse(rowIn(ctx.db, 'ruling', 'r-live').metadata).superseded_by).toBeUndefined();
    });
  });

  describe('rulings at the write surface (the map membership that makes 262 possible)', () => {
    let ctx;
    beforeAll(async () => { ctx = await makeApp(); });
    afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

    it('an under-provenanced ruling write is refused like a lesson (400, names the field)', async () => {
      const row = rulingRow({ source_id: 'r-noproof' });
      delete row.metadata.actor;
      const res = await postRow(ctx.app, row);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('actor');
    });

    it('the db helper resolves a row\'s own kind — and null for a non-lesson-class id', async () => {
      await postRow(ctx.app, rulingRow({ source_id: 'r-find' }));
      await postRow(ctx.app, { source_type: 'episode', source_id: 'ep-2', content_text: 't', metadata: { agent: 'a', session_date: '2026-01-01' } });
      // the helper directly, constructed exactly as routes.js constructs it
      const createMemoryDB = (await import(join(PLUGIN_DIR, 'db.js'))).default;
      const raw = new Database(':memory:');
      raw.exec(readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8'));
      const db2 = createMemoryDB(raw);
      try {
        expect(db2.lessonClassKindOf('nope')).toBe(null);
        db2.index('ruling', 'r-find2', 'ruling text', { metadata: {} });
        expect(db2.lessonClassKindOf('r-find2')).toBe('ruling');
        // an id under two kinds resolves to the FIRST key in the map — the
        // historic kind — so an old id always means what it always meant
        db2.index('lesson', 'dual-kind', 'lesson flavour', { metadata: {} });
        db2.index('ruling', 'dual-kind', 'ruling flavour', { metadata: {} });
        expect(db2.lessonClassKindOf('dual-kind')).toBe('lesson');
      } finally { raw.close(); }
    });
  });
});

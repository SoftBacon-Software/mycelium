// Lessons are memory rows (2026-09-10, F-mycelium/186 — BRIEF-lab-alive-memory-program §1+§2).
//
// THE DIRECTIVE: "each agent does better today because they remember the lessons
// and history of yesterday." Until now the lab's lessons lived in jarvis/squad/lessons.md,
// auto-memory files, and DONE messages — none of which a seat reads at the moment it
// matters. This task makes a LESSON a first-class memory row: source_type 'lesson',
// indexed through the SAME /memory/index path as everything else (so it is embedded and
// searchable like everything else), with REQUIRED provenance metadata. The brief's first
// gate: a lesson row without provenance (actor, learned_at, evidence) is REFUSED at the
// route — 400 naming the field. The harness writes the row (K-kira's writer lands
// separately); the model never hand-waves one into existence.
//
// Routes added (semantic-memory plugin — same organ, no new one):
//   GET /memory/lessons?task_class=&repo=&since=&limit=&q=  — newest first, provenance
//     included; q= reuses searchHybrid restricted to source_types=['lesson'].
//   GET /memory/history?repo=&task_class=&limit=            — prior verdict rows
//     (source_type 'verdict' — same index path; the writer is K-kira's task, the shape
//     defined + accepted here). Same provenance gate as lessons: a verdict without
//     actor/learned_at/evidence is exactly the same failure the brief guards.
//
// models on test/unit/memory-bench-namespace-invisibility.test.js: vitest + supertest +
// express, the plugin's createRoutes() with a faked core and an in-memory
// better-sqlite3 DB seeded from schema.sql — hermetic, no network (the embed provider
// is unset, so autoEmbed is a no-op and searchHybrid runs its keyword arm).

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', '..', 'server', 'plugins', 'semantic-memory');
const TOOLS_DIR = join(HERE, '..', '..', 'tools');

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
    apiError: (res, code, msg) => res.status(code).json({ error: msg }),
    parseIntParam: (v, d) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? d : n;
    },
    asyncHandler: (fn) => function (req, res, next) {
      return Promise.resolve(fn(req, res, next)).catch(next);
    },
    // POST /index announces memory_indexed — the real core emits on the bus
    emitEvent: () => {},
  };

  const { default: createRoutes } = await import(join(PLUGIN_DIR, 'routes.js'));

  const app = express();
  app.use(express.json());
  app.use('/memory', createRoutes(core));

  return { db, app };
}

// A fully-provenanced lesson row — every field the §1 contract names.
// Top-level keys (source_type, source_id, content_text) override the row;
// everything else lands in metadata.
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

describe('the provenance gate: a lesson row without provenance is refused at the route', () => {
  let ctx;
  beforeAll(async () => { ctx = await makeApp(); });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('refuses a lesson missing actor and the 400 names the field', async () => {
    const row = lessonRow({ source_id: 'l-no-actor' });
    delete row.metadata.actor;
    const res = await postRow(ctx.app, row);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('actor');
  });

  it('refuses a lesson missing learned_at and the 400 names the field', async () => {
    const row = lessonRow({ source_id: 'l-no-learned_at' });
    delete row.metadata.learned_at;
    const res = await postRow(ctx.app, row);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('learned_at');
  });

  it('refuses a lesson missing evidence and the 400 names the field', async () => {
    const row = lessonRow({ source_id: 'l-no-evidence' });
    delete row.metadata.evidence;
    const res = await postRow(ctx.app, row);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('evidence');
  });

  it('refuses a lesson whose provenance fields are present but empty', async () => {
    const res = await postRow(ctx.app, lessonRow({ source_id: 'l-empty', actor: '  ', evidence: '' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('actor');
    expect(res.body.error).toContain('evidence');
  });

  it('refuses a lesson posted with no metadata at all', async () => {
    const row = lessonRow({ source_id: 'l-no-meta' });
    delete row.metadata;
    const res = await postRow(ctx.app, row);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('learned_at');
  });

  it('refuses an unprovenanced verdict row too (the history shape carries the same gate)', async () => {
    const res = await request(ctx.app).post('/memory/index').send({
      source_type: 'verdict',
      source_id: 'v-no-provenance',
      content_text: 'PASS',
      metadata: { repo: 'jarvis' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('evidence');
  });

  it('refuses an unprovenanced lesson in a bulk index (naming the field)', async () => {
    const bad = lessonRow({ source_id: 'l-bulk-bad' });
    delete bad.metadata.learned_at;
    const good = lessonRow({ source_id: 'l-bulk-good' });
    const res = await request(ctx.app).post('/memory/index/bulk').send({ items: [good, bad] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('learned_at');
  });

  it('still indexes ordinary (non-lesson) rows without provenance — the gate is scoped to lessons/verdicts', async () => {
    const res = await request(ctx.app).post('/memory/index').send({
      source_type: 'preference',
      source_id: 'pref-plain',
      content_text: 'moving truck parking rules for the house',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('indexes a fully-provenanced lesson through the same /memory/index path', async () => {
    const res = await postRow(ctx.app, lessonRow({ source_id: 'l-ok' }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source_type).toBe('lesson');
  });
});

describe('GET /memory/lessons — recall by class, repo, window; newest first', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    // Deliberately OUT of chronological insert order: the newest lesson is
    // indexed first, so created_at order and learned_at order disagree — the
    // route must order by the lesson's own date ("last Tuesday this exact
    // shape failed"), not by when the row landed.
    await postRow(ctx.app, lessonRow({
      source_id: 'byclass-3', task_class: 'read-loop', repo: 'mycelium',
      learned_at: '2026-09-08', content_text: 'a silent grep is not evidence of absence',
    }));
    await postRow(ctx.app, lessonRow({
      source_id: 'byclass-1', task_class: 'tool-call-shape', repo: 'jarvis',
      learned_at: '2026-09-09', content_text: 'qualified-row selection must resolve before running',
    }));
    await postRow(ctx.app, lessonRow({
      source_id: 'byclass-2', task_class: 'tool-call-shape', repo: 'jarvis',
      learned_at: '2026-09-10', content_text: 'a refired lane task may already be done',
    }));
    await postRow(ctx.app, lessonRow({
      source_id: 'byclass-old', task_class: 'tool-call-shape', repo: 'jarvis',
      learned_at: '2026-08-01', content_text: 'old lesson outside the since window',
    }));
    // A non-lesson row sharing the keyword space — must never surface in /lessons.
    await request(ctx.app).post('/memory/index').send({
      source_type: 'preference', source_id: 'pref-lesson-ish',
      content_text: 'a refired lane task may already be done (stored as a preference, not a lesson)',
    });
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  const ids = (res) => res.body.results.map((r) => r.source_id);

  it('returns lessons newest-first by learned_at (not by insertion order)', async () => {
    const res = await request(ctx.app).get('/memory/lessons').expect(200);
    expect(res.body.source_type).toBe('lesson');
    const got = ids(res);
    expect(got.indexOf('byclass-2')).toBeLessThan(got.indexOf('byclass-1'));
    expect(got.indexOf('byclass-1')).toBeLessThan(got.indexOf('byclass-3'));
  });

  it('each row carries its provenance metadata', async () => {
    const res = await request(ctx.app).get('/memory/lessons?limit=1').expect(200);
    const row = res.body.results[0];
    expect(row.metadata.actor).toBeTruthy();
    expect(row.metadata.learned_at).toBeTruthy();
    expect(row.metadata.evidence).toBeTruthy();
    expect(row.metadata.task_class).toBe('tool-call-shape');
    expect(row.content_text).toBeTruthy();
  });

  it('filters by task_class', async () => {
    const res = await request(ctx.app).get('/memory/lessons?task_class=read-loop').expect(200);
    expect(ids(res)).toEqual(['byclass-3']);
  });

  it('filters by repo', async () => {
    const res = await request(ctx.app).get('/memory/lessons?repo=mycelium').expect(200);
    expect(ids(res)).toEqual(['byclass-3']);
  });

  it('filters by repo AND task_class together', async () => {
    const res = await request(ctx.app).get('/memory/lessons?repo=jarvis&task_class=read-loop').expect(200);
    expect(ids(res)).toEqual([]);
  });

  it('honours since= as a lower bound on the lesson date', async () => {
    const res = await request(ctx.app).get('/memory/lessons?since=2026-09-08').expect(200);
    const got = ids(res);
    expect(got).toContain('byclass-3');
    expect(got).not.toContain('byclass-old');
  });

  it('refuses a malformed since= instead of silently ignoring the window', async () => {
    const res = await request(ctx.app).get('/memory/lessons?since=not-a-date').expect(400);
    expect(res.body.error).toContain('since');
  });

  it('honours limit=', async () => {
    const res = await request(ctx.app).get('/memory/lessons?limit=2').expect(200);
    expect(res.body.results.length).toBe(2);
    expect(res.body.count).toBe(2);
  });

  it('never returns non-lesson rows', async () => {
    const res = await request(ctx.app).get('/memory/lessons?limit=100').expect(200);
    for (const r of res.body.results) expect(r.source_type).toBe('lesson');
    expect(ids(res)).not.toContain('pref-lesson-ish');
  });
});

describe('GET /memory/lessons?q= — semantic recall restricted to lessons', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    await postRow(ctx.app, lessonRow({
      source_id: 'q-lesson',
      content_text: 'the deploy guard blocked the push to main',
      task_class: 'stubbing',
    }));
    // Same keyword space, different source_type — q= must not reach it.
    await request(ctx.app).post('/memory/index').send({
      source_type: 'note', source_id: 'q-note',
      content_text: 'the deploy guard blocked the push to main',
    });
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('returns only lesson rows for a query that also matches other types', async () => {
    const res = await request(ctx.app).get('/memory/lessons?q=deploy%20guard%20blocked').expect(200);
    expect(res.body.count).toBe(1);
    expect(res.body.results[0].source_id).toBe('q-lesson');
    expect(res.body.results[0].source_type).toBe('lesson');
  });

  it('keeps q= composable with the metadata filters', async () => {
    const res = await request(ctx.app)
      .get('/memory/lessons?q=deploy%20guard&task_class=stubbing').expect(200);
    expect(res.body.count).toBe(1);
    const miss = await request(ctx.app)
      .get('/memory/lessons?q=deploy%20guard&task_class=read-loop').expect(200);
    expect(miss.body.count).toBe(0);
  });

  it('reports its mode honestly when no embedding provider is configured', async () => {
    const res = await request(ctx.app).get('/memory/lessons?q=deploy%20guard').expect(200);
    // Hermetic fixture has no embedder, so hybrid falls back to its keyword arm —
    // the response must SAY so (no silent degradation), same contract as /search.
    expect(res.body.mode).toBe('keyword-fallback');
    expect(res.body.degraded).toBeTruthy();
  });
});

describe('GET /memory/history — prior verdict rows for a repo/class', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await makeApp();
    const postVerdict = (over = {}) => {
      const { source_id, ...metaOverrides } = over;
      return request(ctx.app).post('/memory/index').send({
        source_type: 'verdict',
        source_id,
        content_text: 'workflow verdict',
        metadata: {
          task_class: 'tool-call-shape', repo: 'jarvis', actor: 'echo',
          origin: { workflow_id: 'wf501' }, outcome: 'pass',
          evidence: 'receipts/wf501/verdict.md', learned_at: '2026-09-09',
          ...metaOverrides,
        },
      });
    };
    // insert newest-last so created_at and learned_at disagree, as in real life
    await postVerdict({ source_id: 'v-old', learned_at: '2026-09-05', outcome: 'fail' });
    await postVerdict({ source_id: 'v-mid', learned_at: '2026-09-07', outcome: 'pass' });
    await postVerdict({
      source_id: 'v-other-class', task_class: 'read-loop', learned_at: '2026-09-08',
    });
    await postVerdict({ source_id: 'v-new', learned_at: '2026-09-10', outcome: 'fail' });
    // a lesson in the same repo/class — history is verdicts ONLY
    await postRow(ctx.app, lessonRow({ source_id: 'h-lesson', learned_at: '2026-09-10' }));
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  const ids = (res) => res.body.results.map((r) => r.source_id);

  it('returns verdict rows newest-first with provenance', async () => {
    const res = await request(ctx.app).get('/memory/history?repo=jarvis&task_class=tool-call-shape').expect(200);
    expect(res.body.source_type).toBe('verdict');
    expect(ids(res)).toEqual(['v-new', 'v-mid', 'v-old']);
    expect(res.body.results[0].metadata.actor).toBe('echo');
    expect(res.body.results[0].metadata.evidence).toContain('wf501');
  });

  it('excludes lessons and other classes', async () => {
    const res = await request(ctx.app).get('/memory/history?repo=jarvis&task_class=tool-call-shape').expect(200);
    expect(ids(res)).not.toContain('h-lesson');
    expect(ids(res)).not.toContain('v-other-class');
  });

  it('filters by task_class alone', async () => {
    const res = await request(ctx.app).get('/memory/history?task_class=read-loop').expect(200);
    expect(ids(res)).toEqual(['v-other-class']);
  });

  it('honours limit=', async () => {
    const res = await request(ctx.app).get('/memory/history?repo=jarvis&task_class=tool-call-shape&limit=1').expect(200);
    expect(ids(res)).toEqual(['v-new']);
  });
});

// ---- The lessons.md migration (§1: lessons.md becomes a rendered VIEW, never the store) ----

describe('tools/migrate-lessons-md.mjs — the parser', () => {
  let parseLessonsMd;
  beforeAll(async () => {
    ({ parseLessonsMd } = await import(join(TOOLS_DIR, 'migrate-lessons-md.mjs')));
  });

  const FIXTURE = [
    '## 2026-09-01 — first fixture lesson',
    '',
    '**Symptom:** the gate skipped with exit 2.',
    '',
    '**Fix:** resolve qualified rows before running.',
    '',
    '**Date:** 2026-09-01.',
    '',
    '## 2026-09-02 — second fixture lesson, malformed',
    '',
    'Something failed here but the entry was truncated before anyone',
    'wrote the Symptom or the Fix.',
    '',
    '## 2026-09-03 — third fixture lesson',
    '',
    '**Symptom:** cursor file mtime was frozen while the ingest job ran every 15 min.',
    'The cursor was only written when receipts were POSTed.',
    '',
    '**Fix:** update `last_run` on every non-dry-run run.',
    '',
    '**Date:** 2026-09-03.',
    '',
  ].join('\n');

  it('parses 3 fixture entries: 2 well-formed, 1 refused', () => {
    const { rows, refused } = parseLessonsMd(FIXTURE, { sourcePath: '/lab/jarvis/squad/lessons.md' });
    expect(rows.length).toBe(2);
    expect(refused.length).toBe(1);
    expect(refused[0].title).toContain('malformed');
    expect(refused[0].reason).toBeTruthy();
  });

  it('builds a complete lesson row: symptom, fix, actor squad, evidence = file + heading', () => {
    const { rows } = parseLessonsMd(FIXTURE, { sourcePath: '/lab/jarvis/squad/lessons.md' });
    const first = rows[0];
    expect(first.source_type).toBe('lesson');
    expect(first.metadata.symptom).toContain('exit 2');
    expect(first.metadata.fix_or_rule).toContain('qualified rows');
    expect(first.metadata.actor).toBe('squad');
    expect(first.metadata.learned_at).toBe('2026-09-01');
    expect(first.metadata.evidence).toContain('/lab/jarvis/squad/lessons.md');
    expect(first.metadata.evidence).toContain('first fixture lesson');
    expect(first.metadata.repo).toBeTruthy();
    expect(first.metadata.origin).toBeTruthy();
    expect(first.metadata.outcome).toBeTruthy();
    expect(first.content_text).toContain('Symptom:');
    expect(first.content_text).toContain('qualified rows');
  });

  it('joins multi-line Symptom/Fix bodies without losing text', () => {
    const { rows } = parseLessonsMd(FIXTURE, { sourcePath: 'x.md' });
    const third = rows.find((r) => r.metadata.learned_at === '2026-09-03');
    expect(third.metadata.symptom).toContain('every 15 min');
    expect(third.metadata.symptom).toContain('only written when receipts');
    expect(third.metadata.fix_or_rule).toContain('last_run');
  });

  it('parses the legacy log-shape heading ("## <date> | meta") with its bold headline as the symptom', () => {
    const text = [
      '## 2026-07-06 | m5Max',
      '',
      '**Output-gate false-nudge on recalled prior-work paths — every workflow coding turn.**',
      'A stale memory naming the harvest script got pulled as a declared output.',
      '',
      'FIX (m5Max — gate-critical file): `_brief_output_paths` strips the recall',
      'preamble before scanning; only the real task is checked.',
      '',
    ].join('\n');
    const { rows, refused, byShape } = parseLessonsMd(text, { sourcePath: 'x.md' });
    expect(refused.length).toBe(0);
    expect(byShape.pipe).toBe(1);
    const row = rows[0];
    expect(row.metadata.learned_at).toBe('2026-07-06'); // from the heading
    expect(row.metadata.symptom).toContain('Output-gate false-nudge');
    expect(row.metadata.fix_or_rule).toContain('strips the recall');
    expect(row.content_text).toContain('declared output'); // full body is searchable
    expect(row.source_id).toContain('2026-07-06');
  });

  it('parses a bare (dateless) heading whose Date line is in the body', () => {
    const text = [
      '## Pipeline ada→lucy: the planner seat cannot write files',
      '',
      '**Symptom:** the ada-stage instruction said write_file but the seat is read-only.',
      '',
      '**Fix:** the orchestrator or the downstream coder lands the file.',
      '',
      '**Date:** 2026-08-31.',
      '',
    ].join('\n');
    const { rows, refused, byShape } = parseLessonsMd(text, { sourcePath: 'x.md' });
    expect(refused.length).toBe(0);
    expect(byShape.bare).toBe(1);
    expect(rows[0].metadata.learned_at).toBe('2026-08-31'); // from the **Date:** line
    expect(rows[0].metadata.symptom).toContain('read-only');
  });

  it('refuses a bare heading with no date anywhere (the route would refuse the row)', () => {
    const text = [
      '## An undated fragment',
      '',
      '**Symptom:** nobody dated this.',
      '',
    ].join('\n');
    const { rows, refused } = parseLessonsMd(text, { sourcePath: 'x.md' });
    expect(rows.length).toBe(0);
    expect(refused[0].reason).toContain('learned_at');
  });

  it('parses a symptom-only entry (the lesson is "this shape fails"; the fix column stays empty)', () => {
    const text = [
      '## 2026-09-04 — symptom-only lesson',
      '',
      '**Symptom:** the seat answered from a stale boot snapshot.',
      '',
    ].join('\n');
    const { rows, refused } = parseLessonsMd(text, { sourcePath: 'x.md' });
    expect(refused.length).toBe(0);
    expect(rows[0].metadata.symptom).toContain('stale boot snapshot');
    expect(rows[0].metadata.fix_or_rule).toBe('');
  });

  it('derives learned_at from the heading when the Date line is absent (but the entry is otherwise sound)', () => {
    const text = [
      '## 2026-08-15 — heading-dated lesson',
      '',
      '**Symptom:** fans spinning with nobody home.',
      '',
      '**Fix:** know what is running where.',
      '',
    ].join('\n');
    const { rows, refused } = parseLessonsMd(text, { sourcePath: 'x.md' });
    expect(refused.length).toBe(0);
    expect(rows[0].metadata.learned_at).toBe('2026-08-15');
  });

  it('is idempotent: the same date+title yields the same source_id across parses', () => {
    const a = parseLessonsMd(FIXTURE, { sourcePath: 'x.md' });
    const b = parseLessonsMd(FIXTURE, { sourcePath: 'x.md' });
    expect(a.rows.map((r) => r.source_id)).toEqual(b.rows.map((r) => r.source_id));
    // and the id names its origin
    expect(a.rows[0].source_id).toContain('2026-09-01');
  });
});

describe('tools/migrate-lessons-md.mjs — migration against the routes (composition)', () => {
  let migrateLessonsMd;
  let ctx;
  beforeAll(async () => {
    ({ migrateLessonsMd } = await import(join(TOOLS_DIR, 'migrate-lessons-md.mjs')));
    ctx = await makeApp();
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('posts each parsed row through POST /memory/index; refused entries never hit the route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-md-'));
    const file = join(dir, 'lessons.md');
    writeFileSync(file, [
      '# Squad lessons',
      '',
      '## 2026-09-01 — composed migration lesson one',
      '',
      '**Symptom:** lane logs grew unbounded.',
      '',
      '**Fix:** gzip idle lane logs past 7 days.',
      '',
      '**Date:** 2026-09-01.',
      '',
      '## 2026-09-02 — composed migration lesson two',
      '',
      '**Symptom:** two heads, one seat.',
      '',
      '**Fix:** the wake battery says when ds4 earns the chair back.',
      '',
      '**Date:** 2026-09-02.',
      '',
      '## 2026-09-03 — composed malformed lesson',
      '',
      'This entry was truncated: nobody ever wrote the Symptom or the Fix.',
      '',
    ].join('\n'));

    const posted = [];
    const report = await migrateLessonsMd(file, {
      // the CLI's post() is a fetch to POST /memory/index; the test binds the
      // SAME contract to supertest so the composition is what's under test
      post: async (row) => {
        const res = await postRow(ctx.app, row);
        if (res.status !== 200) throw new Error(res.body.error || 'post failed');
        posted.push(row.source_id);
        return res.body;
      },
    });

    expect(report.parsed).toBe(2);
    expect(report.refused.length).toBe(1);
    expect(report.indexed).toBe(2);
    expect(posted.length).toBe(2);

    // the rows actually landed and come back through the recall route
    const res = await request(ctx.app).get('/memory/lessons?limit=100').expect(200);
    expect(res.body.count).toBe(2);
    for (const row of res.body.results) {
      expect(row.metadata.actor).toBe('squad');
      expect(row.metadata.evidence).toContain('lessons.md');
    }

    // idempotent end-to-end: re-running the migration overwrites the SAME rows
    const second = await migrateLessonsMd(file, {
      post: async (row) => {
        const res = await postRow(ctx.app, row);
        if (res.status !== 200) throw new Error(res.body.error || 'post failed');
        posted.push(row.source_id);
        return res.body;
      },
    });
    expect(second.indexed).toBe(2);
    expect(new Set(posted).size).toBe(2); // no new source_ids on the re-run
  });
});

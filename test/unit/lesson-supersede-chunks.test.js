// Lesson SUPERSEDE × chunking — the Review-A fixes for the 234/235/237 batch
// (task 241, PR #182). F1 (blocking): a MULTI-CHUNK lesson's supersede must
// retire the WHOLE doc — the old row rewrites through indexDoc so stale chunks
// are removed in-transaction, and every surviving chunk carries the pointer
// metadata and the dated death line (searchHybrid fuses per-chunk; a stale
// unmarked chunk recalled the dead lesson at full rank under the default arm).
// F2 (minor): a DEAD lesson is refused as a by_id successor — supersede by the
// replacement, not the history. Harness: the same in-memory stand-in the
// supersede route tests use (no embedder → keyword arm, honestly stamped).
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

function lessonRow(overrides = {}) {
  const { source_type, source_id, content_text, ...metadataOverrides } = overrides;
  return {
    source_type: source_type || 'lesson',
    source_id: source_id || 'lesson-' + Math.random().toString(36).slice(2, 8),
    content_text: content_text || 'the gate skipped with exit 2',
    metadata: {
      symptom: 's', fix_or_rule: 'r', task_class: 'tool-call-shape', repo: 'jarvis',
      actor: 'kira', origin: { workflow_id: 'wf500' }, outcome: 'fixed',
      evidence: 'receipts/wf500/verdict.md', learned_at: '2026-09-09',
      ...metadataOverrides,
    },
  };
}

const postRow = (app, row) => request(app).post('/memory/index').send(row);
const supersede = (app, id, body) =>
  request(app).post('/memory/lessons/' + encodeURIComponent(id) + '/supersede').send(body);

describe('F1: supersede of a multi-chunk lesson retires EVERY chunk (chunk size 4000)', () => {
  let ctx;
  const CHUNK0_TOKEN = 'ALPHAUNIQUE-CHUNKONE-zz7';
  const CHUNK1_TOKEN = 'BETAUNIQUE-CHUNKTWO-qq9';
  const CORRECTION = 'the corrected single-sentence rule';

  beforeAll(async () => {
    ctx = await makeApp();
    // ~7800 chars: part one (~3900) + token + part two (~3900) + token.
    const part0 = 'A'.repeat(3700) + ' ' + CHUNK0_TOKEN + ' ' + 'A'.repeat(180);
    const part1 = 'B'.repeat(3700) + ' ' + CHUNK1_TOKEN + ' ' + 'B'.repeat(180);
    const res = await postRow(ctx.app, lessonRow({
      source_id: 'mc-old',
      content_text: part0 + ' ' + part1,
    }));
    expect(res.status).toBe(200);
    const chunks = ctx.db.prepare(
      "SELECT chunk_index, content_text FROM sm_embeddings WHERE source_type='lesson' AND source_id='mc-old' ORDER BY chunk_index"
    ).all();
    expect(chunks.length).toBe(2); // fixture sanity: the lesson really is multi-chunk
    expect(chunks[0].content_text).toContain(CHUNK0_TOKEN);
    expect(chunks[1].content_text).toContain(CHUNK1_TOKEN);

    const sup = await supersede(ctx.app, 'mc-old', {
      by_text: CORRECTION, reason: 'r', actor: 'a', evidence: 'e',
    });
    expect(sup.status).toBe(200);
  });
  afterAll(() => { try { ctx.db.close(); } catch (e) { /* already closed */ } });

  it('the old row survives with EXACTLY the chunks indexDoc produces for the marked content — no stale chunk beyond them', () => {
    const chunks = ctx.db.prepare(
      "SELECT chunk_index, content_text, metadata FROM sm_embeddings WHERE source_type='lesson' AND source_id='mc-old' ORDER BY chunk_index"
    ).all();
    expect(chunks.length).toBe(2); // indexDoc's output for ~7.8k marked chars — chunks 1..N are gone or rewritten, never orphaned
    expect(chunks[0].chunk_index).toBe(0);
    expect(chunks[1].chunk_index).toBe(1);
  });

  it('EVERY surviving chunk carries superseded_by AND the dated death line — a recall hit on any chunk renders the death', () => {
    const chunks = ctx.db.prepare(
      "SELECT chunk_index, content_text, metadata FROM sm_embeddings WHERE source_type='lesson' AND source_id='mc-old' ORDER BY chunk_index"
    ).all();
    for (const c of chunks) {
      const meta = JSON.parse(c.metadata);
      expect(meta.superseded_by).toBeTruthy();
      expect(meta.valid_to).toBeTruthy();
      expect(meta.superseded_by_text).toBe(CORRECTION);
      expect(c.content_text).toContain('[superseded on ');
      expect(c.content_text).toContain('by: ' + CORRECTION + ']');
    }
    // the chunk the finding named: it kept the ORIGINAL content with NO marker
    expect(chunks[1].content_text).toContain(CHUNK1_TOKEN);
  });

  it('THE HOLE, closed: default q= search does NOT recall the dead lesson via any chunk', async () => {
    for (const token of [CHUNK0_TOKEN, CHUNK1_TOKEN]) {
      const res = await request(ctx.app)
        .get('/memory/lessons?q=' + encodeURIComponent(token))
        .expect(200);
      expect(res.body.results.map((r) => r.source_id)).not.toContain('mc-old');
    }
  });

  it('include_superseded=1 reads the dead lesson back EXACTLY ONCE by q, with its death line rendered', async () => {
    const res = await request(ctx.app)
      .get('/memory/lessons?include_superseded=1&q=' + encodeURIComponent(CHUNK1_TOKEN))
      .expect(200);
    const hits = res.body.results.filter((r) => r.source_id === 'mc-old');
    expect(hits).toHaveLength(1);
    expect(hits[0].content_text).toContain('[superseded on ');
    expect(hits[0].metadata.superseded_by).toBeTruthy();
  });

  it('the correction itself IS recalled by its own text (the correcting row is reachable)', async () => {
    const res = await request(ctx.app)
      .get('/memory/lessons?q=' + encodeURIComponent('corrected single-sentence'))
      .expect(200);
    const hit = res.body.results.find((r) => r.metadata?.supersedes === 'mc-old');
    expect(hit).toBeTruthy();
  });

  it('the no-q default list stays clean and the include-flag renders the row once', async () => {
    const def = await request(ctx.app).get('/memory/lessons?limit=100').expect(200);
    expect(def.body.results.map((r) => r.source_id)).not.toContain('mc-old');
    const incl = await request(ctx.app)
      .get('/memory/lessons?include_superseded=1&limit=100').expect(200);
    expect(incl.body.results.filter((r) => r.source_id === 'mc-old').length).toBe(1);
  });

  it('stats counts the retirement ONCE — the pointer now lives on every chunk, the count is per doc', async () => {
    const res = await request(ctx.app).get('/memory/stats').expect(200);
    expect(res.body.lessons_superseded.count).toBe(1);
    expect(res.body.lessons_superseded.latest).toBeTruthy();
  });
});

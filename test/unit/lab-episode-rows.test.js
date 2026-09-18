// Lab EPISODE rows (2026-09-18, F-mycelium/218 — BRIEF-lab-alive-memory-program §3).
//
// THE DIRECTIVE: "each agent does better today because they remember the lessons
// and history of yesterday." Lessons (186) are the reconciled FACT half; an EPISODE
// is the verbatim EVENT half they point at: one squad session transcript, stored
// whole (source_type 'episode'), indexed through the SAME /memory/index path as
// every other row, with REQUIRED provenance — agent, session_date, session_id
// (the transcript file's content hash), origin (the workflow_id when the transcript
// carries one, else the file path). The gate is 186's, scoped differently: a
// lesson row needs actor/learned_at/evidence; an episode row needs agent +
// session_date — a transcript whose WHO or WHEN is unknown is refused at the
// route, 400 naming the field, because a fact that cannot cite its session is
// exactly the failure §3 exists to fix.
//
// Read side (this file pins both):
//   POST /memory/search with source_types:['episode'] — meaning recall reaches
//     episodes, each hit rendering its session_date (the dated line the wake/boot
//     blocks will gain when the live reconcile lands).
//   GET /memory/episodes?agent=&session_date= — the dated enumeration the reconcile
//     dry-run reads ("the indexed episodes of one agent/day"), newest first.
//
// Harness mirrors test/unit/lessons-memory-rows.test.js: vitest + supertest +
// express, the plugin's createRoutes() with a faked core and an in-memory
// better-sqlite3 DB seeded from schema.sql — hermetic, no network (the embed
// provider is unset, so autoEmbed is a no-op and searchHybrid runs its keyword arm).

import { describe, it, expect } from 'vitest';
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
    apiError: (res, code, msg) => res.status(code).json({ error: msg }),
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

// A fully-provenanced episode row — every field the §3 contract requires.
function episodeRow(overrides = {}) {
  const { source_type, source_id, content_text, namespace, ...metadataOverrides } = overrides;
  return {
    source_type: source_type || 'episode',
    source_id: source_id || 'episode:3f7a1c9b2d',
    content_text: content_text ||
      'the workflow runner wedged on the seat hold during the night wave; the heavy brief serialized every lane for four hours',
    namespace: namespace === undefined ? 'lab' : namespace,
    metadata: {
      agent: 'kira',
      session_date: '2026-09-15',
      session_id: 'b7e4d2c0a1938f56',
      origin: '/data/squad-transcripts/kira/2026-09-15/wake-603-20260915_135745.jsonl',
      ...metadataOverrides,
    },
  };
}

describe('episode provenance gate (218) — refuse at the route, naming the field', () => {
  it('refuses an episode row missing agent', async () => {
    const { app } = await makeApp();
    const row = episodeRow({ agent: undefined });
    const res = await request(app).post('/memory/index').send(row);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agent');
    expect(res.body.error).toContain('episode');
  });

  it('refuses an episode row missing session_date', async () => {
    const { app } = await makeApp();
    const row = episodeRow({ session_date: undefined });
    const res = await request(app).post('/memory/index').send(row);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('session_date');
  });

  it('refuses an episode row with no metadata at all, naming BOTH required fields', async () => {
    const { app } = await makeApp();
    const row = episodeRow();
    delete row.metadata;
    const res = await request(app).post('/memory/index').send(row);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agent');
    expect(res.body.error).toContain('session_date');
  });

  it('refuses an episode whose agent is an empty string (present-but-blank is missing)', async () => {
    const { app } = await makeApp();
    const res = await request(app)
      .post('/memory/index')
      .send(episodeRow({ agent: '   ' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('agent');
  });

  it('the bulk path carries the same gate, naming the offending item', async () => {
    const { app } = await makeApp();
    const good = episodeRow({ source_id: 'episode:good1' });
    const bad = episodeRow({ source_id: 'episode:bad1', session_date: undefined });
    const res = await request(app)
      .post('/memory/index/bulk')
      .send({ items: [good, bad] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('items[1]');
    expect(res.body.error).toContain('session_date');
  });

  it('an episode missing nothing indexes clean', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/memory/index').send(episodeRow());
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.chunks).toBe(1);
  });

  it('the 186 lesson gate is untouched — a lesson without provenance still 400s', async () => {
    const { app } = await makeApp();
    const res = await request(app).post('/memory/index').send({
      source_type: 'lesson',
      source_id: 'lesson-x',
      content_text: 'gate on the runner exit code, never a piped tail',
      metadata: { symptom: 'red suite', fix_or_rule: 'gate on rc' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('actor');
  });
});

describe('episode read side (218) — recall by meaning, enumeration by day', () => {
  it('an episode answers a meaning query with its session_date rendered', async () => {
    const { app } = await makeApp();
    const idx = await request(app).post('/memory/index').send(episodeRow());
    expect(idx.status).toBe(200);

    const res = await request(app)
      .post('/memory/search')
      .send({ query: 'workflow runner wedged seat hold', source_types: ['episode'] });
    expect(res.status).toBe(200);
    const hit = res.body.results.find((r) => r.source_id === 'episode:3f7a1c9b2d');
    expect(hit).toBeTruthy();
    expect(hit.metadata.session_date).toBe('2026-09-15');
    expect(hit.metadata.agent).toBe('kira');
  });

  it('GET /memory/episodes?agent=&session_date= enumerates one agent-day, newest first', async () => {
    const { app } = await makeApp();
    await request(app).post('/memory/index').send(episodeRow({ source_id: 'episode:a1' }));
    await request(app).post('/memory/index').send(
      episodeRow({ source_id: 'episode:a2', session_date: '2026-09-16', agent: 'lucy' })
    );
    await request(app).post('/memory/index').send(
      episodeRow({ source_id: 'episode:a3', content_text: 'another kira day row about the seat hold gate' })
    );

    const res = await request(app)
      .get('/memory/episodes')
      .query({ agent: 'kira', session_date: '2026-09-15' });
    expect(res.status).toBe(200);
    expect(res.body.source_type).toBe('episode');
    expect(res.body.count).toBe(2);
    for (const r of res.body.results) {
      expect(r.metadata.agent).toBe('kira');
      expect(r.metadata.session_date).toBe('2026-09-15');
      expect(r.metadata.session_id).toBeTruthy();
    }
  });

  it('GET /memory/episodes without filters returns episodes from every agent', async () => {
    const { app } = await makeApp();
    await request(app).post('/memory/index').send(episodeRow({ source_id: 'episode:b1' }));
    await request(app).post('/memory/index').send(
      episodeRow({ source_id: 'episode:b2', agent: 'echo', session_date: '2026-06-07' })
    );
    const res = await request(app).get('/memory/episodes');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it('a multi-chunk episode comes back WHOLE — the live-receipt defect (2026-09-18): chunk 0 alone was a 4000-char fragment no consumer could parse', async () => {
    const { app } = await makeApp();
    // Ten transcript lines ~800 chars each -> ~8KB -> several chunks under the
    // 4000-char DEFAULT_CHUNK_SIZE, with the LAST line landing past the final
    // chunk boundary (the tail a chunk-0 read silently drops).
    const line = (i) => JSON.stringify({
      timestamp: `2026-09-17T0${i}:00:00`,
      session_id: `sess_${i}`,
      role: i % 2 ? 'user' : 'assistant',
      content: `turn ${i}: ` + 'x'.repeat(780),
    });
    const content = Array.from({ length: 10 }, (_, i) => line(i)).join('\n') + '\n';
    expect(content.length).toBeGreaterThan(4000);

    const idx = await request(app).post('/memory/index').send(episodeRow({
      source_id: 'episode:multichunk',
      content_text: content,
      session_date: '2026-09-17',
    }));
    expect(idx.status).toBe(200);
    expect(idx.body.chunks).toBeGreaterThan(1); // it really is chunked

    const res = await request(app).get('/memory/episodes').query({ agent: 'kira' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const row = res.body.results[0];
    expect(row.content_text).toBe(content); // verbatim — chunks.join('') round-trips
    // Every transcript line parses: the shape the reconcile dry-run consumes.
    const turns = row.content_text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(turns).toHaveLength(10);
    expect(turns[9].content.startsWith('turn 9: ')).toBe(true);
  });
});

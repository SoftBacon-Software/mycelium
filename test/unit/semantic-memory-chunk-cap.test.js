// Task 240, CodeQL alert #279 (js/loop-bound-injection, semantic-memory
// POST /memory/index) — the chunked path loops once per chunk of caller
// content, so the bound is now an explicit named constant enforced BEFORE the
// write. This file pins the envelope:
//
//   - content that would produce MAX_CHUNKS_PER_DOC + 1 chunks -> 413 naming
//     content_text, and NOTHING is written (the refusal precedes indexDoc);
//   - content producing exactly MAX_CHUNKS_PER_DOC chunks -> 200 with
//     chunks: MAX (the bound is a cap, not a smaller de-facto limit);
//   - ordinary content is untouched by the check.
//
// The request bodies here are ~33.5 MB BY CONTRACT: bodies are capped at 16 MB
// upstream in production (express.json on /memory), but the route-level bound
// must hold on its own — and at the DEFAULT chunk size 4000 the 16 MB cap
// itself can still yield the full 8389 chunks, so the cap must sit exactly
// above what a legal max-size body produces. Test timeout raised accordingly.
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

import createMemoryRoutes from '../../server/plugins/semantic-memory/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const smSchema = fs.readFileSync(path.join(here, '../../server/plugins/semantic-memory/schema.sql'), 'utf8');

// Mirrors semantic-memory-unchanged-index.test.js's makeCore — the pieces the
// semantic-memory router destructures off pluginCore.
function makeCore(db) {
  return {
    db,
    auth: {
      checkAgentOrAdmin() { return 'tester'; },
      checkAdmin() { return 'tester'; },
      getAdminDisplayName() { return 'tester'; },
    },
    apiError(res, status, message, extra) { return res.status(status).json(Object.assign({ error: message }, extra || {})); },
    parseIntParam(val) { const n = parseInt(val, 10); return isNaN(n) ? null : n; },
    asyncHandler(fn) {
      return function (req, res, next) { Promise.resolve(fn(req, res, next)).catch(next); };
    },
    emitEvent() {},
    onEvent() {},
    gatedActions: [],
    inbox: {},
  };
}

async function boot() {
  const db = new Database(':memory:');
  db.exec(smSchema);
  const app = express();
  // 64mb: upstream production caps /memory at 16mb; the test app widens the
  // parser so the ROUTE-level bound is what the over-bound leg exercises.
  app.use(express.json({ limit: '64mb' }));
  app.use('/api/mycelium/memory', createMemoryRoutes(makeCore(db)));
  return { db, app };
}

let app;
let db;
afterEach(async function () {
  if (db) { db.close(); db = undefined; }
  app = undefined;
});

// chunkText hard-splits newline-free text at exactly 4000 chars, so n chunks
// need 4000*(n-1)+1 chars.
const MAX = 8389;
const lenForChunks = (n) => 4000 * (n - 1) + 1;

describe('semantic-memory chunk-count bound (task 240 #279)', () => {
  it('refuses MAX+1 chunks with 413 naming content_text, writing nothing', async function () {
    const ctx = await boot();
    app = ctx.app; db = ctx.db;
    var res = await request(app)
      .post('/api/mycelium/memory/index')
      .send({ source_type: 'probe', source_id: 'cap-over', content_text: 'x'.repeat(lenForChunks(MAX + 1)) })
      .expect(413);
    expect(res.body.error).toContain('content_text');
    expect(res.body.error).toContain('MAX_CHUNKS_PER_DOC');
    // the refusal preceded the write — no rows for the doc
    expect(db.prepare("SELECT COUNT(*) c FROM sm_embeddings WHERE source_id = 'cap-over'").get().c).toBe(0);
  }, 120000);

  it('accepts exactly MAX chunks (200, chunks: MAX)', async function () {
    const ctx = await boot();
    app = ctx.app; db = ctx.db;
    var res = await request(app)
      .post('/api/mycelium/memory/index')
      .send({ source_type: 'probe', source_id: 'cap-at', content_text: 'x'.repeat(lenForChunks(MAX)) })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.chunks).toBe(MAX);
    expect(db.prepare("SELECT COUNT(*) c FROM sm_embeddings WHERE source_id = 'cap-at'").get().c).toBe(MAX);
  }, 120000);

  it('leaves ordinary content untouched', async function () {
    const ctx = await boot();
    app = ctx.app; db = ctx.db;
    var res = await request(app)
      .post('/api/mycelium/memory/index')
      .send({ source_type: 'probe', source_id: 'cap-normal', content_text: 'a plain small doc' })
      .expect(200);
    expect(res.body.chunks).toBe(1);
  });
});

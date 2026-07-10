// Regression test — 07-02 audit finding R1 (HIGH, whole-platform crash).
//
// POST /memory/reindex and POST /memory/backfill-embeddings were raw
// `async function` handlers mounted on a plugin router with NO asyncHandler.
// With embedding_provider='openai', a provider hiccup (missing key / HTTP>=400
// / bad format / fetch reject) threw an unhandled promise rejection that
// crashed the whole platform from a routine admin reindex.
//
// This test asserts the FIX: a /reindex with a FAILING embed provider returns
// an error RESPONSE (embedded:0, errors>0) — NOT a process crash. It also
// verifies defense-in-depth: a handler-level throw is forwarded to Express's
// error pipeline (500) instead of becoming an unhandled rejection.
//
// Models on test/unit/directive-and-upload-auth.test.js (vitest + supertest +
// express). Uses the plugin's own createRoutes() with a faked core + an
// in-memory better-sqlite3 DB seeded from schema.sql — same isolation pattern
// as server/plugins/semantic-memory/test.js.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname_test = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname_test, '..', '..', 'server', 'plugins', 'semantic-memory');

let app;
let db;
let cleanup;

beforeAll(async () => {
  // In-memory DB seeded with the plugin schema.
  db = new Database(':memory:');
  const schema = readFileSync(join(PLUGIN_DIR, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Faked core: auth always passes (we're testing the embed path, not auth),
  // apiError/parseIntParam mirror the real helpers.
  const core = {
    db,
    auth: {
      checkAdmin: () => ({ id: 1, name: 'admin' }),
      checkAgentOrAdmin: () => ({ id: 1, name: 'admin' }),
    },
    apiError: (res, code, msg) => res.status(code).json({ error: msg }),
    parseIntParam: (v, d) => {
      const n = parseInt(v, 10);
      return isNaN(n) ? d : n;
    },
  };

  const { default: createRoutes } = await import(join(PLUGIN_DIR, 'routes.js'));
  const router = createRoutes(core);

  app = express();
  app.use(express.json());
  app.use('/memory', router);
  // Express error handler — asyncHandler forwards rejections here as 500s.
  app.use((err, req, res, next) => {
    res.status(500).json({ error: 'forwarded: ' + (err && err.message ? err.message : String(err)) });
  });

  cleanup = () => { try { db.close(); } catch (e) { /* already closed */ } };
});

afterAll(() => { if (cleanup) cleanup(); });

describe('R1 regression — failing embed provider must not crash the platform', () => {
  it('POST /memory/reindex with openai provider + no key returns an error response, not a crash', async () => {
    // Seed one unembedded row + an openai config with NO api key.
    // embedOpenAIBatch throws 'OpenAI API key required' — the exact path that
    // used to crash the process. After the fix generateEmbeddingBatch catches
    // it and degrades to per-item nulls.
    db.prepare('DELETE FROM sm_embeddings').run();
    db.prepare('DELETE FROM sm_config').run();
    const { default: createMemoryDB } = await import(join(PLUGIN_DIR, 'db.js'));
    const mem = createMemoryDB(db);
    mem.index('note', 'r1-test', 'some content that needs an embedding');
    mem.setConfig('embedding_provider', 'openai');
    // embedding_api_key intentionally unset -> embedOpenAIBatch throws.

    const res = await request(app)
      .post('/memory/reindex')
      .set('Authorization', 'Bearer admin')
      .send({});

    // The critical assertion: we GOT a response (process did not crash).
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Nothing was embedded (provider failed), and the failure was COUNTED,
    // not propagated as an unhandled rejection.
    expect(res.body.embedded).toBe(0);
    expect(res.body.errors).toBeGreaterThanOrEqual(1);
  });

  it('POST /memory/reindex with openai provider + unreachable URL degrades, not crash', async () => {
    // Simulate a live API hiccup: valid-looking key but the endpoint refuses
    // the connection (fetch rejects). After the fix this degrades to nulls.
    db.prepare('DELETE FROM sm_embeddings').run();
    db.prepare('DELETE FROM sm_config').run();
    const { default: createMemoryDB } = await import(join(PLUGIN_DIR, 'db.js'));
    const mem = createMemoryDB(db);
    mem.index('note', 'r1-net', 'content for the network-failure case');
    mem.setConfig('embedding_provider', 'openai');
    mem.setConfig('embedding_api_key', 'sk-test-dummy');
    mem.setConfig('embedding_url', 'http://127.0.0.1:1'); // port 1: connection refused

    const res = await request(app)
      .post('/memory/reindex')
      .set('Authorization', 'Bearer admin')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.embedded).toBe(0);
    expect(res.body.errors).toBeGreaterThanOrEqual(1);
  });

  it('a handler-level throw is forwarded to Express (500), not an unhandled rejection', async () => {
    // Defense-in-depth for the asyncHandler wrapper: if something INSIDE the
    // handler throws (not the embed path), the rejection must route through
    // Express's error pipeline (500) instead of crashing the process.
    db.prepare('DELETE FROM sm_embeddings').run();
    db.prepare('DELETE FROM sm_config').run();
    const { default: createMemoryDB } = await import(join(PLUGIN_DIR, 'db.js'));
    const mem = createMemoryDB(db);
    mem.index('note', 'r1-throw', 'content');
    mem.setConfig('embedding_provider', 'openai');

    // Sabotage getUnembedded so the handler throws synchronously-ish after
    // the await. We swap the DB statement's .all to throw.
    const orig = db.prepare;
    db.prepare = () => { throw new Error('simulated DB failure'); };

    try {
      const res = await request(app)
        .post('/memory/reindex')
        .set('Authorization', 'Bearer admin')
        .send({});

      // Forwarded by asyncHandler -> Express error handler -> 500 JSON.
      // NOT a crash, NOT a hung request (supertest would time out).
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/forwarded/);
    } finally {
      db.prepare = orig; // restore so afterAll cleanup works
    }
  });
});

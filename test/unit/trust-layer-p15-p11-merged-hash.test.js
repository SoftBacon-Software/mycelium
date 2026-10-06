// TRUST LAYER P1.5 × P1.1 — the merged audit hash covers the provenance stamps
// (2026-10-06, F-mycelium/264d — PR #200 merged master after #201/#203).
//
// PR #200 (P1.5, the append-only hash-chained memory audit log) and PR #201
// (P1.1, origin/trust/derived_from on the same rows) touched the same write
// paths. The merge law (264d): the audited row must hash the fields P1.1
// added — a re-stamp is a mutation the chain must pin, and two rows differing
// only in their stamps are different rows. This file pins that:
//
//   * factState (auto-memory/db.js) — the canonical am_facts hash — carries
//     origin/trust/derived_from in their stored shapes, and unknown (null)
//     hashes differently from foreign (0): unknown READS as the lowest trust,
//     it is not EQUAL to it.
//   * POST /auto-memory/facts' audit row_hash === contentHash(factState(stored
//     row)) on a stamped row — the write path hashes the stamps because
//     factState does.
//   * the sm row hash (semantic-memory/routes.js smRowState) carries the
//     stamps: two docs identical except their stamps hash differently, and a
//     rewrite that re-stamps pins the NEW stamps — the hash reads the live
//     row, never a prior state.
//
// Each item runs against the REAL router with the REAL plugin routes mounted
// via initPlugins — the same harness as trust-layer-p15-audit-log.test.js.

process.env.MYCELIUM_RATE_LIMIT = 'off'; // limiters are proven in trust-layer-rate-limits.test.js

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';

import { factState } from '../../server/plugins/auto-memory/db.js';
import { contentHash } from '../../server/lib/memory-audit.js';

const ADMIN_KEY = 'trust-layer-264d-admin-key-0123456789abcdef';
const JWT_SECRET = 'trust-layer-264d-jwt-secret';
const AGENT_KEY = 'dvk_' + 'c'.repeat(48); // lucy-tl264m — the writer

let tmpDataDir;
let db;
let app;

const agentAuth = { 'X-Agent-Key': AGENT_KEY };

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-trust-layer-264d-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = JWT_SECRET;

  db = await import('../../server/db.js');
  db.initDB();

  const routes = (await import('../../server/routes/mycelium.js')).default;
  app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/mycelium', routes);
  const { initPlugins } = await import('../../server/routes/mycelium.js');
  await initPlugins(app);

  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex');
  db.createAgent('lucy-tl264m', 'Lucy TL264m', 'trust-proj', hash, '["code"]');
});

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

// The sm row state in the EXACT key set the routes' smRowState hashes (the
// P1.5 five + the P1.1 stamps), computed off the live rows — the test's
// independent restatement of the shape the routes hash.
function smRowStateFromDb(sourceType, sourceId) {
  const chunks = db.getDB().prepare(
    'SELECT * FROM sm_embeddings WHERE source_type = ? AND source_id = ? ORDER BY chunk_index'
  ).all(sourceType, String(sourceId));
  if (chunks.length === 0) return null;
  let meta;
  try { meta = JSON.parse(chunks[0].metadata || '{}'); } catch (e) { meta = {}; }
  return {
    content: chunks.map((c) => c.content_text).join(''),
    namespace: chunks[0].namespace || null,
    metadata: meta,
    written_by: chunks[0].written_by || null,
    superseded_by: chunks[0].superseded_by || null,
    origin: chunks[0].origin || null,
    trust: (chunks[0].trust == null) ? null : Number(chunks[0].trust),
    derived_from: chunks[0].derived_from || null
  };
}

function lastAuditHash(sourceType, sourceId) {
  const row = db.getDB().prepare(
    'SELECT row_hash FROM memory_audit WHERE source_type = ? AND source_id = ? ORDER BY seq DESC'
  ).get(sourceType, String(sourceId));
  return row ? row.row_hash : null;
}

// ---- 1. factState covers the stamps -----------------------------------------

describe('the merged am hash (factState) covers origin/trust/derived_from', () => {
  const base = {
    id: 1, fact_text: 'same text', agent_id: 'lucy-tl264m', category: 'general',
    project_id: null, confidence: 0.9, source_type: 'aria', source_authority: 'inferred',
    valid_from: '2026-10-06 00:00:00', valid_to: null, verified_at: null,
    superseded_by: null, namespace: null, origin: null, trust: null, derived_from: null
  };

  test('a stamp-only difference changes the hash', () => {
    const h0 = contentHash(factState(base));
    expect(contentHash(factState({ ...base, origin: 'owner-agent', trust: 3 }))).not.toBe(h0);
    expect(contentHash(factState({ ...base, derived_from: '["am:1"]' }))).not.toBe(h0);
  });

  test('unknown (null) and foreign (0) are different states — unknown reads as the lowest, it is not EQUAL to it', () => {
    const h0 = contentHash(factState(base));
    expect(contentHash(factState({ ...base, trust: 0 }))).not.toBe(h0);
    expect(contentHash(factState({ ...base, trust: 0 }))).not.toBe(contentHash(factState({ ...base, trust: 3 })));
  });

  test('same fields, same hash (the chain input is deterministic)', () => {
    expect(contentHash(factState(base))).toBe(contentHash(factState({ ...base })));
  });
});

// ---- 2. the am write path's audit row hashes the stamps ---------------------

describe('POST /auto-memory/facts audit row_hash === contentHash(factState(stored row))', () => {
  test('a stamped write pins origin/trust in its audit row', async () => {
    const res = await request(app).post('/api/mycelium/auto-memory/facts').set(agentAuth).send({
      fact_text: 'the merged audit hash covers origin trust and derived_from on the am side',
      origin: 'tool'
    });
    expect(res.status).toBe(200);
    const id = res.body.id;
    const row = db.getDB().prepare('SELECT * FROM am_facts WHERE id = ?').get(id);
    expect(row.origin).toBe('tool'); // the stamp landed …
    expect(row.trust).toBe(2);       // … at the ladder's tool trust
    expect(lastAuditHash('am_fact', id)).toBe(contentHash(factState(row)));
  });
});

// ---- 3. the sm row hash covers the stamps -----------------------------------

describe('the merged sm hash (smRowState) covers origin/trust/derived_from', () => {
  const provenance = { learned_at: '2026-10-06T00:00:00Z', evidence: '264d merged-hash probe' };
  const post = (sourceId, extra) => request(app).post('/api/mycelium/memory/index').set(agentAuth).send({
    source_type: 'preference',
    source_id: sourceId,
    content_text: 'identical content for the stamp-hash probe',
    metadata: { ...provenance },
    ...extra
  });

  test('two docs identical except their stamps hash differently', async () => {
    // No body origin = the surface ceiling (owner-agent/3) — the binder always
    // stamps; a body origin at or below it is an honest self-lowering.
    expect((await post('tl264m-stamp-a', {})).status).toBe(200);
    expect((await post('tl264m-stamp-b', { origin: 'tool' })).status).toBe(200);
    const ceiling = smRowStateFromDb('preference', 'tl264m-stamp-a');
    const lowered = smRowStateFromDb('preference', 'tl264m-stamp-b');
    expect(ceiling.origin).toBe('owner-agent');
    expect(ceiling.trust).toBe(3);
    expect(lowered.origin).toBe('tool');
    expect(lowered.trust).toBe(2);
    expect(lastAuditHash('preference', 'tl264m-stamp-a')).toBe(contentHash({ kind: 'sm_row', ...ceiling }));
    expect(lastAuditHash('preference', 'tl264m-stamp-b')).toBe(contentHash({ kind: 'sm_row', ...lowered }));
    expect(lastAuditHash('preference', 'tl264m-stamp-a')).not.toBe(lastAuditHash('preference', 'tl264m-stamp-b'));
  });

  test('a rewrite that re-stamps (tool/2) pins the NEW stamps in its audit row_hash', async () => {
    expect((await post('tl264m-restamp', {})).status).toBe(200);
    expect((await post('tl264m-restamp', { content_text: 'version two restamped tool', origin: 'tool' })).status).toBe(200);
    const live = smRowStateFromDb('preference', 'tl264m-restamp');
    expect(live.origin).toBe('tool'); // the rewrite carried its own stamp …
    expect(live.trust).toBe(2);       // … and the audit row hashed THIS state,
    expect(lastAuditHash('preference', 'tl264m-restamp')).toBe(contentHash({ kind: 'sm_row', ...live }));
  });
});

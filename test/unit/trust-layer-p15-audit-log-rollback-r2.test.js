// TRUST LAYER P1.5 — review A round 2 (N1..N5): every memory write / edit /
// delete and its audit row commit in ONE transaction.
//
// Round 1's M2a/b/c proved the shape for /index/bulk, the federation visit
// write and the import: no audit table → the append throws (fail-loud) → the
// memory write must roll back WITH the row it owes. Round 2 names five more
// seams that still committed the write before its audit row — the same shape:
//
//   N1  the admin sm purge (DELETE /memory/index?source_type=…)
//   N2  POST /memory/index's default (chunked) branch
//   N3  the auto-memory namespace purge (DELETE /auto-memory/facts?namespace=…)
//   N4  the three housekeeping prunes (pruneOldSuperseded / pruneLowConfidence /
//       pruneExcessFacts — audited inside db.js, so the probes call the methods
//       the way their callers do)
//   N5  the consolidation/extract fact edits (extraction write, confidence
//       update, merge supersede, insight write — driven through /extract and
//       /consolidate against a mock LLM)
//
// One rollback probe per seam: break memory_audit (the M2 injection, hardened
// below), call the path, assert the call fails loud AND the memory write is
// absent. Each probe restores the table in finally so later setup writes still
// audit.

process.env.MYCELIUM_RATE_LIMIT = 'off'; // limiters are proven in trust-layer-rate-limits.test.js

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { MEMORY_AUDIT_DDL } from '../../server/lib/memory-audit.js';

const ADMIN_KEY = 'trust-layer-p15r2-admin-key-0123456789abcdef';
const JWT_SECRET = 'trust-layer-p15r2-jwt-secret';
const AGENT_A_KEY = 'dvk_' + 'c'.repeat(48); // lucy-tl264r2 — the writer

let tmpDataDir;
let db;
let raw;   // the raw better-sqlite3 handle
let am;    // the auto-memory wrapper (what extract/consolidate callers hold)
let app;

const agentA = { 'X-Agent-Key': AGENT_A_KEY };
const adminKeyAuth = { 'X-Admin-Key': ADMIN_KEY };

const countSm = (type, id) => raw.prepare(
  'SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = ? AND source_id = ?'
).get(type, String(id)).c;
const countSmType = (type) => raw.prepare(
  'SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = ?'
).get(type).c;
const countFacts = (where, ...params) => raw.prepare(
  'SELECT COUNT(*) AS c FROM am_facts WHERE ' + where
).get(...params).c;
const factById = (id) => raw.prepare('SELECT * FROM am_facts WHERE id = ?').get(id);

// The M2 injection, hardened: a plain DROP is not enough on these seams — the
// extract/consolidate paths construct their audit handle lazily (auditFor's
// WeakMap) and createMemoryAudit self-ensures its DDL, so the next append
// silently rebuilds the table and succeeds. What must not heal is the APPEND:
// the table is recreated in its exact shape but with an always-false CHECK, so
// every insert fails — a pre-warmed prepared statement and a freshly built
// handle alike.
function dropAudit() {
  raw.exec('DROP TABLE IF EXISTS memory_audit');
  raw.exec("CREATE TABLE memory_audit (" +
    "seq INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), actor TEXT NOT NULL, " +
    "action TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, row_owner TEXT, " +
    "row_hash TEXT NOT NULL, reason TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, " +
    'CHECK (seq < 0))');
}
function restoreAudit() {
  raw.exec('DROP TABLE IF EXISTS memory_audit');
  raw.exec(MEMORY_AUDIT_DDL);
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-trust-layer-p15r2-'));
  process.env.DATA_DIR = tmpDataDir;
  process.env.ADMIN_KEY = ADMIN_KEY;
  process.env.JWT_SECRET = JWT_SECRET;

  db = await import('../../server/db.js');
  db.initDB();
  raw = db.getDB();

  const routes = (await import('../../server/routes/mycelium.js')).default;
  app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/mycelium', routes);
  const { initPlugins } = await import('../../server/routes/mycelium.js');
  await initPlugins(app);

  const hashA = crypto.createHash('sha256').update(AGENT_A_KEY).digest('hex');
  db.createAgent('lucy-tl264r2', 'Lucy TL264r2', 'trust-proj', hashA, '["code"]');
  const createAutoMemoryDB = (await import('../../server/plugins/auto-memory/db.js')).default;
  am = createAutoMemoryDB(raw);
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  mockServer.closeAllConnections();
  await new Promise((resolve) => mockServer.close(resolve));
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true });
});

// The mock LLM (provider 'custom'): answers whatever the probe last set, so
// /extract and /consolidate reach their write legs without a real model.
let mockPayload = {};
const mockServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ response: JSON.stringify(mockPayload) }));
});
function useMockLLM() {
  const port = mockServer.address().port;
  am.setConfig('llm_provider', 'custom');
  am.setConfig('llm_url', 'http://127.0.0.1:' + port);
}
function resetLLM() {
  am.setConfig('llm_provider', 'none');
  am.setConfig('llm_url', '');
}

describe('P1.5 review A round 2: the purge seams commit write + audit in ONE transaction', () => {
  test('N1: DELETE /memory/index (the admin sm purge) rolls the wipe back when its audit row cannot land', async () => {
    const w = await request(app).post('/api/mycelium/memory/index').set(adminKeyAuth)
      .send({ source_type: 'tl264r2purge', source_id: 'doomed-1', content_text: 'a row the purge will name' });
    expect(w.status).toBe(200);
    expect(countSmType('tl264r2purge')).toBe(1);

    dropAudit();
    try {
      const res = await request(app).delete('/api/mycelium/memory/index?source_type=tl264r2purge').set(adminKeyAuth);
      expect(res.status).toBe(500); // the audit throw propagates — fail-loud
      expect(countSmType('tl264r2purge')).toBe(1); // the wipe rolled back WITH its purge row
    } finally {
      restoreAudit();
    }
  });

  test('N2: POST /memory/index default (chunked) branch rolls the doc back when its audit row cannot land', async () => {
    dropAudit();
    try {
      const res = await request(app).post('/api/mycelium/memory/index').set(agentA)
        .send({ source_type: 'probe', source_id: 'tl264r2-chunk-1', content_text: 'must roll back with its audit row' });
      expect(res.status).toBe(500); // the audit throw propagates — fail-loud
      expect(countSm('probe', 'tl264r2-chunk-1')).toBe(0); // the write rolled back WITH its audit row
    } finally {
      restoreAudit();
    }
  });

  test('N3: DELETE /auto-memory/facts?namespace= rolls the purge back when its audit row cannot land', async () => {
    const f = await request(app).post('/api/mycelium/auto-memory/facts').set(agentA)
      .send({ fact_text: 'a namespaced fact for the r2 purge probe', namespace: 'tl264r2-ns' });
    expect(f.status).toBe(200);
    expect(countFacts("namespace = 'tl264r2-ns'")).toBe(1);

    dropAudit();
    try {
      const res = await request(app).delete('/api/mycelium/auto-memory/facts?namespace=tl264r2-ns').set(adminKeyAuth);
      expect(res.status).toBe(500); // the audit throw propagates — fail-loud
      expect(countFacts("namespace = 'tl264r2-ns'")).toBe(1); // the purge rolled back WITH its row
    } finally {
      restoreAudit();
    }
  });
});

describe('P1.5 review A round 2: the housekeeping prunes commit write + audit in ONE transaction', () => {
  test('N4a: pruneOldSuperseded rolls the delete back when its audit row cannot land', () => {
    const a = am.createFact('lucy-tl264r2', null, 'general', 'old superseded fact for the r2 housekeeping probe', 0.8);
    const b = am.createFact('lucy-tl264r2', null, 'general', 'the r2 housekeeping probe replacement', 0.8);
    am.supersedeFact(a, b);
    raw.prepare("UPDATE am_facts SET updated_at = datetime('now', '-40 days') WHERE id = ?").run(a);
    expect(factById(a).superseded_by).not.toBeNull(); // doomed: superseded + 40 days old

    dropAudit();
    try {
      expect(() => am.pruneOldSuperseded('30 days')).toThrow(); // fail-loud
      expect(factById(a)).toBeTruthy(); // the prune rolled back WITH its row
    } finally {
      restoreAudit();
    }
  });

  test('N4b: pruneLowConfidence rolls the self-supersede back when its audit row cannot land', () => {
    const low = am.createFact('lucy-tl264r2', null, 'general', 'a low-confidence fact for the r2 decay prune', 0.1);
    raw.prepare("UPDATE am_facts SET updated_at = datetime('now', '-8 days') WHERE id = ?").run(low);

    dropAudit();
    try {
      expect(() => am.pruneLowConfidence(0.15)).toThrow(); // fail-loud
      const row = factById(low);
      expect(row).toBeTruthy();
      expect(row.superseded_by).toBeNull(); // the self-supersede rolled back WITH its row
    } finally {
      restoreAudit();
    }
  });

  test('N4c: pruneExcessFacts rolls the delete back when its audit row cannot land', () => {
    for (let i = 0; i < 3; i++) {
      am.createFact('tl264r2-house-agent', null, 'general', 'excess fact ' + i + ' for the r2 cap probe', 0.8);
    }
    expect(countFacts("agent_id = 'tl264r2-house-agent'")).toBe(3);

    dropAudit();
    try {
      expect(() => am.pruneExcessFacts('tl264r2-house-agent', 2)).toThrow(); // fail-loud
      expect(countFacts("agent_id = 'tl264r2-house-agent'")).toBe(3); // the delete rolled back WITH its row
    } finally {
      restoreAudit();
    }
  });
});

describe('P1.5 review A round 2: the consolidation/extract fact edits commit write + audit in ONE transaction', () => {
  test('N5a: the extraction write rolls back when its audit row cannot land', async () => {
    useMockLLM();
    mockPayload = { facts: [{ category: 'preference', fact_text: 'a durable extracted r2 preference fact', confidence: 0.5 }] };
    const text = 'activity text long enough for the extractor to run on it (well over the twenty-char floor)';
    expect(countFacts("fact_text = 'a durable extracted r2 preference fact'")).toBe(0);

    dropAudit();
    try {
      const res = await request(app).post('/api/mycelium/auto-memory/extract').set(agentA).send({ text: text });
      expect(res.body.facts_extracted).toBe(0); // the batch aborted — the audit throw surfaced
      expect(countFacts("fact_text = 'a durable extracted r2 preference fact'")).toBe(0); // the write rolled back WITH its row
    } finally {
      restoreAudit();
      resetLLM();
    }
  });

  test('N5b: the consolidation confidence edit rolls back when its audit row cannot land', async () => {
    useMockLLM();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(am.createFact('lucy-tl264r2', null, 'general', 'consolidation r2 keep seed ' + i, 0.5));
    mockPayload = { keep: [{ id: ids[0], new_confidence: 0.9 }] };

    dropAudit();
    try {
      const res = await request(app).post('/api/mycelium/auto-memory/consolidate').set(adminKeyAuth);
      expect(res.body.result.error).toBeTruthy(); // the consolidation surfaced its failure
      expect(factById(ids[0]).confidence).toBe(0.5); // the rewrite rolled back WITH its edit row
    } finally {
      restoreAudit();
      resetLLM();
    }
  });

  test('N5c: the consolidation merge supersede rolls back when its audit row cannot land', async () => {
    useMockLLM();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(am.createFact('lucy-tl264r2', null, 'general', 'consolidation r2 merge seed ' + i, 0.5));
    mockPayload = { merge: [{ keep_id: ids[1], supersede_ids: [ids[2]] }] };

    dropAudit();
    try {
      const res = await request(app).post('/api/mycelium/auto-memory/consolidate').set(adminKeyAuth);
      expect(res.body.result.error).toBeTruthy(); // the consolidation surfaced its failure
      expect(factById(ids[2]).superseded_by).toBeNull(); // the supersede rolled back WITH its edit row
    } finally {
      restoreAudit();
      resetLLM();
    }
  });

  test('N5d: the consolidation insight write rolls back when its audit row cannot land', async () => {
    useMockLLM();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(am.createFact('lucy-tl264r2', null, 'general', 'consolidation r2 insight seed ' + i, 0.5));
    mockPayload = { insights: [{ category: 'insight', fact_text: 'a consolidated r2 insight row', confidence: 0.7 }] };
    expect(countFacts("fact_text = 'a consolidated r2 insight row'")).toBe(0);

    dropAudit();
    try {
      const res = await request(app).post('/api/mycelium/auto-memory/consolidate').set(adminKeyAuth);
      expect(res.body.result.error).toBeTruthy(); // the consolidation surfaced its failure
      expect(countFacts("fact_text = 'a consolidated r2 insight row'")).toBe(0); // the insight rolled back WITH its write row
    } finally {
      restoreAudit();
      resetLLM();
    }
  });
});

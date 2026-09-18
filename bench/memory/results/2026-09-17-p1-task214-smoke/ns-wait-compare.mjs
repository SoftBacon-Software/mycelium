// task 214 REDUCED live instrument — the wait-comparison leg only.
//
// The FULL capped smoke (ns-wait-smoke.mjs: the real run.mjs, answers + judge)
// was refused by the 3090 slot lock — 1/1 held by the director's bench r2
// (pid 56594) — and a lane documents that SKIP, never --no-slot-lock around
// it. This instrument banks what the refusal does NOT have to cost: the
// shipped wait path (createPlatform → waitForArmEmbeddings with the run's
// namespace list → GET /memory/coverage) exercised END-TO-END against a live
// scratch boot of this worktree with the real Jetson embedder, while the
// GLOBAL leg is observed through /memory/stats exactly as the pre-214 wait
// polled it — the freeze seeded the same way (unembedded noise rows the write
// never reads). What this instrument does NOT cover: answer rows (no
// answerer — the slot refusal), so the receipt's hybrid-mode clause stays
// pinned by the hermetic suite until the full smoke runs post-r2.
//
// Pre-committed clause 1, measured here: namespace-scoped wait wall-clock ≤
// the global-wait wall-clock for the same write, both waits started at t0.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createPlatform } from '../../platform.mjs';
import { waitForArmEmbeddings } from '../../embedding_wait.mjs';
import { startJetsonRelay } from './jetson-relay.mjs';

const log = (m) => console.error(`[compare] ${m}`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/mycelium`;
const ADMIN = { 'X-Admin-Key': 'task214-smoke-admin', 'Content-Type': 'application/json' };
const NS = 'bench-p1-smoke214';
const NS_FACTS = 'bench-p1-smoke214-amfacts';
const NOISE_ROWS = 60;
const ITEMS_PER_NS = 25;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myc-214-cmp-'));
let server = null;
let relay = null;
try {
  // The scratch server's node fetch cannot reach 192.168.50.x on this Mac
  // (EHOSTUNREACH — the recorded node/python-vs-curl lesson); the embedder
  // dials the Jetson THROUGH the curl-backed loopback relay instead.
  relay = await startJetsonRelay({ log });
  log(`jetson relay: http://127.0.0.1:${relay.port} → 192.168.50.106:11434 (curl-backed)`);
  const boot = () => {
    const s = spawn('node', ['server/index.js'], {
      cwd: REPO,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), ADMIN_KEY: 'task214-smoke-admin', JWT_SECRET: 'task214-smoke-jwt' },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    server = s;
    return s;
  };
  const untilHealthy = async () => {
    for (;;) {
      try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }); return; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  };

  boot();
  await untilHealthy();
  await fetch(`${API}/memory/config`, {
    method: 'PUT', headers: ADMIN,
    body: JSON.stringify({ embedding_provider: 'ollama', embedding_url: `http://127.0.0.1:${relay.port}`, embedding_model: 'nomic-embed-text' }),
  });
  log('embedder → Jetson ollama nomic-embed-text (via curl relay)');

  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  const db = new Database(path.join(dataDir, 'mycelium.db'));
  const seed = db.prepare(
    "INSERT INTO sm_embeddings (source_type, source_id, namespace, chunk_index, content_text, metadata) VALUES ('lesson', ?, ?, 0, ?, '{}')"
  );
  db.transaction(() => {
    for (let i = 0; i < NOISE_ROWS; i++) seed.run(`noise-${i}`, 'bench-214-noise', `noise ${i} — never searched, never embedded`);
  })();
  db.close();
  log(`seeded ${NOISE_ROWS} unembedded noise rows (global freeze condition)`);

  boot();
  await untilHealthy();
  const stats0 = await (await fetch(`${API}/memory/stats`, { headers: ADMIN })).json();
  log(`pre-write GLOBAL coverage: ${stats0.embedding_coverage}%`);

  // THE WRITE: through the platform seam the run uses (bulk index), in TWO
  // namespaces — the run's base + the am_facts suffix shape (task 206).
  const platform = createPlatform({ baseUrl: BASE, headers: { 'X-Admin-Key': 'task214-smoke-admin', 'X-Acting-As': 'm5Max' }, timeoutMs: 30000, maxRetries: 4 });
  const items = [];
  for (let i = 0; i < ITEMS_PER_NS; i++) {
    items.push({ source_type: 'bench_smoke214', source_id: `base-${i}`, namespace: NS, content_text: `smoke row ${i}: the vault code rotates on the first Monday of each month and the custodian logs the change` });
    items.push({ source_type: 'bench_smoke214', source_id: `fact-${i}`, namespace: NS_FACTS, content_text: `fact row ${i}: the team lead for the north ridge survey is Dana and the relay window opens at dawn` });
  }
  const t0 = Date.now();
  const wrote = await platform.indexBulk(items);
  const docs = wrote.reduce((n, r) => n + (r.indexed ?? r.chunks ?? 0), 0);
  log(`wrote ${docs} index rows across ${NS} + ${NS_FACTS}; both waits start NOW`);

  // GLOBAL leg — polled exactly as the pre-214 wait polled it, same t0. The
  // last OBSERVED coverage is carried out even when unsettled: "frozen" must
  // be a number the leg read, never an assertion made in a catch block.
  let lastSeen = null;
  const globalLeg = (async () => {
    for (;;) {
      try {
        const s = await platform.stats();
        lastSeen = s.embedding_coverage;
        if (s.embedding_coverage >= 99.9) return { settled: true, waited_ms: Date.now() - t0, last_coverage: lastSeen };
      } catch { /* a slow platform is a wait, not a crash */ }
      if (Date.now() - t0 > 180000) return { settled: false, waited_ms: Date.now() - t0, last_coverage: lastSeen };
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();

  // NAMESPACE leg — the shipped path, the run's own wait, same t0.
  const nsLeg = waitForArmEmbeddings(platform, { expected: items.length, namespaces: [NS, NS_FACTS], log: (m) => log(`wait: ${m}`) });

  const [nsWait, globalWait] = await Promise.all([nsLeg, globalLeg]);
  log('--- PRE-COMMITTED CLAUSE 1, measured -----------------------------------');
  log(`NAMESPACE leg: scope=${nsWait.scope} waited_ms=${nsWait.waited_ms} settled=${nsWait.settled} coverage_by_namespace=${JSON.stringify(nsWait.coverage_by_namespace ?? null)} poll_failures=${nsWait.poll_failures}`);
  log(`GLOBAL leg:    settled=${globalWait.settled} waited_ms=${globalWait.waited_ms} last_coverage=${globalWait.last_coverage} (freeze seeded: ${NOISE_ROWS} noise rows the write never reads)`);
  let fail = 0;
  const check = (name, ok) => { log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail = 1; };
  check(`scope === 'namespace'`, nsWait.scope === 'namespace');
  check(`namespace leg settled at 100% of BOTH namespaces`, nsWait.settled === true && Object.values(nsWait.coverage_by_namespace ?? {}).every((v) => v >= 99.9));
  check(`namespace waited_ms (${nsWait.waited_ms}) <= global waited_ms (${globalWait.waited_ms})`, nsWait.waited_ms <= globalWait.waited_ms);
  check(`global freeze held (never reached 99.9)`, globalWait.settled === false);
  log('-------------------------------------------------------------------------');
  fs.writeFileSync(path.join(HERE, 'ns-wait-compare.out.json'), JSON.stringify({ write_rows: items.length, namespace_wait: nsWait, global_wait: globalWait }, null, 2));
  log('wrote ns-wait-compare.out.json');
  process.exitCode = fail;
} finally {
  if (relay) relay.stop();
  if (server) server.kill('SIGTERM');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  log('scratch server stopped, temp DATA_DIR removed');
}

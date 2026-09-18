// task 214 capped smoke — namespace-scoped embedding wait vs the global wait,
// on the SAME write, under a live server boot of this worktree's tree.
//
// Shape follows the task 211 route smoke (../2026-09-17-p1-task211-smoke/):
// scratch boot only — temp DATA_DIR (removed on exit), loopback port, server
// child killed before exit. No deploy. The 3090 slot is taken by run.mjs's own
// slot lock (a refusal is a documented SKIP, never --no-slot-lock).
//
// The pre-committed line (brief task 214):
//   namespace-scoped wait wall-clock ≤ the global-wait wall-clock for the same
//   write, BOTH reaching 100% coverage of the run's namespaces before the
//   first answer, and every answer row's retrieval_mode 'hybrid'.
//
// The freeze condition is seeded, not hoped for: 60 unembedded noise rows in a
// namespace the run never searches hold the scratch platform's GLOBAL coverage
// below 99.9 forever — the lab-busy shape (r2: global ~40% for ~25 min) made
// deterministic. The namespace leg settles on the run's own namespaces via GET
// /memory/coverage (the route this branch adds); the global leg is observed
// concurrently through /memory/stats exactly as the pre-214 wait polled it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startJetsonRelay } from './jetson-relay.mjs';

const log = (m) => console.error(`[smoke] ${m}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..'); // results/<dir>/ -> bench/memory -> bench -> repo
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/mycelium`;
const ADMIN = { 'X-Admin-Key': 'task214-smoke-admin', 'Content-Type': 'application/json' };
const NOISE_NS = 'bench-214-noise';
const NOISE_ROWS = 60;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myc-214-smoke-'));
// The scratch server's node fetch cannot reach 192.168.50.x on this Mac
// (EHOSTUNREACH — the recorded node/python-vs-curl lesson); the embedder dials
// the Jetson THROUGH the curl-backed loopback relay instead.
const relay = await startJetsonRelay({ log });
log(`jetson relay: http://127.0.0.1:${relay.port} → 192.168.50.106:11434 (curl-backed)`);
let server = spawn('node', ['server/index.js'], {
  cwd: REPO,
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), ADMIN_KEY: 'task214-smoke-admin', JWT_SECRET: 'task214-smoke-jwt' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

let runProc = null;
try {
  // ---- wait for /health ------------------------------------------------------
  const t0 = Date.now();
  for (;;) {
    try {
      await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      break;
    } catch {
      if (Date.now() - t0 > 30000) throw new Error(`scratch server never answered /health:\n${serverErr.slice(-800)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  log(`scratch server up on :${PORT} (DATA_DIR ${dataDir})`);

  // ---- point the embedder at the Jetson's ollama (a CLIENT of it — no model
  // server is started here; nomic-embed-text already serves there) ----------
  const putCfg = await fetch(`${API}/memory/config`, {
    method: 'PUT', headers: ADMIN,
    body: JSON.stringify({ embedding_provider: 'ollama', embedding_url: `http://127.0.0.1:${relay.port}`, embedding_model: 'nomic-embed-text' }),
  });
  if (!putCfg.ok) throw new Error(`PUT /memory/config -> ${putCfg.status}: ${(await putCfg.text()).slice(0, 200)}`);
  const cfg = await (await fetch(`${API}/memory/config`, { headers: ADMIN })).json();
  log(`embedder: provider=${cfg.embedding_provider} model=${cfg.embedding_model} url=${cfg.embedding_url} (→ Jetson via curl relay)`);

  // ---- the server holds the sqlite file now: stop it, seed noise, restart ----
  server.kill('SIGTERM');
  await new Promise((r) => server.on('exit', r));
  const dbFile = path.join(dataDir, 'mycelium.db');
  const db = new Database(dbFile);
  const seed = db.prepare(
    "INSERT INTO sm_embeddings (source_type, source_id, namespace, chunk_index, content_text, metadata) " +
    "VALUES ('lesson', ?, ?, 0, ?, '{}')"
  );
  db.transaction(() => {
    for (let i = 0; i < NOISE_ROWS; i++) {
      seed.run(`noise-${i}`, NOISE_NS, `noise row ${i} — never searched, never embedded; holds GLOBAL coverage down`);
    }
  })();
  db.close();
  log(`seeded ${NOISE_ROWS} unembedded noise rows in namespace ${NOISE_NS} (global freeze condition)`);
  server = spawn('node', ['server/index.js'], {
    cwd: REPO,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), ADMIN_KEY: 'task214-smoke-admin', JWT_SECRET: 'task214-smoke-jwt' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', (d) => { serverErr += d; });
  for (;;) {
    try { await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }); break; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const stats0 = await (await fetch(`${API}/memory/stats`, { headers: ADMIN })).json();
  log(`pre-run GLOBAL coverage: ${stats0.embedding_coverage}% (noise rows count, nothing embedded yet)`);

  // ---- the observer: the GLOBAL leg, polled exactly as the pre-214 wait did --
  const obs = { t0: null, samples: [], settledAt: null };
  const observe = async () => {
    for (;;) {
      if (obs.t0 !== null) {
        try {
          const s = await (await fetch(`${API}/memory/stats`, { headers: ADMIN })).json();
          obs.samples.push({ t: Date.now() - obs.t0, coverage: s.embedding_coverage });
          if (s.embedding_coverage >= 99.9 && obs.settledAt === null) obs.settledAt = Date.now() - obs.t0;
        } catch { /* observer poll failures are not the finding */ }
      }
      if (!runProc || runProc.exitCode !== null) {
        // one last sample after the run exits, then stop
        if (obs.grace) break;
        obs.grace = true;
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  };
  const observerDone = observe();

  // ---- THE RUN: the real run.mjs, capped smoke shape --------------------------
  const runArgs = ['bench/memory/run.mjs', '--arms', 'mycelium,mycelium-timeline', '--n', '1', '--max-sessions', '5', '--receipt'];
  log(`spawning: node ${runArgs.join(' ')}  (slot lock taken by run.mjs itself; refusal = SKIP)`);
  const runT0 = Date.now();
  obs.t0 = runT0;
  runProc = spawn('node', runArgs, {
    cwd: REPO,
    env: { ...process.env, MYCELIUM_URL: BASE, MYCELIUM_ADMIN_KEY: 'task214-smoke-admin', MYCELIUM_TIMELINE_FACTS: 'am_facts' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let runStdout = '';
  runProc.stdout.on('data', (d) => { runStdout += d; });
  const runExit = await new Promise((r) => runProc.on('exit', (code, sig) => r({ code, sig })));
  const runWallMs = Date.now() - runT0;
  await new Promise((r) => setTimeout(r, 3500)); // let the observer take its last sample
  await observerDone;

  if (runExit.code !== 0) {
    throw new Error(`run.mjs exited ${runExit.code} ${runExit.sig ?? ''} (slot-lock refusal or bench failure — see stderr above)`);
  }
  const runOut = JSON.parse(runStdout.trim().split('\n').filter(Boolean).pop());
  log(`run ${runOut.run_id} finished in ${Math.round(runWallMs / 1000)}s — results ${runOut.out_dir}`);

  // ---- read the run's own stamps ---------------------------------------------
  const summary = JSON.parse(fs.readFileSync(path.join(REPO, runOut.out_dir, 'summary.json'), 'utf8'));
  const globalWait = {
    settled: obs.settledAt !== null,
    waited_ms: obs.settledAt ?? (obs.samples.at(-1)?.t ?? 0),
    samples: obs.samples.length,
    last_coverage: obs.samples.at(-1)?.coverage ?? null,
  };

  log('--- PRE-COMMITTED LINE, measured ---------------------------------------');
  for (const arm of ['mycelium', 'mycelium-timeline']) {
    const w = summary.write_info?.[arm]?.embed_wait;
    if (!w) { log(`${arm}: NO embed_wait stamp (FAIL)`); process.exitCode = 1; continue; }
    log(`${arm}: scope=${w.scope} namespaces=${JSON.stringify(w.namespaces)} waited_ms=${w.waited_ms} settled=${w.settled} poll_failures=${w.poll_failures} coverage_by_namespace=${JSON.stringify(w.coverage_by_namespace ?? null)}`);
    const checks = [
      [`scope === 'namespace'`, w.scope === 'namespace'],
      [`settled`, w.settled === true],
      [`namespace coverage 100 at settle`, Object.values(w.coverage_by_namespace ?? {}).every((v) => v >= 99.9)],
      [`namespace waited_ms (${w.waited_ms}) <= global waited_ms (${globalWait.waited_ms})`, w.waited_ms <= globalWait.waited_ms],
    ];
    for (const [name, ok] of checks) { log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) process.exitCode = 1; }
  }
  log(`GLOBAL leg: settled=${globalWait.settled} waited_ms=${globalWait.waited_ms} last_coverage=${globalWait.last_coverage}% over ${globalWait.samples} samples (freeze seeded: ${NOISE_ROWS} unembedded noise rows the run never reads)`);
  if (globalWait.settled) log('  NOTE: global settled anyway — the freeze did NOT hold; the ≤ comparison is a tie at best');
  const modes = Object.fromEntries(Object.entries(summary.arms).map(([a, v]) => [a, v.retrieval_modes ?? null]));
  log(`retrieval_modes per arm: ${JSON.stringify(modes)}`);
  for (const [arm, m] of Object.entries(modes)) {
    if (!m) continue; // an arm without answers stamps no modes
    const ok = Object.keys(m).every((k) => k === 'hybrid') && Object.values(m).every((v) => v > 0);
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${arm}: every answered query ran hybrid (zero keyword-fallback rows)`);
    if (!ok) process.exitCode = 1;
  }
  log('-------------------------------------------------------------------------');

  // ---- artifacts beside this driver -------------------------------------------
  const copy = (from, to) => { try { fs.copyFileSync(path.join(REPO, from), path.join(HERE, to)); log(`copied ${to}`); } catch (e) { log(`copy ${from}: ${e.message}`); } };
  copy(path.join(runOut.out_dir, 'summary.json'), 'summary.json');
  copy(path.join(runOut.out_dir, 'receipt.md'), 'receipt.md');
  fs.writeFileSync(path.join(HERE, 'global-wait-observer.json'), JSON.stringify(globalWait, null, 2));
  log('wrote global-wait-observer.json');
} finally {
  if (runProc && runProc.exitCode === null) runProc.kill('SIGTERM');
  relay.stop();
  server.kill('SIGTERM');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  log('scratch server stopped, temp DATA_DIR removed');
}

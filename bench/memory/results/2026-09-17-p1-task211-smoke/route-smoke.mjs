// task 211 capped-smoke route driver — DELETE /auto-memory/facts?namespace=<ns>
// (am_facts bulk delete by namespace, BRIEF-lab-alive-memory §3). Boots a
// SCRATCH local server of this worktree's tree on a temp DATA_DIR, drives the
// new route end-to-end (purge isolation, superseded-rows-die-too, unscoped
// 400, non-admin 403, post-purge search 0 hits), then dumps the route_usage
// counter rows — the counters ARE the receipt (206's convention). No model,
// no 3090 slot, no deploy. The server child is killed before exit.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..'); // → the worktree/repo root
const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_KEY = 'smoke-local-admin';
const NS = 'bench-p1-smoke20260917-amfacts-purge'; // the run-scoped namespace, arm-shaped
const OTHER = 'bench-p1-smoke20260917-other-amfacts';
const H = { 'content-type': 'application/json', 'x-admin-key': ADMIN_KEY, 'x-acting-as': 'm5Max' };
const log = (...a) => console.log(...a);

const dataDir = mkdtempSync(join(tmpdir(), 'myc-amfacts-bulk-smoke-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), ADMIN_KEY, JWT_SECRET: 'smoke-local-secret' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

// the cleanup this driver owes the box NO MATTER HOW it exits (lane rule 0:
// a lane's background child dies with the lane — kill it EXPLICITLY first)
let exiting = false;
async function killServer() {
  if (exiting) return;
  exiting = true;
  if (server.exitCode === null && !server.killed) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), new Promise((r) => setTimeout(r, 5000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', () => { if (!exiting) { server.kill('SIGKILL'); } });

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('scratch server never became healthy\n' + serverLog.slice(-2000));
}

async function call(method, path, body, headers = H) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

try {
  const health = await waitHealthy();
  log('HEALTH', JSON.stringify({ ok: health.ok ?? true, version: health.version, commit_sha: health.commit_sha }));

  // 1. ADD — three facts in the run namespace + one bystander in the other
  const mk = (text, ns, sid) => call('POST', '/api/mycelium/auto-memory/facts', {
    fact_text: text, namespace: ns, category: 'general',
    source_type: 'bench_longmemeval', source_id: sid,
    metadata: { question_id: sid, layer: 'fact', ingestion: 'timeline', run_id: 'smoke20260917-purge' },
  });
  const alex = await mk("User's manager is Alex", NS, 'smoke-q003-tl-f0');
  const cats = await mk('Cats dream during REM sleep', NS, 'smoke-q002-tl-f0');
  const dana = await mk("User's new manager is Dana now", NS, 'smoke-q003-tl-f1');
  const osaka = await mk('The offsite is in Osaka', OTHER, 'smoke-other-f0');
  log('ADD ids', JSON.stringify({ alex: alex.json.id, cats: cats.json.id, dana: dana.json.id, other: osaka.json.id }));

  // 2. SUPERSEDE — Dana replaces Alex (the old row STAYS indexed, per 206)
  const sup = await call('POST', `/api/mycelium/auto-memory/facts/${alex.json.id}/supersede?namespace=${encodeURIComponent(NS)}`, { new_id: dana.json.id });
  log('SUPERSEDE', JSON.stringify({ status: sup.status, old_superseded_by: sup.json?.fact?.superseded_by, old_valid_to: sup.json?.fact?.valid_to }));

  // 3. SEARCH BEFORE — the namespace answers (keyword mode: no embed provider on the scratch boot)
  const before = await call('POST', '/api/mycelium/memory/search', { query: 'manager', namespace: NS, source_types: ['am_fact'], mode: 'keyword', limit: 25 });
  log('SEARCH BEFORE PURGE ns hits:', before.json.results.length, before.json.results.map((r) => r.source_id).join(','));

  // 4. PURGE — the new route: deletes current AND superseded, nothing else
  const purge = await call('DELETE', `/api/mycelium/auto-memory/facts?namespace=${encodeURIComponent(NS)}`);
  log('PURGE', JSON.stringify({ status: purge.status, ...purge.json }));

  // 5. the OTHER namespace: deleted 0 there, rows survive and still answer
  const otherList = await call('GET', `/api/mycelium/auto-memory/facts?namespace=${encodeURIComponent(OTHER)}`);
  const otherHits = await call('POST', '/api/mycelium/memory/search', { query: 'Osaka offsite', namespace: OTHER, source_types: ['am_fact'], mode: 'keyword', limit: 25 });
  log('OTHER NS rows:', otherList.json.length, '| still-searchable hits:', otherHits.json.results.length);

  // 6. SEARCH AFTER PURGE — 0 hits in the purged namespace (the pre-committed number)
  const after = await call('POST', '/api/mycelium/memory/search', { query: 'manager', namespace: NS, source_types: ['am_fact'], mode: 'keyword', limit: 25 });
  log('SEARCH AFTER PURGE ns hits:', after.json.results.length);

  // 7. UNSCOPED REFUSAL + NON-ADMIN 403
  const unscoped = await call('DELETE', '/api/mycelium/auto-memory/facts');
  const forbidden = await fetch(`${BASE}/api/mycelium/auto-memory/facts?namespace=${encodeURIComponent(NS)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', 'x-admin-key': 'not-the-admin-key' },
  });
  log('UNSCOPED', JSON.stringify({ status: unscoped.status, error: unscoped.json?.error }));
  log('NON-ADMIN', JSON.stringify({ status: forbidden.status }));

  // 8. THE RECEIPT — route_usage rows for this boot, verbatim
  await new Promise((r) => setTimeout(r, 300)); // let response-finish counters land
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(dataDir, 'mycelium.db'), { readonly: true });
  const rows = db.prepare("SELECT method, route_pattern, count, day, first_seen, last_seen FROM route_usage WHERE route_pattern LIKE '/auto-memory/facts%' OR route_pattern = '/memory/search' ORDER BY method, route_pattern").all();
  const header = 'method           route_pattern                        count     day          first_seen            last_seen';
  const body = rows.map((r) =>
    `${r.method.padEnd(16)}  ${r.route_pattern.padEnd(34)}  ${String(r.count).padStart(5)}  ${r.day}  ${r.first_seen}  ${r.last_seen}`
  ).join('\n');
  const receipt = `${header}\n${'------  ' + '--------------------------------  ' + '-----  ' + '----------  ' + '-------------------  ' + '-------------------'}\n${body}\n`;
  log('ROUTE USAGE COUNTERS:\n' + receipt);
  writeFileSync(join(HERE, 'route-usage-counters.txt'), receipt);
  db.close();
} finally {
  await killServer();
}
log('DONE — route smoke complete');

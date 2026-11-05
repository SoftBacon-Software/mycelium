// LIVE CHECK — the #206 revoke re-send loop over TWO REAL SPAWNED SERVERS.
// (The unit suite proves the semantics against a faked core; this proves the
// loop over real HTTP: two fresh `node server/index.js` processes, fresh
// DATA_DIRs, the shipped client driving, everything killed on exit.)
//
//   server H (port 3971)  the HOLDER — the network whose store the late copy
//                         lands in and that must catch up on the next hello
//   server D (port 3972)  the AUTHOR'S HOME NODE — where agent A records its
//                         outstanding revoke (GET /federation/outbox lists it)
//
// The story, one checkpoint per step:
//   1. A knocks D (its home) — passports on file there.
//   2. A computes a row id X for content H has never seen, revokes X at H
//      directly → `unknown`, nothing written (M1 as shipped, live).
//   3. A records the revoke on D → 200 (the author's keep).
//   4. A third holder L hands H a souvenir carrying X → `imported` (THE GAP).
//   5. D's outbox lists X; A knocks H AGAIN carrying it → applied, the copy
//      falls (THE CATCH-UP).
//   6. H now refuses re-arrivals: a fresh bundle re-imports as `revoked`, a
//      live visit write of the same content answers 410, and recall is empty.
//   7. A plain hello answers exactly as before (no `revokes` key).
//
// Run: node docs/specs/2026-10-08-federation-revoke-resend/live-check.mjs
// Exit 0 iff every checkpoint passes. Kills both children in `finally`.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const FED = join(ROOT, 'server', 'plugins', 'federation');

const ADMIN_KEY = 'live-check-admin-key-0123456789abcdef';
const JWT_SECRET = 'live-check-jwt-secret';
const PORT_H = 3971;
const PORT_D = 3972;
const BASE_H = 'http://127.0.0.1:' + PORT_H;
const BASE_D = 'http://127.0.0.1:' + PORT_D;
const HEALTH_DEADLINE_MS = 15000;

const HOST_SEED = crypto.createHash('sha256').update('p14r-live-host').digest('hex');
const HOME_SEED = crypto.createHash('sha256').update('p14r-live-home').digest('hex');
const AGENT_SEED = crypto.createHash('sha256').update('p14r-live-agent').digest('hex');
const LATE_HOST_SEED = crypto.createHash('sha256').update('p14r-live-late-host').digest('hex');

const OWNER_TOKEN = jwt.sign(
  { studioUser: true, userId: 4242, username: 'live-check', role: 'operator' },
  JWT_SECRET, { expiresIn: '1h' });

const { makeVisitor } = await import(join(FED, 'client.js'));
const protocol = await import(join(FED, 'protocol.js'));
const keys = await import(join(FED, 'keys.js'));
const visitor = makeVisitor({
  homeSeed: HOME_SEED, agentSeed: AGENT_SEED,
  homeName: 'qurio-home-live', agentName: 'Qurio-live-check'
});

const watchdog = setTimeout(() => {
  console.error('LIVE-CHECK TIMEOUT — killed');
  process.exit(1);
}, 120000);

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
  if (!cond) failures++;
}

async function fetchJSON(base, path, opts = {}) {
  const r = await fetch(base + path, {
    method: opts.method || 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, opts.headers || {}),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(10000)
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* non-JSON body */ }
  return { status: r.status, body };
}

// The shipped client's transport shape, over real HTTP (path → /api/mycelium).
const transportFor = (base) => ({
  post: async (path, body, headers) => fetchJSON(base, '/api/mycelium' + path, { body, headers })
});

function spawnServer(name, port, dataDir, logPath) {
  const child = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_KEY,
      JWT_SECRET,
      MYCELIUM_RATE_LIMIT: 'off',
      NODE_ENV: 'test'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = createWriteStream(logPath);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.on('exit', (code, sig) => { log.write('[exit] code=' + code + ' sig=' + sig + '\n'); log.end(); });
  return child;
}

async function waitHealthy(base, label) {
  const deadline = Date.now() + HEALTH_DEADLINE_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) { console.log('booted ' + label + ' at ' + base); return true; }
    } catch (e) { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  console.error('FAILED to boot ' + label + ' within ' + HEALTH_DEADLINE_MS + 'ms');
  return false;
}

async function envelopeFor(payload) {
  return protocol.makeEnvelope(visitor.agentKey, visitor.agentId, payload,
    Math.floor(Date.now() / 1000), crypto.randomBytes(16).toString('hex'));
}

// A hand-built souvenir from third holder L carrying one A-authored row — the
// door a late copy actually arrives through (verifyBundle enforces
// row.agent === the bundle's agent, so only the author's own rows travel).
function lateBundle(fields, visitId) {
  const hostKey = keys.keyFromSeed(LATE_HOST_SEED);
  const hostId = keys.idForKey(hostKey);
  const row = protocol.makeRow(visitor.agentKey, visitor.agentId, fields, {
    agent: visitor.agentId, network: hostId, home: visitor.homeNetworkId, visit: visitId
  });
  const bundle = protocol.makeBundle(hostKey, {
    host_passport: protocol.makeNetworkPassport(hostKey, hostId, {
      name: 'p14r-live-late-host',
      policy: { visitors: true, kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] },
      issued_at: new Date().toISOString()
    }),
    agent_passport: visitor.agentPassport,
    visit: protocol.makeVisitRecord({
      visit_id: visitId, host_network: hostId, agent_id: visitor.agentId,
      home_network: visitor.homeNetworkId, grant_id: 'unused-for-shape',
      started_at: '2026-10-08T07:00:00Z', ended_at: '2026-10-08T08:00:00Z'
    }),
    rows: [row], issued_at: new Date().toISOString()
  });
  return { bundle, row };
}

const dataDir = mkdtempSync(join(tmpdir(), 'p14r-live-'));
const dirH = join(dataDir, 'holder-H');
const dirD = join(dataDir, 'author-D');
const serverH = spawnServer('H', PORT_H, dirH, '/tmp/p14r-live-H.log');
const serverD = spawnServer('D', PORT_D, dirD, '/tmp/p14r-live-D.log');

let booted = await waitHealthy(BASE_H, 'holder H');
booted = (await waitHealthy(BASE_D, 'author home D')) && booted;

try {
  if (!booted) throw new Error('a server failed to boot — see /tmp/p14r-live-{H,D}.log');

  // Both networks' identities pinned to the driver's seeds: H is the holder,
  // D is the author's home (A's passports are signed with D's key).
  const netH = await fetchJSON(BASE_H, '/api/mycelium/federation/network', {
    headers: { 'X-Admin-Key': ADMIN_KEY },
    body: { seed_hex: HOST_SEED, name: 'live-check-host', visitors: true,
      kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] }
  });
  check('H network configured', netH.status === 200 || netH.status === 201, 'status=' + netH.status);
  const netD = await fetchJSON(BASE_D, '/api/mycelium/federation/network', {
    headers: { 'X-Admin-Key': ADMIN_KEY },
    body: { seed_hex: HOME_SEED, name: 'qurio-home-live' }
  });
  check('D network configured', netD.status === 200 || netD.status === 201, 'status=' + netD.status);

  // 1. A knocks its HOME node D — passports on file there.
  const knockD = await visitor.hello(transportFor(BASE_D));
  check('A knocked its home node D', knockD.status === 200, 'status=' + knockD.status);

  // 2. X: content H has never seen. The direct revoke lands `unknown`.
  const fields = {
    kind: 'aboutYou', key: 'live.loop',
    text: 'the live-check row revoked before its holder ever saw it',
    source: 'visit', at: '2026-10-08T08:00:00Z', supersedes: null
  };
  const xId = protocol.rowId(fields);
  const rev = protocol.makeRevoke(visitor.agentKey, visitor.agentId, visitor.homeNetworkId, [xId], {
    reason: 'gone before you met it', issued_at: new Date().toISOString()
  });
  const knockH = await visitor.hello(transportFor(BASE_H));
  check('A knocked holder H', knockH.status === 200, 'status=' + knockH.status);
  const hostNetworkId = knockH.body.network_passport.network_id;
  const r0 = await transportFor(BASE_H).post('/federation/revoke', await envelopeFor({ revoke: rev }));
  check('direct revoke at H lands unknown (M1 live)',
    r0.status === 200 && r0.body.revoked === 0 && Array.isArray(r0.body.unknown) && r0.body.unknown[0] === xId,
    JSON.stringify(r0.body).slice(0, 200));

  // 3. The author's keep on D.
  const rec = await visitor.recordRevoke(transportFor(BASE_D), xId, 'gone before you met it');
  check('A recorded the revoke on its home node D', rec.status === 200, 'status=' + rec.status);

  // 4. The late copy from third holder L LANDS at H — the gap, live.
  const late1 = lateBundle(fields, 'v-live-late-1');
  check('third-holder row keeps one protocol id', late1.row.id === xId);
  const imp = await fetchJSON(BASE_H, '/api/mycelium/federation/import', {
    headers: { Authorization: 'Bearer ' + OWNER_TOKEN }, body: { bundle: late1.bundle }
  });
  const outcome1 = imp.body && imp.body.outcomes && imp.body.outcomes.find((o) => o.row_id === xId);
  check('THE GAP: the late copy landed at H', imp.status === 201 && outcome1 && outcome1.outcome === 'imported',
    'status=' + imp.status + ' outcome=' + (outcome1 ? outcome1.outcome : 'none'));

  // 5. D's outbox lists it; A's NEXT HELLO to H carries it — the catch-up.
  const outbox = await fetchJSON(BASE_D, '/api/mycelium/federation/outbox', {
    method: 'GET', headers: { 'X-Admin-Key': ADMIN_KEY }
  });
  check('D lists the outstanding revoke', outbox.status === 200 &&
    outbox.body.revokes.some((r) => r.row_ids[0] === xId),
    'count=' + (outbox.body ? outbox.body.count : 'none'));
  const knock2 = await visitor.hello(transportFor(BASE_H), { revokes: outbox.body.revokes });
  const mine = knock2.body && knock2.body.revokes &&
    knock2.body.revokes.outcomes.find((o) => o.agent_id === visitor.agentId);
  check('THE CATCH-UP: the next hello applied the re-send and the copy fell',
    knock2.status === 200 && knock2.body.revokes && knock2.body.revokes.applied >= 1 &&
      mine && mine.revoked >= 1,
    JSON.stringify(knock2.body && knock2.body.revokes).slice(0, 240));

  // 6. H refuses re-arrivals.
  const late2 = lateBundle(fields, 'v-live-late-2');
  const reImp = await fetchJSON(BASE_H, '/api/mycelium/federation/import', {
    headers: { Authorization: 'Bearer ' + OWNER_TOKEN }, body: { bundle: late2.bundle }
  });
  const outcome2 = reImp.body && reImp.body.outcomes && reImp.body.outcomes.find((o) => o.row_id === xId);
  check('re-import refused as revoked', outcome2 && outcome2.outcome === 'revoked',
    'outcome=' + (outcome2 ? outcome2.outcome : 'none'));

  const grant = await fetchJSON(BASE_H, '/api/mycelium/federation/grant', {
    headers: { Authorization: 'Bearer ' + OWNER_TOKEN }, body: { agent_passport: visitor.agentPassport }
  });
  check('live grant issued', grant.status === 201 && grant.body.visit_id, 'status=' + grant.status);
  const rewrite = await visitor.writeMemory(transportFor(BASE_H), grant.body.visit_id, hostNetworkId, fields);
  check('re-write refused with 410 on the visit door', rewrite.status === 410, 'status=' + rewrite.status);

  const recall = await fetchJSON(BASE_H, '/api/mycelium/memory/me/memory', {
    method: 'GET', headers: { Authorization: 'Bearer ' + OWNER_TOKEN }
  });
  const stillThere = recall.body && Array.isArray(recall.body.results) &&
    recall.body.results.some((r) => r.provenance && r.provenance.id === xId);
  check('recall is empty of X', recall.status === 200 && !stillThere);

  // 7. A plain hello answers exactly as before.
  const plain = await visitor.hello(transportFor(BASE_H));
  check('plain hello unchanged (no revokes key)', plain.status === 200 &&
    plain.body.ok === true && plain.body.revokes === undefined);
} finally {
  clearTimeout(watchdog);
  for (const c of [serverH, serverD]) { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } }
  await new Promise((res) => setTimeout(res, 1500));
  for (const c of [serverH, serverD]) { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* tmp */ }
}

console.log('');
if (!booted || failures > 0) {
  console.log('LIVE CHECK: ' + (booted ? failures + ' FAILURE(S)' : 'SERVER BOOT FAILED'));
  process.exit(1);
}
console.log('LIVE CHECK: ALL PASS');
process.exit(0);

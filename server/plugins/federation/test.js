// Federation plugin tests — the protocol's own smoke (spec/federation-v0/).
// Run from server/:  node --test plugins/federation/test.js
// Real keys.js/protocol.js/store.js/routes.js on an in-memory better-sqlite3
// DB seeded from the real schema.sql files; core faked with the same shapes
// routes/mycelium.js hands plugins. Hermetic: Ed25519 needs no network, no
// embedder is configured, and the deep gates (every committed vector, the
// full HTTP round trip) live in test/unit/federation-*.test.js — this file
// proves the plugin's own wiring: sign → verify → store → serve.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import Database from 'better-sqlite3';

import { keyFromSeed, idForKey, cjson } from './keys.js';
import {
  makeRow, makeNetworkPassport, makeAgentPassport, makeGrant, makeBundle,
  verifyRow, verifyGrant, verifyBundle, adjudicateImport
} from './protocol.js';
import createFederationStore from './store.js';
import createRoutes from './routes.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministic test keys — the same fixed material the committed vectors use.
import crypto from 'crypto';
function seedFor(label) { return crypto.createHash('sha256').update(label, 'utf8').digest('hex'); }
var HOST_SEED = seedFor('mycelium-federation-v0/test/host');
var GUEST_SEED = seedFor('mycelium-federation-v0/test/guest-network');
var AGENT_SEED = seedFor('mycelium-federation-v0/test/agent-a');
var hostKey = keyFromSeed(HOST_SEED);
var guestKey = keyFromSeed(GUEST_SEED);
var agentKey = keyFromSeed(AGENT_SEED);
var HOST_ID = idForKey(hostKey);
var GUEST_ID = idForKey(guestKey);
var AGENT_ID = idForKey(agentKey);

function freshDb() {
  var db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'semantic-memory', 'schema.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

function fakeCore(db) {
  return {
    db: db,
    auth: {
      getStudioUser: () => null,
      checkAdmin: (req, res) => { res.status(401).json({ error: 'no admin in this fake' }); return null; },
      checkAgentOrAdmin: () => null,
    },
    apiError: (res, code, msg) => res.status(code).json({ error: msg }),
    parseIntParam: (v) => { var n = parseInt(v, 10); return isNaN(n) ? null : n; },
    asyncHandler: (fn) => function (req, res, next) { return Promise.resolve(fn(req, res, next)).catch(next); },
    emitEvent: () => {},
  };
}

test('federation keys: same seed, same id, across the boundary', () => {
  // The interoperability floor: a second implementation (Swift's
  // Curve25519 rawRepresentation) derives the same keypair from the same seed.
  assert.equal(idForKey(keyFromSeed(HOST_SEED)), HOST_ID);
  assert.match(HOST_ID, /^[a-z2-7]{52}$/); // base32(raw 32-byte key), unpadded
});

test('federation protocol: every message verifies, tamper does not', () => {
  var pp = makeAgentPassport(guestKey, {
    agent_id: AGENT_ID, name: 'Q', species: 'qurio', home_network: GUEST_ID,
    capabilities: ['memory'], consent: { share_memories: true },
    issued_at: '2026-09-24T10:00:00Z'
  });
  assert.deepEqual(verifyRow(tamperSig(row())), { valid: false, reason: 'row-sig' });

  var grant = makeGrant(hostKey, {
    visit_id: 'v1', host_network: HOST_ID, agent_id: AGENT_ID, home_network: GUEST_ID,
    kinds_writable: ['aboutYou'], kinds_readable: [], kinds_exportable: ['aboutYou'],
    issued_at: '2026-09-24T10:00:00Z', expires_at: '2026-09-24T12:00:00Z'
  });
  assert.equal(verifyGrant(grant, Date.parse('2026-09-24T10:30:00Z')).valid, true);
  assert.equal(verifyGrant(grant, Date.parse('2026-09-24T12:30:00Z')).reason, 'grant-expired');

  var bundle = makeBundle(hostKey, {
    host_passport: makeNetworkPassport(hostKey, HOST_ID, {
      name: 'lab', policy: { visitors: true, kinds_writable: ['aboutYou'], kinds_exportable: ['aboutYou'] },
      issued_at: '2026-09-24T10:00:00Z'
    }),
    agent_passport: pp,
    visit: {
      type: 'visit-record-v0', visit_id: 'v1', host_network: HOST_ID, agent_id: AGENT_ID,
      home_network: GUEST_ID, grant_id: grant.grant_id,
      started_at: '2026-09-24T10:00:00Z', ended_at: '2026-09-24T11:00:00Z'
    },
    rows: [row()],
    issued_at: '2026-09-24T11:00:00Z'
  });
  assert.equal(verifyBundle(bundle, { expectedHome: GUEST_ID }).valid, true);
  assert.equal(verifyBundle(Object.assign({}, bundle, { sig_by_host: ('0' === bundle.sig_by_host[0] ? '1' : '0') + bundle.sig_by_host.slice(1) }), { expectedHome: GUEST_ID }).reason, 'bundle-sig');

  // Import adjudication never silently supersedes: a live home row with the
  // same (kind, key) turns the arrival into a candidate.
  var adj = adjudicateImport(bundle, [{ id: 'h1', kind: 'aboutYou', key: 'dance.pickles-foxtrot', superseded_by: null, candidate: false }]);
  assert.equal(adj.outcomes[0].outcome, 'supersede-candidate');
  assert.equal(adj.outcomes[0].conflicts_with, 'h1');

  function row() {
    return makeRow(agentKey, AGENT_ID, {
      kind: 'aboutYou', key: 'dance.pickles-foxtrot',
      text: "Learned the Pickles Foxtrot at a friend's house.",
      source: 'visit', at: '2026-09-24T10:05:00Z', supersedes: null
    }, { agent: AGENT_ID, network: HOST_ID, home: GUEST_ID, visit: 'v1' });
  }
  function tamperSig(r) {
    return Object.assign({}, r, { sig: ('0' === r.sig[0] ? '1' : '0') + r.sig.slice(1) });
  }
});

test('federation store: owner-scoped rows + the pre-federation migration', () => {
  var db = freshDb();
  var store = createFederationStore(db);

  // A pre-federation table gains the fed_* columns at store creation and the
  // legacy row stays valid (NULL provenance reads as a plain home row).
  var cols = db.pragma('table_info(sm_embeddings)').map((c) => c.name);
  ['fed_agent', 'fed_network', 'fed_home', 'fed_visit', 'fed_sig'].forEach((c) => assert.ok(cols.includes(c), 'missing ' + c));

  var r = row();
  assert.equal(store.insertFedRow(1, r).inserted, true);
  assert.equal(store.insertFedRow(1, r).inserted, false); // content-addressed replay
  assert.equal(store.insertFedRow(2, r).inserted, true); // another owner, their OWN row

  var v = store.view(store.rowById(1, r.id));
  assert.equal(v.provenance.id, r.id);
  assert.equal(v.provenance.agent, AGENT_ID);
  assert.equal(store.view(store.rowById(2, r.id)).id !== store.view(store.rowById(1, r.id)).id, true);

  function row() {
    return makeRow(agentKey, AGENT_ID, {
      kind: 'aboutYou', key: 'k', text: 't', source: 'visit',
      at: '2026-09-24T10:05:00Z', supersedes: null
    }, { agent: AGENT_ID, network: HOST_ID, home: GUEST_ID, visit: 'v1' });
  }
});

test('federation routes: mount, default policy answers honestly', async () => {
  var db = freshDb();
  var app = express();
  app.use(express.json());
  app.use('/federation', createRoutes(fakeCore(db)));
  process.env.MYCELIUM_RATE_LIMIT = 'off';

  // HELLO with a forged passport is a 400 — the knock is checked.
  var pp = makeAgentPassport(guestKey, {
    agent_id: AGENT_ID, name: 'Q', species: 'qurio', home_network: GUEST_ID,
    capabilities: ['memory'], consent: { share_memories: true },
    issued_at: '2026-09-24T10:00:00Z'
  });
  var forged = Object.assign({}, pp, { name: 'Impostor' });
  var res = await fetchJSON(app, 'post', '/federation/hello', {
    network_passport: makeNetworkPassport(guestKey, GUEST_ID, {
      name: 'phone', policy: { visitors: false, kinds_writable: [], kinds_exportable: [] },
      issued_at: '2026-09-24T10:00:00Z'
    }),
    agent_passport: forged
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /agent_passport rejected/);

  // An honest knock is answered with THIS network's signed passport — saying
  // plainly that it hosts no visitors (the default policy).
  var knock = await fetchJSON(app, 'post', '/federation/hello', {
    network_passport: makeNetworkPassport(guestKey, GUEST_ID, {
      name: 'phone', policy: { visitors: false, kinds_writable: [], kinds_exportable: [] },
      issued_at: '2026-09-24T10:00:00Z'
    }),
    agent_passport: pp
  });
  assert.equal(knock.status, 200);
  assert.equal(knock.body.network_passport.policy.visitors, false);
  assert.equal(knock.body.network_passport.sig.length > 0, true);

  // cjson is canonical: key order never leaks into a signature.
  assert.equal(cjson({ b: 1, a: 2 }), cjson({ a: 2, b: 1 }));
});

// Minimal in-process HTTP against the express app (node:test has no supertest
// dependency here; the deep route gates in test/unit/ use supertest).
import http from 'http';
function fetchJSON(app, method, path, body) {
  return new Promise((resolve, reject) => {
    var server = app.listen(0, '127.0.0.1', () => {
      var port = server.address().port;
      var data = JSON.stringify(body);
      var req = http.request({
        host: '127.0.0.1', port: port, path: path, method: method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
      }, (res) => {
        var chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); }
          catch (e) { resolve({ status: res.statusCode, body: {} }); }
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(data);
    });
  });
}

// Review A nit 8: with semantic-memory absent (its table never created), the
// store must name the dependency instead of dying on a raw SQLite error that
// the per-plugin catch reduces to "federation silently absent".
test('store creation names the semantic-memory dependency when sm_embeddings is missing (review A nit 8)', () => {
  var db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')); // fed_* tables only
  assert.throws(
    function () { createFederationStore(db); },
    /requires the semantic-memory plugin/
  );
  db.close();
});

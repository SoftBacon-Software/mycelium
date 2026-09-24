// Federation v0 routes (spec/federation-v0/README.md §4).
//
// Two auth planes, by who is calling:
//   * the HOST side (this instance's operator/owner): existing platform auth —
//     admin for identity + policy, studio bearer for grant issuance and import
//     (those land in a person's memory scope);
//   * the VISITOR side (a foreign network's agent): the protocol's own
//     signatures — an agent-signed envelope over a grant the host issued.
//     A foreign network holds no platform credential and never should.
//
// Default policy: NO visitors (hello answers honestly, grant refuses to issue,
// visit writes 403) until an operator turns it on.

import crypto from 'crypto';
import { Router } from 'express';
import { rateLimited } from '../../lib/rate-limit.js';
import { keyFromSeed, idForKey, cjson } from './keys.js';
import {
  KINDS, verifyRow, verifyNetworkPassport, verifyAgentPassport, makeGrant,
  makeNetworkPassport, makeVisitRecord, makeBundle, verifyBundle,
  adjudicateImport, episodeRow, verifyEnvelope, verifyGrant
} from './protocol.js';
import createFederationStore from './store.js';

export default function (core) {
  var router = Router();
  var store = createFederationStore(core.db);
  var { checkAdmin, getStudioUser } = core.auth;
  var { apiError, asyncHandler } = core;

  var helloLimiter = rateLimited('federation/hello', { windowMs: 60000, max: 30 });
  var visitLimiter = rateLimited('federation/visit', { windowMs: 60000, max: 120 });
  // Review A nit 10: the bearer-authenticated surfaces carry limiters too —
  // a stolen/compromised studio bearer must not be able to hammer grant
  // issuance or import unthrottled. 30/min matches hello (an owner issues a
  // handful of grants by hand; imports are one-per-souvenir).
  var grantLimiter = rateLimited('federation/grant', { windowMs: 60000, max: 30 });
  var importLimiter = rateLimited('federation/import', { windowMs: 60000, max: 30 });

  var GRANT_TTL_DEFAULT_MINUTES = 120;
  var GRANT_TTL_MAX_MINUTES = 24 * 60;
  // Review A nit 9: a garbage FEDERATION_GRANT_TTL_MINUTES must not 400 every
  // grant with a confusing message — fall back to the default and say so once.
  // Values above the max clamp to it.
  var GRANT_TTL_MINUTES = GRANT_TTL_DEFAULT_MINUTES;
  (function () {
    var raw = process.env.FEDERATION_GRANT_TTL_MINUTES;
    if (raw === undefined || raw === '') return;
    var parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      GRANT_TTL_MINUTES = Math.min(parsed, GRANT_TTL_MAX_MINUTES);
    } else {
      console.warn('[federation] FEDERATION_GRANT_TTL_MINUTES=' + raw +
        ' is not a positive integer — using the default (' + GRANT_TTL_DEFAULT_MINUTES + ' minutes)');
    }
  })();

  // ---- identity + policy ----------------------------------------------------
  // The network key is generated on first use and persisted (seed, hex) unless
  // FEDERATION_NETWORK_SEED pins one — the deterministic path tests and a
  // deliberate re-key both use. Policy lives in fed_config; visitors defaults
  // OFF everywhere.

  function identity() {
    var seed = store.getConfig('network_seed');
    if (!seed) {
      seed = process.env.FEDERATION_NETWORK_SEED || crypto.randomBytes(32).toString('hex');
      store.setConfig('network_seed', seed);
    }
    var key = keyFromSeed(seed);
    var networkId = idForKey(key);
    if (store.getConfig('network_id') !== networkId) store.setConfig('network_id', networkId);
    return {
      key: key,
      networkId: networkId,
      name: store.getConfig('fed_name') || 'mycelium-network',
      policy: {
        visitors: store.getConfig('fed_visitors') === '1',
        kinds_writable: JSON.parse(store.getConfig('fed_kinds_writable') || '["aboutYou"]'),
        kinds_exportable: JSON.parse(store.getConfig('fed_kinds_exportable') || '[]')
      }
    };
  }

  function requireBearer(req, res) {
    var user = getStudioUser(req);
    if (!user || !user.userId) {
      apiError(res, 401, 'a studio bearer token is required — this surface manages a person\'s memory scope');
      return null;
    }
    return user;
  }

  function kindsOr400(res, kinds) {
    if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every(function (k) { return KINDS.indexOf(k) !== -1; })) {
      apiError(res, 400, 'kinds must be a non-empty array of: ' + KINDS.join(', '));
      return false;
    }
    return true;
  }

  // GET /network — identity + policy (admin)
  router.get('/network', function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = identity();
    res.json({
      ok: true,
      network_id: id.networkId,
      name: id.name,
      policy: id.policy,
      visits_hosted: core.db.prepare('SELECT COUNT(*) AS n FROM fed_visits').get().n,
      // DISTINCT: fed_imports is one row per (bundle, owner) — the count is
      // bundles, not imports (review A minor 6).
      bundles_imported: core.db.prepare('SELECT COUNT(DISTINCT bundle_id) AS n FROM fed_imports').get().n
    });
  });

  // POST /network — set name/policy, or pin the identity seed (admin).
  // Changing the seed re-keys the network: grants already issued under the old
  // key stop verifying. Deliberate act, admin-only, logged in the response.
  router.post('/network', function (req, res) {
    if (!checkAdmin(req, res)) return;
    var body = req.body || {};
    if (body.seed_hex !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(String(body.seed_hex))) {
        return apiError(res, 400, 'seed_hex must be 64 hex chars (32 bytes)');
      }
      store.setConfig('network_seed', String(body.seed_hex));
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.length || body.name.length > 64) {
        return apiError(res, 400, 'name must be 1-64 chars');
      }
      store.setConfig('fed_name', body.name);
    }
    if (body.visitors !== undefined) {
      store.setConfig('fed_visitors', body.visitors ? '1' : '0');
    }
    if (body.kinds_writable !== undefined) {
      if (!kindsOr400(res, body.kinds_writable)) return;
      store.setConfig('fed_kinds_writable', JSON.stringify(body.kinds_writable));
    }
    if (body.kinds_exportable !== undefined) {
      if (!kindsOr400(res, body.kinds_exportable)) return;
      store.setConfig('fed_kinds_exportable', JSON.stringify(body.kinds_exportable));
    }
    var id = identity();
    res.json({ ok: true, network_id: id.networkId, name: id.name, policy: id.policy });
  });

  // ---- HELLO — the knock ------------------------------------------------------
  // Both passports are verified before anything is stored; nothing else
  // crosses. The host answers with its own signed network passport — policy
  // included — so a visitor learns "no visitors here" before asking.

  router.post('/hello', helloLimiter, function (req, res) {
    var body = req.body || {};
    var net = verifyNetworkPassport(body.network_passport);
    if (!net.valid) return apiError(res, 400, 'network_passport rejected: ' + net.reason);
    var agent = verifyAgentPassport(body.agent_passport);
    if (!agent.valid) return apiError(res, 400, 'agent_passport rejected: ' + agent.reason);
    if (body.agent_passport.home_network !== body.network_passport.network_id) {
      return apiError(res, 400, 'agent_passport.home_network does not match the network_passport it arrived with');
    }
    store.upsertPassport('network', body.network_passport.network_id, null, cjson(body.network_passport));
    store.upsertPassport('agent', body.agent_passport.agent_id, body.agent_passport.home_network, cjson(body.agent_passport));
    var id = identity();
    res.json({
      ok: true,
      network_passport: makeNetworkPassport(id.key, id.networkId, {
        name: id.name, policy: id.policy, issued_at: new Date().toISOString()
      })
    });
  });

  // ---- GRANT — the host owner consents ---------------------------------------
  // Studio bearer only: the visit lands in the TOKEN OWNER's memory scope, so
  // the owner issues the grant. Default policy (visitors off) refuses here.

  router.post('/grant', grantLimiter, function (req, res) {
    var user = requireBearer(req, res);
    if (!user) return;
    var id = identity();
    if (!id.policy.visitors) {
      return apiError(res, 403, 'this network hosts no visitors — an operator must turn policy.visitors on first (POST /federation/network)');
    }
    var body = req.body || {};
    var agent = verifyAgentPassport(body.agent_passport);
    if (!agent.valid) return apiError(res, 400, 'agent_passport rejected: ' + agent.reason);
    if (agent.home_network === id.networkId) {
      return apiError(res, 400, 'the visitor is one of this network\'s own agents — a visit is to another network');
    }

    var kindsWritable = body.kinds_writable || id.policy.kinds_writable;
    if (!kindsOr400(res, kindsWritable)) return;
    var kindsReadable = body.kinds_readable || [];
    if (!Array.isArray(kindsReadable)) return apiError(res, 400, 'kinds_readable must be an array');
    var kindsExportable = body.kinds_exportable !== undefined ? body.kinds_exportable : id.policy.kinds_exportable;
    if (!Array.isArray(kindsExportable) || !kindsExportable.every(function (k) { return KINDS.indexOf(k) !== -1; })) {
      return apiError(res, 400, 'kinds_exportable must be an array of: ' + KINDS.join(', '));
    }

    // Review A nit 9: ttl_minutes 0 (or garbage) is a 400, not a silent
    // fall-back to the default — `||` swallowed 0; only an absent field means
    // "use the configured default".
    var rawTtl = body.ttl_minutes;
    var ttl = rawTtl === undefined || rawTtl === null ? GRANT_TTL_MINUTES : parseInt(rawTtl, 10);
    if (isNaN(ttl) || ttl < 1 || ttl > GRANT_TTL_MAX_MINUTES) {
      return apiError(res, 400, 'ttl_minutes must be 1..' + GRANT_TTL_MAX_MINUTES);
    }

    var issuedAt = new Date();
    var expiresAt = new Date(issuedAt.getTime() + ttl * 60000);
    var grant = makeGrant(id.key, {
      visit_id: 'v' + crypto.randomBytes(12).toString('hex'),
      host_network: id.networkId,
      agent_id: agent.agent_id,
      home_network: agent.home_network,
      kinds_writable: kindsWritable,
      kinds_readable: kindsReadable,
      kinds_exportable: kindsExportable,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString()
    });
    store.insertGrant(Object.assign({ host_owner: user.userId }, grant));
    store.upsertPassport('agent', body.agent_passport.agent_id, body.agent_passport.home_network, cjson(body.agent_passport));
    res.status(201).json({ ok: true, grant: grant, visit_id: grant.visit_id });
  });

  // ---- VISIT — the visitor writes ---------------------------------------------
  // Envelope-signed by the agent; every check is a verdict, not an exception:
  //   404 unknown visit · 401 bad envelope · 403 policy/kind/ended ·
  //   410 expired grant · 400 row rejected

  function grantForVisit(visitId) {
    var visit = store.visit(visitId);
    if (!visit) return { err: 404 };
    var row = store.grantByVisit(visitId);
    if (!row) return { err: 404 };
    // Re-key revocation (review A blocker 2). A grant's signature verifies
    // against the host_network key STAMPED IN IT — the old key — so signature
    // verification alone can never notice a re-key. The promise four doc
    // sites make (README env table, .env.example, the /network route, here)
    // is enforced by this check: the CURRENT identity must be the one that
    // issued the grant. Without it, a mid-visit re-key kept accepting writes
    // and then bricked the souvenir (a bundle signed by the new key over rows
    // stamped with the old network id fails every border check).
    if (row.host_network !== identity().networkId) return { err: 'rekeyed' };
    var grant = {
      type: 'grant-v0',
      grant_id: row.grant_id,
      visit_id: row.visit_id,
      host_network: row.host_network,
      agent_id: row.agent_id,
      home_network: row.home_network,
      kinds_writable: row.kinds_writable,
      kinds_readable: row.kinds_readable,
      kinds_exportable: row.kinds_exportable,
      issued_at: row.issued_at,
      expires_at: row.expires_at,
      sig_by_host: row.sig_by_host
    };
    return { visit: visit, grant: grant, row: row };
  }

  // The door answer when grantForVisit refuses a known visit.
  function refuseVisit(res, g) {
    if (g.err === 'rekeyed') {
      return apiError(res, 403, 'grant rejected: the network was re-keyed after this grant was issued — every grant from the previous network identity is revoked');
    }
    return apiError(res, 404, 'no such visit');
  }

  function checkEnvelope(req, res, expectedAgentId) {
    var env = req.body;
    var v = verifyEnvelope(env, Date.now(), function (nonce) {
      return !store.consumeNonce(nonce); // consumeNonce true = fresh
    });
    if (!v.valid) {
      apiError(res, 401, 'envelope rejected: ' + v.reason);
      return null;
    }
    if (expectedAgentId && env.agent_id !== expectedAgentId) {
      apiError(res, 401, 'envelope is signed by ' + env.agent_id + ' but the visit belongs to ' + expectedAgentId);
      return null;
    }
    return env;
  }

  router.post('/visit/:visitId/memory', visitLimiter, function (req, res) {
    var g = grantForVisit(req.params.visitId);
    if (g.err) return refuseVisit(res, g);
    var env = checkEnvelope(req, res, g.grant.agent_id);
    if (!env) return;

    if (g.row.status === 'revoked') {
      return apiError(res, 403, 'this visit was revoked by the host operator (POST /federation/visit/:id/end)');
    }
    if (g.row.status !== 'active') return apiError(res, 403, 'this visit has ended');
    var gv = verifyGrant(g.grant, Date.now());
    if (!gv.valid) {
      var code = gv.reason === 'grant-expired' ? 410 : 403;
      return apiError(res, code, 'grant rejected: ' + gv.reason);
    }

    var row = env.payload && env.payload.row;
    if (!row) return apiError(res, 400, 'payload.row is required');
    var vr = verifyRow(row);
    if (!vr.valid) return apiError(res, 400, 'row rejected: ' + vr.reason);
    if (row.kind && g.grant.kinds_writable.indexOf(row.kind) === -1) {
      return apiError(res, 403, "grant does not allow writing kind '" + row.kind + "' (allowed: " + g.grant.kinds_writable.join(', ') + ')');
    }
    if (row.text.length > 2000) return apiError(res, 400, 'text exceeds 2000 chars');
    if (row.source.length > 64) return apiError(res, 400, 'source exceeds 64 chars');
    if (row.key && row.key.length > 128) return apiError(res, 400, 'key exceeds 128 chars');
    if (isNaN(Date.parse(row.at))) return apiError(res, 400, 'at must be a parseable timestamp');
    if (row.agent !== g.grant.agent_id || row.home !== g.grant.home_network ||
        row.network !== g.grant.host_network || row.visit !== g.grant.visit_id) {
      return apiError(res, 400, 'row provenance does not match the grant (agent/home/network/visit)');
    }

    var written = store.insertFedRow(g.visit.host_owner, row);
    res.status(written.inserted ? 201 : 200).json({
      ok: true,
      replayed: !written.inserted,
      row: store.view(written.row)
    });
  });

  // ---- SOUVENIR — the visitor leaves with what the export policy allows ------
  // Idempotent by construction: issued_at is pinned to the visit's ended_at,
  // so a re-request after a lost bundle rebuilds the SAME signed bundle from
  // whatever the host still retains.

  router.post('/visit/:visitId/souvenir', visitLimiter, function (req, res) {
    var g = grantForVisit(req.params.visitId);
    if (g.err) return refuseVisit(res, g);
    var env = checkEnvelope(req, res, g.grant.agent_id);
    if (!env) return;

    // The kill switch outranks the grant clock: a revoked visit refuses the
    // souvenir even inside the grant's validity window (review A minor 3).
    if (g.row.status === 'revoked') {
      return apiError(res, 403, 'this visit was revoked by the host operator — no souvenir can leave');
    }

    var gv = verifyGrant(g.grant, Date.now());
    if (!gv.valid) {
      var code = gv.reason === 'grant-expired' ? 410 : 403;
      return apiError(res, code, 'grant rejected: ' + gv.reason);
    }

    var id = identity();
    var endedAt = g.visit.ended_at;
    if (!endedAt) {
      store.endVisit(g.grant.visit_id);
      endedAt = store.visit(g.grant.visit_id).ended_at;
    }

    var exportable = g.grant.kinds_exportable;
    var rows = store.rowsByVisit(g.grant.visit_id)
      .map(function (r) { return store.protocolRow(r); })
      .filter(function (r) { return exportable.indexOf(r.kind) !== -1; });

    var agentPassport = JSON.parse(store.getPassport('agent', g.grant.agent_id).passport_cjson);
    var bundle = makeBundle(id.key, {
      host_passport: makeNetworkPassport(id.key, id.networkId, {
        name: id.name, policy: id.policy, issued_at: endedAt
      }),
      agent_passport: agentPassport,
      visit: makeVisitRecord({
        visit_id: g.grant.visit_id,
        host_network: id.networkId,
        agent_id: g.grant.agent_id,
        home_network: g.grant.home_network,
        grant_id: g.grant.grant_id,
        started_at: g.visit.started_at,
        ended_at: endedAt
      }),
      rows: rows,
      issued_at: endedAt
    });
    res.json({ ok: true, bundle: bundle });
  });

  // ---- IMPORT — the home side --------------------------------------------------
  // Studio bearer (rows land in the owner's scope). The home network must be
  // able to vouch for the agent's home: either the agent is LOCAL (home is
  // this network — the your-agent-came-home case) or the home network was met
  // at HELLO and its passport is on file. A self-asserted home alone proves
  // nothing — anyone can generate a keypair.

  router.post('/import', importLimiter, asyncHandler(async function (req, res) {
    var user = requireBearer(req, res);
    if (!user) return;
    var id = identity();
    var bundle = req.body && req.body.bundle;
    if (!bundle) return apiError(res, 400, 'bundle is required');

    var expectedHome = null;
    var agentHome = bundle.agent_passport && bundle.agent_passport.home_network;
    if (agentHome === id.networkId) {
      expectedHome = id.networkId; // local agent coming home
    } else if (agentHome && store.getPassport('network', agentHome)) {
      expectedHome = agentHome; // met at HELLO — the id on file is the vouching
    }
    if (!expectedHome) {
      return apiError(res, 400, 'the agent\'s home network is neither this network nor a network met at hello — cannot vouch for it');
    }

    var bv = verifyBundle(bundle, { expectedHome: expectedHome });
    if (!bv.valid) return apiError(res, 400, 'bundle rejected: ' + bv.reason);

    // Bundle-level replay bookkeeping is PER OWNER (review A minor 6): the
    // fed_imports PK is (bundle_id, owner), so the fast path fires for every
    // owner who already imported this bundle — not just the first one.
    var prior = store.getImport(bundle.bundle_id, user.userId);
    if (prior) {
      var priorEpisode = store.rowById(user.userId, episodeRow(bundle).id);
      // §2.7: a replay answers 'replayed' PER ROW — the original outcomes are
      // history, not this answer. Nothing is written.
      return res.json({
        ok: true,
        replayed: true,
        outcomes: prior.outcomes.map(function (o) { return { row_id: o.row_id, outcome: 'replayed' }; }),
        episode: priorEpisode ? store.view(priorEpisode) : null
      });
    }

    // Collision set: this owner's rows as adjudication sees them — id is the
    // PROTOCOL id (content-addressed), so a federation replay matches, while
    // a native row never collides on id (it can still clash on kind+key).
    var homeRows = store.liveHomeRows(user.userId).map(function (r) {
      var meta = {};
      try { meta = JSON.parse(r.metadata || '{}'); } catch (e) { /* unparseable metadata is not a collision */ }
      return { id: meta.fed_id || r.source_id, kind: meta.kind || null, key: meta.key || null, superseded_by: null, candidate: !!meta.candidate };
    });

    var adj = adjudicateImport(bundle, homeRows);
    for (var i = 0; i < bundle.rows.length; i++) {
      var outcome = adj.outcomes[i];
      if (outcome.outcome === 'replayed') continue;
      store.insertFedRow(user.userId, bundle.rows[i], { candidate: outcome.outcome === 'supersede-candidate' });
    }
    var episodeStore = store.insertFedRow(user.userId, adj.episode);
    store.recordImport(bundle.bundle_id, user.userId, adj.outcomes);
    res.status(201).json({
      ok: true,
      replayed: false,
      outcomes: adj.outcomes,
      episode: store.view(episodeStore.row)
    });
  }));

  // ---- operator visibility ------------------------------------------------------

  // POST /visit/:visitId/end — the operator's kill switch for an in-flight
  // visit (review A minor 3). Toggling policy.visitors off stops NEW grants
  // only; this ends a live one: further writes AND souvenirs 403. The
  // alternative levers are the grant's TTL (up to 24 h) and a re-key.
  router.post('/visit/:visitId/end', function (req, res) {
    if (!checkAdmin(req, res)) return;
    if (!store.visit(req.params.visitId)) return apiError(res, 404, 'no such visit');
    var visit = store.revokeVisit(req.params.visitId);
    res.json({ ok: true, visit: visit, status: 'revoked' });
  });

  router.get('/visits', function (req, res) {
    if (!checkAdmin(req, res)) return;
    var rows = core.db.prepare(
      'SELECT v.*, g.status AS grant_status FROM fed_visits v ' +
      'LEFT JOIN fed_grants g ON g.visit_id = v.visit_id ' +
      'ORDER BY v.started_at DESC LIMIT 200'
    ).all();
    res.json({ ok: true, visits: rows, count: rows.length });
  });

  return router;
}

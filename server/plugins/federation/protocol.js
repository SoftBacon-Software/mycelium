// Federation v0 — the pure protocol layer (spec/federation-v0 §2).
//
// No DB, no HTTP, no clock reads: every function that needs time takes `now`
// and every function that needs state takes the state. This is the reference
// implementation the committed vectors are generated from (spec/federation-v0/
// vectors/generate.mjs) and the verifier live traffic runs through — one
// definition, so the vectors can never drift from the code that enforces them.
//
// Verdicts are { valid, reason } — never thrown — because at a network border
// a bad message is a verdict to report, not an exception to crash on.

import { cjson, sha256hex, sign, verify } from './keys.js';

export var KINDS = ['aboutYou', 'aboutMe', 'howWeTalk'];

function fail(reason) { return { valid: false, reason: reason }; }
function ok(extra) { return Object.assign({ valid: true }, extra || {}); }

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isStrArray(v) { return Array.isArray(v) && v.every(isStr); }

// ---------------------------------------------------------------------------
// §2.3 The memory row

// Normalize content fields to THE canonical shape: key/supersedes are null
// when unset (never omitted), text/kind/source/at strings.
export function rowContent(fields) {
  return {
    kind: fields.kind,
    key: fields.key || null,
    text: fields.text,
    source: fields.source,
    at: fields.at,
    supersedes: fields.supersedes || null
  };
}

// Content-addressed id: sha256 of the canonical JSON of the content fields.
// The same memory arriving twice (outbox replay, a souvenir imported twice)
// hashes to one row.
export function rowId(fields) {
  return sha256hex(rowContent(fields));
}

// Build a signed federated row. `prov` = { agent, network, home, visit }.
export function makeRow(agentKey, agentId, fields, prov) {
  var content = rowContent(fields);
  var row = Object.assign({}, content, {
    id: sha256hex(content),
    agent: prov.agent,
    network: prov.network,
    home: prov.home,
    visit: prov.visit === undefined ? null : prov.visit
  });
  row.sig = sign(agentKey, row);
  return row;
}

// Verify one row in isolation: the id must match the content (tamper check)
// and the agent's signature must cover the full row minus sig.
export function verifyRow(row) {
  if (!row || typeof row !== 'object') return fail('row-shape');
  for (var f of ['kind', 'text', 'source', 'at', 'id', 'agent', 'network', 'home']) {
    if (!isStr(row[f])) return fail('row-field:' + f);
  }
  if (KINDS.indexOf(row.kind) === -1) return fail('row-kind');
  if (row.visit !== null && !isStr(row.visit)) return fail('row-field:visit');
  var content = rowContent(row);
  if (sha256hex(content) !== row.id) return fail('row-id');
  if (!verify(row.agent, row.sig, Object.assign({}, content, {
    id: row.id, agent: row.agent, network: row.network, home: row.home, visit: row.visit === undefined ? null : row.visit
  }))) return fail('row-sig');
  return ok({ id: row.id });
}

// ---------------------------------------------------------------------------
// §2.1 / §2.2 Passports

export function makeNetworkPassport(netKey, netId, fields) {
  var pp = {
    type: 'network-passport-v0',
    network_id: netId,
    name: fields.name,
    policy: {
      visitors: !!fields.policy.visitors,
      kinds_writable: fields.policy.kinds_writable || [],
      kinds_exportable: fields.policy.kinds_exportable || []
    },
    issued_at: fields.issued_at
  };
  pp.sig = sign(netKey, pp);
  return pp;
}

export function verifyNetworkPassport(pp) {
  if (!pp || pp.type !== 'network-passport-v0') return fail('passport-type');
  if (!isStr(pp.network_id) || !isStr(pp.name) || !isStr(pp.issued_at)) return fail('passport-shape');
  if (!pp.policy || typeof pp.policy !== 'object') return fail('passport-policy');
  var body = Object.assign({}, pp, { sig: undefined });
  delete body.sig;
  if (!verify(pp.network_id, pp.sig, body)) return fail('passport-sig');
  return ok({ network_id: pp.network_id });
}

export function makeAgentPassport(homeKey, fields) {
  var pp = {
    type: 'agent-passport-v0',
    agent_id: fields.agent_id,
    name: fields.name,
    species: fields.species,
    home_network: fields.home_network,
    capabilities: fields.capabilities || [],
    consent: fields.consent || {},
    issued_at: fields.issued_at
  };
  pp.sig_by_home = sign(homeKey, pp);
  return pp;
}

// The home network's signature is verified against `home_network` (the id IS
// the public key). `expectedHome` optionally pins it to a known network —
// the importer's own id in the your-agent-came-home case.
export function verifyAgentPassport(pp, expectedHome) {
  if (!pp || pp.type !== 'agent-passport-v0') return fail('passport-type');
  if (!isStr(pp.agent_id) || !isStr(pp.name) || !isStr(pp.species) ||
      !isStr(pp.home_network) || !isStr(pp.issued_at)) return fail('passport-shape');
  if (!isStrArray(pp.capabilities)) return fail('passport-capabilities');
  if (!pp.consent || typeof pp.consent !== 'object') return fail('passport-consent');
  if (expectedHome && pp.home_network !== expectedHome) return fail('passport-home-mismatch');
  var body = Object.assign({}, pp, { sig_by_home: undefined });
  delete body.sig_by_home;
  if (!verify(pp.home_network, pp.sig_by_home, body)) return fail('passport-sig');
  return ok({ agent_id: pp.agent_id, home_network: pp.home_network });
}

// ---------------------------------------------------------------------------
// §2.4 Grant

export function makeGrant(hostKey, fields) {
  var grant = {
    type: 'grant-v0',
    visit_id: fields.visit_id,
    host_network: fields.host_network,
    agent_id: fields.agent_id,
    home_network: fields.home_network,
    kinds_writable: fields.kinds_writable,
    kinds_readable: fields.kinds_readable || [],
    kinds_exportable: fields.kinds_exportable,
    issued_at: fields.issued_at,
    expires_at: fields.expires_at
  };
  grant.grant_id = sha256hex(grant);
  grant.sig_by_host = sign(hostKey, grant);
  return grant;
}

// A grant is valid at `now` iff the host's signature verifies and
// issued_at <= now < expires_at. `now` is epoch ms.
export function verifyGrant(grant, now) {
  if (!grant || grant.type !== 'grant-v0') return fail('grant-type');
  if (!isStr(grant.visit_id) || !isStr(grant.host_network) || !isStr(grant.agent_id) ||
      !isStr(grant.home_network) || !isStr(grant.issued_at) || !isStr(grant.expires_at)) return fail('grant-shape');
  if (!isStrArray(grant.kinds_writable) || !isStrArray(grant.kinds_readable) ||
      !isStrArray(grant.kinds_exportable)) return fail('grant-kinds');
  var body = Object.assign({}, grant, { sig_by_host: undefined });
  delete body.sig_by_host;
  if (!verify(grant.host_network, grant.sig_by_host, body)) return fail('grant-sig');
  var issued = Date.parse(grant.issued_at);
  var expires = Date.parse(grant.expires_at);
  if (isNaN(issued) || isNaN(expires)) return fail('grant-times');
  if (now < issued) return fail('grant-not-yet-valid');
  if (now >= expires) return fail('grant-expired');
  return ok({ grant_id: grant.grant_id, visit_id: grant.visit_id });
}

// ---------------------------------------------------------------------------
// §2.6 Souvenir bundle

export function makeVisitRecord(fields) {
  return {
    type: 'visit-record-v0',
    visit_id: fields.visit_id,
    host_network: fields.host_network,
    agent_id: fields.agent_id,
    home_network: fields.home_network,
    grant_id: fields.grant_id,
    started_at: fields.started_at,
    ended_at: fields.ended_at
  };
}

export function makeBundle(hostKey, fields) {
  var bundle = {
    type: 'souvenir-v0',
    host_passport: fields.host_passport,
    agent_passport: fields.agent_passport,
    visit: fields.visit,
    rows: fields.rows,
    issued_at: fields.issued_at
  };
  bundle.bundle_id = sha256hex(bundle);
  bundle.sig_by_host = sign(hostKey, bundle);
  return bundle;
}

// Full border check (§2.7 steps 1–4). `opts.expectedHome` pins the agent's
// home network when the importer knows it (its own id in the coming-home
// case); omit it to accept any home whose signature verifies.
export function verifyBundle(bundle, opts) {
  opts = opts || {};
  if (!bundle || bundle.type !== 'souvenir-v0') return fail('bundle-type');
  if (!Array.isArray(bundle.rows)) return fail('bundle-rows');
  var host = verifyNetworkPassport(bundle.host_passport);
  if (!host.valid) return fail('bundle-host-passport:' + host.reason);
  var agent = verifyAgentPassport(bundle.agent_passport, opts.expectedHome);
  if (!agent.valid) return fail('bundle-agent-passport:' + agent.reason);

  var visit = bundle.visit;
  if (!visit || visit.type !== 'visit-record-v0') return fail('bundle-visit');
  if (visit.host_network !== bundle.host_passport.network_id) return fail('visit-host-mismatch');
  if (visit.agent_id !== bundle.agent_passport.agent_id) return fail('visit-agent-mismatch');
  if (visit.home_network !== bundle.agent_passport.home_network) return fail('visit-home-mismatch');

  var body = Object.assign({}, bundle, { sig_by_host: undefined });
  delete body.sig_by_host;
  if (!verify(bundle.host_passport.network_id, bundle.sig_by_host, body)) return fail('bundle-sig');

  for (var row of bundle.rows) {
    var vr = verifyRow(row);
    if (!vr.valid) return fail('bundle-row:' + vr.reason);
    if (row.agent !== bundle.agent_passport.agent_id) return fail('bundle-row-agent');
    if (row.network !== bundle.host_passport.network_id) return fail('bundle-row-network');
    if (row.home !== bundle.agent_passport.home_network) return fail('bundle-row-home');
    if (row.visit !== visit.visit_id) return fail('bundle-row-visit');
  }
  return ok({ bundle_id: bundle.bundle_id, host_network: bundle.host_passport.network_id, rows: bundle.rows.length });
}

// The one episode an import writes (§2.7 step 5) — deterministic from the
// bundle so both implementations produce the same sentence.
export function episodeText(bundle) {
  var day = String(bundle.visit.ended_at).slice(0, 10);
  return 'I visited ' + bundle.host_passport.name + ' on ' + day +
    ' and learned ' + bundle.rows.length + ' memories.';
}

export function episodeRow(bundle) {
  return {
    kind: 'aboutMe',
    key: null,
    text: episodeText(bundle),
    source: 'visit',
    at: bundle.visit.ended_at,
    supersedes: null,
    id: rowId({ kind: 'aboutMe', key: null, text: episodeText(bundle), source: 'visit', at: bundle.visit.ended_at, supersedes: null }),
    agent: bundle.visit.agent_id,
    network: bundle.visit.home_network, // made at home — this row never crosses a border
    home: bundle.visit.home_network,
    visit: bundle.visit.visit_id,
    sig: null
  };
}

// ---------------------------------------------------------------------------
// §2.7 Import adjudication — pure: given a VERIFIED bundle and the live home
// rows (shape {id, kind, key, superseded_by, candidate}), decide per-row
// outcomes without touching a store.

export function adjudicateImport(bundle, homeRows) {
  var live = (homeRows || []).filter(function (r) { return !r.superseded_by && !r.candidate; });
  var byId = {};
  for (var r of homeRows || []) byId[r.id] = r;
  var outcomes = [];
  for (var row of bundle.rows) {
    if (byId[row.id]) {
      // Content addressing: the second arrival of the same memory is a no-op.
      // The first arrival's provenance wins.
      outcomes.push({ row_id: row.id, outcome: 'replayed' });
      continue;
    }
    var clash = null;
    if (row.key) {
      for (var h of live) {
        if (!h.candidate && h.kind === row.kind && h.key === row.key) { clash = h; break; }
      }
    }
    if (clash) {
      // The honesty law: an imported row never supersedes a home row silently.
      outcomes.push({ row_id: row.id, outcome: 'supersede-candidate', conflicts_with: clash.id });
    } else {
      outcomes.push({ row_id: row.id, outcome: 'imported' });
    }
  }
  return { outcomes: outcomes, episode: episodeRow(bundle) };
}

// ---------------------------------------------------------------------------
// §3 Transport envelope (HTTPS shape; a phone-to-phone transport may frame its
// own — the §2 signatures are the protocol, this is replay hardening).

export function makeEnvelope(agentKey, agentId, payload, tsSec, nonce) {
  var env = {
    agent_id: agentId,
    ts: tsSec,
    nonce: nonce,
    payload: payload
  };
  env.sig = sign(agentKey, env);
  return env;
}

export function verifyEnvelope(env, nowMs, nonceSeen) {
  if (!env || typeof env !== 'object') return fail('envelope-shape');
  if (!isStr(env.agent_id) || !isStr(env.nonce) || typeof env.ts !== 'number') return fail('envelope-shape');
  var body = Object.assign({}, env, { sig: undefined });
  delete body.sig;
  if (!verify(env.agent_id, env.sig, body)) return fail('envelope-sig');
  if (Math.abs(nowMs - env.ts * 1000) > 300000) return fail('envelope-stale');
  if (nonceSeen(env.nonce)) return fail('envelope-replay');
  return ok({ agent_id: env.agent_id });
}

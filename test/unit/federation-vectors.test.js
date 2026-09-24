// Federation v0 vectors (spec/federation-v0/vectors/) — the definition of
// "powered by Mycelium": a message one implementation emits must pass the
// other's verifier. This gate runs EVERY committed vector through the server's
// protocol layer; MyceliumKit (Swift) runs the same files in its own CI.
// One canonical set, never two — a missing case is added to the generator and
// both sides adopt it.
//
// The vectors are generated from protocol.js itself
// (spec/federation-v0/vectors/generate.mjs), so this gate's job is to pin the
// COMMITTED bytes against the LIVE code: if either drifts (an edit to the
// protocol, a regenerated vector not committed, a hand-edited vector), this
// fails. Determinism is total — fixed seeds, fixed clocks, RFC 8032 signing.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { keyFromSeed, verify, cjson } from '../../server/plugins/federation/keys.js';
import {
  rowId, makeRow, makeNetworkPassport, makeAgentPassport, makeGrant,
  makeVisitRecord, makeBundle, verifyRow, verifyGrant, verifyBundle,
  adjudicateImport
} from '../../server/plugins/federation/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, '..', '..', 'spec', 'federation-v0', 'vectors');

function load(name) {
  return JSON.parse(readFileSync(join(VECTORS, name), 'utf8'));
}

// Every vector file carries the same fixed key material; keys are rebuilt
// from seeds exactly as a second implementation would.
function keysFor(vec) {
  return {
    host: keyFromSeed(vec.keys.host_network.seed_hex),
    guest: keyFromSeed(vec.keys.guest_network.seed_hex),
    agent: keyFromSeed(vec.keys.agent_a.seed_hex)
  };
}

describe('federation v0 vectors', () => {

  it('01 — canonical row: cjson form + content-addressed id', () => {
    const vec = load('01-canonical-row.json');
    const k = keysFor(vec);
    expect(k.host && k.guest && k.agent).toBeTruthy();
    for (const c of vec.cases) {
      expect(cjson(c.content)).toBe(c.expected.cjson);
      expect(rowId(c.content)).toBe(c.expected.id);
    }
  });

  it('02 — agent passport + sig_by_home', () => {
    const vec = load('02-passport.json');
    const k = keysFor(vec);
    const pp = makeAgentPassport(k.guest, vec.input.fields);
    expect(pp).toEqual(vec.expected.passport);
    // and the signature verifies against the home network id, not just equals
    const body = { ...pp };
    delete body.sig_by_home;
    expect(verify(pp.home_network, pp.sig_by_home, body)).toBe(true);
  });

  it('03 — grant: signature + validity window (valid, expired)', () => {
    const vec = load('03-grant.json');
    const k = keysFor(vec);
    const grant = makeGrant(k.host, vec.input.fields);
    expect(grant).toEqual(vec.expected.grant);
    for (const check of vec.expected.verify) {
      expect(verifyGrant(grant, check.now_ms)).toEqual(check.result);
    }
  });

  it('04 — souvenir bundle: passports, visit record, rows, host signature', () => {
    const vec = load('04-souvenir-bundle.json');
    const k = keysFor(vec);
    const hostId = vec.keys.host_network.network_id;
    const guestId = vec.keys.guest_network.network_id;
    const agentId = vec.keys.agent_a.agent_id;

    const hostPassport = makeNetworkPassport(k.host, hostId, {
      name: vec.input.host_passport_fields.name,
      policy: vec.input.host_passport_fields.policy,
      issued_at: vec.input.host_passport_fields.issued_at
    });
    expect(hostPassport).toEqual(vec.expected.bundle.host_passport);

    const agentPassport = makeAgentPassport(k.guest, vec.input.agent_passport_fields);
    expect(agentPassport).toEqual(vec.expected.bundle.agent_passport);

    const row = makeRow(k.agent, agentId, vec.input.row, {
      agent: agentId, network: hostId, home: guestId, visit: vec.input.visit_fields.visit_id
    });
    expect(row).toEqual(vec.expected.bundle.rows[0]);

    const visit = makeVisitRecord(vec.input.visit_fields);
    expect(visit).toEqual(vec.expected.bundle.visit);

    const bundle = makeBundle(k.host, {
      host_passport: hostPassport,
      agent_passport: agentPassport,
      visit: visit,
      rows: [row],
      issued_at: vec.input.issued_at
    });
    expect(bundle).toEqual(vec.expected.bundle);
  });

  it('05 — import outcomes: ok / replay / supersede-candidate / tampered / expired', () => {
    const vec = load('05-import-outcomes.json');
    const guestId = vec.keys.guest_network.network_id;
    for (const c of vec.cases) {
      if (c.name === 'verify-row-tampered') {
        expect(verifyRow(c.input.row)).toEqual(c.expected);
      } else if (c.name === 'verify-bundle-tampered') {
        expect(verifyBundle(c.input.bundle, { expectedHome: guestId })).toEqual(c.expected);
      } else if (c.name.startsWith('import-')) {
        const v = verifyBundle(c.input.bundle, { expectedHome: guestId });
        expect(v.valid).toBe(true);
        const adj = adjudicateImport(c.input.bundle, c.input.home_rows);
        expect(adj).toEqual(c.expected);
      } else {
        throw new Error('unknown vector case: ' + c.name);
      }
    }
  });

  it('the committed vectors are the generated ones (no hand edits, no stale regeneration)', () => {
    // The generator is deterministic; running it must be a no-op on the
    // committed bytes. execFileSync — fixed argv, no shell.
    const files = ['01-canonical-row.json', '02-passport.json', '03-grant.json', '04-souvenir-bundle.json', '05-import-outcomes.json'];
    const before = files.map((f) => readFileSync(join(VECTORS, f), 'utf8'));
    execFileSync('node', ['spec/federation-v0/vectors/generate.mjs'], { cwd: join(HERE, '..', '..'), stdio: 'pipe' });
    const after = files.map((f) => readFileSync(join(VECTORS, f), 'utf8'));
    expect(after).toEqual(before);
  });
});

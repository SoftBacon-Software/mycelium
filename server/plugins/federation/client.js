// Federation v0 — the VISITOR side (spec/federation-v0 §3).
//
// This is the library a network uses to visit another network over HTTPS:
// build the knock, sign the envelopes, carry the souvenir home. It is the
// shape MyceliumKit (Swift) mirrors on the phone — same five messages, same
// signatures — and what the round-trip test drives against a live server.
//
// Transport-agnostic: `transport` is { post(path, body, headers) } returning
// { status, body } — supertest apps, fetch wrappers, or a Multipeer framing
// all plug in. Nothing here touches a database: the visitor's keys and
// passport are the caller's (a phone keeps them in the Keychain).

import crypto from 'crypto';
import { keyFromSeed, idForKey } from './keys.js';
import { makeNetworkPassport, makeAgentPassport, makeRow, makeEnvelope, verifyBundle, episodeRow } from './protocol.js';

// A visiting agent: its keypair, its home network's keypair, and the passport
// the home network signed. `homeSeed`/`agentSeed` are the deterministic path
// (tests); a phone derives its own and holds the keys.
export function makeVisitor(opts) {
  var homeKey = keyFromSeed(opts.homeSeed);
  var agentKey = keyFromSeed(opts.agentSeed);
  var homeId = idForKey(homeKey);
  var agentId = idForKey(agentKey);
  var networkPassport = makeNetworkPassport(homeKey, homeId, {
    name: opts.homeName || 'mycelium-node',
    policy: { visitors: false, kinds_writable: [], kinds_exportable: [] },
    issued_at: new Date().toISOString()
  });
  var agentPassport = makeAgentPassport(homeKey, {
    agent_id: agentId,
    name: opts.agentName || 'agent',
    species: opts.species || 'qurio',
    home_network: homeId,
    capabilities: opts.capabilities || ['memory'],
    consent: opts.consent || { share_memories: true },
    issued_at: new Date().toISOString()
  });
  return {
    homeKey: homeKey,
    agentKey: agentKey,
    homeNetworkId: homeId,
    agentId: agentId,
    networkPassport: networkPassport,
    agentPassport: agentPassport,

    // HELLO: knock on a host network. Nothing but passports crosses.
    async hello(transport) {
      return transport.post('/federation/hello', {
        network_passport: networkPassport,
        agent_passport: agentPassport
      });
    },

    // VISIT: write one memory in the host's store, attributed to this agent.
    // The envelope's message is { row } — messages are named, so one message
    // shape never has to be inferred from the payload's fields.
    async writeMemory(transport, visitId, hostNetworkId, fields) {
      var row = makeRow(agentKey, agentId, fields, {
        agent: agentId, network: hostNetworkId, home: homeId, visit: visitId
      });
      return transport.post('/federation/visit/' + visitId + '/memory', envelope({ row: row }));
    },

    // SOUVENIR: leave with what the host's export policy allows.
    async requestSouvenir(transport, visitId) {
      return transport.post('/federation/visit/' + visitId + '/souvenir', envelope({}));
    },

    // Border check the phone runs before carrying a bundle anywhere: the same
    // verifyBundle the home server will run — fail EARLY, at the door.
    checkSouvenir(bundle) {
      return verifyBundle(bundle, { expectedHome: homeId });
    }
  };

  function envelope(payload) {
    return makeEnvelope(agentKey, agentId, payload, Math.floor(Date.now() / 1000), crypto.randomBytes(16).toString('hex'));
  }
}

// IMPORT — the home network side of the same protocol, over HTTPS with the
// home owner's bearer token. The bundle is verified locally FIRST (the door
// check above); the server verifies it again at its own border.
export async function importBundle(transport, token, bundle) {
  return transport.post('/federation/import', { bundle: bundle }, {
    Authorization: 'Bearer ' + token
  });
}

// What the episode row WILL be, for clients that want to mirror it locally.
export { episodeRow };

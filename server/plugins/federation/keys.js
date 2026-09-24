// Federation v0 — crypto + canonicalization primitives (spec/federation-v0 §1).
//
// Everything here is deliberately dependency-free Node crypto so the protocol
// layer (protocol.js) stays pure and runnable headless: the SAME functions
// generate the committed vectors and verify live traffic. The Swift mirror
// (MyceliumKit) implements the identical rules from the spec text — the
// vectors, not the code, are the contract.

import crypto from 'crypto';

// RFC 4648 base32, lowercase alphabet, unpadded — the id encoding. Written by
// hand (Node ships no base32) against the spec's exact wording so the Swift
// side can be written against the same wording and meet us in the middle.
var ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32Encode(buf) {
  var bits = 0;
  var value = 0;
  var out = '';
  for (var i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// Canonical JSON: keys sorted by UTF-16 code unit, no whitespace. The sort is
// JS's default string compare — pinned here because "sorted keys" alone is
// under-specified across languages (code-unit order, not locale or codepoint).
export function cjson(value) {
  var path = new WeakSet(); // ancestors only — a shared non-cyclic ref is fine
  function walk(v) {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'number' && !Number.isInteger(v)) {
        throw new Error('federation cjson: floats are not allowed in protocol messages — two languages must serialize the same bytes');
      }
      return v;
    }
    if (path.has(v)) throw new Error('federation cjson: cycles are not representable');
    path.add(v);
    var out;
    if (Array.isArray(v)) {
      out = v.map(walk);
    } else {
      out = {};
      for (var k of Object.keys(v).sort()) out[k] = walk(v[k]);
    }
    path.delete(v);
    return out;
  }
  return JSON.stringify(walk(value));
}

export function sha256hex(value) {
  return crypto.createHash('sha256').update(cjson(value), 'utf8').digest('hex');
}

// ---- Ed25519 keys ----------------------------------------------------------

var ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// Deterministic keypair from a 32-byte seed (tests + vectors). The PKCS#8
// wrap is the standard SPKI/Ed25519 DER; Swift's
// Curve25519.Signing.PrivateKey(rawRepresentation:) yields the same keypair.
export function keyFromSeed(seed) {
  var buf = Buffer.isBuffer(seed) ? seed : Buffer.from(seed, 'hex');
  if (buf.length !== 32) throw new Error('federation keyFromSeed: seed must be 32 bytes');
  var der = Buffer.concat([ED25519_PKCS8_PREFIX, buf]);
  var priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  var pub = crypto.createPublicKey(priv);
  return { priv, pub };
}

export function publicKeyHex(key) {
  return key.pub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

// The network/agent id for a key: base32 of the raw public key.
export function idForKey(key) {
  return base32Encode(Buffer.from(publicKeyHex(key), 'hex'));
}

var ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function sign(key, value) {
  return crypto.sign(null, Buffer.from(cjson(value), 'utf8'), key.priv).toString('hex');
}

// Verify a signature over cjson(value) with the public key behind `id`
// (base32). Returns boolean — never throws on malformed input (a bad message
// is a verdict, not an exception, at a network border).
export function verify(id, sigHex, value) {
  try {
    // base32 decode → raw 32-byte key → SPKI wrap for Node.
    var spki = Buffer.concat([ED25519_SPKI_PREFIX, base32Decode(id)]);
    var pub = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(cjson(value), 'utf8'), pub, Buffer.from(String(sigHex), 'hex'));
  } catch (e) {
    return false;
  }
}

export function base32Decode(str) {
  var bits = 0;
  var value = 0;
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var idx = ALPHABET.indexOf(str[i]);
    if (idx === -1) throw new Error('bad base32 character: ' + str[i]);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

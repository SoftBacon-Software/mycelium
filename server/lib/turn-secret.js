// Issues the REST-style TURN credentials served by GET /api/voice/turn-
// credentials. Extracted from server/index.js so the secret-resolution rule is
// unit-testable without booting the daemon (index.js calls app.listen() at
// import time, so it can't be imported into a test directly) — same reason
// trust-proxy.js exists.
//
// SECURITY: through 2026-08 this fell back to a hard-coded public demo relay
// secret when TURN_SECRET was unset — auth material derived from a constant
// committed to public source, in the boot path of every clone of this public
// repo. The fallback is now a per-boot random secret (crypto.randomBytes).
// Credentials minted from it are well-formed HMACs but will NOT authenticate
// against any external TURN relay (a relay only accepts credentials derived
// from its own shared secret) — fail honest, not fail open. Set TURN_SECRET to
// the relay's shared secret to make relay auth work.
//
// The issuer is constructed ONCE at module scope in index.js: every credential
// in a boot is keyed by the same secret. That once-ness is part of the
// contract, pinned by test/unit/turn-secret-no-default.test.js.

import crypto from 'crypto';

export function createTurnCredentialIssuer(env) {
  var generated = false;
  var secret;
  if (env && env.TURN_SECRET) {
    secret = env.TURN_SECRET; // explicit override: used exactly as given
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    generated = true;
  }
  return {
    generated: generated,
    // Exposed for diagnostics/tests — never log or serialize this value.
    secret: secret,
    issue: function (nowMs) {
      // REST-auth shape the voice clients already speak: username is
      // "<expiry epoch>:<user>", credential is HMAC-SHA1(username, secret).
      var expiry = Math.floor(nowMs / 1000) + 24 * 3600;
      var username = expiry + ':studiouser';
      var hmac = crypto.createHmac('sha1', secret);
      hmac.update(username);
      return { username: username, credential: hmac.digest('base64') };
    }
  };
}

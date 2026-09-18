// Task 240, CodeQL alert #272 (js/server-side-unvalidated-url-redirection,
// server/routes/plugins.js) — marketingLegacyRedirect used to build its 301
// target by string-replacing the legacy prefix INSIDE req.originalUrl. The fix
// builds the target from the request's PARTS: baseUrl (the mount Express
// matched) + '/marketing' + req.path (the router-relative path the loop just
// prefix-matched), with the query re-derived from originalUrl's '?' suffix.
//
// Pins, without booting the daemon:
//   - a legacy hit redirects to the exact on-site target, query preserved;
//   - a request whose originalUrl is NOT under a legacy prefix falls through
//     (the '//evil.com/bip' shape — protocol-relative URL, no match, no
//     redirect);
//   - every target starts with a SINGLE '/', i.e. it is mount-relative and can
//     never be scheme-relative or absolute.
import { describe, test, expect } from 'vitest';
import { marketingLegacyRedirect } from '../../server/routes/plugins.js';

function run(req) {
  var out = { redirected: false, location: null, nextCalled: 0 };
  var res = {
    redirect: function (status, target) {
      out.redirected = true;
      out.status = status;
      out.location = target;
    },
  };
  var next = function () { out.nextCalled += 1; };
  marketingLegacyRedirect(req, res, next);
  return out;
}

function legacyReq(path, originalUrl, baseUrl) {
  return { path: path, originalUrl: originalUrl || path, baseUrl: baseUrl === undefined ? '/api/mycelium' : baseUrl };
}

describe('marketingLegacyRedirect builds targets from request parts (task 240 #272)', () => {
  test('legacy hit redirects 301 to the mount + /marketing + path, query preserved', function () {
    var out = run(legacyReq('/bip/x', '/api/mycelium/bip/x?y=1'));
    expect(out.redirected).toBe(true);
    expect(out.status).toBe(301);
    expect(out.location).toBe('/api/mycelium/marketing/bip/x?y=1');
    expect(out.nextCalled).toBe(0);
  });

  test('all four legacy prefixes redirect (social, x, outreach, bip)', function () {
    for (var legacy of ['/social', '/x', '/outreach', '/bip']) {
      var out = run(legacyReq(legacy + '/posts', '/api/mycelium' + legacy + '/posts'));
      expect(out.redirected, legacy).toBe(true);
      expect(out.location, legacy).toBe('/api/mycelium/marketing' + legacy + '/posts');
    }
  });

  test('a protocol-relative originalUrl does NOT redirect — it falls through', function () {
    var out = run(legacyReq('//evil.com/bip', '//evil.com/bip', ''));
    expect(out.redirected).toBe(false);
    expect(out.nextCalled).toBe(1);
  });

  test('an originalUrl that merely CONTAINS a legacy prefix is not redirected', function () {
    // /xTERS... matched no legacy prefix before the fix and must not after it.
    var out = run(legacyReq('/xTERS-really-not-a-route', '/api/mycelium/xTERS-really-not-a-route'));
    expect(out.redirected).toBe(false);
    expect(out.nextCalled).toBe(1);
  });

  test('targets are always single-slash-rooted (never scheme-relative or absolute)', function () {
    var cases = [
      legacyReq('/bip/x', '/api/mycelium/bip/x?y=1'),
      legacyReq('/x', '/x', ''),
      legacyReq('/outreach/deep/path?q=1', '/outreach/deep/path?q=1', ''),
    ];
    for (var req of cases) {
      var out = run(req);
      expect(out.redirected).toBe(true);
      expect(out.location).toMatch(/^\//);      // rooted
      expect(out.location).not.toMatch(/^\/\//); // never protocol-relative
      expect(out.location).not.toMatch(/^[a-z]+:/i); // never absolute URL
    }
  });

  test('query-less originalUrl redirects without a trailing separator', function () {
    var out = run(legacyReq('/bip/posts', '/api/mycelium/bip/posts'));
    expect(out.location).toBe('/api/mycelium/marketing/bip/posts');
  });
});

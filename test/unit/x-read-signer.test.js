// x read side: the OAuth 1.0a GET signer must fold query params into the
// signature base string — the defect class this pins is "signed like a
// bare POST, 401s on every parameterized GET".
import { test, expect } from 'vitest';
import { oauthHeaderForGet } from '../../server/plugins/marketing/x/twitter.js';

const CREDS = {
  api_key: 'ck', api_secret: 'cs',
  access_token: 'at', access_token_secret: 'ats'
};
const FIXED = { nonce: 'abc123', timestamp: '1700000000' };

test('query params change the signature (they are inside the base string)', () => {
  const a = oauthHeaderForGet('https://api.twitter.com/2/u', { max_results: 25 }, CREDS, FIXED);
  const b = oauthHeaderForGet('https://api.twitter.com/2/u', { max_results: 50 }, CREDS, FIXED);
  expect(/oauth_signature="([^"]+)"/.exec(a)[1]).not.toEqual(/oauth_signature="([^"]+)"/.exec(b)[1]);
});

test('deterministic under fixed nonce/timestamp (regression vector)', () => {
  const h1 = oauthHeaderForGet('https://api.twitter.com/2/u', { q: 'x y' }, CREDS, FIXED);
  const h2 = oauthHeaderForGet('https://api.twitter.com/2/u', { q: 'x y' }, CREDS, FIXED);
  expect(h1).toEqual(h2);
  expect(h1).toMatch(/^OAuth /);
  expect(h1).toMatch(/oauth_consumer_key="ck"/);
});

test('header carries only oauth_* params (query stays in the URL)', () => {
  const h = oauthHeaderForGet('https://api.twitter.com/2/u', { max_results: 25 }, CREDS, FIXED);
  expect(h).not.toMatch(/max_results/);
});

// Task 240, CodeQL alert #267 (js/request-forgery, marketing/x twitter.js) —
// the X read side interpolates caller-supplied ids into the request URL. The
// fix is two layers, and this file pins both:
//
//   1. every caller that interpolates an id validates it as a decimal X id
//      (getMentions userId/since_id, getTweet tweetId, searchConversation
//      conversationId) — a traversal or query-smuggling value is refused
//      BEFORE any URL is built, proven here by stubbing global fetch and
//      asserting it was never called;
//   2. apiGet pins the base URL to https://api.twitter.com before fetching —
//      a future caller that interpolates a full or scheme-relative URL fails
//      at the layer that fetches, whatever the callers do.
//
// A legal id must still reach the EXACT expected URL (the fix must not bend
// the happy path).
import { describe, test, expect, afterEach } from 'vitest';
import { getMe, getMentions, getTweet, searchConversation, apiGet } from '../../server/plugins/marketing/x/twitter.js';

var calls = [];
var realFetch = globalThis.fetch;

function stubFetch() {
  calls = [];
  globalThis.fetch = function (url, opts) {
    calls.push({ url: String(url), opts: opts });
    return Promise.resolve({ status: 200, json: function () { return Promise.resolve({ data: { id: '42', name: 'x' } }); } });
  };
}

var CREDS = { api_key: 'k', api_secret: 's', access_token: 't', access_token_secret: 'ts' };

afterEach(function () {
  globalThis.fetch = realFetch;
});

describe('x apiGet host allowlist + caller-side id validation (task 240 #267)', () => {
  test('getMentions refuses a traversal userId before any fetch', function () {
    stubFetch();
    expect(function () { getMentions('../../evil', CREDS); }).toThrow(/invalid X user id/);
    expect(calls).toHaveLength(0);
  });

  test('getMentions refuses a query-smuggling userId before any fetch', function () {
    stubFetch();
    expect(function () { getMentions('123?x=', CREDS); }).toThrow(/invalid X user id/);
    expect(calls).toHaveLength(0);
  });

  test('getMentions refuses a non-decimal sinceId before any fetch', function () {
    stubFetch();
    expect(function () { getMentions('1234567890123456789', CREDS, '99;drop'); }).toThrow(/invalid X since_id/);
    expect(calls).toHaveLength(0);
  });

  test('getMentions with a legal id hits the exact URL', async function () {
    stubFetch();
    await getMentions('1234567890123456789', CREDS, '987654321098765432');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'https://api.twitter.com/2/users/1234567890123456789/mentions' +
      '?expansions=author_id&max_results=25' +
      '&since_id=987654321098765432' +
      '&tweet.fields=author_id%2Ccreated_at%2Cconversation_id%2Cin_reply_to_user_id' +
      '&user.fields=username%2Cname'
    );
  });

  test('getTweet refuses a traversal tweetId before any fetch; legal id hits the exact URL', async function () {
    stubFetch();
    expect(function () { getTweet('../../evil', CREDS); }).toThrow(/invalid X tweet id/);
    expect(calls).toHaveLength(0);
    await getTweet('1800000000000000001', CREDS);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twitter.com/2/tweets/1800000000000000001' +
      '?expansions=author_id%2Creferenced_tweets.id' +
      '&tweet.fields=author_id%2Ccreated_at%2Cconversation_id%2Cpublic_metrics%2Creferenced_tweets' +
      '&user.fields=username%2Cname');
  });

  test('searchConversation refuses a non-decimal conversationId; legal id is query-encoded', async function () {
    stubFetch();
    expect(function () { searchConversation('12abc', CREDS); }).toThrow(/invalid X conversation id/);
    expect(calls).toHaveLength(0);
    await searchConversation('1800000000000000002', CREDS);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twitter.com/2/tweets/search/recent' +
      '?expansions=author_id&max_results=50' +
      '&query=conversation_id%3A1800000000000000002' +
      '&tweet.fields=author_id%2Ccreated_at%2Cin_reply_to_user_id' +
      '&user.fields=username%2Cname');
    expect(calls[0].url).toContain('query=conversation_id%3A1800000000000000002');
  });

  test('apiGet refuses a lookalike host', function () {
    stubFetch();
    expect(function () { apiGet('https://api.twitter.com.evil.com/2/users/me', {}, CREDS); })
      .toThrow(/refuses non-X host/);
    expect(calls).toHaveLength(0);
  });

  test('apiGet refuses plain http', function () {
    stubFetch();
    expect(function () { apiGet('http://api.twitter.com/2/users/me', {}, CREDS); })
      .toThrow(/refuses non-X host/);
    expect(calls).toHaveLength(0);
  });

  test('apiGet refuses a scheme-relative base', function () {
    stubFetch();
    expect(function () { apiGet('//evil.com/2/users/me', {}, CREDS); }).toThrow();
    expect(calls).toHaveLength(0);
  });

  test('apiGet still serves the constant-host callers (getMe)', async function () {
    stubFetch();
    var r = await getMe(CREDS);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twitter.com/2/users/me');
    expect(calls[0].opts.headers.Authorization).toMatch(/^OAuth /);
  });
});

// Shared X/Twitter API v2 utilities (OAuth 1.0a)
// Used by both routes.js and handlers.js

import crypto from 'crypto';

// X ids (user, tweet, conversation) are decimal strings up to ~20 digits.
// Validating them at every caller that interpolates one into a request kills
// the js/request-forgery taint at the layer it enters (task 240, alert #267):
// a value like '../../evil' or '123?x=' is refused before any URL is built.
var X_ID_RE = /^[0-9]{1,20}$/;

function assertXId(kind, id) {
  if (typeof id !== 'string' || !X_ID_RE.test(id)) {
    throw new Error('invalid X ' + kind + ': expected a decimal id string, got: ' + String(id).slice(0, 40));
  }
}

export function oauthHeader(method, url, creds) {
  var oauthParams = {
    oauth_consumer_key: creds.api_key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.access_token,
    oauth_version: '1.0'
  };

  var sortedKeys = Object.keys(oauthParams).sort();
  var paramStr = sortedKeys.map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(oauthParams[k]);
  }).join('&');

  var baseStr = method.toUpperCase() + '&' + encodeURIComponent(url) + '&' + encodeURIComponent(paramStr);
  var signingKey = encodeURIComponent(creds.api_secret) + '&' + encodeURIComponent(creds.access_token_secret);
  var signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');

  oauthParams.oauth_signature = signature;

  var parts = Object.keys(oauthParams).sort().map(function (k) {
    return encodeURIComponent(k) + '="' + encodeURIComponent(oauthParams[k]) + '"';
  });

  return 'OAuth ' + parts.join(', ');
}

export function sendTweet(text, replyToId, creds) {
  var url = 'https://api.twitter.com/2/tweets';
  var body = { text: text };
  if (replyToId) {
    body.reply = { in_reply_to_tweet_id: replyToId };
  }

  return fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': oauthHeader('POST', url, creds),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (data) {
      return { status: r.status, data: data };
    });
  });
}

export function getCredentials(db) {
  try {
    var rows = db.prepare("SELECT key, value FROM plugin_config WHERE plugin_name = 'x-posting'").all();
    var config = {};
    for (var i = 0; i < rows.length; i++) {
      config[rows[i].key] = rows[i].value;
    }
    return config;
  } catch (e) {
    return {};
  }
}

// ── Read side (2026-08-29) ─────────────────────────────────────────────────
// OAuth 1.0a GETs must fold QUERY params into the signature base string —
// the POST-only header above signs oauth_* params alone and 401s on any
// parameterized GET. `opts` accepts {nonce, timestamp} for deterministic tests.

export function oauthHeaderForGet(baseUrl, query, creds, opts) {
  opts = opts || {};
  var oauthParams = {
    oauth_consumer_key: creds.api_key,
    oauth_nonce: opts.nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: opts.timestamp || String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.access_token,
    oauth_version: '1.0'
  };
  var all = {};
  Object.keys(oauthParams).forEach(function (k) { all[k] = oauthParams[k]; });
  Object.keys(query || {}).forEach(function (k) { all[k] = String(query[k]); });

  var paramStr = Object.keys(all).sort().map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(all[k]);
  }).join('&');
  var baseStr = 'GET&' + encodeURIComponent(baseUrl) + '&' + encodeURIComponent(paramStr);
  var signingKey = encodeURIComponent(creds.api_secret) + '&' + encodeURIComponent(creds.access_token_secret);
  oauthParams.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseStr).digest('base64');

  var parts = Object.keys(oauthParams).sort().map(function (k) {
    return encodeURIComponent(k) + '="' + encodeURIComponent(oauthParams[k]) + '"';
  });
  return 'OAuth ' + parts.join(', ');
}

export function apiGet(baseUrl, query, creds) {
  // Host allowlist (task 240, alert #267): apiGet fetches the X API and nothing
  // else, so the base URL is pinned before any fetch — a caller that ever
  // interpolates a full or scheme-relative URL instead of an id fails here,
  // whatever the callers' own validation does. Plain Error, not a fetch.
  var parsed = new URL(baseUrl);
  if (parsed.protocol !== 'https:' || parsed.host !== 'api.twitter.com') {
    throw new Error('apiGet refuses non-X host: ' + parsed.host + ' (protocol ' + parsed.protocol + ')');
  }
  var qs = Object.keys(query || {}).sort().map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k]));
  }).join('&');
  var url = qs ? baseUrl + '?' + qs : baseUrl;
  return fetch(url, {
    headers: { 'Authorization': oauthHeaderForGet(baseUrl, query, creds) }
  }).then(function (r) {
    return r.json().then(function (data) {
      return { status: r.status, data: data };
    }).catch(function () {
      return { status: r.status, data: { error: 'unparseable body' } };
    });
  });
}

export function getMe(creds) {
  return apiGet('https://api.twitter.com/2/users/me', {}, creds);
}

export function getMentions(userId, creds, sinceId) {
  assertXId('user id', userId);
  var q = {
    'tweet.fields': 'author_id,created_at,conversation_id,in_reply_to_user_id',
    'expansions': 'author_id',
    'user.fields': 'username,name',
    'max_results': 25
  };
  if (sinceId) {
    assertXId('since_id', sinceId);
    q.since_id = sinceId;
  }
  return apiGet('https://api.twitter.com/2/users/' + userId + '/mentions', q, creds);
}

export function getTweet(tweetId, creds) {
  assertXId('tweet id', tweetId);
  return apiGet('https://api.twitter.com/2/tweets/' + tweetId, {
    'tweet.fields': 'author_id,created_at,conversation_id,public_metrics,referenced_tweets',
    'expansions': 'author_id,referenced_tweets.id',
    'user.fields': 'username,name'
  }, creds);
}

export function searchConversation(conversationId, creds) {
  assertXId('conversation id', conversationId);
  // search/recent may be tier-gated: callers surface the API's own verdict
  return apiGet('https://api.twitter.com/2/tweets/search/recent', {
    'query': 'conversation_id:' + conversationId,
    'tweet.fields': 'author_id,created_at,in_reply_to_user_id',
    'expansions': 'author_id',
    'user.fields': 'username,name',
    'max_results': 50
  }, creds);
}

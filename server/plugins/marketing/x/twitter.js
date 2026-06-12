// Shared X/Twitter API v2 utilities (OAuth 1.0a)
// Used by both routes.js and handlers.js

import crypto from 'crypto';

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

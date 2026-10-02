// Task 262 — X read returns the WHOLE long post. X stores a long post's body
// in note_tweet.text; the v2 API returns that object ONLY when tweet.fields
// includes note_tweet, and text alone is the ~280-char display truncation.
// Reading a ~2,400-char post through GET /api/mycelium/marketing/x/read/:tweetId
// returned 303 characters because none of the three read paths (getTweet /
// getMentions / searchConversation) asked for the field and the routes passed
// the truncation through untouched. This file pins both halves:
//
//   1. every read path REQUESTS note_tweet (tweet.fields carries the field);
//   2. every tweet body that leaves the routes (the tweet, each mention, each
//      thread reply, and the referenced tweets in includes) carries
//      full_text = note_tweet.text when present, else text — so a caller
//      never has to know the long-post rule.
//
// Hermetic: global fetch stubbed with recorded v2 payloads (the shape X
// returns for a note tweet: short text + long note_tweet.text), an in-memory
// better-sqlite3 DB on the marketing plugin's real schema.sql (plus the core
// plugin_config table it reads), and the plugin router mounted at its
// production prefix.
import { describe, test, expect, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getTweet, getMentions, searchConversation } from '../../server/plugins/marketing/x/twitter.js'
import createMarketingRoutes from '../../server/plugins/marketing/routes.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// ── recorded payload material ──────────────────────────────────────────────
// SHORT_TEXT mirrors what the route returned in the defect: a ~300-char
// display truncation ending in an ellipsis. LONG_TEXT mirrors the real
// note_tweet.text the caller was owed (~2,400 chars in the repro).
var SHORT_TEXT = 'The loop compounds and the weights do not. ' + 'Routing beats recall. '.repeat(12) + '…'
var LONG_TEXT = 'The loop compounds and the weights do not. '.repeat(20) +
  'Every hop a checker verifies. '.repeat(40) +
  'Context is the real weights. '.repeat(10)
var REPLY_SHORT = 'short reply, plain post'
var REPLY_LONG = 'Reply body, delivered whole. '.repeat(85)

const TWEET_ID = '2105819303471976479'
const SHORT_ID = '2109999999999999999'
const OWN_USER_ID = '555000111'

const RECORDED_TWEET = {
  data: {
    id: TWEET_ID,
    text: SHORT_TEXT,
    author_id: OWN_USER_ID,
    created_at: '2026-10-01T12:00:00.000Z',
    conversation_id: TWEET_ID,
    public_metrics: { retweet_count: 0, reply_count: 1, like_count: 0, quote_count: 0 },
    note_tweet: { id: TWEET_ID, text: LONG_TEXT }
  },
  includes: { users: [{ id: OWN_USER_ID, name: 'Karpathy', username: 'karpathy' }] },
  meta: {}
}

const RECORDED_SHORT = {
  data: {
    id: SHORT_ID,
    text: SHORT_TEXT,
    author_id: OWN_USER_ID,
    created_at: '2026-10-01T13:00:00.000Z',
    conversation_id: SHORT_ID,
    public_metrics: { retweet_count: 0, reply_count: 0, like_count: 0, quote_count: 0 }
  },
  includes: { users: [{ id: OWN_USER_ID, name: 'Karpathy', username: 'karpathy' }] },
  meta: {}
}

const RECORDED_THREAD = {
  data: [
    {
      id: TWEET_ID.slice(0, -2) + '80',
      text: REPLY_SHORT,
      author_id: '1400000002',
      created_at: '2026-10-01T12:05:00.000Z',
      conversation_id: TWEET_ID
    },
    {
      id: TWEET_ID.slice(0, -2) + '81',
      text: REPLY_LONG.slice(0, 200) + '…',
      author_id: '1400000003',
      created_at: '2026-10-01T12:06:00.000Z',
      conversation_id: TWEET_ID,
      note_tweet: { id: TWEET_ID.slice(0, -2) + '81', text: REPLY_LONG }
    }
  ],
  includes: { users: [{ id: '1400000002', name: 'a', username: 'a' }, { id: '1400000003', name: 'b', username: 'b' }] },
  meta: { result_count: 2 }
}

const RECORDED_MENTIONS = {
  data: [
    {
      id: TWEET_ID.slice(0, -2) + '90',
      text: SHORT_TEXT,
      author_id: '1400000004',
      created_at: '2026-10-01T12:10:00.000Z',
      conversation_id: TWEET_ID.slice(0, -2) + '90',
      note_tweet: { id: TWEET_ID.slice(0, -2) + '90', text: LONG_TEXT }
    },
    {
      id: TWEET_ID.slice(0, -2) + '91',
      text: REPLY_SHORT,
      author_id: '1400000005',
      created_at: '2026-10-01T12:11:00.000Z',
      conversation_id: TWEET_ID.slice(0, -2) + '91'
    }
  ],
  includes: { users: [{ id: '1400000004', name: 'c', username: 'c' }] },
  meta: { result_count: 2 }
}

// ── harness ────────────────────────────────────────────────────────────────
var calls = []
var realFetch = globalThis.fetch

function serveByUrl(url) {
  var u = String(url)
  if (u.indexOf('/2/tweets/search/recent') !== -1) return RECORDED_THREAD
  if (u.indexOf('/2/tweets/' + TWEET_ID + '?') !== -1) return RECORDED_TWEET
  if (u.indexOf('/2/tweets/' + SHORT_ID + '?') !== -1) return RECORDED_SHORT
  if (u.indexOf('/2/users/' + OWN_USER_ID + '/mentions') !== -1) return RECORDED_MENTIONS
  return { data: { id: '0' } }
}

function stubFetch() {
  calls = []
  globalThis.fetch = function (url) {
    calls.push({ url: String(url) })
    return Promise.resolve({
      status: 200,
      json: function () { return Promise.resolve(serveByUrl(url)) }
    })
  }
}

afterEach(function () {
  globalThis.fetch = realFetch
})

function tweetFieldsOf(i) {
  return new URL(calls[i].url).searchParams.get('tweet.fields').split(',')
}

function makeApp() {
  var db = new Database(':memory:')
  db.exec(fs.readFileSync(path.join(here, '../../server/plugins/marketing/schema.sql'), 'utf8'))
  // plugin_config is a core table (server/schema.sql); the marketing plugin
  // schema does not carry it, but the x read side reads creds, own_user_id and
  // the mentions watermark from it.
  db.exec("CREATE TABLE IF NOT EXISTS plugin_config (plugin_name TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (plugin_name, key))")
  var seed = db.prepare("INSERT OR REPLACE INTO plugin_config (plugin_name, key, value) VALUES ('x-posting', ?, ?)")
  seed.run('own_user_id', OWN_USER_ID)
  seed.run('api_key', 'k')
  seed.run('api_secret', 's')
  seed.run('access_token', 't')
  seed.run('access_token_secret', 'ts')

  var core = {
    db: db,
    auth: {
      checkAgentOrAdmin(req, res) {
        if (req.headers && req.headers['x-test-deny']) { res.status(401).json({ error: 'Authentication required' }); return false; }
        return (req.headers && req.headers['x-acting-as']) || 'tester'
      },
      checkAdmin() { return 'tester' },
      getAdminDisplayName() { return 'tester' }
    },
    // The read routes use the one-arg form (res.json(apiError(msg))); the
    // write routes use the express form. Mirror both.
    apiError(resOrMsg, status, message, extra) {
      if (typeof resOrMsg === 'string') return { error: resOrMsg }
      return resOrMsg.status(status).json(Object.assign({ error: message }, extra || {}))
    },
    parseIntParam(val) { var n = parseInt(val, 10); return isNaN(n) ? null : n },
    emitEvent() {},
    onEvent() {},
    gatedActions: [],
    inbox: {}
  }
  var app = express()
  app.use('/api/mycelium/marketing', createMarketingRoutes(core))
  return app
}

describe('x read asks for note_tweet and returns the whole long post (task 262)', () => {
  test('sanity: the recorded truncation is shorter than the recorded note body', () => {
    expect(SHORT_TEXT.length).toBeLessThan(LONG_TEXT.length)
    expect(REPLY_SHORT.length).toBeLessThan(REPLY_LONG.length)
  })

  test('getTweet requests note_tweet', async function () {
    stubFetch()
    await getTweet(TWEET_ID, { api_key: 'k', api_secret: 's', access_token: 't', access_token_secret: 'ts' })
    expect(tweetFieldsOf(0)).toContain('note_tweet')
  })

  test('getMentions requests note_tweet', async function () {
    stubFetch()
    await getMentions(OWN_USER_ID, { api_key: 'k', api_secret: 's', access_token: 't', access_token_secret: 'ts' })
    expect(tweetFieldsOf(0)).toContain('note_tweet')
  })

  test('searchConversation requests note_tweet', async function () {
    stubFetch()
    await searchConversation(TWEET_ID, { api_key: 'k', api_secret: 's', access_token: 't', access_token_secret: 'ts' })
    expect(tweetFieldsOf(0)).toContain('note_tweet')
  })

  test('GET /x/read/:tweetId returns the whole long post, not the truncation', async function () {
    stubFetch()
    var res = await supertest(makeApp()).get('/api/mycelium/marketing/x/read/' + TWEET_ID)
    expect(res.status).toBe(200)
    // The truncation stays where it was; the whole post arrives beside it.
    expect(res.body.tweet.data.text).toBe(SHORT_TEXT)
    expect(res.body.tweet.data.full_text).toBe(LONG_TEXT)
    // Thread replies follow the same rule — callers never branch.
    expect(res.body.thread.data[0].full_text).toBe(REPLY_SHORT)
    expect(res.body.thread.data[1].full_text).toBe(REPLY_LONG)
  })

  test('a short post (no note_tweet) carries full_text = text', async function () {
    stubFetch()
    var res = await supertest(makeApp()).get('/api/mycelium/marketing/x/read/' + SHORT_ID + '?thread=0')
    expect(res.status).toBe(200)
    expect(res.body.tweet.data.full_text).toBe(res.body.tweet.data.text)
  })

  test('GET /x/mentions returns full_text for each mention', async function () {
    stubFetch()
    var res = await supertest(makeApp()).get('/api/mycelium/marketing/x/mentions')
    expect(res.status).toBe(200)
    expect(res.body.mentions[0].text).toBe(SHORT_TEXT)
    expect(res.body.mentions[0].full_text).toBe(LONG_TEXT)
    expect(res.body.mentions[1].full_text).toBe(REPLY_SHORT)
  })
})

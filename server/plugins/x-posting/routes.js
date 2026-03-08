// X/Twitter Posting plugin routes
// Direct posting to X via Twitter API v2 with OAuth 1.0a.

import { Router } from 'express';
import crypto from 'crypto';
import createXDB from './db.js';
import { sendTweet, getCredentials } from './twitter.js';
// Note: crypto still needed for thread UUID generation

export default function (core) {
  var router = Router();
  var db = createXDB(core.db);
  var { apiError, parseIntParam } = core;

  // ── Draft Management ──

  // POST /x/posts — Create a tweet draft
  router.post('/posts', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var text = req.body.text || req.body.tweet_text;
    if (!text) return apiError(res, 400, 'text is required');
    if (text.length > 280) return apiError(res, 400, 'Tweet exceeds 280 characters (' + text.length + ')');

    var id = db.createPost({
      project_id: req.body.project_id || '',
      tweet_text: text,
      thread_id: req.body.thread_id || null,
      thread_position: req.body.thread_position || null,
      source: req.body.source || 'manual',
      source_id: req.body.source_id || null,
      status: 'draft',
      posted_by: who
    });

    // Emit event so handlers can route to operator inbox
    core.emitEvent('x_draft_created', who, req.body.project_id || '',
      'Tweet draft created', { post_id: id, text: text, posted_by: who });

    res.json({ ok: true, id: id });
  });

  // GET /x/posts — List tweet drafts/posts
  router.get('/posts', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listPosts({
      status: req.query.status,
      project_id: req.query.project_id,
      thread_id: req.query.thread_id,
      source: req.query.source,
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // GET /x/posts/:id — Get single post
  router.get('/posts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var post = db.getPost(parseIntParam(req.params.id));
    if (!post) return apiError(res, 404, 'Post not found');
    res.json(post);
  });

  // PUT /x/posts/:id — Edit draft
  router.put('/posts/:id', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var post = db.getPost(parseIntParam(req.params.id));
    if (!post) return apiError(res, 404, 'Post not found');
    if (post.status !== 'draft') return apiError(res, 400, 'Can only edit drafts');
    var updates = {};
    if (req.body.text !== undefined || req.body.tweet_text !== undefined) {
      var newText = req.body.text || req.body.tweet_text;
      if (newText.length > 280) return apiError(res, 400, 'Tweet exceeds 280 characters');
      updates.tweet_text = newText;
    }
    db.updatePost(post.id, updates);
    res.json({ ok: true, post: db.getPost(post.id) });
  });

  // DELETE /x/posts/:id — Delete draft
  router.delete('/posts/:id', function (req, res) {
    var who = core.auth.checkAdmin(req, res);
    if (!who) return;
    db.deletePost(parseIntParam(req.params.id));
    res.json({ ok: true });
  });

  // ── Publishing ──

  // POST /x/posts/:id/publish — Send tweet to X
  router.post('/posts/:id/publish', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var post = db.getPost(parseIntParam(req.params.id));
    if (!post) return apiError(res, 404, 'Post not found');
    if (!post.tweet_text) return apiError(res, 400, 'Post has no text');
    if (post.status === 'published') return apiError(res, 400, 'Already published');

    // Check approval gate
    var gate = core.checkApprovalGate(req, who, 'x_publish');
    if (gate && !gate.ok) {
      return apiError(res, 403, gate.soft
        ? 'X publishing requires approval. Use mycelium_request_approval with action_type=x_publish first.'
        : (gate.error || 'Publishing not permitted'), { approval_required: true });
    }

    var creds = getCredentials(core.db);
    if (!creds.api_key || !creds.api_secret || !creds.access_token || !creds.access_token_secret) {
      return apiError(res, 400, 'X/Twitter API credentials not configured. Set api_key, api_secret, access_token, access_token_secret in plugin config.');
    }

    // If this is part of a thread, find the previous tweet ID to reply to
    var replyTo = null;
    if (post.thread_id && post.thread_position > 0) {
      var prev = core.db.prepare(
        "SELECT tweet_id FROM x_posts WHERE thread_id = ? AND thread_position = ? AND status = 'published'"
      ).get(post.thread_id, post.thread_position - 1);
      if (prev) replyTo = prev.tweet_id;
    }

    db.updatePost(post.id, { status: 'publishing' });

    sendTweet(post.tweet_text, replyTo, creds).then(function (result) {
      if (result.status === 201 && result.data && result.data.data) {
        var tweetId = result.data.data.id;
        var tweetUrl = 'https://x.com/i/status/' + tweetId;
        db.updatePost(post.id, {
          status: 'published',
          tweet_id: tweetId,
          tweet_url: tweetUrl,
          posted_at: new Date().toISOString()
        });
        core.emitEvent('x_tweet_published', who, post.project_id,
          'Tweet published', { post_id: post.id, tweet_id: tweetId, tweet_url: tweetUrl });
        res.json({ ok: true, tweet_id: tweetId, tweet_url: tweetUrl });
      } else {
        var errMsg = (result.data && result.data.detail) || (result.data && result.data.title) || JSON.stringify(result.data);
        db.updatePost(post.id, { status: 'failed', error: errMsg });
        apiError(res, 502, 'Twitter API error: ' + errMsg);
      }
    }).catch(function (err) {
      db.updatePost(post.id, { status: 'failed', error: err.message });
      apiError(res, 500, 'Tweet failed: ' + err.message);
    });
  });

  // POST /x/thread — Create and optionally publish a thread
  router.post('/thread', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var tweets = req.body.tweets;
    if (!Array.isArray(tweets) || tweets.length === 0) return apiError(res, 400, 'tweets array is required');
    for (var i = 0; i < tweets.length; i++) {
      if (!tweets[i] || tweets[i].length > 280) {
        return apiError(res, 400, 'Tweet ' + (i + 1) + ' is empty or exceeds 280 characters');
      }
    }

    var threadId = crypto.randomUUID();
    var ids = [];
    for (var j = 0; j < tweets.length; j++) {
      var id = db.createPost({
        project_id: req.body.project_id || '',
        tweet_text: tweets[j],
        thread_id: threadId,
        thread_position: j,
        source: req.body.source || 'manual',
        source_id: req.body.source_id || null,
        status: 'draft',
        posted_by: who
      });
      ids.push(id);
    }

    res.json({ ok: true, thread_id: threadId, post_ids: ids, count: ids.length });
  });

  // POST /x/thread/:threadId/publish — Publish entire thread sequentially
  router.post('/thread/:threadId/publish', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    var threadId = req.params.threadId;
    var tweets = db.getThread(threadId);
    if (!tweets.length) return apiError(res, 404, 'Thread not found');

    // Check approval gate
    var gate = core.checkApprovalGate(req, who, 'x_publish');
    if (gate && !gate.ok) {
      return apiError(res, 403, gate.soft
        ? 'X publishing requires approval.'
        : (gate.error || 'Publishing not permitted'), { approval_required: true });
    }

    var creds = getCredentials(core.db);
    if (!creds.api_key || !creds.api_secret || !creds.access_token || !creds.access_token_secret) {
      return apiError(res, 400, 'X/Twitter API credentials not configured.');
    }

    // Publish sequentially — each tweet replies to the previous
    var results = [];
    var chain = Promise.resolve(null);

    for (var i = 0; i < tweets.length; i++) {
      (function (tweet, idx) {
        chain = chain.then(function (prevTweetId) {
          db.updatePost(tweet.id, { status: 'publishing' });
          return sendTweet(tweet.tweet_text, prevTweetId, creds).then(function (result) {
            if (result.status === 201 && result.data && result.data.data) {
              var tweetId = result.data.data.id;
              var tweetUrl = 'https://x.com/i/status/' + tweetId;
              db.updatePost(tweet.id, {
                status: 'published',
                tweet_id: tweetId,
                tweet_url: tweetUrl,
                posted_at: new Date().toISOString()
              });
              results.push({ id: tweet.id, tweet_id: tweetId, tweet_url: tweetUrl });
              return tweetId;
            } else {
              var errMsg = (result.data && result.data.detail) || JSON.stringify(result.data);
              db.updatePost(tweet.id, { status: 'failed', error: errMsg });
              throw new Error('Tweet ' + (idx + 1) + ' failed: ' + errMsg);
            }
          });
        });
      })(tweets[i], i);
    }

    chain.then(function () {
      core.emitEvent('x_thread_published', who, tweets[0].project_id,
        'Thread published (' + results.length + ' tweets)', { thread_id: threadId, tweets: results });
      res.json({ ok: true, thread_id: threadId, tweets: results });
    }).catch(function (err) {
      res.json({ ok: false, error: err.message, published: results });
    });
  });

  // ── Stats ──

  // GET /x/stats — Post counts by status
  router.get('/stats', function (req, res) {
    var who = core.auth.checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.getStats(req.query.project_id));
  });

  return router;
}

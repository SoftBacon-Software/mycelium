// X/Twitter Posting event handlers
// Creates approval records for tweet drafts and auto-publishes on approval.

import createXDB from './db.js';
import { sendTweet, getCredentials } from './twitter.js';

export function registerHooks(core) {
  var db = createXDB(core.db);

  // When any X draft is created, create an approval record and route to operator inbox
  core.onEvent('x_draft_created', function (eventData) {
    try {
      var data = eventData.data || {};
      var postId = data.post_id;
      var text = data.text || '';
      if (!postId) return;

      // Create a real approval record so it appears in the Approvals page
      var result = core.db.prepare(
        "INSERT INTO approvals (action_type, requested_by, title, payload, project_id, risk_tier, required_approvals) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
      ).get(
        'x_publish',
        data.posted_by || '__system__',
        'Publish tweet: ' + (text.length > 60 ? text.substring(0, 57) + '...' : text),
        JSON.stringify({ post_id: postId, full_text: text }),
        eventData.project || 'mycelium',
        'low',
        1
      );
      var approvalId = result.id;

      var preview = text.length > 100 ? text.substring(0, 97) + '...' : text;

      core.inbox.createInboxItemForAllOperators(
        'approval',
        'approval',
        String(approvalId),
        'Tweet draft #' + postId + ' ready for review',
        preview,
        { post_id: postId, approval_id: approvalId, full_text: text },
        'normal'
      );
    } catch (e) {
      console.error('[x-posting] Error routing draft to inbox:', e.message);
    }
  });

  // When an approval is approved, check if it's an x_publish and auto-publish the tweet
  core.onEvent('approval_approved', function (eventData) {
    try {
      // Parse event data to get approval_id
      var raw = eventData.data;
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      var approvalId = parsed.approval_id;
      if (!approvalId) return;

      var approval = core.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId);
      if (!approval || approval.action_type !== 'x_publish') return;

      var payload = JSON.parse(approval.payload || '{}');
      var postId = payload.post_id;
      if (!postId) return;

      var post = db.getPost(postId);
      if (!post || !post.tweet_text) return;
      if (post.status === 'published') {
        // Post already published (e.g. via direct-publish before this fired) — the
        // approval is fulfilled, so mark it executed instead of stranding it at
        // 'approved' (bug #1).
        core.db.prepare(
          "UPDATE approvals SET status = 'executed', executed_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status != 'executed'"
        ).run(approvalId);
        return;
      }

      var creds = getCredentials(core.db);
      if (!creds.api_key || !creds.api_secret || !creds.access_token || !creds.access_token_secret) {
        console.error('[x-posting] Cannot auto-publish: X API credentials not configured');
        return;
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

      console.log('[x-posting] Approval #' + approvalId + ' approved, publishing tweet #' + postId);

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

          // Mark approval as executed
          core.db.prepare(
            "UPDATE approvals SET status = 'executed', executed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          ).run(approvalId);

          core.emitEvent('x_tweet_published', '__system__', post.project_id,
            'Tweet published via approval', { post_id: post.id, tweet_id: tweetId, tweet_url: tweetUrl, approval_id: approvalId });

          console.log('[x-posting] Tweet #' + postId + ' published: ' + tweetUrl);
        } else {
          var errMsg = (result.data && result.data.detail) || (result.data && result.data.title) || JSON.stringify(result.data);
          db.updatePost(post.id, { status: 'failed', error: errMsg });
          console.error('[x-posting] Tweet #' + postId + ' failed: ' + errMsg);
        }
      }).catch(function (err) {
        db.updatePost(post.id, { status: 'failed', error: err.message });
        console.error('[x-posting] Tweet #' + postId + ' error: ' + err.message);
      });

    } catch (e) {
      console.error('[x-posting] Error handling approval_approved:', e.message);
    }
  });

  // When a BIP draft is approved, auto-create an X post (and optionally auto-publish)
  core.onEvent('bip_draft_approved', function (eventData) {
    try {
      // Check if auto-posting is enabled
      var autoPost = core.db.prepare(
        "SELECT value FROM plugin_config WHERE plugin_name = 'x-posting' AND key = 'auto_post_bip'"
      ).get();
      if (!autoPost || autoPost.value !== 'true') return;

      var data = eventData.data || {};
      var draftId = data.draft_id;
      if (!draftId) return;

      // Get the BIP draft content
      var draft = core.db.prepare('SELECT * FROM bip_drafts WHERE id = ?').get(draftId);
      if (!draft) return;

      var content = draft.content || '';
      if (!content) return;

      // Truncate to 280 chars for tweet
      var tweetText = content.length > 280 ? content.substring(0, 277) + '...' : content;

      // Get default project from config
      var projectConfig = core.db.prepare(
        "SELECT value FROM plugin_config WHERE plugin_name = 'x-posting' AND key = 'default_project'"
      ).get();
      var projectId = (projectConfig && projectConfig.value) || 'mycelium';

      // Create the X post
      var newPostId = db.createPost({
        project_id: projectId,
        tweet_text: tweetText,
        source: 'bip',
        source_id: String(draftId),
        status: 'draft',
        posted_by: '__system__'
      });

      console.log('[x-posting] Auto-created X post #' + newPostId + ' from BIP draft #' + draftId);

      // Emit x_draft_created to trigger approval flow
      core.emitEvent('x_draft_created', '__system__', projectId,
        'Tweet draft created from BIP', { post_id: newPostId, text: tweetText, posted_by: '__system__' });

    } catch (e) {
      console.error('[x-posting] Error handling bip_draft_approved:', e.message);
    }
  });
}

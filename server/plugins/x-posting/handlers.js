// X/Twitter Posting event handlers
// Listens for BIP draft approvals and auto-tweets if configured.

import createXDB from './db.js';

export function registerHooks(core) {
  var db = createXDB(core.db);

  // When a BIP draft is approved, auto-create an X post (and optionally auto-publish)
  core.onEvent('bip_draft_approved', function (eventData) {
    try {
      // Check if auto-posting is enabled
      var autoPost = core.db.prepare(
        "SELECT value FROM dv_plugin_config WHERE plugin_name = 'x-posting' AND key = 'auto_post_bip'"
      ).get();
      if (!autoPost || autoPost.value !== 'true') return;

      var data = eventData.data || {};
      var draftId = data.draft_id;
      if (!draftId) return;

      // Get the BIP draft content
      var draft = core.db.prepare('SELECT * FROM dv_bip_drafts WHERE id = ?').get(draftId);
      if (!draft) return;

      var content = draft.content || '';
      if (!content) return;

      // Truncate to 280 chars for tweet
      var tweetText = content.length > 280 ? content.substring(0, 277) + '...' : content;

      // Get default project from config
      var projectConfig = core.db.prepare(
        "SELECT value FROM dv_plugin_config WHERE plugin_name = 'x-posting' AND key = 'default_project'"
      ).get();
      var projectId = (projectConfig && projectConfig.value) || 'mycelium';

      // Create the X post
      var postId = db.createPost({
        project_id: projectId,
        tweet_text: tweetText,
        source: 'bip',
        source_id: String(draftId),
        status: 'draft',
        posted_by: '__system__'
      });

      console.log('[x-posting] Auto-created X post #' + postId + ' from BIP draft #' + draftId);

      // Notify operators via inbox
      try {
        core.inbox.createInboxItemForAllOperators(
          'message',
          'x_post_ready',
          String(postId),
          'Tweet ready: ' + tweetText.substring(0, 60) + (tweetText.length > 60 ? '...' : ''),
          'Auto-created from approved BIP draft #' + draftId + '. Publish via POST /x/posts/' + postId + '/publish',
          { post_id: postId, draft_id: draftId },
          'normal'
        );
      } catch (e) { /* non-fatal */ }

      core.emitEvent('x_post_created', '__system__', projectId,
        'X post created from BIP draft', { post_id: postId, draft_id: draftId });

    } catch (e) {
      console.error('[x-posting] Error handling bip_draft_approved:', e.message);
    }
  });
}

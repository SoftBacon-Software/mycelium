// Slack Bridge event handlers
// Subscribes to platform events and forwards them to Slack (and optionally Discord).
// Also bridges Mycelium channel messages to mapped Slack channels.

import createSlackDB from './db.js';

function postToSlack(botToken, channel, text) {
  return fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + botToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channel, text: text })
  }).then(function (r) { return r.json(); });
}

function postToDiscord(webhookUrl, content) {
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: content })
  }).catch(function (e) { console.error('[slack-bridge] Discord post failed:', e.message); });
}

export function registerHooks(core) {
  var db = createSlackDB(core.db);

  function getConfig(key) {
    var row = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'slack-bridge' AND key = ?").get(key);
    return row ? row.value : '';
  }

  function formatEventMessage(eventData) {
    var agent = eventData.agent || 'system';
    var summary = eventData.summary || eventData.type || 'event';
    var project = eventData.project_id ? ' [' + eventData.project_id + ']' : '';
    return '*' + agent + '*' + project + ': ' + summary;
  }

  // Subscribe to all events and filter based on config
  core.onEvent('*', function (eventData) {
    try {
      var eventType = eventData.type || eventData.event_type || '';
      if (!eventType) return;

      var botToken = getConfig('bot_token');
      if (!botToken) return;
      var defaultChannel = getConfig('default_channel');
      var filtersStr = getConfig('event_filters');
      var filters = filtersStr ? filtersStr.split(',').map(function (s) { return s.trim(); }) : [];

      // Check if this event type should be forwarded
      if (filters.length > 0 && filters.indexOf(eventType) === -1) return;

      var message = formatEventMessage(eventData);

      // Post to default Slack channel
      if (defaultChannel) {
        postToSlack(botToken, defaultChannel, message).catch(function (e) {
          console.error('[slack-bridge] Slack post failed:', e.message);
        });
        db.logMessage('outbound', null, '', defaultChannel, message, eventData.agent || '');
      }

      // Post to Discord if configured
      var discordWebhook = getConfig('discord_webhook');
      if (discordWebhook) {
        // Discord uses **bold** instead of Slack's *bold*
        var discordMsg = message.replace(/\*/g, '**');
        postToDiscord(discordWebhook, discordMsg);
      }
    } catch (e) {
      console.error('[slack-bridge] Event hook error:', e.message);
    }
  });

  // Bridge Mycelium channel messages to mapped Slack channels
  core.onEvent('channel_message', function (eventData) {
    try {
      var botToken = getConfig('bot_token');
      if (!botToken) return;

      var channelId = eventData.data ? eventData.data.channel_id : null;
      if (!channelId) return;

      // Skip messages that originated from Slack (prevent loops)
      var senderId = eventData.data ? eventData.data.sender_id : '';
      if (typeof senderId === 'string' && senderId.indexOf('slack:') === 0) return;

      var mapping = db.getMapByMycelium(channelId);
      if (!mapping) return;
      if (mapping.direction !== 'both' && mapping.direction !== 'to_slack') return;

      var sender = eventData.agent || (eventData.data ? eventData.data.sender_id : '') || 'unknown';
      var content = eventData.data ? eventData.data.content : eventData.summary || '';
      var slackText = '*[' + sender + ']*: ' + content;

      postToSlack(botToken, mapping.slack_channel_id, slackText)
        .then(function (result) {
          if (result.ok) {
            var myceliumMsgId = eventData.data ? eventData.data.message_id : null;
            db.logMessage('outbound', myceliumMsgId, result.ts || '', mapping.slack_channel_id, content, sender);
          }
        })
        .catch(function (e) {
          console.error('[slack-bridge] Failed to forward to Slack:', e.message);
        });

      // Also forward to Discord if configured
      var discordWebhook = getConfig('discord_webhook');
      if (discordWebhook) {
        var discordText = '**[' + sender + ']**: ' + content;
        postToDiscord(discordWebhook, discordText);
      }
    } catch (e) {
      console.error('[slack-bridge] Channel message hook error:', e.message);
    }
  });
}

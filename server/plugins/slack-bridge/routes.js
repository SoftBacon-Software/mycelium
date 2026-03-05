// Slack Bridge plugin routes
// Handles Slack Events API, slash commands, channel mappings, and message logs.

import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import createSlackDB from './db.js';

function verifySlackSignature(signingSecret, timestamp, body, signature) {
  var baseString = 'v0:' + timestamp + ':' + body;
  var expected = 'v0=' + createHmac('sha256', signingSecret).update(baseString).digest('hex');
  try { return timingSafeEqual(Buffer.from(expected), Buffer.from(signature || '')); } catch (e) { return false; }
}

function postToSlack(botToken, channel, text) {
  return fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + botToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: channel, text: text })
  }).then(function (r) { return r.json(); });
}

export default function (core) {
  var router = Router();
  var db = createSlackDB(core.db);
  var { checkAgentOrAdmin, checkAdmin } = core.auth;
  var { apiError, parseIntParam } = core;

  function getConfig(key) {
    var row = core.db.prepare("SELECT value FROM dv_plugin_config WHERE plugin_name = 'slack-bridge' AND key = ?").get(key);
    return row ? row.value : '';
  }

  // Middleware to verify Slack request signatures
  function verifySlack(req, res, next) {
    var signingSecret = getConfig('signing_secret');
    if (!signingSecret) return apiError(res, 500, 'Slack signing secret not configured');

    var timestamp = req.headers['x-slack-request-timestamp'];
    var signature = req.headers['x-slack-signature'];

    // Reject requests older than 5 minutes to prevent replay attacks
    var now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > 300) {
      return apiError(res, 403, 'Request timestamp expired');
    }

    var rawBody = req.rawBody || JSON.stringify(req.body);
    if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
      return apiError(res, 403, 'Invalid Slack signature');
    }

    next();
  }

  // POST /slack/events — Slack Events API endpoint
  router.post('/events', verifySlack, function (req, res) {
    var payload = req.body;

    // URL verification challenge
    if (payload.type === 'url_verification') {
      return res.json({ challenge: payload.challenge });
    }

    // Event callbacks
    if (payload.type === 'event_callback') {
      var event = payload.event || {};

      // Handle message events from mapped Slack channels
      if (event.type === 'message' && !event.subtype && !event.bot_id) {
        var mapping = db.getMapBySlack(event.channel);
        if (mapping && (mapping.direction === 'both' || mapping.direction === 'to_mycelium')) {
          var text = event.text || '';
          var user = event.user || 'slack-user';

          // Forward to Mycelium channel
          try {
            core.db.prepare(
              'INSERT INTO dv_channel_messages (channel_id, sender_type, sender_id, content) VALUES (?, ?, ?, ?)'
            ).run(mapping.mycelium_channel_id, 'external', 'slack:' + user, text);

            db.logMessage('inbound', null, event.ts || '', event.channel, text, 'slack:' + user);

            core.emitEvent('slack_message_received', 'slack:' + user, null,
              'Slack message forwarded to Mycelium channel #' + mapping.mycelium_channel_id,
              { slack_channel: event.channel, mycelium_channel_id: mapping.mycelium_channel_id });
          } catch (e) {
            console.error('[slack-bridge] Failed to forward Slack message:', e.message);
          }
        }
      }

      return res.json({ ok: true });
    }

    res.json({ ok: true });
  });

  // POST /slack/commands — Slack slash command handler
  router.post('/commands', verifySlack, function (req, res) {
    var command = (req.body.text || '').trim();
    var parts = command.split(/\s+/);
    var subcommand = (parts[0] || '').toLowerCase();

    if (subcommand === 'status') {
      // Return agent statuses
      var agents = core.db.prepare(
        "SELECT id, status, working_on, last_heartbeat FROM dv_agents WHERE status != 'offline' ORDER BY last_heartbeat DESC"
      ).all();

      var lines = agents.map(function (a) {
        var heartbeat = a.last_heartbeat ? ' (last seen: ' + a.last_heartbeat + ')' : '';
        var work = a.working_on ? ' — ' + a.working_on : '';
        return ':robot_face: *' + a.id + '* [' + a.status + ']' + work + heartbeat;
      });

      return res.json({
        response_type: 'in_channel',
        text: lines.length > 0 ? lines.join('\n') : 'No active agents.'
      });
    }

    if (subcommand === 'tasks') {
      // Return open tasks
      var tasks = core.db.prepare(
        "SELECT id, title, status, assignee, priority FROM dv_tasks WHERE status NOT IN ('done', 'cancelled') ORDER BY priority DESC, id DESC LIMIT 15"
      ).all();

      var taskLines = tasks.map(function (t) {
        var assignee = t.assignee ? ' :point_right: ' + t.assignee : ' (unassigned)';
        return '#' + t.id + ' [' + t.status + '] *' + t.title + '*' + assignee;
      });

      return res.json({
        response_type: 'in_channel',
        text: taskLines.length > 0 ? taskLines.join('\n') : 'No open tasks.'
      });
    }

    if (subcommand === 'assign') {
      // /mycelium assign <agent> <task description>
      var agent = parts[1] || '';
      var taskDesc = parts.slice(2).join(' ');

      if (!agent || !taskDesc) {
        return res.json({
          response_type: 'ephemeral',
          text: 'Usage: `/mycelium assign <agent-id> <task description>`'
        });
      }

      try {
        var r = core.db.prepare(
          "INSERT INTO dv_tasks (title, description, assignee, status, priority) VALUES (?, ?, ?, 'open', 'normal') RETURNING id"
        ).get(taskDesc, 'Created via Slack by ' + (req.body.user_name || 'unknown'), agent);

        core.emitEvent('task_created', 'slack:' + (req.body.user_name || 'unknown'), null,
          'Task created via Slack: ' + taskDesc,
          { task_id: r.id, assignee: agent });

        return res.json({
          response_type: 'in_channel',
          text: ':white_check_mark: Task #' + r.id + ' created and assigned to *' + agent + '*: ' + taskDesc
        });
      } catch (e) {
        return res.json({
          response_type: 'ephemeral',
          text: ':x: Failed to create task: ' + e.message
        });
      }
    }

    // Unknown subcommand
    res.json({
      response_type: 'ephemeral',
      text: 'Available commands:\n`/mycelium status` — agent statuses\n`/mycelium tasks` — open tasks\n`/mycelium assign <agent> <description>` — create & assign a task'
    });
  });

  // GET /slack/channels — list channel mappings
  router.get('/channels', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listChannelMaps());
  });

  // POST /slack/channels — create channel mapping (admin only)
  router.post('/channels', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var myceliumChannelId = req.body.mycelium_channel_id;
    var slackChannelId = req.body.slack_channel_id;
    var direction = req.body.direction || 'both';

    if (!slackChannelId) return apiError(res, 400, 'slack_channel_id is required');
    if (['both', 'to_slack', 'to_mycelium'].indexOf(direction) === -1) {
      return apiError(res, 400, 'direction must be both, to_slack, or to_mycelium');
    }

    var id = db.createChannelMap(myceliumChannelId, slackChannelId, direction);
    core.emitEvent('slack_channel_mapped', who, null,
      who + ' mapped Mycelium channel #' + myceliumChannelId + ' to Slack ' + slackChannelId,
      { map_id: id, mycelium_channel_id: myceliumChannelId, slack_channel_id: slackChannelId });
    res.json({ ok: true, id: id });
  });

  // PUT /slack/channels/:id — update mapping (admin only)
  router.put('/channels/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.getChannelMap(id)) return apiError(res, 404, 'Channel mapping not found');

    var updates = {};
    if (req.body.direction !== undefined) updates.direction = req.body.direction;
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
    if (req.body.mycelium_channel_id !== undefined) updates.mycelium_channel_id = req.body.mycelium_channel_id;
    if (req.body.slack_channel_id !== undefined) updates.slack_channel_id = req.body.slack_channel_id;
    db.updateChannelMap(id, updates);
    res.json({ ok: true, mapping: db.getChannelMap(id) });
  });

  // DELETE /slack/channels/:id — remove mapping (admin only)
  router.delete('/channels/:id', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;
    var id = parseIntParam(req.params.id);
    if (!db.getChannelMap(id)) return apiError(res, 404, 'Channel mapping not found');
    db.deleteChannelMap(id);
    core.emitEvent('slack_channel_unmapped', who, null,
      who + ' removed Slack channel mapping #' + id, { map_id: id });
    res.json({ ok: true });
  });

  // GET /slack/messages — message log
  router.get('/messages', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    res.json(db.listMessages({
      direction: req.query.direction || undefined,
      slack_channel: req.query.slack_channel || undefined,
      limit: parseInt(req.query.limit) || 50
    }));
  });

  // POST /slack/test — send test message to default Slack channel (admin only)
  router.post('/test', function (req, res) {
    var who = checkAdmin(req, res);
    if (!who) return;

    var botToken = getConfig('bot_token');
    var defaultChannel = getConfig('default_channel');
    if (!botToken) return apiError(res, 400, 'Bot token not configured');
    if (!defaultChannel) return apiError(res, 400, 'Default channel not configured');

    var message = req.body.message || 'Mycelium Slack Bridge test message — connection is working.';

    postToSlack(botToken, defaultChannel, message)
      .then(function (result) {
        if (result.ok) {
          db.logMessage('outbound', null, result.ts || '', defaultChannel, message, who);
          res.json({ ok: true, ts: result.ts });
        } else {
          res.json({ ok: false, error: result.error || 'Slack API error' });
        }
      })
      .catch(function (e) {
        apiError(res, 500, 'Failed to post to Slack: ' + e.message);
      });
  });

  // GET /slack/widgets/status — widget data for dashboard
  router.get('/widgets/status', function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;

    var mapCount = core.db.prepare('SELECT COUNT(*) as count FROM dv_slack_channel_map WHERE enabled = 1').get().count;
    var todayMessages = core.db.prepare(
      "SELECT COUNT(*) as count FROM dv_slack_messages WHERE direction = 'outbound' AND created_at >= date('now')"
    ).get().count;

    res.json({
      channel_maps: mapCount,
      messages_forwarded_today: todayMessages
    });
  });

  return router;
}

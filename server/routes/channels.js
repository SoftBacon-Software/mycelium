// Channel routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-05; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  createChannel, getChannel, getChannelBySlug, listChannels, updateChannel,
  deleteChannel, addChannelMember, removeChannelMember, listChannelMembers,
  isChannelMember, markChannelRead, getUnreadCounts, getLatestChannelMessageId,
  listChannelMessages, createChannelMessage, getOrCreateDmChannel,
} from '../db.js';

export function registerChannelRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkAdmin, escapeHtml, parseIntParam,
    parseLimit, validateEnum, emitEvent, getAdminDisplayName, CHANNEL_STATUSES,
  } = deps;

  // ======== CHANNELS ========

  // GET /channels/unread — unread counts (MUST be before :id routes)
  router.get('/channels/unread', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var counts = getUnreadCounts(who);
    var result = {};
    for (var c of counts) {
      result[c.channel_id] = { name: c.name, slug: c.slug, unread: c.unread };
    }
    res.json(result);
  }));

  // GET /channels — list channels
  router.get('/channels', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var filters = {
      type: req.query.type,
      status: req.query.status,
      member: req.query.member,
      limit: parseLimit(req.query.limit, 50),
      offset: parseInt(req.query.offset) || 0
    };
    var channels = listChannels(filters);
    // DM channels are private — filter to only include those where the authenticated user is a member.
    // Skip filtering if an explicit member filter is already set, or caller is __system__.
    if (!filters.member && who !== '__system__') {
      channels = channels.filter(function (c) {
        if (c.type !== 'dm') return true;
        return isChannelMember(c.id, who);
      });
    }
    res.json(channels);
  }));

  // POST /channels — create channel
  router.post('/channels', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var name = escapeHtml(req.body.name);
    var slug = escapeHtml(req.body.slug);
    if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
    var existing = getChannelBySlug(slug);
    if (existing) return res.status(409).json({ error: 'Channel slug already exists', channel_id: existing.id });
    var type = req.body.type || 'general';
    var description = escapeHtml(req.body.description || '');
    var createdBy = who;
    var id = createChannel(name, slug, type, req.body.linked_type || null, req.body.linked_id || null, description, createdBy);
    if (req.body.members && Array.isArray(req.body.members)) {
      for (var m of req.body.members) {
        addChannelMember(id, m.user_id, m.user_type || 'agent', m.role || 'member');
      }
    }
    emitEvent('channel_created', createdBy, null, createdBy + ' created channel ' + name, { channel_id: id });
    res.json({ ok: true, id: id, name: name, slug: slug });
  }));

  // POST /channels/dm — start or get a DM channel with another user
  router.post('/channels/dm', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var targetId = req.body.user_id || req.body.target;
    if (!targetId) return res.status(400).json({ error: 'user_id is required' });
    var myType = req._authAgentId ? 'agent' : 'operator';
    var targetType = req.body.user_type || 'operator';
    var channelId = getOrCreateDmChannel(who, targetId, myType, targetType);
    var channel = getChannel(channelId);
    res.json({ ok: true, channel_id: channelId, channel: channel });
  }));

  // GET /channels/:id — channel detail + member count
  router.get('/channels/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    var members = listChannelMembers(channel.id);
    channel.members = members;
    channel.member_count = members.length;
    res.json(channel);
  }));

  // PUT /channels/:id — update channel
  router.put('/channels/:id', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!validateEnum(res, req.body.status, CHANNEL_STATUSES, 'status')) return;
    var fields = {};
    if (req.body.name !== undefined) fields.name = escapeHtml(req.body.name);
    if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
    if (req.body.status !== undefined) fields.status = req.body.status;
    updateChannel(channel.id, fields);
    res.json({ ok: true, id: channel.id });
  }));

  // DELETE /channels/:id — delete channel (admin only, protected slugs cannot be deleted)
  var PROTECTED_CHANNEL_SLUGS = ['general', 'admin'];
  router.delete('/channels/:id', asyncHandler(function (req, res) {
    if (!checkAdmin(req, res)) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (PROTECTED_CHANNEL_SLUGS.includes(channel.slug)) return res.status(403).json({ error: 'Cannot delete protected channel' });
    deleteChannel(channel.id);
    emitEvent('channel_deleted', getAdminDisplayName(req), null, 'Deleted channel ' + channel.name, { channel_id: channel.id });
    res.json({ ok: true, deleted: channel.id });
  }));

  // -- Channel Members --

  router.get('/channels/:id/members', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    res.json(listChannelMembers(channel.id));
  }));

  router.post('/channels/:id/members', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    var userId = req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    var added = addChannelMember(channel.id, userId, req.body.user_type || 'agent', req.body.role || 'member');
    res.json({ ok: true, added: added, channel_id: channel.id, user_id: userId });
  }));

  router.delete('/channels/:id/members/:userId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    var removed = removeChannelMember(channel.id, req.params.userId);
    res.json({ ok: true, removed: removed });
  }));

  // -- Channel Messages --

  router.get('/channels/:id/messages', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    // DM channels are private — only members can read messages
    if (channel.type === 'dm' && who !== '__system__' && !isChannelMember(channel.id, who)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    var filters = {
      before: req.query.before ? parseIntParam(req.query.before) : undefined,
      after: req.query.after ? parseIntParam(req.query.after) : undefined,
      limit: parseLimit(req.query.limit, 50)
    };
    var messages = listChannelMessages(channel.id, filters);
    res.json(messages);
  }));

  router.post('/channels/:id/messages', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    // DM channels are private — only members can post
    if (channel.type === 'dm' && who !== '__system__' && !isChannelMember(channel.id, who)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    var content = req.body.content;
    if (!content) return res.status(400).json({ error: 'content is required' });
    var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
    var id = createChannelMessage(channel.id, who, content, metadata);
    emitEvent('channel_message', who, null, who + ' posted in ' + channel.name, { channel_id: channel.id, message_id: id });
    res.json({ ok: true, id: id, channel_id: channel.id });
  }));

  // -- Channel Read Tracking --

  router.put('/channels/:id/read', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var channel = getChannel(parseIntParam(req.params.id));
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    var messageId = req.body.message_id || getLatestChannelMessageId(channel.id);
    markChannelRead(channel.id, who, messageId);
    res.json({ ok: true, channel_id: channel.id, last_read_message_id: messageId });
  }));
}

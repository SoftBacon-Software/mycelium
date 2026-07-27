// =============== MYCELIUM — DB entity: channels, members, messages, seeding ===============
// Extracted from server/db.js (Wave 3 of the decomposition). Coupling:
// `ensureDefaultChannels` + `autoCreateEntityChannel` import `listOperators`
// (operators) and `listAgents` (agents). `ensureDefaultChannels` is one of the
// three initDB seeds — the barrel's initDB calls this import directly. Channel
// *messages* read/write the `messages` table by raw SQL — stays here (mirrors
// routes/channels.js). The functions below use the live `db` + `buildUpdate`
// bindings from ./core.js. Bodies moved VERBATIM — bare db.prepare(...) /
// buildUpdate(...) keep working via the ESM live bindings (initDBConnection
// assigns db; nobody else may). The barrel server/db.js re-exports these via
// `export * from './db/channels.js'` so no consumer changes a single import.
import { db, buildUpdate } from './core.js';
import { listOperators } from './operators.js';
import { listAgents } from './agents.js';

// -- Channels --

export function createChannel(name, slug, type, linkedType, linkedId, description, createdBy) {
  var result = db.prepare(
    "INSERT INTO channels (name, slug, type, linked_type, linked_id, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(name, slug, type || 'general', linkedType || null, linkedId || null, description || '', createdBy);
  return result.id;
}

export function getChannel(id) {
  return db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
}

export function getChannelBySlug(slug) {
  return db.prepare("SELECT * FROM channels WHERE slug = ?").get(slug);
}

export function getChannelByLink(linkedType, linkedId) {
  return db.prepare("SELECT * FROM channels WHERE linked_type = ? AND linked_id = ?").get(linkedType, linkedId);
}

export function listChannels(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status && filters.status !== 'all') { where.push('status = ?'); params.push(filters.status); }
  else if (!filters.status) { where.push("status = 'active'"); }
  if (filters.member) {
    where.push('id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)');
    params.push(filters.member);
  }
  var limit = Math.min(filters.limit || 50, 500);
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM channels WHERE ' + where.join(' AND ') + ' ORDER BY created_at ASC LIMIT ? OFFSET ?').all(...params);
}

export function updateChannel(id, fields) {
  buildUpdate('channels', id, fields, ['name', 'description', 'status']);
}

export function deleteChannel(id) {
  db.prepare("DELETE FROM channels WHERE id = ?").run(id);
}

// -- Channel Members --

export function addChannelMember(channelId, userId, userType, role) {
  try {
    db.prepare(
      "INSERT INTO channel_members (channel_id, user_id, user_type, role) VALUES (?, ?, ?, ?)"
    ).run(channelId, userId, userType || 'agent', role || 'member');
    return true;
  } catch (e) {
    return false;
  }
}

export function removeChannelMember(channelId, userId) {
  var result = db.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
  return result.changes > 0;
}

export function listChannelMembers(channelId) {
  return db.prepare("SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at ASC").all(channelId);
}

export function isChannelMember(channelId, userId) {
  var row = db.prepare("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?").get(channelId, userId);
  return !!row;
}

export function getChannelsByUser(userId) {
  return db.prepare(
    "SELECT c.*, cm.role as member_role FROM channels c JOIN channel_members cm ON c.id = cm.channel_id WHERE cm.user_id = ? AND c.status = 'active' ORDER BY c.created_at ASC"
  ).all(userId);
}

// -- Channel Read Tracking --

export function markChannelRead(channelId, userId, messageId) {
  db.prepare(
    "INSERT INTO channel_reads (channel_id, user_id, last_read_at, last_read_message_id) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = datetime('now'), last_read_message_id = excluded.last_read_message_id"
  ).run(channelId, userId, messageId || 0);
}

export function getUnreadCounts(userId) {
  return db.prepare(
    "SELECT c.id as channel_id, c.name, c.slug, COUNT(m.id) as unread FROM channels c JOIN channel_members cm ON c.id = cm.channel_id LEFT JOIN messages m ON m.channel_id = c.id AND m.id > COALESCE((SELECT last_read_message_id FROM channel_reads WHERE channel_id = c.id AND user_id = ?), 0) WHERE cm.user_id = ? AND c.status = 'active' GROUP BY c.id"
  ).all(userId, userId);
}

export function getLatestChannelMessageId(channelId) {
  var row = db.prepare("SELECT MAX(id) as max_id FROM messages WHERE channel_id = ?").get(channelId);
  return row ? (row.max_id || 0) : 0;
}

// -- Channel Messages --

export function listChannelMessages(channelId, filters) {
  var where = ['channel_id = ?'];
  var params = [channelId];
  if (filters.before) { where.push('id < ?'); params.push(filters.before); }
  if (filters.after) { where.push('id > ?'); params.push(filters.after); }
  var limit = Math.min(filters.limit || 50, 500);
  params.push(limit);
  return db.prepare(
    'SELECT * FROM messages WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}

export function createChannelMessage(channelId, fromAgent, content, metadata) {
  var result = db.prepare(
    "INSERT INTO messages (channel_id, from_agent, content, metadata, msg_type) VALUES (?, ?, ?, ?, 'message') RETURNING id"
  ).get(channelId, fromAgent, content, metadata || '{}');
  return result.id;
}

// -- Channel Seeding + Auto-Creation --

export function ensureDefaultChannels() {
  var defaults = [
    { name: '#general', slug: 'general', type: 'general', description: 'General discussion' },
    { name: '#admin', slug: 'admin', type: 'announcement', description: 'Admin coordination' }
  ];
  for (var def of defaults) {
    var existing = getChannelBySlug(def.slug);
    if (!existing) {
      var id = createChannel(def.name, def.slug, def.type, null, null, def.description, 'system');
      var operators = listOperators();
      for (var op of operators) {
        addChannelMember(id, op.id, 'operator', 'admin');
      }
      if (def.slug === 'general') {
        var agents = listAgents();
        for (var agent of agents) {
          addChannelMember(id, agent.id, 'agent', 'member');
        }
      }
    }
  }
}

export function autoCreateEntityChannel(linkedType, linkedId, name, createdBy, memberIds) {
  var slug = linkedType + '-' + linkedId;
  var existing = getChannelBySlug(slug);
  if (existing) return existing.id;
  var channelName = name || '#' + slug;
  var id = createChannel(channelName, slug, linkedType, linkedType, linkedId, '', createdBy);
  var operators = listOperators();
  for (var op of operators) {
    addChannelMember(id, op.id, 'operator', 'admin');
  }
  if (memberIds) {
    for (var mid of memberIds) {
      if (mid) addChannelMember(id, mid, 'agent', 'member');
    }
  }
  return id;
}

export function getOrCreateDmChannel(userA, userB, userAType, userBType) {
  // Find any existing active DM channel that has exactly these two participants (case-insensitive).
  // This prevents duplicate channels when usernames differ by case or creation order.
  var existing = db.prepare(`
    SELECT c.id FROM channels c
    WHERE c.type = 'dm' AND c.status = 'active'
      AND (SELECT COUNT(*) FROM channel_members m
           WHERE m.channel_id = c.id AND LOWER(m.user_id) IN (LOWER(?), LOWER(?))) = 2
      AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) = 2
    ORDER BY c.id ASC
    LIMIT 1
  `).get(userA, userB);
  if (existing) {
    // Ensure both users are members (handles legacy channels missing a member row)
    addChannelMember(existing.id, userA, userAType || 'agent', 'member');
    addChannelMember(existing.id, userB, userBType || 'agent', 'member');
    return existing.id;
  }
  // Create new DM channel — use case-insensitive sort for canonical slug
  var sorted = [userA, userB].sort(function (a, b) {
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  });
  var slug = 'dm-' + sorted[0].toLowerCase() + '-' + sorted[1].toLowerCase();
  // Check slug in case a channel exists that our member query didn't catch (e.g. single-member DM)
  var bySlug = getChannelBySlug(slug);
  if (bySlug) {
    addChannelMember(bySlug.id, userA, userAType || 'agent', 'member');
    addChannelMember(bySlug.id, userB, userBType || 'agent', 'member');
    return bySlug.id;
  }
  var id = createChannel('DM: ' + sorted[0] + ' & ' + sorted[1], slug, 'dm', null, null, '', userA);
  addChannelMember(id, userA, userAType || 'agent', 'member');
  addChannelMember(id, userB, userBType || 'agent', 'member');
  return id;
}

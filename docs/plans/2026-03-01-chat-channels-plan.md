# Chat Channels Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the flat message list with Discord-style channels — messages belong to named channels linked to plans, bugs, tasks, or general conversation, with full membership and unread tracking.

**Architecture:** Three new tables (`dv_channels`, `dv_channel_members`, `dv_channel_reads`) plus a `channel_id` column on `dv_messages`. Channel CRUD, membership, and read-tracking exposed as REST endpoints under `/api/mycelium/channels`. Existing message routes get backward-compatible `channel_id` support. Auto-creation hooks on plan/bug/task creation. Default channels seeded on boot.

**Tech Stack:** Express.js, better-sqlite3, existing auth middleware (`checkAgent`, `checkAdmin`, `checkAgentOrAdmin`)

**Design Doc:** `D:/mycelium/docs/plans/2026-03-01-chat-channels-design.md`

**No test framework configured.** Verification uses `curl` against the local dev server (`localhost:3002`). Start the server with `cd D:/mycelium && node server/index.js` before testing.

---

## Task 1: Schema + Migration

Add the three new tables and the `channel_id` column on `dv_messages`.

**Files:**
- Modify: `server/schema.sql` (append after line 360)
- Modify: `server/db.js` (add migration at ~line 54, add index at ~line 64)

**Step 1: Add tables to schema.sql**

Append to the end of `server/schema.sql`:

```sql
-- Chat channels
CREATE TABLE IF NOT EXISTS dv_channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL DEFAULT 'general',
  linked_type TEXT,
  linked_id   INTEGER,
  description TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dv_channels_slug ON dv_channels(slug);
CREATE INDEX IF NOT EXISTS idx_dv_channels_type ON dv_channels(type);
CREATE INDEX IF NOT EXISTS idx_dv_channels_linked ON dv_channels(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_dv_channels_status ON dv_channels(status);

-- Channel membership
CREATE TABLE IF NOT EXISTS dv_channel_members (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  INTEGER NOT NULL REFERENCES dv_channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  user_type   TEXT NOT NULL DEFAULT 'agent',
  role        TEXT NOT NULL DEFAULT 'member',
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_dv_channel_members_channel ON dv_channel_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_dv_channel_members_user ON dv_channel_members(user_id);

-- Channel read tracking
CREATE TABLE IF NOT EXISTS dv_channel_reads (
  channel_id          INTEGER NOT NULL REFERENCES dv_channels(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL,
  last_read_at        TEXT,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  UNIQUE(channel_id, user_id)
);
```

**Step 2: Add migration for dv_messages.channel_id**

In `server/db.js`, add to the `migrations` array (after the last entry at ~line 53):

```javascript
["dv_messages", "channel_id", "INTEGER"],
```

And add the index after the existing migration indexes (~line 64):

```javascript
try { db.exec('CREATE INDEX IF NOT EXISTS idx_dv_messages_channel ON dv_messages(channel_id)'); } catch (e) {}
```

**Step 3: Verify**

Run:
```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); console.log('OK'); process.exit(0); });"
```
Expected: `OK` with no errors.

**Step 4: Commit**

```bash
git add server/schema.sql server/db.js
git commit -m "feat(channels): schema for channels, members, reads tables"
```

---

## Task 2: Channel CRUD DB Functions

Add database functions for creating, reading, updating, and deleting channels.

**Files:**
- Modify: `server/db.js` (add after the Team Chat section, ~line 907)

**Step 1: Add channel CRUD functions**

Add after the `listDvTeamChat` function:

```javascript
// -- Channels --

export function createChannel(name, slug, type, linkedType, linkedId, description, createdBy) {
  var result = db.prepare(
    "INSERT INTO dv_channels (name, slug, type, linked_type, linked_id, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(name, slug, type || 'general', linkedType || null, linkedId || null, description || '', createdBy);
  return result.id;
}

export function getChannel(id) {
  return db.prepare("SELECT * FROM dv_channels WHERE id = ?").get(id);
}

export function getChannelBySlug(slug) {
  return db.prepare("SELECT * FROM dv_channels WHERE slug = ?").get(slug);
}

export function getChannelByLink(linkedType, linkedId) {
  return db.prepare("SELECT * FROM dv_channels WHERE linked_type = ? AND linked_id = ?").get(linkedType, linkedId);
}

export function listChannels(filters) {
  var where = ['1=1'];
  var params = [];
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  else { where.push("status = 'active'"); }
  if (filters.member) {
    where.push('id IN (SELECT channel_id FROM dv_channel_members WHERE user_id = ?)');
    params.push(filters.member);
  }
  var limit = filters.limit || 50;
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_channels WHERE ' + where.join(' AND ') + ' ORDER BY created_at ASC LIMIT ? OFFSET ?').all(...params);
}

export function updateChannel(id, fields) {
  var sets = [];
  var values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare('UPDATE dv_channels SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteChannel(id) {
  db.prepare("DELETE FROM dv_channels WHERE id = ?").run(id);
}
```

**Step 2: Commit**

```bash
git add server/db.js
git commit -m "feat(channels): channel CRUD db functions"
```

---

## Task 3: Membership + Read Tracking DB Functions

**Files:**
- Modify: `server/db.js` (append after channel CRUD)

**Step 1: Add membership functions**

```javascript
// -- Channel Members --

export function addChannelMember(channelId, userId, userType, role) {
  try {
    db.prepare(
      "INSERT INTO dv_channel_members (channel_id, user_id, user_type, role) VALUES (?, ?, ?, ?)"
    ).run(channelId, userId, userType || 'agent', role || 'member');
    return true;
  } catch (e) {
    return false; // UNIQUE constraint = already a member
  }
}

export function removeChannelMember(channelId, userId) {
  var result = db.prepare("DELETE FROM dv_channel_members WHERE channel_id = ? AND user_id = ?").run(channelId, userId);
  return result.changes > 0;
}

export function listChannelMembers(channelId) {
  return db.prepare("SELECT * FROM dv_channel_members WHERE channel_id = ? ORDER BY joined_at ASC").all(channelId);
}

export function isChannelMember(channelId, userId) {
  var row = db.prepare("SELECT 1 FROM dv_channel_members WHERE channel_id = ? AND user_id = ?").get(channelId, userId);
  return !!row;
}

export function getChannelsByUser(userId) {
  return db.prepare(
    "SELECT c.*, cm.role as member_role FROM dv_channels c JOIN dv_channel_members cm ON c.id = cm.channel_id WHERE cm.user_id = ? AND c.status = 'active' ORDER BY c.created_at ASC"
  ).all(userId);
}
```

**Step 2: Add read tracking functions**

```javascript
// -- Channel Read Tracking --

export function markChannelRead(channelId, userId, messageId) {
  db.prepare(
    "INSERT INTO dv_channel_reads (channel_id, user_id, last_read_at, last_read_message_id) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = datetime('now'), last_read_message_id = excluded.last_read_message_id"
  ).run(channelId, userId, messageId || 0);
}

export function getUnreadCounts(userId) {
  return db.prepare(
    "SELECT c.id as channel_id, c.name, c.slug, COUNT(m.id) as unread FROM dv_channels c JOIN dv_channel_members cm ON c.id = cm.channel_id LEFT JOIN dv_messages m ON m.channel_id = c.id AND m.id > COALESCE((SELECT last_read_message_id FROM dv_channel_reads WHERE channel_id = c.id AND user_id = ?), 0) WHERE cm.user_id = ? AND c.status = 'active' GROUP BY c.id"
  ).all(userId, userId);
}

export function getLatestChannelMessageId(channelId) {
  var row = db.prepare("SELECT MAX(id) as max_id FROM dv_messages WHERE channel_id = ?").get(channelId);
  return row ? (row.max_id || 0) : 0;
}
```

**Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat(channels): membership and read tracking db functions"
```

---

## Task 4: Channel Message DB Functions + Legacy Compat Queries

**Files:**
- Modify: `server/db.js`

**Step 1: Add channel message functions**

```javascript
// -- Channel Messages --

export function listChannelMessages(channelId, filters) {
  var where = ['channel_id = ?'];
  var params = [channelId];
  if (filters.before) { where.push('id < ?'); params.push(filters.before); }
  if (filters.after) { where.push('id > ?'); params.push(filters.after); }
  var limit = filters.limit || 50;
  params.push(limit);
  return db.prepare(
    'SELECT * FROM dv_messages WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}

export function createChannelMessage(channelId, fromAgent, content, metadata) {
  var result = db.prepare(
    "INSERT INTO dv_messages (channel_id, from_agent, content, metadata, msg_type) VALUES (?, ?, ?, ?, 'message') RETURNING id"
  ).get(channelId, fromAgent, content, metadata || '{}');
  return result.id;
}

export function listGeneralChannelMessages(generalChannelId, filters) {
  var where = ['(channel_id = ? OR channel_id IS NULL)', "msg_type != 'chat'"];
  var params = [generalChannelId];
  if (filters.before) { where.push('id < ?'); params.push(filters.before); }
  if (filters.after) { where.push('id > ?'); params.push(filters.after); }
  params.push(filters.limit || 50);
  return db.prepare(
    'SELECT * FROM dv_messages WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}

export function listTeamChatChannelMessages(teamChatChannelId, filters) {
  var where = ["(channel_id = ? OR (msg_type = 'chat' AND channel_id IS NULL))"];
  var params = [teamChatChannelId];
  if (filters.before) { where.push('id < ?'); params.push(filters.before); }
  if (filters.after) { where.push('id > ?'); params.push(filters.after); }
  params.push(filters.limit || 50);
  return db.prepare(
    'SELECT * FROM dv_messages WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?'
  ).all(...params);
}
```

**Step 2: Update createDvMessage to accept channelId**

Modify the existing `createDvMessage` function (~line 426). Add `channelId` as the 8th parameter:

Change signature from:
```javascript
export function createDvMessage(fromAgent, toAgent, threadId, game, content, metadata, msgType) {
```
To:
```javascript
export function createDvMessage(fromAgent, toAgent, threadId, game, content, metadata, msgType, channelId) {
```

Update the first INSERT (msgType branch) to include channel_id:
```javascript
    var result = db.prepare(
      "INSERT INTO dv_messages (from_agent, to_agent, thread_id, game, content, metadata, msg_type, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(fromAgent, toAgent || null, threadId || null, game || null, content, metadata || '{}', msgType, channelId || null);
```

Update the second INSERT (default branch). **Must use `db.prepare` directly** (not `stmt()`) because the SQL changed:
```javascript
  var result = db.prepare(
    "INSERT INTO dv_messages (from_agent, to_agent, thread_id, game, content, metadata, channel_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(fromAgent, toAgent || null, threadId || null, game || null, content, metadata || '{}', channelId || null);
```

Delete or rename the old `stmt('dvCreateMessage', ...)` cached statement — it has the wrong column count now.

**Step 3: Update listDvMessages to support channel_id filter**

In the existing `listDvMessages` function (~line 463), add after the `filters.since` check:

```javascript
  if (filters.channel_id) { where.push('channel_id = ?'); params.push(filters.channel_id); }
```

**Step 4: Commit**

```bash
git add server/db.js
git commit -m "feat(channels): channel message functions + update createDvMessage with channelId"
```

---

## Task 5: Default Channel Seeding

Seed `#general`, `#admin`, `#team-chat` on boot. Add auto-creation helpers.

**Files:**
- Modify: `server/db.js` (add functions + call from initDB)

**Step 1: Add ensureDefaultChannels and autoCreateEntityChannel**

```javascript
// -- Channel Seeding + Auto-Creation --

export function ensureDefaultChannels() {
  var defaults = [
    { name: '#general', slug: 'general', type: 'general', description: 'General discussion' },
    { name: '#admin', slug: 'admin', type: 'announcement', description: 'Admin coordination' },
    { name: '#team-chat', slug: 'team-chat', type: 'announcement', description: 'Team chat' }
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
  var sorted = [userA, userB].sort();
  var slug = 'dm-' + sorted[0] + '-' + sorted[1];
  var existing = getChannelBySlug(slug);
  if (existing) return existing.id;
  var id = createChannel('DM: ' + sorted[0] + ' & ' + sorted[1], slug, 'dm', null, null, '', userA);
  addChannelMember(id, userA, userAType || 'agent', 'member');
  addChannelMember(id, userB, userBType || 'agent', 'member');
  return id;
}
```

**Step 2: Call from initDB**

In `initDB()`, add after the agent role updates (~line 107, before `console.log('Mycelium DB initialized...')`:

```javascript
  ensureDefaultChannels();
```

**Step 3: Verify**

```bash
cd D:/mycelium && node -e "import('./server/db.js').then(db => { db.initDB(); var ch = db.getChannelBySlug('general'); console.log('general:', ch ? ch.id : 'MISSING'); process.exit(0); });"
```

Expected: `general: <number>`

**Step 4: Commit**

```bash
git add server/db.js
git commit -m "feat(channels): seed default channels on boot + auto-creation helpers"
```

---

## Task 6: Channel Routes (CRUD + Members + Messages + Reads)

Add all channel REST endpoints.

**Files:**
- Modify: `server/routes/mycelium.js`

**Step 1: Add imports**

Add to the import block at the top (~lines 30-64), alongside existing imports:

```javascript
  createChannel, getChannel, getChannelBySlug, getChannelByLink,
  listChannels, updateChannel, deleteChannel,
  addChannelMember, removeChannelMember, listChannelMembers,
  isChannelMember, getChannelsByUser,
  markChannelRead, getUnreadCounts, getLatestChannelMessageId,
  listChannelMessages, createChannelMessage,
  listGeneralChannelMessages, listTeamChatChannelMessages,
  autoCreateEntityChannel, getOrCreateDmChannel,
```

**Step 2: Add all channel routes**

Insert a new `// ======== CHANNELS ========` section after the Team Chat routes (after line 1491) and **before** the Webhooks section. Registration order matters — `/channels/unread` must come before `/channels/:id`.

```javascript
// ======== CHANNELS ========

// GET /channels/unread — unread counts (MUST be before :id routes)
router.get('/channels/unread', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var counts = getUnreadCounts(who);
  var result = {};
  for (var c of counts) {
    result[c.channel_id] = { name: c.name, slug: c.slug, unread: c.unread };
  }
  res.json(result);
});

// GET /channels — list channels
router.get('/channels', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var filters = {
    type: req.query.type,
    status: req.query.status,
    member: req.query.member,
    limit: parseInt(req.query.limit) || 50,
    offset: parseInt(req.query.offset) || 0
  };
  res.json(listChannels(filters));
});

// POST /channels — create channel (admin only)
router.post('/channels', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var name = escapeHtml(req.body.name);
  var slug = escapeHtml(req.body.slug);
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
  var existing = getChannelBySlug(slug);
  if (existing) return res.status(409).json({ error: 'Channel slug already exists', channel_id: existing.id });
  var type = req.body.type || 'general';
  var description = escapeHtml(req.body.description || '');
  var createdBy = getAdminDisplayName(req);
  var id = createChannel(name, slug, type, req.body.linked_type || null, req.body.linked_id || null, description, createdBy);
  if (req.body.members && Array.isArray(req.body.members)) {
    for (var m of req.body.members) {
      addChannelMember(id, m.user_id, m.user_type || 'agent', m.role || 'member');
    }
  }
  emitEvent('channel_created', createdBy, null, createdBy + ' created channel ' + name, { channel_id: id });
  res.json({ ok: true, id: id, name: name, slug: slug });
});

// GET /channels/:id — channel detail + member count
router.get('/channels/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var members = listChannelMembers(channel.id);
  channel.members = members;
  channel.member_count = members.length;
  res.json(channel);
});

// PUT /channels/:id — update channel
router.put('/channels/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var fields = {};
  if (req.body.name !== undefined) fields.name = escapeHtml(req.body.name);
  if (req.body.description !== undefined) fields.description = escapeHtml(req.body.description);
  if (req.body.status !== undefined) fields.status = req.body.status;
  updateChannel(channel.id, fields);
  res.json({ ok: true, id: channel.id });
});

// DELETE /channels/:id — delete channel (admin only)
router.delete('/channels/:id', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  deleteChannel(channel.id);
  emitEvent('channel_deleted', getAdminDisplayName(req), null, 'Deleted channel ' + channel.name, { channel_id: channel.id });
  res.json({ ok: true, deleted: channel.id });
});

// -- Channel Members --

router.get('/channels/:id/members', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  res.json(listChannelMembers(channel.id));
});

router.post('/channels/:id/members', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var userId = req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id is required' });
  var added = addChannelMember(channel.id, userId, req.body.user_type || 'agent', req.body.role || 'member');
  res.json({ ok: true, added: added, channel_id: channel.id, user_id: userId });
});

router.delete('/channels/:id/members/:userId', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var removed = removeChannelMember(channel.id, req.params.userId);
  res.json({ ok: true, removed: removed });
});

// -- Channel Messages --

router.get('/channels/:id/messages', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var filters = {
    before: req.query.before ? parseInt(req.query.before) : undefined,
    after: req.query.after ? parseInt(req.query.after) : undefined,
    limit: parseInt(req.query.limit) || 50
  };
  var messages;
  if (channel.slug === 'general') {
    messages = listGeneralChannelMessages(channel.id, filters);
  } else if (channel.slug === 'team-chat') {
    messages = listTeamChatChannelMessages(channel.id, filters);
  } else {
    messages = listChannelMessages(channel.id, filters);
  }
  res.json(messages);
});

router.post('/channels/:id/messages', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var content = req.body.content;
  if (!content) return res.status(400).json({ error: 'content is required' });
  var metadata = req.body.metadata ? JSON.stringify(req.body.metadata) : '{}';
  var id = createChannelMessage(channel.id, who, content, metadata);
  emitEvent('channel_message', who, null, who + ' posted in ' + channel.name, { channel_id: channel.id, message_id: id });
  res.json({ ok: true, id: id, channel_id: channel.id });
});

// -- Channel Read Tracking --

router.put('/channels/:id/read', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var channel = getChannel(parseInt(req.params.id));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  var messageId = req.body.message_id || getLatestChannelMessageId(channel.id);
  markChannelRead(channel.id, who, messageId);
  res.json({ ok: true, channel_id: channel.id, last_read_message_id: messageId });
});
```

**Step 3: Verify**

Start server, then:

```bash
ADMIN_KEY="$ADMIN_KEY"
BASE="http://localhost:3002/api/mycelium"

# List channels
curl -s "$BASE/channels" -H "X-Admin-Key: $ADMIN_KEY"

# Get channel detail
curl -s "$BASE/channels/1" -H "X-Admin-Key: $ADMIN_KEY"

# Post to channel
curl -s -X POST "$BASE/channels/1/messages" \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"Hello channels!"}'

# Read channel messages
curl -s "$BASE/channels/1/messages" -H "X-Admin-Key: $ADMIN_KEY"

# Unread counts
curl -s "$BASE/channels/unread" -H "X-Admin-Key: $ADMIN_KEY"
```

**Step 4: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat(channels): all channel routes (CRUD, members, messages, reads)"
```

---

## Task 7: Backward Compat on Existing Message Routes

Modify `GET /messages` and `POST /messages` to support `channel_id`.

**Files:**
- Modify: `server/routes/mycelium.js` (~lines 745-786)

**Step 1: Update GET /messages**

In the `GET /messages` handler (~line 745), add `channel_id` to filters object:

```javascript
  if (req.query.channel_id) {
    filters.channel_id = parseInt(req.query.channel_id);
  }
```

**Step 2: Update POST /messages**

In the `POST /messages` handler (~line 760), before the `createDvMessage` call (~line 779), add channel routing logic:

```javascript
  // Route to channel
  var channelId = req.body.channel_id ? parseInt(req.body.channel_id) : null;
  if (!channelId && toAgent) {
    // DM: auto-create DM channel
    channelId = getOrCreateDmChannel(agentId, toAgent, 'agent', 'agent');
  }
  if (!channelId && !toAgent) {
    // Broadcast: route to #general
    var general = getChannelBySlug('general');
    if (general) channelId = general.id;
  }
```

Then update the `createDvMessage` call to pass `channelId`:

```javascript
  var id = createDvMessage(agentId, toAgent, threadId, game, content, metadata, msgType, channelId);
```

**Step 3: Verify**

```bash
# Old-style broadcast should go to #general
curl -s -X POST "$BASE/messages" \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"Old-style broadcast"}'

# Check it appears in #general
curl -s "$BASE/channels/1/messages?limit=1" -H "X-Admin-Key: $ADMIN_KEY"

# DM should create DM channel
curl -s -X POST "$BASE/messages" \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"DM test","to_agent":"hijack-claude"}'

curl -s "$BASE/channels?type=dm" -H "X-Admin-Key: $ADMIN_KEY"
```

**Step 4: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat(channels): backward-compatible channel_id on existing message routes"
```

---

## Task 8: Boot Payload + Admin Overview

Add channel data to boot and overview responses.

**Files:**
- Modify: `server/db.js` — update `getBootPayload()` and `getDvOverview()`

**Step 1: Update getBootPayload (~line 564)**

Before the return statement (~line 620), add:

```javascript
  var myChannels = getChannelsByUser(agentId);
  var unreadCounts = getUnreadCounts(agentId);
  var unreadMap = {};
  for (var uc of unreadCounts) {
    unreadMap[uc.channel_id] = uc.unread;
  }
  for (var ch of myChannels) {
    ch.unread = unreadMap[ch.id] || 0;
  }
```

Add to the return object:

```javascript
    channels: myChannels,
    unread_counts: unreadMap,
```

**Step 2: Update getDvOverview (~line 1111)**

Before the return statement (~line 1131), add:

```javascript
  var allChannels = listChannels({ limit: 200, status: undefined });
  var activeChannelCount = allChannels.filter(function (c) { return c.status === 'active'; }).length;
  var archivedChannelCount = allChannels.filter(function (c) { return c.status === 'archived'; }).length;
```

Note: Pass `status: undefined` so the filter doesn't default to 'active' only. Actually, looking at the `listChannels` function, when `filters.status` is falsy it defaults to active. For overview we want ALL channels. Add a special case: when `filters.status === 'all'`, skip the status filter:

Update `listChannels` in db.js:
```javascript
  if (filters.status && filters.status !== 'all') { where.push('status = ?'); params.push(filters.status); }
  else if (!filters.status) { where.push("status = 'active'"); }
  // if filters.status === 'all', no status filter
```

Then in getDvOverview:
```javascript
  var allChannels = listChannels({ limit: 200, status: 'all' });
```

Add to the return object:

```javascript
    channels: allChannels,
    channel_counts: { total: allChannels.length, active: activeChannelCount, archived: archivedChannelCount },
```

**Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat(channels): add channels to boot payload and admin overview"
```

---

## Task 9: Auto-Channel Hooks

Wire plan/bug/task creation to auto-create channels. Auto-add new agents to #general.

**Files:**
- Modify: `server/routes/mycelium.js`

**Step 1: Update POST /plans (~line 838)**

After `var id = createDvPlan(...)` (line 849), add:

```javascript
  var planMembers = [];
  if (owner) planMembers.push(owner);
  autoCreateEntityChannel('plan', id, '#plan-' + id + ': ' + title, agentId, planMembers);
```

**Step 2: Update POST /bugs (~line 1400)**

After `var id = createDvBug(...)` (line 1415), add:

```javascript
  var bugMembers = [who];
  if (assignee) bugMembers.push(assignee);
  autoCreateEntityChannel('bug', id, '#bug-' + id + ': ' + title, who, bugMembers);
```

**Step 3: Update POST /tasks (~line 330)**

After `var id = createDvTask(...)` (line 339), add:

```javascript
  var taskMembers = [agentId];
  if (req.body.assignee) taskMembers.push(req.body.assignee);
  autoCreateEntityChannel('task', id, '#task-' + id + ': ' + title, agentId, taskMembers);
```

**Step 4: Auto-add new agents to #general**

Find the `POST /admin/agents` route. After agent creation, add:

```javascript
  var generalChannel = getChannelBySlug('general');
  if (generalChannel) {
    addChannelMember(generalChannel.id, id, 'agent', 'member');
  }
```

**Step 5: Verify**

```bash
# Create a test task
curl -s -X POST "$BASE/tasks" \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Test channel auto-creation"}'

# Check for auto-created task channel
curl -s "$BASE/channels?type=task" -H "X-Admin-Key: $ADMIN_KEY"
```

**Step 6: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat(channels): auto-create channels on plan/bug/task creation"
```

---

## Task 10: Deploy + End-to-End Verification

**Step 1: Deploy**

```bash
cd D:/mycelium && railway up
```

**Step 2: Full verification**

```bash
ADMIN_KEY="$ADMIN_KEY"
BASE="https://mycelium.fyi/api/mycelium"

# Default channels exist
curl -s "$BASE/channels" -H "X-Admin-Key: $ADMIN_KEY"

# #general has members
curl -s "$BASE/channels/1/members" -H "X-Admin-Key: $ADMIN_KEY"

# Post and read
curl -s -X POST "$BASE/channels/1/messages" \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"Channels are live!"}'

# Unread counts
curl -s "$BASE/channels/unread" -H "X-Admin-Key: $ADMIN_KEY"

# Admin overview has channels
curl -s "$BASE/admin/overview" -H "X-Admin-Key: $ADMIN_KEY" | python -m json.tool | grep channel_counts
```

**Step 3: Announce to the network**

Broadcast message that channels are live.

---

## Route Registration Order (CRITICAL)

Express matches routes in registration order. These routes MUST be registered in this order:

1. `GET /channels/unread` (before `:id` to avoid "unread" matching as id)
2. `GET /channels`
3. `POST /channels`
4. `GET /channels/:id`
5. `PUT /channels/:id`
6. `DELETE /channels/:id`
7. `GET /channels/:id/members`
8. `POST /channels/:id/members`
9. `DELETE /channels/:id/members/:userId`
10. `GET /channels/:id/messages`
11. `POST /channels/:id/messages`
12. `PUT /channels/:id/read`

---

## Summary of Changes

| File | Changes |
|------|---------|
| `server/schema.sql` | +3 tables (`dv_channels`, `dv_channel_members`, `dv_channel_reads`), +7 indexes |
| `server/db.js` | +1 migration (`channel_id` on messages), +~20 functions (channel CRUD, members, reads, seeding, auto-create), boot/overview updates, `ensureDefaultChannels()` in `initDB` |
| `server/routes/mycelium.js` | +~12 new routes under `/channels`, modify `POST /messages` (channel routing + DM), modify `GET /messages` (channel_id filter), modify `POST /plans`, `POST /bugs`, `POST /tasks` (auto-create channels), modify `POST /admin/agents` (join #general) |

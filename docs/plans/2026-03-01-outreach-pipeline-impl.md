# Mycelium Outreach Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port wsac-agent outreach pipeline into Mycelium as a first-class platform feature with DB tables, API routes, and MCP tools.

**Architecture:** Add outreach tables to Mycelium SQLite, CRUD + pipeline action routes in Express, external API modules (YouTube, Hunter.io, Claude, Gmail) as server-side JS, and MCP tools in dioverse-mcp.

**Tech Stack:** Express, better-sqlite3, googleapis (YouTube + Gmail), @anthropic-ai/sdk, node-fetch

---

### Task 1: Schema + DB Functions

**Files:**
- Modify: `D:/mycelium/server/schema.sql` (append tables + indexes)
- Modify: `D:/mycelium/server/db.js` (add CRUD functions + migrations)

**Step 1: Add tables to schema.sql**

Append after the last CREATE INDEX:

```sql
-- Outreach contacts
CREATE TABLE IF NOT EXISTS dv_outreach_contacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT NOT NULL,
  campaign_id     INTEGER REFERENCES dv_outreach_campaigns(id),
  type            TEXT NOT NULL DEFAULT 'creator',
  name            TEXT NOT NULL,
  email           TEXT NOT NULL DEFAULT '',
  outlet          TEXT NOT NULL DEFAULT '',
  tier            TEXT NOT NULL DEFAULT '',
  archetype       TEXT NOT NULL DEFAULT '',
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'discovered',
  pitch_subject   TEXT NOT NULL DEFAULT '',
  pitch_body      TEXT NOT NULL DEFAULT '',
  last_content    TEXT NOT NULL DEFAULT '',
  key_assigned    TEXT NOT NULL DEFAULT '',
  pitch_sent_at   TEXT,
  followup_due_at TEXT,
  followup_sent_at TEXT,
  response_at     TEXT,
  outcome         TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outreach campaigns (per-project config)
CREATE TABLE IF NOT EXISTS dv_outreach_campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project         TEXT NOT NULL,
  name            TEXT NOT NULL,
  persona_prompt  TEXT NOT NULL DEFAULT '',
  game_facts      TEXT NOT NULL DEFAULT '',
  templates       TEXT NOT NULL DEFAULT '{}',
  config          TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'active',
  created_by      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_outreach_contacts_project ON dv_outreach_contacts(project);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_status ON dv_outreach_contacts(status);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_campaign ON dv_outreach_contacts(campaign_id);
CREATE INDEX IF NOT EXISTS idx_outreach_contacts_email ON dv_outreach_contacts(email);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_project ON dv_outreach_campaigns(project);
CREATE INDEX IF NOT EXISTS idx_outreach_campaigns_status ON dv_outreach_campaigns(status);
```

**Step 2: Add DB functions to db.js**

Add after the `getDvOverview()` function (~line 945), before the closing:

```javascript
// -- Outreach Campaigns --

export function createOutreachCampaign(project, name, personaPrompt, gameFacts, templates, config, createdBy) {
  var result = db.prepare(`INSERT INTO dv_outreach_campaigns (project, name, persona_prompt, game_facts, templates, config, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(project, name, personaPrompt || '', gameFacts || '', templates || '{}', config || '{}', createdBy || '');
  return result.id;
}

export function getOutreachCampaign(id) {
  return db.prepare('SELECT * FROM dv_outreach_campaigns WHERE id = ?').get(id);
}

export function listOutreachCampaigns(filters) {
  var where = ['1=1']; var params = [];
  if (filters.project) { where.push('project = ?'); params.push(filters.project); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  params.push(filters.limit || 50);
  return db.prepare('SELECT * FROM dv_outreach_campaigns WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
}

export function updateOutreachCampaign(id, fields) {
  var sets = ["updated_at = datetime('now')"]; var values = [];
  for (var key of ['name','persona_prompt','game_facts','templates','config','status']) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  values.push(id);
  return db.prepare('UPDATE dv_outreach_campaigns SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

// -- Outreach Contacts --

export function createOutreachContact(fields) {
  var result = db.prepare(`INSERT INTO dv_outreach_contacts
    (project, campaign_id, type, name, email, outlet, tier, archetype, subscriber_count, status, last_content, notes, metadata, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
    fields.project, fields.campaign_id || null, fields.type || 'creator', fields.name,
    fields.email || '', fields.outlet || '', fields.tier || '', fields.archetype || '',
    fields.subscriber_count || 0, fields.status || 'discovered', fields.last_content || '',
    fields.notes || '', fields.metadata || '{}', fields.created_by || ''
  );
  return result.id;
}

export function getOutreachContact(id) {
  return db.prepare('SELECT * FROM dv_outreach_contacts WHERE id = ?').get(id);
}

export function listOutreachContacts(filters) {
  var where = ['1=1']; var params = [];
  if (filters.project) { where.push('project = ?'); params.push(filters.project); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  if (filters.type) { where.push('type = ?'); params.push(filters.type); }
  if (filters.campaign_id) { where.push('campaign_id = ?'); params.push(filters.campaign_id); }
  var limit = filters.limit || 50;
  var offset = filters.offset || 0;
  params.push(limit, offset);
  return db.prepare('SELECT * FROM dv_outreach_contacts WHERE ' + where.join(' AND ') + ' ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(...params);
}

export function updateOutreachContact(id, fields) {
  var sets = ["updated_at = datetime('now')"]; var values = [];
  var allowed = ['name','email','outlet','tier','archetype','subscriber_count','status',
    'pitch_subject','pitch_body','last_content','key_assigned','pitch_sent_at',
    'followup_due_at','followup_sent_at','response_at','outcome','notes','metadata','campaign_id'];
  for (var key of allowed) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  values.push(id);
  return db.prepare('UPDATE dv_outreach_contacts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
}

export function deleteOutreachContact(id) {
  return db.prepare('DELETE FROM dv_outreach_contacts WHERE id = ?').run(id);
}

export function countOutreachContacts(project) {
  var rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM dv_outreach_contacts WHERE project = ? GROUP BY status'
  ).all(project);
  var counts = {};
  for (var r of rows) counts[r.status] = r.count;
  return counts;
}

export function findOutreachContactByEmail(project, email) {
  return db.prepare('SELECT * FROM dv_outreach_contacts WHERE project = ? AND email = ?').get(project, email);
}
```

**Step 3: Add imports to routes/mycelium.js**

Add to the import block at line 24:

```javascript
  createOutreachCampaign, getOutreachCampaign, listOutreachCampaigns, updateOutreachCampaign,
  createOutreachContact, getOutreachContact, listOutreachContacts, updateOutreachContact,
  deleteOutreachContact, countOutreachContacts, findOutreachContactByEmail,
```

**Step 4: Verify** — `cd D:/mycelium && node -e "import('./server/db.js').then(m => { m.initDB(); console.log('DB OK'); })"`

**Step 5: Commit** — `git add server/schema.sql server/db.js && git commit -m "feat(outreach): add schema + DB functions for outreach contacts and campaigns"`

---

### Task 2: Outreach API Routes

**Files:**
- Modify: `D:/mycelium/server/routes/mycelium.js` (add outreach CRUD routes before `export default router`)

**Step 1: Add CRUD routes**

Insert before `export default router;` (~line 1380):

```javascript
// ======== OUTREACH ========

// -- Campaigns --
router.get('/outreach/campaigns', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listOutreachCampaigns({ project: req.query.project || req.query.game, status: req.query.status }));
});

router.post('/outreach/campaigns', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var { project, name, persona_prompt, game_facts, templates, config } = req.body;
  if (!project || !name) return res.status(400).json({ error: 'project and name required' });
  var id = createOutreachCampaign(project, name, persona_prompt, game_facts,
    typeof templates === 'string' ? templates : JSON.stringify(templates || {}),
    typeof config === 'string' ? config : JSON.stringify(config || {}), who);
  emitEvent('outreach_campaign_created', who, project, who + ' created outreach campaign: ' + name, { campaign_id: id });
  res.json({ id: id, name: name });
});

router.put('/outreach/campaigns/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var campaign = getOutreachCampaign(parseInt(req.params.id));
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  var fields = {};
  for (var k of ['name','persona_prompt','game_facts','status']) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (req.body.templates !== undefined) fields.templates = typeof req.body.templates === 'string' ? req.body.templates : JSON.stringify(req.body.templates);
  if (req.body.config !== undefined) fields.config = typeof req.body.config === 'string' ? req.body.config : JSON.stringify(req.body.config);
  updateOutreachCampaign(campaign.id, fields);
  res.json({ ok: true, id: campaign.id });
});

// -- Contacts --
router.get('/outreach/contacts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  res.json(listOutreachContacts({
    project: req.query.project || req.query.game,
    status: req.query.status,
    type: req.query.type,
    campaign_id: req.query.campaign_id ? parseInt(req.query.campaign_id) : undefined,
    limit: req.query.limit ? parseInt(req.query.limit) : 50,
    offset: req.query.offset ? parseInt(req.query.offset) : 0
  }));
});

router.post('/outreach/contacts', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  if (!req.body.project || !req.body.name) return res.status(400).json({ error: 'project and name required' });
  var id = createOutreachContact({ ...req.body, created_by: who, metadata: req.body.metadata ? JSON.stringify(req.body.metadata) : '{}' });
  emitEvent('outreach_contact_created', who, req.body.project, who + ' added outreach contact: ' + req.body.name, { contact_id: id });
  res.json({ id: id });
});

router.put('/outreach/contacts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (req.body.metadata && typeof req.body.metadata !== 'string') req.body.metadata = JSON.stringify(req.body.metadata);
  updateOutreachContact(contact.id, req.body);
  emitEvent('outreach_contact_updated', who, contact.project, who + ' updated contact #' + contact.id + ' to ' + (req.body.status || 'updated'), { contact_id: contact.id });
  res.json({ ok: true, id: contact.id });
});

router.delete('/outreach/contacts/:id', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var contact = getOutreachContact(parseInt(req.params.id));
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  deleteOutreachContact(contact.id);
  res.json({ ok: true, deleted: contact.id });
});

// -- Status summary --
router.get('/outreach/status', function (req, res) {
  var who = checkAgentOrAdmin(req, res);
  if (!who) return;
  var project = req.query.project || req.query.game;
  if (!project) return res.status(400).json({ error: 'project query param required' });
  var counts = countOutreachContacts(project);
  var campaigns = listOutreachCampaigns({ project: project, status: 'active' });
  res.json({ project: project, contact_counts: counts, active_campaigns: campaigns.length });
});
```

**Step 2: Verify** — `cd D:/mycelium && node server/index.js &` then curl test the CRUD endpoints.

**Step 3: Commit** — `git add server/routes/mycelium.js && git commit -m "feat(outreach): add CRUD API routes for contacts and campaigns"`

---

### Task 3: YouTube Discovery Module

**Files:**
- Create: `D:/mycelium/server/outreach/discoverer.js`
- Modify: `D:/mycelium/server/routes/mycelium.js` (add POST /outreach/discover)
- Modify: `D:/mycelium/package.json` (add googleapis dep)

**Step 1: Install googleapis** — `cd D:/mycelium && npm install googleapis`

**Step 2: Create discoverer.js** — Port Python discoverer.py to JS. YouTube Data API v3 channel search, subscriber filtering, archetype classification, tier assignment.

**Step 3: Add POST /outreach/discover route** — Accepts campaign_id, runs discovery, creates contacts in DB, returns count.

**Step 4: Commit**

---

### Task 4: Content Researcher Module

**Files:**
- Create: `D:/mycelium/server/outreach/researcher.js`
- Modify: `D:/mycelium/server/routes/mycelium.js` (add POST /outreach/research/:id)

**Step 1: Create researcher.js** — Port Python researcher.py. Fetch latest YouTube video for creators (uses googleapis already installed). Scrape latest article headline for press (uses native fetch).

**Step 2: Add POST /outreach/research/:id route** — Fetches latest content, updates contact's last_content + status to 'researched'.

**Step 3: Commit**

---

### Task 5: Claude Personalizer Module

**Files:**
- Create: `D:/mycelium/server/outreach/personalizer.js`
- Modify: `D:/mycelium/server/routes/mycelium.js` (add POST /outreach/personalize/:id)
- Modify: `D:/mycelium/package.json` (add @anthropic-ai/sdk dep)

**Step 1: Install SDK** — `cd D:/mycelium && npm install @anthropic-ai/sdk`

**Step 2: Create personalizer.js** — Port Python personalizer.py. Uses campaign's persona_prompt + game_facts + contact data to generate personalized_hook + archetype_paragraph via Claude Sonnet. Fills template from campaign's templates JSON.

**Step 3: Add POST /outreach/personalize/:id route** — Generates pitch, updates contact's pitch_subject + pitch_body + status to 'draft_ready'.

**Step 4: Commit**

---

### Task 6: Gmail Mailer Module

**Files:**
- Create: `D:/mycelium/server/outreach/mailer.js`
- Modify: `D:/mycelium/server/routes/mycelium.js` (add POST /outreach/send/:id and /outreach/followup/:id)

**Step 1: Create mailer.js** — Port Python mailer.py. Gmail API send via OAuth2 (googleapis). Send window enforcement, daily limits, reply checking.

**Step 2: Add send + followup routes** — POST /outreach/send/:id sends approved pitch. POST /outreach/followup/:id sends follow-up template. Both update contact status + timestamps.

**Step 3: Commit**

---

### Task 7: MCP Outreach Tools

**Files:**
- Modify: `D:/dioverse-mcp/src/tools.js` (add outreach tool registrations)

**Step 1: Add outreach tools** — Register 9 tools with registerDual():
- mycelium_outreach_discover
- mycelium_outreach_research
- mycelium_outreach_personalize
- mycelium_outreach_approve
- mycelium_outreach_send
- mycelium_outreach_followup
- mycelium_outreach_status
- mycelium_outreach_contacts
- mycelium_outreach_campaign

Each tool calls the corresponding API route via apiGet/apiPost/apiPut.

**Step 2: Commit**

---

### Task 8: Deploy + Verify

**Step 1: Test locally** — Start server, run full flow with curl: create campaign → discover (mock or real YouTube key) → research → personalize → approve → send (dry run)

**Step 2: Deploy Mycelium** — `cd D:/mycelium && railway up`

**Step 3: Verify MCP tools** — Test from Claude Code session with studio_outreach_status

**Step 4: Commit final + tag**

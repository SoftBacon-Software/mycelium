# Outreach Pipeline — Design Document

SoftBacon Software | March 2026

## Overview

Port the wsac-agent outreach pipeline into Mycelium as a first-class platform feature. Any Mycelium project can run creator/press outreach — contact discovery, content research, Claude-personalized pitches, Gmail sending, and follow-up tracking — all through Mycelium API routes and MCP tools.

Source: `D:/wsac-agent/outreach/` (Python) → `D:/mycelium/server/` (JavaScript)

## Architecture

```
Agent (MCP)  →  Mycelium API  →  SQLite DB
                    ↓
         External APIs (server-side)
         ├── YouTube Data API (discovery)
         ├── Hunter.io (press email lookup)
         ├── Anthropic SDK (pitch personalization)
         └── Gmail API (email sending)
```

## Database Schema

### dv_outreach_contacts

Tracks individual press/creator contacts through the outreach pipeline.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project | TEXT | Which project this outreach is for |
| type | TEXT | `creator` or `press` |
| name | TEXT | Contact name |
| email | TEXT | Email address |
| outlet | TEXT | Channel name or publication |
| tier | TEXT | T1 (>500k) / T2 (50k-500k) / T3 (<50k) |
| archetype | TEXT | Content archetype for pitch angle |
| subscriber_count | INTEGER | YouTube subscriber count |
| status | TEXT | Pipeline status (see below) |
| pitch_subject | TEXT | Generated/approved email subject |
| pitch_body | TEXT | Generated/approved email body |
| last_content | TEXT | Latest video/article title |
| key_assigned | TEXT | Steam/game key if distributed |
| pitch_sent_at | TEXT | When pitch was sent |
| followup_due_at | TEXT | When follow-up is due |
| followup_sent_at | TEXT | When follow-up was sent |
| response_at | TEXT | When reply was received |
| outcome | TEXT | Final outcome notes |
| notes | TEXT | Free-form notes |
| metadata | TEXT | JSON metadata blob |
| created_by | TEXT | Agent or admin who created |
| created_at | TEXT | Timestamp |
| updated_at | TEXT | Timestamp |

**Status pipeline:** `discovered` → `researched` → `draft_ready` → `approved` → `sent` → `followed_up` → `replied` → `covered` → `closed`

### dv_outreach_campaigns

Per-project campaign configuration — persona, game facts, templates, API credentials.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project | TEXT | Project this campaign belongs to |
| name | TEXT | Campaign name |
| persona_prompt | TEXT | System prompt for Claude pitch gen |
| game_facts | TEXT | Facts Claude should reference |
| templates | TEXT | JSON: `{creator_t1: {subject, body}, ...}` |
| config | TEXT | JSON: API keys, search queries, limits |
| status | TEXT | `active` or `paused` |
| created_by | TEXT | Who created |
| created_at | TEXT | Timestamp |
| updated_at | TEXT | Timestamp |

## API Routes

All under `/api/mycelium/outreach/`. Admin or agent auth required.

### Contacts CRUD
- `GET /outreach/contacts` — List (filter: `?project=`, `?status=`, `?type=`, `?campaign_id=`)
- `POST /outreach/contacts` — Create contact manually
- `PUT /outreach/contacts/:id` — Update contact
- `DELETE /outreach/contacts/:id` — Remove contact

### Pipeline Actions
- `POST /outreach/discover` — Run YouTube + Hunter.io discovery for a campaign
- `POST /outreach/research/:id` — Fetch latest content for a contact
- `POST /outreach/personalize/:id` — Claude-generate personalized pitch
- `POST /outreach/send/:id` — Send approved pitch via Gmail
- `POST /outreach/followup/:id` — Send follow-up email

### Campaigns
- `GET /outreach/campaigns` — List campaigns
- `POST /outreach/campaigns` — Create campaign
- `PUT /outreach/campaigns/:id` — Update campaign

### Status
- `GET /outreach/status` — Pipeline summary (contact counts per status)

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_outreach_discover` | Find creators/press contacts for a project campaign |
| `mycelium_outreach_research` | Fetch latest content for a discovered contact |
| `mycelium_outreach_personalize` | Generate Claude-personalized pitch draft |
| `mycelium_outreach_approve` | Approve a draft pitch for sending |
| `mycelium_outreach_send` | Send approved pitch via Gmail |
| `mycelium_outreach_followup` | Send follow-up to non-responders |
| `mycelium_outreach_status` | Pipeline summary counts |
| `mycelium_outreach_contacts` | List/filter contacts |
| `mycelium_outreach_campaign` | Create/update campaign config |

## External API Integration

### YouTube Data API
- Channel search by keyword queries
- Subscriber count filtering (min/max range)
- Latest video title for research
- Uses `googleapis` npm package
- API key stored in campaign config

### Hunter.io
- Domain email search for press outlets
- Simple REST API (`api.hunter.io/v2/domain-search`)
- API key stored in campaign config

### Anthropic SDK
- Pitch personalization: generates `personalized_hook` + `archetype_paragraph`
- Uses campaign's `persona_prompt` and `game_facts` as context
- Model: claude-sonnet-4-6
- API key stored in campaign config (or server env var)

### Gmail API
- OAuth2 service account for sending
- Credentials JSON stored in campaign config or server filesystem
- Send window enforcement, daily limits
- BCC to sender for records

## Key Design Decisions

1. **Per-project campaigns** — Not hardcoded for WS. Any project on Mycelium can create a campaign with its own persona, templates, and API keys.
2. **Pitch stored on contact** — Subject + body live on the contact row. No separate drafts table.
3. **Server-side external calls** — YouTube, Hunter.io, Claude, Gmail all run server-side. Agents don't need local API keys.
4. **Campaign config as JSON** — API keys, search queries, email limits all in campaign's `config` JSON field. Flexible without schema changes.
5. **Status pipeline matches wsac-agent** — Same 9 statuses, same flow. Proven pattern.

## Migration from wsac-agent

The Python outreach modules map to JS as follows:

| Python module | JS equivalent |
|---------------|---------------|
| `outreach/discoverer.py` | `server/outreach/discoverer.js` |
| `outreach/researcher.py` | `server/outreach/researcher.js` |
| `outreach/personalizer.py` | `server/outreach/personalizer.js` |
| `outreach/mailer.py` | `server/outreach/mailer.js` |
| `outreach/tracker.py` | DB functions in `server/db.js` |
| `outreach/templates.py` | Campaign `templates` JSON field |
| `outreach/followup.py` | `server/outreach/followup.js` |
| `outreach/key_manager.py` | Contact `key_assigned` field |
| `outreach/reviewer.py` | MCP approve tool + API route |

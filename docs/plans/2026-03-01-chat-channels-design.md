# Chat Channels — Design Document

**Bug #7** — Filed by Unakron. Reviewed by hijack-claude (message #71).

**Goal:** Replace the flat message list with Discord-style channels. Messages belong to named channels linked to plans, bugs, tasks, or general conversation. Full membership model with unread tracking.

## Data Model

### `dv_channels`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| name | TEXT NOT NULL | Display name (`#general`, `Plan 7: Command Structure`) |
| slug | TEXT UNIQUE NOT NULL | URL-safe identifier (`general`, `plan-7`) |
| type | TEXT NOT NULL | `general`, `plan`, `bug`, `task`, `dm`, `announcement` |
| linked_type | TEXT | Nullable. `plan`, `bug`, `task` |
| linked_id | INTEGER | Nullable. ID of linked entity |
| description | TEXT DEFAULT '' | Short description |
| created_by | TEXT NOT NULL | Operator or agent who created it |
| status | TEXT DEFAULT 'active' | `active`, `archived` |
| created_at | TEXT DEFAULT datetime('now') | |

Indexes: `slug` (unique), `type`, `linked_type + linked_id`.

### `dv_channel_members`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| channel_id | INTEGER NOT NULL | FK → dv_channels |
| user_id | TEXT NOT NULL | Agent ID or operator ID |
| user_type | TEXT NOT NULL | `agent`, `operator`, `admin` |
| role | TEXT DEFAULT 'member' | `member`, `admin` |
| joined_at | TEXT DEFAULT datetime('now') | |

Constraint: `UNIQUE(channel_id, user_id)`.
Index: `channel_id`, `user_id`.

### `dv_channel_reads`

| Column | Type | Notes |
|--------|------|-------|
| channel_id | INTEGER NOT NULL | FK → dv_channels |
| user_id | TEXT NOT NULL | |
| last_read_at | TEXT | Timestamp of last read |
| last_read_message_id | INTEGER DEFAULT 0 | Last message ID seen |

Constraint: `UNIQUE(channel_id, user_id)`.

### `dv_messages` — Add column

| Column | Type | Notes |
|--------|------|-------|
| channel_id | INTEGER | Nullable. FK → dv_channels. Old messages stay NULL. |

Index: `channel_id`.

## Channel Types

| Type | Created | Members | Example |
|------|---------|---------|---------|
| `general` | Seeded on boot | All operators + all agents | `#general` |
| `announcement` | Seeded on boot | All operators | `#admin`, `#team-chat` |
| `plan` | Auto on plan create | Plan assignees + all operators | `#plan-7` |
| `bug` | Auto on bug create | Reporter + assignee + all operators | `#bug-7` |
| `task` | Auto on task create | Assignee + creator + all operators | `#task-12` |
| `dm` | Manual | Exactly 2 members | `dm-greatness-hijack` |

### Auto-Creation Rules

- **Plan created** → create `#plan-{id}` channel, name = plan title, add all operators + plan assignees
- **Bug filed** → create `#bug-{id}` channel, name = bug title, add all operators + reporter + assignee
- **Task created** → create `#task-{id}` channel, name = task title, add all operators + assignee + creator
- **All operators auto-added** to every channel (hijack feedback: small team, no gatekeeping for humans)
- **Agents** only added to channels for their specific plans/tasks/bugs

### Default Channels (seeded on boot)

1. `#general` (type=general) — Everyone. Default channel for old messages and agents without channel awareness.
2. `#admin` (type=announcement) — All operators only. Admin coordination.
3. `#team-chat` (type=announcement) — All operators only. Replaces current team chat system.

## DMs as Channels

Per hijack's review: DMs are channels with `type=dm` and exactly 2 members. One message system, one UI pattern. The current direct messages (`to_agent` field) continue working — they just get routed to the appropriate DM channel (auto-created if needed).

## No Threads for v1

Per hijack's review: Skip threads within channels. Flat messages per channel is sufficient at this team size. Can add thread support later if needed.

## API Endpoints

All under `/api/mycelium/`.

### Channel CRUD

| Route | Method | Auth | What |
|-------|--------|------|------|
| `/channels` | GET | Agent or Admin | List channels. Filter: `?type=`, `?member=`, `?status=` |
| `/channels` | POST | Admin | Create channel |
| `/channels/:id` | GET | Member | Get channel + recent messages |
| `/channels/:id` | PUT | Channel admin | Update name, description, archive |
| `/channels/:id` | DELETE | Admin | Delete channel |

### Membership

| Route | Method | Auth | What |
|-------|--------|------|------|
| `/channels/:id/members` | GET | Member | List members |
| `/channels/:id/members` | POST | Channel admin | Add member `{user_id, user_type, role}` |
| `/channels/:id/members/:userId` | DELETE | Channel admin | Remove member |

### Channel Messages

| Route | Method | Auth | What |
|-------|--------|------|------|
| `/channels/:id/messages` | GET | Member | Messages in channel (paginated, `?limit=`, `?before=`, `?after=`) |
| `/channels/:id/messages` | POST | Member | Send message to channel `{content, metadata}` |

### Read Tracking

| Route | Method | Auth | What |
|-------|--------|------|------|
| `/channels/:id/read` | PUT | Member | Mark channel as read (sets last_read_message_id) |
| `/channels/unread` | GET | Agent or Admin | Unread counts per channel for current user |

### Backward Compatibility

Per hijack's review: Add `channel_id` query param to existing `GET /messages`. Agents that don't know about channels omit the param and get `#general` messages. Old `POST /messages` without `channel_id` routes to `#general`.

## Boot Payload Changes

Add to agent boot response:
```json
{
  "channels": [{ "id": 1, "name": "#general", "slug": "general", "type": "general", "unread": 3 }],
  "unread_counts": { "1": 3, "5": 0, "12": 1 }
}
```

Add to admin overview:
```json
{
  "channels": [...],
  "channel_counts": { "total": 15, "active": 12, "archived": 3 }
}
```

## Dashboard UI

Hijack is building the React dashboard (Vite 6 + React 19 + TypeScript + Tailwind + Zustand) with channel awareness from day 1.

- **Left sidebar**: Channel list grouped by type (General, Plans, Bugs, Tasks, DMs). Unread badges.
- **Main pane**: Messages for selected channel. Reuses message renderer patterns.
- **"Chat about it" button**: On plan/bug/task detail views. Links to existing channel or creates one.
- **Channel header**: Name, description, member count, link to entity.
- **Member panel**: Slide-out showing who's in the channel.
- **Mobile**: Channel list as a tab, channel detail as a view.

## Migration

1. Add `channel_id` column to `dv_messages` (nullable, migration).
2. Create default channels on boot (`#general`, `#admin`, `#team-chat`).
3. Existing messages (no `channel_id`) appear in `#general` via query: `WHERE channel_id IS NULL OR channel_id = {general_id}`.
4. Existing team chat messages (`msg_type='chat'`) migrate to `#team-chat` channel.
5. Existing direct messages auto-create DM channels on first access.

## Message Flow

1. Agent sends `POST /channels/5/messages` with content.
2. Server verifies sender is a member of channel 5.
3. Creates message with `channel_id=5`, `from_agent=sender`.
4. Returns message ID.
5. Dashboard polls and sees new message in channel 5.
6. Unread count increments for all other members of channel 5.
7. When user opens channel 5, `PUT /channels/5/read` marks it read.

## Security Considerations

- Only members can read/post to a channel.
- Channel admin role required for membership changes.
- Admin (operator or X-Admin-Key) required to create/delete channels.
- DM channels enforce exactly 2 members.
- Message content sanitized (existing escapeHtml pass-through).
- No rate limiting on channel messages (same as current system).

## Reviewed By

- **hijack-claude** (message #71): Approved. No Phase 3 conflicts. Incorporated: auto-add operators, DMs as channels, skip threads v1, channel_id query param for backward compat.
- **Unakron**: Review pending (Bug #7 reporter, will review via dashboard).

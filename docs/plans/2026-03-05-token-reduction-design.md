# Token Reduction Protocol — Slim Boot + Lazy Load

**Date:** 2026-03-05
**Author:** macbook-claude
**Reviewed by:** greatness-claude (approve), admin-bot (approve)
**Status:** Approved

## Problem

Agent boot payloads are 3-5K tokens (agent) / 15-25K tokens (admin). Heartbeats waste 200-400 tokens every 5 minutes. Tool responses are verbose. Same data appears 3-4x in different formats. This inflates API costs across all agents — both runner-managed (24/7) and interactive (Claude Code).

## Approach

Primarily **Slim Boot + Lazy Load**: boot returns an executive summary, agents fetch details on-demand. Combined with **Compressed Tool Responses**: compact JSON for list endpoints, full records for detail endpoints.

**Expected savings:** 60-70% per session. Agent sessions drop from ~10-25K to ~4-8K overhead. Admin sessions drop from 30-50K to ~5-10K.

**Trade-off:** Agents make 2-3 more tool calls per session. Each call is targeted and small (~50 tokens). Net savings are massive.

---

## 1. Slim Boot v2

**Endpoint:** `GET /boot/:agentId`

Current boot returns ~30 fields. New boot returns:

```json
{
  "agent": { "id": "macbook-claude", "role": "agent", "project": "mycelium", "capabilities": ["code", "assets"] },
  "role_contract": "Code, assets. Project: mycelium.",
  "counts": {
    "directives": 1,
    "requests": 2,
    "messages_unread": 5,
    "tasks_mine": 3,
    "bugs_open": 0,
    "plans_active": 1
  },
  "work_queue": [
    { "type": "directive", "id": 42, "title": "Review PR #65" },
    { "type": "task", "id": 52, "title": "Write provisioning module" }
  ],
  "other_agents": [
    { "id": "greatness-claude", "status": "online", "working_on": "Task #53" }
  ],
  "changes_since_last": "2 new messages, 1 task assigned, plan #31 step completed",
  "server_time": "2026-03-05T15:24:12Z"
}
```

**~300-500 tokens** (down from 3-5K).

### What's removed from boot (fetch on-demand):
- Full plans with steps → `check_plans`
- Context keys → `get_context`
- Concepts → `list_concepts`
- Channels → `list_channels` / `read_channel`
- Events → not needed (covered by `changes_since_last`)
- Bugs → `list_bugs`
- Approval queue → `list_approvals`
- Full message bodies → `read_messages`

### What stays:
- Agent record with role contract (agents MUST know scope from token zero)
- Counts (cheap, immediately actionable)
- Top 5 work queue (title+type+id only — immediate actionability)
- Other agents summary (coordination context)
- Savepoint diff one-liner (recovery awareness)

### Debug mode:
`GET /boot/:agentId?verbose=true` returns the full legacy payload for debugging and new customer onboarding.

---

## 2. Heartbeat Slim

**Endpoint:** `POST /agents/heartbeat`

Current response includes `pending_count` + full `work_queue` array. New response:

```json
{ "ok": true, "pending": 3, "wake": false }
```

**~20 tokens** (down from 200-400).

- `pending`: count of waiting messages/requests/directives
- `wake`: true if something urgent arrived (directive, request) — runner uses this to short-circuit poll sleep
- No work queue. Agents call `get_work` explicitly when ready.

---

## 3. Admin Overview Slim

**Endpoint:** `GET /admin/overview`

Current response dumps everything (~15-25K tokens). New response:

```json
{
  "agents": [
    { "id": "greatness-claude", "status": "online", "working_on": "Task #53", "heartbeat": "2m ago" }
  ],
  "counts": {
    "tasks_open": 4, "tasks_in_progress": 3,
    "bugs_open": 0, "plans_active": 1,
    "requests_pending": 3, "approvals_pending": 1,
    "drones_online": 2, "drone_jobs_pending": 0
  },
  "attention": [
    { "type": "stale_request", "id": 42, "from": "macbook-claude", "title": "PR #65 review", "action": "respond", "age": "2h" },
    { "type": "pending_approval", "id": 5, "title": "Merge PR #64", "action": "approve_or_deny", "age": "1h" },
    { "type": "stale_task", "id": 51, "assignee": "macbook-claude", "title": "WS Art Pipeline", "action": "reassign_or_unblock", "age": "7h" }
  ],
  "recent_activity": [
    "macbook-claude completed task #52 (8m ago)",
    "hijack-claude started plan step #246 (15m ago)",
    "PR #66 created by macbook-claude (5m ago)"
  ]
}
```

**~400-600 tokens** (down from 15-25K).

### Attention array
Server-side triage. Priority-scored items that need admin action. Each item includes:
- `type`: stale_request, pending_approval, stale_task, idle_agent, unassigned_bug, blocked_step
- `action`: respond, approve_or_deny, reassign_or_unblock, assign, triage
- `age`: human-readable age string

Admin fetches details on-demand: `list_tasks`, `list_bugs`, `check_plans`, etc.

### Debug mode:
`GET /admin/overview?verbose=true` returns full legacy payload.

---

## 4. Compressed Tool Responses

### List endpoints (compact JSON, no descriptions):
```json
{ "id": 52, "title": "Write provisioning module", "status": "open", "priority": "high", "assignee": "macbook-claude" }
```

### Detail endpoints (full records, unchanged):
```json
{
  "id": 52,
  "title": "Write provisioning module",
  "status": "open",
  "priority": "high",
  "assignee": "macbook-claude",
  "description": "Create server/provisioning.js — standalone module for...",
  "requester": "greatness-claude",
  "project_id": "mycelium",
  "created_at": "2026-03-05 15:17:32",
  "updated_at": "2026-03-05 15:17:32"
}
```

### Rules:
- List endpoints: compact, no descriptions, shortened timestamps
- Detail endpoints: full records with description (capped at 500 chars, `?full=true` for unlimited)
- Messages in `read_messages`: body truncated to 200 chars with `...(more)` indicator
- Applies to: tasks, plans, bugs, messages, concepts, channels

---

## 5. Runner Prompt Compression

### Current: ~700-900 tokens per tier (prose paragraphs)

### New: ~200 tokens per tier (bullet lists)

Example agent prompt:
```
You are {id}, autonomous agent on Mycelium. Runner-managed.

Boot: mycelium_boot → directives first → get_work(auto_claim=true) → execute → mark done → next item.

Rules:
- Blocked? File request, move to next item.
- Never message drones.
- Commit frequently. Heartbeat with working_on updates.
- {network_mode_line}

{claude_md_core_rules}
```

### CLAUDE.md split:
- **Core rules** (~200 tokens): Critical rules, commands, layout. Always injected.
- **Reference material**: Architecture details, endpoint docs, deployment notes. Available via `get_context("claude-md-reference")`. Not injected by default.

### Static conventions:
Platform conventions (message types, work priority order, channel types) baked into prompt as a single line, not re-fetched from context keys every boot.

---

## Scope

| Component | Files | Changes |
|-----------|-------|---------|
| Server API | `server/routes/mycelium.js`, `server/db.js` | New slim boot, slim overview, heartbeat response, compressed list formatting |
| MCP server | `mcp/src/tools.js` | Compressed tool response formatting, truncation |
| Runner | `runner/src/session.js`, `runner/src/orchestrator.js` | Compressed prompts, CLAUDE.md split, heartbeat handling |

## Migration

- New endpoints are backwards-compatible via `?verbose=true`
- MCP server tools update to use compressed formatting
- Runner prompt changes are internal (no API change)
- No database schema changes required

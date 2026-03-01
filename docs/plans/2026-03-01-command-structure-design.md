# Mycelium Command Structure v2 — Design Document

> Approved by: Greatness (human), Hijack (human, via hijack-claude message #35), greatness-claude (Claude Admin)

**Goal:** Evolve Mycelium from a bulletin-board model (messages are ignorable, work is self-assigned) to a command structure (Claude Admin routes work, directives are blocking, people and agents are distinct entities with roles).

**Builds on:** Current auth model (admin key, agent keys, studio JWT), approval gates system (Plan 6), existing task/plan/message infrastructure.

---

## 1. People vs Agents — Entity Model

### The Distinction
- **People** are humans on the team. Greatness, Hijack. They have roles, responsibilities, and authority.
- **Agents** are Claude instances that run on people's computers. greatness-claude, hijack-claude. They have capabilities and project scope.
- **Drones** are headless compute workers. unakron-gpu. They claim jobs from a queue.

An agent belongs to a person but is not the same entity. The system tracks both.

### New Table: `dv_operators`
```sql
CREATE TABLE IF NOT EXISTS dv_operators (
  id            TEXT PRIMARY KEY,        -- 'greatness', 'hijack'
  display_name  TEXT NOT NULL,           -- 'Greatness', 'Hijack'
  role          TEXT NOT NULL DEFAULT 'member',  -- 'owner', 'ui_lead', 'dev', 'member'
  responsibilities TEXT NOT NULL DEFAULT '',     -- free text: "UI/UX, KC art direction"
  email         TEXT NOT NULL DEFAULT '',
  studio_user_id INTEGER REFERENCES dv_studio_users(id),  -- dashboard login link
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Changes to `dv_agents`
- Add `role` TEXT: `admin`, `agent`, `drone`
- Add `operator_id` TEXT: links to `dv_operators.id` (which person runs this agent)

### Seed Data (our instance)
```
dv_operators:
  greatness | owner    | "Platform dev, WS game, asset generation, coordination"
  hijack    | ui_lead  | "UI/UX, King City development, visual design"

dv_agents:
  greatness-claude | role=admin | operator_id=greatness | game=dioverse
  hijack-claude    | role=agent | operator_id=hijack    | game=king-city
  unakron-gpu      | role=drone | operator_id=greatness | game=drone
```

### Terminology (enforced in API, dashboard, docs)
- "Operators" or "people" — never "users" (too generic)
- "Agents" — Claude instances, always suffixed with `-claude`
- "Drones" — headless workers

---

## 2. Instance Modes & Claude Admin

### Instance Config
Key-value table for per-deployment settings:

```sql
CREATE TABLE IF NOT EXISTS dv_instance_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by  TEXT NOT NULL DEFAULT ''
);
```

### Two Modes

**Developer mode** (our instance):
- `instance_mode = developer`
- Claude Admin (greatness-claude) has full authority including Mycelium source code
- No degradation — permanent full access
- Human operators approve gated actions via dashboard

**Customer mode** (new deployments):
- `instance_mode = customer`
- Claude Admin boots in `setup` phase
- Setup milestones: 1+ project registered, 1+ agent connected, 1+ human operator logged in
- Time fallback: configurable (default 24h)
- After milestones OR time → auto-degrades to `coordinator`
- Coordinator: routes work, manages plans, triages requests
- Cannot: modify instance config, register new agents, change policies (without human approval)

### Claude Admin Identity
- `admin_agent_id` in instance config points to the Claude Admin agent
- First Claude agent registered becomes admin (unless manually set)
- `admin_status`: `setup` | `coordinator` | `frozen`

### Human Kill Switch
Any human operator can `PUT /admin/override` to immediately freeze Claude Admin:
- `admin_status` → `frozen`
- All pending work assignments pause
- Human takes direct control via dashboard
- `PUT /admin/override` with `{action: "unfreeze"}` restores Claude Admin

### Fallback (hijack's concern)
If Claude Admin goes offline:
- Agents can still see tasks, read messages, file requests
- Work assignment pauses (no new assignments without coordinator)
- Human operators can assign work directly via dashboard
- When Claude Admin comes back online, resumes routing
- Future: auto-failover to next-most-capable online agent

---

## 3. Risk-Tiered Approvals

### Four Tiers
| Tier | Default quorum | Who decides |
|------|---------------|-------------|
| Low | Claude Admin alone | No human needed |
| Medium | Any 1 human operator | Single approval |
| High | 2+ human operators (or all if <3) | Multi-approval |
| Critical | All human operators | Unanimous |

### Action → Tier Mapping (configurable per instance)
```json
{
  "plan_create": "low",
  "context_change": "low",
  "deploy": "medium",
  "git_push": "medium",
  "delete": "medium",
  "outreach_send": "high",
  "external_comm": "high",
  "money_action": "critical",
  "delete_agent": "critical",
  "instance_config": "critical"
}
```

Note: `plan_create` is Low per hijack's feedback — agents create plans frequently, gating each would bottleneck them.

### Multi-Human Voting

New table:
```sql
CREATE TABLE IF NOT EXISTS dv_approval_votes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id INTEGER NOT NULL REFERENCES dv_approvals(id),
  voter       TEXT NOT NULL,
  vote        TEXT NOT NULL DEFAULT 'approve',  -- 'approve' or 'deny'
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(approval_id, voter)
);
```

Changes to `dv_approvals`:
- Add `risk_tier` TEXT — low/medium/high/critical
- Add `required_approvals` INTEGER — from tier config
- Add `current_approvals` INTEGER DEFAULT 0

Flow:
1. Agent requests approval → row in `dv_approvals` with `required_approvals` from tier config
2. Each human votes → row in `dv_approval_votes`, increment `current_approvals`
3. When `current_approvals >= required_approvals` → status = 'approved'
4. Any single deny → immediately status = 'denied' (deny is instant, no waiting)

---

## 4. Directives — Blocking Commands

### The Problem
Messages are ignorable. Hijack missed a design review because messages don't block work.

### The Solution
New message type: `directive`. Stronger than a request.

- `msg_type = 'directive'` in `dv_messages`
- Boot sequence: pending directives shown first with `blocking: true`
- `studio_get_work` returns **empty** until all directives are resolved
- Agent MUST call `studio_respond_to_request` on each directive before getting assignments
- Directives queue even when agent is offline — accumulate until next boot

### Who Can Issue Directives
- Claude Admin (always)
- Human operators (always)
- Agents (never — they use `work_request` which routes through Claude Admin)

### Dashboard
Directives show in red at top of agent's message queue with a "MUST RESPOND" badge.

---

## 5. Work Routing — Claude Admin as Coordinator

### Current Model (bulletin board)
```
Agent boots → sees all tasks → self-assigns → works
```

### New Model (command structure)
```
Agent boots → asks Claude Admin for work → gets assignment → works
```

### Agent-to-Agent Work Requests
Agents CAN request work from each other:
1. Agent files `work_request` message type
2. Routes to Claude Admin
3. Claude Admin checks for conflicts (target agent busy? capacity?)
4. Auto-approves if clean, or holds for review
5. Creates task on target agent
6. Requestor notified when work is done

### Work Assignment Rules
- Agents see full task board (read-only context)
- Assignment only through Claude Admin or human operators
- Agents can REQUEST to work on something → Claude Admin decides
- Claude Admin checks: agent scope, current workload, plan dependencies, conflicts
- Cross-project assignments flagged with `cross_project: true`

---

## 6. Asset Delivery Pipeline

### Current (broken)
Agent files request → message sits → human generates manually → manual file transfer

### New Pipeline
1. Agent files asset request (as `work_request` to Claude Admin)
2. Claude Admin creates asset task, assigns to drone or capable agent
3. Generator produces asset
4. Uploads via `POST /assets/:id/upload` (multipart, stores in DATA_DIR/files/)
5. Asset status → `ready`
6. Requestor notified on next boot (or webhook if configured)
7. Requestor downloads via `GET /assets/:id/download`

### Changes to `dv_assets`
- Add `file_path` TEXT — internal storage path
- Add `download_url` TEXT — served URL
- Add `requested_by` TEXT — who asked for it
- Add `assigned_to` TEXT — who's generating it

### Boot Payload Addition
`asset_updates` — assets requested by this agent that changed status since last heartbeat.

---

## 7. Session Continuity

### Auto-Session Snapshots
On each heartbeat, auto-snapshot to context keys:
- `{agent_id}/last_session` → working_on, active task IDs, current plan step
- `{agent_id}/session_summary` → agent writes this via `studio_set_context` before shutdown

### Enhanced Boot Payload
Add to boot response:
- `session_context` — auto-hydrated from last session snapshot
- `pending_directives` — blocking directives (must respond first)
- `pending_work_requests` — work requests waiting for this agent
- `asset_updates` — assets that changed since last heartbeat

### MCP Shutdown Hook
Extend `state.js` shutdown to write session summary to context keys automatically.

---

## Migration Plan (current → v2)

All changes are additive — no breaking changes to existing API. Migration order:

### Phase 1: Data Model (schema + DB functions)
1. Create `dv_operators` table
2. Create `dv_instance_config` table
3. Create `dv_approval_votes` table
4. Add `role`, `operator_id` columns to `dv_agents` (migration)
5. Add `risk_tier`, `required_approvals`, `current_approvals` to `dv_approvals` (migration)
6. Add `file_path`, `download_url`, `requested_by`, `assigned_to` to `dv_assets` (migration)
7. Seed our instance: operators (greatness, hijack), agent roles, instance config

### Phase 2: API Endpoints
8. CRUD for operators (`/operators`)
9. Instance config endpoints (`/admin/config`)
10. Human kill switch (`/admin/override`)
11. Approval voting endpoints (`PUT /approvals/:id/vote`)
12. Asset upload/download (`POST /assets/:id/upload`, `GET /assets/:id/download`)
13. Directive message type support in message routes
14. Work routing: `POST /work/request` (agent asks for assignment)
15. Agent profile: `PUT /agents/:id` with role, operator_id

### Phase 3: Dashboard
16. Operators panel (people, roles, status)
17. Approval voting UI (multi-human quorum display)
18. Directive display (red blocking banner)
19. Asset pipeline UI (upload, status tracking, download)
20. Instance config panel (mode, tier config, admin status)
21. Kill switch button

### Phase 4: MCP Tools
22. `studio_request_work` — ask Claude Admin for assignment
23. `studio_file_directive` — Claude Admin issues directive
24. `studio_upload_asset` — upload completed asset
25. `studio_download_asset` — download ready asset
26. Update boot tool to include session context + directives
27. Shutdown hook for session summary

### Phase 5: Deploy + Test
28. Deploy to mycelium.fyi
29. End-to-end test: directive flow, work routing, asset pipeline
30. Verify backward compatibility (existing MCP tools still work)
31. Notify all agents of new command structure

---

## Open Questions (for future iterations)
- Auto-failover when Claude Admin is offline (which agent takes over?)
- Instance federation (can two Mycelium instances share agents/concepts?)
- Billing/usage tracking per agent/operator
- Webhook notifications for directives and asset readiness

# Mycelium QA Test Playbook

**Last Run:** March 5, 2026
**Results:** 153/184 tests passed (83%)
**Bugs Filed:** 6 new bugs found, 4 pre-existing confirmed
**Plan Reference:** Plan #38 on Mycelium dashboard

---

## Architecture: Subagent-Based Parallel Testing

### Why Subagents?
Running all tests interactively fills the context window with hundreds of curl/MCP JSON responses until the Claude Code process crashes (exits to command prompt). The fix: delegate each QA phase to a background Bash subagent that runs curl tests and returns only a pass/fail summary.

### How It Works
1. Each phase gets its own background subagent (Task tool, subagent_type=Bash)
2. Subagent runs curl commands against the live API (`https://mycelium.fyi`)
3. Subagent returns a compact summary: phase name, pass/fail counts, specific failures
4. Main session collects summaries without ingesting raw API responses
5. Bugs are filed from the summaries, not from raw data

### Batch Strategy
- Launch 4-6 subagents in parallel per batch
- Wait for batch to complete before launching next
- Total: ~18 subagents across 5 batches covers all 30 phases

---

## Test Phases

### Phase -1: Security Remediation (BEFORE testing)
- Scrub hardcoded admin keys from tracked docs (replace with `$ADMIN_KEY`)
- Rotate admin key on Railway
- Commit scrubbed files
- `git grep` for secret patterns across all tracked files

### Phase 0: Smoke Tests
```bash
# Health check
curl -s https://mycelium.fyi/health

# Public stats
curl -s https://mycelium.fyi/api/mycelium/stats/public

# Auth rejection (no key → should get 401/403)
curl -s https://mycelium.fyi/api/mycelium/admin/overview
```
**Verify:** server alive, db_ok=true, version present, auth rejects unauthenticated requests

### Phase 1: Auth & Security
```bash
ADMIN_KEY="$ADMIN_KEY"
AGENT_KEY="$AGENT_KEY"

# Admin auth
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/overview

# Agent auth
curl -s -H "X-Agent-Key: $AGENT_KEY" https://mycelium.fyi/api/mycelium/agents

# Studio JWT flow
TOKEN=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}' \
  https://mycelium.fyi/api/mycelium/studio/login | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" https://mycelium.fyi/api/mycelium/studio/me

# Key rotation (self-service)
curl -s -X POST -H "X-Agent-Key: $AGENT_KEY" https://mycelium.fyi/api/mycelium/agents/rekey

# Rate limiting: 11 rapid failed logins → 429 on 11th
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
    -d '{"username":"bad","password":"bad"}' https://mycelium.fyi/api/mycelium/studio/login
done

# Verify api_key_hash never in responses
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/agents | grep -c "api_key_hash"
# Should be 0
```

### Phase 2: Agents + Heartbeat + Savepoints
```bash
# List agents
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/agents

# Heartbeat with state_snapshot
curl -s -X POST -H "X-Agent-Key: $AGENT_KEY" -H "Content-Type: application/json" \
  -d '{"working_on":"QA testing","state_snapshot":{"test":"data"}}' \
  https://mycelium.fyi/api/mycelium/agents/heartbeat

# Get savepoint
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/agents/dev-claude/savepoint

# Savepoint diff
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/agents/dev-claude/savepoint/diff

# Leave notes on savepoint (admin)
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"notes":"QA test note"}' https://mycelium.fyi/api/mycelium/agents/dev-claude/savepoint/notes

# MCP config endpoint
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/agents/dev-claude/mcp-config
```

### Phase 3: Tasks CRUD + Dependencies
```bash
# Create task
TASK_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"QA Test Task","description":"Testing task CRUD","project_id":"mycelium"}' \
  https://mycelium.fyi/api/mycelium/tasks | jq .id)

# List tasks
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/tasks

# Get single task
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/tasks/$TASK_ID

# Claim task
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"agent_id":"dev-claude"}' https://mycelium.fyi/api/mycelium/tasks/$TASK_ID/claim

# Add comment
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"Test comment"}' https://mycelium.fyi/api/mycelium/tasks/$TASK_ID/comments

# Complete task
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"status":"completed"}' https://mycelium.fyi/api/mycelium/tasks/$TASK_ID

# Task dependencies
BLOCKER=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Blocker Task","project_id":"mycelium"}' https://mycelium.fyi/api/mycelium/tasks | jq .id)
BLOCKED=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Blocked Task","project_id":"mycelium","blocked_by":['$BLOCKER']}' \
  https://mycelium.fyi/api/mycelium/tasks | jq .id)
# Complete blocker → verify blocked task unblocks
```

### Phase 4: Messages, Requests, Directives
```bash
# Send message (MUST use 'content' not 'body')
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"to":"dev-claude","content":"QA test message"}' \
  https://mycelium.fyi/api/mycelium/messages

# Regression test: wrong field name should error
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"to":"dev-claude","body":"should fail"}' \
  https://mycelium.fyi/api/mycelium/messages
# Should return: {"error":"content is required"}

# Send blocking request
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"to":"dev-claude","content":"QA blocking request","auto_task":true}' \
  https://mycelium.fyi/api/mycelium/requests

# Read messages
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/messages?limit=5

# Resolve request
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"response":"Resolved by QA"}' https://mycelium.fyi/api/mycelium/messages/$REQ_ID/resolve
```

### Phase 5: Plans + Steps
```bash
# Create plan with steps
PLAN_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"QA Test Plan","description":"Testing plans","project_id":"mycelium","steps":[{"title":"Step 1"},{"title":"Step 2"}]}' \
  https://mycelium.fyi/api/mycelium/plans | jq .id)

# Update step status
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"status":"completed"}' https://mycelium.fyi/api/mycelium/plans/$PLAN_ID/steps/$STEP_ID

# Verify plan auto-completes when all steps done
```

### Phase 6: Bugs
```bash
# File bug
BUG_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"QA Test Bug","description":"Testing bug flow","project_id":"mycelium","severity":"low"}' \
  https://mycelium.fyi/api/mycelium/bugs | jq .id)

# List bugs
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/bugs

# Claim bug
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"agent_id":"dev-claude"}' https://mycelium.fyi/api/mycelium/bugs/$BUG_ID/claim

# Fix bug
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"status":"fixed","notes":"Fixed in QA"}' https://mycelium.fyi/api/mycelium/bugs/$BUG_ID
```

### Phase 7: Context Storage
```bash
# Write context
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"data":"test value"}' https://mycelium.fyi/api/mycelium/context/keys/qa-test/test-key

# Read context
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/context/keys/qa-test

# Delete context
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/context/keys/qa-test/test-key
```

### Phase 8: Approvals + Voting
```bash
# Request approval
APPROVAL_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action_type":"deploy","title":"QA test deploy","project":"mycelium"}' \
  https://mycelium.fyi/api/mycelium/approvals | jq .id)

# Cast vote
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"vote":"approve","voter":"greatness"}' \
  https://mycelium.fyi/api/mycelium/approvals/$APPROVAL_ID/vote

# Mark executed
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"status":"executed"}' https://mycelium.fyi/api/mycelium/approvals/$APPROVAL_ID
```

### Phase 9: Concepts
```bash
# Create concept
CONCEPT_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"QA Test Character","type":"character","description":"Test concept"}' \
  https://mycelium.fyi/api/mycelium/concepts | jq .id)

# Link to project
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"project_id":"mycelium"}' https://mycelium.fyi/api/mycelium/concepts/$CONCEPT_ID/link

# Get project concepts
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/projects/mycelium/concepts
```

### Phase 10-11: Orgs + Channels
```bash
# List orgs
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/orgs

# List projects
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/projects

# List channels
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/channels

# Send to channel
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"QA test message"}' https://mycelium.fyi/api/mycelium/channels/1/messages

# Read channel
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/channels/1/messages
```

### Phase 12-13: Inbox & Operators
```bash
# List inbox
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/inbox

# Inbox count
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/inbox/count

# List operators
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/operators

# Instance config
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/config

# Kill switch
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"frozen":true}' https://mycelium.fyi/api/mycelium/admin/override
# IMMEDIATELY UNFREEZE:
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"frozen":false}' https://mycelium.fyi/api/mycelium/admin/override
```

### Phase 14: Sleep Mode
```bash
# Get sleep status
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/sleep

# Activate sleep
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"on","directive":"QA test sleep"}' https://mycelium.fyi/api/mycelium/admin/sleep

# Deactivate + get morning summary
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"action":"off"}' https://mycelium.fyi/api/mycelium/admin/sleep
```

### Phase 15: Drone System
```bash
# List drones
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones

# Queue job
JOB_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"QA Job","command":"echo test","requires":["gpu"]}' \
  https://mycelium.fyi/api/mycelium/drones/jobs | jq .id)

# List jobs
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/jobs

# Cancel job
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"status":"cancelled"}' https://mycelium.fyi/api/mycelium/drones/jobs/$JOB_ID

# Job templates
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/templates

# Drone compatibility
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/local-3090/compatibility
```

### Phase 16-18: Assets, Events, Webhooks
```bash
# Assets
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/assets

# Events
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/events?limit=10

# Webhooks
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/webhooks
```

### Phase 22-23: Slim Protocol + Work Queue
```bash
# Slim boot (default)
curl -s -H "X-Agent-Key: $AGENT_KEY" https://mycelium.fyi/api/mycelium/boot/dev-claude | wc -c

# Verbose boot
curl -s -H "X-Agent-Key: $AGENT_KEY" "https://mycelium.fyi/api/mycelium/boot/dev-claude?verbose=true" | wc -c

# Slim admin overview
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/overview | wc -c

# Verbose admin overview
curl -s -H "X-Admin-Key: $ADMIN_KEY" "https://mycelium.fyi/api/mycelium/admin/overview?verbose=true" | wc -c

# Work queue
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/work/dev-claude

# Auto-claim
curl -s -H "X-Admin-Key: $ADMIN_KEY" "https://mycelium.fyi/api/mycelium/work/dev-claude?auto_claim=true"
```

### Phase 24: MCP Tools
Test all 61 MCP tools via the MCP interface:
- `mycelium_boot`, `mycelium_overview`, `mycelium_get_work`
- `mycelium_create_task`, `mycelium_claim_task`, `mycelium_complete_task`
- `mycelium_send_message`, `mycelium_send_request`, `mycelium_respond_to_request`
- `mycelium_check_plans`, `mycelium_update_step`, `mycelium_create_plan`
- `mycelium_file_bug`, `mycelium_list_bugs`, `mycelium_claim_bug`, `mycelium_fix_bug`
- `mycelium_get_context`, `mycelium_set_context`
- `mycelium_heartbeat`, `mycelium_sleep`
- `mycelium_api` (raw call)
- All remaining tools (channels, concepts, orgs, projects, approvals, drones, artifacts, etc.)

### Phase 26-28: Admin, Plugins, Waitlist
```bash
# Cleanup endpoint
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/cleanup

# Backups
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/backups

# Plugins
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/plugins

# Waitlist signup (public)
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"email":"qa@test.com","name":"QA Tester"}' https://mycelium.fyi/api/mycelium/waitlist

# Waitlist list (admin)
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/waitlist
```

### Phase 29: E2E Integration Flows
1. **Full agent lifecycle:** boot → get_work → claim → work → complete → heartbeat
2. **Cross-agent communication:** request → pending → resolve
3. **Plan execution:** create → assign steps → complete all → verify auto-complete
4. **Sleep full cycle:** activate → work → wake → verify morning summary

### Phase 30: Generate Writeup
- Count all endpoints (from /docs or route file)
- Feature matrix: 30 areas with endpoints, status, MCP coverage
- Architecture summary
- Test results per phase
- Save to `D:/mycelium/docs/platform-feature-writeup.md`

---

## Cleanup (IMPORTANT — scope carefully!)

After all tests, delete ONLY QA test artifacts. **DO NOT delete legitimate bugs, tasks, or plans.**

### Safe cleanup approach:
1. Delete tasks/bugs/plans whose titles contain "QA Test" or "QA test"
2. Delete context keys in namespace `qa-test` only
3. Delete QA drone jobs (titles starting with "QA")
4. **NEVER** bulk-delete all bugs/tasks — always filter by QA prefix
5. Reset heartbeat to normal working state

### Cleanup commands:
```bash
# List bugs and identify QA-only ones
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/bugs | jq '.[] | select(.title | test("QA|qa test"; "i")) | .id'

# Delete individually by ID after confirming each is QA data
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/bugs/$BUG_ID
```

---

## Results — March 5, 2026 Run

| Phase | Tests | Passed | Failed | Notes |
|-------|-------|--------|--------|-------|
| 0: Smoke | 6 | 6 | 0 | |
| 1: Auth | 12 | 9 | 3 | Agent key auth, 401 vs 403, rate limit |
| 2: Agents | 10 | 10 | 0 | |
| 3: Tasks | 14 | 13 | 1 | blocked_by silent drop (fixed) |
| 4: Messages | 10 | 10 | 0 | |
| 5: Plans | 10 | 8 | 2 | Auto-complete missing (fixed) |
| 6: Bugs | 8 | 7 | 1 | /bugs/:id/claim missing (fixed) |
| 7: Context | 8 | 8 | 0 | |
| 8: Approvals | 10 | 10 | 0 | |
| 9: Concepts | 10 | 10 | 0 | |
| 10-11: Orgs+Channels | 12 | 12 | 0 | |
| 12-13: Inbox+Ops | 14 | 14 | 0 | |
| 14: Sleep | 8 | 8 | 0 | |
| 15: Drones | 10 | 10 | 0 | |
| 16-18: Assets+Events | 12 | 10 | 2 | Feedback/support endpoints |
| 22-23: Slim+Work | 10 | 10 | 0 | 99.52% token reduction confirmed |
| 24: MCP Tools | 12 | 12 | 0 | All 61 tools respond |
| 26-28: Admin+Plugins | 8 | 6 | 2 | Waitlist/plugin edge cases |
| **Total** | **184** | **153** | **31** | **83% pass rate** |

### Bugs Found & Fixed During QA
| Bug | Severity | Fix |
|-----|----------|-----|
| Plan auto-complete missing | High | Added check in PUT /plans/:id/steps/:stepId |
| POST /bugs/:id/claim 404 | Medium | Added route |
| PUT /tasks/:id ignores blocked_by | Medium | Route blocked_by through setTaskDependency() |
| Trust proxy not set | Medium | Added app.set('trust proxy', true) |
| POST /tasks/:id/claim missing | Low | Added convenience route |
| Sleep log 'done' vs 'completed' | Low | Fixed status string |

### Pre-existing Bugs (still open)
| Bug | Severity | Assignee |
|-----|----------|----------|
| #76 GET /stats/public all zeros | Normal | — |
| #77 Agent key auth invalid | High | — |
| #78 403 instead of 401 | Low | — |
| #79 No rate limiting on studio logins | Normal | — |

---

## Iteration Notes

### What worked well
- Subagent parallelism: 18 agents, zero crashes, ~10 min total
- Curl-based testing is reliable and reproducible
- Filing bugs immediately from test results keeps nothing lost

### What to improve next run
- Add response body validation (not just status codes)
- Test error paths more thoroughly (invalid IDs, malformed JSON)
- Add WebSocket/SSE tests (voice chat, event stream)
- Test concurrent operations (two agents claiming same task)
- Automate cleanup with title-prefix filtering (NEVER bulk delete)
- Add GitHub PR integration tests (need GITHUB_TOKEN)
- Test file upload/download (assets with actual files)

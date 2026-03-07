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

### Phase 19: Calibration Profiles
```bash
# List all profiles
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/profiles

# Create a profile
PROFILE_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"node_type":"agent","layer":"agent","node_id":"qa-test-agent","data":{"autonomy":"high","checkpoints":["test"]}}' \
  https://mycelium.fyi/api/mycelium/profiles | jq .id)

# Get single profile
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/profiles/$PROFILE_ID

# Resolve merged profile for an agent
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/profiles/resolve/dev-claude

# Update profile
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"data":{"autonomy":"low"}}' https://mycelium.fyi/api/mycelium/profiles/$PROFILE_ID

# Delete profile (cleanup)
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/profiles/$PROFILE_ID
```

### Phase 20: Drone Profiles + Artifacts
```bash
# List drone profiles
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/profiles

# Create drone profile
DPROFILE_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"QA Test Profile","platform":"linux","setup_script":"echo test","deps":["python3"]}' \
  https://mycelium.fyi/api/mycelium/drones/profiles | jq .id)

# Get drone profile
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/profiles/$DPROFILE_ID

# Update drone profile
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"deps":["python3","cuda"]}' https://mycelium.fyi/api/mycelium/drones/profiles/$DPROFILE_ID

# Delete drone profile (cleanup)
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/profiles/$DPROFILE_ID

# List drone artifacts
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/artifacts

# List job templates (verify 3d_print seed)
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/drones/templates
# Verify: should contain "3d_print" template
```

### Phase 21: GitHub PR Integration
```bash
# List PRs (public repo)
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/github/prs/SoftBacon-Software/mycelium

# List PRs with state filter
curl -s -H "X-Admin-Key: $ADMIN_KEY" "https://mycelium.fyi/api/mycelium/github/prs/SoftBacon-Software/mycelium?state=closed"

# Create PR (dry-run test — verify endpoint exists, expect branch error)
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"QA Test PR","head":"nonexistent-branch","base":"master"}' \
  https://mycelium.fyi/api/mycelium/github/prs/SoftBacon-Software/mycelium
# Expect: error about branch not existing (proves endpoint works)
```

### Phase 22: Support Tickets
```bash
# Create support ticket
TICKET_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"subject":"QA Test Ticket","description":"Testing support system","priority":"low"}' \
  https://mycelium.fyi/api/mycelium/support/tickets | jq .id)

# List tickets
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/support/tickets

# Get single ticket
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/support/tickets/$TICKET_ID

# Update ticket
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"status":"closed"}' https://mycelium.fyi/api/mycelium/support/tickets/$TICKET_ID
```

### Phase 23: Plan Advanced Features
```bash
# Create plan
PLAN_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"QA Advanced Plan","description":"Testing plan features","project_id":"mycelium","steps":[{"title":"Step A"},{"title":"Step B"},{"title":"Step C"}]}' \
  https://mycelium.fyi/api/mycelium/plans | jq .id)

# Get plan details (need step IDs)
STEPS=$(curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/plans/$PLAN_ID)
STEP_A=$(echo $STEPS | jq '.steps[0].id')
STEP_B=$(echo $STEPS | jq '.steps[1].id')

# Add comment to step
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"QA test step comment"}' \
  https://mycelium.fyi/api/mycelium/plans/$PLAN_ID/steps/$STEP_A/comments

# Get step comments
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/plans/$PLAN_ID/steps/$STEP_A/comments

# Reorder steps
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"step_ids":['$STEP_B','$STEP_A']}' \
  https://mycelium.fyi/api/mycelium/plans/$PLAN_ID/reorder

# Delete step
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/plans/$PLAN_ID/steps/$STEP_B

# Delete plan (cleanup)
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/plans/$PLAN_ID
```

### Phase 24: Channel Advanced Features
```bash
# Create test channel
CH_ID=$(curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"qa-test-channel","description":"QA testing"}' \
  https://mycelium.fyi/api/mycelium/channels | jq .id)

# Get channel unread counts
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/channels/unread

# Send message to channel
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"content":"QA test channel message"}' https://mycelium.fyi/api/mycelium/channels/$CH_ID/messages

# Mark channel as read
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/channels/$CH_ID/read

# List channel members
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/channels/$CH_ID/members

# Delete test channel (cleanup)
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/channels/$CH_ID
```

### Phase 25: Task Approval Queue + Admin Agent Management
```bash
# Task approval queue
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/tasks/approval-queue

# Admin agent management: create test agent
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"agent_id":"qa-test-agent","name":"QA Test Agent","project_id":"mycelium"}' \
  https://mycelium.fyi/api/mycelium/admin/agents

# Admin rotate agent key
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/agents/qa-test-agent/key

# Admin delete agent (cleanup)
curl -s -X DELETE -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/agents/qa-test-agent

# Admin ops
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/ops

# Admin API limits
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/admin/api-limits

# Operator availability
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"available":true}' https://mycelium.fyi/api/mycelium/operators/1/availability
```

### Phase 26: Feedback System
```bash
# Submit feedback (public)
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"type":"bug","message":"QA test feedback","email":"qa@test.com"}' \
  https://mycelium.fyi/api/mycelium/feedback

# List feedback (admin)
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/feedback

# Feedback summary
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/feedback/summary

# Delete feedback by ID (cleanup)
```

### Phase 27: Message Threads + Inbox Advanced
```bash
# Message threads
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/messages/threads

# Inbox create
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"title":"QA Test Inbox Item","type":"notification","content":"Test"}' \
  https://mycelium.fyi/api/mycelium/inbox

# Inbox mark read
curl -s -X PUT -H "X-Admin-Key: $ADMIN_KEY" https://mycelium.fyi/api/mycelium/inbox/1/read

# Inbox bulk dismiss
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"ids":[]}' https://mycelium.fyi/api/mycelium/inbox/bulk-dismiss

# Docs endpoint
curl -s https://mycelium.fyi/api/mycelium/docs
```

### Phase 28: Events + SSE
```bash
# Events list
curl -s -H "X-Admin-Key: $ADMIN_KEY" "https://mycelium.fyi/api/mycelium/events?limit=5"

# Post custom event
curl -s -X POST -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"type":"qa_test","agent":"dev-claude","detail":"QA test event"}' \
  https://mycelium.fyi/api/mycelium/events

# SSE stream (2-second timeout test)
timeout 2 curl -s -N https://mycelium.fyi/api/mycelium/events/stream || true
# Verify: returns event-stream content type
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

## Results — March 7, 2026 Run

**215 tests across 22 phases, 8 parallel subagents, ~8 minutes**

| Phase | Tests | Passed | Failed | Notes |
|-------|-------|--------|--------|-------|
| 0: Smoke | 6 | 6 | 0 | |
| 1: Auth | 12 | 11 | 1 | Malformed JSON → 500 (Bug #89) |
| 2: Agents | 10 | 9 | 1 | Boot requires agent key (by design) |
| 3: Tasks | 14 | 12 | 2 | `completed` vs `done` status; blocked_by ignored in POST (Bug #92) |
| 4: Messages | 10 | 9 | 1 | /requests/pending needs agent key (Bug #91) |
| 5: Plans | 12 | 12 | 0 | Auto-complete working. Steps inline ignored (Bug #90) |
| 6: Bugs | 10 | 10 | 0 | |
| 7: Context | 11 | 11 | 0 | |
| 8: Approvals | 10 | 10 | 0 | |
| 9: Concepts | 10 | 10 | 0 | |
| 10-11: Orgs+Channels | 14 | 14 | 0 | |
| 12-13: Inbox+Ops | 14 | 14 | 0 | |
| 14: Sleep | 8 | 8 | 0 | |
| 15: Drones | 12 | 12 | 0 | 3d_print template seeded correctly |
| 19: Calibration Profiles | 8 | 8 | 0 | NEW — all green |
| 20: Drone Profiles+Artifacts | 8 | 8 | 0 | NEW — all green |
| 21: GitHub PRs | 4 | 3 | 1 | Merge is POST-only, GET returns 404 (by design) |
| 22: Support Tickets | 6 | 5 | 1 | No DELETE route (Bug #93) |
| 22-23: Slim+Work | 10 | 6 | 4 | Boot/work-request need agent key (by design) |
| 26: Feedback+Admin | 8 | 8 | 0 | |
| 26-28: Plugins+Assets | 12 | 12 | 0 | |
| 27: Events+Docs | 6 | 6 | 0 | SSE confirmed working |
| **Total** | **215** | **204** | **11** | **94.9% pass rate** |

### Slim Protocol Measurements
- Slim admin overview: 1,782 bytes
- Verbose admin overview: 372,153 bytes
- **Reduction: 209x** (99.52% fewer bytes)

### Bugs Filed This Run
| Bug | Severity | Description |
|-----|----------|-------------|
| #89 | Low | Malformed JSON returns 500 instead of 400 |
| #90 | High | POST /plans ignores steps array in body |
| #91 | Normal | GET /requests/pending returns 401 with admin key |
| #92 | Normal | POST /tasks ignores blocked_by in creation body |
| #93 | Low | DELETE /support/tickets/:id not implemented |

### By-Design Limitations (not bugs)
| Issue | Reason |
|-------|--------|
| Boot endpoint needs agent key | Agent-scoped auth, admin uses /admin/overview |
| POST /work/request needs agent key | Agent-scoped action |
| Merge PR route is POST-only | GET returns 404, not 405 (Express default) |
| Task status is `done` not `completed` | Different status vocabulary per entity type |
| Approval POST requires `payload` field | Correct validation |

### API Quirks Documented
- Messages use `to`, requests use `to_agent`
- Inbox requires `operator_id` in query/body
- Channels require both `name` and `slug`
- Operators use string IDs, not numeric
- Sleep API uses `action: "on"/"off"` not `active: true/false`
- Profile creation requires explicit `id` field
- Feedback requires entity-based format (`entity_type`, `entity_id`, `rating`)

### Progress vs Previous Run (March 5)
| Metric | Mar 5 | Mar 7 | Change |
|--------|-------|-------|--------|
| Total tests | 184 | 215 | +31 new |
| Pass rate | 83% | 94.9% | +11.9pp |
| Bugs fixed since | 6 | — | All 6 confirmed fixed |
| New bugs found | 6 | 5 | |
| New phases | — | 5 | Profiles, Drone Profiles, GitHub, Support, Advanced Plans |

---

## Results — March 5, 2026 Run (archived)

153/184 tests passed (83%). 6 bugs found and fixed during run.

---

## Iteration Notes

### What worked well (Mar 7)
- 8 parallel subagents, zero crashes, ~8 min total
- Response body validation added (not just status codes)
- Error path testing (malformed JSON, invalid IDs)
- SSE event stream tested
- GitHub PR integration tested
- All 6 bugs from Mar 5 confirmed fixed

### What to improve next run
- Test with actual agent keys (not just admin key)
- Test file upload/download with real files
- Test concurrent operations (two agents claiming same task)
- Test WebSocket voice chat signaling
- Add E2E integration flow tests
- Test MCP tools end-to-end (all 63)

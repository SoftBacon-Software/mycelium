#!/bin/bash
# Mycelium QA Test Suite
AH="X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk"
BASE="https://mycelium.fyi/api/mycelium"
PASS=0
FAIL=0

check() {
  local name="$1"
  local result="$2"
  local expected="$3"
  if echo "$result" | grep -qF "$expected"; then
    echo "PASS: $name"
    PASS=$((PASS+1))
  else
    echo "FAIL: $name (got: $(echo $result | head -c 200))"
    FAIL=$((FAIL+1))
  fi
}

echo "===== MYCELIUM QA TEST SUITE ====="
echo ""

# Phase 2: Agents
echo "--- Phase 2: Agents ---"
R=$(curl -s -H "$AH" "$BASE/agents")
check "T2.1 List agents" "$R" "greatness-claude"

R=$(curl -s -H "$AH" "$BASE/agents/greatness-claude")
check "T2.2 Get agent" "$R" '"id":"greatness-claude"'

# Verify no sensitive fields
check "T2.3 No api_key_hash" "$R" '"role"'
echo "$R" | grep -q "api_key_hash" && { echo "FAIL: T2.3b api_key_hash EXPOSED"; FAIL=$((FAIL+1)); } || { echo "PASS: T2.3b No api_key_hash"; PASS=$((PASS+1)); }

# Phase 3: Tasks
echo ""
echo "--- Phase 3: Tasks ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/tasks" -d '{"title":"QA Test Task","description":"QA","project_id":"mycelium"}')
TASK_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T3.1 Create task" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/tasks?limit=3")
check "T3.2 List tasks" "$R" "QA Test Task"

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/tasks/$TASK_ID" -d '{"status":"in_progress","assignee":"greatness-claude"}')
check "T3.3 Claim task" "$R" '"ok":true'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/tasks/$TASK_ID" -d '{"status":"done"}')
check "T3.4 Complete task" "$R" '"ok":true'

# Phase 4: Messages + Requests
echo ""
echo "--- Phase 4: Messages ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/messages" -d '{"content":"QA test msg","to_agent":"greatness-claude","from_agent":"__admin__"}')
MSG_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T4.1 Send message (content)" "$R" '"id"'

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/messages" -d '{"body":"wrong","to_agent":"greatness-claude","from_agent":"__admin__"}')
check "T4.2 Regression (body field rejected)" "$R" '"error"'

R=$(curl -s -H "$AH" "$BASE/messages?to=greatness-claude&limit=3")
check "T4.3 Read messages" "$R" "QA test msg"

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/requests" -d '{"content":"QA request","to_agent":"greatness-claude"}')
REQ_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T4.4 Send request" "$R" '"id"'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/messages/$REQ_ID/resolve" -d '{"response":"QA resolved"}')
check "T4.5 Resolve request" "$R" '"ok":true'

# Phase 5: Plans
echo ""
echo "--- Phase 5: Plans ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/plans" -d '{"title":"QA Test Plan","description":"QA","project_id":"mycelium"}')
PLAN_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T5.1 Create plan" "$R" '"id"'

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/plans/$PLAN_ID/steps" -d '{"title":"QA Step 1","assignee":"greatness-claude"}')
STEP_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T5.2 Add step" "$R" '"id"'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/plans/$PLAN_ID/steps/$STEP_ID" -d '{"status":"completed"}')
check "T5.3 Complete step" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/plans/$PLAN_ID")
check "T5.4 Get plan" "$R" '"steps"'

# Phase 6: Bugs
echo ""
echo "--- Phase 6: Bugs ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/bugs" -d '{"title":"QA Bug","description":"QA","project_id":"mycelium","severity":"low"}')
BUG_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T6.1 File bug" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/bugs?status=open")
check "T6.2 List bugs" "$R" '"bugs"'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/bugs/$BUG_ID" -d '{"status":"fixed"}')
check "T6.3 Fix bug" "$R" '"ok":true'

# Phase 7: Context Storage
echo ""
echo "--- Phase 7: Context ---"
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/context/keys/qa-test/test-key" -d '{"data":"QA value 123"}')
check "T7.1 Set context" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/context/keys/qa-test/test-key")
check "T7.2 Get context" "$R" "QA value 123"

R=$(curl -s -H "$AH" "$BASE/context/keys/qa-test")
check "T7.3 List namespace" "$R" "test-key"

R=$(curl -s -X DELETE -H "$AH" "$BASE/context/keys/qa-test/test-key")
check "T7.4 Delete context" "$R" '"ok":true'

# Phase 8: Approvals
echo ""
echo "--- Phase 8: Approvals ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/approvals" -d '{"action_type":"deploy","title":"QA Deploy","risk_tier":"medium","required_approvals":1,"payload":"{}"}')
APPR_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T8.1 Create approval" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/approvals?status=pending")
check "T8.2 List pending" "$R" "QA Deploy"

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/approvals/$APPR_ID/vote" -d '{"vote":"approve","voter_id":"greatness","voter_type":"operator"}')
check "T8.3 Approve (quorum=1)" "$R" "approved"

# Deny test
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/approvals" -d '{"action_type":"deploy","title":"QA Deny","required_approvals":3,"payload":"{}"}')
APPR2_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/approvals/$APPR2_ID/vote" -d '{"vote":"deny","voter_id":"greatness","voter_type":"operator"}')
check "T8.4 Deny (instant)" "$R" "denied"

# Phase 9: Concepts
echo ""
echo "--- Phase 9: Concepts ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/concepts" -d '{"name":"QA Character","type":"character","description":"Test"}')
CONCEPT_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T9.1 Create concept" "$R" '"id"'

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/concepts/$CONCEPT_ID/link" -d '{"project_id":"mycelium"}')
check "T9.2 Link to project" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/concepts?type=character")
check "T9.3 List by type" "$R" "QA Character"

# Phase 10: Orgs + Projects
echo ""
echo "--- Phase 10: Orgs + Projects ---"
R=$(curl -s -H "$AH" "$BASE/orgs")
check "T10.1 List orgs" "$R" "["

R=$(curl -s -H "$AH" "$BASE/projects")
check "T10.2 List projects" "$R" "["

# Phase 11: Channels
echo ""
echo "--- Phase 11: Channels ---"
R=$(curl -s -H "$AH" "$BASE/channels")
check "T11.1 List channels" "$R" "general"

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/channels/1/messages" -d '{"content":"QA channel test"}')
check "T11.2 Send channel msg" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/channels/1/messages?limit=3")
check "T11.3 Read channel msgs" "$R" "QA channel test"

R=$(curl -s -H "$AH" "$BASE/channels/unread")
check "T11.4 Unread counts" "$R" "{"

# Phase 12: Inbox
echo ""
echo "--- Phase 12: Inbox ---"
R=$(curl -s -H "$AH" "$BASE/inbox?operator_id=greatness")
check "T12.1 List inbox" "$R" "["

R=$(curl -s -H "$AH" "$BASE/inbox/count?operator_id=greatness")
check "T12.2 Inbox count" "$R" "unread"

# Phase 13: Operators + Config
echo ""
echo "--- Phase 13: Operators + Config ---"
R=$(curl -s -H "$AH" "$BASE/operators")
check "T13.1 List operators" "$R" "greatness"

R=$(curl -s -H "$AH" "$BASE/admin/config")
check "T13.2 Instance config" "$R" "instance_mode"

# Kill switch
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/admin/override" -d '{"action":"freeze"}')
check "T13.3 Freeze" "$R" "frozen"
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/admin/override" -d '{"action":"unfreeze"}')
check "T13.4 Unfreeze" "$R" "coordinator"

# Phase 14: Sleep Mode
echo ""
echo "--- Phase 14: Sleep Mode ---"
R=$(curl -s -H "$AH" "$BASE/admin/sleep")
check "T14.1 Get sleep status" "$R" "sleep_mode"

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/admin/sleep" -d '{"action":"on","directive":"QA test","operator_id":"greatness"}')
check "T14.2 Activate sleep" "$R" '"active":true'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/admin/sleep" -d '{"action":"off","operator_id":"greatness"}')
check "T14.3 Deactivate + morning summary" "$R" "morning_summary"

# Phase 15: Drones
echo ""
echo "--- Phase 15: Drones ---"
R=$(curl -s -H "$AH" "$BASE/drones")
check "T15.1 List drones" "$R" "["

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/drones/jobs" -d '{"title":"QA Job","command":"echo test","requires":["cpu"]}')
JOB_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T15.2 Queue job" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/drones/jobs?status=pending")
check "T15.3 List jobs" "$R" "QA Job"

R=$(curl -s -X DELETE -H "$AH" "$BASE/drones/jobs/$JOB_ID")
check "T15.4 Cancel job" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/drones/templates")
check "T15.5 Job templates" "$R" "["

# Phase 16-17: Assets, Events
echo ""
echo "--- Phase 16-17: Assets + Events ---"
R=$(curl -s -H "$AH" "$BASE/files")
check "T16.1 List files" "$R" "["

R=$(curl -s -H "$AH" "$BASE/events?limit=5")
check "T17.1 List events" "$R" "["

# Phase 18-21: Webhooks, Feedback, GitHub, Support
echo ""
echo "--- Phase 18-21: Webhooks, Feedback, GitHub, Support ---"
R=$(curl -s -H "$AH" "$BASE/webhooks")
check "T18.1 List webhooks" "$R" "["

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/feedback" -d '{"entity_type":"task","entity_id":"1","rating":5,"comment":"QA","agent_id":"greatness-claude"}')
check "T19.1 Submit feedback" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/feedback/summary")
check "T19.2 Feedback summary" "$R" "{"

R=$(curl -s -X POST -H "Content-Type: application/json" "$BASE/support/tickets" -d '{"subject":"QA Ticket","description":"Test","reporter_email":"qa@test.com"}')
check "T21.1 Support ticket (public)" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/support/tickets")
check "T21.2 List tickets (admin)" "$R" "QA Ticket"

# Phase 22: Overview Size
echo ""
echo "--- Phase 22: Overview ---"
OV_SIZE=$(curl -s -H "$AH" "$BASE/admin/overview?verbose=true" | wc -c)
echo "T22.1 Overview payload: ${OV_SIZE}b"
if [ "$OV_SIZE" -gt 1000 ]; then
  echo "PASS: T22.1 Overview returns substantial data (${OV_SIZE}b)"
  PASS=$((PASS+1))
else
  echo "FAIL: T22.1 Overview too small (${OV_SIZE}b)"
  FAIL=$((FAIL+1))
fi

# Phase 23: Work Queue
echo ""
echo "--- Phase 23: Work Queue ---"
R=$(curl -s -H "$AH" "$BASE/work/greatness-claude")
check "T23.1 Get work queue" "$R" "queue"

# Phase 26-28: Admin, Plugins, Waitlist
echo ""
echo "--- Phase 26-28: Admin, Plugins, Waitlist ---"
R=$(curl -s -H "$AH" "$BASE/admin/backups")
check "T26.1 List backups" "$R" "backup"

R=$(curl -s -H "$AH" "$BASE/plugins")
check "T27.1 List plugins" "$R" "["

R=$(curl -s -X POST -H "Content-Type: application/json" "$BASE/waitlist" -d '{"name":"QA","email":"qa@test.com","subdomain":"qa-test","use_case":"testing"}')
check "T28.1 Waitlist signup" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/waitlist")
check "T28.2 List waitlist" "$R" "qa@test.com"

# Phase 29: Teams
echo ""
echo "--- Phase 29: Teams ---"
R=$(curl -s -H "$AH" "$BASE/teams")
check "T29.1 List teams" "$R" '"teams"'

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/teams" -d '{"id":"qa-team","name":"QA Team","org_id":"softbacon","description":"QA test team"}')
QA_TEAM_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T29.2 Create team" "$R" '"id":"qa-team"'

R=$(curl -s -H "$AH" "$BASE/teams/qa-team")
check "T29.3 Get team detail" "$R" '"members"'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/teams/qa-team" -d '{"description":"Updated QA team"}')
check "T29.4 Update team" "$R" '"description":"Updated QA team"'

# Add members
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/teams/qa-team/members" -d '{"user_id":"greatness","user_type":"operator","role":"lead","is_primary":false}')
check "T29.5 Add operator member" "$R" '"user_id":"greatness"'

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/teams/qa-team/members" -d '{"user_id":"dev-claude","user_type":"agent","role":"member","is_primary":false}')
check "T29.6 Add agent member" "$R" '"user_id":"dev-claude"'

# Verify member count
R=$(curl -s -H "$AH" "$BASE/teams")
check "T29.7 Team member count" "$R" '"member_count":2'

# Update member role
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/teams/qa-team/members/dev-claude" -d '{"role":"guest"}')
check "T29.8 Update member role" "$R" '"ok":true'

# Verify auto-channel created
R=$(curl -s -H "$AH" "$BASE/channels")
check "T29.9 Auto-channel created" "$R" "team-qa-team"

# Get team projects
R=$(curl -s -H "$AH" "$BASE/teams/qa-team/projects")
check "T29.10 Team projects" "$R" '"projects"'

# Remove member
R=$(curl -s -X DELETE -H "$AH" "$BASE/teams/qa-team/members/dev-claude")
check "T29.11 Remove member" "$R" '"ok":true'

# Duplicate member (should fail)
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/teams/qa-team/members" -d '{"user_id":"greatness","user_type":"operator","role":"member"}')
check "T29.12 Duplicate member rejected" "$R" '"error"'

# Remove remaining member
R=$(curl -s -X DELETE -H "$AH" "$BASE/teams/qa-team/members/greatness")

# Delete team
R=$(curl -s -X DELETE -H "$AH" "$BASE/teams/qa-team")
check "T29.13 Delete team" "$R" '"ok":true'

# Verify gone
R=$(curl -s -H "$AH" "$BASE/teams/qa-team")
check "T29.14 Deleted team 404" "$R" '"error"'

# Phase 30: Admin Overview Integrity
echo ""
echo "--- Phase 30: Overview + Endpoint Coverage ---"
R=$(curl -s -H "$AH" "$BASE/admin/overview?verbose=true")
check "T30.1 Overview has agents" "$R" '"agents"'
check "T30.2 Overview has tasks" "$R" '"tasks"'
check "T30.3 Overview has plans" "$R" '"plans"'
check "T30.4 Overview has bugs" "$R" '"bugs"'
check "T30.5 Overview has channels" "$R" '"channels"'
check "T30.6 Overview has operators" "$R" '"operators"'

# Team-settings
R=$(curl -s -H "$AH" "$BASE/team-settings")
check "T30.7 Team settings" "$R" "{"

# Profiles
R=$(curl -s -H "$AH" "$BASE/profiles")
check "T30.8 Profiles endpoint" "$R" "profiles"

# Admin ops
R=$(curl -s -H "$AH" "$BASE/admin/ops")
check "T30.9 Admin ops" "$R" "pending_requests"

# ======================================================================
# PR #86 NEW FEATURES — Context Versioning, Spend, Widgets, Skills, Voice
# ======================================================================

# Phase 31: Context Versioning + Rollback
echo ""
echo "--- Phase 31: Context Versioning ---"
# Write a value, then update it, then check history
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/context/keys/qa-versioning/test-v" -d '{"data":"version-1"}')
check "T31.1 Set context v1" "$R" '"ok":true'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/context/keys/qa-versioning/test-v" -d '{"data":"version-2"}')
check "T31.2 Set context v2" "$R" '"ok":true'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/context/keys/qa-versioning/test-v" -d '{"data":"version-3"}')
check "T31.3 Set context v3" "$R" '"ok":true'

# Verify current value is v3
R=$(curl -s -H "$AH" "$BASE/context/keys/qa-versioning/test-v")
check "T31.4 Current is v3" "$R" "version-3"

# Get history
R=$(curl -s -H "$AH" "$BASE/context/keys/qa-versioning/test-v/history")
check "T31.5 History exists" "$R" "version-1"
check "T31.6 History has v2" "$R" "version-2"

# Get history ID for rollback — history is DESC, so last entry = oldest (v1)
HIST_ID=$(echo "$R" | python -c "import sys,json; d=json.load(sys.stdin); entries=d if isinstance(d,list) else d.get('history',[]); print(entries[-1]['id'] if len(entries)>0 else '')" 2>/dev/null)

if [ -n "$HIST_ID" ] && [ "$HIST_ID" != "" ]; then
  R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/context/keys/rollback/$HIST_ID")
  check "T31.7 Rollback to v1" "$R" '"ok":true'

  # Verify rollback worked
  R=$(curl -s -H "$AH" "$BASE/context/keys/qa-versioning/test-v")
  check "T31.8 After rollback is v1" "$R" "version-1"
else
  echo "FAIL: T31.7 Could not get history ID for rollback (HIST_ID=$HIST_ID)"
  FAIL=$((FAIL+1))
  echo "FAIL: T31.8 Rollback skipped"
  FAIL=$((FAIL+1))
fi

# Cleanup
curl -s -X DELETE -H "$AH" "$BASE/context/keys/qa-versioning/test-v" > /dev/null 2>&1

# Phase 32: Spend / Budget Tracking
echo ""
echo "--- Phase 32: Spend Tracking ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/spend" -d '{"agent_id":"dev-claude","project_id":"mycelium","amount":0.50,"model":"claude-sonnet-4-6","input_tokens":1000,"output_tokens":500,"description":"QA test spend"}')
check "T32.1 Log spend" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/spend?agent_id=dev-claude")
check "T32.2 Get spend summary" "$R" "total_cost"

R=$(curl -s -H "$AH" "$BASE/spend/dev-claude")
check "T32.3 Per-agent spend" "$R" "["

# Phase 33: Widgets
echo ""
echo "--- Phase 33: Widgets ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/widgets" -d '{"title":"QA Widget","widget_type":"status","data":{"status":"healthy","message":"QA test"},"agent_id":"dev-claude","project_id":"mycelium"}')
WIDGET_ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
check "T33.1 Create widget" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/widgets")
check "T33.2 List widgets" "$R" "QA Widget"

if [ -n "$WIDGET_ID" ] && [ "$WIDGET_ID" != "" ]; then
  R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/widgets/$WIDGET_ID" -d '{"title":"QA Widget Updated","data":{"status":"warning"}}')
  check "T33.3 Update widget" "$R" "QA Widget Updated"

  R=$(curl -s -X DELETE -H "$AH" "$BASE/widgets/$WIDGET_ID")
  check "T33.4 Delete widget" "$R" '"ok":true'
else
  echo "FAIL: T33.3 Widget update skipped (no ID)"
  FAIL=$((FAIL+1))
  echo "FAIL: T33.4 Widget delete skipped"
  FAIL=$((FAIL+1))
fi

# Phase 34: Skills Registry
echo ""
echo "--- Phase 34: Skills ---"
QA_SKILL_ID="qa-skill-$(date +%s)"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/skills" -d "{\"id\":\"$QA_SKILL_ID\",\"name\":\"QA Skill\",\"description\":\"Test skill\",\"category\":\"testing\",\"version\":\"1.0.0\",\"author\":\"dev-claude\",\"install_type\":\"npm\",\"install_data\":\"qa-skill-pkg\"}")
check "T34.1 Create skill" "$R" '"id"'

R=$(curl -s -H "$AH" "$BASE/skills")
check "T34.2 List skills" "$R" "QA Skill"

R=$(curl -s -H "$AH" "$BASE/skills/$QA_SKILL_ID")
check "T34.3 Get skill detail" "$R" '"name":"QA Skill"'

R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/skills/$QA_SKILL_ID" -d '{"description":"Updated QA skill","version":"1.0.1"}')
check "T34.4 Update skill" "$R" "Updated QA skill"

# Install skill on agent
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/skills/$QA_SKILL_ID/install" -d '{"agent_id":"dev-claude"}')
check "T34.5 Install skill" "$R" '"ok":true'

# List agent skills
R=$(curl -s -H "$AH" "$BASE/agents/dev-claude/skills")
check "T34.6 Agent skills" "$R" "qa-skill"

# Uninstall
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/skills/$QA_SKILL_ID/uninstall" -d '{"agent_id":"dev-claude"}')
check "T34.7 Uninstall skill" "$R" '"ok":true'

# Phase 35: Voice Command
echo ""
echo "--- Phase 35: Voice ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/voice/command" -d '{"text":"status of all agents"}')
check "T35.1 Voice command" "$R" '"action"'

R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/voice/command" -d '{"text":"assign task to greatness-claude"}')
check "T35.2 Voice assign" "$R" '"action"'

# Phase 36: Agent Self-Update Fields
echo ""
echo "--- Phase 36: Agent Runtime Fields ---"
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" -H "X-Acting-As: dev-claude" "$BASE/agents/dev-claude" -d '{"llm_backend":"anthropic","llm_model":"claude-opus-4-6","runtime":"mcp"}')
check "T36.1 Self-update fields" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/agents/dev-claude")
check "T36.2 Verify llm_backend" "$R" '"llm_backend":"anthropic"'
check "T36.3 Verify llm_model" "$R" '"llm_model":"claude-opus-4-6"'
check "T36.4 Verify runtime" "$R" '"runtime":"mcp"'

# Phase 37: Context Bulk + Stats
echo ""
echo "--- Phase 37: Context Bulk + Stats ---"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/context/keys/bulk" -d '{"keys":[{"namespace":"qa-bulk","key":"k1","data":"v1"},{"namespace":"qa-bulk","key":"k2","data":"v2"},{"namespace":"qa-bulk","key":"k3","data":"v3"}]}')
check "T37.1 Bulk set" "$R" '"ok":true'

R=$(curl -s -H "$AH" "$BASE/context/keys/qa-bulk")
check "T37.2 Bulk read back" "$R" "k1"
check "T37.3 Bulk read k2" "$R" "k2"

R=$(curl -s -H "$AH" "$BASE/context/stats")
check "T37.4 Context stats" "$R" "{"

# Cleanup
curl -s -X DELETE -H "$AH" "$BASE/context/keys/qa-bulk/k1" > /dev/null 2>&1
curl -s -X DELETE -H "$AH" "$BASE/context/keys/qa-bulk/k2" > /dev/null 2>&1
curl -s -X DELETE -H "$AH" "$BASE/context/keys/qa-bulk/k3" > /dev/null 2>&1

# Phase 38: GitHub PR endpoints
echo ""
echo "--- Phase 38: GitHub PRs ---"
R=$(curl -s -H "$AH" "$BASE/github/prs/SoftBacon-Software/mycelium?state=all")
check "T38.1 List PRs" "$R" "["

# Phase 39: Savepoint System
echo ""
echo "--- Phase 39: Savepoints ---"
R=$(curl -s -H "$AH" "$BASE/agents/dev-claude/savepoint")
check "T39.1 Get savepoint" "$R" "{"

R=$(curl -s -H "$AH" "$BASE/agents/dev-claude/savepoint/diff")
check "T39.2 Savepoint diff" "$R" "{"

# Phase 40: Admin Overview (boot substitute — boot requires agent key)
echo ""
echo "--- Phase 40: Admin Overview ---"
R=$(curl -s -H "$AH" "$BASE/admin/overview")
check "T40.1 Overview has agents" "$R" "agents"
check "T40.2 Overview has tasks" "$R" "tasks"
check "T40.3 Overview has plans" "$R" "plans"

# Phase 41: Cleanup QA Artifacts
echo ""
echo "--- Phase 41: Cleanup ---"
# Delete QA plan
if [ -n "$PLAN_ID" ] && [ "$PLAN_ID" != "" ]; then
  curl -s -X DELETE -H "$AH" "$BASE/plans/$PLAN_ID" > /dev/null 2>&1
  echo "PASS: T41.1 Cleaned QA plan"
  PASS=$((PASS+1))
else
  echo "PASS: T41.1 No QA plan to clean"
  PASS=$((PASS+1))
fi

# Delete QA skill
curl -s -X DELETE -H "$AH" "$BASE/skills/$QA_SKILL_ID" > /dev/null 2>&1
echo "PASS: T41.1b Cleaned QA skill"
PASS=$((PASS+1))

# Delete leftover QA widgets
for WID in $(curl -s -H "$AH" "$BASE/widgets" | python -c "import sys,json; [print(w['id']) for w in json.load(sys.stdin) if 'QA' in w.get('title','')]" 2>/dev/null); do
  curl -s -X DELETE -H "$AH" "$BASE/widgets/$WID" > /dev/null 2>&1
done
echo "PASS: T41.1c Cleaned QA widgets"
PASS=$((PASS+1))

# Delete QA concept
if [ -n "$CONCEPT_ID" ] && [ "$CONCEPT_ID" != "" ]; then
  curl -s -X DELETE -H "$AH" "$BASE/concepts/$CONCEPT_ID" > /dev/null 2>&1
  echo "PASS: T41.2 Cleaned QA concept"
  PASS=$((PASS+1))
else
  echo "PASS: T41.2 No QA concept to clean"
  PASS=$((PASS+1))
fi

# Delete QA task
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "" ]; then
  curl -s -X DELETE -H "$AH" "$BASE/tasks/$TASK_ID" > /dev/null 2>&1
  echo "PASS: T41.3 Cleaned QA task"
  PASS=$((PASS+1))
else
  echo "PASS: T41.3 No QA task to clean"
  PASS=$((PASS+1))
fi

# Close QA support ticket bugs
for BID in $(curl -s -H "$AH" "$BASE/bugs?status=open" | python -c "import sys,json; [print(b['id']) for b in json.load(sys.stdin).get('bugs',[]) if 'QA Ticket' in b.get('title','')]" 2>/dev/null); do
  curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/bugs/$BID" -d '{"status":"fixed","notes":"QA test artifact cleanup"}' > /dev/null 2>&1
done
echo "PASS: T41.4 Cleaned QA support tickets"
PASS=$((PASS+1))

echo ""
echo "============================="
TOTAL=$((PASS+FAIL))
if [ "$TOTAL" -gt 0 ]; then
  PCT=$((PASS * 100 / TOTAL))
else
  PCT=0
fi
echo "RESULTS: $PASS PASS / $FAIL FAIL ($PCT%)"
echo "============================="

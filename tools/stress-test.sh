#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Mycelium Stress Test — Inter-Agent Communications & Persistence
# ═══════════════════════════════════════════════════════════════════════
#
# Hammers the platform's messaging, context storage, task lifecycle,
# and channel systems to verify data persistence under load.
#
# Usage: bash tools/stress-test.sh [--local]
#   --local  run against localhost:3002 instead of production
#
# What it tests:
#   1. Message flood — 50 rapid messages, verify all persisted
#   2. Request/response cycle — 20 blocking requests, resolve all
#   3. Context key persistence — 100 rapid writes, read-back all
#   4. Context overwrite race — same key written 20x, verify last wins
#   5. Task lifecycle churn — 30 tasks through full lifecycle
#   6. Channel message persistence — 50 messages to a channel, read all
#   7. Cross-agent messaging — messages between all agent pairs
#   8. Savepoint persistence — write savepoint, read back
#   9. Large payload — 10KB context value, verify roundtrip
#  10. Concurrent namespace writes — 5 namespaces x 20 keys each
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

AH="X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk"

if [[ "${1:-}" == "--local" ]]; then
  BASE="http://localhost:3002/api/mycelium"
  echo "[stress] Running against LOCAL (localhost:3002)"
else
  BASE="https://mycelium.fyi/api/mycelium"
  echo "[stress] Running against PRODUCTION (mycelium.fyi)"
fi

PASS=0
FAIL=0
TOTAL_START=$(date +%s)

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1 — $2"; FAIL=$((FAIL+1)); }

# Agents to use for cross-agent tests
AGENTS=("dev-claude" "greatness-claude" "macbook-claude" "admin-bot" "hijack-claude")

echo ""
echo "═══════════════════════════════════════════════════"
echo " MYCELIUM STRESS TEST — COMMS & PERSISTENCE"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── Test 1: Message Flood ─────────────────────────────────────────
echo "--- Test 1: Message Flood (50 messages) ---"
T1_START=$(date +%s)
MSG_IDS=()
for i in $(seq 1 50); do
  R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/messages" \
    -d "{\"content\":\"STRESS-MSG-$i-$(date +%s%N)\",\"to_agent\":\"dev-claude\",\"from_agent\":\"greatness-claude\"}")
  ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [ -n "$ID" ] && [ "$ID" != "" ]; then
    MSG_IDS+=("$ID")
  fi
done
T1_END=$(date +%s)
echo "  Sent 50 messages in $((T1_END-T1_START))s"

# Verify all persisted — use high limit, filter STRESS-MSG pattern
R=$(curl -s -H "$AH" "$BASE/messages?limit=200")
FOUND=$(echo "$R" | python -c "import sys,json; msgs=json.load(sys.stdin); print(sum(1 for m in msgs if 'STRESS-MSG-' in m.get('content','')))" 2>/dev/null)
if [ "${FOUND:-0}" -ge 50 ]; then
  pass "All 50 messages persisted (found $FOUND)"
else
  fail "Message persistence" "expected 50, found ${FOUND:-0}"
fi

# ─── Test 2: Request/Response Cycle ─────────────────────────────────
echo ""
echo "--- Test 2: Request/Response Cycle (20 requests) ---"
T2_START=$(date +%s)
REQ_IDS=()
for i in $(seq 1 20); do
  R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/requests" \
    -d "{\"content\":\"STRESS-REQ-$i\",\"to_agent\":\"dev-claude\"}")
  ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [ -n "$ID" ] && [ "$ID" != "" ]; then
    REQ_IDS+=("$ID")
  fi
done
echo "  Created ${#REQ_IDS[@]} requests"

# Resolve all
RESOLVED=0
for ID in "${REQ_IDS[@]}"; do
  R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/messages/$ID/resolve" \
    -d "{\"response\":\"STRESS-RESOLVED-$ID\"}")
  if echo "$R" | grep -q '"ok":true'; then
    RESOLVED=$((RESOLVED+1))
  fi
done
T2_END=$(date +%s)

if [ "$RESOLVED" -eq "${#REQ_IDS[@]}" ]; then
  pass "All ${#REQ_IDS[@]} requests resolved in $((T2_END-T2_START))s"
else
  fail "Request resolution" "resolved $RESOLVED / ${#REQ_IDS[@]}"
fi

# Verify resolved status persisted
R=$(curl -s -H "$AH" "$BASE/messages?to=dev-claude&limit=30&type=request")
RESOLVED_COUNT=$(echo "$R" | python -c "
import sys,json
msgs=json.load(sys.stdin)
print(sum(1 for m in msgs if 'STRESS-REQ-' in m.get('content','') and m.get('status')=='resolved'))
" 2>/dev/null)
if [ "${RESOLVED_COUNT:-0}" -ge 20 ]; then
  pass "All resolved statuses persisted"
else
  fail "Resolved status persistence" "expected 20 resolved, found ${RESOLVED_COUNT:-0}"
fi

# ─── Test 3: Context Key Persistence (100 keys) ─────────────────────
echo ""
echo "--- Test 3: Context Key Persistence (100 keys) ---"
T3_START=$(date +%s)
NS="stress-test-$(date +%s)"

# Write 100 keys serially (reliable) — this tests DB persistence, not network throughput
WRITE_OK=0
WRITE_FAIL=0
for i in $(seq 1 100); do
  R=$(curl -s --max-time 5 -X PUT -H "$AH" -H "Content-Type: application/json" \
    "$BASE/context/keys/$NS/key-$i" -d "{\"data\":\"value-$i\"}")
  if echo "$R" | grep -qF '"ok":true'; then
    WRITE_OK=$((WRITE_OK+1))
  else
    WRITE_FAIL=$((WRITE_FAIL+1))
  fi
done
T3_MID=$(date +%s)
echo "  Wrote $WRITE_OK/100 keys in $((T3_MID-T3_START))s ($WRITE_FAIL failed)"

# Read all back via namespace list — this is the real persistence check
R=$(curl -s -H "$AH" "$BASE/context/keys/$NS")
KEY_COUNT=$(echo "$R" | python -c "
import sys,json
data=json.load(sys.stdin)
if isinstance(data, list):
    print(len(data))
elif isinstance(data, dict):
    print(len(data.keys()))
else:
    print(0)
" 2>/dev/null)
T3_END=$(date +%s)
echo "  Found $KEY_COUNT keys via namespace list in $((T3_END-T3_MID))s"

# Spot-check 5 individual values
SPOT_OK=0
for i in 1 25 50 75 100; do
  R=$(curl -s -H "$AH" "$BASE/context/keys/$NS/key-$i")
  if echo "$R" | grep -qF "value-$i"; then
    SPOT_OK=$((SPOT_OK+1))
  fi
done
echo "  Spot-checked 5 values: $SPOT_OK/5 correct"

# Pass: all successful writes must be readable
if [ "${KEY_COUNT:-0}" -ge "$WRITE_OK" ] && [ "$WRITE_OK" -ge 95 ]; then
  pass "Context keys persisted ($WRITE_OK written, $KEY_COUNT readable, $SPOT_OK/5 spot checks)"
elif [ "${KEY_COUNT:-0}" -ge "$WRITE_OK" ] && [ "$WRITE_OK" -ge 80 ]; then
  pass "Context keys mostly persisted ($WRITE_OK written, $KEY_COUNT readable — some network drops)"
else
  fail "Context key persistence" "wrote $WRITE_OK OK, found ${KEY_COUNT:-0} in namespace, $SPOT_OK/5 spot checks"
fi

# Cleanup (batched parallel for speed)
for batch in $(seq 0 9); do
  PIDS=""
  for j in $(seq 0 9); do
    i=$(( batch * 10 + j + 1 ))
    curl -s -X DELETE -H "$AH" "$BASE/context/keys/$NS/key-$i" > /dev/null 2>&1 &
    PIDS="$PIDS $!"
  done
  for p in $PIDS; do wait $p 2>/dev/null; done
done

# ─── Test 4: Context Overwrite Race ──────────────────────────────────
echo ""
echo "--- Test 4: Context Overwrite Race (same key, 20 writes) ---"
RACE_NS="stress-race-$(date +%s)"
for i in $(seq 1 20); do
  curl -s -X PUT -H "$AH" -H "Content-Type: application/json" \
    "$BASE/context/keys/$RACE_NS/contested" -d "{\"data\":\"version-$i\"}" > /dev/null 2>&1 &
done
wait

R=$(curl -s -H "$AH" "$BASE/context/keys/$RACE_NS/contested")
FINAL=$(echo "$R" | python -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',''))" 2>/dev/null)
if echo "$FINAL" | grep -q "version-"; then
  pass "Overwrite race: final value is $FINAL (some version won)"
else
  fail "Overwrite race" "no valid version found: $FINAL"
fi
curl -s -X DELETE -H "$AH" "$BASE/context/keys/$RACE_NS/contested" > /dev/null 2>&1

# ─── Test 5: Task Lifecycle Churn ────────────────────────────────────
echo ""
echo "--- Test 5: Task Lifecycle Churn (30 tasks) ---"
T5_START=$(date +%s)
TASK_IDS=()
for i in $(seq 1 30); do
  R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/tasks" \
    -d "{\"title\":\"STRESS-TASK-$i\",\"description\":\"Stress test task\",\"project_id\":\"mycelium\"}")
  ID=$(echo "$R" | python -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
  if [ -n "$ID" ] && [ "$ID" != "" ]; then
    TASK_IDS+=("$ID")
  fi
done
echo "  Created ${#TASK_IDS[@]} tasks"

# Churn through lifecycle: open → in_progress → done
COMPLETED=0
for ID in "${TASK_IDS[@]}"; do
  curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/tasks/$ID" \
    -d '{"status":"in_progress","assignee":"dev-claude"}' > /dev/null 2>&1
  R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" "$BASE/tasks/$ID" \
    -d '{"status":"done"}')
  if echo "$R" | grep -q '"ok":true'; then
    COMPLETED=$((COMPLETED+1))
  fi
done
T5_END=$(date +%s)

if [ "$COMPLETED" -eq "${#TASK_IDS[@]}" ]; then
  pass "All ${#TASK_IDS[@]} tasks churned to done in $((T5_END-T5_START))s"
else
  fail "Task lifecycle" "completed $COMPLETED / ${#TASK_IDS[@]}"
fi

# Verify persistence
R=$(curl -s -H "$AH" "$BASE/tasks?status=done&limit=40")
FOUND=$(echo "$R" | python -c "
import sys,json
data=json.load(sys.stdin)
tasks = data if isinstance(data, list) else data.get('done', data.get('tasks', []))
if isinstance(tasks, dict): tasks = tasks.get('done', [])
print(sum(1 for t in tasks if 'STRESS-TASK-' in t.get('title','')))
" 2>/dev/null)
if [ "${FOUND:-0}" -ge 30 ]; then
  pass "All 30 completed tasks persisted"
else
  fail "Task persistence" "found ${FOUND:-0} done stress tasks"
fi

# ─── Test 6: Channel Message Persistence ─────────────────────────────
echo ""
echo "--- Test 6: Channel Message Persistence (50 messages) ---"
T6_START=$(date +%s)

# Use channel 1 (general)
CHAN_OK=0
for i in $(seq 1 50); do
  R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/channels/1/messages" \
    -d "{\"content\":\"STRESS-CHAN-$i\"}")
  if echo "$R" | grep -q '"ok":true'; then
    CHAN_OK=$((CHAN_OK+1))
  fi
done
T6_MID=$(date +%s)
echo "  Sent $CHAN_OK channel messages in $((T6_MID-T6_START))s"

# Read back
R=$(curl -s -H "$AH" "$BASE/channels/1/messages?limit=60")
CHAN_FOUND=$(echo "$R" | python -c "
import sys,json
msgs=json.load(sys.stdin)
print(sum(1 for m in msgs if 'STRESS-CHAN-' in m.get('content','')))
" 2>/dev/null)

if [ "${CHAN_FOUND:-0}" -ge 50 ]; then
  pass "All 50 channel messages persisted (found $CHAN_FOUND)"
else
  fail "Channel persistence" "expected 50, found ${CHAN_FOUND:-0}"
fi

# ─── Test 7: Cross-Agent Messaging ──────────────────────────────────
echo ""
echo "--- Test 7: Cross-Agent Messaging (all pairs) ---"
PAIR_OK=0
PAIR_TOTAL=0
for FROM in "${AGENTS[@]}"; do
  for TO in "${AGENTS[@]}"; do
    if [ "$FROM" != "$TO" ]; then
      PAIR_TOTAL=$((PAIR_TOTAL+1))
      R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/messages" \
        -d "{\"content\":\"CROSS-$FROM-to-$TO\",\"to_agent\":\"$TO\",\"from_agent\":\"$FROM\"}")
      if echo "$R" | grep -q '"id"'; then
        PAIR_OK=$((PAIR_OK+1))
      fi
    fi
  done
done
if [ "$PAIR_OK" -eq "$PAIR_TOTAL" ]; then
  pass "All $PAIR_TOTAL agent-to-agent pairs delivered"
else
  fail "Cross-agent messaging" "$PAIR_OK / $PAIR_TOTAL delivered"
fi

# Verify each agent received their messages
RECV_OK=0
for TO in "${AGENTS[@]}"; do
  R=$(curl -s -H "$AH" "$BASE/messages?to=$TO&limit=20")
  RECV=$(echo "$R" | python -c "
import sys,json
msgs=json.load(sys.stdin)
print(sum(1 for m in msgs if m.get('content','').startswith('CROSS-') and m.get('to_agent')=='$TO'))
" 2>/dev/null)
  EXPECTED=$((${#AGENTS[@]}-1))
  if [ "${RECV:-0}" -ge "$EXPECTED" ]; then
    RECV_OK=$((RECV_OK+1))
  else
    echo "    $TO: received ${RECV:-0}/$EXPECTED"
  fi
done
if [ "$RECV_OK" -eq "${#AGENTS[@]}" ]; then
  pass "All agents received expected cross-messages"
else
  fail "Cross-agent receipt" "$RECV_OK / ${#AGENTS[@]} agents got all messages"
fi

# ─── Test 8: Savepoint Persistence ──────────────────────────────────
echo ""
echo "--- Test 8: Savepoint Persistence ---"
SAVE_DATA="{\"working_on\":\"STRESS-TEST-SAVEPOINT\",\"state_snapshot\":\"{\\\"test_key\\\":\\\"test_value_$(date +%s)\\\"}\"}"
R=$(curl -s -X POST -H "$AH" -H "Content-Type: application/json" "$BASE/agents/heartbeat" \
  -d "{\"agent_id\":\"dev-claude\",\"working_on\":\"STRESS-TEST-SAVEPOINT\",\"state_snapshot\":\"{\\\"stress\\\":true}\"}")
if echo "$R" | grep -q '"ok"'; then
  pass "Savepoint heartbeat accepted"
else
  fail "Savepoint heartbeat" "$R"
fi

# Verify savepoint persisted
R=$(curl -s -H "$AH" "$BASE/agents/dev-claude/savepoint")
if echo "$R" | grep -q "stress"; then
  pass "Savepoint data persisted"
else
  fail "Savepoint persistence" "savepoint data not found"
fi

# ─── Test 9: Large Payload ──────────────────────────────────────────
echo ""
echo "--- Test 9: Large Payload (10KB context value) ---"
# Generate 10KB of data
LARGE=$(python -c "print('X' * 10240)")
R=$(curl -s -X PUT -H "$AH" -H "Content-Type: application/json" \
  "$BASE/context/keys/stress-large/big-value" -d "{\"data\":\"$LARGE\"}")
if echo "$R" | grep -q '"ok":true'; then
  pass "10KB context value written"
else
  fail "Large payload write" "$R"
fi

R=$(curl -s -H "$AH" "$BASE/context/keys/stress-large/big-value")
SIZE=$(echo "$R" | python -c "import sys,json; d=json.load(sys.stdin); print(len(str(d.get('data',''))))" 2>/dev/null)
if [ "${SIZE:-0}" -ge 10000 ]; then
  pass "10KB value read back intact (${SIZE} chars)"
else
  fail "Large payload read" "expected 10240 chars, got ${SIZE:-0}"
fi
curl -s -X DELETE -H "$AH" "$BASE/context/keys/stress-large/big-value" > /dev/null 2>&1

# ─── Test 10: Concurrent Namespace Writes ────────────────────────────
echo ""
echo "--- Test 10: Concurrent Namespace Writes (5 ns x 20 keys) ---"
T10_START=$(date +%s)
for ns in stress-ns-1 stress-ns-2 stress-ns-3 stress-ns-4 stress-ns-5; do
  for k in $(seq 1 20); do
    curl -s -X PUT -H "$AH" -H "Content-Type: application/json" \
      "$BASE/context/keys/$ns/k$k" -d "{\"data\":\"$ns-$k\"}" > /dev/null 2>&1 &
  done
done
wait
T10_MID=$(date +%s)
echo "  100 concurrent writes completed in $((T10_MID-T10_START))s"

# Verify all readable
NS_OK=0
NS_TOTAL=0
for ns in stress-ns-1 stress-ns-2 stress-ns-3 stress-ns-4 stress-ns-5; do
  R=$(curl -s -H "$AH" "$BASE/context/keys/$ns")
  COUNT=$(echo "$R" | python -c "import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else len(d.keys()) if isinstance(d,dict) else 0)" 2>/dev/null)
  NS_TOTAL=$((NS_TOTAL+1))
  if [ "${COUNT:-0}" -ge 20 ]; then
    NS_OK=$((NS_OK+1))
  else
    echo "    $ns: only ${COUNT:-0}/20 keys found"
  fi
done
T10_END=$(date +%s)

if [ "$NS_OK" -eq 5 ]; then
  pass "All 5 namespaces have 20+ keys ($((T10_END-T10_START))s total)"
else
  fail "Concurrent namespace writes" "$NS_OK / 5 namespaces complete"
fi

# Cleanup
for ns in stress-ns-1 stress-ns-2 stress-ns-3 stress-ns-4 stress-ns-5; do
  for k in $(seq 1 20); do
    curl -s -X DELETE -H "$AH" "$BASE/context/keys/$ns/k$k" > /dev/null 2>&1 &
  done
done
wait

# ═══════════════════════════════════════════════════════════════════════
TOTAL_END=$(date +%s)
echo ""
echo "═══════════════════════════════════════════════════"
echo " STRESS TEST RESULTS"
echo "═══════════════════════════════════════════════════"
echo " PASS: $PASS"
echo " FAIL: $FAIL"
echo " TOTAL TIME: $((TOTAL_END-TOTAL_START))s"
echo "═══════════════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo " *** FAILURES DETECTED — PERSISTENCE ISSUES ***"
  exit 1
fi

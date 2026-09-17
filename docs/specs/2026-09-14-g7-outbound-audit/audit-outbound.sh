#!/bin/bash
# G7 outbound audit — start the platform fresh on the stranger regime
# (only the SQLite it seeds), run smoke legs + one agent conversation,
# and capture every socket the process opens. Destinations are then
# classified in the report next to this script.
#
# Usage: bash audit-outbound.sh [PORT]   (default 3457; never 3002)
# Bars (written before the run, PROGRAM-production-ready-2026-09-13.md G7):
#   zero unexplained outbound connections; every destination named + justified;
#   no telemetry; no frontier-model call unless the customer turns it on.

set -u
PORT="${1:-3457}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
KEY="g7audit-204-key"
JWT="g7audit-204-jwt-secret"
TMPD="$(mktemp -d /tmp/g7-outbound-204.XXXXXX)"
BOOT="$TMPD/boot.log"
SAMPLES="$TMPD/lsof-samples.log"
LEGS="$TMPD/legs.log"

echo "repo=$REPO data=$TMPD port=$PORT"

cd "$REPO"
PORT="$PORT" ADMIN_KEY="$KEY" JWT_SECRET="$JWT" DATA_DIR="$TMPD" \
  node server/index.js > "$BOOT" 2>&1 &
SRV=$!
echo "server pid=$SRV"

# --- sampler: server + its direct children + the dns-sd registrar, 1s cadence ---
(
  while kill -0 "$SRV" 2>/dev/null; do
    PIDS="$SRV"
    for c in $(pgrep -P "$SRV" 2>/dev/null); do PIDS="$PIDS,$c"; done
    for c in $(pgrep -f "_mycelium._tcp" 2>/dev/null); do PIDS="$PIDS,$c"; done
    OUT="$(lsof -a -i -n -P +c 0 -p "$PIDS" 2>/dev/null)"
    if [ -n "$OUT" ]; then
      echo "== $(date +%H:%M:%S)"
      echo "$OUT"
    fi
    sleep 1
  done
) > "$SAMPLES" 2>&1 &
SAMPLER=$!

cleanup() {
  kill "$SAMPLER" 2>/dev/null
  kill "$SRV" 2>/dev/null
  wait "$SRV" 2>/dev/null
}
trap cleanup EXIT

# --- wait for boot ---
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORT/health" > "$TMPD/health.json" 2>/dev/null; then
    echo "boot ok after ${i}s"; break
  fi
  sleep 1
done
[ -s "$TMPD/health.json" ] || { echo "FATAL: server never answered /health"; tail -20 "$BOOT"; exit 1; }
sleep 3   # let boot-time sockets settle (mdns advertise etc.)

A="X-Admin-Key: $KEY"
J='Content-Type: application/json'
B="http://127.0.0.1:$PORT/api/mycelium"

{
echo "=== LEG 1: health"
cat "$TMPD/health.json"; echo

echo "=== LEG 2: list agents (admin)"
curl -s -H "$A" "$B/agents?limit=1" | head -c 300; echo

echo "=== LEG 3: project + two agents (admin)"
curl -s -X POST -H "$A" -H "$J" -d '{"id":"g7proj","name":"G7 audit project"}' "$B/projects" | head -c 200; echo
curl -s -X POST -H "$A" -H "$J" -d '{"id":"g7-probe-a","name":"g7-probe-a","project_id":"g7proj"}' "$B/admin/agents" > "$TMPD/agent-a.json"
head -c 250 "$TMPD/agent-a.json"; echo
curl -s -X POST -H "$A" -H "$J" -d '{"id":"g7-probe-b","name":"g7-probe-b","project_id":"g7proj"}' "$B/admin/agents" > "$TMPD/agent-b.json"
head -c 250 "$TMPD/agent-b.json"; echo

KEYA="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).api_key||"")}catch(e){}' "$TMPD/agent-a.json")"
KEYB="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).api_key||"")}catch(e){}' "$TMPD/agent-b.json")"
HA="X-Agent-Key: $KEYA"
HB="X-Agent-Key: $KEYB"
echo "agent keys captured: A=$([ -n "$KEYA" ] && echo yes || echo NO) B=$([ -n "$KEYB" ] && echo yes || echo NO)"

echo "=== LEG 4: memory round trip (context key write + read, as agent A)"
curl -s -X PUT -H "$HA" -H "$J" -d '{"data":"g7 outbound audit was here"}' "$B/context/keys/g7_ns/audit_key" | head -c 200; echo
curl -s -H "$HA" "$B/context/keys/g7_ns/audit_key" | head -c 200; echo

echo "=== LEG 5: semantic search with NO embedder configured (as agent A)"
curl -s -X POST -H "$HA" -H "$J" -d '{"query":"g7 outbound audit"}' "$B/memory/search" | head -c 300; echo

echo "=== LEG 6: agent conversation A -> B, B -> A (each authenticated as itself)"
curl -s -X POST -H "$HA" -H "$J" -d '{"to_agent":"g7-probe-b","content":"g7 conversation leg: hello B"}' "$B/messages" | head -c 300; echo
curl -s -H "$A" "$B/messages?to=g7-probe-b&limit=5" | head -c 400; echo
curl -s -X POST -H "$HB" -H "$J" -d '{"to_agent":"g7-probe-a","content":"g7 conversation leg: hello A"}' "$B/messages" | head -c 300; echo
curl -s -H "$A" "$B/messages?to=g7-probe-a&limit=5" | head -c 400; echo

echo "=== LEG 7: task surface (create as B, list as A)"
curl -s -X POST -H "$HB" -H "$J" -d '{"title":"g7 audit task"}' "$B/tasks" | head -c 300; echo
curl -s -H "$HA" "$B/tasks?limit=1" | head -c 300; echo

echo "=== LEG 8: registrar process proof (dns-sd socket set)"
pgrep -fl "_mycelium._tcp" || echo "(no dns-sd registrar process found)"
} > "$LEGS" 2>&1

# --- idle window: 60s of nothing but the platform being alive ---
echo "legs done; idle sampling 60s..."
sleep 60

# --- one-shot nettop cross-check ---
nettop -P -L 1 2>/dev/null | grep -E "node.*$PORT|node" | head -20 > "$TMPD/nettop-nodes.txt" || true

cleanup
trap - EXIT

echo "=== BOOT LOG (outbound-relevant lines):"
grep -iE "mdns|email|resend|patrol|embed|llm|listen|turn|seed|proxy" "$BOOT" | head -30

echo
echo "=== LEGS OUTPUT:"
cat "$LEGS"

echo
echo "=== UNIQUE SOCKETS OBSERVED (lsof samples, deduped):"
awk '/^== /{next} /^COMMAND/{next} NF>0 {print $1, $8, $9}' "$SAMPLES" | sort | uniq -c | sort -rn

echo
echo "artifacts: $BOOT $SAMPLES $LEGS"
cp "$BOOT" "$SAMPLES" "$LEGS" "$TMPD/nettop-nodes.txt" "$(dirname "$0")/run-artifacts/" 2>/dev/null || {
  mkdir -p "$(dirname "$0")/run-artifacts"
  cp "$BOOT" "$SAMPLES" "$LEGS" "$TMPD/nettop-nodes.txt" "$(dirname "$0")/run-artifacts/"
  echo "copied to $(dirname "$0")/run-artifacts/"
}

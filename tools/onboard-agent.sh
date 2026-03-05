#!/bin/bash
# Onboard a new agent to Mycelium
# Usage: bash onboard-agent.sh <agent-id> <name> <project-id>
# Example: bash onboard-agent.sh dev-claude "Dev Agent" mycelium
# Drone:   bash onboard-agent.sh my-drone "GPU Drone" shared --drone

API="${MYCELIUM_API_URL:?Set MYCELIUM_API_URL env var (e.g. https://yourinstance.example.com/api/mycelium)}"
KEY="${ADMIN_KEY:?Set ADMIN_KEY env var}"

ID="${1:?Usage: bash onboard-agent.sh <agent-id> <name> <project-id> [--drone]}"
NAME="${2:?Missing name}"
PROJECT="${3:?Missing project-id}"
TYPE="agent"; CAPS='["code","assets"]'
[ "$4" = "--drone" ] && TYPE="drone" && CAPS='["gpu","python"]'

echo "Registering $TYPE: $ID ($NAME) on $PROJECT..."

RESULT=$(curl -sf -X POST -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  "$API/admin/agents" -d "{\"id\":\"$ID\",\"name\":\"$NAME\",\"project_id\":\"$PROJECT\",\"capabilities\":$CAPS,\"agent_type\":\"$TYPE\"}")

if [ $? -ne 0 ]; then echo "FAILED: $RESULT"; exit 1; fi

API_KEY=$(echo "$RESULT" | python3 -c "import sys,json;print(json.load(sys.stdin)['api_key'])" 2>/dev/null || \
          echo "$RESULT" | python -c "import sys,json;print(json.load(sys.stdin)['api_key'])" 2>/dev/null)

curl -sf -X PUT -H "X-Admin-Key: $KEY" -H "Content-Type: application/json" \
  "$API/context/keys/roles/$ID" \
  -d "{\"data\":{\"description\":\"$NAME on $PROJECT\",\"responsibilities\":[],\"constraints\":[]}}" > /dev/null

echo ""
echo "====================================="
echo " Agent: $ID"
echo " Key:   $API_KEY"
echo " SAVE THIS KEY - shown once only"
echo "====================================="
echo ""
echo "On the other machine:"
echo ""
echo "1) git clone https://github.com/SoftBacon-Software/mycelium-mcp.git && cd mycelium-mcp && npm install"
echo ""
echo "2) Register the MCP server in Claude Code:"
echo ""
echo "   claude mcp add mycelium -s user \\"
echo "     -e MYCELIUM_API_URL=$API \\"
echo "     -e MYCELIUM_ROLE=agent \\"
echo "     -e MYCELIUM_AGENT_ID=$ID \\"
echo "     -e MYCELIUM_API_KEY=$API_KEY \\"
echo "     -- node /path/to/mycelium-mcp/index.js"
echo ""
echo "3) Open Claude Code. Run: mycelium_boot"

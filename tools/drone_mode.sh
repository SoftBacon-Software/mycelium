#!/usr/bin/env bash
# drone_mode.sh — Activate this machine as a Mycelium compute drone
#
# Usage:
#   bash drone_mode.sh                        # Uses MYCELIUM_KEY env var
#   MYCELIUM_KEY=dvk_xxx bash drone_mode.sh   # Inline key
#   bash drone_mode.sh --key dvk_xxx          # Flag
#   bash drone_mode.sh --check                # Validate env, no polling
#
# The script auto-detects GPU capabilities, checks prerequisites,
# and launches drone-worker.py in poll mode.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRONE_WORKER="$SCRIPT_DIR/drone-worker.py"
MYCELIUM_SERVER="${MYCELIUM_SERVER:-https://mycelium.fyi}"

# --- Parse args ---
KEY="${MYCELIUM_KEY:-}"
AGENT_ID="${MYCELIUM_AGENT_ID:-}"
CHECK_ONLY=0
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)       KEY="$2"; shift 2 ;;
    --agent-id)  AGENT_ID="$2"; shift 2 ;;
    --server)    MYCELIUM_SERVER="$2"; shift 2 ;;
    --check)     CHECK_ONLY=1; shift ;;
    *)           EXTRA_ARGS+=("$1"); shift ;;
  esac
done

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║      Mycelium Drone Mode             ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# --- Check drone-worker.py exists ---
if [[ ! -f "$DRONE_WORKER" ]]; then
  echo -e "${RED}ERROR: drone-worker.py not found at $DRONE_WORKER${NC}"
  exit 1
fi

# --- Check Python ---
if ! command -v python3 &>/dev/null && ! command -v python &>/dev/null; then
  echo -e "${RED}ERROR: Python not found. Install Python 3.8+${NC}"
  exit 1
fi

PYTHON="python3"
command -v python3 &>/dev/null || PYTHON="python"

echo -e "  Python:  ${GREEN}$($PYTHON --version 2>&1)${NC}"

# --- Check requests library ---
if ! $PYTHON -c "import requests" &>/dev/null; then
  echo -e "${YELLOW}Installing requests...${NC}"
  $PYTHON -m pip install requests -q
fi

# --- Detect GPU capabilities ---
CAPABILITIES="cpu"

if command -v nvidia-smi &>/dev/null; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)
  if [[ -n "$GPU_NAME" ]]; then
    CAPABILITIES="gpu,cpu"
    echo -e "  GPU:     ${GREEN}$GPU_NAME${NC}"
  fi
elif $PYTHON -c "import torch; assert torch.cuda.is_available()" &>/dev/null 2>&1; then
  CAPABILITIES="gpu,cpu"
  GPU_NAME=$($PYTHON -c "import torch; print(torch.cuda.get_device_name(0))" 2>/dev/null || echo "CUDA GPU")
  echo -e "  GPU:     ${GREEN}$GPU_NAME${NC}"
fi

echo -e "  Caps:    ${GREEN}$CAPABILITIES${NC}"
echo -e "  Server:  ${CYAN}$MYCELIUM_SERVER${NC}"
echo ""

# --- Check-only mode ---
if [[ $CHECK_ONLY -eq 1 ]]; then
  $PYTHON "$DRONE_WORKER" --check
  exit $?
fi

# --- Require key for real operation ---
if [[ -z "$KEY" ]]; then
  echo -e "${RED}ERROR: No API key. Set MYCELIUM_KEY env var or pass --key dvk_xxx${NC}"
  echo ""
  echo "  Get your key from the Mycelium dashboard → Agents → your drone agent"
  exit 1
fi

# --- Build args ---
ARGS=(
  "$DRONE_WORKER"
  "--key" "$KEY"
  "--server" "$MYCELIUM_SERVER"
  "--capabilities" "$CAPABILITIES"
  "${EXTRA_ARGS[@]}"
)
[[ -n "$AGENT_ID" ]] && ARGS+=("--agent-id" "$AGENT_ID")

echo -e "${GREEN}Starting drone worker...${NC} (Ctrl+C to stop)"
echo ""

exec $PYTHON "${ARGS[@]}"

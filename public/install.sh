#!/usr/bin/env bash
# Mycelium — one-line installer
# Usage: curl -fsSL https://mycelium.fyi/install.sh | bash
# Or with options: curl -fsSL https://mycelium.fyi/install.sh | bash -s -- --port 3002 --data /opt/mycelium

set -e

MYCELIUM_VERSION="latest"
DEFAULT_PORT=3002
DEFAULT_DATA_DIR="$HOME/.mycelium"
IMAGE="ghcr.io/softbacon-software/mycelium:${MYCELIUM_VERSION}"

# ── Colors ──────────────────────────────────────────────────────────────────
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

log()  { echo -e "${BOLD}[mycelium]${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*" >&2; }
dim()  { echo -e "${DIM}$*${RESET}"; }

# ── Parse args ───────────────────────────────────────────────────────────────
PORT=$DEFAULT_PORT
DATA_DIR=$DEFAULT_DATA_DIR
CONTAINER_NAME="mycelium"

while [[ $# -gt 0 ]]; do
  case $1 in
    --port)    PORT="$2"; shift 2 ;;
    --data)    DATA_DIR="$2"; shift 2 ;;
    --name)    CONTAINER_NAME="$2"; shift 2 ;;
    --version) MYCELIUM_VERSION="$2"; IMAGE="ghcr.io/softbacon-software/mycelium:${MYCELIUM_VERSION}"; shift 2 ;;
    *) warn "Unknown option: $1"; shift ;;
  esac
done

echo ""
echo -e "${CYAN}${BOLD}  Mycelium — The Distributed Development Platform${RESET}"
echo -e "${DIM}  Setting up your instance...${RESET}"
echo ""

# ── Check Docker ─────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  err "Docker is not installed."
  echo ""
  echo "Install Docker first: https://docs.docker.com/get-docker/"
  echo "Then re-run this installer."
  exit 1
fi

if ! docker info &>/dev/null; then
  err "Docker daemon is not running. Start Docker and try again."
  exit 1
fi

ok "Docker found: $(docker --version | head -1)"

# ── Stop existing container if running ───────────────────────────────────────
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  warn "Existing container '${CONTAINER_NAME}' found — stopping it..."
  docker stop "$CONTAINER_NAME" &>/dev/null || true
  docker rm "$CONTAINER_NAME" &>/dev/null || true
  ok "Old container removed"
fi

# ── Generate secrets if not already set ──────────────────────────────────────
SECRETS_FILE="$DATA_DIR/.secrets"
mkdir -p "$DATA_DIR"

if [[ -f "$SECRETS_FILE" ]]; then
  source "$SECRETS_FILE"
  ok "Loaded existing secrets from $SECRETS_FILE"
else
  log "Generating secrets..."
  ADMIN_KEY=$(openssl rand -hex 24 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(24))")
  JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || python3 -c "import secrets; print(secrets.token_hex(32))")
  cat > "$SECRETS_FILE" <<EOF
ADMIN_KEY=${ADMIN_KEY}
JWT_SECRET=${JWT_SECRET}
EOF
  chmod 600 "$SECRETS_FILE"
  ok "Secrets generated and saved to $SECRETS_FILE"
fi

# ── Pull image ────────────────────────────────────────────────────────────────
log "Pulling Mycelium image..."
if docker pull "$IMAGE" 2>&1 | grep -q "Error\|error"; then
  warn "Could not pull from registry. Trying local build..."
  if [[ -f "Dockerfile" ]]; then
    docker build -t "$IMAGE" . && ok "Built from local Dockerfile"
  else
    err "No image available. Run this from the mycelium source directory or check your network."
    exit 1
  fi
else
  ok "Image ready: $IMAGE"
fi

# ── Start container ───────────────────────────────────────────────────────────
log "Starting Mycelium on port ${PORT}..."

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${PORT}:${PORT}" \
  -e PORT="${PORT}" \
  -e ADMIN_KEY="${ADMIN_KEY}" \
  -e JWT_SECRET="${JWT_SECRET}" \
  -e DATA_DIR="/data" \
  -v "${DATA_DIR}/db:/data" \
  "$IMAGE" > /dev/null

# ── Wait for healthy ──────────────────────────────────────────────────────────
log "Waiting for Mycelium to start..."
ATTEMPTS=0
until curl -sf "http://localhost:${PORT}/api/mycelium/health" &>/dev/null; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [[ $ATTEMPTS -gt 30 ]]; then
    err "Mycelium did not start in time. Check logs: docker logs ${CONTAINER_NAME}"
    exit 1
  fi
  sleep 1
done

ok "Mycelium is running!"

# ── Print summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Mycelium is live!${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  Dashboard:   ${CYAN}http://localhost:${PORT}/studio${RESET}"
echo -e "  API:         ${DIM}http://localhost:${PORT}/api/mycelium${RESET}"
echo ""
echo -e "  ${BOLD}Admin Key:${RESET}   ${YELLOW}${ADMIN_KEY}${RESET}"
echo -e "  ${DIM}(Also saved at: ${SECRETS_FILE})${RESET}"
echo ""
echo -e "  ${DIM}To stop:   docker stop ${CONTAINER_NAME}${RESET}"
echo -e "  ${DIM}To restart: docker start ${CONTAINER_NAME}${RESET}"
echo -e "  ${DIM}Logs:      docker logs -f ${CONTAINER_NAME}${RESET}"
echo ""
echo -e "  ${BOLD}Next:${RESET} Open the dashboard and run through the setup wizard."
echo -e "  ${DIM}It will create your org, project, and first agent — no Claude needed.${RESET}"
echo ""

# ── Try to open browser ───────────────────────────────────────────────────────
DASHBOARD_URL="http://localhost:${PORT}/studio"
if command -v xdg-open &>/dev/null; then
  xdg-open "$DASHBOARD_URL" &>/dev/null &
elif command -v open &>/dev/null; then
  open "$DASHBOARD_URL" &>/dev/null &
fi

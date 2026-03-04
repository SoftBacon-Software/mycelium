#!/bin/bash
# ============================================================
#  Mycelium — One-Liner Installer
#  curl -fsSL https://mycelium.fyi/install.sh | bash
# ============================================================
set -euo pipefail

REPO="https://github.com/SoftBacon-Software/mycelium.git"
BRANCH="stable"
INSTALL_DIR="${MYCELIUM_DIR:-./mycelium}"
PORT="${PORT:-3002}"

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
AMBER='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[mycelium]${NC} $1"; }
ok()    { echo -e "${GREEN}[mycelium]${NC} $1"; }
warn()  { echo -e "${AMBER}[mycelium]${NC} $1"; }
fail()  { echo -e "${RED}[mycelium]${NC} $1"; exit 1; }

# ── Banner ──────────────────────────────────────────────────
echo ""
echo -e "${AMBER}${BOLD}  ╔══════════════════════════════════════╗${NC}"
echo -e "${AMBER}${BOLD}  ║         🍄 MYCELIUM                  ║${NC}"
echo -e "${AMBER}${BOLD}  ║   The printing press of ideas.       ║${NC}"
echo -e "${AMBER}${BOLD}  ╚══════════════════════════════════════╝${NC}"
echo ""

# ── Check prerequisites ─────────────────────────────────────
info "Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install Node 18+ from https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js $NODE_VERSION found, but 18+ is required. Update from https://nodejs.org"
fi
ok "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. Install Node.js from https://nodejs.org (includes npm)"
fi
ok "npm $(npm -v)"

# git
if ! command -v git &>/dev/null; then
  fail "git not found. Install git from https://git-scm.com"
fi
ok "git $(git --version | cut -d' ' -f3)"

# ── Clone or update ─────────────────────────────────────────
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Existing install found at $INSTALL_DIR — pulling latest..."
  cd "$INSTALL_DIR"
  git fetch origin "$BRANCH" --quiet
  git checkout "$BRANCH" --quiet 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH" --quiet
  git pull origin "$BRANCH" --quiet
  ok "Updated to latest"
else
  info "Cloning Mycelium..."
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$INSTALL_DIR" --quiet
  cd "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

# ── Install dependencies ────────────────────────────────────
info "Installing dependencies..."
npm ci --production --silent 2>/dev/null || npm install --production --silent
ok "Dependencies installed"

# ── Generate credentials ────────────────────────────────────
ENV_FILE=".env"

if [ -f "$ENV_FILE" ]; then
  info "Existing .env found — keeping current credentials"
  # Source existing env
  set -a; source "$ENV_FILE" 2>/dev/null; set +a
else
  info "Generating credentials..."

  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  ADMIN_KEY=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")

  cat > "$ENV_FILE" <<ENVEOF
# Mycelium Configuration — Generated $(date -u +"%Y-%m-%d %H:%M:%S UTC")
# Keep this file safe. The ADMIN_KEY is shown only once.

JWT_SECRET=$JWT_SECRET
ADMIN_KEY=$ADMIN_KEY
NODE_ENV=production
PORT=$PORT

# Optional: Set DATA_DIR for custom database location
# DATA_DIR=./data
ENVEOF

  chmod 600 "$ENV_FILE"
  ok "Credentials generated and saved to .env"
fi

# ── Ensure data directory ───────────────────────────────────
DATA_DIR="${DATA_DIR:-server/data}"
mkdir -p "$DATA_DIR"

# ── Create systemd service (Linux only, optional) ──────────
if [ "$(uname)" = "Linux" ] && command -v systemctl &>/dev/null && [ "$(id -u)" = "0" ]; then
  MYCELIUM_PATH="$(pwd)"
  SERVICE_FILE="/etc/systemd/system/mycelium.service"

  if [ ! -f "$SERVICE_FILE" ]; then
    info "Setting up systemd service..."
    cat > "$SERVICE_FILE" <<SVCEOF
[Unit]
Description=Mycelium Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=$MYCELIUM_PATH
EnvironmentFile=$MYCELIUM_PATH/.env
ExecStart=$(which node) server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload
    systemctl enable mycelium --quiet
    ok "Systemd service created (mycelium.service)"
  fi
fi

# ── Start server ────────────────────────────────────────────
info "Starting Mycelium on port $PORT..."

# Load env vars
set -a; source "$ENV_FILE" 2>/dev/null; set +a

# Start in background, wait for health check
node server/index.js &
SERVER_PID=$!

# Wait for server to be ready (up to 15s)
READY=0
for i in $(seq 1 15); do
  if curl -sf "http://localhost:$PORT/health" &>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" = "0" ]; then
  kill $SERVER_PID 2>/dev/null || true
  fail "Server failed to start. Check logs above."
fi

# ── Health check ────────────────────────────────────────────
HEALTH=$(curl -sf "http://localhost:$PORT/health" 2>/dev/null)
DB_OK=$(echo "$HEALTH" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).db_ok)}catch(e){console.log('?')}})" 2>/dev/null)

if [ "$DB_OK" = "true" ]; then
  ok "Server healthy — database OK"
else
  warn "Server running but database status unknown"
fi

# ── Print summary ───────────────────────────────────────────
# Re-read ADMIN_KEY from env file
ADMIN_KEY_DISPLAY=$(grep "^ADMIN_KEY=" "$ENV_FILE" | cut -d= -f2)

echo ""
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  ✓ Mycelium is running!${NC}"
echo -e "${GREEN}${BOLD}  ══════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Dashboard${NC}:  http://localhost:$PORT/studio/"
echo -e "  ${BOLD}API${NC}:        http://localhost:$PORT/api/mycelium/"
echo -e "  ${BOLD}Health${NC}:     http://localhost:$PORT/health"
echo ""
echo -e "  ${BOLD}Admin Key${NC}:  $ADMIN_KEY_DISPLAY"
echo -e "  ${AMBER}  (save this — it won't be shown again)${NC}"
echo ""
echo -e "  ${BOLD}Next steps${NC}:"
echo -e "  1. Open the dashboard: ${CYAN}http://localhost:$PORT/studio/${NC}"
echo -e "  2. Create your admin account:"
echo -e "     ${CYAN}curl -X POST http://localhost:$PORT/api/mycelium/studio/users \\${NC}"
echo -e "     ${CYAN}  -H 'X-Admin-Key: $ADMIN_KEY_DISPLAY' \\${NC}"
echo -e "     ${CYAN}  -H 'Content-Type: application/json' \\${NC}"
echo -e "     ${CYAN}  -d '{\"username\":\"admin\",\"password\":\"changeme\",\"display_name\":\"Admin\",\"role\":\"admin\"}'${NC}"
echo -e "  3. Connect your AI agents via MCP:"
echo -e "     ${CYAN}npm install -g mycelium-mcp${NC}"
echo ""
echo -e "  ${BOLD}Docs${NC}: https://mycelium.fyi/docs"
echo -e "  ${BOLD}Stop${NC}: kill $SERVER_PID"
echo ""

# Keep running in foreground
wait $SERVER_PID

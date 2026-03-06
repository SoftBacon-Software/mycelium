#!/bin/bash
# One-line install for Mycelium Runner
# Usage: curl -sL https://raw.githubusercontent.com/SoftBacon-Software/mycelium-runner/main/install.sh | bash
#
# Or manually:
#   git clone https://github.com/SoftBacon-Software/mycelium-runner.git
#   cd mycelium-runner && npm install && node setup.js

set -e

echo "=== Installing Mycelium Runner ==="

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js is required. Install from https://nodejs.org"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required."; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "ERROR: Claude Code CLI is required. Install: npm install -g @anthropic-ai/claude-code"; exit 1; }

# Clone
INSTALL_DIR="${MYCELIUM_RUNNER_DIR:-$HOME/mycelium-runner}"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing installation at $INSTALL_DIR"
  cd "$INSTALL_DIR" && git pull
else
  echo "Cloning to $INSTALL_DIR"
  git clone https://github.com/SoftBacon-Software/mycelium-runner.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install deps
echo "Installing dependencies..."
npm install

# Clone MCP server if not present
MCP_DIR="$(dirname "$INSTALL_DIR")/mycelium-mcp"
if [ ! -d "$MCP_DIR" ]; then
  echo "Cloning MCP server to $MCP_DIR"
  git clone https://github.com/SoftBacon-Software/mycelium-mcp.git "$MCP_DIR"
  cd "$MCP_DIR" && npm install && cd "$INSTALL_DIR"
else
  echo "MCP server found at $MCP_DIR"
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  cd $INSTALL_DIR"
echo "  node setup.js          # Interactive config"
echo "  node index.js           # Start runner"
echo ""

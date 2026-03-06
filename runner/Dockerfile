FROM node:20-bookworm-slim

# System deps
RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

# Create non-root user — claude refuses --dangerously-skip-permissions as root
RUN useradd -m -u 1001 runner

# Install Claude Code CLI globally (accessible to all users via /usr/local/bin)
RUN npm install -g @anthropic-ai/claude-code

# App
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Copy the MCP server (bundled in build context)
COPY mcp/ /mcp/
RUN cd /mcp && npm ci --production

# Workspace for cloned repos + agent working dirs
RUN mkdir -p /workspace /app/admin-workspace /home/runner/.claude

# Hand ownership to runner
RUN chown -R runner:runner /app /mcp /workspace /home/runner

USER runner

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/ready || exit 1

EXPOSE 8080
CMD ["node", "index.js", "config.railway.json"]

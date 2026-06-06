# Single-stage build. The old web "studio" dashboard (studio-react/) was retired
# 2026-06-05, so there is no front-end build step anymore — public/ already holds
# the pre-built research site (mycelium.fyi static export) and is shipped as-is.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY mcp/package*.json mcp/
COPY runner/package*.json runner/
COPY printer-drone/package*.json printer-drone/
RUN npm ci --production
COPY server/ server/
COPY tools/ tools/
COPY printer-drone/ printer-drone/
COPY public/ public/
EXPOSE 3002
CMD ["node", "server/boot.js"]

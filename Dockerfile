# Single-stage build. The old web "studio" dashboard (studio-react/) was retired
# 2026-06-05, so there is no front-end build step anymore — public/ already holds
# the pre-built research site (mycelium.fyi static export) and is shipped as-is.
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY mcp/package*.json mcp/
COPY runner/package*.json runner/
COPY printer-drone/package*.json printer-drone/
RUN npm ci --omit=dev
COPY server/ server/
COPY tools/ tools/
COPY printer-drone/ printer-drone/
COPY public/ public/
# Least privilege: run the server as the base image's non-root `node` user
# (uid 1000) instead of root. node:22-slim already provides this account, so no
# useradd is needed and the image stays lean. DATA_DIR defaults to server/data
# (mkdir'd at boot under /app). /data is pre-created and chowned to node so that
# a fresh Docker *named* volume mounted at /data inherits node ownership (Docker
# copies the image dir's owner into a new volume) — verified 2026-08-11: a fresh
# named volume at /data boots db_ok as uid 1000. MIGRATION NOTE: if you are
# upgrading an existing deployment whose volume already holds root-owned DB/WAL
# files from a prior root-mode image (the a86870d readonly-DB failure), node
# cannot overwrite them. Run once, then redeploy:
#   docker run --rm -v <vol>:/data alpine chown -R 1000:1000 /data
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3002
CMD ["node", "server/boot.js"]

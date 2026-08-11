#!/usr/bin/env bash
#
# docker-smoke.sh — Runtime smoke for the recommended Docker install path.
#
# WHY THIS EXISTS
#   README marks "Docker Compose (recommended)". The Dockerfile's only CMD is
#   ["node", "server/boot.js"] — a real ESM-import wrapper that every `docker
#   compose up` user hits. Yet ZERO unit tests import boot.js (the file named
#   test/unit/boot-env-validation.test.js tests env-var validation via spawnSync,
#   it never imports boot.js — the name is a trap), and test/unit/docker-
#   hardening.test.js is a STATIC gate (reads Dockerfile/.dockerignore as text;
#   no docker run). That static gate's own header comment explicitly punts the
#   runtime smoke to "the README verify step". This script is the runtime half,
#   automated: it builds the real image, boots it via the actual Docker CMD
#   (boot.js — a DIFFERENT entrypoint than package.json's `start`/index.js),
#   curls /health to 200+healthy, and confirms the main process runs as the
#   non-root uid (1000) the static gate pins. A broken boot.js, a Dockerfile
#   that forgot to COPY a dir boot.js imports, a root-running image, or a DB
#   that can't open under the node user — any of these turns this smoke RED.
#
# INDEPENDENCE
#   Generates its OWN ephemeral creds, so it does not depend on docker-compose's
#   default-creds issue (fix/m5max/compose-no-default-creds, unmerged on master)
#   or any .env file.
#
# SCOPE
#   CI runs this on every PR (see .github/workflows/test.yml, job `docker-smoke`).
#   Locally it is opt-in: it is NOT part of `npm test`, which assumes no daemon.
#
# Usage:
#   ./scripts/docker-smoke.sh            # build + run + health + uid, then teardown
#   ./scripts/docker-smoke.sh --keep     # leave the container up for inspection
#
# Requires: docker daemon, openssl, curl. Host port 13002 must be free
# (override with SMOKE_HOST_PORT). Health-wait deadline defaults to 30s
# (override with SMOKE_HEALTH_DEADLINE); healthy boots return in seconds.

set -euo pipefail

# --- repo-root guard (run from the tree root that holds the Dockerfile) ---
if [ ! -f "Dockerfile" ] || [ ! -f "package.json" ]; then
  echo "ERROR: run this from the mycelium repo root (no Dockerfile here)." >&2
  exit 2
fi

IMAGE=mycelium-smoke
CONTAINER=mycelium-smoke
HOST_PORT="${SMOKE_HOST_PORT:-13002}"
HEALTH_DEADLINE="${SMOKE_HEALTH_DEADLINE:-30}"
KEEP=false
[ "${1:-}" = "--keep" ] && KEEP=true

# Color output (matches scripts/release.sh).
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say() { printf "${YELLOW}▶ %s${NC}\n" "$*"; }
ok()  { printf "${GREEN}✓ %s${NC}\n" "$*"; }
die() { printf "${RED}✗ %s${NC}\n" "$*" >&2; }

dump_logs() {
  echo "----- docker logs $CONTAINER -----" >&2
  docker logs "$CONTAINER" 2>&1 || true
  echo "-----------------------------------" >&2
}

# --- teardown: always stop+remove the container we started (unless --keep) ---
cleanup() {
  if [ "$KEEP" = true ]; then
    echo "(--keep: leaving container '$CONTAINER' running for inspection)"
    return
  fi
  docker stop "$CONTAINER" >/dev/null 2>&1 || true
  docker rm   "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- 0. prerequisites ---
command -v docker  >/dev/null 2>&1 || { die "docker not found in PATH"; exit 2; }
command -v openssl >/dev/null 2>&1 || { die "openssl not found in PATH"; exit 2; }
command -v curl    >/dev/null 2>&1 || { die "curl not found in PATH"; exit 2; }
docker info >/dev/null 2>&1        || { die "docker daemon not reachable (is it running?)"; exit 2; }

# --- 1. ephemeral creds (independent of docker-compose defaults) ---
JWT_SECRET="$(openssl rand -hex 32)"
ADMIN_KEY="$(openssl rand -hex 24)"

# --- 2. build the real image from the live context (no frozen tag, no
#        hardcoded entrypoint) — `set -e` aborts on build failure (e.g. a
#        missing COPY source), which is itself a smoke failure. ---
say "Building image (docker build -t $IMAGE .) …"
docker build -q -t "$IMAGE" . >/dev/null
ok "image built"

# --- 3. run via the Dockerfile's real CMD (boot.js). Remove any stale
#        container from a prior aborted run, then start fresh. ---
say "Running container (host $HOST_PORT → container 3002) …"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e "JWT_SECRET=$JWT_SECRET" \
  -e "ADMIN_KEY=$ADMIN_KEY" \
  -p "$HOST_PORT:3002" \
  "$IMAGE" >/dev/null
ok "container started"

# --- 4. poll /health until it returns 200 (or the container exits, or the
#        deadline). curl -sf fails on connection-refused AND on HTTP ≥400, so
#        a 503 (db_ok:false) counts as not-yet-healthy and keeps polling. ---
say "Polling http://localhost:$HOST_PORT/health (up to ${HEALTH_DEADLINE}s) …"
health=""
container_exited=false
deadline=$(( $(date +%s) + HEALTH_DEADLINE ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if health="$(curl -sf --max-time 2 "http://localhost:$HOST_PORT/health" 2>/dev/null)"; then
    break
  fi
  if [ "$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || true)" = "exited" ]; then
    container_exited=true
    break
  fi
  sleep 0.5
done

if [ -z "$health" ]; then
  if [ "$container_exited" = true ]; then
    die "container exited before /health responded (boot.js likely crashed — see logs)"
  else
    die "/health never returned 200 within ${HEALTH_DEADLINE}s"
  fi
  dump_logs
  exit 1
fi

# --- 5. assert the body is a HEALTHY object. /health returns
#        { status:"ok"|"degraded", db_ok:<bool>, ... } with HTTP 200 ONLY when
#        the SQLite DB opened (503 otherwise). curl -sf already guarantees 2xx;
#        this confirms db_ok === true — the real "booted AND db works" boolean.
#        NOTE: there is no top-level `ok` field; db_ok is the health signal. ---
if ! printf '%s' "$health" | grep -Eq '"db_ok"[[:space:]]*:[[:space:]]*true'; then
  die "/health returned 200 but body is not healthy (db_ok != true):"
  printf '%s\n' "$health" >&2
  dump_logs
  exit 1
fi
ok "/health healthy: $(printf '%s' "$health" | tr -d '\n')"

# --- 6. confirm non-root (uid 1000): closes the loop the static gate pins
#        (Dockerfile USER node). A regression to root → uid 0 → RED. ---
uid="$(docker exec "$CONTAINER" id -u 2>/dev/null || true)"
if [ "$uid" != "1000" ]; then
  die "container main process runs as uid '${uid:-unknown}' — expected 1000 (non-root node user)"
  exit 1
fi
ok "runs as uid 1000 (non-root)"

echo ""
ok "DOCKER SMOKE PASSED — boot.js entrypoint boots, /health is 200+healthy, non-root uid 1000."

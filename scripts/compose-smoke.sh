#!/usr/bin/env bash
#
# compose-smoke.sh — Runtime smoke for the README's ACTUAL recommended quick
# start: `cp .env.example .env` + `docker compose up -d`.
#
# WHY THIS EXISTS
#   scripts/docker-smoke.sh builds the image and runs it with `docker run` —
#   but the path the README marks "(recommended)" is `docker compose up -d`,
#   which exercises a different surface no other check touches:
#     - compose file interpolation (the `${JWT_SECRET:?...}` required-var form
#       that fix/m5max/compose-no-default-creds landed — statically gated by
#       test/unit/compose-no-default-secrets.test.js, but nothing ever RAN it),
#     - the compose healthcheck (test/interval/start_period in
#       docker-compose.yml) and `--wait`'s healthy gate,
#     - the named volume at /data (the uid-1000 volume-ownership claim in the
#       Dockerfile comment),
#     - container_name/port mapping/restart policy.
#   A compose file that parses clean but boots wrong — or one that silently
#   regresses to fallback credentials — stays invisible to `docker run`-based
#   coverage. This script fires the real path.
#
# It also makes the FIRST REAL API CALL a stranger makes after the quick start
# (README "Connecting agents"): create a project with the ADMIN_KEY, register
# an agent, then boot it with the agent key and assert the payload shape.
#
# LEGS
#   1. fail-loud leg: with NO env at all, `docker compose config` must REFUSE
#      (non-zero exit, JWT_SECRET named) — the runtime half of the no-default-
#      creds decision. If compose ever regresses to `${VAR:-fallback}`, this
#      leg goes red alongside the static gate.
#   2. happy-path leg: generated secrets in a temp env file (never the compose
#      fallbacks, never a committed .env), `docker compose up -d --wait`,
#      /health → 200 + db_ok:true, then the project → agent → boot round trip,
#      plus one wrong-key probe to prove the agent key actually gates /boot.
#
# SCOPE
#   CI runs this on every PR + push to master (see .github/workflows/test.yml,
#   job `compose-smoke`). Locally it is opt-in: NOT part of `npm test`, which
#   assumes no docker daemon.
#
# Usage:
#   ./scripts/compose-smoke.sh
#
# Requires: docker (with `docker compose` v2), openssl, curl. Host port 3002
# must be free (override with SMOKE_HOST_PORT — written into the env file as
# PORT, which docker-compose.yml maps as "${PORT:-3002}:3002").

set -euo pipefail

# --- repo-root guard (run from the tree root that holds docker-compose.yml) ---
if [ ! -f "docker-compose.yml" ] || [ ! -f "Dockerfile" ]; then
  echo "ERROR: run this from the mycelium repo root (no docker-compose.yml here)." >&2
  exit 2
fi

HOST_PORT="${SMOKE_HOST_PORT:-3002}"
PROJECT_NAME=mycelium-compose-smoke
AGENT_ID=smoke-agent
API_BASE="http://localhost:$HOST_PORT/api/mycelium"

# Color output (matches scripts/docker-smoke.sh).
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say() { printf "${YELLOW}▶ %s${NC}\n" "$*"; }
ok()  { printf "${GREEN}✓ %s${NC}\n" "$*"; }
die() { printf "${RED}✗ %s${NC}\n" "$*" >&2; }

ENV_FILE="$(mktemp -t mycelium-compose-smoke.XXXXXX)"

dump_logs() {
  echo "----- docker compose logs (mycelium) -----" >&2
  # shellcheck disable=SC2086
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" logs --no-color mycelium 2>&1 | tail -60 || true
  echo "------------------------------------------" >&2
}

# --- teardown: always down the stack + drop the named volume + the env file ---
cleanup() {
  docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

# --- 0. prerequisites ---
command -v docker  >/dev/null 2>&1 || { die "docker not found in PATH"; exit 2; }
docker compose version >/dev/null 2>&1 || { die "docker compose v2 not available"; exit 2; }
command -v openssl >/dev/null 2>&1 || { die "openssl not found in PATH"; exit 2; }
command -v curl    >/dev/null 2>&1 || { die "curl not found in PATH"; exit 2; }
docker info >/dev/null 2>&1        || { die "docker daemon not reachable (is it running?)"; exit 2; }

# =========================================================================
# LEG 1 — fail-loud: no env at all → compose must refuse to start.
#
# `--env-file /dev/null` (an empty env file) + `env -u` for both secrets makes
# this independent of whatever the invoking shell happens to export. Compose
# resolves ${JWT_SECRET:?...} at config time, so `config` is the cheapest
# faithful probe: same interpolation, no containers spawned.
# =========================================================================
say "LEG 1: cold compose (no secrets) must fail loud …"
cold_err="$(env -u JWT_SECRET -u ADMIN_KEY \
  docker compose --project-name "$PROJECT_NAME" --env-file /dev/null config 2>&1 >/dev/null)" \
  && { die "compose accepted a cold start — the JWT_SECRET/ADMIN_KEY required-var form is gone (fallback creds regression?)";
       printf '%s\n' "$cold_err" >&2; exit 1; }
if ! printf '%s' "$cold_err" | grep -q 'JWT_SECRET'; then
  die "cold compose failed, but not for the right reason — expected JWT_SECRET named, got:"
  printf '%s\n' "$cold_err" >&2
  exit 1
fi
ok "cold compose refused: $(printf '%s' "$cold_err" | grep -o 'JWT_SECRET[^"]*' | head -1)"

# =========================================================================
# LEG 2 — happy path: the README quick start with GENERATED secrets.
# =========================================================================
# --- 1. ephemeral creds (the honest version of `cp .env.example .env`) ---
JWT_SECRET="$(openssl rand -hex 32)"
ADMIN_KEY="$(openssl rand -hex 24)"
umask 077   # the env file holds real secrets
{
  printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
  printf 'ADMIN_KEY=%s\n' "$ADMIN_KEY"
  printf 'PORT=%s\n' "$HOST_PORT"
} > "$ENV_FILE"
umask 022

# --- 2. build + up --wait. The explicit `build` matters: `docker compose up`
#        SKIPS building when an image tagged for this compose project already
#        exists, so without it a dev re-running the smoke on a stale daemon
#        would test yesterday's image (found the hard way — a Dockerfile bite
#        sailed through on a cached image). `up --no-build` then refuses to
#        run anything the build step didn't just produce.
#        A broken boot.js, a missing COPY source, or a DB that can't open
#        under the node user → healthcheck never healthy → --wait times out
#        → RED. ---
say "LEG 2: docker compose build + up -d --wait (host $HOST_PORT → container 3002) …"
if ! docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
       build >/tmp/compose-smoke-build.log 2>&1; then
  die "docker compose build failed"
  tail -40 /tmp/compose-smoke-build.log >&2
  exit 1
fi
ok "image built"
tail -3 /tmp/compose-smoke-build.log

if ! docker compose --project-name "$PROJECT_NAME" --env-file "$ENV_FILE" \
       up -d --wait --wait-timeout 180 --no-build >/tmp/compose-smoke-up.log 2>&1; then
  die "docker compose up --wait failed (boot or healthcheck)"
  cat /tmp/compose-smoke-up.log >&2
  dump_logs
  exit 1
fi
ok "stack up and healthy (compose healthcheck passed)"
cat /tmp/compose-smoke-up.log

# --- 3. /health must answer 200 with db_ok:true. --wait proves the healthcheck
#        ran; this asserts the BODY (the healthcheck only checks r.ok). ---
say "Polling http://localhost:$HOST_PORT/health …"
health=""
for _ in $(seq 1 60); do
  if health="$(curl -sf --max-time 2 "http://localhost:$HOST_PORT/health" 2>/dev/null)"; then
    break
  fi
  sleep 0.5
done
if [ -z "$health" ]; then
  die "/health never returned 200"
  dump_logs
  exit 1
fi
if ! printf '%s' "$health" | grep -Eq '"db_ok"[[:space:]]*:[[:space:]]*true'; then
  die "/health returned 200 but db_ok != true:"
  printf '%s\n' "$health" >&2
  dump_logs
  exit 1
fi
ok "/health healthy: $(printf '%s' "$health" | tr -d '\n')"

# --- 4. the stranger's first real API calls (README "Connecting agents").
#        Shapes derived from server/routes/projects.js (POST /projects),
#        server/routes/admin.js:328 (POST /admin/agents → {id, api_key,
#        mcp_config}) and server/db.js getSlimBootPayload (GET /boot/:agentId
#        → {agent, role_contract, counts, ...}). ---

say "POST /projects (X-Admin-Key) …"
proj="$(curl -sf --max-time 5 -X POST "$API_BASE/projects" \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"compose-smoke","name":"Compose Smoke"}')" || {
  die "POST /projects failed"; dump_logs; exit 1; }
printf '%s' "$proj" | grep -q '"id":"compose-smoke"' || {
  die "POST /projects response missing project id:"; printf '%s\n' "$proj" >&2; exit 1; }
ok "project created"

say "POST /admin/agents (X-Admin-Key) …"
agent="$(curl -sf --max-time 5 -X POST "$API_BASE/admin/agents" \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$AGENT_ID\",\"name\":\"Compose Smoke Agent\",\"project_id\":\"compose-smoke\"}")" || {
  die "POST /admin/agents failed"; dump_logs; exit 1; }
AGENT_KEY="$(printf '%s' "$agent" | sed -nE 's/.*"api_key":"([^"]+)".*/\1/p')"
if [ -z "$AGENT_KEY" ]; then
  die "POST /admin/agents returned no api_key:"; printf '%s\n' "$agent" >&2; exit 1
fi
ok "agent registered, api_key issued (${AGENT_KEY:0:8}…)"

say "GET /boot/$AGENT_ID (X-Agent-Key) …"
boot="$(curl -sf --max-time 5 "$API_BASE/boot/$AGENT_ID" -H "X-Agent-Key: $AGENT_KEY")" || {
  die "GET /boot with the issued agent key failed"; dump_logs; exit 1; }
printf '%s' "$boot" | grep -q "\"id\":\"$AGENT_ID\"" || {
  die "boot payload does not identify the agent:"; printf '%s\n' "$boot" >&2; exit 1; }
printf '%s' "$boot" | grep -q '"role_contract"' || {
  die "boot payload missing role_contract:"; printf '%s\n' "$boot" >&2; exit 1; }
ok "boot payload OK (agent + role_contract present)"

# --- 5. the agent key must actually gate /boot: a wrong key is not 200. ---
wrong_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  "$API_BASE/boot/$AGENT_ID" -H "X-Agent-Key: dvk_deadbeef$(openssl rand -hex 16)")" || wrong_code=000
case "$wrong_code" in
  200) die "GET /boot accepted a WRONG agent key (HTTP 200) — agent auth is not gating"; exit 1 ;;
  000) die "GET /boot with a wrong key did not answer at all"; exit 1 ;;
  *)   ok "wrong agent key rejected (HTTP $wrong_code)" ;;
esac

echo ""
ok "COMPOSE SMOKE PASSED — cold start fails loud, recommended path boots healthy, project→agent→boot round trip 200s."

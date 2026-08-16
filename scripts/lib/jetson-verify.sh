#!/usr/bin/env bash
# Behavioural verification of a jetson01 deploy, run FROM THE MAC.
#
# "systemctl is-active" is not proof — it was the old standard, and it reported
# a perfectly healthy platform for two weeks while DEPLOYED_VERSION was stale.
# Each check below is a capability that has broken silently before.
#
# mdns is here because DISCOVER — the deploy-or-join handshake that makes this a
# platform agents find rather than a chat host — dies invisibly if the advertiser
# is lost, and /health stays green the whole time.
#
# Output: one `name=ok` / `name=FAIL` line per check. Exit non-zero if any failed.
# The deploy script parses these lines; keep the format stable.
#
# See docs/superpowers/specs/2026-08-16-jetson-mycelium-deploy-design.md
set -uo pipefail

SUBSTRATE="${SUBSTRATE_URL:-http://jetson01.local:3002}"
SMOKE="${SMOKE_SCRIPT:-$HOME/Projects/mycelium-agent/scripts/smoke_mycelium_agent.sh}"
MDNS_SERVICE="${MDNS_SERVICE:-_mycelium._tcp}"
rc=0

report() { # name  ok|FAIL
  echo "$1=$2"
  [ "$2" = "ok" ] || rc=1
}

# 1. health — the platform answers at all
if curl -sS --max-time 10 "$SUBSTRATE/health" 2>/dev/null | grep -q '"status"'; then
  report health ok
else
  report health FAIL
fi

# 2. mDNS advertiser — the capability that dies quietly.
#
# Match an actual "Add" RECORD, not merely the service name. dns-sd echoes what
# it is browsing for in its own header ("Browsing for _mycelium._tcp.local"), so
# a naive `grep "$MDNS_SERVICE"` matches its own query and can NEVER fail. That
# version was written first and caught by browsing a service nobody advertises;
# it still reported ok. A gate that greps its own input is not a gate.
if dns-sd -t 8 -B "$MDNS_SERVICE" local 2>/dev/null \
     | grep -qE "^[0-9:. ]+Add[[:space:]]+.*${MDNS_SERVICE}"; then
  report mdns ok
else
  report mdns FAIL
fi

# 3/4/7. contract smoke legs: substrate round-trip, coordination, discover
if [ -f "$SMOKE" ]; then
  for leg in 3 4 7; do
    if bash "$SMOKE" "$leg" 2>&1 | grep -q "^PASS"; then
      report "smoke-leg-$leg" ok
    else
      report "smoke-leg-$leg" FAIL
    fi
  done
else
  report smoke-script-present FAIL
fi

exit $rc

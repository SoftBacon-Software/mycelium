#!/usr/bin/env bash
# Wait for an mDNS advertiser, tolerating the post-restart settling window.
#
#   mdns-wait.sh <service-type>          e.g. mdns-wait.sh _mycelium._tcp
#
# Exit 0 the moment a browse attempt sees an actual Add record; exit 1 only
# after MDNS_DEADLINE_S has elapsed with no Add record on any attempt.
#
# Why this exists: on 2026-08-26 jetson-verify.sh browsed seconds after a
# restore's `systemctl start`. Avahi had not re-advertised yet, one fixed 8s
# window came up empty, and a restore that had SUCCEEDED (health ok, service
# active, git at the rollback point) was reported as "RESTORE FAILED —
# INTERVENE". Condition-based waiting with a bounded deadline distinguishes the
# two states a single window cannot: "still settling" (an Add record appears on
# a later attempt inside the deadline) vs "advertiser dead" (the deadline
# expires with no Add record ever). No fixed sleep: the first attempt starts
# immediately and a healthy advertiser passes as fast as it ever did.
#
# stdout stays SILENT: jetson-verify.sh owns the name=ok/name=FAIL contract that
# deploy-jetson.sh parses. Diagnostics go to stderr only.
#
# Knobs (env): MDNS_DEADLINE_S total budget (default 45 — worst case one browse
# window longer), MDNS_BROWSE_T per-attempt browse window (default 8),
# DNS_SD_BIN the browser binary (test seam).
set -u

SERVICE="${1:?usage: mdns-wait.sh <service-type>}"
DEADLINE_S="${MDNS_DEADLINE_S:-45}"
BROWSE_T="${MDNS_BROWSE_T:-8}"
DNS_SD_BIN="${DNS_SD_BIN:-dns-sd}"

start="$(date +%s)"
attempt=0
while :; do
  attempt=$((attempt + 1))
  # Capture, then grep — piping into `grep -q` would SIGPIPE the browser on an
  # early match, and the browser's own exit status proves nothing either way.
  out="$("$DNS_SD_BIN" -t "$BROWSE_T" -B "$SERVICE" local 2>/dev/null || true)"
  # Match an actual "Add" RECORD, never the header: dns-sd echoes the service
  # name in "Browsing for ..." on every run, so a bare grep for the name is a
  # gate that greps its own input and can never fail.
  if printf '%s\n' "$out" | grep -qE "^[0-9:. ]+Add[[:space:]]+.*${SERVICE}"; then
    elapsed=$(( $(date +%s) - start ))
    if [ "$attempt" -gt 1 ]; then
      echo "mdns-wait: $SERVICE advertised on attempt $attempt (${elapsed}s) — post-restart settling, not a failure" >&2
    fi
    exit 0
  fi
  elapsed=$(( $(date +%s) - start ))
  if [ "$elapsed" -ge "$DEADLINE_S" ]; then
    echo "mdns-wait: no Add record for $SERVICE in $attempt attempts over ${elapsed}s (deadline ${DEADLINE_S}s) — this is not settling, the advertiser is absent" >&2
    exit 1
  fi
done

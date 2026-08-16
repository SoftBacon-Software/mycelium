#!/usr/bin/env bash
# Deploy a tagged Mycelium release to jetson01.
#
#   scripts/deploy-jetson.sh <annotated-tag> [--dry-run]
#
# Replaces hand `cp -a` from whatever branch held the fix. Git on the box is the
# record of what is deployed; DEPLOYED_VERSION is a generated convenience.
#
# See docs/superpowers/specs/2026-08-16-jetson-mycelium-deploy-design.md
set -euo pipefail

TAG="${1:?usage: deploy-jetson.sh <annotated-tag> [--dry-run]}"
DRY="${2:-}"
BOX=jetson01.local
TREE=/home/grb/mycelium                       # NOT ~/Projects/mycelium (a decoy)
NODE_BIN=/home/grb/.nvm/versions/node/v25.9.0/bin  # nvm: nothing is on PATH over ssh
NPM="$NODE_BIN/npm"
HERE="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

say() { printf '\n=== %s ===\n' "$*"; }

# --- 1. guard the target -----------------------------------------------------
say "guard: $TAG"
OBJ_TYPE="$(git cat-file -t "$TAG" 2>/dev/null || echo none)"
if git merge-base --is-ancestor "$TAG" master 2>/dev/null; then ANC=true; else ANC=false; fi
node --input-type=module -e "
  import { assertDeployableTag } from '${HERE}/lib/deploy-guards.js'
  assertDeployableTag({ objectType: '${OBJ_TYPE}', isAncestorOfMaster: ${ANC}, name: '${TAG}' })
  console.log('guard ok: ${TAG}')
"

# --- 2. refuse a dirty box ---------------------------------------------------
# That drift is somebody's undeployed work. Overwriting it silently is how the
# 08-07 files got lost track of in the first place.
say "drift check"
# REFUSE if the probe cannot run. An earlier version swallowed the error with
# `|| true`, so a broken .git on the box produced an empty string, which parses
# as "clean" — the gate reported "tree clean" while being structurally unable to
# tell. Caught by a dry run on 2026-08-16, before it could license a deploy over
# unknown drift. "Could not determine" is not "passed".
if ! PORCELAIN="$(ssh "$BOX" "cd $TREE && git status --porcelain" 2>&1)"; then
  echo "REFUSING: cannot read git state in $TREE on $BOX:" >&2
  echo "$PORCELAIN" | sed 's/^/  /' >&2
  echo "Is it a real checkout yet? See the conversion task in" >&2
  echo "docs/superpowers/plans/2026-08-16-jetson-orderly-deploy.md" >&2
  exit 1
fi
# Passed through the ENVIRONMENT, never interpolated into the JS source: a
# filename containing a backtick or ${...} would otherwise be executed.
PORCELAIN="$PORCELAIN" node --input-type=module -e "
  import { parseDriftVerdict } from '${HERE}/lib/deploy-guards.js'
  const v = parseDriftVerdict(process.env.PORCELAIN || '')
  if (!v.clean) {
    console.error('REFUSING: the box has uncommitted drift:')
    for (const e of v.entries) console.error('  ' + e)
    console.error('Resolve it deliberately before deploying over it.')
    process.exit(1)
  }
  console.log('tree clean')
"

# --- 3. record the rollback point + back up ----------------------------------
say "backup"
if ! PREV="$(ssh "$BOX" "cd $TREE && git rev-parse HEAD" 2>&1)"; then
  echo "REFUSING: cannot determine the current commit on $BOX:" >&2
  echo "$PREV" | sed 's/^/  /' >&2
  echo "Without a rollback point there is no safe way forward." >&2
  exit 1
fi
echo "rollback point: $PREV"
# Ship the backup script rather than calling it inside $TREE: at the FIRST
# deploy the box is still at a commit that predates it, so an in-tree path would
# fail exactly when the backup matters most.
scp -q "$HERE/lib/jetson-db-backup.py" "$BOX:/tmp/jetson-db-backup.py"
ssh "$BOX" "mkdir -p /home/grb/backups && python3 /tmp/jetson-db-backup.py \
  $TREE/server/data/mycelium.db /home/grb/backups/mycelium-$STAMP.db"
# node_modules too: npm ci below rebuilds native modules (better-sqlite3 on
# arm64), and a rollback that restores code but not deps is not a rollback.
ssh "$BOX" "cd $TREE && tar czf /home/grb/backups/node_modules-$STAMP.tgz node_modules" || \
  echo "WARN: node_modules backup failed — rollback may need a manual npm ci"

if [ "$DRY" = "--dry-run" ]; then
  echo
  echo "DRY RUN: stopping before any change. Guards passed, backup taken."
  exit 0
fi

# --- 4. stop, ship, deps, start ----------------------------------------------
# Stop FIRST: Restart=always would otherwise relaunch into a half-updated tree.
#
# STOPPED guards the window in which the substrate is down. Anything that exits
# non-zero in here — set -e, a failed ssh, a Ctrl-C — must not leave the box
# dead. On 2026-08-16 it did exactly that: `git fetch --tags` returned non-zero
# over three stale tags it declined to clobber, set -e killed the script one
# line after the stop, and the platform stayed down until a human noticed.
# Being stranded down is a worse failure than any deploy this script can ship.
say "deploy"
SUDO="$(security find-generic-password -s velum-sudo-jetson01 -w)"
STOPPED=0

restore_on_abort() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$STOPPED" -eq 1 ]; then
    echo
    echo "!!! DEPLOY ABORTED (exit $rc) WITH THE SERVICE STOPPED — restoring $PREV"
    ssh "$BOX" "cd $TREE && git checkout -f '$PREV'" || true
    ssh "$BOX" "cd $TREE && tar xzf /home/grb/backups/node_modules-$STAMP.tgz" 2>/dev/null || true
    ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl reset-failed mycelium.service" || true
    ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl start mycelium.service" || true
    sleep 10
    if bash "$HERE/lib/jetson-verify.sh"; then
      echo "restored: the box is back on $PREV and verifying green"
    else
      echo "RESTORE FAILED — INTERVENE. DB backup: /home/grb/backups/mycelium-$STAMP.db"
    fi
  fi
}
trap restore_on_abort EXIT

ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl stop mycelium.service"
STOPPED=1
# Fetch ONLY the tag being deployed, forced. `git fetch --tags` fails wholesale
# if any unrelated tag would be clobbered, which has nothing to do with this
# deploy and must not abort it.
ssh "$BOX" "cd $TREE && git fetch -q origin '+refs/tags/${TAG}:refs/tags/${TAG}' && git checkout -f '$TAG'"
if ! ssh "$BOX" "cd $TREE && git diff --quiet '$PREV' HEAD -- package-lock.json"; then
  echo "lockfile changed — npm ci"
  ssh "$BOX" "cd $TREE && PATH=$NODE_BIN:\$PATH $NPM ci --omit=dev"
else
  echo "lockfile unchanged — skipping npm ci"
fi
ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl start mycelium.service"
STOPPED=0   # service is up again; the abort-restore no longer applies
sleep 10

# --- 5. verify behaviour; roll back on any red -------------------------------
say "verify"
VERIFY_OUT="$(bash "$HERE/lib/jetson-verify.sh" || true)"
echo "$VERIFY_OUT"
JSON="$(echo "$VERIFY_OUT" | awk -F= '
  BEGIN { printf "[" }
  NF == 2 { printf "%s{\"name\":\"%s\",\"ok\":%s}", (n++ ? "," : ""), $1, ($2 == "ok" ? "true" : "false") }
  END { printf "]" }')"
if ! VERIFY_JSON="$JSON" node --input-type=module -e "
  import { decideRollback } from '${HERE}/lib/deploy-guards.js'
  const d = decideRollback(JSON.parse(process.env.VERIFY_JSON || '[]'))
  if (d.rollback) { console.error('VERIFICATION RED: ' + d.failed.join(', ')); process.exit(1) }
  console.log('all checks green')
"; then
  say "ROLLING BACK to $PREV"
  ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl stop mycelium.service"
  STOPPED=1   # down again — a failure DURING rollback must still restore
  ssh "$BOX" "cd $TREE && git checkout -f '$PREV'"
  ssh "$BOX" "cd $TREE && tar xzf /home/grb/backups/node_modules-$STAMP.tgz" || \
    ssh "$BOX" "cd $TREE && PATH=$NODE_BIN:\$PATH $NPM ci --omit=dev" || true
  ssh "$BOX" "echo '$SUDO' | sudo -S -p '' systemctl start mycelium.service"
  STOPPED=0   # rollback restarted it; do not let the trap restore twice
  sleep 10
  if bash "$HERE/lib/jetson-verify.sh"; then
    echo "rollback verified green — the box is back where it was"
  else
    echo "ROLLBACK ALSO RED — INTERVENE. DB backup: /home/grb/backups/mycelium-$STAMP.db"
  fi
  exit 1
fi

# --- 6. stamp from git -------------------------------------------------------
say "stamp"
COMMIT="$(git rev-parse --short "$TAG^{commit}")"
SUBJECT="$(git log -1 --format=%s "$TAG^{commit}")"
DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
FROM="$(hostname -s)"
TAG="$TAG" COMMIT="$COMMIT" SUBJECT="$SUBJECT" DEPLOYED_AT="$DEPLOYED_AT" FROM="$FROM" \
node --input-type=module -e "
  import { renderDeployedVersion } from '${HERE}/lib/deploy-guards.js'
  process.stdout.write(renderDeployedVersion({
    tag: process.env.TAG, commit: process.env.COMMIT, subject: process.env.SUBJECT,
    deployedAt: process.env.DEPLOYED_AT, from: process.env.FROM,
  }))
" | ssh "$BOX" "cat > $TREE/DEPLOYED_VERSION"

say "deployed $TAG ($COMMIT)"

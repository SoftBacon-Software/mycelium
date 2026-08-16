# Deploying Mycelium to jetson01

The substrate host runs `mycelium.service` (systemd, `User=grb`,
`Restart=always`). Deploys are a **git checkout of an annotated tag**, driven
from the Mac. Git on the box is the record of what is deployed; the
`DEPLOYED_VERSION` file is a generated convenience.

```bash
cd ~/Projects/mycelium
bash scripts/deploy-jetson.sh <annotated-tag>            # add --dry-run first
```

## Two facts that used to be wrong everywhere

1. **The deploy tree is `/home/grb/mycelium`.**
   `~/Projects/mycelium` also exists on the Jetson and is a **stale decoy**. It
   cost three wrong conclusions on 2026-08-16 ("the mDNS advertiser is absent
   from the box" — it was present, in the real tree). Ground truth is the unit:

   ```bash
   systemctl show mycelium.service -p WorkingDirectory -p ExecStart
   ls -l /proc/$(systemctl show mycelium.service -p MainPID --value)/cwd
   ```

2. **Git works on the box.** It always did — `git` 2.34.1 was installed, but
   `.git` was a *file* reading `gitdir:` a Mac-only worktree path, so every
   command failed. Converted to a real repository 2026-08-16. Any runbook
   telling you to "verify by content hash because you cannot diff by revision"
   is superseded: `git status` answers it.

## What the deploy does, in order

1. **Guards the target** — annotated tag, reachable from `master`. A lightweight
   tag is refused (it has no tagger, date or message, so it cannot record who
   shipped what); a side-branch target is refused (that is how the box ended up
   on `security-backport-20260802` while master moved on without it).
2. **Refuses a dirty box.** That drift is somebody's undeployed work. If the
   probe cannot *read* git state it refuses too — "could not determine" is not
   "passed".
3. **Backs up** the database (through `sqlite3.Connection.backup()`, then
   OPENS the copy and `integrity_check`s it) and `node_modules`, and records the
   current commit as the rollback point.
4. **Stops the service, checks out, `npm ci` if the lockfile moved, starts.**
   Stop first: `Restart=always` would otherwise relaunch into a half-updated
   tree.
5. **Verifies behaviour** — `/health`, the mDNS advertiser, and contract smoke
   legs 3/4/7. "Service is active" is not proof: on 2026-08-16 a deploy reported
   `health=ok` while the advertiser was dead.
6. **Auto-rolls-back** on any red, then re-verifies.
7. **Regenerates `DEPLOYED_VERSION`** from git. Never hand-edit it. If it and
   git disagree, git wins.

An **EXIT trap** covers the window in which the service is stopped: any non-zero
exit there restores the previous commit, reinstalls the backed-up
`node_modules`, restarts and verifies. Being stranded down is worse than any
deploy this script can ship — it happened once, when `git fetch --tags` returned
non-zero over unrelated stale tags and `set -e` killed the script one line after
the stop.

## Rolling back by hand

```bash
ssh jetson01.local 'cd /home/grb/mycelium && git checkout -f <previous-tag-or-sha>'
ssh jetson01.local 'sudo systemctl restart mycelium.service'
cd ~/Projects/mycelium && bash scripts/lib/jetson-verify.sh
```

The **as-found state before the first orderly deploy** is preserved as a real
commit, not a tarball: branch `jetson-as-found-2026-08-16`, commit `20e7f1d`.
Backups live in `/home/grb/backups/` (DB, tree tarball, `node_modules`).

## Database safety

Migrations run at boot from `server/db/core.js`. Most are additive
`ALTER TABLE ADD COLUMN`, which old code ignores — so they do not block a
rollback. Three are **not** additive: a `DROP COLUMN` on `messages`, a
`RENAME COLUMN` set (`game` → `project_id`), and `games` → `projects`.

Verified 2026-08-16 against the live DB: **all three are no-ops** — the dead
columns are already gone, the renames already done, and there is no `games`
table. Re-check before any deploy that crosses a schema change:

```bash
scp scripts/lib/jetson-db-backup.py jetson01.local:/tmp/
ssh jetson01.local 'python3 /tmp/jetson-db-backup.py --verify-only \
  /home/grb/mycelium/server/data/mycelium.db'
```

⚠️ The real database is `server/data/mycelium.db` (~150 MB, 77 tables). The
repo-root `mycelium.db` is a **0-byte decoy**, and there is no `sqlite3` CLI on
the box.

## Environment traps

- **sudo password** comes from the Mac keychain:
  `security find-generic-password -s velum-sudo-jetson01 -w` piped to
  `sudo -S -p ""`. Only `systemctl` needs it — copy files as `grb` so nothing
  lands root-owned.
- **nvm puts NOTHING on PATH over ssh.** Node is
  `/home/grb/.nvm/versions/node/v25.9.0/bin/node`. An absolute *npm* path is not
  enough — npm is itself a node script (`#!/usr/bin/env node`), so `node` must be
  **on PATH** or `npm ci` dies with `env: 'node': No such file or directory`.
  `start-platform.sh` gets away with an absolute path because it execs node
  directly and never re-enters a shebang.
- **`start-platform.sh` is tracked here now.** Until 2026-08-16 the script named
  by `ExecStart` existed in no repository at all.
- macOS `tar`: `export COPYFILE_DISABLE=1` (AppleDouble `._` files otherwise ride
  along and break `*.js` globs). zsh does not word-split unquoted `$(...)` — use
  `tar -T <filelist>`.

## Monitoring

`jarvis/squad/lab_check.py` runs `jetson_deploy_drift` hourly: it FAILs if the
tree is dirty or the box is not at the expected tag, and SKIPs if the host is
unreachable (a LAN outage is not drift). Override the expectation with
`JETSON_EXPECTED_TAG` after an intentional deploy.

Design and plan: `docs/superpowers/specs/2026-08-16-jetson-mycelium-deploy-design.md`,
`docs/superpowers/plans/2026-08-16-jetson-orderly-deploy.md`.

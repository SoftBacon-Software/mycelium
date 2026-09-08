# Deploying Mycelium to the substrate host

The substrate host runs `mycelium.service` (systemd, `User=<user>`,
`Restart=always`). Deploys are a **git checkout of an annotated tag**, driven
from the operator's workstation. Git on the box is the record of what is
deployed; the `DEPLOYED_VERSION` file is a generated convenience.

This runbook is deliberately value-free. The host name, login user, tree paths,
node install, and the sudo-secret mechanism are per-deployment and live in
`docs/runbooks/jetson-deploy.LOCAL.md` (gitignored — see the keys it holds at
the bottom of this file). Read `<...>` as "fill in from the LOCAL file".

```bash
cd <your checkout of this repo>
bash scripts/deploy-jetson.sh <annotated-tag>          # add --dry-run first
```

## Two facts that used to be wrong everywhere

1. **The deploy tree is `<deploy-tree>`.**
   `~/Projects/mycelium` also exists on the box and is a **stale decoy**. It
   cost three wrong conclusions on 2026-08-16 ("the mDNS advertiser is absent
   from the box" — it was present, in the real tree). Ground truth is the unit:

   ```bash
   systemctl show mycelium.service -p WorkingDirectory -p ExecStart
   ls -l /proc/$(systemctl show mycelium.service -p MainPID --value)/cwd
   ```

   Trust the running unit over any path someone (including a runbook) asserts.

2. **Git works on the box.** It always did — a current `git` was installed, but
   `.git` was a *file* reading `gitdir:` a workstation-only worktree path, so
   every command failed. Converted to a real repository 2026-08-16. Any runbook
   telling you to "verify by content hash because you cannot diff by revision"
   is superseded: `git status` answers it.

## What the deploy does, in order

1. **Guards the target** — annotated tag, reachable from `master`. A lightweight
   tag is refused (it has no tagger, date or message, so it cannot record who
   shipped what); a side-branch target is refused (that is how the box ended up
   on a stale security-backport branch while master moved on without it).
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
ssh <user>@<host> 'cd <deploy-tree> && git checkout -f <previous-tag-or-sha>'
ssh <user>@<host> 'sudo systemctl restart mycelium.service'
cd <your checkout of this repo> && bash scripts/lib/jetson-verify.sh
```

The **as-found state before the first orderly deploy** was preserved as a real
commit, not a tarball, on a dedicated as-found branch (branch and commit: LOCAL
file). Backups live in `<backup-dir>/` (DB, tree tarball, `node_modules`).

## Database safety

Migrations run at boot from `server/db/core.js`. Most are additive
`ALTER TABLE ADD COLUMN`, which old code ignores — so they do not block a
rollback. Three are **not** additive: a `DROP COLUMN` on `messages`, a
`RENAME COLUMN` set (`game` → `project_id`), and `games` → `projects`.

Verified 2026-08-16 against the live DB: **all three are no-ops** — the dead
columns are already gone, the renames already done, and there is no `games`
table. Re-check before any deploy that crosses a schema change:

```bash
scp scripts/lib/jetson-db-backup.py <host>:/tmp/
ssh <user>@<host> 'python3 /tmp/jetson-db-backup.py --verify-only \
  <deploy-tree>/server/data/mycelium.db'
```

⚠️ The real database is `server/data/mycelium.db` **under the deploy tree** —
its size and table count are in the LOCAL file, and they are worth knowing
before you backup/verify one. The repo-root `mycelium.db` is a **0-byte decoy**,
and there is no `sqlite3` CLI on the box.

## Environment traps

- **sudo password** comes from the operator workstation's keychain, fetched by
  the deploy script; only `systemctl` needs it — copy files as `<user>` so
  nothing lands root-owned. The keychain item name and the exact retrieval line
  are ops-local (LOCAL file): a public page naming both is a map for any reader.
- **nvm puts NOTHING on PATH over ssh.** Node is at an absolute path under the
  login user's nvm directory (`<node-bin>`). An absolute *npm* path is not
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

The lab's own health checker (a private tree, not this repo) runs a
`deploy-drift` probe hourly: it FAILs if the tree is dirty or the box is not at
the expected tag, and SKIPs if the host is unreachable (a LAN outage is not
drift). Override the expectation after an intentional deploy — the variable name
and the checker's location are in the LOCAL file.

## This deployment's concrete values

`docs/runbooks/jetson-deploy.LOCAL.md` (gitignored, never committed) holds the
map this runbook abstracts away. Its keys:

- host name and login user
- deploy tree and backup directory (absolute paths on the box)
- the keychain item for the sudo secret, and the exact retrieval line
- absolute `node`/`npm` paths (nvm layout)
- the as-found branch and commit preserved before the first orderly deploy
- the expected-tag override variable, and where the drift probe lives
- the live database's path, size and table count

Recreate it on any checkout that will drive a deploy. The tracked runbook above
is the method and stays value-free on purpose.

Design and plan history (redacted to the same standard):
`docs/superpowers/specs/2026-08-16-jetson-mycelium-deploy-design.md`,
`docs/superpowers/plans/2026-08-16-jetson-orderly-deploy.md`.

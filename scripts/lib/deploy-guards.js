// Decision rules for deploying Mycelium to jetson01.
//
// Kept pure and separate from scripts/deploy-jetson.sh so each rule is testable
// without a Jetson. Every rule here is a past failure turned into a refusal:
// deploys came from whatever branch held the fix, and DEPLOYED_VERSION was a
// hand-written file that went stale without anyone noticing (stamped 08-03 while
// files dated 08-07 sat on the box).
//
// See docs/superpowers/specs/2026-08-16-jetson-mycelium-deploy-design.md

/**
 * Refuse anything that is not an annotated tag reachable from master.
 *
 * @param {{objectType: string, isAncestorOfMaster: boolean, name: string}} target
 * @throws {Error} when the target is not deployable
 */
export function assertDeployableTag({ objectType, isAncestorOfMaster, name }) {
  if (!name) {
    throw new Error('deploy target: name is required')
  }
  if (objectType !== 'tag') {
    throw new Error(
      `deploy target ${name}: must be an ANNOTATED tag (git cat-file -t said ` +
      `"${objectType}"). A lightweight tag carries no tagger, date or message, ` +
      'so it cannot record who shipped what.'
    )
  }
  if (!isAncestorOfMaster) {
    throw new Error(
      `deploy target ${name}: not reachable from master. Deploying from a side ` +
      'branch is how the box ended up on security-backport-20260802 while master ' +
      'moved on without it.'
    )
  }
}

/**
 * Refuse a tag the BOX cannot resolve — before anything is touched.
 *
 * The local guard above cannot speak for the remote checkout: on 2026-08-26 an
 * annotated tag that existed only on the Mac passed every local check, backups
 * ran, the service was STOPPED, and only then did the box's fetch die with
 * "couldn't find remote ref". The abort trap restored, but the substrate was
 * down for a fault that was knowable before any mutation.
 *
 * `lsRemote` must be the output of
 *   ssh box "cd tree && git ls-remote origin refs/tags/T 'refs/tags/T^{}'"
 * asked ON the box against ITS origin — the exact remote the later fetch will
 * contact. Three facts about that output (pinned in a scratch repo and against
 * jetson01 itself):
 *   - a missing ref is EMPTY stdout with EXIT 0, so only this parse can refuse
 *     an unpushed tag; the exit code is not a guard
 *   - an annotated tag is two lines: "<tagsha>\trefs/tags/T" + "<commitsha>\trefs/tags/T^{}"
 *   - a lightweight tag has no ^{} line (its ref sha IS the commit)
 *
 * The peeled commit must equal the LOCAL tag's commit: the fetch is forced
 * (+refs/tags/...), so on a name collision the box would silently deploy
 * whatever the remote holds, not what the local guards just validated.
 *
 * Like the porcelain input, `lsRemote` is untrusted DATA passed through the
 * environment; nothing here evaluates it.
 *
 * @param {{name: string, localCommit: string, lsRemote: string|null|undefined}} target
 * @throws {Error} when the box could not deploy this tag
 */
export function assertBoxResolvesTag({ name, localCommit, lsRemote }) {
  if (!name) {
    throw new Error('remote tag guard: name is required')
  }
  if (!localCommit) {
    throw new Error(`remote tag guard ${name}: localCommit is required`)
  }
  const rows = (lsRemote || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.split(/\s+/))
    .filter((cols) => cols.length === 2)
  const exact = rows.find(([, ref]) => ref === `refs/tags/${name}`)
  const peeled = rows.find(([, ref]) => ref === `refs/tags/${name}^{}`)
  if (!exact) {
    const extra = (lsRemote || '').trim()
    throw new Error(
      `deploy target ${name}: the box cannot resolve refs/tags/${name} from its ` +
      'origin (ls-remote returned no matching ref' +
      (extra ? `; it said: ${extra}` : '') + '). ' +
      `An unpushed tag passes every local guard and then kills the deploy AFTER ` +
      `the service is stopped — push it first: git push origin ${name}`
    )
  }
  if (!peeled) {
    throw new Error(
      `deploy target ${name}: the remote tag is LIGHTWEIGHT (no ^{} peel line). ` +
      'The box fetches the REMOTE object, so the annotated-tag rule must hold ' +
      `there too. Push the annotated tag: git push -f origin ${name}`
    )
  }
  if (peeled[0] !== localCommit) {
    throw new Error(
      `deploy target ${name}: the remote tag peels to ${peeled[0]} but the local ` +
      `tag peels to ${localCommit}. The forced fetch would make the box deploy ` +
      'the REMOTE version — not what these guards just validated. Reconcile the ' +
      'tags deliberately before deploying.'
    )
  }
}

/**
 * Turn `git status --porcelain` output into a drift verdict.
 *
 * Input is untrusted DATA — filenames may contain backticks or ${...}. It is
 * passed to this function through the environment, never interpolated into
 * source, and nothing here evaluates it.
 *
 * @param {string|null|undefined} porcelainOutput
 * @returns {{clean: boolean, entries: string[]}}
 */
export function parseDriftVerdict(porcelainOutput) {
  const entries = (porcelainOutput || '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
  return { clean: entries.length === 0, entries }
}

/**
 * Decide whether a deploy must be rolled back, given verification results.
 *
 * @param {Array<{name: string, ok: boolean}>} verifications
 * @returns {{rollback: boolean, failed: string[]}}
 */
export function decideRollback(verifications) {
  // An empty or malformed list means nothing was actually checked. Verifying
  // nothing is not passing — "systemctl is-active" was the old standard and it
  // hid a stale deploy for two weeks.
  if (!Array.isArray(verifications) || verifications.length === 0) {
    return { rollback: true, failed: ['no-verifications-ran'] }
  }
  const failed = verifications.filter((v) => !v || !v.ok).map((v) => (v && v.name) || 'unnamed')
  return { rollback: failed.length > 0, failed }
}

/**
 * Render DEPLOYED_VERSION from git facts. Never hand-written.
 *
 * @param {{tag: string, commit: string, subject: string, deployedAt: string, from: string}} facts
 * @returns {string}
 */
export function renderDeployedVersion({ tag, commit, subject, deployedAt, from }) {
  return [
    `tag:      ${tag}`,
    `commit:   ${commit}`,
    `subject:  ${subject}`,
    `deployed: ${deployedAt}`,
    `from:     ${from}`,
    '',
    '# generated from git by scripts/deploy-jetson.sh — do not hand-edit.',
    '# git is the truth; this file is a convenience. If they disagree, git wins.',
    '',
  ].join('\n')
}

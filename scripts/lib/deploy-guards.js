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

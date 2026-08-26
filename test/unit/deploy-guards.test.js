import { describe, test, expect } from 'vitest'
import {
  assertDeployableTag,
  assertBoxResolvesTag,
  parseDriftVerdict,
  renderDeployedVersion,
  decideRollback,
} from '../../scripts/lib/deploy-guards.js'

// These guards exist because jetson01 was deployed by hand from whatever branch
// held the fix, and DEPLOYED_VERSION went stale without anyone noticing (stamped
// 08-03 while files dated 08-07 sat on the box). Each rule below is one way that
// happened, turned into a refusal.

describe('assertDeployableTag', () => {
  test('accepts an annotated tag reachable from master', () => {
    expect(() => assertDeployableTag({
      objectType: 'tag', isAncestorOfMaster: true, name: 'deploy-2026-08-16',
    })).not.toThrow()
  })

  test('rejects a lightweight tag (a commit object, no provenance)', () => {
    expect(() => assertDeployableTag({
      objectType: 'commit', isAncestorOfMaster: true, name: 'quickfix',
    })).toThrow(/annotated/i)
  })

  test('rejects a tag not reachable from master — the branch-deploy habit', () => {
    expect(() => assertDeployableTag({
      objectType: 'tag', isAncestorOfMaster: false, name: 'security-backport-20260802',
    })).toThrow(/master/)
  })

  test('rejects an empty target', () => {
    expect(() => assertDeployableTag({
      objectType: 'tag', isAncestorOfMaster: true, name: '',
    })).toThrow(/name/)
  })
})

describe('parseDriftVerdict', () => {
  test('empty porcelain output is clean', () => {
    expect(parseDriftVerdict('')).toEqual({ clean: true, entries: [] })
  })

  test('whitespace-only output is clean', () => {
    expect(parseDriftVerdict('\n  \n')).toEqual({ clean: true, entries: [] })
  })

  test('an untracked file is drift — this is the 08-07 case', () => {
    const v = parseDriftVerdict('?? server/lib/mdns-advertise.js\n')
    expect(v.clean).toBe(false)
    expect(v.entries).toEqual(['?? server/lib/mdns-advertise.js'])
  })

  test('modified and untracked entries are all reported', () => {
    const v = parseDriftVerdict(' M server/index.js\n?? server/lib/x.js\n')
    expect(v.clean).toBe(false)
    expect(v.entries).toHaveLength(2)
  })

  test('a filename with shell metacharacters is data, not code', () => {
    // The porcelain output is passed through the environment precisely so a
    // filename like this cannot be executed. Parsing it must not choke either.
    const v = parseDriftVerdict('?? server/`whoami`.js\n?? server/${HOME}.js\n')
    expect(v.clean).toBe(false)
    expect(v.entries).toHaveLength(2)
  })

  test('null/undefined input is treated as clean, not a crash', () => {
    expect(parseDriftVerdict(null)).toEqual({ clean: true, entries: [] })
    expect(parseDriftVerdict(undefined)).toEqual({ clean: true, entries: [] })
  })
})

describe('decideRollback', () => {
  test('all green does not roll back', () => {
    expect(decideRollback([{ name: 'health', ok: true }, { name: 'mdns', ok: true }]))
      .toEqual({ rollback: false, failed: [] })
  })

  test('any red rolls back and names what failed', () => {
    const d = decideRollback([
      { name: 'health', ok: true },
      { name: 'mdns', ok: false },
      { name: 'smoke-leg-7', ok: false },
    ])
    expect(d.rollback).toBe(true)
    expect(d.failed).toEqual(['mdns', 'smoke-leg-7'])
  })

  test('an empty verification list rolls back — verifying nothing is not passing', () => {
    expect(decideRollback([]).rollback).toBe(true)
  })

  test('a non-array rolls back rather than passing by accident', () => {
    expect(decideRollback(undefined).rollback).toBe(true)
    expect(decideRollback(null).rollback).toBe(true)
  })
})

describe('renderDeployedVersion', () => {
  test('renders every provenance field from git facts', () => {
    const out = renderDeployedVersion({
      tag: 'deploy-2026-08-16',
      commit: 'abc1234',
      subject: 'First orderly deployable',
      deployedAt: '2026-08-16T20:00:00Z',
      from: 'Gilberts-MacBook-Pro',
    })
    expect(out).toMatch(/tag:\s+deploy-2026-08-16/)
    expect(out).toMatch(/commit:\s+abc1234/)
    expect(out).toMatch(/deployed:\s+2026-08-16T20:00:00Z/)
    expect(out).toMatch(/generated from git/)
  })

  test('says git wins, so the file is never mistaken for the source of truth', () => {
    const out = renderDeployedVersion({
      tag: 't', commit: 'c', subject: 's', deployedAt: 'd', from: 'f',
    })
    expect(out).toMatch(/git is the truth/)
    expect(out).toMatch(/do not hand-edit/)
  })
})

describe('assertBoxResolvesTag', () => {
  // 2026-08-26: an annotated tag existed only on the Mac. Every local guard
  // passed, backups ran, the service was STOPPED — and only then did the box
  // fail with "couldn't find remote ref". The lsRemote input here must be the
  // output of `ssh box "cd tree && git ls-remote origin refs/tags/T refs/tags/T^{}"`
  // — asked ON the box, against ITS origin — because only the box's view of the
  // tag decides whether the later fetch can succeed.
  const NAME = 'deploy-2026-08-26'
  const COMMIT = '882bd19d8cf9c5dcab03df68afac5ed64c17023c'
  const TAGOBJ = 'f5be5069e216278fd0458bec64fbb369c7dcf664'
  const annotated =
    `${TAGOBJ}\trefs/tags/${NAME}\n` +
    `${COMMIT}\trefs/tags/${NAME}^{}\n`

  test("empty output is THE 2026-08-26 failure — an unpushed tag must be refused before any mutation", () => {
    // git ls-remote exits 0 with empty stdout when the ref does not exist, so
    // only the parse can refuse this. The exit code is not a guard.
    expect(() => assertBoxResolvesTag({ name: NAME, localCommit: COMMIT, lsRemote: '' }))
      .toThrow(/push/i)
  })

  test('whitespace-only output is refused the same way', () => {
    expect(() => assertBoxResolvesTag({ name: NAME, localCommit: COMMIT, lsRemote: '\n  \n' }))
      .toThrow(/push/i)
  })

  test('accepts an annotated tag whose peeled commit matches the local tag', () => {
    expect(() => assertBoxResolvesTag({ name: NAME, localCommit: COMMIT, lsRemote: annotated }))
      .not.toThrow()
  })

  test('refuses when the remote tag peels to a DIFFERENT commit, naming both shas', () => {
    // The fetch is forced (+refs/tags/...), so the box would silently deploy
    // whatever the remote holds — not what the local guards just validated.
    const drifted =
      `${TAGOBJ}\trefs/tags/${NAME}\n` +
      `aaaa000000000000000000000000000000000000\trefs/tags/${NAME}^{}\n`
    let err
    try { assertBoxResolvesTag({ name: NAME, localCommit: COMMIT, lsRemote: drifted }) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.message).toContain(COMMIT)
    expect(err.message).toContain('aaaa000000000000000000000000000000000000')
  })

  test('refuses a lightweight remote tag even at the right commit', () => {
    // No ^{} line means the remote object IS the commit — a lightweight tag.
    // The annotated-tag rule holds for what the box will actually fetch.
    const lightweight = `${COMMIT}\trefs/tags/${NAME}\n`
    expect(() => assertBoxResolvesTag({ name: NAME, localCommit: COMMIT, lsRemote: lightweight }))
      .toThrow(/annotated/i)
  })

  test('error text from a failed remote query is refused, not parsed as success', () => {
    expect(() => assertBoxResolvesTag({
      name: NAME, localCommit: COMMIT,
      lsRemote: 'fatal: unable to access https://github.com/...: Could not resolve host\n',
    })).toThrow(/cannot resolve/i)
  })

  test('only the EXACT ref counts — a near-miss tag name does not resolve this one', () => {
    const nearMiss =
      `${TAGOBJ}\trefs/tags/${NAME}-rc\n` +
      `${COMMIT}\trefs/tags/${NAME}-rc^{}\n`
    expect(() => assertBoxResolvesTag({ name: NAME, localCommit: COMMIT, lsRemote: nearMiss }))
      .toThrow(/push/i)
  })

  test('output with shell metacharacters is data, not code', () => {
    // Like the porcelain input, lsRemote arrives through the environment and
    // nothing may evaluate it.
    expect(() => assertBoxResolvesTag({
      name: NAME, localCommit: COMMIT,
      lsRemote: '`whoami`\trefs/tags/${HOME}\n',
    })).toThrow(/push/i)
  })

  test('a missing name or local commit is refused outright', () => {
    expect(() => assertBoxResolvesTag({ name: '', localCommit: COMMIT, lsRemote: annotated }))
      .toThrow(/name/)
    expect(() => assertBoxResolvesTag({ name: NAME, localCommit: '', lsRemote: annotated }))
      .toThrow(/commit/i)
  })
})

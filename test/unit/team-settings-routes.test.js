// Behavior gate for the team-settings HTTP contract (brief 140).
//
// WHY THIS EXISTS: brief 138 (teams.js) explicitly deferred team_settings.js
// — "team_settings.js and orgs.js are SEPARATE modules with their own
// surfaces — OUT of scope; note them as follow-up candidates." This is that
// follow-up. Survey #15 (2026-08-26, on master 2d4b9a3) found
// team_settings.js among the seven mounted route modules invisible from
// every public surface: 5 mounted routes (GET /team-settings,
// GET /team-settings/:section, PUT /team-settings/:section/:key,
// DELETE /team-settings/:section/:key, POST /team-settings/sync), zero test
// files, zero README/docs mentions, zero mycelium_* MCP tools.
//
// WHAT STEP 0 DERIVED (from module source, then verified live):
//   - ALL FIVE routes are checkAdmin. The brief's draft row said "agent key
//     -> 403 on every route"; re-derived from source, a BARE agent key gets
//     401 instead: checkAdmin (mycelium.js) never reads X-Agent-Key, and with
//     neither X-Admin-Key nor an Authorization header it takes its
//     "Authentication required" 401 branch. The 403 "Invalid admin key" branch
//     only fires when an admin key was PRESENTED and is wrong. Both are pinned.
//   - The section/key shape: team_settings (schema.sql) rows are
//     (section, key, value TEXT, updated_at, updated_by), UNIQUE(section, key).
//     Values are stored as STRINGS (objects JSON.stringify'd) and parsed back
//     with JSON.parse on read (string fallback if unparseable). So the PUT
//     response echoes the RAW row (setting.value is the string), while the
//     GETs return parsed values.
//   - PUT accepts exactly five sections (route literal): coding_standards,
//     deploy_workflow, brand, guardrails, team_rules. Unknown -> 400.
//   - THE HEADLINE: the settings are not just a KV store — every upsert AND
//     every delete calls syncTeamSettingsToProfile() (server/db/teams.js),
//     which WRITES the node_profiles row id 'customer-agent' (created on
//     first sync; NOT seeded by boot — seedPlatformProfiles only seeds
//     default-agent/default-drone/default-admin). POST /team-settings/sync
//     re-runs the same write on demand. There is NO HTTP surface for
//     node_profiles, so the sync-effect assertions below read the row via
//     the db module — the only reader that exists.
//   - Sync mapping (all verified live): guardrails.{tool_whitelist,
//     repo_list, md_checkpoints, md_blocklist} map to the like-named profile
//     columns; coding_standards builds rules.coding_standards (severity high)
//     AND appends its languages into md_checkpoints; deploy_workflow builds
//     rules.deploy_workflow; team_rules builds rules.team_rules (severity
//     medium); guardrails.custom_rules entries become rules[cr.key]. `brand`
//     is an ACCEPTED section that sync IGNORES.
//
// Harness mirrors test/unit/spend-routes-behavior.test.js: real router via
// supertest, fresh temp DATA_DIR + ADMIN_KEY set BEFORE the dynamic import.
// Tests within this file run in order and SHARE one DB; the sync describes
// are sequenced first and document their state transitions inline.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import request from 'supertest'

// --- source-pinned contract values (read, not re-typed) ---
const ROUTE_SRC = readFileSync(
  fileURLToPath(new URL('../../server/routes/team_settings.js', import.meta.url)),
  'utf8'
)
const DB_TEAMS_SRC = readFileSync(
  fileURLToPath(new URL('../../server/db/teams.js', import.meta.url)),
  'utf8'
)
// The five-section whitelist literal (team_settings.js, PUT handler):
const SECTIONS_MATCH = ROUTE_SRC.match(/var validSections = \[([^\]]*)\]/)
const VALID_SECTIONS = SECTIONS_MATCH
  ? SECTIONS_MATCH[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))
  : []
// The profile the sync writes (server/db/teams.js, syncTeamSettingsToProfile):
const PROFILE_ID_MATCH = DB_TEAMS_SRC.match(/var profileId = '([^']+)'/)
const SYNC_PROFILE_ID = PROFILE_ID_MATCH ? PROFILE_ID_MATCH[1] : null

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const KEYA = 'dvk_' + 'a'.repeat(48) // a real, non-admin agent key
const AGENTA = 'ts-agentA'
const ACTING_AS = 'lane-140'

const ADMIN = { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': ACTING_AS }
const SECTION_PATH = '/api/mycelium/team-settings'

let tmpDataDir
let app
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-team-settings-behavior-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  const crypto = await import('node:crypto')
  db.createAgent(AGENTA, 'TS Agent A', 'ts-proj',
    crypto.createHash('sha256').update(KEYA).digest('hex'), '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const putSetting = (section, key, value) =>
  request(app).put(`${SECTION_PATH}/${section}/${key}`).set(ADMIN).send({ value })
const profile = () => db.getNodeProfile(SYNC_PROFILE_ID)

// ===========================================================================
// SYNC — the side effect one admin POST (or any upsert/delete) triggers.
// These run FIRST: the file's DB is pristine here, which the creation pins
// rely on. State transitions are documented per test.
// ===========================================================================
describe('SYNC PIN — the settings store writes the customer-agent node profile', () => {
  test('boot does NOT seed the sync target (it is born from a settings write)', () => {
    expect(SYNC_PROFILE_ID).toBe('customer-agent')
    expect(profile()).toBeNull()
  })

  test('POST /team-settings/sync on EMPTY settings still creates the profile', async () => {
    const res = await request(app).post(`${SECTION_PATH}/sync`).set(ADMIN)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, message: 'Profile sync complete' })

    const p = profile()
    expect(p).toBeTruthy()
    expect(p.node_type).toBe('agent')
    expect(p.layer).toBe('customer')
    expect(p.rules).toEqual({}) // nothing to map -> empty rules
  })

  test('every UPSERT already syncs: the full mapping lands without ever calling POST /sync', async () => {
    // Ten settings across the five accepted sections. No POST /sync in here —
    // the profile must update as a side effect of the PUTs alone.
    await putSetting('guardrails', 'tool_whitelist', ['mcp_a', 'mcp_b'])
    await putSetting('guardrails', 'repo_list', ['/repo/one'])
    await putSetting('guardrails', 'md_checkpoints', ['anchor1'])
    await putSetting('guardrails', 'md_blocklist', ['banned1'])
    await putSetting('guardrails', 'custom_rules', [
      { key: 'no_secrets', description: 'Never commit secrets', severity: 'critical' },
    ])
    await putSetting('coding_standards', 'languages', ['Swift', 'Python'])
    await putSetting('coding_standards', 'linter', 'eslint')
    await putSetting('deploy_workflow', 'stages', ['build', 'test', 'ship'])
    await putSetting('deploy_workflow', 'deploy_method', 'manual')
    await putSetting('team_rules', 'communication_style', 'direct')

    const p = profile()
    // Direct-mapped guardrails:
    expect(p.tool_whitelist).toEqual(['mcp_a', 'mcp_b'])
    expect(p.repo_list).toEqual(['/repo/one'])
    expect(p.md_blocklist).toEqual(['banned1'])
    // md_checkpoints = the guardrail setting PLUS the coding languages, deduped:
    expect(p.md_checkpoints).toEqual(['anchor1', 'Swift', 'Python'])
    // Built rules:
    expect(p.rules.no_secrets).toEqual({
      severity: 'critical', description: 'Never commit secrets',
    })
    expect(p.rules.coding_standards).toEqual({
      severity: 'high', description: 'Languages: Swift, Python. Linter: eslint',
    })
    expect(p.rules.deploy_workflow).toEqual({
      severity: 'high', description: 'Stages: build → test → ship. Method: manual',
    })
    expect(p.rules.team_rules).toEqual({
      severity: 'medium', description: 'Style: direct',
    })
  })

  test('brand is an ACCEPTED section that sync IGNORES', async () => {
    await putSetting('brand', 'tagline', 'be nice')
    const p = profile()
    // Nowhere in the profile does the brand setting appear.
    expect(JSON.stringify(p)).not.toContain('tagline')
    expect(JSON.stringify(p)).not.toContain('be nice')
  })

  test('POST /team-settings/sync re-runs the mapping — it recreates the profile when the row is missing', async () => {
    // Prove the POST endpoint itself invokes sync: remove the row out-of-band
    // (no route deletes node profiles), then sync.
    db.getDB().prepare('DELETE FROM node_profiles WHERE id = ?').run(SYNC_PROFILE_ID)
    expect(profile()).toBeNull()

    const res = await request(app).post(`${SECTION_PATH}/sync`).set(ADMIN)
    expect(res.status).toBe(200)
    expect(res.body.message).toBe('Profile sync complete')
    expect(profile()).toBeTruthy()
  })
})

// ===========================================================================
describe('contract — PUT upserts one string-serialized row per section/key', () => {
  test('PUT returns {ok, setting} where setting is the RAW row (value still a string)', async () => {
    const res = await putSetting('coding_standards', 'formatter', 'prettier')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.setting.section).toBe('coding_standards')
    expect(res.body.setting.key).toBe('formatter')
    expect(res.body.setting.value).toBe('prettier') // stored string, NOT parsed on the way out
    expect(res.body.setting.updated_by).toBe(ACTING_AS) // audit trail via X-Acting-As
  })

  test('a second PUT to the same section/key OVERWRITES (no duplicate row), and the profile follows', async () => {
    const res = await putSetting('coding_standards', 'linter', 'ruff')
    expect(res.status).toBe(200)
    expect(res.body.setting.value).toBe('ruff')

    const row = db.getTeamSetting('coding_standards', 'linter')
    expect(row.value).toBe('ruff')
    const count = db.getDB()
      .prepare('SELECT COUNT(*) AS c FROM team_settings WHERE section = ? AND key = ?')
      .get('coding_standards', 'linter').c
    expect(count).toBe(1)
    // The rebuilt rule carries the new value (formatter, set in the prior
    // test, still joins the description):
    expect(profile().rules.coding_standards.description).toBe(
      'Languages: Swift, Python. Linter: ruff. Formatter: prettier'
    )
  })

  test('scalar and object values round-trip: stored as strings, read back parsed', async () => {
    await putSetting('brand', 'port', 8080)
    const stored = db.getTeamSetting('brand', 'port')
    expect(stored.value).toBe('8080') // string on the way in

    const read = await request(app).get(`${SECTION_PATH}/brand`).set(ADMIN)
    expect(read.status).toBe(200)
    expect(read.body.port).toBe(8080) // number on the way back out
    expect(read.body.tagline).toBe('be nice') // string values stay strings
  })

  test('PUT without value -> 400 "value is required"', async () => {
    const res = await request(app)
      .put(`${SECTION_PATH}/brand/novalue`)
      .set(ADMIN)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('value is required')
  })

  test('PUT to an unknown section -> 400 naming the five valid sections', async () => {
    const res = await request(app)
      .put(`${SECTION_PATH}/bogus_section/key`)
      .set(ADMIN)
      .send({ value: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(
      'Invalid section. Must be one of: ' + VALID_SECTIONS.join(', ')
    )
  })
})

describe('contract — GET reads grouped/parsed; unknown section is an empty 200', () => {
  test('GET /team-settings returns sections as top-level keys with PARSED values', async () => {
    const res = await request(app).get(SECTION_PATH).set(ADMIN)
    expect(res.status).toBe(200)
    for (const section of ['guardrails', 'coding_standards', 'deploy_workflow', 'team_rules', 'brand']) {
      expect(res.body[section]).toBeTruthy()
    }
    expect(res.body.coding_standards.linter).toBe('ruff') // parsed, not '"ruff"'
    expect(res.body.guardrails.tool_whitelist).toEqual(['mcp_a', 'mcp_b']) // until the STALE PIN deletes it
  })

  test('GET /team-settings/:section returns only that section', async () => {
    const res = await request(app).get(`${SECTION_PATH}/guardrails`).set(ADMIN)
    expect(res.status).toBe(200)
    expect(Object.keys(res.body).sort()).toEqual(
      // tool_whitelist is still present here; the STALE PIN describe deletes it below.
      ['custom_rules', 'md_blocklist', 'md_checkpoints', 'repo_list', 'tool_whitelist']
    )
  })

  test('GET /team-settings/:section for an unknown section -> 200 {} (no 404)', async () => {
    const res = await request(app).get(`${SECTION_PATH}/never_a_section`).set(ADMIN)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({})
  })
})

// ===========================================================================
// STALE PIN — deleting a setting does NOT remove its synced effect (OPEN).
// ===========================================================================
// syncTeamSettingsToProfile is upsert-only in BOTH directions of the mapping:
//   1. Direct-mapped fields: a deleted setting simply contributes no update,
//      so the profile KEEPS the last-synced value (partial UPDATE).
//   2. Rule keys: `rules` is seeded from the profile's EXISTING rules
//      (teams.js: `if (existing) rules = existing.rules ...`) and only ever
//      gains/overwrites keys — a deleted setting's rule key is never pruned.
// Verified live for both. Deleting a guardrail therefore silently leaves the
// customer-agent profile enforcing a rule the team already rescinded — that
// reads like a bug, but flipping it changes public behavior, so it is PINNED
// here and left OPEN for Gilbert. If sync becomes subtracting, this REDS.
// ===========================================================================
describe('STALE PIN — DELETE removes the setting but not its synced profile effect', () => {
  test('deleting guardrails/tool_whitelist leaves the stale value on the profile', async () => {
    const del = await request(app)
      .delete(`${SECTION_PATH}/guardrails/tool_whitelist`)
      .set(ADMIN)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    // The setting is really gone from the store...
    const read = await request(app).get(`${SECTION_PATH}/guardrails`).set(ADMIN)
    expect(read.body.tool_whitelist).toBeUndefined()
    // ...but the profile still carries it.
    expect(profile().tool_whitelist).toEqual(['mcp_a', 'mcp_b'])
  })

  test('deleting a rules-backed key leaves the stale rule on the profile too', async () => {
    await request(app)
      .delete(`${SECTION_PATH}/team_rules/communication_style`)
      .set(ADMIN)
    const read = await request(app).get(`${SECTION_PATH}/team_rules`).set(ADMIN)
    expect(read.body.communication_style).toBeUndefined()
    // rules are seeded from the profile's existing rules — never pruned:
    expect(profile().rules.team_rules).toEqual({
      severity: 'medium', description: 'Style: direct',
    })
  })

  test('deleting a key that never existed is a 200 no-op', async () => {
    const res = await request(app)
      .delete(`${SECTION_PATH}/guardrails/never_existed`)
      .set(ADMIN)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

// ===========================================================================
describe('auth row — all five routes are admin-only', () => {
  // checkAdmin never reads X-Agent-Key. A BARE agent key (no Authorization
  // header) hits the 401 "Authentication required" branch — the brief's draft
  // expectation of 403 was re-derived from source before pinning. 403 IS the
  // answer when an admin key is presented and wrong (next test).
  test('a bare agent key is rejected with 401 on every route, including the GETs', async () => {
    const attempts = [
      ['get', SECTION_PATH],
      ['get', `${SECTION_PATH}/guardrails`],
      ['put', `${SECTION_PATH}/brand/k`],
      ['delete', `${SECTION_PATH}/brand/k`],
      ['post', `${SECTION_PATH}/sync`],
    ]
    for (const [verb, path] of attempts) {
      const res = await request(app)[verb](path).set('X-Agent-Key', KEYA).send({ value: 1 })
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Authentication required')
    }
  })

  test('a WRONG admin key is rejected with 403 on every route', async () => {
    const attempts = [
      ['get', SECTION_PATH],
      ['get', `${SECTION_PATH}/guardrails`],
      ['put', `${SECTION_PATH}/brand/k`],
      ['delete', `${SECTION_PATH}/brand/k`],
      ['post', `${SECTION_PATH}/sync`],
    ]
    for (const [verb, path] of attempts) {
      const res = await request(app)[verb](path)
        .set('X-Admin-Key', 'wrong-admin-key')
        .send({ value: 1 })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Invalid admin key')
    }
  })

  test('the agent in this file really is non-admin (its key never opens a read)', async () => {
    expect(db.getAgent(AGENTA)).toBeTruthy()
    const res = await request(app).get(SECTION_PATH).set('X-Agent-Key', KEYA)
    expect(res.status).toBe(401)
  })
})

// ===========================================================================
describe('source pins (tracks reality — reds if the literals drift)', () => {
  test('team_settings.js guards every route with checkAdmin (5x) and nothing else (0x agent-or-admin)', () => {
    const admin = ROUTE_SRC.match(/checkAdmin\(/g) || []
    const agentOrAdmin = ROUTE_SRC.match(/checkAgentOrAdmin\(/g) || []
    expect(admin).toHaveLength(5)
    expect(agentOrAdmin).toHaveLength(0)
  })

  test('the accepted-sections whitelist is read from source and is the five documented sections', () => {
    expect(SECTIONS_MATCH).toBeTruthy()
    expect(VALID_SECTIONS).toEqual([
      'coding_standards', 'deploy_workflow', 'brand', 'guardrails', 'team_rules',
    ])
  })

  test('the sync target profile id is read from db/teams.js and is customer-agent', () => {
    expect(PROFILE_ID_MATCH).toBeTruthy()
    expect(SYNC_PROFILE_ID).toBe('customer-agent')
  })

  test('the sync response literal lives in the route source', () => {
    expect(ROUTE_SRC).toContain("'Profile sync complete'")
  })
})

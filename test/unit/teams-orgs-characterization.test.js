import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// CHARACTERIZATION tests for the TEAMS / ORGS / OPERATORS / TEAM-SETTINGS slice
// of server/routes/mycelium.js (the 6,539-line god-file), written as a safety
// net BEFORE decomposition. These tests LOCK CURRENT behavior — including
// behavior that smells like a bug. Where something looks wrong it is flagged
// with a LATENT-BUG comment, but the assertion still pins what the code DOES
// today. Do not "fix" an assertion here without consciously changing the
// contract (and this file) together.
//
// Coverage map (route → auth guard):
//   GET  /orgs                        checkAgentOrAdmin
//   POST /orgs                        checkAdmin
//   GET  /orgs/:id                    checkAgentOrAdmin  (+ projects)
//   PUT  /orgs/:id                    checkAdmin
//   DEL  /orgs/:id                    checkAdmin
//   GET  /teams                       checkAgentOrAdmin  (?org_id filter)
//   POST /teams                       checkAdmin         (+ auto team channel)
//   GET  /teams/:id                   checkAgentOrAdmin  (members + projects)
//   PUT  /teams/:id                   checkAdmin
//   DEL  /teams/:id                   checkAdmin         (refuses non-empty)
//   POST /teams/:id/members           checkAdminOrOperator
//   PUT  /teams/:id/members/:userId   checkAdminOrOperator
//   DEL  /teams/:id/members/:userId   checkAdminOrOperator
//   GET  /teams/:id/projects          checkAgentOrAdmin
//   GET  /team-settings               checkAdmin (grouped)
//   GET  /team-settings/:section      checkAdmin
//   PUT  /team-settings/:section/:key checkAdmin (upsert)
//   DEL  /team-settings/:section/:key checkAdmin
//   POST /team-settings/sync          checkAdmin
//   GET  /operators                   checkAgentOrAdmin
//   GET  /operators/:id               checkAgentOrAdmin
//   POST /operators                   checkAdmin
//   PUT  /operators/:id               checkAdmin
//   DEL  /operators/:id               checkAdmin
//   getTeamProjectIdsForAgent         via checkProjectScope on PUT /tasks/:id
//
// Same harness as studio-login.test.js / auth-roles.test.js: real router,
// fresh temp DB, env set before the dynamic import. pool:'forks' isolates the
// module-global state (rate limiters, agent-key cache).

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'

let tmpDataDir
let app

// Studio JWTs minted directly (same claims getStudioUser verifies) — matches
// the auth-roles.test.js pattern; no studio_users row is required for JWT auth.
function jwtFor(role, displayName) {
  return jwt.sign(
    { studioUser: true, userId: 999, username: displayName.toLowerCase(), displayName, role },
    JWT_SECRET,
    { expiresIn: '1h' }
  )
}

function asAdmin(req) {
  return req.set('X-Admin-Key', ADMIN_KEY).set('X-Acting-As', 'm5max-test')
}

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-teams-orgs-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET
  // POST /admin/agents derives an instance URL from the Host header unless
  // PUBLIC_BASE_URL is set — pin it so agent registration is deterministic.
  process.env.PUBLIC_BASE_URL = 'http://localhost:3002'

  const db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Shared fixtures, created through the REAL routes (production write paths):
  // org-a ← team alpha; project proj-orga lives in org-a (org detail view).
  const org = await asAdmin(request(app).post('/api/mycelium/orgs'))
    .send({ id: 'org-a', name: 'Org A', description: 'first org' })
  if (org.status !== 200) throw new Error('fixture org-a failed: ' + JSON.stringify(org.body))

  const proj = await asAdmin(request(app).post('/api/mycelium/projects'))
    .send({ id: 'proj-orga', name: 'Org A Project', org_id: 'org-a' })
  if (proj.status !== 200) throw new Error('fixture proj-orga failed: ' + JSON.stringify(proj.body))

  const team = await asAdmin(request(app).post('/api/mycelium/teams'))
    .send({ id: 'alpha', org_id: 'org-a', name: 'Team Alpha', description: 'alpha squad' })
  if (team.status !== 200) throw new Error('fixture team alpha failed: ' + JSON.stringify(team.body))

  for (const id of ['op-1', 'op-2', 'op-prim']) {
    const op = await asAdmin(request(app).post('/api/mycelium/operators'))
      .send({ id, display_name: 'Operator ' + id })
    if (op.status !== 200) throw new Error('fixture ' + id + ' failed: ' + JSON.stringify(op.body))
  }
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// =============== ORGS ===============

describe('orgs — CRUD + auth', () => {
  test('POST /orgs returns the created org row; owner_id is the acting-as identity', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/orgs'))
      .send({ id: 'org-crud', name: 'CRUD Org', description: 'desc' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'org-crud',
      name: 'CRUD Org',
      description: 'desc',
      owner_id: 'm5max-test', // getAdminDisplayName(req) → X-Acting-As
      status: 'active',
    })
    expect(res.body.created_at).toBeTruthy()
  })

  test('POST /orgs missing name → 400', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/orgs')).send({ id: 'no-name' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('id and name required')
  })

  // LATENT BUG: createOrg uses INSERT OR IGNORE — re-POSTing an existing org id
  // is a silent no-op that returns 200 with the ORIGINAL row. The caller's new
  // name/description are discarded without any 409/conflict signal.
  test('POST /orgs with duplicate id silently returns the ORIGINAL org (200, no conflict)', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/orgs'))
      .send({ id: 'org-a', name: 'Hijacked Name', description: 'overwrite attempt' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Org A') // new name ignored
    expect(res.body.description).toBe('first org')
  })

  test('GET /orgs lists orgs (agent-or-admin auth)', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/orgs'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.map((o) => o.id)).toContain('org-a')
  })

  test('GET /orgs/:id returns org with its projects attached', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/orgs/org-a'))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('org-a')
    expect(Array.isArray(res.body.projects)).toBe(true)
    expect(res.body.projects.map((p) => p.id)).toContain('proj-orga')
  })

  test('GET /orgs/:id unknown → 404', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/orgs/no-such-org'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Organization not found')
  })

  test('PUT /orgs/:id updates whitelisted fields and returns the fresh row; unknown fields ignored', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/orgs/org-crud'))
      .send({ description: 'updated desc', bogus_field: 'ignored' })
    expect(res.status).toBe(200)
    expect(res.body.description).toBe('updated desc')
    expect(res.body).not.toHaveProperty('bogus_field')
  })

  test('PUT /orgs/:id unknown → 404', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/orgs/no-such-org')).send({ name: 'x' })
    expect(res.status).toBe(404)
  })

  test('DELETE /orgs/:id unknown → 404', async () => {
    const res = await asAdmin(request(app).delete('/api/mycelium/orgs/no-such-org'))
    expect(res.status).toBe(404)
  })

  // LATENT BUG: teams.org_id has NO foreign key and deleteOrg does no emptiness
  // check (contrast deleteTeam, which refuses when members exist). Deleting an
  // org strands its teams with a dangling org_id.
  test('DELETE /orgs/:id with teams still in it succeeds and ORPHANS the teams', async () => {
    await asAdmin(request(app).post('/api/mycelium/orgs')).send({ id: 'org-del', name: 'Doomed Org' })
    await asAdmin(request(app).post('/api/mycelium/teams'))
      .send({ id: 'orphan-team', org_id: 'org-del', name: 'Orphan Team' })

    const del = await asAdmin(request(app).delete('/api/mycelium/orgs/org-del'))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    // The team survives, pointing at an org that no longer exists.
    const team = await asAdmin(request(app).get('/api/mycelium/teams/orphan-team'))
    expect(team.status).toBe(200)
    expect(team.body.org_id).toBe('org-del')
  })

  test('POST /orgs as non-admin operator JWT → 403 Admin role required', async () => {
    const res = await request(app)
      .post('/api/mycelium/orgs')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
      .send({ id: 'op-org', name: 'Nope' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })

  test('POST /orgs unauthenticated → 401 Authentication required', async () => {
    const res = await request(app).post('/api/mycelium/orgs').send({ id: 'anon-org', name: 'Nope' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })
})

// =============== TEAMS ===============

describe('teams — CRUD + auth', () => {
  test('POST /teams returns the team with an empty members array; created_by = acting-as', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams'))
      .send({ id: 'beta', org_id: 'org-a', name: 'Team Beta', description: 'beta squad' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'beta',
      org_id: 'org-a',
      name: 'Team Beta',
      description: 'beta squad',
      created_by: 'm5max-test',
    })
    expect(res.body.members).toEqual([])
    expect(res.body.created_at).toBeTruthy()
    expect(res.body.updated_at).toBeTruthy()
  })

  test('POST /teams auto-creates the #team-<id> channel', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/channels').query({ type: 'team' }))
    expect(res.status).toBe(200)
    const slugs = (res.body.channels || res.body).map((c) => c.slug)
    expect(slugs).toContain('team-beta')
  })

  test('POST /teams missing org_id → 400 with combined required-fields message', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams'))
      .send({ id: 'no-org', name: 'No Org' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('id, org_id, and name required')
  })

  // LATENT BUG: duplicate team creation surfaces the RAW SQLite error message
  // to the client (err.message pass-through) instead of a clean conflict error.
  test('POST /teams duplicate id → 400 leaking the raw SQLite UNIQUE-constraint message', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams'))
      .send({ id: 'alpha', org_id: 'org-a', name: 'Alpha Again' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/UNIQUE constraint failed: teams\.id/)
  })

  // LATENT BUG: org existence is never validated on team create (and teams.org_id
  // has no FK) — a team can be born into a nonexistent org.
  test('POST /teams accepts a nonexistent org_id (no validation, no FK)', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams'))
      .send({ id: 'ghost-team', org_id: 'org-that-never-existed', name: 'Ghost Team' })
    expect(res.status).toBe(200)
    expect(res.body.org_id).toBe('org-that-never-existed')
  })

  test('GET /teams returns { teams: [...] } with member_count per team', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/teams'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.teams)).toBe(true)
    const alpha = res.body.teams.find((t) => t.id === 'alpha')
    expect(alpha).toBeTruthy()
    expect(alpha).toHaveProperty('member_count')
    expect(typeof alpha.member_count).toBe('number')
  })

  test('GET /teams?org_id= filters to that org', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/teams').query({ org_id: 'org-a' }))
    expect(res.status).toBe(200)
    const ids = res.body.teams.map((t) => t.id)
    expect(ids).toContain('alpha')
    expect(ids).not.toContain('ghost-team') // different org_id
  })

  test('GET /teams/:id returns team detail with members[] and projects[]', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/teams/alpha'))
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('alpha')
    expect(Array.isArray(res.body.members)).toBe(true)
    expect(Array.isArray(res.body.projects)).toBe(true)
  })

  test('GET /teams/:id unknown → 404 Team not found', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/teams/no-such-team'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Team not found')
  })

  test('PUT /teams/:id updates name and returns the fresh team', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/teams/beta'))
      .send({ name: 'Team Beta Renamed' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Team Beta Renamed')
  })

  test('PUT /teams/:id with empty body is a 200 no-op returning the team', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/teams/beta')).send({})
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('beta')
  })

  test('PUT /teams/:id unknown → 404', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/teams/no-such-team')).send({ name: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Team not found')
  })

  test('DELETE /teams/:id refuses while members remain (400), succeeds once empty', async () => {
    await asAdmin(request(app).post('/api/mycelium/teams'))
      .send({ id: 'del-team', org_id: 'org-a', name: 'Deletable' })
    await asAdmin(request(app).post('/api/mycelium/teams/del-team/members'))
      .send({ user_id: 'op-2' })

    const blocked = await asAdmin(request(app).delete('/api/mycelium/teams/del-team'))
    expect(blocked.status).toBe(400)
    expect(blocked.body.error).toBe('Team has members — remove them first')

    await asAdmin(request(app).delete('/api/mycelium/teams/del-team/members/op-2'))
    const ok = await asAdmin(request(app).delete('/api/mycelium/teams/del-team'))
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true })

    const gone = await asAdmin(request(app).get('/api/mycelium/teams/del-team'))
    expect(gone.status).toBe(404)
  })

  // LATENT BUG: deleting a team that doesn't exist returns { ok: true } — the
  // delete path never 404s (memberCount of a missing team is 0, DELETE matches
  // 0 rows, no error thrown).
  test('DELETE /teams/:id on a NONEXISTENT team returns 200 ok (no 404)', async () => {
    const res = await asAdmin(request(app).delete('/api/mycelium/teams/never-existed'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test('POST /teams as non-admin operator JWT → 403 Admin role required', async () => {
    const res = await request(app)
      .post('/api/mycelium/teams')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
      .send({ id: 'op-team', org_id: 'org-a', name: 'Nope' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })

  // FIXED (findings §1): checkAdmin now classifies a VALID agent key as
  // authenticated-but-not-authorized → 403 "Admin role required" (it grants
  // nothing). An UNRECOGNIZED agent key is not authentication → still 401.
  test('POST /teams with an agent key: valid → 403, unrecognized → 401', async () => {
    const reg = await asAdmin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id: 'teams-auth-probe', name: 'Teams Auth Probe', project_id: 'teams-auth-probe-proj' })
    expect(reg.status).toBe(200)

    const valid = await request(app)
      .post('/api/mycelium/teams')
      .set('X-Agent-Key', reg.body.api_key)
      .send({ id: 'agent-team', org_id: 'org-a', name: 'Nope' })
    expect(valid.status).toBe(403)
    expect(valid.body.error).toBe('Admin role required')

    const unrecognized = await request(app)
      .post('/api/mycelium/teams')
      .set('X-Agent-Key', 'dvk_' + 'a'.repeat(48))
      .send({ id: 'agent-team', org_id: 'org-a', name: 'Nope' })
    expect(unrecognized.status).toBe(401)
    expect(unrecognized.body.error).toBe('Authentication required')
  })

  // NOTE (locked): unauthenticated reads on checkAgentOrAdmin routes fall all
  // the way through to checkAgent, so the error message talks about agent keys
  // even when the caller is a browser/operator client.
  test('GET /teams unauthenticated → 401 "Missing X-Agent-Key header"', async () => {
    const res = await request(app).get('/api/mycelium/teams')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })
})

// =============== TEAM MEMBERS ===============

describe('team members — roles, primary flag, auth', () => {
  test('POST /teams/:id/members defaults: user_type operator, role member, not primary', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members'))
      .send({ user_id: 'op-1' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      team_id: 'alpha',
      user_id: 'op-1',
      user_type: 'operator',
      role: 'member',
      is_primary: 0,
    })
    expect(res.body.joined_at).toBeTruthy()
  })

  test('POST /teams/:id/members honors an explicit lead role', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members'))
      .send({ user_id: 'op-2', role: 'lead' })
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('lead')
  })

  test('member add is visible in GET /teams/:id members and member_count', async () => {
    const detail = await asAdmin(request(app).get('/api/mycelium/teams/alpha'))
    const ids = detail.body.members.map((m) => m.user_id)
    expect(ids).toContain('op-1')
    expect(ids).toContain('op-2')

    const list = await asAdmin(request(app).get('/api/mycelium/teams'))
    const alpha = list.body.teams.find((t) => t.id === 'alpha')
    expect(alpha.member_count).toBeGreaterThanOrEqual(2)
  })

  test('POST /teams/:id/members missing user_id → 400', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members')).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('user_id required')
  })

  // LATENT BUG: role is unvalidated free text. The documented vocabulary is
  // lead/member/guest, but any string is stored verbatim.
  test('role is NOT validated — arbitrary role strings are accepted and stored', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members'))
      .send({ user_id: 'op-prim', role: 'supreme-overlord' })
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('supreme-overlord')
    // clean up membership for the is_primary tests below
    await asAdmin(request(app).delete('/api/mycelium/teams/alpha/members/op-prim'))
  })

  // LATENT BUG: user existence is never checked — a user_id that matches no
  // operator, agent, or studio user becomes a ghost member.
  test('ghost user_id (no such operator/agent) is accepted as a member', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members'))
      .send({ user_id: 'nobody-anywhere' })
    expect(res.status).toBe(200)
    expect(res.body.user_id).toBe('nobody-anywhere')
    await asAdmin(request(app).delete('/api/mycelium/teams/alpha/members/nobody-anywhere'))
  })

  // LATENT BUG: raw SQLite UNIQUE-constraint message leaks on duplicate add.
  test('adding the same member twice → 400 with raw UNIQUE-constraint message', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members'))
      .send({ user_id: 'op-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/UNIQUE constraint failed: team_members\.team_id, team_members\.user_id/)
  })

  // LATENT BUG: raw FK error leaks when the team doesn't exist (foreign_keys=ON
  // catches it, but the client sees SQLite internals instead of a 404).
  test('adding a member to a NONEXISTENT team → 400 with raw FOREIGN KEY message', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/teams/no-such-team/members'))
      .send({ user_id: 'op-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/FOREIGN KEY constraint failed/)
  })

  test('is_primary add sets the operator primary_team_id; re-primary elsewhere moves it (single-primary invariant)', async () => {
    // Second team to flip primary to.
    await asAdmin(request(app).post('/api/mycelium/teams'))
      .send({ id: 'gamma', org_id: 'org-a', name: 'Team Gamma' })

    const first = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members'))
      .send({ user_id: 'op-prim', is_primary: true })
    expect(first.status).toBe(200)
    expect(first.body.is_primary).toBe(1)

    let op = await asAdmin(request(app).get('/api/mycelium/operators/op-prim'))
    expect(op.body.primary_team_id).toBe('alpha')

    // Joining gamma as primary demotes the alpha membership's flag and
    // repoints the operator row.
    const second = await asAdmin(request(app).post('/api/mycelium/teams/gamma/members'))
      .send({ user_id: 'op-prim', is_primary: true })
    expect(second.status).toBe(200)
    expect(second.body.is_primary).toBe(1)

    op = await asAdmin(request(app).get('/api/mycelium/operators/op-prim'))
    expect(op.body.primary_team_id).toBe('gamma')

    const alpha = await asAdmin(request(app).get('/api/mycelium/teams/alpha'))
    const prim = alpha.body.members.find((m) => m.user_id === 'op-prim')
    expect(prim.is_primary).toBe(0)
  })

  test('PUT /teams/:id/members/:userId updates the role (response is bare {ok:true})', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/teams/alpha/members/op-1'))
      .send({ role: 'guest' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const detail = await asAdmin(request(app).get('/api/mycelium/teams/alpha'))
    const m = detail.body.members.find((x) => x.user_id === 'op-1')
    expect(m.role).toBe('guest')
  })

  // LATENT BUG: updating a membership that doesn't exist is a silent 200 no-op
  // (updateTeamMember UPDATEs 0 rows and returns nothing; the route can't tell).
  test('PUT on a NONEXISTENT membership → 200 {ok:true} (silent no-op)', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/teams/alpha/members/never-joined'))
      .send({ role: 'lead' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test('DELETE removes the member; removing the primary clears operator primary_team_id', async () => {
    const res = await asAdmin(request(app).delete('/api/mycelium/teams/gamma/members/op-prim'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })

    const detail = await asAdmin(request(app).get('/api/mycelium/teams/gamma'))
    expect(detail.body.members.map((m) => m.user_id)).not.toContain('op-prim')

    const op = await asAdmin(request(app).get('/api/mycelium/operators/op-prim'))
    expect(op.body.primary_team_id).toBeNull()
  })

  // LATENT BUG: like PUT, member DELETE never 404s — unknown membership is a
  // silent {ok:true}.
  test('DELETE on a NONEXISTENT membership → 200 {ok:true} (silent no-op)', async () => {
    const res = await asAdmin(request(app).delete('/api/mycelium/teams/alpha/members/never-joined'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  test('non-admin operator JWT CAN manage members (checkAdminOrOperator)', async () => {
    // op-prim is still an alpha member (only its gamma membership was removed
    // above), so use a fresh user id — ghosts are accepted, as pinned earlier.
    const add = await request(app)
      .post('/api/mycelium/teams/alpha/members')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
      .send({ user_id: 'jwt-added-user', role: 'guest' })
    expect(add.status).toBe(200)
    expect(add.body.user_id).toBe('jwt-added-user')
    await asAdmin(request(app).delete('/api/mycelium/teams/alpha/members/jwt-added-user'))
  })

  test('agent key CANNOT manage members → 403 Operator or admin access required', async () => {
    const res = await request(app)
      .post('/api/mycelium/teams/alpha/members')
      .set('X-Agent-Key', 'dvk_' + 'b'.repeat(48))
      .send({ user_id: 'op-1' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Operator or admin access required')
  })

  // FIXED (findings §1 sibling): checkAdminOrOperator now distinguishes a fully
  // anonymous request (401 — never authenticated) from a caller that presented
  // a credential but isn't operator/admin (403, as pinned above).
  test('unauthenticated member add → 401 "Authentication required"', async () => {
    const res = await request(app)
      .post('/api/mycelium/teams/alpha/members')
      .send({ user_id: 'op-1' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })
})

// =============== TEAM SETTINGS ===============

describe('team-settings — sectioned KV, upsert/read-back, sync', () => {
  test('PUT upserts a string value; response wraps the RAW stored row (value is the string)', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/team-settings/coding_standards/linter'))
      .send({ value: 'eslint' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.setting).toMatchObject({
      section: 'coding_standards',
      key: 'linter',
      value: 'eslint', // stored string, NOT parsed
      updated_by: 'm5max-test',
    })
    expect(res.body.setting.updated_at).toBeTruthy()
  })

  test('GET /team-settings/:section returns { key: parsedValue } for the section', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/team-settings/coding_standards'))
    expect(res.status).toBe(200)
    expect(res.body.linter).toBe('eslint')
  })

  test('object values round-trip: stored as JSON, parsed on section read', async () => {
    const put = await asAdmin(request(app).put('/api/mycelium/team-settings/guardrails/tool_whitelist'))
      .send({ value: ['bash', 'read_file'] })
    expect(put.status).toBe(200)
    expect(put.body.setting.value).toBe('["bash","read_file"]') // raw JSON string in the row

    const get = await asAdmin(request(app).get('/api/mycelium/team-settings/guardrails'))
    expect(get.body.tool_whitelist).toEqual(['bash', 'read_file'])
  })

  test('re-PUT on the same section/key overwrites (upsert, not insert)', async () => {
    await asAdmin(request(app).put('/api/mycelium/team-settings/coding_standards/linter'))
      .send({ value: 'biome' })
    const res = await asAdmin(request(app).get('/api/mycelium/team-settings/coding_standards'))
    expect(res.body.linter).toBe('biome')
  })

  // LATENT BUG (type morphing): write path stores non-objects with String(value);
  // read path attempts JSON.parse on every value. A STRING that happens to look
  // like JSON changes type on the way back out: '123' → 123, 'true' → true.
  test('numeric-looking STRING value morphs into a NUMBER on read-back', async () => {
    const put = await asAdmin(request(app).put('/api/mycelium/team-settings/brand/version'))
      .send({ value: '123' })
    expect(put.status).toBe(200)
    expect(put.body.setting.value).toBe('123') // write response: string

    const get = await asAdmin(request(app).get('/api/mycelium/team-settings/brand'))
    expect(get.body.version).toBe(123) // read-back: number
    expect(typeof get.body.version).toBe('number')
  })

  test('boolean false is a legal value (only undefined is rejected) and survives round-trip', async () => {
    const put = await asAdmin(request(app).put('/api/mycelium/team-settings/team_rules/strict_mode'))
      .send({ value: false })
    expect(put.status).toBe(200)
    const get = await asAdmin(request(app).get('/api/mycelium/team-settings/team_rules'))
    expect(get.body.strict_mode).toBe(false)
  })

  test('PUT without value → 400 value is required', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/team-settings/brand/logo')).send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('value is required')
  })

  test('PUT rejects sections outside the whitelist with the allowed list in the message', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/team-settings/nonsense/key'))
      .send({ value: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe(
      'Invalid section. Must be one of: coding_standards, deploy_workflow, brand, guardrails, team_rules'
    )
  })

  // LATENT BUG (asymmetry): the section whitelist is enforced ONLY on the write
  // path. Reads of an invalid section return an empty object, and deletes of an
  // invalid section return ok — neither 400s.
  test('GET and DELETE do NOT validate the section (empty object / silent ok)', async () => {
    const get = await asAdmin(request(app).get('/api/mycelium/team-settings/nonsense'))
    expect(get.status).toBe(200)
    expect(get.body).toEqual({})

    const del = await asAdmin(request(app).delete('/api/mycelium/team-settings/nonsense/key'))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
  })

  test('GET /team-settings returns everything grouped by section', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/team-settings'))
    expect(res.status).toBe(200)
    expect(res.body.coding_standards).toMatchObject({ linter: 'biome' })
    expect(res.body.guardrails).toMatchObject({ tool_whitelist: ['bash', 'read_file'] })
  })

  test('DELETE removes the key; deleting an absent key is an idempotent ok', async () => {
    const del = await asAdmin(request(app).delete('/api/mycelium/team-settings/brand/version'))
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    const get = await asAdmin(request(app).get('/api/mycelium/team-settings/brand'))
    expect(get.body).not.toHaveProperty('version')

    const again = await asAdmin(request(app).delete('/api/mycelium/team-settings/brand/version'))
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ ok: true })
  })

  test('POST /team-settings/sync → { ok, message: Profile sync complete }', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/team-settings/sync'))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, message: 'Profile sync complete' })
  })

  test('team-settings are admin-only: operator JWT → 403, unrecognized agent key → 401, anonymous → 401', async () => {
    const asOperator = await request(app)
      .get('/api/mycelium/team-settings')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
    expect(asOperator.status).toBe(403)
    expect(asOperator.body.error).toBe('Admin role required')

    // An UNRECOGNIZED agent key never authenticates → 401. (A VALID agent key
    // now draws 403 "Admin role required" — findings-§1 fix, proven in the
    // POST /teams auth test above.)
    const asAgent = await request(app)
      .get('/api/mycelium/team-settings')
      .set('X-Agent-Key', 'dvk_' + 'c'.repeat(48))
    expect(asAgent.status).toBe(401)
    expect(asAgent.body.error).toBe('Authentication required')

    const anon = await request(app).get('/api/mycelium/team-settings')
    expect(anon.status).toBe(401)
  })
})

// =============== OPERATORS ===============

describe('operators — CRUD + admin-only mutations', () => {
  test('POST /operators returns the full row with defaults (role member, active/available)', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/operators'))
      .send({ id: 'op-new', display_name: 'New Operator' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'op-new',
      display_name: 'New Operator',
      role: 'member',
      responsibilities: '',
      email: '',
      studio_user_id: null,
      status: 'active',
      availability: 'available',
      away_message: '',
      primary_team_id: null,
    })
    expect(res.body.created_at).toBeTruthy()
  })

  test('POST /operators honors explicit role/email/responsibilities', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/operators'))
      .send({ id: 'op-full', display_name: 'Full Operator', role: 'admin', email: 'x@y.z', responsibilities: 'everything' })
    expect(res.status).toBe(200)
    expect(res.body.role).toBe('admin')
    expect(res.body.email).toBe('x@y.z')
    expect(res.body.responsibilities).toBe('everything')
  })

  test('POST /operators duplicate id → 409 Operator already exists', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/operators'))
      .send({ id: 'op-1', display_name: 'Clone' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Operator already exists')
  })

  test('POST /operators missing display_name → 400', async () => {
    const res = await asAdmin(request(app).post('/api/mycelium/operators')).send({ id: 'no-name' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('id and display_name required')
  })

  test('PUT /operators/:id updates whitelisted fields, ignores unknown ones, returns fresh row', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/operators/op-new'))
      .send({ display_name: 'Renamed Operator', role: 'lead', hackfield: 'ignored' })
    expect(res.status).toBe(200)
    expect(res.body.display_name).toBe('Renamed Operator')
    expect(res.body.role).toBe('lead')
    expect(res.body).not.toHaveProperty('hackfield')
  })

  test('PUT /operators/:id unknown → 404 Operator not found', async () => {
    const res = await asAdmin(request(app).put('/api/mycelium/operators/no-such-op'))
      .send({ display_name: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Operator not found')
  })

  test('GET /operators lists all operators (array of rows)', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/operators'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const ids = res.body.map((o) => o.id)
    expect(ids).toEqual(expect.arrayContaining(['op-1', 'op-2', 'op-prim', 'op-new']))
  })

  test('GET /operators/:id unknown → 404', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/operators/no-such-op'))
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Operator not found')
  })

  test('operator mutations are admin-only: operator JWT 403, unrecognized agent key 401', async () => {
    const asOperator = await request(app)
      .post('/api/mycelium/operators')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
      .send({ id: 'sneak', display_name: 'Sneak' })
    expect(asOperator.status).toBe(403)
    expect(asOperator.body.error).toBe('Admin role required')

    // Unrecognized key = no authentication → 401 (a VALID agent key would 403
    // per the findings-§1 fix).
    const asAgent = await request(app)
      .put('/api/mycelium/operators/op-1')
      .set('X-Agent-Key', 'dvk_' + 'd'.repeat(48))
      .send({ role: 'admin' })
    expect(asAgent.status).toBe(401)
    expect(asAgent.body.error).toBe('Authentication required')
  })

  test('operator reads are open to any authenticated principal — operator JWT works', async () => {
    const res = await request(app)
      .get('/api/mycelium/operators')
      .set('Authorization', 'Bearer ' + jwtFor('member', 'Hijack'))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })

  test('GET /operators unauthenticated → 401 with the agent-key fall-through message', async () => {
    const res = await request(app).get('/api/mycelium/operators')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })
})

// =============== AGENT → TEAMS → PROJECTS SCOPING ===============

// getTeamProjectIdsForAgent is reached through checkProjectScope on task
// writes: an agent may WRITE to a project it doesn't own iff a team it belongs
// to owns that project (write-scope matches dispatch-scope). Fixtures are all
// built through real routes: POST /admin/agents (returns the plaintext key),
// PUT /projects/:id to set team_id, POST /teams/:id/members with
// user_type 'agent'.
describe('agent→team→project scoping (getTeamProjectIdsForAgent via task writes)', () => {
  let scopedKey
  let outsiderKey
  let teamTaskId
  let nowhereTaskId

  beforeAll(async () => {
    // Projects: the agents' home project, a team-owned project, and a project
    // owned by no team.
    for (const [id, name] of [
      ['scope-home', 'Scope Home'],
      ['scope-teamproj', 'Scope Team Project'],
      ['scope-nowhere', 'Scope Nowhere'],
    ]) {
      const r = await asAdmin(request(app).post('/api/mycelium/projects'))
        .send({ id, name, org_id: 'org-a' })
      if (r.status !== 200) throw new Error('project ' + id + ' failed: ' + JSON.stringify(r.body))
    }

    // Hand scope-teamproj to team alpha (team_id only settable via PUT).
    const own = await asAdmin(request(app).put('/api/mycelium/projects/scope-teamproj'))
      .send({ team_id: 'alpha' })
    if (own.status !== 200) throw new Error('team_id set failed: ' + JSON.stringify(own.body))

    // Two agents, same home project; only one joins team alpha.
    const reg1 = await asAdmin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id: 'scoped-agent', name: 'Scoped Agent', project_id: 'scope-home' })
    if (reg1.status !== 200) throw new Error('scoped-agent failed: ' + JSON.stringify(reg1.body))
    scopedKey = reg1.body.api_key

    const reg2 = await asAdmin(request(app).post('/api/mycelium/admin/agents'))
      .send({ id: 'outsider-agent', name: 'Outsider Agent', project_id: 'scope-home' })
    if (reg2.status !== 200) throw new Error('outsider-agent failed: ' + JSON.stringify(reg2.body))
    outsiderKey = reg2.body.api_key

    const join = await asAdmin(request(app).post('/api/mycelium/teams/alpha/members'))
      .send({ user_id: 'scoped-agent', user_type: 'agent', role: 'member' })
    if (join.status !== 200) throw new Error('agent join failed: ' + JSON.stringify(join.body))

    // Tasks to write against (created by admin).
    const t1 = await asAdmin(request(app).post('/api/mycelium/tasks'))
      .send({ title: 'team project task', project_id: 'scope-teamproj' })
    teamTaskId = t1.body.id
    const t2 = await asAdmin(request(app).post('/api/mycelium/tasks'))
      .send({ title: 'nowhere task', project_id: 'scope-nowhere' })
    nowhereTaskId = t2.body.id
    if (!teamTaskId || !nowhereTaskId) throw new Error('task fixtures failed')
  })

  test('agent registration returns the plaintext api_key exactly once', () => {
    expect(scopedKey).toMatch(/^dvk_[0-9a-f]{48}$/)
    expect(outsiderKey).toMatch(/^dvk_[0-9a-f]{48}$/)
  })

  test('GET /teams/:id/projects shows the team-owned project', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/teams/alpha/projects'))
    expect(res.status).toBe(200)
    expect(res.body.projects.map((p) => p.id)).toContain('scope-teamproj')
  })

  test('agent membership appears with user_type agent in team detail', async () => {
    const res = await asAdmin(request(app).get('/api/mycelium/teams/alpha'))
    const m = res.body.members.find((x) => x.user_id === 'scoped-agent')
    expect(m).toBeTruthy()
    expect(m.user_type).toBe('agent')
    expect(m.role).toBe('member')
  })

  test('team member agent CAN write a task in the team-owned project (cross-project write allowed)', async () => {
    const res = await request(app)
      .put('/api/mycelium/tasks/' + teamTaskId)
      .set('X-Agent-Key', scopedKey)
      .send({ status: 'in_progress' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id: teamTaskId })
  })

  test('NON-member agent writing the same task → 403 with the project-scope error', async () => {
    const res = await request(app)
      .put('/api/mycelium/tasks/' + teamTaskId)
      .set('X-Agent-Key', outsiderKey)
      .send({ status: 'in_progress' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe(
      'Agent outsider-agent cannot access resources in project scope-teamproj'
    )
  })

  test('team membership does NOT grant writes to projects owned by no team', async () => {
    const res = await request(app)
      .put('/api/mycelium/tasks/' + nowhereTaskId)
      .set('X-Agent-Key', scopedKey)
      .send({ status: 'in_progress' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe(
      'Agent scoped-agent cannot access resources in project scope-nowhere'
    )
  })

  test('reads stay unscoped: the same agent can GET the task it may not write', async () => {
    const res = await request(app)
      .get('/api/mycelium/tasks/' + nowhereTaskId)
      .set('X-Agent-Key', scopedKey)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(nowhereTaskId)
  })

  test('agents CAN read the team roster (GET /teams with agent key)', async () => {
    const res = await request(app)
      .get('/api/mycelium/teams')
      .set('X-Agent-Key', scopedKey)
    expect(res.status).toBe(200)
    expect(res.body.teams.map((t) => t.id)).toContain('alpha')
  })
})

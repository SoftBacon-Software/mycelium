import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'

// CHARACTERIZATION tests — CONCEPTS + PROJECTS + SKILLS slice of the
// 6,539-line god-file server/routes/mycelium.js, written BEFORE decomposition.
//
// These tests LOCK CURRENT BEHAVIOR — including behavior that smells like a
// bug. Each suspicious behavior is flagged with "LATENT BUG (locked):" in a
// comment but is still asserted AS-IS. If decomposition changes any of these,
// the change must be deliberate (update the test + note the semantic change),
// not accidental.
//
// Locked latent-bug inventory (details at each test):
//  B1. POST /projects with an existing id is a silent no-op (INSERT OR IGNORE)
//      that returns 200 with the OLD row — client's name/description ignored.
//  B2. GET /projects/:id/bug-categories never 404s — nonexistent project
//      returns the DEFAULT categories.
//  B3. POST /concepts returns 200, not 201 (POST /skills returns 201 — the
//      two registries disagree on create status codes).
//  B4. PUT /concepts/:id does NOT validate `type` (POST does) — any string
//      is accepted on update.
//  B5. POST /concepts/:id/link does not validate the project exists (and
//      project_concepts.project_id has no FK) → orphan link rows. Asymmetric
//      visibility: GET /projects/:ghost/concepts SHOWS the concept, but the
//      concept's own projects list omits the ghost project (JOIN on projects).
//  B6. PUT /skills/:id with no updatable fields (or only non-allowlisted
//      fields, e.g. `author`) returns 404 "skill not found" even though the
//      skill EXISTS (updateSkill conflates "no fields changed" with "no row").
//  B7. POST /skills/:id/install with admin key + X-Acting-As IGNORES
//      body.agent_id and installs on the acting-as name; admin key with
//      neither installs on the literal agent id "__system__".
//  B8. Reinstalling a skill double-increments install_count (INSERT OR
//      REPLACE + unconditional increment); uninstall never decrements.
//  B9. POST /skills/:id/uninstall never 404s (no skill/agent existence check).
// B10. Admin-only routes (checkAdmin) never consult X-Agent-Key: a request
//      authenticated ONLY by a valid agent key gets 401 "Authentication
//      required" (not 403). Conversely on agent-or-admin routes an INVALID
//      X-Admin-Key with no agent key falls through to 401 "Missing
//      X-Agent-Key header" (not 403 "Invalid admin key").
//
// Harness: same as studio-login.test.js — real router, fresh temp DB,
// env before dynamic import, supertest. Fixtures via the real routes where
// possible; db.createAgent/createProject for agent-key fixtures (the pattern
// locked in project-scope-rerun-approval.test.js).

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const JWT_SECRET = 'test-jwt-secret'
const AGENT_KEY = 'dvk_test_cps_agent_key_0123456789abcdef01234567'
const AGENT_HASH = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
const AGENT_ID = 'cps-agent'

let tmpDataDir
let db
let app
let memberJwt // studio JWT with a NON-admin role

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-cps-char-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY
  process.env.JWT_SECRET = JWT_SECRET

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Agent fixture: scoped to cps-proj-a (project created first for realism)
  db.createProject('cps-proj-a', 'CPS Proj A', '', '', '', 'software')
  db.createAgent(AGENT_ID, 'CPS Agent', 'cps-proj-a', AGENT_HASH, '["code"]')

  // Non-admin operator token — getStudioUser only verifies the JWT, no DB row
  // required. Used to lock checkAdmin's 403 "Admin role required" branch.
  memberJwt = jwt.sign(
    { studioUser: true, userId: 424242, username: 'op-member', role: 'member' },
    JWT_SECRET, { algorithm: 'HS256' }
  )
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

const api = (p) => '/api/mycelium' + p
function adminHeaders() {
  return { 'X-Admin-Key': ADMIN_KEY } // no X-Acting-As → who = '__system__'
}
function actingAs(name) {
  return { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': name }
}
function agentHeaders() {
  return { 'X-Agent-Key': AGENT_KEY }
}

// ======================= AUTH MATRIX =======================

describe('auth: checkAgentOrAdmin routes (GET /skills as probe)', () => {
  test('no credentials → 401 "Missing X-Agent-Key header"', async () => {
    const res = await request(app).get(api('/skills'))
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('LATENT BUG (locked) B10: INVALID admin key falls through to agent auth → 401 (not 403)', async () => {
    // checkAgentOrAdmin: isAdminKey(bad) is false → silently falls through to
    // checkAgent → no X-Agent-Key header → 401. The caller sent a WRONG admin
    // key and is told an agent header is missing — misleading, but current.
    const res = await request(app).get(api('/skills')).set('X-Admin-Key', 'wrong-key')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('invalid agent key → 403 "Invalid agent key"', async () => {
    const res = await request(app).get(api('/skills')).set('X-Agent-Key', 'not-a-real-key')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })

  test('valid agent key and valid admin key both pass', async () => {
    expect((await request(app).get(api('/skills')).set(agentHeaders())).status).toBe(200)
    expect((await request(app).get(api('/skills')).set(adminHeaders())).status).toBe(200)
  })
})

describe('auth: checkAdmin routes (POST /skills as probe)', () => {
  test('no credentials → 401 "Authentication required"', async () => {
    const res = await request(app).post(api('/skills')).send({ id: 'x', name: 'X' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })

  test('LATENT BUG (locked) B10: valid AGENT key on admin route → 401 (agent keys never consulted)', async () => {
    // checkAdmin only looks at studio JWT + X-Admin-Key. An authenticated
    // agent gets the same 401 as an anonymous caller (not a role-based 403).
    const res = await request(app).post(api('/skills')).set(agentHeaders()).send({ id: 'x', name: 'X' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Authentication required')
  })

  test('wrong admin key → 403 "Invalid admin key"', async () => {
    const res = await request(app).post(api('/skills')).set('X-Admin-Key', 'wrong-key').send({ id: 'x', name: 'X' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid admin key')
  })

  test('studio JWT with non-admin role → 403 "Admin role required"', async () => {
    const res = await request(app)
      .post(api('/skills'))
      .set('Authorization', 'Bearer ' + memberJwt)
      .send({ id: 'x', name: 'X' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Admin role required')
  })
})

// ======================= PROJECTS =======================

describe('projects: CRUD + listing', () => {
  test('POST /projects (admin) → 200 with full row + schema defaults', async () => {
    const res = await request(app)
      .post(api('/projects'))
      .set(adminHeaders())
      .send({ id: 'proj-crud-1', name: 'Crud One', description: 'first', repo_url: 'https://x/r.git', org_id: 'org-z' })
    // NOTE: create returns 200, not 201 (POST /skills returns 201 — inconsistent, locked)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'proj-crud-1',
      name: 'Crud One',
      description: 'first',
      repo_url: 'https://x/r.git',
      org_id: 'org-z',
      type: 'software',       // default when not sent
      status: 'active',       // schema default
      bug_categories: '[]',   // raw string, NOT parsed
      repo_path: ''
    })
    expect(res.body.created_at).toBeTruthy()
  })

  test('POST /projects missing id or name → 400 "id and name required"', async () => {
    const noName = await request(app).post(api('/projects')).set(adminHeaders()).send({ id: 'p-x' })
    const noId = await request(app).post(api('/projects')).set(adminHeaders()).send({ name: 'X' })
    expect(noName.status).toBe(400)
    expect(noId.status).toBe(400)
    expect(noName.body.error).toBe('id and name required')
  })

  test('LATENT BUG (locked) B1: duplicate project id → 200 with the ORIGINAL row (silent no-op)', async () => {
    // createProject uses INSERT OR IGNORE; the handler then re-fetches by id.
    // The second caller gets a 200 "success" whose name/description are the
    // FIRST caller's values — no conflict signal at all (contrast: POST
    // /skills → 409 on duplicate).
    const res = await request(app)
      .post(api('/projects'))
      .set(adminHeaders())
      .send({ id: 'proj-crud-1', name: 'HIJACKED NAME', description: 'overwrite attempt' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Crud One')          // original name, not the new one
    expect(res.body.description).toBe('first')       // original description
  })

  test('GET /projects (agent auth) lists projects; ?org_id= filters', async () => {
    const all = await request(app).get(api('/projects')).set(agentHeaders())
    expect(all.status).toBe(200)
    expect(Array.isArray(all.body)).toBe(true)
    expect(all.body.find(p => p.id === 'proj-crud-1')).toBeTruthy()

    const filtered = await request(app).get(api('/projects?org_id=org-z')).set(adminHeaders())
    expect(filtered.status).toBe(200)
    expect(filtered.body.length).toBeGreaterThan(0)
    expect(filtered.body.every(p => p.org_id === 'org-z')).toBe(true)
    expect(filtered.body.find(p => p.id === 'cps-proj-a')).toBeFalsy() // org_id '' excluded
  })

  test('GET /projects/:id → 200; agent may read a project OUTSIDE its own scope (no checkProjectScope here)', async () => {
    // The agent fixture is scoped to cps-proj-a. Project reads are NOT
    // project-scoped on this route (contrast PUT /tasks/:id, which 403s
    // cross-project agents — locked in project-scope-rerun-approval.test.js).
    const res = await request(app).get(api('/projects/proj-crud-1')).set(agentHeaders())
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('proj-crud-1')
  })

  test('GET /projects/:id unknown → 404 "Project not found"', async () => {
    const res = await request(app).get(api('/projects/no-such-project')).set(adminHeaders())
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Project not found')
  })

  test('PUT /projects/:id (admin) updates allow-listed fields, returns fresh row', async () => {
    const res = await request(app)
      .put(api('/projects/proj-crud-1'))
      .set(adminHeaders())
      .send({ name: 'Crud One v2', status: 'archived', team_id: 'team-9' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Crud One v2')
    expect(res.body.status).toBe('archived')
    expect(res.body.team_id).toBe('team-9')
  })

  test('PUT /projects/:id with only non-allowlisted fields → 200, row unchanged (silent no-op)', async () => {
    // buildUpdate returns false (no allowed fields); the handler ignores the
    // return value and responds with the untouched row. `id` is not
    // renameable and unknown fields are dropped without error.
    const res = await request(app)
      .put(api('/projects/proj-crud-1'))
      .set(adminHeaders())
      .send({ id: 'evil-rename', nonsense_field: 42 })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('proj-crud-1')
    expect(res.body.name).toBe('Crud One v2') // unchanged from previous test
  })

  test('PUT /projects/:id unknown → 404; agent key → 401 (admin-only)', async () => {
    const notFound = await request(app).put(api('/projects/nope')).set(adminHeaders()).send({ name: 'x' })
    expect(notFound.status).toBe(404)
    expect(notFound.body.error).toBe('Project not found')

    const asAgent = await request(app).put(api('/projects/proj-crud-1')).set(agentHeaders()).send({ name: 'x' })
    expect(asAgent.status).toBe(401) // B10 again: agent key invisible to checkAdmin
  })

  test('DELETE /projects/:id → { ok, deleted }; row gone; unknown → 404', async () => {
    await request(app).post(api('/projects')).set(adminHeaders()).send({ id: 'proj-del-1', name: 'Doomed' })
    const del = await request(app).delete(api('/projects/proj-del-1')).set(adminHeaders())
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true, deleted: 'proj-del-1' })

    const gone = await request(app).get(api('/projects/proj-del-1')).set(adminHeaders())
    expect(gone.status).toBe(404)

    const again = await request(app).delete(api('/projects/proj-del-1')).set(adminHeaders())
    expect(again.status).toBe(404)
  })

  test('GET /projects/:id/bug-categories: custom list when set; LATENT BUG (locked) B2: nonexistent project → 200 defaults', async () => {
    await request(app).post(api('/projects')).set(adminHeaders()).send({ id: 'proj-cats', name: 'Cats' })
    // PUT stringifies array bug_categories before storage
    await request(app).put(api('/projects/proj-cats')).set(adminHeaders()).send({ bug_categories: ['sound', 'gfx'] })

    const custom = await request(app).get(api('/projects/proj-cats/bug-categories')).set(agentHeaders())
    expect(custom.status).toBe(200)
    expect(custom.body).toEqual({ project_id: 'proj-cats', categories: ['sound', 'gfx'] })

    // No existence check: a project that was never created still gets 200
    // with the DEFAULT categories (no 404 signal for typo'd project ids).
    const ghost = await request(app).get(api('/projects/no-such-proj/bug-categories')).set(agentHeaders())
    expect(ghost.status).toBe(200)
    expect(ghost.body.project_id).toBe('no-such-proj')
    expect(ghost.body.categories).toEqual(['bug', 'feature', 'ui', 'crash', 'api', 'infrastructure', 'other'])
  })
})

// ======================= CONCEPTS =======================

describe('concepts: create / read / update', () => {
  let conceptId

  test('LATENT BUG (locked) B3: POST /concepts → 200 (not 201); data parsed; created_by from X-Acting-As', async () => {
    const res = await request(app)
      .post(api('/concepts'))
      .set(actingAs('tester'))
      .send({ name: 'Kira', type: 'character', description: 'squad head', data: { hp: 10, traits: ['sharp'] } })
    expect(res.status).toBe(200) // POST /skills returns 201; concepts return 200
    expect(res.body.id).toBeTypeOf('number')
    expect(res.body).toMatchObject({
      name: 'Kira',
      type: 'character',
      description: 'squad head',
      version: 1,
      created_by: 'tester'
    })
    expect(res.body.data).toEqual({ hp: 10, traits: ['sharp'] }) // parsed object, not string
    expect(res.body.projects).toEqual([])
    conceptId = res.body.id
  })

  test('POST /concepts as agent → created_by is the agent id; type defaults to custom; data defaults {}', async () => {
    const res = await request(app)
      .post(api('/concepts'))
      .set(agentHeaders())
      .send({ name: 'agent-made concept' })
    expect(res.status).toBe(200)
    expect(res.body.created_by).toBe(AGENT_ID)
    expect(res.body.type).toBe('custom')
    expect(res.body.data).toEqual({})
  })

  test('POST /concepts missing name → 400 "name is required"', async () => {
    const res = await request(app).post(api('/concepts')).set(adminHeaders()).send({ type: 'style' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('name is required')
  })

  test('POST /concepts invalid type → 400 listing valid types', async () => {
    const res = await request(app).post(api('/concepts')).set(adminHeaders()).send({ name: 'X', type: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('type must be one of: character, style, ruleset, library, brand, custom')
  })

  test('GET /concepts lists with parsed data + projects[] attached; ?type= filters', async () => {
    await request(app).post(api('/concepts')).set(adminHeaders()).send({ name: 'noir palette', type: 'style' })

    const all = await request(app).get(api('/concepts')).set(agentHeaders())
    expect(all.status).toBe(200)
    const kira = all.body.find(c => c.id === conceptId)
    expect(kira).toBeTruthy()
    expect(kira.data).toEqual({ hp: 10, traits: ['sharp'] })
    expect(Array.isArray(kira.projects)).toBe(true)

    const chars = await request(app).get(api('/concepts?type=character')).set(agentHeaders())
    expect(chars.status).toBe(200)
    expect(chars.body.length).toBeGreaterThan(0)
    expect(chars.body.every(c => c.type === 'character')).toBe(true)
    expect(chars.body.find(c => c.name === 'noir palette')).toBeFalsy()
  })

  test('GET /concepts/:id unknown numeric → 404; non-numeric id → 404 (parseIntParam → null)', async () => {
    const missing = await request(app).get(api('/concepts/999999')).set(adminHeaders())
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe('Concept not found')

    const nonNumeric = await request(app).get(api('/concepts/abc')).set(adminHeaders())
    expect(nonNumeric.status).toBe(404)
    expect(nonNumeric.body.error).toBe('Concept not found')
  })

  test('PUT /concepts/:id updates fields, bumps version, round-trips data', async () => {
    const res = await request(app)
      .put(api('/concepts/' + conceptId))
      .set(actingAs('tester'))
      .send({ description: 'squad HEAD + orchestrator', data: { hp: 12 } })
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(2) // extraSets bump
    expect(res.body.description).toBe('squad HEAD + orchestrator')
    expect(res.body.data).toEqual({ hp: 12 })
    expect(Array.isArray(res.body.projects)).toBe(true)
  })

  test('LATENT BUG (locked) B4: PUT /concepts/:id does NOT validate type — any string accepted', async () => {
    // POST rejects type 'bogus' with 400 (asserted above); PUT stores it.
    const res = await request(app)
      .put(api('/concepts/' + conceptId))
      .set(adminHeaders())
      .send({ type: 'totally-not-a-valid-type' })
    expect(res.status).toBe(200)
    expect(res.body.type).toBe('totally-not-a-valid-type')
    expect(res.body.version).toBe(3)
    // restore for later tests
    await request(app).put(api('/concepts/' + conceptId)).set(adminHeaders()).send({ type: 'character' })
  })

  test('PUT /concepts/:id with no updatable fields → 200, version unchanged (silent no-op)', async () => {
    const before = await request(app).get(api('/concepts/' + conceptId)).set(adminHeaders())
    const res = await request(app)
      .put(api('/concepts/' + conceptId))
      .set(adminHeaders())
      .send({ unknown_field: 1 })
    expect(res.status).toBe(200)
    expect(res.body.version).toBe(before.body.version) // buildUpdate no-op, no bump
  })

  test('PUT /concepts/:id unknown → 404', async () => {
    const res = await request(app).put(api('/concepts/999999')).set(adminHeaders()).send({ name: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Concept not found')
  })
})

describe('concepts: project links', () => {
  let cid

  beforeAll(async () => {
    const c = await request(app)
      .post(api('/concepts'))
      .set(actingAs('linker'))
      .send({ name: 'link-me', type: 'ruleset', data: { rule: 1 } })
    cid = c.body.id
    await request(app).post(api('/projects')).set(adminHeaders()).send({ id: 'proj-linked', name: 'Linked Proj' })
  })

  test('POST /concepts/:id/link → { ok, concept_id, project }; both sides see the link', async () => {
    const res = await request(app)
      .post(api('/concepts/' + cid + '/link'))
      .set(actingAs('linker'))
      .send({ project_id: 'proj-linked' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, concept_id: cid, project: 'proj-linked' })

    // concept side: projects[] carries project row + linked_at/linked_by
    const concept = await request(app).get(api('/concepts/' + cid)).set(adminHeaders())
    const proj = concept.body.projects.find(p => p.id === 'proj-linked')
    expect(proj).toBeTruthy()
    expect(proj.linked_by).toBe('linker')
    expect(proj.linked_at).toBeTruthy()

    // project side: GET /projects/:projectId/concepts with parsed data + link metadata
    const list = await request(app).get(api('/projects/proj-linked/concepts')).set(agentHeaders())
    expect(list.status).toBe(200)
    const linked = list.body.find(c => c.id === cid)
    expect(linked).toBeTruthy()
    expect(linked.data).toEqual({ rule: 1 })
    expect(linked.linked_by).toBe('linker')
  })

  test('link: missing project_id → 400; unknown concept → 404', async () => {
    const noProj = await request(app).post(api('/concepts/' + cid + '/link')).set(adminHeaders()).send({})
    expect(noProj.status).toBe(400)
    expect(noProj.body.error).toBe('project_id is required')

    const noConcept = await request(app)
      .post(api('/concepts/999999/link'))
      .set(adminHeaders())
      .send({ project_id: 'proj-linked' })
    expect(noConcept.status).toBe(404)
    expect(noConcept.body.error).toBe('Concept not found')
  })

  test('LATENT BUG (locked) B5: linking to a NONEXISTENT project succeeds → asymmetric orphan link', async () => {
    // No project-existence check in the handler and no FK on
    // project_concepts.project_id. The orphan row is then visible from the
    // project side (JOIN on concepts only) but INVISIBLE from the concept
    // side (JOIN on projects drops it).
    const res = await request(app)
      .post(api('/concepts/' + cid + '/link'))
      .set(adminHeaders())
      .send({ project_id: 'ghost-project' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    const fromProject = await request(app).get(api('/projects/ghost-project/concepts')).set(adminHeaders())
    expect(fromProject.body.find(c => c.id === cid)).toBeTruthy() // ghost project "has" the concept

    const fromConcept = await request(app).get(api('/concepts/' + cid)).set(adminHeaders())
    expect(fromConcept.body.projects.find(p => p.id === 'ghost-project')).toBeFalsy() // but concept doesn't list it
  })

  test('duplicate link → 200 (INSERT OR IGNORE); unlink → { ok }; unlink of nonexistent link also → { ok }', async () => {
    const dup = await request(app)
      .post(api('/concepts/' + cid + '/link'))
      .set(adminHeaders())
      .send({ project_id: 'proj-linked' })
    expect(dup.status).toBe(200)
    // still exactly one link row on the project side
    const list = await request(app).get(api('/projects/proj-linked/concepts')).set(adminHeaders())
    expect(list.body.filter(c => c.id === cid).length).toBe(1)

    const unlink = await request(app).delete(api('/concepts/' + cid + '/link/proj-linked')).set(adminHeaders())
    expect(unlink.status).toBe(200)
    expect(unlink.body).toEqual({ ok: true })
    const after = await request(app).get(api('/projects/proj-linked/concepts')).set(adminHeaders())
    expect(after.body.find(c => c.id === cid)).toBeFalsy()

    // No existence check: unlinking a link that isn't there is still ok:true
    const again = await request(app).delete(api('/concepts/' + cid + '/link/proj-linked')).set(adminHeaders())
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ ok: true })
  })

  test('GET /projects/:projectId/concepts for a project with no links → []', async () => {
    const res = await request(app).get(api('/projects/cps-proj-a/concepts')).set(agentHeaders())
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

describe('concepts: delete + approval gate', () => {
  async function makeConcept(name) {
    const c = await request(app).post(api('/concepts')).set(adminHeaders()).send({ name })
    return c.body.id
  }

  test('DELETE /concepts/:id as admin → { ok: true }, concept gone (admin bypasses the gate)', async () => {
    const id = await makeConcept('doomed-by-admin')
    const res = await request(app).delete(api('/concepts/' + id)).set(adminHeaders())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true }) // no approval_warning for admin
    const gone = await request(app).get(api('/concepts/' + id)).set(adminHeaders())
    expect(gone.status).toBe(404)
  })

  test('DELETE as AGENT without approval_id → SOFT gate: deletes anyway, returns approval_warning', async () => {
    // checkApprovalGate returns { ok:false, soft:true, warning } for agents
    // with no approval_id — the handler proceeds with the delete and attaches
    // the warning. Deletion is NOT blocked (soft enforcement, locked).
    const id = await makeConcept('doomed-by-agent')
    const res = await request(app).delete(api('/concepts/' + id)).set(agentHeaders())
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.approval_warning).toMatch(/approval/i)
    const gone = await request(app).get(api('/concepts/' + id)).set(adminHeaders())
    expect(gone.status).toBe(404) // it really was deleted
  })

  test('DELETE as AGENT with a bogus approval_id → 403 hard block, concept survives', async () => {
    // Presenting an approval_id engages HARD enforcement: an approval that
    // doesn't exist / isn't approved / wrong action / wrong owner → 403.
    const id = await makeConcept('survives-bad-approval')
    const res = await request(app)
      .delete(api('/concepts/' + id + '?approval_id=999999'))
      .set(agentHeaders())
    expect(res.status).toBe(403)
    expect(res.body.approval_required).toBe(true)
    expect(res.body.error).toBe('Approval #999999 not found')
    const alive = await request(app).get(api('/concepts/' + id)).set(adminHeaders())
    expect(alive.status).toBe(200)
  })

  test('DELETE unknown concept → 404', async () => {
    const res = await request(app).delete(api('/concepts/999999')).set(adminHeaders())
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Concept not found')
  })
})

// ======================= SKILLS =======================

describe('skills: registry CRUD', () => {
  test('POST /skills (admin) → 201 { id }; GET shows schema defaults with UNPARSED JSON-string fields', async () => {
    const create = await request(app)
      .post(api('/skills'))
      .set(adminHeaders())
      .send({ id: 'skill-defaults', name: 'Defaults Probe' })
    expect(create.status).toBe(201) // contrast: POST /concepts and POST /projects return 200
    expect(create.body).toEqual({ id: 'skill-defaults' })

    const res = await request(app).get(api('/skills/skill-defaults')).set(agentHeaders())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'skill-defaults',
      name: 'Defaults Probe',
      description: '',
      category: 'general',
      version: '1.0.0',
      author: '',
      install_type: 'concept',
      status: 'published',
      install_count: 0
    })
    // NOTE (locked): unlike concepts, skill JSON columns are returned as raw
    // STRINGS — clients must JSON.parse install_data/required_capabilities/tags.
    expect(res.body.install_data).toBe('{}')
    expect(res.body.required_capabilities).toBe('[]')
    expect(res.body.tags).toBe('[]')
  })

  test('POST /skills stringifies object fields on write (still returned as strings)', async () => {
    await request(app)
      .post(api('/skills'))
      .set(adminHeaders())
      .send({
        id: 'skill-objects', name: 'Objects Probe',
        install_data: { steps: [1, 2] }, required_capabilities: ['code'], tags: ['zzweld', 'metalwork']
      })
    const res = await request(app).get(api('/skills/skill-objects')).set(adminHeaders())
    expect(JSON.parse(res.body.install_data)).toEqual({ steps: [1, 2] })
    expect(JSON.parse(res.body.required_capabilities)).toEqual(['code'])
    expect(JSON.parse(res.body.tags)).toEqual(['zzweld', 'metalwork'])
  })

  test('POST /skills missing id/name → 400; duplicate id → 409 "skill already exists"', async () => {
    const missing = await request(app).post(api('/skills')).set(adminHeaders()).send({ name: 'No Id' })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('id and name required')

    const dup = await request(app)
      .post(api('/skills'))
      .set(adminHeaders())
      .send({ id: 'skill-defaults', name: 'Dup' })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('skill already exists')
  })

  test('GET /skills/:id unknown → 404 "skill not found"', async () => {
    const res = await request(app).get(api('/skills/no-such-skill')).set(agentHeaders())
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('skill not found')
  })

  test('GET /skills ?category= and ?search= filters (search hits name OR description OR tags)', async () => {
    await request(app).post(api('/skills')).set(adminHeaders())
      .send({ id: 'skill-cat-a', name: 'Cat A', category: 'zz-cat' })

    const byCat = await request(app).get(api('/skills?category=zz-cat')).set(agentHeaders())
    expect(byCat.status).toBe(200)
    expect(byCat.body.length).toBe(1)
    expect(byCat.body[0].id).toBe('skill-cat-a')

    // search matches tags LIKE (skill-objects has tag 'zzweld')
    const byTag = await request(app).get(api('/skills?search=zzweld')).set(agentHeaders())
    expect(byTag.body.map(s => s.id)).toEqual(['skill-objects'])

    // search matches name LIKE
    const byName = await request(app).get(api('/skills?search=Objects Pro')).set(agentHeaders())
    expect(byName.body.map(s => s.id)).toContain('skill-objects')

    const noHit = await request(app).get(api('/skills?search=zz-no-match-token')).set(agentHeaders())
    expect(noHit.body).toEqual([])
  })

  test('PUT /skills/:id (admin) updates allow-listed fields; non-allowlisted fields silently ignored', async () => {
    const res = await request(app)
      .put(api('/skills/skill-defaults'))
      .set(adminHeaders())
      .send({ description: 'now described', id: 'evil-rename', install_count: 99, author: 'nope' })
    expect(res.status).toBe(200)
    expect(res.body.description).toBe('now described')
    expect(res.body.id).toBe('skill-defaults')  // id not renameable
    expect(res.body.install_count).toBe(0)      // install_count not writable via PUT
    expect(res.body.author).toBe('')            // author NOT in the update allow-list
  })

  test('LATENT BUG (locked) B6: PUT /skills/:id with NO allow-listed fields → 404 even though the skill exists', async () => {
    // updateSkill returns null when buildUpdate finds nothing to change; the
    // handler maps null → 404 "skill not found". An empty-body update on an
    // EXISTING skill therefore reports the skill missing.
    const empty = await request(app).put(api('/skills/skill-defaults')).set(adminHeaders()).send({})
    expect(empty.status).toBe(404)
    expect(empty.body.error).toBe('skill not found')

    const onlyIgnored = await request(app).put(api('/skills/skill-defaults')).set(adminHeaders()).send({ author: 'x' })
    expect(onlyIgnored.status).toBe(404)

    // ...but the skill is demonstrably still there:
    const alive = await request(app).get(api('/skills/skill-defaults')).set(agentHeaders())
    expect(alive.status).toBe(200)
  })

  test('PUT /skills/:id unknown id → 404', async () => {
    const res = await request(app).put(api('/skills/no-such-skill')).set(adminHeaders()).send({ description: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('skill not found')
  })

  test('status → draft hides the skill from GET /skills but NOT from GET /skills/:id', async () => {
    await request(app).post(api('/skills')).set(adminHeaders()).send({ id: 'skill-draft', name: 'Draft Probe' })
    await request(app).put(api('/skills/skill-draft')).set(adminHeaders()).send({ status: 'draft' })

    const list = await request(app).get(api('/skills')).set(agentHeaders())
    expect(list.body.find(s => s.id === 'skill-draft')).toBeFalsy() // listSkills: status='published' only

    const byId = await request(app).get(api('/skills/skill-draft')).set(agentHeaders())
    expect(byId.status).toBe(200) // getSkill has no status filter
    expect(byId.body.status).toBe('draft')
  })
})

describe('skills: install / uninstall on agents', () => {
  beforeAll(async () => {
    await request(app).post(api('/skills')).set(adminHeaders()).send({ id: 'skill-inst', name: 'Installable' })
  })

  test('install as AGENT: installs on SELF; body agent_id is silently IGNORED', async () => {
    const res = await request(app)
      .post(api('/skills/skill-inst/install'))
      .set(agentHeaders())
      .send({ agent_id: 'someone-else', config: { level: 3 } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, skill_id: 'skill-inst', agent_id: AGENT_ID }) // NOT someone-else

    const mine = await request(app).get(api('/agents/' + AGENT_ID + '/skills')).set(agentHeaders())
    const entry = mine.body.find(s => s.id === 'skill-inst')
    expect(entry).toBeTruthy()
    expect(entry.installed_at).toBeTruthy()
    expect(JSON.parse(entry.config)).toEqual({ level: 3 }) // config returned as string

    const theirs = await request(app).get(api('/agents/someone-else/skills')).set(adminHeaders())
    expect(theirs.body).toEqual([]) // body agent_id had no effect
  })

  test('install as admin with body agent_id → installs on that agent (even a NONEXISTENT one — no agent validation)', async () => {
    // agent_skills has no FK on agent_id and the handler never checks the
    // agent exists: installing onto a ghost agent id succeeds.
    const res = await request(app)
      .post(api('/skills/skill-inst/install'))
      .set(adminHeaders())
      .send({ agent_id: 'ghost-agent-42' })
    expect(res.status).toBe(200)
    expect(res.body.agent_id).toBe('ghost-agent-42')

    const list = await request(app).get(api('/agents/ghost-agent-42/skills')).set(adminHeaders())
    expect(list.body.map(s => s.id)).toEqual(['skill-inst'])
  })

  test('LATENT BUG (locked) B7: admin key with NO agent_id installs on the literal agent "__system__"', async () => {
    const res = await request(app)
      .post(api('/skills/skill-inst/install'))
      .set(adminHeaders())
      .send({})
    expect(res.status).toBe(200)
    expect(res.body.agent_id).toBe('__system__') // sentinel leaks into agent_skills as a real row

    const list = await request(app).get(api('/agents/__system__/skills')).set(adminHeaders())
    expect(list.body.map(s => s.id)).toContain('skill-inst')
  })

  test('LATENT BUG (locked) B7: admin key + X-Acting-As IGNORES body agent_id, installs on the acting-as name', async () => {
    // who = 'acting-admin' (not a sentinel) → the handler treats the admin
    // like an agent and installs on 'acting-admin'; body agent_id 'real-target'
    // is silently dropped. Admin attribution breaks delegated installs.
    const res = await request(app)
      .post(api('/skills/skill-inst/install'))
      .set(actingAs('acting-admin'))
      .send({ agent_id: 'real-target' })
    expect(res.status).toBe(200)
    expect(res.body.agent_id).toBe('acting-admin') // NOT real-target

    const target = await request(app).get(api('/agents/real-target/skills')).set(adminHeaders())
    expect(target.body).toEqual([])
  })

  test('install unknown skill → 404 "skill not found"', async () => {
    const res = await request(app)
      .post(api('/skills/no-such-skill/install'))
      .set(adminHeaders())
      .send({ agent_id: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('skill not found')
  })

  test('LATENT BUG (locked) B8: reinstall double-increments install_count while the agent still has ONE entry', async () => {
    await request(app).post(api('/skills')).set(adminHeaders()).send({ id: 'skill-count', name: 'Counter' })

    await request(app).post(api('/skills/skill-count/install')).set(adminHeaders()).send({ agent_id: 'count-agent' })
    await request(app).post(api('/skills/skill-count/install')).set(adminHeaders()).send({ agent_id: 'count-agent' })

    const skill = await request(app).get(api('/skills/skill-count')).set(adminHeaders())
    expect(skill.body.install_count).toBe(2) // INSERT OR REPLACE + unconditional increment

    const list = await request(app).get(api('/agents/count-agent/skills')).set(adminHeaders())
    expect(list.body.filter(s => s.id === 'skill-count').length).toBe(1)
  })

  test('LATENT BUG (locked) B8+B9: uninstall removes the row but never decrements install_count; unknown skill → still ok', async () => {
    await request(app).post(api('/skills')).set(adminHeaders()).send({ id: 'skill-uninst', name: 'Uninstallable' })
    await request(app).post(api('/skills/skill-uninst/install')).set(adminHeaders()).send({ agent_id: 'uninst-agent' })

    const un = await request(app)
      .post(api('/skills/skill-uninst/uninstall'))
      .set(adminHeaders())
      .send({ agent_id: 'uninst-agent' })
    expect(un.status).toBe(200)
    expect(un.body).toEqual({ ok: true })

    const list = await request(app).get(api('/agents/uninst-agent/skills')).set(adminHeaders())
    expect(list.body).toEqual([])

    const skill = await request(app).get(api('/skills/skill-uninst')).set(adminHeaders())
    expect(skill.body.install_count).toBe(1) // never decremented

    // uninstall again → still ok (idempotent, no signal)
    const again = await request(app)
      .post(api('/skills/skill-uninst/uninstall'))
      .set(adminHeaders())
      .send({ agent_id: 'uninst-agent' })
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ ok: true })

    // uninstall a skill id that DOESN'T EXIST → 200 ok (no 404 — no existence check)
    const ghost = await request(app)
      .post(api('/skills/no-such-skill/uninstall'))
      .set(adminHeaders())
      .send({ agent_id: 'uninst-agent' })
    expect(ghost.status).toBe(200)
    expect(ghost.body).toEqual({ ok: true })
  })

  test('uninstall as AGENT ignores body agent_id (uninstalls from SELF)', async () => {
    // Mirror of the install path: agent identity wins over body.agent_id.
    await request(app).post(api('/skills')).set(adminHeaders()).send({ id: 'skill-self-un', name: 'Self Uninstall' })
    await request(app).post(api('/skills/skill-self-un/install')).set(adminHeaders()).send({ agent_id: 'other-agent-7' })
    await request(app).post(api('/skills/skill-self-un/install')).set(agentHeaders()).send({})

    const res = await request(app)
      .post(api('/skills/skill-self-un/uninstall'))
      .set(agentHeaders())
      .send({ agent_id: 'other-agent-7' }) // attempt to uninstall from someone else
    expect(res.status).toBe(200)

    const mine = await request(app).get(api('/agents/' + AGENT_ID + '/skills')).set(agentHeaders())
    expect(mine.body.find(s => s.id === 'skill-self-un')).toBeFalsy() // removed from SELF

    const theirs = await request(app).get(api('/agents/other-agent-7/skills')).set(adminHeaders())
    expect(theirs.body.find(s => s.id === 'skill-self-un')).toBeTruthy() // other agent untouched
  })

  test('GET /agents/:agentId/skills for an agent with no installs (or nonexistent agent) → []', async () => {
    const res = await request(app).get(api('/agents/never-installed-anything/skills')).set(agentHeaders())
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })
})

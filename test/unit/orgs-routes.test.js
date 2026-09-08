// Behavior gate for the organizations HTTP contract (brief 140).
//
// WHY THIS EXISTS: brief 138 (teams.js) explicitly deferred orgs.js — "orgs.js
// and team_settings.js are SEPARATE modules with their own surfaces — OUT of
// scope; note them as follow-up candidates." This is that follow-up. Survey #15
// (2026-08-26, on master 2d4b9a3) found orgs.js among the seven mounted route
// modules invisible from every public surface: 5 mounted routes (GET /orgs,
// POST /orgs, GET /orgs/:id, PUT /orgs/:id, DELETE /orgs/:id), zero test
// files, zero README/docs mentions, zero mycelium_* MCP tools. A regression
// that flipped an auth check or broke the delete contract shipped undetected.
//
// WHAT STEP 0 DERIVED (from module source, then verified live):
//   - orgs.js (server/routes/orgs.js) registers 5 routes. GET /orgs and
//     GET /orgs/:id are checkAgentOrAdmin (agent-readable); POST/PUT/DELETE
//     are checkAdmin. All 5 live on the mycelium router via
//     registerOrgRoutes(router, {...}) (mycelium.js), so mounting that router
//     wires them exactly as production does.
//   - orgs table is `organizations` (schema.sql) — id, name, description,
//     owner_id, status DEFAULT 'active', created_at. There is NO `plan`
//     column (see the FINDING PIN below).
//   - The org→project relation is projects.org_id (schema.sql), written via
//     POST /projects {org_id}. GET /orgs/:id embeds it: org.projects =
//     listProjects(orgId) (orgs.js).
//   - deleteOrg (server/db/projects.js) is a BARE single-table DELETE FROM
//     organizations — no cascade, no block, no reassign. `foreign_keys = ON`
//     is set (server/db/core.js), but projects.org_id declares NO REFERENCES,
//     so the orphan below is structural, not a pragma accident.
//
// Harness mirrors test/unit/spend-routes-behavior.test.js: real router via
// supertest, fresh temp DATA_DIR + ADMIN_KEY set BEFORE the dynamic import so
// db.js picks them up at module-eval, one real agent (SHA-256 key hash) for
// the agent-readable rows, and X-Acting-As to pin the owner_id/audit path.
//
// "TRACKS REALITY" GUARDS: the updateOrg field whitelist and the deleteOrg
// statement shape are READ FROM server/db/projects.js rather than re-typed;
// the source-pin describe reds if they drift, coupling this gate to the
// exact lines that make the behavioral pins below true.
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// --- source-pinned contract values (read, not re-typed) ---
const DB_PROJECTS_SRC = readFileSync(
  fileURLToPath(new URL('../../server/db/projects.js', import.meta.url)),
  'utf8'
)
const ORGS_ROUTE_SRC = readFileSync(
  fileURLToPath(new URL('../../server/routes/orgs.js', import.meta.url)),
  'utf8'
)
// updateOrg's allowed-column whitelist (server/db/projects.js, updateOrg):
const WHITELIST_MATCH = DB_PROJECTS_SRC.match(
  /buildUpdate\('organizations', id, fields, \[([^\]]*)\]/
)
const UPDATE_WHITELIST = WHITELIST_MATCH
  ? WHITELIST_MATCH[1].split(',').map((s) => s.trim().replace(/['"]/g, ''))
  : []
// deleteOrg's statement (server/db/projects.js, deleteOrg):
const DELETE_ORG_BLOCK = DB_PROJECTS_SRC.match(
  /export function deleteOrg[\s\S]*?\n}/
)

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const KEYA = 'dvk_' + 'a'.repeat(48) // a real, non-admin agent key
const AGENTA = 'orgs-agentA'
const ACTING_AS = 'lane-140' // getAdminDisplayName falls back to X-Acting-As

const ADMIN = { 'X-Admin-Key': ADMIN_KEY, 'X-Acting-As': ACTING_AS }

let tmpDataDir
let app
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-orgs-behavior-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // One real agent (default role 'agent', NOT admin) whose key we hold.
  const hashA = crypto.createHash('sha256').update(KEYA).digest('hex')
  db.createAgent(AGENTA, 'Orgs Agent A', 'orgs-proj', hashA, '["code"]')
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// ===========================================================================
describe('contract — POST /orgs creates; GET reads back; GET /orgs/:id embeds projects', () => {
  test('POST /orgs creates the org and returns the raw row (no projects key)', async () => {
    const res = await request(app)
      .post('/api/mycelium/orgs')
      .set(ADMIN)
      .send({ id: 'org-alpha', name: 'Alpha Org', description: 'first org' })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('org-alpha')
    expect(res.body.name).toBe('Alpha Org')
    expect(res.body.description).toBe('first org')
    // owner_id is the admin display name — X-Acting-As path (getAdminDisplayName).
    expect(res.body.owner_id).toBe(ACTING_AS)
    expect(res.body.status).toBe('active')
    expect(typeof res.body.created_at).toBe('string')
    // Only GET /orgs/:id embeds projects; the create response does not.
    expect(res.body.projects).toBeUndefined()
  })

  test('POST /orgs without id or name -> 400 "id and name required"', async () => {
    const noName = await request(app).post('/api/mycelium/orgs').set(ADMIN).send({ id: 'x1' })
    expect(noName.status).toBe(400)
    expect(noName.body.error).toBe('id and name required')
    const noId = await request(app).post('/api/mycelium/orgs').set(ADMIN).send({ name: 'x' })
    expect(noId.status).toBe(400)
  })

  test('GET /orgs lists orgs — readable with a plain agent key', async () => {
    const res = await request(app).get('/api/mycelium/orgs').set('X-Agent-Key', KEYA)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.some((o) => o.id === 'org-alpha')).toBe(true)
  })

  test('GET /orgs/:id returns projects: [] before any project is linked', async () => {
    const res = await request(app)
      .get('/api/mycelium/orgs/org-alpha')
      .set('X-Agent-Key', KEYA)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('org-alpha')
    expect(res.body.projects).toEqual([])
  })

  test('the org→project relation: POST /projects {org_id}, then GET /orgs/:id embeds it', async () => {
    const created = await request(app)
      .post('/api/mycelium/projects')
      .set(ADMIN)
      .send({ id: 'proj-in-alpha', name: 'Project In Alpha', org_id: 'org-alpha' })
    expect(created.status).toBe(200)
    expect(created.body.org_id).toBe('org-alpha')

    const res = await request(app)
      .get('/api/mycelium/orgs/org-alpha')
      .set('X-Agent-Key', KEYA)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.projects)).toBe(true)
    const embedded = res.body.projects.find((p) => p.id === 'proj-in-alpha')
    expect(embedded).toBeTruthy()
    expect(embedded.name).toBe('Project In Alpha')
    expect(embedded.org_id).toBe('org-alpha')
  })

  test('GET /orgs/:id for a missing org -> 404 "Organization not found"', async () => {
    const res = await request(app)
      .get('/api/mycelium/orgs/never-was')
      .set('X-Agent-Key', KEYA)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Organization not found')
  })
})

describe('contract — PUT /orgs/:id updates through a field whitelist', () => {
  test('whitelisted fields update; unknown fields are silently ignored', async () => {
    const res = await request(app)
      .put('/api/mycelium/orgs/org-alpha')
      .set(ADMIN)
      .send({ description: 'updated desc', status: 'archived', bogus_field: 'nope' })
    expect(res.status).toBe(200)
    expect(res.body.description).toBe('updated desc')
    expect(res.body.status).toBe('archived')
    expect(res.body.name).toBe('Alpha Org') // omitted fields untouched
    expect(res.body.bogus_field).toBeUndefined() // whitelist rejected it
  })

  test('PUT with ONLY unknown fields is a silent no-op: 200, row unchanged', async () => {
    // buildUpdate returns false when no whitelisted column is present, so no
    // UPDATE runs — the handler still answers 200 with the unchanged row.
    const res = await request(app)
      .put('/api/mycelium/orgs/org-alpha')
      .set(ADMIN)
      .send({ bogus_field: 'still nope' })
    expect(res.status).toBe(200)
    expect(res.body.description).toBe('updated desc')
    expect(res.body.bogus_field).toBeUndefined()
  })

  test('PUT /orgs/:id for a missing org -> 404', async () => {
    const res = await request(app)
      .put('/api/mycelium/orgs/never-was')
      .set(ADMIN)
      .send({ description: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Organization not found')
  })

  test('POST /orgs with an EXISTING id is accepted (INSERT OR IGNORE) and returns the ORIGINAL row', async () => {
    // No 409/409-style conflict path exists: createOrg uses INSERT OR IGNORE,
    // so the second POST is a silent no-op and the handler echoes the row
    // already stored. PINNED as current behavior.
    const res = await request(app)
      .post('/api/mycelium/orgs')
      .set(ADMIN)
      .send({ id: 'org-alpha', name: 'DIFFERENT NAME', description: 'DIFFERENT' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Alpha Org')
    expect(res.body.description).toBe('updated desc')

    const got = await request(app)
      .get('/api/mycelium/orgs/org-alpha')
      .set('X-Agent-Key', KEYA)
    expect(got.body.name).toBe('Alpha Org')
  })
})

// ===========================================================================
// RELATION PIN — DELETE /orgs/:id ORPHANS the org's projects (OPEN for Gilbert).
// ===========================================================================
// WHAT THE CODE DOES: deleteOrg (server/db/projects.js) is a bare
// `DELETE FROM organizations WHERE id = ?` — no cascade, no block, no
// reassignment of projects.org_id. foreign_keys = ON (server/db/core.js)
// does NOT save you: projects.org_id declares no REFERENCES clause, so
// SQLite has nothing to enforce. Verified live: the project row survives the
// org delete still pointing at the dead org id.
//
// WHAT THIS TEST DOES: pins the orphan (project survives, org_id goes stale).
// If someone adds a cascade (projects deleted with the org) or a guard
// (delete blocked while projects exist), this test REDS — correctly flagging
// that the relation semantics changed so the pin and the docs move together.
//
// WHAT IT DOES NOT DECIDE: whether orphan is the right policy. Blocking (the
// teams.js pattern — deleteTeam throws 'Team has members — remove them
// first') is the house precedent for parent deletes, which makes the silent
// orphan here look unreviewed rather than chosen. OPEN for Gilbert.
// ===========================================================================
describe('RELATION PIN — DELETE /orgs/:id orphans its projects (OPEN for Gilbert)', () => {
  test('org delete leaves its projects in place with a stale org_id', async () => {
    // org-doom has two projects; org-keeper has one (control).
    await request(app).post('/api/mycelium/orgs').set(ADMIN)
      .send({ id: 'org-doom', name: 'Doomed Org' })
    await request(app).post('/api/mycelium/orgs').set(ADMIN)
      .send({ id: 'org-keeper', name: 'Keeper Org' })
    for (const p of [['p-doom-1', 'Doom Project 1'], ['p-doom-2', 'Doom Project 2']]) {
      const r = await request(app).post('/api/mycelium/projects').set(ADMIN)
        .send({ id: p[0], name: p[1], org_id: 'org-doom' })
      expect(r.status).toBe(200)
    }
    const control = await request(app).post('/api/mycelium/projects').set(ADMIN)
      .send({ id: 'p-keep-1', name: 'Keeper Project', org_id: 'org-keeper' })
    expect(control.status).toBe(200)

    // Pre-delete sanity: the org embeds both projects.
    const before = await request(app)
      .get('/api/mycelium/orgs/org-doom')
      .set('X-Agent-Key', KEYA)
    expect(before.body.projects).toHaveLength(2)

    const del = await request(app).delete('/api/mycelium/orgs/org-doom').set(ADMIN)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })

    // The org is gone from both surfaces.
    const gone = await request(app)
      .get('/api/mycelium/orgs/org-doom')
      .set('X-Agent-Key', KEYA)
    expect(gone.status).toBe(404)
    const list = await request(app).get('/api/mycelium/orgs').set('X-Agent-Key', KEYA)
    expect(list.body.some((o) => o.id === 'org-doom')).toBe(false)

    // THE PIN: its projects SURVIVE, still carrying the dead org_id.
    for (const pid of ['p-doom-1', 'p-doom-2']) {
      const orphan = await request(app)
        .get('/api/mycelium/projects/' + pid)
        .set('X-Agent-Key', KEYA)
      expect(orphan.status).toBe(200)
      expect(orphan.body.org_id).toBe('org-doom') // stale reference, not nulled
    }
    // And the control org is untouched.
    const keeper = await request(app)
      .get('/api/mycelium/orgs/org-keeper')
      .set('X-Agent-Key', KEYA)
    expect(keeper.status).toBe(200)
    expect(keeper.body.projects).toHaveLength(1)
  })
})

// ===========================================================================
// FINDING PIN — PUT /orgs/:id {plan} 500s (whitelist vs schema drift; OPEN).
// ===========================================================================
// updateOrg's whitelist (server/db/projects.js) is
// ['name', 'description', 'plan', 'status'] — but the organizations table
// (schema.sql) has NO `plan` column. PUTting plan therefore builds
// "UPDATE organizations SET plan = ?" and SQLite throws -> 500.
// Verified live on this branch (empty-body 500). A documented-by-whitelist
// field that 500s is a latent defect: OPEN for Gilbert (drop `plan` from the
// whitelist or add the column). If either fix lands, this pin REDS — that is
// the gate doing its job: the behavior change becomes loud, and this test is
// updated to pin the new, deliberate contract.
// ===========================================================================
describe('FINDING PIN — PUT {plan} is a 500 (whitelist names a column the table lacks)', () => {
  test('PUT /orgs/:id {plan} -> 500 today', async () => {
    expect(UPDATE_WHITELIST).toContain('plan') // the whitelist still offers it
    const res = await request(app)
      .put('/api/mycelium/orgs/org-alpha')
      .set(ADMIN)
      .send({ plan: 'pro' })
    expect(res.status).toBe(500)
    // And the failed write changed nothing else.
    const after = await request(app)
      .get('/api/mycelium/orgs/org-alpha')
      .set('X-Agent-Key', KEYA)
    expect(after.body.plan).toBeUndefined()
  })
})

// ===========================================================================
describe('auth row — GETs are agent-readable, writes are admin-only', () => {
  test('GET /orgs with no credentials -> 401 "Missing X-Agent-Key header"', async () => {
    const res = await request(app).get('/api/mycelium/orgs')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing X-Agent-Key header')
  })

  test('GET /orgs with a WRONG agent key -> 403 "Invalid agent key"', async () => {
    const res = await request(app)
      .get('/api/mycelium/orgs')
      .set('X-Agent-Key', 'dvk_not_a_real_key')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Invalid agent key')
  })

  test('GET /orgs/:id is agent-readable (checkAgentOrAdmin, per-route proof)', async () => {
    const res = await request(app)
      .get('/api/mycelium/orgs/org-alpha')
      .set('X-Agent-Key', KEYA)
    expect(res.status).toBe(200)
  })

  // checkAdmin never consults X-Agent-Key: with ONLY an agent key and no
  // Authorization header, the guard hits its "Authentication required" 401
  // branch. An authenticated agent does NOT outrank an anonymous one here —
  // both are rejected; the agent just gets the 401 shape.
  test('writes reject a bare agent key with 401 "Authentication required"', async () => {
    for (const [verb, path, body] of [
      ['post', '/api/mycelium/orgs', { id: 'nope-org', name: 'Nope' }],
      ['put', '/api/mycelium/orgs/org-alpha', { description: 'nope' }],
      ['delete', '/api/mycelium/orgs/org-alpha', {}],
    ]) {
      const res = await request(app)[verb](path).set('X-Agent-Key', KEYA).send(body)
      expect(res.status).toBe(401)
      expect(res.body.error).toBe('Authentication required')
    }
  })

  test('writes reject a WRONG admin key with 403 "Invalid admin key"', async () => {
    for (const [verb, path, body] of [
      ['post', '/api/mycelium/orgs', { id: 'nope-org', name: 'Nope' }],
      ['put', '/api/mycelium/orgs/org-alpha', { description: 'nope' }],
      ['delete', '/api/mycelium/orgs/org-alpha', {}],
    ]) {
      const res = await request(app)[verb](path)
        .set('X-Admin-Key', 'wrong-admin-key')
        .send(body)
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Invalid admin key')
    }
  })

  test('the agent in this file really is non-admin (its key never opens writes)', async () => {
    // Sanity on the harness itself: KEYA resolves to a real agent row, so the
    // 401s above mean "agent key present but admin not satisfied", not "key
    // never existed".
    expect(db.getAgent(AGENTA)).toBeTruthy()
  })
})

// ===========================================================================
describe('source pins (tracks reality — reds if the literals drift)', () => {
  test('updateOrg whitelist is read from source and is name/description/plan/status', () => {
    expect(WHITELIST_MATCH).toBeTruthy()
    expect(UPDATE_WHITELIST).toEqual(['name', 'description', 'plan', 'status'])
  })

  test('deleteOrg is a single-table DELETE — no projects statement in its block', () => {
    expect(DELETE_ORG_BLOCK).toBeTruthy()
    expect(DELETE_ORG_BLOCK[0]).toContain('DELETE FROM organizations')
    expect(DELETE_ORG_BLOCK[0]).not.toContain('DELETE FROM projects')
  })

  test('orgs.js guards: 2x checkAgentOrAdmin (the GETs), 3x checkAdmin (the writes)', () => {
    const agentOrAdmin = ORGS_ROUTE_SRC.match(/checkAgentOrAdmin\(/g) || []
    const admin = ORGS_ROUTE_SRC.match(/checkAdmin\(/g) || []
    expect(agentOrAdmin).toHaveLength(2)
    expect(admin).toHaveLength(3)
    // And no route is registered unguarded: 5 router verbs, 5 guards.
    const verbs = ORGS_ROUTE_SRC.match(/router\.(get|post|put|delete)\(/g) || []
    expect(verbs).toHaveLength(5)
  })
})

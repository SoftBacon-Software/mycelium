import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Regression test for audit finding S5: widget mutation endpoints
// (PUT/DELETE /widgets/:id) must scope the mutation to the caller's project.
//
// Before the fix they called checkAgentOrAdmin (auth only) and then mutated
// the widget with NO project-scope check — so ANY authenticated agent could
// modify or delete ANY widget on the platform, including widgets owned by
// other projects/agents. The fix loads the widget, runs checkProjectScope on
// its project_id (the same pattern tasks/plans already use), then mutates.
//
// Harness mirrors directive-and-upload-auth.test.js: real router, fresh temp
// DB, env set before the dynamic import so db.js / routes pick up DATA_DIR +
// ADMIN_KEY.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const OWNER_KEY = 'dvk_' + 'b'.repeat(48)
const OTHER_KEY = 'dvk_' + 'c'.repeat(48)

const OWNER_PROJECT = 'owner-proj'
const OTHER_PROJECT = 'other-proj'

let tmpDataDir
let db
let app
let widgetId

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-widget-scope-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // Owner agent scoped to OWNER_PROJECT.
  const ownerHash = crypto.createHash('sha256').update(OWNER_KEY).digest('hex')
  db.createAgent('owner-agent', 'Owner Agent', OWNER_PROJECT, ownerHash, '["code"]')

  // Cross-project agent scoped to a DIFFERENT project.
  const otherHash = crypto.createHash('sha256').update(OTHER_KEY).digest('hex')
  db.createAgent('other-agent', 'Other Agent', OTHER_PROJECT, otherHash, '["code"]')

  // A widget owned by OWNER_PROJECT.
  const created = db.createWidget('owner-agent', OWNER_PROJECT, 'Status Widget', 'status', { hello: 'world' })
  widgetId = created.id
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('PUT/DELETE /widgets/:id — audit S5 project-scope gate', () => {
  test('a cross-project agent is 403 on PUT', async () => {
    const res = await request(app)
      .put('/api/mycelium/widgets/' + widgetId)
      .set('X-Agent-Key', OTHER_KEY)
      .send({ title: 'hacked' })
    expect(res.status).toBe(403)
  })

  test('a cross-project agent is 403 on DELETE', async () => {
    const res = await request(app)
      .delete('/api/mycelium/widgets/' + widgetId)
      .set('X-Agent-Key', OTHER_KEY)
    expect(res.status).toBe(403)
  })

  test('the owning agent can PUT its own widget (200)', async () => {
    const res = await request(app)
      .put('/api/mycelium/widgets/' + widgetId)
      .set('X-Agent-Key', OWNER_KEY)
      .send({ title: 'updated by owner' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('updated by owner')
  })

  test('admin can PUT any widget (200)', async () => {
    const res = await request(app)
      .put('/api/mycelium/widgets/' + widgetId)
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
      .send({ title: 'updated by admin' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('updated by admin')
  })

  test('admin can DELETE any widget (200)', async () => {
    const res = await request(app)
      .delete('/api/mycelium/widgets/' + widgetId)
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

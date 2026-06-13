import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// listAgents() returned a TRIMMED roster (no brain/telemetry columns), forcing
// the cockpit into a GET /agents/:id per agent it never does — so the live
// meters (tps, brain-residency, watts) read empty even though the app parses
// and renders them. This pins that the roster now carries brain/telemetry
// inline, still without api_key_hash. Same harness as db-agent-heartbeat:
// set DATA_DIR before the dynamic import; initDB writes only to the temp dir.

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-agents-telemetry-'))
  process.env.DATA_DIR = tmpDataDir
  process.env.ADMIN_KEY = 'test-admin-key'
  process.env.JWT_SECRET = 'test-jwt-secret'
  db = await import('../../server/db.js')
  db.initDB()
  db.createAgent('lucy-test', 'Lucy Test', 'proj', 'secret-hash', '["code"]')
  db.updateAgent('lucy-test', {
    llm_backend: 'omlx',
    llm_model: 'Qwen3-Coder-Next-8bit',
    runtime: 'oMLX',
    agent_type: 'agent',
    system_diagnostics: { ram_gb: 82, tps: 42, watts_per_tok: 2.1 },
  })
})

afterAll(() => { if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true }) })

describe('GET /agents roster carries brain/telemetry inline', () => {
  test('listAgents() row includes llm_*/runtime/system_diagnostics/agent_type', () => {
    const row = db.listAgents().find((a) => a.id === 'lucy-test')
    expect(row).toBeDefined()
    expect(row.llm_model).toBe('Qwen3-Coder-Next-8bit')
    expect(row.llm_backend).toBe('omlx')
    expect(row.runtime).toBe('oMLX')
    expect(row.agent_type).toBe('agent')
    // system_diagnostics is stored + returned as a JSON string (the app decodes
    // it, exactly as it already does for capabilities). Don't double-encode.
    expect(typeof row.system_diagnostics).toBe('string')
    expect(JSON.parse(row.system_diagnostics).tps).toBe(42)
  })

  test('roster still excludes api_key_hash', () => {
    const row = db.listAgents().find((a) => a.id === 'lucy-test')
    expect(row.api_key_hash).toBeUndefined()
  })
})

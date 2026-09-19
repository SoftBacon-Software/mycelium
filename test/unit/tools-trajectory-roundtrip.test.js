// tools/trajectory.py — the END-TO-END round trip over the real transport
// (task 243). The pytest file (tools/test_trajectory.py) pins the logic with
// a fake runner; THIS one proves the real thing: a node stub platform on a
// real port, the tool driving it through actual curl + python3, and the
// brief's acceptance test — episodes -> export -> records -> ingest ->
// episodes with byte-identical content_text.
//
// Skipped with a stated reason when python3 or curl is missing (CI has both;
// a dev box without them should say so, not fail mysteriously).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..')
const TOOL = join(ROOT, 'tools', 'trajectory.py')

function have(bin) {
  return spawnSync(bin, ['--version']).status === 0
}
const py = have('python3')
const curl = have('curl')

describe('tools/trajectory.py end-to-end (real curl transport)', () => {
  if (!py || !curl) {
    it.skip(`needs python3 (${py}) and curl (${curl}) on PATH`, () => {})
    return
  }

  let server
  let base
  const indexed = []           // every row POSTed to /memory/index
  let episodesPayload = { source_type: 'episode', count: 0, results: [] }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (req.url.startsWith('/api/mycelium/memory/index')) {
          indexed.push(JSON.parse(body))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, source_id: JSON.parse(body).source_id }))
          return
        }
        if (req.url.startsWith('/api/mycelium/memory/episodes')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(episodesPayload))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}/api/mycelium`
  })

  afterAll(() => { server?.close() })

  // The tool runs via ASYNC spawn, not spawnSync: the stub platform lives on
  // THIS process's event loop, and a blocking spawn freezes that loop, so the
  // stub could never parse the request or answer — curl connects, receives 0
  // bytes, times out. (Measured, not guessed: spawnSync here = curl exit 28
  // "0 bytes received" against a server that was listening the whole time.)
  function runTool(args) {
    return new Promise((resolve) => {
      const child = spawn('python3', [TOOL, ...args], {
        env: { ...process.env, MYCELIUM_API_KEY: 'test-key', MYCELIUM_URL: base },
      })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ status: null, signal: 'SIGKILL', stdout: out, stderr: err })
      }, 20000)
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        if (code !== 0) {
          console.error('[trajectory e2e] rc=', code, 'signal=', signal,
            '\nstdout:', out, '\nstderr:', err)
        }
        resolve({ status: code, signal, stdout: out, stderr: err })
      })
    })
  }

  it('round-trips a session: episodes -> trajectory v1 -> episodes, byte-identical', async () => {
    const turns = [
      { role: 'user', text: 'Which scenario planted the $10 discrepancy?' },
      { role: 'assistant', text: 'C2_settlement — the appraisal tax line, misread 151.72 as 161.72.' },
      { role: 'tool', text: 'checker output: 15 of 20 failing runs never re-derived the total' },
    ]
    episodesPayload = {
      source_type: 'episode',
      count: turns.length,
      results: turns.map((t, i) => ({
        source_type: 'episode',
        source_id: `episode:rt${i}`,
        content_text: t.text,
        created_at: `2026-09-19T0${i + 1}:00:00Z`,
        metadata: {
          agent: 'mycelium-agent', session_date: '2026-09-19', session_id: 'sess_e2e',
          origin: 'hermes-turn:sess_e2e', seq: i, traj_role: t.role,
          ...(t.role === 'tool' ? { traj_tool_call_id: `c${i}`, traj_ok: false } : {}),
        },
      })),
    }

    const dir = mkdtempSync(join(tmpdir(), 'traj-e2e-'))
    const out = join(dir, 'session.json')
    const exported = await runTool(['export', '--agent', 'mycelium-agent', '--session-id', 'sess_e2e',
      '--out', out, '--url', base])
    expect(exported.status).toBe(0)

    // the file on disk is a bare v1 array — no extension fields anywhere
    const records = JSON.parse(readFileSync(out, 'utf-8'))
    expect(records).toHaveLength(3)
    expect(records.map((r) => r.content)).toEqual(turns.map((t) => t.text))
    expect(records.map((r) => r.role)).toEqual(['user', 'assistant', 'tool'])
    for (const r of records) {
      expect(Object.keys(r).sort()).toEqual(
        r.role === 'tool'
          ? ['content', 'ok', 'role', 'timestamp', 'tool_call_id']
          : ['content', 'role', 'timestamp'])
    }
    // the sidecar exists and carries what v1 cannot
    const sidecar = JSON.parse(readFileSync(out + '.mycelium.json', 'utf-8'))
    expect(sidecar.format).toBe('mycelium-episode-sidecar/1')
    expect(sidecar.records['0'].metadata.agent).toBe('mycelium-agent')

    // ingest into the stub platform through REAL curl
    const ingested = await runTool(['ingest', out, '--sidecar', out + '.mycelium.json',
      '--agent', 'mycelium-agent', '--session-date', '2026-09-19',
      '--session-id', 'sess_e2e', '--url', base])
    expect(ingested.status).toBe(0)
    expect(indexed).toHaveLength(3)

    // THE acceptance: byte-identical text, roles and provenance restored
    expect(indexed.map((r) => r.content_text)).toEqual(turns.map((t) => t.text))
    expect(indexed.map((r) => r.metadata.traj_role)).toEqual(turns.map((t) => t.role))
    const firstIds = indexed.map((r) => r.source_id)
    for (const r of indexed) {
      expect(r.source_type).toBe('episode')
      expect(r.metadata.agent).toBe('mycelium-agent')
      expect(r.metadata.session_date).toBe('2026-09-19')
      expect(r.metadata.session_id).toBe('sess_e2e')
    }
    // stable ids: the same file again upserts the same rows (idempotent)
    indexed.length = 0
    const again = await runTool(['ingest', out, '--sidecar', out + '.mycelium.json',
      '--agent', 'mycelium-agent', '--session-date', '2026-09-19',
      '--session-id', 'sess_e2e', '--url', base])
    expect(again.status).toBe(0)
    expect(indexed.map((r) => r.source_id)).toEqual(firstIds)
  })

  it('refuses an invalid trajectory with exit 2 and posts nothing', async () => {
    const before = indexed.length   // the round-trip test's rows stay; nothing NEW may land
    const dir = mkdtempSync(join(tmpdir(), 'traj-e2e-'))
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, JSON.stringify([
      { role: 'user', content: 'x', timestamp: '2026-09-19T09:00:00Z', supersedes: 'episode:1' },
    ]))
    const r = await runTool(['ingest', bad, '--agent', 'a', '--session-date', '2026-09-19', '--url', base])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('supersedes')       // additionalProperties:false named
    expect(indexed).toHaveLength(before)
  })
})

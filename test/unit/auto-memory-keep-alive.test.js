import { describe, test, expect, vi, afterEach } from 'vitest'
import { callLLM } from '../../server/plugins/auto-memory/llm.js'

// Task 195 — the auto-memory extraction model must not pin the Jetson.
// Ollama's per-request keep_alive controls how long a model stays resident
// after a call. The platform box (jetson01) is small and shared: node + the
// semantic-memory embedder + the extraction model on one board, and the box's
// ollama unit ran OLLAMA_KEEP_ALIVE=-1 — so ONE extraction pinned
// nemotron-mini (2,696 MB) for as long as the unit stayed up (measured
// 2026-09-11: 1.5 days resident with no requests in 90 min → three event-loop
// wedges in 3.5 h). Every ollama call auto-memory makes must therefore carry
// an explicit, FINITE keep_alive, from AUTO_MEMORY_LLM_KEEP_ALIVE (default
// '10m'). The semantic-memory embedder is deliberately NOT touched — it is
// hit constantly and must stay warm (a cold reload is only ~2 s, but the
// embedder should never go cold in the first place).

const realFetch = global.fetch
const OLLAMA = '11434'
var captured = []

function mockOllama(responder) {
  return function (url, opts) {
    if (String(url).indexOf(OLLAMA) !== -1) {
      captured.push({ url: String(url), body: JSON.parse(opts.body) })
      return Promise.resolve(responder())
    }
    return realFetch(url, opts)
  }
}

function okGenerate() {
  return new Response(JSON.stringify({ response: '{"facts":[]}' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

var config = {
  llm_provider: 'ollama',
  llm_url: 'http://localhost:11434',
  llm_model: 'nemotron-mini:latest'
}

afterEach(() => {
  global.fetch = realFetch
  captured = []
  vi.unstubAllEnvs()
})

describe('auto-memory ollama keep_alive (task 195)', () => {
  test('extraction body carries the finite default keep_alive "10m"', async () => {
    delete process.env.AUTO_MEMORY_LLM_KEEP_ALIVE
    global.fetch = mockOllama(okGenerate)

    await callLLM(config, 'extract facts from this')

    expect(captured.length).toBe(1)
    expect(captured[0].url).toContain('/api/generate')
    expect(captured[0].body.keep_alive).toBe('10m')
    // The request shape the extraction path depends on is otherwise unchanged.
    expect(captured[0].body.model).toBe('nemotron-mini:latest')
    expect(captured[0].body.prompt).toBe('extract facts from this')
    expect(captured[0].body.stream).toBe(false)
  })

  test('AUTO_MEMORY_LLM_KEEP_ALIVE overrides the default', async () => {
    vi.stubEnv('AUTO_MEMORY_LLM_KEEP_ALIVE', '45m')
    global.fetch = mockOllama(okGenerate)

    await callLLM(config, 'extract facts from this')

    expect(captured[0].body.keep_alive).toBe('45m')
  })

  test('an evict-now value passes through verbatim ("0" = unload immediately)', async () => {
    vi.stubEnv('AUTO_MEMORY_LLM_KEEP_ALIVE', '0')
    global.fetch = mockOllama(okGenerate)

    await callLLM(config, 'consolidate')

    expect(captured[0].body.keep_alive).toBe('0')
  })

  test('clearing the env var returns the call to the default', async () => {
    vi.stubEnv('AUTO_MEMORY_LLM_KEEP_ALIVE', '0')
    global.fetch = mockOllama(okGenerate)
    await callLLM(config, 'first call')
    expect(captured[0].body.keep_alive).toBe('0')

    vi.unstubAllEnvs()
    global.fetch = mockOllama(okGenerate)
    await callLLM(config, 'second call')
    expect(captured[1].body.keep_alive).toBe('10m')
  })
})

import { describe, test, expect, vi, beforeEach } from 'vitest'

// Task 186 §4 (AUDIT-lab-clockwork-2026-09-12): the decay/prune half of the
// auto-memory consolidation tick ran UNGATED — every 6h it walked and mutated
// the facts table while the LIVE config has consolidation_enabled=false and
// llm_provider=none (extraction off too). The pass is now gated behind
// `decay_enabled`, which DEFAULTS TO the consolidation flag: enabling
// consolidation keeps decay (back-compat); the live shape stops paying for a
// pass nobody asked for; decay alone is still available explicitly.

vi.mock('../../server/plugins/auto-memory/decay.js', () => ({
  applyDecay: vi.fn(function () { return 0 }),
}))
vi.mock('../../server/plugins/auto-memory/routes.js', () => ({
  extractFacts: vi.fn(),
  runConsolidation: vi.fn(function () { return Promise.resolve({ ok: true }) }),
}))

import { applyDecay } from '../../server/plugins/auto-memory/decay.js'
import { runConsolidation } from '../../server/plugins/auto-memory/routes.js'
import { isDecayEnabled, consolidationTick } from '../../server/plugins/auto-memory/handlers.js'

function stubDb() {
  return { pruneLowConfidence: vi.fn(function () { return 0 }) }
}

beforeEach(() => {
  vi.clearAllMocks() // mock call counts must not leak between tests
})

function tickWith(config) {
  var db = stubDb()
  consolidationTick(db, config, {})
  return db
}

describe('auto-memory decay gate (task 186 §4)', () => {
  test('isDecayEnabled: THE BITE — live config (consolidation off) gates decay OFF', () => {
    expect(isDecayEnabled({ consolidation_enabled: 'false', llm_provider: 'none' })).toBe(false)
  })

  test('isDecayEnabled: unset flags keep the historical default (decay on)', () => {
    expect(isDecayEnabled({})).toBe(true)
    expect(isDecayEnabled({ llm_provider: 'none' })).toBe(true)
  })

  test('isDecayEnabled: explicit decay_enabled overrides the consolidation flag both ways', () => {
    expect(isDecayEnabled({ consolidation_enabled: 'false', decay_enabled: 'true' })).toBe(true)
    expect(isDecayEnabled({ consolidation_enabled: 'true', decay_enabled: 'false' })).toBe(false)
  })

  test('tick with decay gated off touches nothing', () => {
    var db = tickWith({ consolidation_enabled: 'false', llm_provider: 'none' })
    expect(applyDecay).not.toHaveBeenCalled()
    expect(db.pruneLowConfidence).not.toHaveBeenCalled()
    expect(runConsolidation).not.toHaveBeenCalled()
  })

  test('tick with decay on runs decay+prune but skips consolidation when it is off', async () => {
    var db = tickWith({ consolidation_enabled: 'false', decay_enabled: 'true', llm_provider: 'none' })
    expect(applyDecay).toHaveBeenCalledTimes(1)
    expect(db.pruneLowConfidence).toHaveBeenCalledWith(0.15)
    await new Promise(function (r) { setTimeout(r, 0) })
    expect(runConsolidation).not.toHaveBeenCalled()
  })

  test('tick with everything on preserves the consolidation path', async () => {
    tickWith({ consolidation_enabled: 'true', llm_provider: 'glm' })
    expect(applyDecay).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(runConsolidation).toHaveBeenCalled())
  })

  test('decay failure does not block the consolidation half (error contained)', () => {
    var db = stubDb()
    applyDecay.mockImplementationOnce(function () { throw new Error('decay boom') })
    expect(function () {
      consolidationTick(db, { consolidation_enabled: 'true', llm_provider: 'glm' }, {})
    }).not.toThrow()
    expect(db.pruneLowConfidence).not.toHaveBeenCalled() // try-block abandoned as before
    void runConsolidation
  })
})

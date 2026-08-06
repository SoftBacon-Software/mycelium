import { describe, test, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { analyzeImportGraph } from '../../tools/import-graph.js'

// Regression gate for import cycles. The Mycelium module graph is a DAG by
// construction (see docs/IMPORT-GRAPH.md). This test runs the same Tarjan SCC
// analyzer a human runs from the CLI (node tools/import-graph.js) and fails the
// suite the moment a directed cycle is introduced anywhere in the repo — before
// it lands. It exists because a real 2-file cycle (mcp/src/sse.js <-> state.js)
// once went unnoticed, and because heuristic scanners have falsely reported the
// server/db.js barrel neighborhood as a "cycle"; this is the authoritative check.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const graph = analyzeImportGraph(repoRoot)

describe('import graph is acyclic (no directed import cycles)', () => {
  test('scanner resolved the real source tree (guards against a vacuous pass)', () => {
    // If the root were wrong or the walk silently empty, "0 cycles" would be
    // meaningless. Assert the scanner actually found the known anchors.
    const rel = graph.files.map((f) => f.slice(repoRoot.length + 1))
    expect(rel).toContain('server/db.js')
    expect(rel).toContain('server/index.js')
    expect(rel).toContain('mcp/src/sse.js')
    expect(graph.fileCount).toBeGreaterThan(300)
  })

  test('no directed import cycles (strongly connected components of size > 1)', () => {
    if (graph.cycles.length > 0) {
      const detail = graph.cycles
        .map((c) => c.map((n) => `${n.file} -> [${n.edgesTo.join(', ')}]`).join('\n      '))
        .join('\n      ')
      throw new Error(`Import cycle(s) introduced — a module now imports back into itself:\n      ${detail}\n    See docs/IMPORT-GRAPH.md.`)
    }
    expect(graph.cycles).toHaveLength(0)
  })

  test('no self-loops (a module importing itself)', () => {
    expect(graph.selfLoops).toHaveLength(0)
  })
})

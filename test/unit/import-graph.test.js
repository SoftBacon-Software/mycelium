import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// The acyclicity gate above is only worth anything if the analyzer actually
// DETECTS a cycle when one exists. A bug that made Tarjan always return [] would
// turn "0 cycles" into a false green and let a real cycle slip through CI. This
// feeds analyzeImportGraph a synthetic cyclic graph and asserts it finds exactly
// the cycles + self-loop planted there — proving the detector detects,
// independent of the repo's current (clean) state. The repo-level tests above
// prove the tree is clean TODAY; these prove the gate would catch a regression
// TOMORROW.
describe('analyzeImportGraph detects cycles (the gate must bite)', () => {
  let fixtureRoot

  beforeAll(() => {
    // mkdtempSync gives an empty unique dir; plant a known graph in it.
    fixtureRoot = mkdtempSync(join(tmpdir(), 'myc-importgraph-detector-'))
    // 2-cycle: a <-> b
    writeFileSync(join(fixtureRoot, 'a.js'), "import './b.js'\n")
    writeFileSync(join(fixtureRoot, 'b.js'), "import './a.js'\n")
    // 3-cycle: c -> d -> e -> c
    writeFileSync(join(fixtureRoot, 'c.js'), "import './d.js'\n")
    writeFileSync(join(fixtureRoot, 'd.js'), "import './e.js'\n")
    writeFileSync(join(fixtureRoot, 'e.js'), "import './c.js'\n")
    // self-loop (a module importing itself)
    writeFileSync(join(fixtureRoot, 'self.js'), "import './self.js'\n")
    // acyclic leaf — must NOT appear in any cycle
    writeFileSync(join(fixtureRoot, 'leaf.js'), 'export const leaf = true\n')
  })

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  test('finds both planted directed cycles', () => {
    const g = analyzeImportGraph(fixtureRoot)
    const components = g.cycles.map((c) => c.map((n) => n.file).sort())
    expect(g.cycles).toHaveLength(2)
    expect(components).toContainEqual(['a.js', 'b.js'])
    expect(components).toContainEqual(['c.js', 'd.js', 'e.js'])
  })

  test('flags the self-loop', () => {
    const g = analyzeImportGraph(fixtureRoot)
    expect(g.selfLoops).toContain('self.js')
  })

  test('does not false-positive on the acyclic leaf', () => {
    const g = analyzeImportGraph(fixtureRoot)
    const inACycle = new Set(g.cycles.flatMap((c) => c.map((n) => n.file)))
    expect(inACycle).not.toContain('leaf.js')
  })
})

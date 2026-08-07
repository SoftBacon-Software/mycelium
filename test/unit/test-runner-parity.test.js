import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

// Pin: the local `npm test` runner must exercise the same plugin suites CI
// grades. CI runs `node --test server/plugins/*/test.js` as a dedicated step
// (see .github/workflows/test.yml). If `npm test` stops chaining test:plugins,
// a plugin can break without failing locally — the local-green ≠ CI-green gap
// this test exists to prevent. See test/README.md "What CI does".
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const { scripts } = pkg

describe('local test runner matches CI', () => {
  test('`npm test` chains test:plugins (plugin suites run locally, not only in CI)', () => {
    expect(
      scripts.test,
      '`test` must chain test:plugins so the plugin node:test suites run on `npm test`'
    ).toContain('test:plugins')
  })

  test('test:plugins uses the exact CI glob (server/plugins/*/test.js)', () => {
    expect(
      scripts['test:plugins'],
      'test:plugins must run the literal CI glob so local and CI cannot drift apart'
    ).toContain('server/plugins/*/test.js')
  })
})

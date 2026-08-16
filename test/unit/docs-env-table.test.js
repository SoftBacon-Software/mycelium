import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const readme = readFileSync(path.resolve(__dirname, '..', '..', 'README.md'), 'utf8')

// The README env table is the surface a stranger reads before deploying. It
// must name TRUST_PROXY so the operator of a direct-exposed instance knows the
// knob exists (and that leaving the default true lets clients spoof IPs past
// per-IP rate limits). Pinned to the `## Environment` section so a stray
// mention elsewhere in the README can't satisfy it.
describe('README environment table', () => {
  test('documents TRUST_PROXY', () => {
    const envSection = readme.split('## Environment')[1] || ''
    expect(envSection, 'README must have a ## Environment section').not.toBe('')
    expect(envSection).toContain('TRUST_PROXY')
  })
})

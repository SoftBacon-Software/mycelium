import { describe, test, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')
const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8')

// Extract the RHS of a `  - NAME=value` env line from docker-compose.yml.
// Returns null if the line is absent.
function envValue(name) {
  const m = compose.match(new RegExp(`^\\s*-\\s*${name}=(.*)$`, 'm'))
  return m ? m[1].trim() : null
}

// docker-compose.yml is the #1 onboarding path: the README's first quick-start
// is `cp .env.example .env && docker compose up -d`. It MUST NOT paper over the
// server's fail-loud boot contract (see boot-env-validation.test.js) with
// publicly-known fallback secrets. With a `${VAR:-<default>}` here, a stranger
// who skips the `cp` — or copies .env.example but leaves the values blank —
// silently stands up an instance the whole internet can admin with
// `local-admin-key` and a publicly-known JWT signing secret.
//
// The required-variable form `${VAR:?msg}` instead makes `docker compose up` /
// `config` refuse to start — and print exactly why — when the secret is unset or
// empty, matching what the server already does on the manual path.
describe('docker-compose.yml ships no default credentials', () => {
  test.each(['JWT_SECRET', 'ADMIN_KEY'])(
    '%s has no literal fallback and fails loud when unset',
    (name) => {
      const value = envValue(name)
      expect(value, `${name}= must appear in docker-compose.yml`).not.toBeNull()

      // (1) No `${VAR:-<default>}`: a guessable/empty default would boot
      //     insecure. The required-variable forms (`${VAR}`, `${VAR:?msg}`)
      //     carry no `:-` operator.
      expect(
        value,
        `${name} must not carry a :- default (found "${value}") — use \${${name}:?...} so a cold \`docker compose up\` refuses to start instead of booting with public creds`
      ).not.toMatch(/:-/)

      // (2) Must be the required-variable form: bare `${VAR}` or `${VAR:?msg}`
      //     (not a hardcoded secret, not a different variable).
      expect(
        value,
        `${name} must use \${${name}} or \${${name}:?...}; found "${value}"`
      ).toMatch(new RegExp(`^\\$\\{${name}(:\\?[^}]*)?\\}$`))
    }
  )
})

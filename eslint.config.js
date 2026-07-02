// ESLint config — the lab JS ruleset (see jarvis docs/CODING-STANDARDS.md §3).
// Philosophy mirrors the Python ruff gate: a GREEN, adoptable correctness gate,
// NOT a style religion. The codebase's intentional house style (var-heavy, the
// apiError/asyncHandler patterns) is not fought here. `no-var` is deliberately
// OFF — migrating ~3700 `var`s to const/let is a scoping-risky refactor to do as
// a planned pass, never a blind gate-day-one autofix.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'public/**',            // Next.js build output
      'node_modules/**',
      '**/*.min.js',
      'coverage/**',
      'web-advisor/**',       // vendored/sub-project
    ],
  },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'sdk/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // correctness (the real bug-catchers) stay as errors:
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-undef': 'error',
      // empty catch is the codebase's intentional fail-soft idiom (best-effort
      // cleanup; the real failure is re-raised/handled elsewhere) — allowed:
      'no-empty': ['error', { allowEmptyCatch: true }],
      // intentional house style — not enforced:
      'no-var': 'off',
      // smells surfaced but non-blocking (they become real under the future
      // var->let migration, which forces block-scoping):
      'no-redeclare': 'warn',
      'no-useless-assignment': 'warn',
      // dead code: warn (ruff parity — pyflakes dead-vars warn, don't block):
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // `while(true)` + break is idiomatic here (pollers):
      'no-constant-condition': ['error', { checkLoops: false }],
      // cosmetic redundant escapes (all `\-` in char classes — benign); surfaced
      // but non-blocking, not worth hand-editing regexes in the god-file:
      'no-useless-escape': 'warn',
    },
  },
];

// Lint-scope parity gate.
//
// `package.json`'s `lint` script and `eslint.config.js`'s `files` glob each list
// the linted directories INDEPENDENTLY. That split is a footgun: a dir present in
// one but not the other either escapes CI's lint step or escapes the ruleset +
// globals grant — exactly how mcp/runner/printer-drone shipped with zero
// correctness-lint coverage (and an undetected no-constant-binary-expression bug
// in runner/src/orchestrator.js). This test freezes their agreement by deriving
// both lists from the live files, so adding a JS top-level dir in only one place
// is named here without anyone editing a checklist.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const PKG_PATH = join(REPO_ROOT, 'package.json');
const ESLINT_CONFIG_PATH = join(REPO_ROOT, 'eslint.config.js');

// Pull the bare directory args out of an `eslint <dirs...> [--flags]` script.
// Flags that TAKE A VALUE contribute that value as a bare token (e.g.
// `--max-warnings 338`), so the value must be dropped with its flag or it
// parses as a directory named "338".
const VALUED_FLAGS = new Set(['--max-warnings', '--format', '--output-file', '--ext']);
function dirsFromEslintScript(scriptName) {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const script = pkg.scripts?.[scriptName];
  if (typeof script !== 'string' || !script.includes('eslint')) {
    throw new Error(`package.json scripts.${scriptName} does not invoke eslint`);
  }
  const tokens = script.split(/\s+/);
  const eslintIdx = tokens.lastIndexOf('eslint'); // skip a leading `npx`
  const args = tokens.slice(eslintIdx + 1).filter((t) => t.length > 0);
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUED_FLAGS.has(args[i])) { i++; continue; } // skip flag + its value
    if (args[i].startsWith('-')) continue;
    dirs.push(args[i]);
  }
  return dirs;
}

// Pull the concrete top-level dir roots out of eslint.config.js's `files` globs
// by importing the live config (no source-text regex). `server/**/*.{js,mjs}` ->
// `server`; bare wildcard patterns (e.g. `**/*.js`) contribute no root.
async function dirsFromEslintConfig() {
  const mod = await import(pathToFileURL(ESLINT_CONFIG_PATH).href);
  const entries = (mod.default ?? []).flat(Infinity);
  const roots = new Set();
  for (const entry of entries) {
    if (!entry || !Array.isArray(entry.files)) continue; // skips `ignores` block + js.configs.recommended
    for (const pattern of entry.files) {
      const first = String(pattern).split('/')[0];
      if (first && !first.includes('*') && !first.includes('?') && !first.startsWith('!')) {
        roots.add(first);
      }
    }
  }
  return [...roots];
}

function drift(report) {
  return (
    `lint scope drift between package.json scripts and eslint.config.js:\n` +
    `  dirs only in lint script : [${report.onlyInScript.join(', ')}]\n` +
    `  dirs only in config files: [${report.onlyInConfig.join(', ')}]\n` +
    `  lint dirs   : [${report.scriptDirs.join(', ')}]\n` +
    `  config dirs : [${report.configDirs.join(', ')}]\n` +
    `The lint script and the eslint files glob list dirs independently — keep them identical.`
  );
}

describe('lint scope parity', () => {
  it('`lint` script dirs === eslint.config.js `files`-glob dirs', async () => {
    const scriptDirs = dirsFromEslintScript('lint').sort();
    const configDirs = (await dirsFromEslintConfig()).sort();
    const onlyInScript = scriptDirs.filter((d) => !configDirs.includes(d));
    const onlyInConfig = configDirs.filter((d) => !scriptDirs.includes(d));
    if (onlyInScript.length || onlyInConfig.length) {
      throw new Error(drift({ scriptDirs, configDirs, onlyInScript, onlyInConfig }));
    }
    expect(scriptDirs).toEqual(configDirs);
  });

  it('`lint:fix` covers the same dirs as `lint`', () => {
    const lint = dirsFromEslintScript('lint').sort();
    const fix = dirsFromEslintScript('lint:fix').sort();
    expect(fix, '`lint:fix` drifted from `lint` — keep both scripts in sync').toEqual(lint);
  });

  it('every linted dir actually exists on disk (catches a typo duplicated in both lists)', () => {
    const dirs = dirsFromEslintScript('lint');
    const missing = dirs.filter((d) => !existsSync(join(REPO_ROOT, d)));
    expect(missing, `lint script names dirs that don't exist: [${missing.join(', ')}]`).toEqual([]);
  });
});

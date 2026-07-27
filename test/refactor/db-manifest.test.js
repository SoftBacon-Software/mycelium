// db.js export-manifest gate — runs under `npx vitest run` (matches test/**/*.test.js).
// Wraps the same assertion as `node test/refactor/db-manifest.mjs --check` so the
// decomposition gate is exercised by the full suite, not just a manual CLI step.
// Snapshot lives in test/refactor/db-manifest.snapshot (committed).
import { describe, test, expect } from 'vitest';
import { buildManifest, SNAPSHOT_PATH } from './db-manifest.mjs';
import { readFileSync, existsSync } from 'node:fs';

const EXPECTED_EXPORT_COUNT = 308;

describe('db.js export manifest (decomposition gate)', () => {
  test('public surface matches snapshot — 308 exports, stable types+arities', async () => {
    const manifest = await buildManifest();

    if (!existsSync(SNAPSHOT_PATH)) {
      throw new Error(
        `db-manifest snapshot missing at ${SNAPSHOT_PATH}.\n` +
        `Run: node test/refactor/db-manifest.mjs --write`,
      );
    }

    const golden = readFileSync(SNAPSHOT_PATH, 'utf8');
    const count = manifest.trim().split('\n').length;

    // Sanity: master's db.js surface is exactly 308 exports. A net change here is a
    // red flag even if the snapshot were stale — catch count drift directly.
    expect(count).toBe(EXPECTED_EXPORT_COUNT);

    if (golden !== manifest) {
      const g = new Set(golden.trim().split('\n'));
      const c = new Set(manifest.trim().split('\n'));
      const lost = [...g].filter((l) => !c.has(l));
      const added = [...c].filter((l) => !g.has(l));
      throw new Error(
        'DB EXPORT MANIFEST DRIFT — extraction changed the public surface:\n' +
          lost.map((l) => `  - LOST:  ${l}`).join('\n') +
          (lost.length && added.length ? '\n' : '') +
          added.map((l) => `  + ADDED: ${l}`).join('\n'),
      );
    }
  });
});

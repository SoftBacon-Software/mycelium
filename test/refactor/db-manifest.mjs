// db-manifest extractor — the invariant that makes db.js decomposition SAFE.
//
// Mirrors test/refactor/route-manifest.mjs. Walks server/db.js's ESM namespace
// and emits every export as `name:typeof:length`, sorted and stable. Snapshot
// this BEFORE an extraction; assert it is byte-identical AFTER. Any export
// silently dropped, added, re-typed, or re-aritied by a move fails the gate
// mechanically — the #1 decomposition risk (the star-export silent-drop trap
// and surface creep from accidentally re-exported internals like `db`/`stmt`).
//
// Usage:
//   node test/refactor/db-manifest.mjs            # print manifest to stdout
//   node test/refactor/db-manifest.mjs --check    # diff against the snapshot, exit 1 on drift
//   node test/refactor/db-manifest.mjs --write    # (re)write the snapshot
//
// Also runs under `npx vitest run` via db-manifest.test.js (same assertion), so
// the gate is exercised by the full suite, not just a manual CLI step.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_PATH = join(HERE, 'db-manifest.snapshot');

// db.js (and, post-Wave-1, db/core.js) read DATA_DIR at module-eval time. No
// initDB() is called here — import only defines functions — but set a temp dir
// so the import is side-effect-free regardless of environment.
export async function buildManifest() {
  if (!process.env.DATA_DIR) process.env.DATA_DIR = join(tmpdir(), 'mycelium-manifest');
  const ns = await import('../../server/db.js');
  const entries = Object.entries(ns)
    .map(([name, value]) => {
      const t = typeof value;
      // fn.length for functions (arity), .length for arrays (count) — both are
      // stable invariants worth pinning. Empty for plain objects / undefined.
      const len = (value != null && typeof value.length === 'number') ? value.length : '';
      return `${name}:${t}:${len}`;
    })
    .sort();
  return entries.join('\n') + '\n';
}

// --- standalone CLI (mirrors route-manifest.mjs) ---
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const manifest = await buildManifest();
  const count = manifest.trim().split('\n').length;

  if (process.argv.includes('--check')) {
    if (!existsSync(SNAPSHOT_PATH)) {
      console.error('no snapshot yet — run `node test/refactor/db-manifest.mjs --write` to create one');
      process.exit(2);
    }
    const golden = readFileSync(SNAPSHOT_PATH, 'utf8');
    if (golden === manifest) {
      console.error(`db export manifest unchanged (${count} exports) ✓`);
      process.exit(0);
    }
    console.error('DB EXPORT MANIFEST DRIFT — extraction changed the public surface:');
    const g = new Set(golden.trim().split('\n'));
    const c = new Set(manifest.trim().split('\n'));
    for (const l of g) if (!c.has(l)) console.error(`  - LOST:  ${l}`);
    for (const l of c) if (!g.has(l)) console.error(`  + ADDED: ${l}`);
    process.exit(1);
  }

  if (process.argv.includes('--write')) {
    writeFileSync(SNAPSHOT_PATH, manifest);
    console.error(`wrote snapshot: ${count} exports → ${SNAPSHOT_PATH}`);
  } else {
    process.stdout.write(manifest);
  }
}

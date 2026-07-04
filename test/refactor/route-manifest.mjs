// Route-manifest extractor — the invariant that makes god-file decomposition SAFE.
//
// Walks the real mounted Express router and emits every route's METHOD + path +
// middleware-name chain, sorted and stable. Snapshot this BEFORE an extraction;
// assert it is byte-identical AFTER. Any route silently dropped, re-pathed, or
// re-authed by a move fails the gate mechanically — the #1 decomposition risk.
//
// Usage:
//   node test/refactor/route-manifest.mjs            # print manifest to stdout
//   node test/refactor/route-manifest.mjs --check    # diff against the snapshot, exit 1 on drift
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, 'route-manifest.snapshot');

function collect(router) {
  const lines = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        const methods = Object.keys(layer.route.methods)
          .filter((m) => layer.route.methods[m])
          .map((m) => m.toUpperCase())
          .sort();
        const mw = (layer.route.stack || [])
          .map((s) => s.name || 'anon')
          .filter((n) => n && n !== '<anonymous>');
        for (const m of methods) lines.push(`${m} ${path}  [${mw.join(',')}]`);
      } else if (layer.name === 'router' && layer.handle?.stack) {
        // nested sub-router (post-extraction shape) — recurse so the manifest is
        // identical whether a route lives in the god file or a domain module.
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(router.stack, '');
  return lines.sort();
}

const { default: router } = await import('../../server/routes/mycelium.js');
const manifest = collect(router).join('\n') + '\n';

if (process.argv.includes('--check')) {
  if (!existsSync(SNAPSHOT)) {
    console.error('no snapshot yet — run without --check to create one');
    process.exit(2);
  }
  const golden = readFileSync(SNAPSHOT, 'utf8');
  if (golden === manifest) {
    console.error(`route manifest unchanged (${manifest.trim().split('\n').length} routes) ✓`);
    process.exit(0);
  }
  console.error('ROUTE MANIFEST DRIFT — extraction changed the route contract:');
  const g = new Set(golden.trim().split('\n'));
  const c = new Set(manifest.trim().split('\n'));
  for (const l of g) if (!c.has(l)) console.error(`  - LOST:  ${l}`);
  for (const l of c) if (!g.has(l)) console.error(`  + ADDED: ${l}`);
  process.exit(1);
}

if (process.argv.includes('--write')) {
  writeFileSync(SNAPSHOT, manifest);
  console.error(`wrote snapshot: ${manifest.trim().split('\n').length} routes`);
} else {
  process.stdout.write(manifest);
}

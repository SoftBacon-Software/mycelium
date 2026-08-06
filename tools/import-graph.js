#!/usr/bin/env node
// Import-graph analyzer for the Mycelium repo.
//
// Read-only: reads file text, resolves relative ESM/CJS specifiers, builds the
// directed module graph, and runs iterative Tarjan strongly-connected-components
// to find TRUE directed cycles (the only honest definition of an import cycle).
// Also reports weakly-connected components (direction-blind) around hub files,
// because high-fan-in barrel facades are routinely — and wrongly — flagged as
// "cycles" by heuristic / direction-blind scanners. See docs/IMPORT-GRAPH.md.
//
// Exists because the 2026-08-04 import-cycle audit left its scanner in /tmp,
// where it was deleted within days. Vendoring it here makes the analysis
// reproducible for the next person and lets test/unit/import-graph.test.js pin
// acyclicity as a CI gate.
//
//   node tools/import-graph.js [path]            # human report (default: repo root)
//   node tools/import-graph.js --json [path]     # machine-readable
//
// Or import in a test:
//   import { analyzeImportGraph } from '../tools/import-graph.js'
//   const { cycles, selfLoops } = analyzeImportGraph(repoRoot)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'build', '.cache']);

// Resolve a relative/absolute specifier from a base dir to an absolute file.
function resolveSpec(spec, baseDir, root) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null; // bare/external
  const start = spec.startsWith('/') ? root : baseDir;
  const candidates = [
    join(start, spec),
    join(start, spec + '.js'),
    join(start, spec + '.mjs'),
    join(start, spec + '.cjs'),
    join(start, spec + '.json'),
    join(start, spec, 'index.js'),
    join(start, spec, 'index.mjs'),
  ];
  for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

// Specifier patterns: static import/export-from, side-effect import, dynamic
// import(), and require(). Template-literal dynamic imports do not occur in this
// repo (verified) and would not be statically resolvable anyway.
const PATTERNS = [
  /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// Strip // line comments and /* */ block comments while preserving string and
// template literals, so a doc comment that merely *mentions*
// `import x from './y'` (see the CLI-help block in this very file) is not
// mistaken for a real import edge. Without this, any comment containing an
// import-looking line fabricates a phantom edge — which, for this file's own
// self-referential help comment, showed up as a false self-loop the moment
// self-edge tracking was fixed. Regex literals aren't specially handled, but an
// import statement never shares a line with one in this repo, so no real
// specifier is dropped.
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src[i] + src[i + 1];
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl; // stop at the newline (keep it, for tidy output)
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      // Copy the string literal verbatim (honoring \-escapes) so a // or /* that
      // appears inside it (e.g. 'http://...', a URL) cannot start a comment.
      out += c; i++;
      while (i < n) {
        const ch = src[i];
        out += ch; i++;
        if (ch === '\\') { if (i < n) { out += src[i]; i++; } continue; }
        if (ch === c) break;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      walk(p, acc);
    } else if (st.isFile()) {
      const ext = extname(name);
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') acc.push(p);
    }
  }
  return acc;
}

// Build the directed graph and analyze it. Returns structured data.
export function analyzeImportGraph(root) {
  root = resolve(root);
  const files = walk(root, []);
  const fileSet = new Set(files);
  const adj = new Map();
  const radj = new Map();
  for (const f of files) { adj.set(f, new Set()); radj.set(f, new Set()); }

  for (const f of files) {
    let txt;
    try { txt = readFileSync(f, 'utf8'); } catch { continue; }
    txt = stripComments(txt);
    const baseDir = dirname(f);
    const specs = new Set();
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(txt)) !== null) specs.add(m[1]);
    }
    for (const s of specs) {
      const target = resolveSpec(s, baseDir, root);
      if (target && fileSet.has(target)) {
        // Self-edges (a module importing itself) are kept in adj ON PURPOSE.
        // They are excluded from `cycles` downstream by the size>1 SCC filter,
        // but the `selfLoops` derivation (adj.get(f).has(f)) needs them present
        // — a previous `&& target !== f` guard here starved it to an always-empty
        // list, making the "no self-loops" gate silently vacuous (caught by the
        // detector-correctness cases in test/unit/import-graph.test.js).
        adj.get(f).add(target);
        radj.get(target).add(f);
      }
    }
  }

  // Iterative Tarjan SCC.
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const ids = new Map();
  const low = new Map();
  const sccs = [];

  function tarjan(start) {
    const work = [[start, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, pi] = top;
      if (pi === 0) {
        ids.set(v, index); low.set(v, index); index++;
        stack.push(v); onStack.add(v);
      }
      let recursed = false;
      const neighbors = [...adj.get(v)];
      let i = pi;
      for (; i < neighbors.length; i++) {
        const w = neighbors[i];
        if (!ids.has(w)) {
          top[1] = i + 1;
          work.push([w, 0]);
          recursed = true;
          break;
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), low.get(w)));
        }
      }
      if (recursed) continue;
      if (low.get(v) === ids.get(v)) {
        const comp = [];
        let w;
        do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
        sccs.push(comp);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
    }
  }
  for (const f of files) if (!ids.has(f)) tarjan(f);

  const rel = (p) => relative(root, p);
  const cycles = sccs.filter(c => c.length > 1).map(comp => {
    // Order each cycle's edges for readability.
    return comp.map(f => ({
      file: rel(f),
      edgesTo: [...adj.get(f)].filter(t => comp.includes(t)).map(rel),
    }));
  });
  const selfLoops = files.filter(f => adj.get(f).has(f)).map(rel);

  return { root, fileCount: files.length, cycles, selfLoops, adj, radj, files };
}

// Undirected (weakly) connected component containing a seed — the number a
// direction-blind scanner mislabels as "a cycle."
export function weaklyConnectedComponent(graph, seedFile) {
  const { adj, radj } = graph;
  const seed = resolve(graph.root, seedFile);
  const seen = new Set([seed]);
  const q = [seed];
  while (q.length) {
    const v = q.pop();
    for (const n of [...(adj.get(v) || []), ...(radj.get(v) || [])]) {
      if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
  }
  return seen.size;
}

// ---- CLI ----
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const pathArg = args.find(a => !a.startsWith('--'));
  const root = pathArg || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const graph = analyzeImportGraph(root);

  if (asJson) {
    console.log(JSON.stringify({
      root: graph.root,
      fileCount: graph.fileCount,
      cycleCount: graph.cycles.length,
      selfLoopCount: graph.selfLoops.length,
      cycles: graph.cycles,
      selfLoops: graph.selfLoops,
    }, null, 2));
    process.exit(0);
  }

  console.log(`ROOT: ${graph.root}`);
  console.log(`FILES scanned: ${graph.fileCount}`);
  console.log(`# true cycles (SCC>1): ${graph.cycles.length}   |   self-loops: ${graph.selfLoops.length}`);
  console.log('');
  if (graph.selfLoops.length) {
    console.log('=== SELF-LOOPS ===');
    for (const f of graph.selfLoops) console.log('  ' + f);
    console.log('');
  }
  graph.cycles.forEach((comp, i) => {
    console.log(`=== CYCLE ${i + 1} (size ${comp.length}) ===`);
    for (const node of comp) {
      console.log(`    ${node.file.padEnd(40)} [cycle-edges-> ${node.edgesTo.join(', ')}]`);
    }
    console.log('');
  });
  if (graph.cycles.length === 0 && graph.selfLoops.length === 0) {
    console.log('No directed import cycles. The module graph is a DAG.');
  }
  // Context: the barrel's undirected neighborhood (what heuristics misflag).
  const barrel = join(graph.root, 'server', 'db.js');
  try {
    if (existsSync(barrel)) {
      const wcc = weaklyConnectedComponent(graph, 'server/db.js');
      console.log(`\n(context) weakly-connected component around server/db.js = ${wcc} files — a DAG hub, not a cycle.`);
    }
  } catch { /* optional context */ }
}

// Split registry + loader. Every split pins: exact file, url, sha256, licence.
// The loader refuses to run against a file whose sha256 does not match —
// the dataset identity is part of the regime stamp, and a silently-changed
// corpus would poison every number downstream.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(BENCH_DIR, 'data');

// The tiny fixture split lives in-repo (committed) so the loader's sha gate
// is testable hermetically. longmemeval points at the public file, which is
// gitignored (277 MB) and re-downloadable from the pinned URL.
export const SPLITS = {
  fixture: {
    name: 'bench-memory hermetic fixture',
    file: 'fixture-split.json',
    dir: path.join(BENCH_DIR, 'test-fixtures'),
    expectedSha256: '431b6339e32986414ac92859307e0e05b60ffd14f4a10260e96db19ea432dd3d',
    url: null,
    licence: 'MIT (this repo)',
    citation: 'internal test fixture',
  },
  longmemeval: {
    name: 'LongMemEval-S (cleaned)',
    file: 'longmemeval_s_cleaned.json',
    dir: DATA_DIR,
    expectedSha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
    licence: 'MIT',
    licenceUrl: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned',
    citation: 'Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", ICLR 2025',
  },
};

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

// Deterministic selection, part of the regime: sort by question_id, take the
// first n. Same split + same n => same items, forever.
export function selectItems(items, n) {
  const sorted = [...items].sort((a, b) => (a.question_id < b.question_id ? -1 : a.question_id > b.question_id ? 1 : 0));
  return sorted.slice(0, n);
}

export async function loadSplit(name, { expectSha = true, splits = SPLITS, sha256FileFn = sha256File } = {}) {
  const spec = splits[name];
  if (!spec) {
    throw new Error(`Unknown split '${name}'. Known: ${Object.keys(splits).join(', ')}`);
  }
  const file = path.join(spec.dir, spec.file);
  if (!fs.existsSync(file)) {
    const how = spec.url
      ? `Download it:\n  mkdir -p ${spec.dir} && curl -L -o '${file}' '${spec.url}'`
      : `Expected fixture at ${file} (should be committed).`;
    throw new Error(`Split file missing: ${file}\n${how}`);
  }
  const actualSha = await sha256FileFn(file);
  if (expectSha && spec.expectedSha256 && actualSha !== spec.expectedSha256) {
    throw new Error(
      `Split sha256 MISMATCH for ${name}:\n  expected ${spec.expectedSha256}\n  actual   ${actualSha}\n` +
      'Refusing to run against a corpus whose identity does not match the pinned regime.'
    );
  }
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(items) || items.length === 0) throw new Error(`Split ${name} parsed to ${Array.isArray(items) ? 'empty' : typeof items}`);
  for (const key of ['question_id', 'question', 'answer', 'haystack_sessions', 'question_type']) {
    if (!(key in items[0])) throw new Error(`Split ${name} items lack required field '${key}'`);
  }
  return {
    name,
    spec,
    items,
    sha256: actualSha,
    count: items.length,
  };
}

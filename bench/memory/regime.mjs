// The regime stamp — written into EVERY result row and into the receipt.
// A benchmark number without its regime is a rumour. This block is what makes
// two runs comparable (or honestly incomparable).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const REGIME_FIELDS = [
  'date_utc',
  'git_sha',
  'git_dirty',
  'harness',
  'dataset',
  'answerer',
  'judge',
  'retrieval',
  'platform',
  'n',
  'selection_rule',
  'notes',
];

export function requireCompleteRegime(regime) {
  const missing = REGIME_FIELDS.filter((f) => regime[f] === undefined);
  if (missing.length) throw new Error(`Regime stamp incomplete: missing ${missing.join(', ')}`);
  return regime;
}

export async function gitState(repoRoot, { run = execFileP } = {}) {
  try {
    const { stdout: sha } = await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: repoRoot });
    return { git_sha: sha.trim(), git_dirty: status.trim().length > 0 };
  } catch (e) {
    return { git_sha: `unknown (${e.message.slice(0, 80)})`, git_dirty: null };
  }
}

export function buildRegime({
  dateUtc,
  git,
  harnessVersion,
  dataset,      // {name, file, sha256, licence, url, count, selected}
  answerer,     // {model, url_host, temperature, max_tokens}
  judge,        // {model, url_host}
  retrieval,    // {budget, chunking, source_type, namespace, server_mode}
  platform,     // {url_host, version, embedding_provider, embedding_model, chunk_size}
  mem0 = null,  // optional — competitor-arm block from the mem0 sidecar's /health
  mem0_raw = null,      // optional — task 182 raw-ingestion control block
  mycelium_extract = null, // optional — task 182 extraction-control block
  zep = null,   // optional — competitor-arm block from the zep sidecar's /health
  letta = null, // optional — competitor-arm block from the letta sidecar's /health
  write = null, // optional — {max_sessions_per_question} when the write phase was capped
  n,
  notes = [],
}) {
  const stamp = {
    date_utc: dateUtc,
    git_sha: git.git_sha,
    git_dirty: git.git_dirty,
    harness: harnessVersion,
    dataset: {
      name: dataset.name,
      file: dataset.file,
      sha256: dataset.sha256,
      licence: dataset.licence,
      url: dataset.url,
      items_available: dataset.count,
      citation: dataset.citation,
    },
    answerer,
    judge,
    retrieval: { ...retrieval },
    platform,
    n,
    selection_rule: 'sort by question_id ascending, take first n (deterministic, stable across runs)',
    notes,
  };
  if (mem0) stamp.mem0 = mem0;
  if (mem0_raw) stamp.mem0_raw = mem0_raw;
  if (mycelium_extract) stamp.mycelium_extract = mycelium_extract;
  if (zep) stamp.zep = zep;
  if (letta) stamp.letta = letta;
  if (write) stamp.write = write;
  return requireCompleteRegime(stamp);
}

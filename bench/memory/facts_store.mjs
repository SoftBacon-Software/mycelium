// bench/memory/facts_store.mjs — the extract arm's facts, persisted per session.
//
// Extraction is the expensive half of the extract arm (2,355 sessions × ~5 s on
// the 3090 ≈ 2 h at n=50). Four B-runs died on 2026-09-09 AFTER their extraction
// had finished, and the failure-path purge (rightly) deleted the indexed facts —
// so every relaunch paid the two hours again. The arm now appends every session's
// facts to <run dir>/mycelium-extract.facts.jsonl as it goes, and a later run may
// pass --reuse-facts <that dir>: sessions found there are re-indexed without a
// model call. Reuse is honest only under the SAME extraction regime — the file's
// header carries it and a mismatch refuses loudly.

import fs from 'node:fs';
import path from 'node:path';

export const FACTS_FILE = 'mycelium-extract.facts.jsonl';

const keyOf = (questionId, sessionIndex) => `${questionId}:${sessionIndex}`;

export function factsRegimeDiff(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const diffs = [];
  for (const k of [...keys].sort()) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) diffs.push(`${k}: ${JSON.stringify(b?.[k])} (file) vs ${JSON.stringify(a?.[k])} (this run)`);
  }
  return diffs;
}

/** Read a facts file → { header, entries: Map(key → entry) }. Loud on a missing or headerless file. */
export function readFactsFile(file) {
  if (!fs.existsSync(file)) throw new Error(`facts reuse refused: no facts file at ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const header = lines.find((l) => l.type === 'header');
  if (!header) throw new Error(`facts reuse refused: ${file} has no header line (extraction regime unknown)`);
  const entries = new Map();
  for (const l of lines) {
    if (l.type === 'session') entries.set(keyOf(l.question_id, l.session_index), l);
  }
  return { header, entries };
}

/**
 * createFactsStore({ file, extraction, reuseFrom }):
 *   save(questionId, idx, record)  — appends a session line (header written first)
 *   load(questionId, idx)          — a reused session record, or null
 *   stats                          — { saved, reused, reuse_file }
 */
export function createFactsStore({ file, extraction, reuseFrom = null, now = () => new Date() }) {
  if (!file) throw new Error('facts store needs a file path');
  if (!extraction || typeof extraction !== 'object') throw new Error('facts store needs the extraction regime to stamp');
  let reuse = null;
  if (reuseFrom) {
    const src = fs.statSync(reuseFrom).isDirectory() ? path.join(reuseFrom, FACTS_FILE) : reuseFrom;
    const { header, entries } = readFactsFile(src);
    const diffs = factsRegimeDiff(extraction, header.extraction);
    if (diffs.length) {
      throw new Error(`facts reuse refused: extraction regime differs from ${src} — ${diffs.join('; ')}`);
    }
    reuse = { file: src, entries, source_run_id: header.run_id ?? null };
  }
  const stats = { saved: 0, reused: 0, reuse_file: reuse?.file ?? null, reuse_source_run_id: reuse?.source_run_id ?? null };
  let headerWritten = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"type":"header"');

  function ensureHeader(runId) {
    if (headerWritten) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ type: 'header', run_id: runId ?? null, extraction, written_at: now().toISOString() }) + '\n');
    headerWritten = true;
  }

  return {
    file,
    stats,
    reusing: Boolean(reuse),
    save(questionId, sessionIndex, record, { runId } = {}) {
      ensureHeader(runId);
      fs.appendFileSync(file, JSON.stringify({ type: 'session', question_id: questionId, session_index: sessionIndex, ...record }) + '\n');
      stats.saved++;
    },
    load(questionId, sessionIndex) {
      if (!reuse) return null;
      const e = reuse.entries.get(keyOf(questionId, sessionIndex)) ?? null;
      if (e) stats.reused++;
      return e;
    },
  };
}

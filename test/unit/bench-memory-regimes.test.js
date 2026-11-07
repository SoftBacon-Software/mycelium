// task 333 — the regime table (bench/memory/regimes.mjs → regimes.md).
// Hermetic: fixture results/receipts dirs in a tmp root; the real-dir tests read
// the TRACKED bench/memory/results + receipts (committed evidence).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditGridReceipts,
  collectRunFiles,
  generatedFromRuns,
  groupByRegime,
  headline,
  resolveEmbedder,
  runLike,
  thinkingStamp,
  writeDecisions,
} from '../../bench/memory/regimes.mjs';
import { effectiveN, loadRun, rejudgeJudgePromptStamp } from '../../bench/memory/grid.mjs';

let root;
let resultsDir;
let receiptsDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-memory-regimes-'));
  resultsDir = path.join(root, 'results');
  receiptsDir = path.join(root, 'receipts');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.mkdirSync(receiptsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- fixtures ---------------------------------------------------------------

const BASE_REGIME = {
  date_utc: '2026-09-09T19:50:34Z',
  git_sha: 'sha-a',
  git_dirty: false,
  harness: 'p1-skeleton.1',
  dataset: {
    name: 'LongMemEval-S (cleaned)',
    file: 'longmemeval_s_cleaned.json',
    sha256: 'd6f21ea9',
    licence: 'MIT',
    url: 'https://example.test/ds.json',
    items_available: 500,
    citation: 'Wu et al.',
  },
  answerer: { model: 'qwen3.8:27b', url_host: 'desktop-1uiqnip:11434', temperature: 0, max_tokens: 4096 },
  judge: { model: 'Laguna-XS-2.1-mlx-oq4e-agentic-ours', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' },
  retrieval: { budget: 5 },
  platform: { url_host: 'jetson01.local:3002', version: '0.1.0' },
  n: 50,
};

function armScore(n, exact, partial, wrong) {
  return { n, elapsed_ms: 42000, score: { n, counts: { exact, partial, wrong }, unparsed: 0, p1_score: (exact + 0.5 * partial) / n } };
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// One banked run file. kind/tag follow the FILENAME law: summary.json = primary;
// summary.rejudge.json = unsuffixed rejudge pair; summary.rejudge-<tag>.json = named pass.
function writeBankedFile(dirName, fileName, { runId, arms, regime = {}, rejudge = null, judgedRows = [], rowsByArm = {} }) {
  const dir = path.join(resultsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const summary = {
    run_id: runId,
    n: rejudge?.summaryN ?? 50,
    regime: deepMerge(BASE_REGIME, { ...regime, n: regime.n ?? 50 }),
    arms,
    write_info: {},
    ...(rejudge ?? {}),
  };
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(summary, null, 2));
  if (judgedRows.length) {
    const name = fileName === 'summary.json'
      ? 'judged.jsonl'
      : fileName === 'summary.rejudge.json'
        ? 'judged.rejudge.jsonl'
        : `judged.rejudge-${fileName.slice('summary.rejudge-'.length, -'.json'.length)}.jsonl`;
    fs.writeFileSync(path.join(dir, name), judgedRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  for (const [arm, rows] of Object.entries(rowsByArm)) {
    fs.writeFileSync(path.join(dir, `${arm}.rows.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return dir;
}

function judgedRow(overrides = {}) {
  return { question_id: 'q1', arm: 'mycelium-timeline', question_type: 'knowledge-update', label: 'exact', ...overrides };
}

function writeDecisionsRow(adds, supersedes, keeps) {
  return { meta: { write_decisions: { adds, supersedes, keeps, candidates: adds + supersedes + keeps } } };
}

function writeGridReceipt(name, citedIds) {
  const file = path.join(receiptsDir, name.endsWith('-grid.md') ? name : `${name}-grid.md`);
  const body = [`# Receipt — memory benchmark P1 grid (${citedIds.join(' + ')})`, '', 'Generated: 2026-09-09T19:00:00Z'];
  for (const id of citedIds) body.push(`### ${id}`);
  fs.writeFileSync(file, body.join('\n') + '\n');
  return file;
}

// ---- collectRunFiles: the filename law ---------------------------------------

describe('collectRunFiles: one entry per banked run FILE', () => {
  it('primary, unsuffixed rejudge pair, and tagged pass each get their own entry with the right kind/tag', () => {
    const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
    writeBankedFile('2026-09-17-p1-224225', 'summary.rejudge.json', { runId: '224225-rejudge', arms });
    writeBankedFile('2026-09-17-p1-224225', 'summary.rejudge-v3.json', {
      runId: '224225-rejudge-v3',
      arms,
      rejudge: { judge_prompt_version: 'judge-prompt.3' },
    });
    writeBankedFile('2026-09-08-p1-185920', 'summary.json', { runId: '185920', arms: { none: armScore(50, 5, 5, 40) } });

    const entries = collectRunFiles(resultsDir);
    expect(entries).toHaveLength(3);
    const byRunId = new Map(entries.map((e) => [e.runId, e]));
    // summary.json = primary
    expect(byRunId.get('185920').kind).toBe('primary');
    expect(byRunId.get('185920').tag).toBeNull();
    // summary.rejudge.json = the UNSUFFIXED rejudge pair (NOT a primary)
    expect(byRunId.get('224225-rejudge').kind).toBe('rejudge');
    expect(byRunId.get('224225-rejudge').tag).toBeNull();
    // summary.rejudge-<tag>.json = a named pass
    expect(byRunId.get('224225-rejudge-v3').kind).toBe('rejudge');
    expect(byRunId.get('224225-rejudge-v3').tag).toBe('v3');
    // every file path is repo-relative and names its dir
    expect(entries.every((e) => e.file.startsWith('bench/memory/results/'))).toBe(true);
  });

  it('a dir with no banked summary is excluded; an unparseable summary is marked unreadable, never swallowed', () => {
    writeBankedFile('2026-09-09-p1-195034', 'summary.json', { runId: '195034', arms: { mem0: armScore(50, 21, 2, 27) } });
    fs.mkdirSync(path.join(resultsDir, '2026-09-11-p1-025039'), { recursive: true }); // evidence gone
    fs.mkdirSync(path.join(resultsDir, 'smoke'), { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'smoke', 'summary.json'), '{not json');

    const entries = collectRunFiles(resultsDir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.runId).sort()).toEqual(['195034', null]);
    expect(entries.find((e) => e.kind === 'unreadable').error).toMatch(/JSON/i);
    expect(entries.find((e) => e.kind === 'unreadable').file).toContain('smoke/summary.json');
  });

  it('a missing results dir yields no entries (exit 0 shape, not a throw)', () => {
    expect(collectRunFiles(path.join(root, 'nope'))).toEqual([]);
  });
});

// ---- the effective readers on run-likes ---------------------------------------

describe('runLike: rejudge files read as what they are', () => {
  it('a rejudge pair reads n from its regime mirror (the question count), not the judged-row count', () => {
    // the 185920 shape: summary.n = 100 (two arms × 50 questions), regime.n = 50
    const arms = { none: armScore(50, 5, 5, 40), mycelium: armScore(50, 21, 16, 13) };
    writeBankedFile('2026-09-08-p1-185920', 'summary.rejudge.json', { runId: '185920-rejudge', arms, rejudge: { summaryN: 100 } });
    const entry = collectRunFiles(resultsDir)[0];
    expect(entry.kind).toBe('rejudge');
    expect(effectiveN(runLike(entry))).toBe(50);
  });

  it('a primary reads n from summary.n', () => {
    writeBankedFile('d', 'summary.json', { runId: 'd', arms: { none: armScore(50, 1, 2, 47) } });
    const entry = collectRunFiles(resultsDir)[0];
    expect(effectiveN(runLike(entry))).toBe(50);
  });

  // task 333-F2: the rejudge stamp is parsed ONCE — grid.mjs's exported
  // rejudgeJudgePromptStamp — and runLike reads it through that same symbol.
  // The composer's loadRun path and the regime table's path therefore cannot
  // diverge: if the stamp moves or gains a field, both change together, and
  // this test fails if either side stops agreeing with the shared reader.
  describe('rejudgeJudgePromptStamp: ONE reader for the composer and the table (task 333-F2)', () => {
    it('runLike\'s rejudge stamp equals the shared reader on every stamp shape', () => {
      const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
      // top-level stamp wins over the regime mirror
      writeBankedFile('run-top', 'summary.rejudge.json', {
        runId: 'run-top',
        arms,
        rejudge: { judge_prompt_version: 'judge-prompt.3' },
        regime: { judge: { judge_prompt_version: 'judge-prompt.9' } },
      });
      // mirror-only (no top-level field) — the fallback is exercised
      writeBankedFile('run-mirror', 'summary.rejudge.json', {
        runId: 'run-mirror',
        arms,
        regime: { judge: { judge_prompt_version: 'judge-prompt.4' } },
      });
      // both nullish — the reader normalizes to null (never undefined)
      writeBankedFile('run-blank', 'summary.rejudge.json', {
        runId: 'run-blank',
        arms,
        regime: { judge: { judge_prompt_version: null } },
      });

      const entries = collectRunFiles(resultsDir);
      for (const entry of entries) {
        expect(runLike(entry).rejudge.judge_prompt_version).toBe(rejudgeJudgePromptStamp(entry.summary));
      }
      const byRunId = new Map(entries.map((e) => [e.runId, e]));
      expect(runLike(byRunId.get('run-top')).rejudge.judge_prompt_version).toBe('judge-prompt.3');
      expect(runLike(byRunId.get('run-mirror')).rejudge.judge_prompt_version).toBe('judge-prompt.4');
      expect(runLike(byRunId.get('run-blank')).rejudge.judge_prompt_version).toBeNull();
    });

    it('the composer\'s loadRun rejudge object reads the same symbol (one parser, both paths)', () => {
      const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
      const judgedRows = [judgedRow(), judgedRow({ question_id: 'q2', label: 'wrong' })];
      const dir = writeBankedFile('pair', 'summary.rejudge.json', {
        runId: 'pair-rejudge',
        arms,
        rejudge: { judge_prompt_version: 'judge-prompt.3' },
        judgedRows,
      });
      const run = loadRun(dir);
      expect(run.rejudge.judge_prompt_version).toBe(rejudgeJudgePromptStamp(run.summary));
      expect(run.rejudge.judge_prompt_version).toBe('judge-prompt.3');
    });
  });
});

// ---- grouping: one definition, grid.mjs's regimeIdentity ----------------------

describe('groupByRegime: groups by the composer\'s own regime identity', () => {
  it('two files sharing the regime land in ONE group; a different answerer box splits the group', () => {
    const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
    writeBankedFile('run-a', 'summary.json', { runId: 'run-a', arms });
    writeBankedFile('run-b', 'summary.json', { runId: 'run-b', arms });
    writeBankedFile('run-c', 'summary.json', {
      runId: 'run-c',
      arms,
      regime: { answerer: { url_host: 'localhost:8780' } }, // the SAME model on the Mac — another regime
    });
    const groups = groupByRegime(collectRunFiles(resultsDir));
    expect(groups).toHaveLength(2);
    const big = groups.find((g) => g.entries.length === 2);
    expect(big.entries.map((e) => e.runId).sort()).toEqual(['run-a', 'run-b']);
    expect(big.label).toContain('qwen3.8:27b @ desktop-1uiqnip:11434');
    expect(groups.find((g) => g.entries.length === 1).entries[0].runId).toBe('run-c');
  });

  it('the judge prompt version splits groups (v2 beside v3 is NOT one regime)', () => {
    const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
    writeBankedFile('224225', 'summary.rejudge.json', { runId: '224225-v2', arms });
    writeBankedFile('224225', 'summary.rejudge-v3.json', {
      runId: '224225-v3',
      arms,
      rejudge: { judge_prompt_version: 'judge-prompt.3' },
    });
    const groups = groupByRegime(collectRunFiles(resultsDir));
    expect(groups).toHaveLength(2);
    const labels = groups.map((g) => g.label);
    // order follows dir/file sort (the tagged pass sorts before the unsuffixed
    // pair), so pin membership, not order
    expect(labels.some((l) => l.includes('judge prompt judge-prompt.2'))).toBe(true);
    expect(labels.some((l) => l.includes('judge prompt judge-prompt.3'))).toBe(true);
  });
});

// ---- the headline: rendered from the files, never typed -----------------------

describe('headline: per-type tallies + write decisions from the run\'s own files', () => {
  it('the 224225 shape: p1 + per-type cells from the paired judged file + write totals from the rows file', () => {
    const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
    const judgedRows = [
      judgedRow({ question_type: 'knowledge-update', label: 'exact' }),
      judgedRow({ question_type: 'knowledge-update', label: 'wrong', question_id: 'q2' }),
      judgedRow({ question_type: 'single-session-assistant', label: 'exact', question_id: 'q3' }),
      judgedRow({ question_type: 'temporal-reasoning', label: 'wrong', question_id: 'q4' }),
    ];
    const rows = [
      writeDecisionsRow(13500, 200, 200),
      writeDecisionsRow(5, 20, 30),
    ];
    writeBankedFile('224225', 'summary.rejudge.json', { runId: '224225-rejudge', arms, judgedRows, rowsByArm: { 'mycelium-timeline': rows } });
    const entry = collectRunFiles(resultsDir)[0];
    const h = headline(entry);
    expect(h).toContain('mycelium-timeline: p1 0.400 (20/0/30 of 50)');
    expect(h).toContain('knowledge-update 1/2');
    expect(h).toContain('single-session-assistant 1/1');
    expect(h).toContain('temporal-reasoning 0/1');
    expect(h).toContain('write: ADD 13,505 / SUP 220 / KEEP 230 (13,955 candidates over 2 rows)');
  });

  it('the tagged pass reads ITS OWN judged file, not the unsuffixed pair\'s', () => {
    const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
    writeBankedFile('224225', 'summary.rejudge.json', {
      runId: '224225-v2',
      arms,
      judgedRows: [judgedRow({ question_type: 'temporal-reasoning', label: 'exact' })],
    });
    writeBankedFile('224225', 'summary.rejudge-v3.json', {
      runId: '224225-v3',
      arms,
      rejudge: { judge_prompt_version: 'judge-prompt.3' },
      judgedRows: [judgedRow({ question_type: 'knowledge-update', label: 'exact' })],
    });
    const entries = collectRunFiles(resultsDir);
    expect(headline(entries.find((e) => e.runId === '224225-v2'))).toContain('temporal-reasoning 1/1');
    expect(headline(entries.find((e) => e.runId === '224225-v3'))).toContain('knowledge-update 1/1');
    expect(headline(entries.find((e) => e.runId === '224225-v3'))).not.toContain('temporal-reasoning');
  });

  it('a run whose judged file is missing still renders its p1 (the summary is banked evidence too)', () => {
    writeBankedFile('d', 'summary.json', { runId: 'd', arms: { none: armScore(50, 1, 2, 47) } });
    const h = headline(collectRunFiles(resultsDir)[0]);
    expect(h).toContain('none: p1 0.040 (1/2/47 of 50)'); // (1 + 0.5·2)/50
    expect(h).not.toContain('write:');
  });
});

describe('writeDecisions / resolveEmbedder / thinkingStamp', () => {
  it('writeDecisions sums meta.write_decisions and reports null when the rows file carries none', () => {
    const dir = writeBankedFile('d', 'summary.json', { runId: 'd', arms: {} });
    expect(writeDecisions(dir, 'mycelium-timeline')).toBeNull(); // no rows file at all
    fs.writeFileSync(
      path.join(dir, 'mycelium-timeline.rows.jsonl'),
      [JSON.stringify(writeDecisionsRow(3, 1, 2)), JSON.stringify({ meta: {} })].join('\n') + '\n'
    );
    expect(writeDecisions(dir, 'mycelium-timeline')).toEqual({ adds: 3, supersedes: 1, keeps: 2, candidates: 6, rows_with_decisions: 1 });
  });

  it('the embedder resolves platform-first, then the sidecar blocks, then a dash', () => {
    expect(resolveEmbedder({ platform: { url_host: 'jetson01.local:3002', embedding_provider: 'ollama', embedding_model: 'nomic-embed-text' } })).toContain('nomic-embed-text (platform ollama @ jetson01.local:3002)');
    expect(resolveEmbedder({ platform: { url_host: null }, mem0: { embedder: { model: 'nomic-embed-text', base_url_host: 'jetson01.local:11434', dims: 768 } } })).toContain('nomic-embed-text (mem0 sidecar @ jetson01.local:11434, 768d)');
    expect(resolveEmbedder({})).toBe('—');
  });

  it('the thinking stamp reads the extraction blocks; no extraction arms → a dash', () => {
    expect(thinkingStamp({ mycelium_timeline: { extraction_thinking: 'off' }, mem0: { extraction_thinking: 'off' } })).toBe('timeline:off mem0:off');
    expect(thinkingStamp({})).toBe('—');
  });
});

// ---- task 333-F3: the generation stamp is DERIVED, not the wall clock ----------

describe('generatedFromRuns: the table regenerates byte-identical (no wall clock)', () => {
  it('the stamp is the NEWEST banked run file\'s own date_utc, unreadable entries excluded', () => {
    const arms = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
    writeBankedFile('run-old', 'summary.json', {
      runId: 'run-old',
      arms,
      regime: { date_utc: '2026-09-09T19:50:34Z' },
    });
    writeBankedFile('run-new', 'summary.json', {
      runId: 'run-new',
      arms,
      regime: { date_utc: '2026-09-19T14:10:07Z' },
    });
    // an unreadable summary must not feed the stamp
    fs.mkdirSync(path.join(resultsDir, 'smoke'), { recursive: true });
    fs.writeFileSync(path.join(resultsDir, 'smoke', 'summary.json'), '{not json');

    const entries = collectRunFiles(resultsDir);
    expect(generatedFromRuns(entries)).toBe('2026-09-19T14:10:07Z'); // content-derived, insertion order irrelevant
    expect(generatedFromRuns([...entries].reverse())).toBe('2026-09-19T14:10:07Z');
  });

  it('no banked run stamps a date -> a named placeholder, never a clock read', () => {
    expect(generatedFromRuns(collectRunFiles(path.join(root, 'nope')))).toBe('no banked run stamps a date_utc');
  });
});

// ---- the composed-grid audit ---------------------------------------------------

describe('auditGridReceipts: which regimes did each grid cite?', () => {
  const ARMS = { 'mycelium-timeline': armScore(50, 20, 0, 30) };
  const ROWS = [judgedRow(), judgedRow({ question_id: 'q2', label: 'wrong' })];

  it('a one-regime grid says one regime; a cross-regime citation is MIXED naming the field; a gone run file is UNVERIFIABLE', () => {
    writeBankedFile('run-a', 'summary.json', { runId: 'run-a', arms: ARMS, judgedRows: ROWS });
    writeBankedFile('run-b', 'summary.json', { runId: 'run-b', arms: ARMS, judgedRows: ROWS });
    writeBankedFile('run-c', 'summary.json', {
      runId: 'run-c',
      arms: ARMS,
      judgedRows: ROWS,
      regime: { answerer: { url_host: 'localhost:8780' } },
    });
    writeGridReceipt('run-a+run-b-grid.md', ['run-a', 'run-b']);
    writeGridReceipt('run-a+run-c-grid.md', ['run-a', 'run-c']);
    writeGridReceipt('run-a+gone-grid.md', ['run-a', '2026-09-11-p1-gone']);

    const audits = auditGridReceipts(receiptsDir, collectRunFiles(resultsDir));
    expect(audits).toHaveLength(3);
    const byFile = new Map(audits.map((a) => [path.basename(a.file), a]));
    expect(byFile.get('run-a+run-b-grid.md').mixed).toEqual([]);
    expect(byFile.get('run-a+run-c-grid.md').mixed.map((d) => d.key)).toEqual(['regime.answerer.url_host']);
    expect(byFile.get('run-a+gone-grid.md').unverifiable).toEqual(['2026-09-11-p1-gone']);
  });

  it('a parsed summary that is not a LOADABLE run is named in the audit — never a silent "one regime" over an uncompared pair', () => {
    writeBankedFile('good', 'summary.json', { runId: 'good', arms: ARMS, judgedRows: ROWS });
    // judged.jsonl deliberately missing: the summary parses but loadRun refuses
    writeBankedFile('blind', 'summary.json', { runId: 'blind', arms: ARMS });
    writeGridReceipt('pair-grid.md', ['good', 'blind']);
    const audits = auditGridReceipts(receiptsDir, collectRunFiles(resultsDir));
    expect(audits[0].mixed).toEqual([]);
    expect(audits[0].unloadable.length).toBe(1);
    expect(audits[0].unloadable[0]).toContain('blind');
  });

  it('a receipt whose cited id resolves to a platform-NULL run beside a stamped run is NOT mixed (the mem0 shape)', () => {
    writeBankedFile('mem0-run', 'summary.json', { runId: 'mem0-run', arms: ARMS, regime: { platform: { url_host: null, version: null } } });
    writeBankedFile('myc-run', 'summary.json', { runId: 'myc-run', arms: ARMS });
    writeGridReceipt('pair-grid.md', ['mem0-run', 'myc-run']);
    const audits = auditGridReceipts(receiptsDir, collectRunFiles(resultsDir));
    expect(audits[0].mixed).toEqual([]);
  });

  it('no receipts dir → no audits (not a throw)', () => {
    expect(auditGridReceipts(path.join(root, 'nope'), [])).toEqual([]);
  });
});

// ---- the real tree -------------------------------------------------------------

describe('against the TRACKED results + receipts (committed evidence)', () => {
  const REAL_RESULTS = path.resolve(path.dirname(fileURL()), '../../bench/memory/results');
  const REAL_RECEIPTS = path.resolve(path.dirname(fileURL()), '../../bench/memory/receipts');

  it('every banked run file is collected (20 at the time of writing — grows as runs are banked)', () => {
    const entries = collectRunFiles(REAL_RESULTS);
    expect(entries.length).toBeGreaterThanOrEqual(20);
    expect(entries.every((e) => e.kind !== 'unreadable')).toBe(true);
    const groups = groupByRegime(entries);
    expect(groups.length).toBeGreaterThanOrEqual(10);
  });

  it('the 330 survey\'s numbers render from the 224225 v2 pair under the 3090 regime', () => {
    const entry = collectRunFiles(REAL_RESULTS).find((e) => e.runId === '2026-09-17-p1-224225-rejudge');
    expect(entry).toBeTruthy();
    const h = headline(entry);
    expect(h).toContain('mycelium-timeline: p1 0.400 (20/0/30 of 50)');
    expect(h).toContain('knowledge-update 8/15');
    expect(h).toContain('single-session-assistant 5/5');
    expect(h).toContain('temporal-reasoning 2/5');
    expect(h).toContain('write: ADD 13,505 / SUP 220 / KEEP 230 (13,955 candidates over 50 rows)');
    const label = groupByRegime([entry])[0].label;
    expect(label).toContain('qwen3.8:27b @ desktop-1uiqnip:11434'); // the 3090, not the Mac
    expect(label).toContain('judge prompt judge-prompt.2');
  });

  it('the four committed grid receipts audit clean-or-named: no MIXED pair, the evidence-gone citations named', () => {
    const audits = auditGridReceipts(REAL_RECEIPTS, collectRunFiles(REAL_RESULTS));
    const KNOWN = [
      '2026-09-09-p1-195034+2026-09-10-p1-001549-grid.md',
      '2026-09-09-p1-195034+2026-09-10-p1-001549+2026-09-11-p1-025039-grid.md',
      '2026-09-09-p1-195034+2026-09-10-p1-001549+2026-09-11-p1-123327-grid.md',
      '2026-09-17-p1-224225-rejudge+2026-09-09-p1-195034-grid.md',
    ];
    const known = audits.filter((a) => KNOWN.includes(path.basename(a.file)));
    expect(known).toHaveLength(4);
    expect(known.every((a) => a.mixed.length === 0)).toBe(true);
    expect(known.every((a) => a.unloadable.length === 0)).toBe(true);
    const unverifiable = known.flatMap((a) => a.unverifiable);
    expect(unverifiable).toEqual(
      expect.arrayContaining(['2026-09-11-p1-025039', '2026-09-11-p1-123327'])
    );
  });
});

function fileURL() {
  return import.meta.url.replace(/^file:\/\//, '');
}

// task 183 — the grid receipt composed from SEPARATE runs (bench/memory/grid.mjs).
// Hermetic: fixture run dirs in a tmp root; the one real-dir test reads the
// TRACKED results dir 2026-09-08-p1-185920 (committed with the run's evidence),
// paired against a hermetic n=1 controls fixture in the shape of the real
// 2026-09-09-p1-172043 controls run (the pair must refuse).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTRACT_ARM_STAMPED, renderReceipt, timelineCostLine } from '../../bench/memory/receipt.mjs';

import {
  COMPARABILITY_KEYS,
  GridInputError,
  GridRefusal,
  allowedDifferences,
  assertComparable,
  buildUnion,
  composeGrid,
  effectiveJudgePromptVersion,
  effectiveN,
  findDifferences,
  flattenRegime,
  loadRun,
  renderGridReceipt,
  unionArms,
  writeCap,
  HANDLABELS_DIR,
} from '../../bench/memory/grid.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_N50_DIR = path.join(REPO_ROOT, 'bench/memory/results/2026-09-08-p1-185920');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-memory-grid-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- fixtures ---------------------------------------------------------------

const BASE_REGIME = {
  date_utc: '2026-09-09T18:25:30Z',
  git_sha: 'sha-a',
  git_dirty: false,
  harness: 'p1-skeleton.1',
  dataset: {
    name: 'LongMemEval-S (cleaned)',
    file: 'longmemeval_s_cleaned.json',
    sha256: 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442',
    licence: 'MIT',
    url: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json',
    items_available: 500,
    citation: 'Wu et al.',
  },
  answerer: { model: 'qwen3.8:27b', url_host: 'desktop-1uiqnip:11434', temperature: 0, max_tokens: 4096 },
  judge: { model: 'Laguna-XS-2.1-mlx-oq4e-agentic-ours', url_host: 'localhost:8780', judge_prompt_version: 'judge-prompt.2' },
  retrieval: {
    budget: 5,
    chunking: 'one memory row per haystack session',
    source_type: 'bench_longmemeval',
    namespace: 'bench-p1-RUN',
    server_mode: 'hybrid (server-side)',
  },
  platform: { url_host: 'jetson01.local:3002', version: '0.1.0' },
  n: 2,
  selection_rule: 'sort by question_id ascending, take first n (deterministic, stable across runs)',
  notes: [
    '3090 slot lock held: 1/2 served slots (served_slots 2); a run never shares a slot with another client',
    'mycelium-extract = the EXTRACTION control for the Mycelium column: the answerer model extracts a fact list per session, THINKING OFF via chat_template_kwargs',
    'judge is a local model; validated against a hand-scored set — see receipt judge-validation section',
  ],
};

function armEntry(n, exact, partial, wrong) {
  return {
    n,
    elapsed_ms: 42000,
    score: {
      n,
      counts: { exact, partial, wrong },
      unparsed: 0,
      p1_score: (exact + 0.5 * partial) / n,
    },
  };
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

// One fixture run dir. questionIds: judged rows for every arm × question.
function writeFixtureRun(name, { runId, arms, writeInfo, questionIds, questionType = 'single-session-user', regime = {}, topCap = null, cleanup = null, summaryPatch = null }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const fullRegime = deepMerge(
    deepMerge(BASE_REGIME, { retrieval: { namespace: `bench-p1-${runId}` }, n: questionIds.length }),
    regime
  );
  const summary = {
    run_id: runId,
    n: questionIds.length,
    regime: fullRegime,
    arms,
    write_info: writeInfo,
    ...(cleanup ? { cleanup } : {}),
    ...(topCap !== null ? { max_sessions_per_question: topCap } : {}),
    ...(summaryPatch ?? {}),
    commands: [`node bench/memory/run.mjs --split longmemeval --arms ${Object.keys(arms).join(',')} --n ${questionIds.length} --receipt`],
  };
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const rows = [];
  for (const [arm] of Object.entries(arms)) {
    for (const qid of questionIds) {
      rows.push({ question_id: qid, arm, question_type: questionType, gold: 'a year', answer: 'I do not know.', label: 'wrong', judge_raw: 'WRONG', judge_had_think: false });
    }
  }
  fs.writeFileSync(path.join(dir, 'judged.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

// The matching pair in the shape of the live 3090 window: run A carries the
// Mem0 column (mem0 = extract, mem0-raw = raw), run B the Mycelium column.
function writeMatchingPair({ regimeA = {}, regimeB = {}, cleanupA = null, cleanupB = null, topCapA = null, topCapB = null } = {}) {
  const dirA = writeFixtureRun('run-a', {
    runId: 'run-a',
    arms: { mem0: armEntry(2, 1, 0, 1), 'mem0-raw': armEntry(2, 1, 1, 0) },
    writeInfo: { mem0: { docs: 5, rows: 21, parse_failures: 1 }, 'mem0-raw': { docs: 5, rows: 41 } },
    questionIds: ['q1', 'q2'],
    regime: regimeA,
    cleanup: cleanupA,
    topCap: topCapA,
  });
  const dirB = writeFixtureRun('run-b', {
    runId: 'run-b',
    arms: { mycelium: armEntry(2, 2, 0, 0), 'mycelium-extract': armEntry(2, 1, 1, 0) },
    writeInfo: { mycelium: { docs: 4, rows: 4 }, 'mycelium-extract': { docs: 4, rows: 30, facts: 30, facts_counts: [10, 5, 9, 6], extract_ms: 80_000 } },
    questionIds: ['q1', 'q2'],
    regime: { git_sha: 'sha-b', date_utc: '2026-09-09T18:35:48Z', ...regimeB },
    cleanup: cleanupB,
    topCap: topCapB,
  });
  return [dirA, dirB];
}

function receiptsDir() {
  return path.join(root, 'receipts');
}

// The task-225 run shape (the real 09-17 runs): each run carries ONLY the
// timeline arm, its regime stamping facts_layer to name the store it measured
// (results/2026-09-17-p1-203802 = memory-rows, 2026-09-17-p1-204603 = am_facts).
// factsLayer null = an old-regime run (predates the 206 stamp, bare name).
function writeTimelineRun(name, { runId, factsLayer = null, questionIds = ['q1', 'q2', 'q3', 'q4', 'q5'] } = {}) {
  return writeFixtureRun(name, {
    runId,
    arms: { 'mycelium-timeline': armEntry(questionIds.length, 0, 0, questionIds.length) },
    writeInfo: { 'mycelium-timeline': { docs: 100, rows: 900, extract_ms: 50_000, reconcile_ms: 900_000 } },
    questionIds,
    questionType: 'knowledge-update',
    regime: factsLayer
      ? { mycelium_timeline: { facts_layer: factsLayer, reconciled: { namespace: `bench-p1-${runId}-timeline` } } }
      : {},
  });
}

// ---- the matching pair -------------------------------------------------------

describe('composeGrid: a comparable pair composes the grid receipt', () => {
  let dirs;

  beforeEach(() => {
    dirs = writeMatchingPair();
  });

  it('writes ONE receipt named <idA>+<idB>-grid.md and reports the union grid', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    expect(out.runIds).toEqual(['run-a', 'run-b']);
    expect(out.gridRendered).toBe(true);
    expect(out.file).toBe(path.join(receiptsDir(), 'run-a+run-b-grid.md'));
    expect(fs.existsSync(out.file)).toBe(true);
  });

  it('the 2×2 is renderIngestionGrid over the union — all four arms in their cells', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('## Ingestion controls ({Mycelium, Mem0} × {raw, extract})');
    expect(md).toContain('| system \\ ingestion | raw | extract |');
    // row-wise cells: Mycelium = raw mycelium / extract mycelium-extract; Mem0 = raw mem0-raw / extract mem0
    expect(md).toContain('| Mycelium | 1.000 (2/0/0) | 0.750 (1/1/0) |');
    expect(md).toContain('| Mem0 | 0.750 (1/1/0) | 0.500 (1/0/1) |');
    // the renderer's own facts-per-session line survives the composition
    expect(md).toContain('Facts per session (mycelium-extract): 30 facts over 4 sessions — mean 7.50, min 5, max 10.');
  });

  it('every arm of every run gets a scores row, tagged with its run', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('| arm | run | n | exact | partial | wrong | p1_score |');
    expect(md).toContain('| mem0 | run-a | 2 | 1 | 0 | 1 | 0.500 |');
    expect(md).toContain('| mem0-raw | run-a | 2 | 1 | 1 | 0 | 0.750 |');
    expect(md).toContain('| mycelium | run-b | 2 | 2 | 0 | 0 | 1.000 |');
    expect(md).toContain('| mycelium-extract | run-b | 2 | 1 | 1 | 0 | 0.750 |');
  });

  it('per-run provenance carries run id, git sha, harness, generated_at, slot-lock and thinking-off notes', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('## Per-run provenance');
    expect(md).toContain('### run-a');
    expect(md).toContain('### run-b');
    expect(md).toContain('- git: `sha-a`');
    expect(md).toContain('- git: `sha-b`');
    expect(md).toMatch(/run-a[\s\S]*- harness: p1-skeleton\.1/);
    expect(md).toMatch(/run-a[\s\S]*- generated_at: 2026-09-09T18:25:30Z/);
    expect(md).toMatch(/run-b[\s\S]*- generated_at: 2026-09-09T18:35:48Z/);
    expect(md).toContain('- slot lock: 3090 slot lock held: 1/2 served slots');
    expect(md).toContain('- thinking: mycelium-extract = the EXTRACTION control');
  });

  it('ingestion stats per arm: facts per session + seconds per add where stamped, absent where not', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('## Ingestion stats per arm');
    // mycelium-extract stamps extract_ms + docs → s/session is their quotient
    expect(md).toContain('Seconds per add (stamped extract_ms 80000 ms / 4 docs): 20.00 s/session.');
    // mem0 logs per-add timing but does not stamp it — absence stays honest
    expect(md).toContain('mem0 (run-a): docs 5, rows 21. Ingestion loss: 1 of 5 sessions dropped by the extractor (reply unparseable) (20.0%). Seconds per add: not stamped.');
    expect(md).toContain('mem0-raw (run-a): docs 5, rows 41.');
    // ingestion loss: mem0 stamps the sessions its extractor dropped; the raw arm has no extractor
    expect(md).not.toContain('mem0-raw (run-a): docs 5, rows 41. Ingestion loss');
  });

  it('the comparability table names every checked key with the shared value', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('## Comparability (checked, all equal)');
    for (const [key] of COMPARABILITY_KEYS) {
      expect(md).toContain(`| ${key} |`);
    }
    expect(md).toContain('| question_ids | 2 ids (identical set across runs; order ignored) |');
  });

  it('allowed differences lists regime keys that differ but not comparability keys', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('## Differences that were allowed');
    expect(md).toContain('- retrieval.namespace: run-a=bench-p1-run-a | run-b=bench-p1-run-b');
    expect(md).toContain('- date_utc: run-a=2026-09-09T18:25:30Z | run-b=2026-09-09T18:35:48Z');
    expect(md).toContain('- git_sha: run-a=sha-a | run-b=sha-b');
    // a comparability key never appears as an allowed difference
    expect(md).not.toMatch(/- dataset\.sha256:/);
    expect(md).not.toMatch(/- answerer\.model:/);
  });

  it('the exact command reproduces the grid from the two result dirs', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('```bash');
    expect(md).toContain(`node bench/memory/run.mjs --grid-from-results ${dirs[0]},${dirs[1]} --receipt`);
  });

  it('dry run (write:false) checks and writes nothing', () => {
    const out = composeGrid({ dirs, generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir(), write: false });
    expect(out.file).toBeNull();
    expect(fs.existsSync(receiptsDir())).toBe(false);
  });
});

// ---- refusals: every comparability key --------------------------------------

describe('composeGrid: refuses loudly on every incomparability', () => {
  beforeEach(() => {
    writeMatchingPair();
  });

  const OVERRIDES = {
    'dataset.name': { regime: { dataset: { name: 'SomeOtherDataset' } } },
    'dataset.sha256': { regime: { dataset: { sha256: 'deadbeef' } } },
    'judge.model': { regime: { judge: { model: 'other-judge' } } },
    'judge.judge_prompt_version': { regime: { judge: { judge_prompt_version: 'judge-prompt.1' } } },
    'answerer.model': { regime: { answerer: { model: 'other-answerer' } } },
    'answerer.max_tokens': { regime: { answerer: { max_tokens: 256 } } },
    'retrieval.budget': { regime: { retrieval: { budget: 10 } } },
    // n is read from summary.n (the regime mirror is the fallback)
    n: { summary: { n: 7 } },
  };

  for (const [key, patch] of Object.entries(OVERRIDES)) {
    it(`mismatched ${key} refuses, naming the key with both runs' values, and writes no receipt`, () => {
      // the fixture pair exists with matching runs; rebuild run B with the mismatch
      fs.rmSync(path.join(root, 'run-b'), { recursive: true, force: true });
      const dirA = path.join(root, 'run-a');
      const dirB = writeFixtureRun('run-b', {
        runId: 'run-b',
        arms: { mycelium: armEntry(2, 2, 0, 0), 'mycelium-extract': armEntry(2, 1, 1, 0) },
        writeInfo: {},
        questionIds: ['q1', 'q2'],
        regime: { git_sha: 'sha-b', ...(patch.regime ?? {}) },
        summaryPatch: patch.summary ?? null,
      });
      let err = null;
      try {
        composeGrid({ dirs: [dirA, dirB], generatedAt: '2026-09-09T19:00:00Z', receiptsDir: receiptsDir() });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GridRefusal);
      expect(err.message).toContain('runs are not comparable — no grid receipt written');
      expect(err.message).toMatch(new RegExp(`^  ${key.replace(/\./g, '\\.')}: `, 'm'));
      expect(err.message).toContain('run-a=');
      expect(err.message).toContain('run-b=');
      // a refused grid leaves NO receipt behind
      expect(fs.existsSync(receiptsDir())).toBe(false);
    });
  }

  it('mismatched question-id sets refuse, naming sizes and the symmetric difference', () => {
    const [dirA] = writeMatchingPair();
    fs.rmSync(path.join(root, 'run-b'), { recursive: true, force: true });
    const dirB = writeFixtureRun('run-b2', {
      runId: 'run-b2',
      arms: { mycelium: armEntry(2, 2, 0, 0), 'mycelium-extract': armEntry(2, 1, 1, 0) },
      writeInfo: {},
      questionIds: ['q2', 'q9'],
    });
    let err = null;
    try {
      composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GridRefusal);
    expect(err.message).toMatch(/question_ids: run-a=2 ids \| run-b2=2 ids \(symmetric difference 2: q1, q9\)/);
    expect(err.message).toContain('compared as sets; order does not matter');
  });

  it('an arm appearing in both runs refuses (the union would quote it twice)', () => {
    const dirA = writeFixtureRun('run-x', {
      runId: 'run-x',
      arms: { mem0: armEntry(2, 1, 0, 1) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    const dirB = writeFixtureRun('run-y', {
      runId: 'run-y',
      arms: { mem0: armEntry(2, 2, 0, 0), mycelium: armEntry(2, 2, 0, 0) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(
      /duplicate_arm[\s\S]*run-x='mem0' \| run-y='mem0'/
    );
  });

  it('an arm that judged fewer questions than its run refuses (hidden n)', () => {
    const made = writeFixtureRun('run-partial', {
      runId: 'run-partial',
      arms: { mycelium: armEntry(2, 2, 0, 0), 'mycelium-extract': armEntry(2, 1, 1, 0) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    // drop one judged row of the extract arm → the arm's set no longer covers the run's
    const lines = fs.readFileSync(path.join(made, 'judged.jsonl'), 'utf8').trim().split('\n');
    const kept = lines.filter((l) => !(JSON.parse(l).arm === 'mycelium-extract' && JSON.parse(l).question_id === 'q2'));
    fs.writeFileSync(path.join(made, 'judged.jsonl'), kept.join('\n') + '\n');
    const other = writeFixtureRun('run-whole', {
      runId: 'run-whole',
      arms: { mem0: armEntry(2, 1, 0, 1), 'mem0-raw': armEntry(2, 1, 1, 0) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    expect(() => composeGrid({ dirs: [other, made], generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(
      /question_ids\.by_arm\[mycelium-extract\][\s\S]*judged 1 of 2 questions/
    );
  });

  it('a dir without summary.json (run in flight or crashed) refuses before comparing', () => {
    const dirA = writeFixtureRun('run-ok', { runId: 'run-ok', arms: { mem0: armEntry(2, 1, 0, 1) }, writeInfo: {}, questionIds: ['q1', 'q2'] });
    const dirB = path.join(root, 'run-inflight');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'judged.jsonl'), '');
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(
      GridInputError
    );
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(/no summary\.json/);
  });

  it('a dir without judged.jsonl refuses (question ids cannot be checked)', () => {
    const dirA = writeFixtureRun('run-ok2', { runId: 'run-ok2', arms: { mem0: armEntry(2, 1, 0, 1) }, writeInfo: {}, questionIds: ['q1', 'q2'] });
    const dirB = path.join(root, 'run-nojudged');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'summary.json'), JSON.stringify({ run_id: 'run-nojudged', n: 2, regime: BASE_REGIME, arms: {} }));
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(/no judged\.jsonl/);
  });

  it('fewer than two dirs refuses', () => {
    expect(() => composeGrid({ dirs: [path.join(root, 'run-a')], generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(
      /at least two run dirs/
    );
  });
});

// ---- capped / unclean runs are NOT quotable ---------------------------------

describe('composeGrid: a capped or unclean run is flagged in bold at the top', () => {
  it('a capped write phase (regime.write.max_sessions_per_question) bolds the warning', () => {
    const [dirA, dirB] = writeMatchingPair({
      regimeB: { write: { max_sessions_per_question: 5 } },
      topCapB: 5,
    });
    const out = composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain(
      '**NOT A QUOTABLE GRID: run-b write phase CAPPED at 5 sessions/question (regime.write.max_sessions_per_question).'
    );
    expect(md).toContain('A capped or unclean run is not a quotable grid.**');
    // the warning sits at the TOP — before the scores section
    expect(md.indexOf('**NOT A QUOTABLE GRID')).toBeLessThan(md.indexOf('## Scores'));
  });

  it('a cleanup that left rows indexed bolds the warning', () => {
    const [dirA, dirB] = writeMatchingPair({
      cleanupA: { namespaces: ['ns'], deleted: 100, rows_remaining_after: 3, kept: false },
    });
    const out = composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain(
      '**NOT A QUOTABLE GRID: run-a platform cleanup left 3 rows indexed (cleanup.rows_remaining_after).'
    );
  });

  it('a clean, uncapped pair carries no warning', () => {
    const [dirA, dirB] = writeMatchingPair({
      cleanupA: { deleted: 21, rows_remaining_after: 0, kept: false },
      cleanupB: { deleted: 30, rows_remaining_after: 0, kept: false },
    });
    const out = composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).not.toContain('NOT A QUOTABLE GRID');
  });

  it('writeCap reads the cap from regime.write or the top-level mirror', () => {
    expect(writeCap({ regime: { write: { max_sessions_per_question: 5 } } })).toBe(5);
    expect(writeCap({ max_sessions_per_question: 5 })).toBe(5);
    expect(writeCap({ regime: {} })).toBeNull();
    expect(writeCap({})).toBeNull();
  });
});

// ---- the union does not always make a 2×2 -----------------------------------

describe('composeGrid: a union without all four grid arms says so instead of drawing', () => {
  it('the receipt names the missing arm(s) and reports gridRendered false', () => {
    const dirA = writeFixtureRun('run-none', {
      runId: 'run-none',
      arms: { none: armEntry(2, 0, 0, 2), mycelium: armEntry(2, 2, 0, 0) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    const dirB = writeFixtureRun('run-mem0s', {
      runId: 'run-mem0s',
      arms: { mem0: armEntry(2, 1, 0, 1), 'mem0-raw': armEntry(2, 1, 1, 0) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    const out = composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() });
    expect(out.gridRendered).toBe(false);
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('The 2×2 is NOT rendered — the union of these runs is missing grid arm(s): mycelium-extract.');
  });
});

// ---- helpers -----------------------------------------------------------------

describe('grid helpers', () => {
  it('loadRun returns the run id, the judged id set, and the per-arm sets', () => {
    const dir = writeFixtureRun('run-load', {
      runId: 'run-load',
      arms: { mem0: armEntry(2, 1, 0, 1) },
      writeInfo: {},
      questionIds: ['q2', 'q1'],
    });
    const run = loadRun(dir);
    expect(run.runId).toBe('run-load');
    expect([...run.judgedIds].sort()).toEqual(['q1', 'q2']);
    expect(run.judgedIdsByArm.mem0.size).toBe(2);
  });

  it('unionArms puts the four grid arms in row-wise order, extras after', () => {
    const runs = [{ summary: { arms: { none: {}, mem0: {}, 'mem0-raw': {}, mycelium: {}, 'mycelium-extract': {} } } }];
    expect(unionArms(runs)).toEqual(['mycelium', 'mycelium-extract', 'mem0-raw', 'mem0', 'none']);
  });

  it('buildUnion merges arms and write_info across runs', () => {
    const [a, b] = writeMatchingPair();
    const runs = [loadRun(a), loadRun(b)];
    const { armsUnion, writeUnion } = buildUnion(runs);
    expect(Object.keys(armsUnion).sort()).toEqual(['mem0', 'mem0-raw', 'mycelium', 'mycelium-extract']);
    expect(writeUnion['mycelium-extract'].extract_ms).toBe(80_000);
  });

  it('flattenRegime reduces nested regime objects to dotted leaves (arrays stay leaves)', () => {
    const flat = flattenRegime({ a: { b: 1, c: null }, d: [1, 2], e: 'x' });
    expect(flat).toEqual({ 'a.b': 1, 'a.c': null, d: [1, 2], e: 'x' });
  });

  it('allowedDifferences compares flattened regimes and skips comparability paths', () => {
    const [a, b] = writeMatchingPair();
    const runs = [loadRun(a), loadRun(b)];
    const allowed = allowedDifferences(runs);
    const paths = allowed.map((d) => d.path);
    expect(paths).toContain('date_utc');
    expect(paths).toContain('git_sha');
    expect(paths).toContain('retrieval.namespace');
    expect(paths).not.toContain('n');
    expect(paths).not.toContain('dataset.name');
    expect(paths).not.toContain('answerer.max_tokens');
  });

  it('assertComparable passes a matching pair and throws on a broken one', () => {
    const [a, b] = writeMatchingPair();
    expect(assertComparable([loadRun(a), loadRun(b)])).toBe(true);
    expect(() => assertComparable([loadRun(a)])).toThrow();
  });
});

// ---- the real refusal path (tracked evidence dir vs a controls fixture) ------

describe('composeGrid against the REAL n=50 run dir', () => {
  it('2026-09-08-p1-185920 (n=50 none,mycelium) vs an n=1 controls fixture refuses on n + question_ids', () => {
    // the results dir is tracked with the run's evidence — its absence means the checkout is broken
    expect(fs.existsSync(path.join(REAL_N50_DIR, 'summary.json'))).toBe(true);
    const controls = writeFixtureRun('controls-fixture', {
      runId: '2026-09-09-p1-172043-shaped',
      arms: { 'mem0-raw': armEntry(1, 0, 0, 1), 'mycelium-extract': armEntry(1, 0, 0, 1) },
      writeInfo: {},
      questionIds: ['001be529'],
      regime: { write: { max_sessions_per_question: 5 } },
      topCap: 5,
    });
    let err = null;
    try {
      composeGrid({ dirs: [REAL_N50_DIR, controls], generatedAt: 'x', receiptsDir: receiptsDir() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GridRefusal);
    expect(err.message).toContain('n: 2026-09-08-p1-185920=50 | 2026-09-09-p1-172043-shaped=1');
    expect(err.message).toMatch(/question_ids: 2026-09-08-p1-185920=50 ids \| 2026-09-09-p1-172043-shaped=1 ids/);
    // the banked run predates the judge_prompt_version stamp — an ABSENT stamp
    // is itself an incomparability (the same judge prompt cannot be proven)
    expect(err.message).toContain(
      'judge.judge_prompt_version: 2026-09-08-p1-185920=<absent> | 2026-09-09-p1-172043-shaped=judge-prompt.2'
    );
    // dataset/answerer/budget all MATCH (same regime) — only n, the id sets and the missing stamp differ
    expect(err.message).not.toMatch(/dataset\./);
    expect(err.message).not.toMatch(/answerer\./);
    expect(err.message).not.toMatch(/retrieval\./);
    expect(fs.existsSync(receiptsDir())).toBe(false);
  });
});

// ---- the timeline arm's write-cost line (task 188, deliverable 3) -----------

describe('the timeline write-cost line — cost ×N of extract; bound ≤ 2×', () => {
  // the r3 timeline run's stamped write stats (results/2026-09-11-p1-025039/summary.json)
  const r3write = { docs: 2355, rows: 21587, extract_ms: 3_056_804, reconcile_ms: 25_823_110 };

  it('EXTRACT_ARM_STAMPED carries provenance for the bound\'s denominator (the extract control\'s n=50 run)', () => {
    expect(EXTRACT_ARM_STAMPED).toEqual({ run_id: '2026-09-10-p1-001549', extract_ms: 11_370_052, docs: 2355 });
  });

  it('timelineCostLine: (extract+reconcile)/docs as a ratio of the extract arm\'s stamped s/session', () => {
    expect(timelineCostLine({ 'mycelium-timeline': r3write })).toBe(
      'Write cost (mycelium-timeline): 12.26 s/session — cost ×2.54 of extract; bound ≤ 2×'
    );
    expect(timelineCostLine({ 'mycelium-timeline': { docs: 100, extract_ms: 50_000 } })).toBe(
      'Write cost (mycelium-timeline): 0.50 s/session — cost ×0.10 of extract; bound ≤ 2×'
    );
  });

  it('no line without timeline write stats (the other arms carry no such bound)', () => {
    expect(timelineCostLine(null)).toBeNull();
    expect(timelineCostLine({ mycelium: { docs: 10, extract_ms: 1000 } })).toBeNull();
    expect(timelineCostLine({ 'mycelium-timeline': { docs: 0, extract_ms: 1000 } })).toBeNull();
  });

  it('renderReceipt prints the line; a run without timeline stats gets none', () => {
    const md = renderReceipt({
      runId: 'r',
      summary: {
        run_id: 'r', regime: { notes: [] },
        arms: { 'mycelium-timeline': { n: 2, score: { counts: { exact: 1, partial: 0, wrong: 1 }, p1_score: 0.5 } } },
        write_info: { 'mycelium-timeline': r3write },
      },
      generatedAt: 'g',
    });
    expect(md).toContain('Write cost (mycelium-timeline): 12.26 s/session — cost ×2.54 of extract; bound ≤ 2×');

    const plain = renderReceipt({
      runId: 'r2',
      summary: {
        run_id: 'r2', regime: { notes: [] },
        arms: { none: { n: 1, score: { counts: { exact: 0, partial: 0, wrong: 1 }, p1_score: 0 } } },
      },
      generatedAt: 'g',
    });
    expect(plain).not.toContain('cost ×');
  });

  it('the grid receipt\'s seconds-per-add includes reconcile_ms when the timeline arm stamps it (it did not before: 12.26 s printed as 1.30 s)', () => {
    const runs = [{
      dir: '/x', runId: 'timeline-run',
      summary: {
        run_id: 'timeline-run', regime: {},
        arms: { 'mycelium-timeline': { n: 1, score: { counts: { exact: 1, partial: 0, wrong: 0 }, p1_score: 1 } } },
        write_info: { 'mycelium-timeline': r3write },
      },
      judgedIds: new Set(['q1']),
      judgedIdsByArm: { 'mycelium-timeline': new Set(['q1']) },
    }];
    const md = renderGridReceipt({ runs, generatedAt: 'g' });
    expect(md).toContain('Seconds per add (stamped extract_ms 3056804 ms + reconcile_ms 25823110 ms / 2355 docs): 12.26 s/session.');
    // an arm without a reconcile stamp keeps the original label
    const runs2 = [{
      ...runs[0], runId: 'extract-run',
      summary: {
        ...runs[0].summary, run_id: 'extract-run',
        arms: { 'mycelium-extract': runs[0].summary.arms['mycelium-timeline'] },
        write_info: { 'mycelium-extract': { docs: 4, rows: 30, extract_ms: 80_000 } },
      },
    }];
    expect(renderGridReceipt({ runs: runs2, generatedAt: 'g' })).toContain(
      'Seconds per add (stamped extract_ms 80000 ms / 4 docs): 20.00 s/session.'
    );
  });
});

// ---- task 224: the grid admits a REJUDGED run --------------------------------
//
// Every judge-prompt bump leaves FINISHED runs holding summary.rejudge.json +
// judged.rejudge.jsonl — and the 2026-09-18 r2 (2026-09-17-p1-224225) holds
// them with NO summary.json at all (the run died after judging; rejudge.mjs
// reconstructed what the evidence could prove). The grid's input contract
// predates that shape and calls a finished, rejudged run "not finished". These
// tests pin the admission: the pair loads, the header names the rejudge with
// its judge-agreement leg, and every downstream check operates unchanged.

// A rejudge fixture dir in the shape rejudge.mjs writes: summary.rejudge.json +
// judged.rejudge.jsonl, NO summary.json — or, with a suffix, the SUFFIXED pair
// (summary.rejudge-<tag>.json + judged.rejudge-<tag>.jsonl) beside whatever the
// dir already holds, exactly what rejudge.mjs --rejudge-suffix <tag> leaves
// (task 229). counts per arm must sum to the question count; questionTypes maps
// question_id -> question_type (optional).
function writeRejudgeFixture(name, { ofRunId, jpv, arms, questionIds, questionTypes = null, regime = {}, summaryPatch = null, suffix = null, answer = 'I do not know.' }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const stem = suffix ? `rejudge-${suffix}` : 'rejudge';
  const fullRegime = deepMerge(
    deepMerge(BASE_REGIME, {
      retrieval: { namespace: `bench-p1-${ofRunId}` },
      n: questionIds.length,
      judge: {
        judge_prompt_version: jpv,
        rejudge: {
          of_run_id: ofRunId,
          date_utc: '2026-09-18T06:00:00Z',
          answers_modified: false,
          note: `labels re-computed from the saved answers (judged.${stem}.jsonl); no answerer or platform calls`,
          ...(suffix ? { suffix } : {}),
        },
      },
    }),
    regime
  );
  const judged = [];
  const armsOut = {};
  for (const [arm, counts] of Object.entries(arms)) {
    const score = {
      n: questionIds.length,
      counts,
      unparsed: 0,
      p1_score: (counts.exact + 0.5 * counts.partial) / questionIds.length,
    };
    armsOut[arm] = { n: questionIds.length, score };
    const labels = [
      ...Array(counts.exact).fill('exact'),
      ...Array(counts.partial).fill('partial'),
      ...Array(counts.wrong).fill('wrong'),
    ];
    questionIds.forEach((qid, i) => {
      judged.push({
        question_id: qid,
        arm,
        question_type: questionTypes?.[qid] ?? 'single-session-user',
        gold: 'a year',
        answer,
        label: labels[i],
        judge_raw: labels[i].toUpperCase(),
        judge_had_think: false,
      });
    });
  }
  const summary = {
    run_id: `${ofRunId}-rejudge${suffix ? `-${suffix}` : ''}`,
    rejudged_from: ofRunId,
    judge_prompt_version: jpv,
    generated_at_utc: '2026-09-18T06:00:00Z',
    n: judged.length,
    regime: fullRegime,
    arms: armsOut,
    original: {
      run_id: ofRunId,
      judge: fullRegime.judge,
      arms: Object.fromEntries(Object.keys(armsOut).map((a) => [a, { n: questionIds.length }])),
    },
    ...(summaryPatch ?? {}),
  };
  fs.writeFileSync(path.join(dir, `summary.${stem}.json`), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(dir, `judged.${stem}.jsonl`), judged.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

function handlabelsDir() {
  return path.join(root, 'handlabels');
}

describe('task 224: the grid admits a rejudged run', () => {
  it('loadRun admits a rejudge pair (summary.json absent) and marks the run from the stamp', () => {
    const dir = writeRejudgeFixture('rej-load', {
      ofRunId: '2026-09-17-p1-224225',
      jpv: 'judge-prompt.2',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    expect(fs.existsSync(path.join(dir, 'summary.json'))).toBe(false);
    const run = loadRun(dir, { handlabelsDir: handlabelsDir() });
    expect(run.runId).toBe('2026-09-17-p1-224225-rejudge');
    // task 229: the rejudge marker carries its pass (null = the unsuffixed
    // default pair) and stem, so renders and the gate can name the pass
    expect(run.rejudge).toMatchObject({
      of_run_id: '2026-09-17-p1-224225',
      judge_prompt_version: 'judge-prompt.2',
      pass: null,
      stem: 'rejudge',
      agreement: null,
    });
    // the judged rows ARE the rejudge pair's rows
    expect(run.judged).toHaveLength(2);
    expect([...run.judgedIds].sort()).toEqual(['q1', 'q2']);
    expect(run.judgedIdsByArm['mycelium-timeline'].size).toBe(2);
  });

  it('loadRun keeps a dir with summary.json PRIMARY even when a rejudge pair sits beside it', () => {
    const dir = writeFixtureRun('primary-with-rejudge', {
      runId: 'prim-run',
      arms: { mem0: armEntry(2, 1, 0, 1) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    // the 2026-09-09/09-10 shape: the rejudge pair lands BESIDE a live summary.json
    writeRejudgeFixture('primary-with-rejudge', {
      ofRunId: 'prim-run',
      jpv: 'judge-prompt.3',
      arms: { mem0: { exact: 0, partial: 0, wrong: 2 } },
      questionIds: ['q1', 'q2'],
    });
    // marker answer written ONLY into the primary's judged.jsonl — if loadRun
    // read the rejudge pair instead, the answers would be the fixture default
    const lines = fs.readFileSync(path.join(dir, 'judged.jsonl'), 'utf8').trim().split('\n');
    fs.writeFileSync(
      path.join(dir, 'judged.jsonl'),
      lines.map((l) => JSON.stringify({ ...JSON.parse(l), answer: 'primary-original-answer' })).join('\n') + '\n'
    );
    const run = loadRun(dir, { handlabelsDir: handlabelsDir() });
    expect(run.runId).toBe('prim-run');
    expect(run.rejudge).toBeNull();
    expect(run.judged.every((r) => r.answer === 'primary-original-answer')).toBe(true); // judged.jsonl, not the pair
  });

  it('a rejudged run + a sibling rejudged run under the SAME judge_prompt_version compose green into ONE grid, header stamped', () => {
    const dirA = writeRejudgeFixture('rej-a', {
      ofRunId: '2026-09-17-p1-224225',
      jpv: 'judge-prompt.2',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    const dirB = writeRejudgeFixture('rej-b', {
      ofRunId: '2026-09-09-p1-195034',
      jpv: 'judge-prompt.2',
      arms: { 'mem0-raw': { exact: 0, partial: 1, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    const out = composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir(), handlabelsDir: handlabelsDir() });
    expect(out.runIds).toEqual(['2026-09-17-p1-224225-rejudge', '2026-09-09-p1-195034-rejudge']);
    expect(fs.existsSync(out.file)).toBe(true);
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('**CONTAINS REJUDGED RUN(S):');
    expect(md).toContain(
      '2026-09-17-p1-224225-rejudge is a REJUDGE of 2026-09-17-p1-224225 — labels re-computed under judge-prompt.2'
    );
    expect(md).toContain('2026-09-09-p1-195034-rejudge is a REJUDGE of 2026-09-09-p1-195034');
    // the stamp sits at the TOP — before the scores section, beside the bold stamps
    expect(md.indexOf('CONTAINS REJUDGED RUN(S)')).toBeLessThan(md.indexOf('## Scores'));
    // downstream operates unchanged: every arm of every run gets its scores row
    expect(md).toContain('| mycelium-timeline | 2026-09-17-p1-224225-rejudge | 2 | 1 | 0 | 1 | 0.500 |');
    expect(md).toContain('| mem0-raw | 2026-09-09-p1-195034-rejudge | 2 | 0 | 1 | 1 | 0.250 |');
    // the artifacts line names the pair the run actually is
    expect(md).toContain('(summary.rejudge.json, judged.rejudge.jsonl, <arm>.rows.jsonl)');
  });

  it('a judge-prompt.1 rejudge beside a judge-prompt.2 rejudge refuses, naming judge.judge_prompt_version', () => {
    const dirA = writeRejudgeFixture('rej-v1', {
      ofRunId: 'run-old-prompt',
      jpv: 'judge-prompt.1',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    const dirB = writeRejudgeFixture('rej-v2', {
      ofRunId: 'run-new-prompt',
      jpv: 'judge-prompt.2',
      arms: { 'mem0-raw': { exact: 0, partial: 1, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    let err = null;
    try {
      composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir(), handlabelsDir: handlabelsDir() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GridRefusal);
    expect(err.message).toMatch(/^ {2}judge\.judge_prompt_version: /m);
    expect(err.message).toContain('run-old-prompt-rejudge=judge-prompt.1');
    expect(err.message).toContain('run-new-prompt-rejudge=judge-prompt.2');
    expect(fs.existsSync(receiptsDir())).toBe(false);
  });

  it('a dir with NEITHER summary refuses with the existing message (nothing at all)', () => {
    const dirA = writeFixtureRun('run-ok3', { runId: 'run-ok3', arms: { mem0: armEntry(2, 1, 0, 1) }, writeInfo: {}, questionIds: ['q1', 'q2'] });
    const dirB = path.join(root, 'run-empty');
    fs.mkdirSync(dirB, { recursive: true });
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir(), handlabelsDir: handlabelsDir() })).toThrow(
      /no summary\.json — a run without its summary is not finished \(in flight, crashed, or not a run dir\)/
    );
  });

  it('judged.rejudge.jsonl without summary.rejudge.json refuses NAMING the missing file', () => {
    const dirA = writeFixtureRun('run-ok4', { runId: 'run-ok4', arms: { mem0: armEntry(2, 1, 0, 1) }, writeInfo: {}, questionIds: ['q1', 'q2'] });
    const dirB = path.join(root, 'rej-half-a');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'judged.rejudge.jsonl'), '');
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir(), handlabelsDir: handlabelsDir() })).toThrow(
      /no summary\.json and the rejudge pair is incomplete — summary\.rejudge\.json is missing/
    );
  });

  it('summary.rejudge.json without judged.rejudge.jsonl refuses NAMING the missing file', () => {
    const dirA = writeFixtureRun('run-ok5', { runId: 'run-ok5', arms: { mem0: armEntry(2, 1, 0, 1) }, writeInfo: {}, questionIds: ['q1', 'q2'] });
    const dirB = path.join(root, 'rej-half-b');
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirB, 'summary.rejudge.json'), JSON.stringify({ run_id: 'x', arms: {} }));
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir(), handlabelsDir: handlabelsDir() })).toThrow(
      /no summary\.json and the rejudge pair is incomplete — judged\.rejudge\.jsonl is missing/
    );
  });

  it('the judge-agreement leg renders from the run’s handlabels file; its absence is stated, never silent', () => {
    const questionIds = ['q1', 'q2', 'q3', 'q4'];
    const dirA = writeRejudgeFixture('rej-agree', {
      ofRunId: '2026-09-17-p1-224225',
      jpv: 'judge-prompt.2',
      arms: { 'mycelium-timeline': { exact: 1, partial: 1, wrong: 2 } },
      questionIds,
      questionTypes: Object.fromEntries(questionIds.map((q) => [q, 'knowledge-update'])),
      // judged labels: q1 exact, q2 partial, q3 wrong, q4 wrong
    });
    // hand labels: 3 of the 4 agree (q4 disagrees: hand exact, judge wrong)
    fs.mkdirSync(handlabelsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(handlabelsDir(), '2026-09-17-p1-224225.json'),
      JSON.stringify({
        hand_scorer: 'director',
        run_id: '2026-09-17-p1-224225',
        sample: [],
        items: [
          { question_id: 'q1', arm: 'mycelium-timeline', label: 'exact' },
          { question_id: 'q2', arm: 'mycelium-timeline', label: 'partial' },
          { question_id: 'q3', arm: 'mycelium-timeline', label: 'wrong' },
          { question_id: 'q4', arm: 'mycelium-timeline', label: 'exact' },
        ],
      })
    );
    const run = loadRun(dirA, { handlabelsDir: handlabelsDir() });
    expect(run.rejudge.agreement.agree).toBe(3);
    expect(run.rejudge.agreement.n).toBe(4);
    expect(run.rejudge.agreement.rate).toBeCloseTo(0.75);

    const dirB = writeRejudgeFixture('rej-nohand', {
      ofRunId: 'run-no-handlabels',
      jpv: 'judge-prompt.2',
      arms: { 'mem0-raw': { exact: 1, partial: 1, wrong: 2 } },
      questionIds,
    });
    const out = composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir(), handlabelsDir: handlabelsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain(
      'hand-vs-judge agreement 0.750 (n=4, 2026-09-17-p1-224225.json)'
    );
    expect(md).toContain(
      'no handlabels file for run-no-handlabels — the judge-agreement leg is NOT rendered'
    );
  });
});

// ---- task 225: the facts layer is part of a timeline arm's grid identity -----
//
// Both the rows-path n=50 and the flag-path n=50 name their arm
// `mycelium-timeline` (the flag switches the STORE — regime.mycelium_timeline
// .facts_layer — not the arm key), so grid.mjs's duplicate-arm rule refused the
// exact §3 comparison the program exists to quote. The layer is part of the
// arm's identity: differently-layered runs compose as two DISTINCTLY labeled
// columns, the same layer twice still refuses, and unstamped regimes render —
// and refuse — exactly as before.

describe('task 225 — rows-path and flag-path timeline runs compose as labeled columns', () => {
  it('a memory-rows run and an am_facts run compose, with two DISTINCTLY labeled timeline rows in the scores table', () => {
    const dirRows = writeTimelineRun('run-rows', { runId: 'run-rows', factsLayer: 'memory-rows' });
    const dirAm = writeTimelineRun('run-am', { runId: 'run-am', factsLayer: 'am_facts' });
    const out = composeGrid({ dirs: [dirRows, dirAm], generatedAt: 'x', receiptsDir: receiptsDir() });
    expect(out.file).toBe(path.join(receiptsDir(), 'run-rows+run-am-grid.md'));
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('| mycelium-timeline [memory-rows] | run-rows | 5 | 0 | 0 | 5 | 0.000 |');
    expect(md).toContain('| mycelium-timeline [am_facts] | run-am | 5 | 0 | 0 | 5 | 0.000 |');
  });

  it('the per-question-type tables label each timeline arm from its run\'s own regime', () => {
    const dirRows = writeTimelineRun('run-rows', { runId: 'run-rows', factsLayer: 'memory-rows' });
    const dirAm = writeTimelineRun('run-am', { runId: 'run-am', factsLayer: 'am_facts' });
    const out = composeGrid({ dirs: [dirRows, dirAm], generatedAt: 'x', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('#### mycelium-timeline [memory-rows]');
    expect(md).toContain('#### mycelium-timeline [am_facts]');
  });

  it('the win condition renders one labeled block per timeline run — one knowledge-update cell each, same bars', () => {
    const dirRows = writeTimelineRun('run-rows', { runId: 'run-rows', factsLayer: 'memory-rows' });
    const dirAm = writeTimelineRun('run-am', { runId: 'run-am', factsLayer: 'am_facts' });
    const out = composeGrid({ dirs: [dirRows, dirAm], generatedAt: 'x', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('| cell | bar | mycelium-timeline [memory-rows] | mem0 | mycelium-extract | verdict |');
    expect(md).toContain('| cell | bar | mycelium-timeline [am_facts] | mem0 | mycelium-extract | verdict |');
    // one judged KU cell per run at the SAME pre-committed bar (n=5 → judged, all wrong → FAIL)
    expect(md.match(/\| knowledge-update \| ≥ 0\.60 \| 0\.000 \(n=5\)/g)?.length).toBe(2);
    expect(md.match(/^VERDICT: /gm)?.length).toBe(2);
  });

  it('two runs with the SAME layer still refuse as duplicates — naming the layer', () => {
    const dirA = writeTimelineRun('run-r1', { runId: 'run-r1', factsLayer: 'memory-rows' });
    const dirB = writeTimelineRun('run-r2', { runId: 'run-r2', factsLayer: 'memory-rows' });
    let err = null;
    try {
      composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GridRefusal);
    expect(err.message).toMatch(
      /duplicate_arm[\s\S]*run-r1='mycelium-timeline' \[memory-rows\] \| run-r2='mycelium-timeline' \[memory-rows\]/
    );
    expect(fs.existsSync(receiptsDir())).toBe(false);
  });

  it('a composite where the SAME layer appears twice refuses, naming the layer', () => {
    const dirs = [
      writeTimelineRun('run-a', { runId: 'run-a', factsLayer: 'memory-rows' }),
      writeTimelineRun('run-b', { runId: 'run-b', factsLayer: 'am_facts' }),
      writeTimelineRun('run-c', { runId: 'run-c', factsLayer: 'memory-rows' }),
    ];
    expect(() => composeGrid({ dirs, generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(
      /duplicate_arm[\s\S]*run-a='mycelium-timeline' \[memory-rows\][\s\S]*run-c='mycelium-timeline' \[memory-rows\]/
    );
  });

  it('an old-regime run (no facts_layer stamp) composes and renders the bare name', () => {
    const dirOld = writeTimelineRun('run-old', { runId: 'run-old' });
    const dirMem0 = writeFixtureRun('run-mem0', {
      runId: 'run-mem0',
      arms: { mem0: armEntry(5, 3, 1, 1) },
      writeInfo: {},
      questionIds: ['q1', 'q2', 'q3', 'q4', 'q5'],
    });
    const out = composeGrid({ dirs: [dirOld, dirMem0], generatedAt: 'x', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('| mycelium-timeline | run-old | 5 | 0 | 0 | 5 | 0.000 |');
    expect(md).not.toContain('mycelium-timeline [');
  });

  it('an old-regime timeline run composes beside a stamped one — bare beside labeled (the layers are distinct measurements)', () => {
    const dirOld = writeTimelineRun('run-old', { runId: 'run-old' });
    const dirAm = writeTimelineRun('run-am', { runId: 'run-am', factsLayer: 'am_facts' });
    const out = composeGrid({ dirs: [dirOld, dirAm], generatedAt: 'x', receiptsDir: receiptsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('| mycelium-timeline | run-old | 5 | 0 | 0 | 5 | 0.000 |');
    expect(md).toContain('| mycelium-timeline [am_facts] | run-am | 5 | 0 | 0 | 5 | 0.000 |');
  });

  it('two old-regime timeline runs still refuse exactly as today (bare names, no brackets)', () => {
    const dirA = writeTimelineRun('run-o1', { runId: 'run-o1' });
    const dirB = writeTimelineRun('run-o2', { runId: 'run-o2' });
    expect(() => composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir() })).toThrow(
      /duplicate_arm[\s\S]*run-o1='mycelium-timeline' \| run-o2='mycelium-timeline'/
    );
  });
});

describe('task 225 — the single-run receipt is self-identifying', () => {
  const baseSummary = (regime) => ({
    run_id: 'r',
    regime,
    arms: { 'mycelium-timeline': { n: 2, score: { counts: { exact: 1, partial: 0, wrong: 1 }, p1_score: 0.5 } } },
    write_info: {},
  });
  const judgedRows = (arm) =>
    ['q1', 'q2'].map((qid) => ({ question_id: qid, arm, question_type: 'knowledge-update', label: 'wrong' }));

  it('the scores table renders [am_facts] beside the arm name when the run stamps it', () => {
    const md = renderReceipt({
      runId: 'r',
      summary: baseSummary({ mycelium_timeline: { facts_layer: 'am_facts' } }),
      generatedAt: 'g',
    });
    expect(md).toContain('| mycelium-timeline [am_facts] | 2 | 1 | 0 | 1 | 0.500 |');
  });

  it('the per-question-type table labels the arm the same way', () => {
    const md = renderReceipt({
      runId: 'r',
      summary: baseSummary({ mycelium_timeline: { facts_layer: 'am_facts' } }),
      judged: judgedRows('mycelium-timeline'),
      generatedAt: 'g',
    });
    expect(md).toContain('#### mycelium-timeline [am_facts]');
  });

  it('an old regime (no facts_layer key) renders the bare arm name', () => {
    const md = renderReceipt({ runId: 'r', summary: baseSummary({ notes: [] }), generatedAt: 'g' });
    expect(md).toContain('| mycelium-timeline | 2 | 1 | 0 | 1 | 0.500 |');
    expect(md).not.toContain('mycelium-timeline [');
  });
});

// ---- task 229: the grid admits a SUFFIXED rejudge pair (--rejudge-pass) -------
//
// judge-prompt.4 is live for new primary runs while every banked comparator run
// labels under judge-prompt.2 — the grid is frozen at the fork until the banked
// runs carry v4 labels. The director's leg is `--rejudge --rejudge-suffix v4`
// over the banked dirs, which writes summary.rejudge-v4.json +
// judged.rejudge-v4.jsonl BESIDE the primary summary and the earlier passes.
// These tests pin that the grid can load and compose a NAMED pass: the caller
// names the pass, the pair loads, and the default path is untouched.

describe('task 229: the grid admits a suffixed rejudge pair (--rejudge-pass)', () => {
  it('loadRun({rejudgePass}) loads the suffixed pair and marks the run with the pass', () => {
    const dir = writeRejudgeFixture('v4-load', {
      ofRunId: '2026-09-17-p1-224225',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
      answer: 'v4-column-answer',
    });
    const run = loadRun(dir, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() });
    expect(run.runId).toBe('2026-09-17-p1-224225-rejudge-v4');
    expect(run.rejudge.of_run_id).toBe('2026-09-17-p1-224225');
    expect(run.rejudge.judge_prompt_version).toBe('judge-prompt.4');
    expect(run.rejudge.pass).toBe('v4');
    expect(run.rejudge.stem).toBe('rejudge-v4');
    // the judged rows ARE the v4 pair's rows
    expect(run.judged.every((r) => r.answer === 'v4-column-answer')).toBe(true);
    expect([...run.judgedIds].sort()).toEqual(['q1', 'q2']);
  });

  it('the named pass loads the pair even when the dir still carries its primary summary.json (the 195034/185920 shape)', () => {
    const dir = writeFixtureRun('primary-with-v4', {
      runId: '2026-09-09-p1-195034',
      arms: { mem0: armEntry(2, 1, 0, 1), 'mem0-raw': armEntry(2, 1, 1, 0) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    writeRejudgeFixture('primary-with-v4', {
      ofRunId: '2026-09-09-p1-195034',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { mem0: { exact: 0, partial: 0, wrong: 2 }, 'mem0-raw': { exact: 2, partial: 0, wrong: 0 } },
      questionIds: ['q1', 'q2'],
      answer: 'v4-pair-answer',
    });
    const run = loadRun(dir, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() });
    expect(run.rejudge).not.toBeNull();
    expect(run.runId).toBe('2026-09-09-p1-195034-rejudge-v4');
    expect(run.judged.every((r) => r.answer === 'v4-pair-answer')).toBe(true);
    // the DEFAULT load of the same dir is untouched: primary wins
    const primary = loadRun(dir, { handlabelsDir: handlabelsDir() });
    expect(primary.rejudge).toBeNull();
    expect(primary.runId).toBe('2026-09-09-p1-195034');
  });

  it('an incomplete named pair refuses NAMING the missing file and the pass', () => {
    const dir = path.join(root, 'v4-half');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'judged.rejudge-v4.jsonl'), '');
    expect(() => loadRun(dir, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() })).toThrow(
      /rejudge pass 'v4' is incomplete — summary\.rejudge-v4\.json is missing/
    );
  });

  it('a dir carrying neither the named pair nor any summary refuses naming the pass', () => {
    const dir = path.join(root, 'v4-absent');
    fs.mkdirSync(dir, { recursive: true });
    expect(() => loadRun(dir, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() })).toThrow(
      /rejudge pass 'v4' not found in .* — no summary\.rejudge-v4\.json/
    );
  });

  it('an invalid pass tag refuses (a tag becomes part of three artifact names)', () => {
    const dir = writeRejudgeFixture('v4-tagcheck', {
      ofRunId: 'r',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { mem0: { exact: 2, partial: 0, wrong: 0 } },
      questionIds: ['q1', 'q2'],
    });
    expect(() => loadRun(dir, { rejudgePass: '../evil', handlabelsDir: handlabelsDir() })).toThrow(
      /invalid --rejudge-pass/
    );
  });

  it('a pair FILE named for pass v4 whose own stamp says another suffix refuses (mislabeled evidence)', () => {
    const dir = writeRejudgeFixture('v4-mislabeled', {
      ofRunId: 'r-mislabeled',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { mem0: { exact: 2, partial: 0, wrong: 0 } },
      questionIds: ['q1', 'q2'],
    });
    // rewrite the summary with a v3 suffix stamp under the v4 filename
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.rejudge-v4.json'), 'utf8'));
    s.regime.judge.rejudge.suffix = 'v3';
    fs.writeFileSync(path.join(dir, 'summary.rejudge-v4.json'), JSON.stringify(s, null, 2));
    expect(() => loadRun(dir, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() })).toThrow(
      /summary\.rejudge-v4\.json is stamped suffix 'v3'/
    );
  });
});

// ---- task 229: the effective judge is the quoted judge ------------------------
//
// COMPARABILITY_KEYS read summary.regime.judge.judge_prompt_version — but a
// rejudged run's EFFECTIVE judge is the pair's own stamp (what rejudge.mjs
// wrote when it re-labelled). A v4-labelled column must compose and render
// under judge-prompt.4 even if the regime mirror it inherited says v2; a grid
// mixing two effective versions refuses naming both.

describe('task 229: the effective judge is the quoted judge', () => {
  it('a v4 pair whose regime mirror says v2 composes under judge-prompt.4 (the pair stamp wins)', () => {
    const dir = writeRejudgeFixture('v4-stale-regime', {
      ofRunId: 'r-stale-regime',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
      // the pair was reconstructed from rows whose regime carried the OLD stamp
      regime: { judge: { judge_prompt_version: 'judge-prompt.2' } },
    });
    const run = loadRun(dir, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() });
    expect(run.summary.regime.judge.judge_prompt_version).toBe('judge-prompt.2'); // the stale mirror
    expect(effectiveJudgePromptVersion(run)).toBe('judge-prompt.4'); // the quoted judge
  });

  it('a primary run still reads its regime stamp (fallback only for primaries)', () => {
    const dir = writeFixtureRun('prim-jpv', {
      runId: 'prim-jpv',
      arms: { mem0: armEntry(2, 1, 0, 1) },
      writeInfo: {},
      questionIds: ['q1', 'q2'],
    });
    expect(effectiveJudgePromptVersion(loadRun(dir, { handlabelsDir: handlabelsDir() }))).toBe('judge-prompt.2');
  });

  it('a v2-labelled pair beside a v4-labelled pair refuses, naming BOTH versions', () => {
    const dirV2 = writeRejudgeFixture('mix-v2', {
      ofRunId: 'run-mixed-a',
      jpv: 'judge-prompt.2',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    const dirV4 = writeRejudgeFixture('mix-v4', {
      ofRunId: 'run-mixed-b',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { 'mem0-raw': { exact: 0, partial: 1, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    let err = null;
    try {
      composeGrid({
        dirs: [dirV2, dirV4],
        generatedAt: 'x',
        receiptsDir: receiptsDir(),
        handlabelsDir: handlabelsDir(),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GridRefusal);
    expect(err.message).toMatch(/^ {2}judge\.judge_prompt_version: /m);
    expect(err.message).toContain('run-mixed-a-rejudge=judge-prompt.2');
    expect(err.message).toContain('run-mixed-b-rejudge-v4=judge-prompt.4');
    expect(fs.existsSync(receiptsDir())).toBe(false);
  });

  it('the two-arm rejudge pair (n=100 judged rows) composes beside one-arm runs — n reads the QUESTION count for pairs', () => {
    // the real banked shape: 195034 (mem0 + mem0-raw) and 185920 (none + mycelium)
    // judge 100 ROWS for the SAME 50 questions; a rejudge pair's summary.n is the
    // row count. The comparability key must count questions for every shape or
    // the single-judge trio refuses on n (50 | 100 | 100).
    const dirTimeline = writeRejudgeFixture('trio-timeline', {
      ofRunId: 'trio-run-a',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { 'mycelium-timeline': { exact: 3, partial: 0, wrong: 2 } },
      questionIds: ['q1', 'q2', 'q3', 'q4', 'q5'],
      questionTypes: Object.fromEntries(['q1', 'q2', 'q3', 'q4', 'q5'].map((q) => [q, 'knowledge-update'])),
    });
    const dirMem0 = writeRejudgeFixture('trio-mem0', {
      ofRunId: 'trio-run-b',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { mem0: { exact: 2, partial: 1, wrong: 2 }, 'mem0-raw': { exact: 1, partial: 0, wrong: 4 } },
      questionIds: ['q1', 'q2', 'q3', 'q4', 'q5'],
    });
    const dirNone = writeRejudgeFixture('trio-none', {
      ofRunId: 'trio-run-c',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { none: { exact: 0, partial: 0, wrong: 5 }, mycelium: { exact: 3, partial: 1, wrong: 1 } },
      questionIds: ['q1', 'q2', 'q3', 'q4', 'q5'],
    });
    const runs = [
      loadRun(dirTimeline, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() }),
      loadRun(dirMem0, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() }),
      loadRun(dirNone, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() }),
    ];
    expect(runs.map((r) => r.summary.n)).toEqual([5, 10, 10]); // row counts differ by arms
    expect(runs.map((r) => effectiveN(r))).toEqual([5, 5, 5]); // the question count agrees
    expect(findDifferences(runs).map((d) => d.key)).not.toContain('n');
    const out = composeGrid({
      dirs: [dirTimeline, dirMem0, dirNone],
      generatedAt: 'x',
      receiptsDir: receiptsDir(),
      handlabelsDir: handlabelsDir(),
      rejudgePass: 'v4',
    });
    expect(fs.existsSync(out.file)).toBe(true);
  });

  it('the same run judged twice (two passes of one of_run_id) refuses, naming the run and the colliding passes', () => {
    const dirV2 = writeRejudgeFixture('twice-v2', {
      ofRunId: 'run-scored-twice',
      jpv: 'judge-prompt.2',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    const dirV4 = writeRejudgeFixture('twice-v4', {
      ofRunId: 'run-scored-twice',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { 'mycelium-timeline': { exact: 2, partial: 0, wrong: 0 } },
      questionIds: ['q1', 'q2'],
      // a different facts layer would dodge the duplicate-arm rule — the
      // same-run rule must fire regardless
      regime: { mycelium_timeline: { facts_layer: 'am_facts' } },
    });
    const runs = [
      loadRun(dirV2, { handlabelsDir: handlabelsDir() }),
      loadRun(dirV4, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() }),
    ];
    let err = null;
    try {
      assertComparable(runs);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GridRefusal);
    expect(err.message).toContain('same_run_twice');
    expect(err.message).toContain('run-scored-twice');
    expect(err.message).toContain("run-scored-twice-rejudge (pass 'default')");
    expect(err.message).toContain("run-scored-twice-rejudge-v4 (pass 'v4')");
  });
});

// ---- task 229: the adoption gate renders in the composed receipt --------------

describe('task 229: the judge adoption gate renders in the grid receipt', () => {
  // A 224225-v4 fixture whose timeline labels satisfy the gate: the four
  // pre-committed _abs rows EXACT, the three protected rows wrong, 19/20
  // agreement with the director's handlabels file, KU 10/15, SSA 5/5, TR 2/5.
  // Layout: KU = 4 abs + 3 protected + h01..h05 + kf1..kf3; SSA = h06..h10;
  // TR = h11..h15; the rest MS fillers h16..h20 + mf*. The ONE disagreement is
  // h20 (hand exact, judge wrong) — the sim's 0a34ad58 slot.
  const GATE_ABS = ['031748ae_abs', '09ba9854_abs', '0ddfec37_abs', '15745da0_abs'];
  const GATE_PROTECTED = ['00ca467f', '078150f1', '1192316e'];
  const GATE_HAND = Array.from({ length: 20 }, (_, i) => `h${String(i + 1).padStart(2, '0')}`);
  const GATE_KU = [...GATE_ABS, ...GATE_PROTECTED, 'h01', 'h02', 'h03', 'h04', 'h05', 'kf1', 'kf2', 'kf3'];
  const GATE_SSA = ['h06', 'h07', 'h08', 'h09', 'h10'];
  const GATE_TR = ['h11', 'h12', 'h13', 'h14', 'h15'];
  const GATE_MS = ['h16', 'h17', 'h18', 'h19', 'h20', ...Array.from({ length: 20 }, (_, i) => `mf${String(i + 1).padStart(2, '0')}`)];
  const GATE_ALL = [...GATE_KU, ...GATE_SSA, ...GATE_TR, ...GATE_MS]; // 15 + 5 + 5 + 25 = 50
  const gateTypeOf = (q) =>
    GATE_KU.includes(q) ? 'knowledge-update' : GATE_SSA.includes(q) ? 'single-session-assistant' : GATE_TR.includes(q) ? 'temporal-reasoning' : 'multi-session';

  function writeGatedV4({ protectedLabel = 'wrong', disagreeId = 'h20' } = {}) {
    const labelOf = (q) => {
      if (GATE_ABS.includes(q)) return 'exact';
      if (GATE_PROTECTED.includes(q)) return protectedLabel;
      if (q === 'kf2' || q === 'kf3') return 'wrong'; // KU filler wrongs → KU exact = 4+5+1 = 10
      if (q === 'h13' || q === 'h14' || q === 'h15') return 'wrong'; // TR 2/5
      if (q === disagreeId) return 'wrong'; // the one hand disagreement
      return 'exact';
    };
    const dir = writeRejudgeFixture('gated-v4', {
      ofRunId: '2026-09-17-p1-224225',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { 'mycelium-timeline': { exact: GATE_ALL.length, partial: 0, wrong: 0 } }, // skeleton; rows rewritten below
      questionIds: GATE_ALL,
      questionTypes: Object.fromEntries(GATE_ALL.map((q) => [q, gateTypeOf(q)])),
    });
    // rewrite the pair's rows with the gate-scenario labels (the helper's own
    // counts only shape the skeleton)
    const rows = GATE_ALL.map((qid) => ({
      question_id: qid,
      arm: 'mycelium-timeline',
      question_type: gateTypeOf(qid),
      gold: 'a year',
      answer: 'gated-v4-answer',
      label: labelOf(qid),
      judge_raw: labelOf(qid).toUpperCase(),
      judge_had_think: false,
    }));
    fs.writeFileSync(path.join(dir, 'judged.rejudge-v4.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.rejudge-v4.json'), 'utf8'));
    const counts = { exact: 0, partial: 0, wrong: 0 };
    for (const r of rows) counts[r.label]++;
    s.n = rows.length;
    s.arms['mycelium-timeline'] = { n: rows.length, score: { n: rows.length, counts, unparsed: 0, p1_score: (counts.exact + 0.5 * counts.partial) / rows.length } };
    fs.writeFileSync(path.join(dir, 'summary.rejudge-v4.json'), JSON.stringify(s, null, 2));
    // the director's 20 hand labels — mirroring the judge EXCEPT the one
    // disagreement slot (h20: hand exact, judge wrong) → agreement 19/20
    fs.mkdirSync(handlabelsDir(), { recursive: true });
    fs.writeFileSync(
      path.join(handlabelsDir(), '2026-09-17-p1-224225.json'),
      JSON.stringify({
        hand_scorer: 'director',
        run_id: '2026-09-17-p1-224225',
        items: GATE_HAND.map((h) => ({
          question_id: h,
          arm: 'mycelium-timeline',
          label: h === 'h20' ? 'exact' : labelOf(h),
        })),
      })
    );
    return dir;
  }

  const writeGateMem0 = (name) =>
    writeRejudgeFixture(name, {
      ofRunId: `of-${name}`,
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { mem0: { exact: 30, partial: 10, wrong: 10 }, 'mem0-raw': { exact: 10, partial: 10, wrong: 30 } },
      questionIds: GATE_ALL,
    });

  it('a gate-satisfying v4 timeline run renders VERDICT: ADOPTED, the pass tag, and the §3 cells under v4', () => {
    const dirT = writeGatedV4();
    const dirM = writeGateMem0('gate-mem0');
    const out = composeGrid({
      dirs: [dirT, dirM],
      generatedAt: 'x',
      receiptsDir: receiptsDir(),
      handlabelsDir: handlabelsDir(),
      rejudgePass: 'v4',
    });
    const md = fs.readFileSync(out.file, 'utf8');
    // the gate section sits at the TOP — before the scores it governs
    expect(md).toContain('## Judge adoption gate (pre-committed, task 226)');
    expect(md.indexOf('## Judge adoption gate')).toBeLessThan(md.indexOf('## Scores'));
    expect(md).toContain('**VERDICT: ADOPTED**');
    expect(md).toContain('4/4 pre-committed _abs rows read EXACT');
    expect(md).toContain('00ca467f, 078150f1, 1192316e all wrong');
    expect(md).toContain('19/20');
    // the header names the pass
    expect(md).toContain('labels re-computed under judge-prompt.4 (pass `rejudge-v4`: summary.rejudge-v4.json + judged.rejudge-v4.jsonl)');
    // the artifacts line names the pair the run actually is
    expect(md).toContain('(summary.rejudge-v4.json, judged.rejudge-v4.jsonl, <arm>.rows.jsonl)');
    // §3 under the adopted judge: KU 10/15 = 0.667 PASS, SSA 5/5, TR 2/5, VERDICT: WIN
    expect(md).toContain('| knowledge-update | ≥ 0.60 | 0.667 (n=15) |');
    expect(md).toContain('| single-session-assistant | ≥ 1.00 | 1.000 (n=5) |');
    expect(md).toContain('| temporal-reasoning | ≥ 0.40 | 0.400 (n=5) |');
    expect(md).toContain('VERDICT: WIN');
  });

  it('a refused gate renders NOT ADOPTED verbatim, naming the failing row and the v2 cell that stays quoted', () => {
    const dirT = writeGatedV4({ protectedLabel: 'exact' }); // the v3 defect, re-created
    const dirM = writeGateMem0('gate-ref-mem0');
    const out = composeGrid({
      dirs: [dirT, dirM],
      generatedAt: 'x',
      receiptsDir: receiptsDir(),
      handlabelsDir: handlabelsDir(),
      rejudgePass: 'v4',
    });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).toContain('**VERDICT: NOT ADOPTED**');
    expect(md).toContain('1192316e reads exact, pre-committed WRONG');
    expect(md).toContain("judge-prompt.2's knowledge-update 8/15 = 0.533 remains the arm's quoted cell");
    expect(md).toContain('no downstream artifact may quote a judge-prompt.4 number as the arm number');
  });

  it('the gate does not render for a v2-labelled composition (the banked receipts keep their shape)', () => {
    const dirA = writeRejudgeFixture('gateless-v2', {
      ofRunId: '2026-09-17-p1-224225',
      jpv: 'judge-prompt.2',
      arms: { 'mycelium-timeline': { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    const dirB = writeRejudgeFixture('gateless-v2-b', {
      ofRunId: 'gateless-run-b',
      jpv: 'judge-prompt.2',
      arms: { 'mem0-raw': { exact: 0, partial: 1, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    const out = composeGrid({ dirs: [dirA, dirB], generatedAt: 'x', receiptsDir: receiptsDir(), handlabelsDir: handlabelsDir() });
    const md = fs.readFileSync(out.file, 'utf8');
    expect(md).not.toContain('## Judge adoption gate');
    // and the unsuffixed header keeps its exact banked shape
    expect(md).toContain('labels re-computed under judge-prompt.2;');
    expect(md).not.toContain('pass `rejudge');
  });

  it('the agreement leg falls back to an in-dir handlabels.json (the 195034 shape)', () => {
    const dir = writeRejudgeFixture('indir-hand', {
      ofRunId: '2026-09-09-p1-195034',
      jpv: 'judge-prompt.4',
      suffix: 'v4',
      arms: { mem0: { exact: 1, partial: 0, wrong: 1 } },
      questionIds: ['q1', 'q2'],
    });
    fs.writeFileSync(
      path.join(dir, 'handlabels.json'),
      JSON.stringify({
        hand_scorer: 'director',
        run_id: '2026-09-09-p1-195034',
        items: [
          { question_id: 'q1', arm: 'mem0', label: 'exact' },
          { question_id: 'q2', arm: 'mem0', label: 'wrong' },
        ],
      })
    );
    const run = loadRun(dir, { rejudgePass: 'v4', handlabelsDir: handlabelsDir() });
    expect(run.rejudge.agreement.agree).toBe(2);
    expect(run.rejudge.agreement.n).toBe(2);
    expect(path.basename(run.rejudge.agreement.file)).toBe('handlabels.json');
  });

  it('the default pass re-renders the banked 224-composed receipt BYTE-IDENTICAL', () => {
    // the tracked receipt was composed by the director over these two dirs at
    // this timestamp; the default path must reproduce it exactly after the
    // pass/effective-judge/gate changes (the no-regression contract)
    const dirs = ['bench/memory/results/2026-09-17-p1-224225', 'bench/memory/results/2026-09-09-p1-195034'];
    for (const d of dirs) expect(fs.existsSync(d)).toBe(true); // relative to the repo root — vitest runs there
    const banked = fs.readFileSync(
      'bench/memory/receipts/2026-09-17-p1-224225-rejudge+2026-09-09-p1-195034-grid.md',
      'utf8'
    );
    const out = composeGrid({
      dirs,
      generatedAt: '2026-09-18T12:16:25Z',
      receiptsDir: path.join(root, 'receipts'),
      handlabelsDir: HANDLABELS_DIR,
    });
    const fresh = fs.readFileSync(out.file, 'utf8');
    expect(fresh).toBe(banked);
  });
});

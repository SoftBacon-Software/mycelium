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

import {
  COMPARABILITY_KEYS,
  GridInputError,
  GridRefusal,
  allowedDifferences,
  assertComparable,
  buildUnion,
  composeGrid,
  flattenRegime,
  loadRun,
  unionArms,
  writeCap,
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
function writeFixtureRun(name, { runId, arms, writeInfo, questionIds, regime = {}, topCap = null, cleanup = null, summaryPatch = null }) {
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
      rows.push({ question_id: qid, arm, question_type: 'single-session-user', gold: 'a year', answer: 'I do not know.', label: 'wrong', judge_raw: 'WRONG', judge_had_think: false });
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
    writeInfo: { mem0: { docs: 5, rows: 21 }, 'mem0-raw': { docs: 5, rows: 41 } },
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
    expect(md).toContain('mem0 (run-a): docs 5, rows 21. Seconds per add: not stamped.');
    expect(md).toContain('mem0-raw (run-a): docs 5, rows 41.');
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

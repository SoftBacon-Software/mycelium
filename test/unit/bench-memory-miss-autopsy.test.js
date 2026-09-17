import { describe, it, expect } from 'vitest';
import {
  MISS_CLASSES,
  UNCLASSIFIED,
  AUTOPSY_QUESTION_TYPE,
  DEFAULT_AUTOPSY_ARM,
  contentTokens,
  classifyMiss,
  computeAutopsy,
  renderAutopsySection,
  autopsyRun,
} from '../../bench/memory/miss_autopsy.mjs';

// task 205 — the miss autopsy: every WRONG knowledge-update row classifies into
// EXACTLY ONE class (the earliest owner of the failure wins), and a row the
// evidence cannot classify is counted unclassified — never forced into a class.

const GOLD = 'software engineer';
const OLD_CAND = 'User works as a teacher at Lincoln High';
const NEW_CAND = 'User switched jobs and is now a software engineer';

// A ledger entry for one question: an old non-gold candidate, then (optionally)
// gold-matching candidates whose decision fields the fixture overrides.
function ledgerEntry(candidates) {
  return {
    question_id: 'ku-1',
    candidates_ledger: [
      {
        index: 0, session_index: 0, text: OLD_CAND, decision: 'ADD', ok: true,
        source: 'auto_add_on_no_match', shown_ids: [], top_score: null, source_id: 'r-ku-1-tl-f0',
      },
      ...candidates,
    ],
  };
}

const decidedAdd = (over = {}) => ({
  index: 1, session_index: 3, text: NEW_CAND, decision: 'ADD', ok: true,
  source: 'decision', shown_ids: ['r-ku-1-tl-f0'], top_score: 6.2, source_id: 'r-ku-1-tl-f1',
  ...over,
});
const readHit = (source_id, rank = 0) => ({ layer: 'fact', source_id, rank, score: 5, rendered_date: 'd', rendered_supersede_line: null });

describe('contentTokens — the lexical gold-match rule, pinned', () => {
  it('lowercases, folds possessives, drops punctuation and stopwords', () => {
    expect(contentTokens("The user's manager = Dana")).toEqual(['user', 'manager', 'dana']);
    expect(contentTokens('')).toEqual([]);
    expect(contentTokens('I am currently a software engineer')).toEqual(['software', 'engineer']);
  });
});

describe('classifyMiss — exactly one class per wrong row', () => {
  it('never-extracted: no candidate carries the gold value', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [readHit('r-ku-1-tl-f0')] } },
      ledgerEntry: ledgerEntry([]),
    });
    expect(v.klass).toBe('never-extracted');
    expect(v.best).toBeNull();
  });

  it('kept-wrong: the decision SAW neighbors and still kept the gold update out', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [] } },
      ledgerEntry: ledgerEntry([decidedAdd({ decision: 'KEEP', source_id: null })]),
    });
    expect(v.klass).toBe('kept-wrong');
    expect(v.best.decision).toBe('KEEP');
  });

  it('added-blind: the gold candidate was added with no decider-visible neighbor', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [readHit('r-ku-1-tl-f0')] } },
      ledgerEntry: ledgerEntry([decidedAdd({ source: 'auto_add_on_no_match', shown_ids: [] })]),
    });
    expect(v.klass).toBe('added-blind');
    expect(v.note).toBeNull();
  });

  it('added-blind via the fastpath carries the fastpath note', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [] } },
      ledgerEntry: ledgerEntry([decidedAdd({ source: 'fastpath_below_threshold', shown_ids: ['r-ku-1-tl-f0'], top_score: 0.2 })]),
    });
    expect(v.klass).toBe('added-blind');
    expect(v.note).toBe('fastpath');
  });

  it('superseded-but-unranked: the gold fact is current in the layer but the read never ranked it', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [readHit('r-ku-1-tl-f0'), readHit('r-ku-1-tl-f2', 1)] } },
      ledgerEntry: ledgerEntry([decidedAdd()]),
    });
    expect(v.klass).toBe('superseded-but-unranked');
    expect(v.best.source_id).toBe('r-ku-1-tl-f1');
  });

  it('superseded-but-unranked notes a stamped retrieval error (read_hits null)', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: null, retrieval_error: 'fact search failed: boom' } },
      ledgerEntry: ledgerEntry([decidedAdd()]),
    });
    expect(v.klass).toBe('superseded-but-unranked');
    expect(v.note).toBe('retrieval_error');
  });

  it('ranked-but-answered-wrong: the gold fact WAS in the context and the answerer still missed', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [readHit('r-ku-1-tl-f1'), readHit('r-ku-1-tl-f0', 1)] } },
      ledgerEntry: ledgerEntry([decidedAdd()]),
    });
    expect(v.klass).toBe('ranked-but-answered-wrong');
  });

  it('the gold-matching candidate is the LATEST one (highest session_index, then index)', () => {
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [] } },
      ledgerEntry: ledgerEntry([
        decidedAdd({ index: 1, session_index: 1, source_id: 'r-ku-1-tl-f1' }),
        decidedAdd({ index: 0, session_index: 3, source_id: 'r-ku-1-tl-f5', source: 'auto_add_on_no_match', shown_ids: [] }),
      ]),
    });
    // the session-3 blind add is the best (latest) match → added-blind, NOT the ranked session-1 add
    expect(v.best.session_index).toBe(3);
    expect(v.klass).toBe('added-blind');
  });

  it('a row that would satisfy TWO classes is classified ONCE — the write-side owner wins', () => {
    // the gold candidate was added BLIND (no neighbor shown) yet its fact IS
    // ranked in the read context: ranked-but-answered-wrong would also "fit",
    // but the defect is the blind add — the supersede never had a chance.
    const v = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [readHit('r-ku-1-tl-f1'), readHit('r-ku-1-tl-f0', 1)] } },
      ledgerEntry: ledgerEntry([decidedAdd({ source: 'auto_add_on_no_match', shown_ids: [] })]),
    });
    expect(v.klass).toBe('added-blind');
    expect(MISS_CLASSES.filter((k) => k === v.klass)).toHaveLength(1);

    // and a KEEP whose read ranked nothing is kept-wrong only — never also
    // superseded-but-unranked
    const v2 = classifyMiss({
      row: { gold: GOLD, meta: { read_hits: [] } },
      ledgerEntry: ledgerEntry([decidedAdd({ decision: 'KEEP', source_id: null })]),
    });
    expect(v2.klass).toBe('kept-wrong');
  });

  it('a row the evidence cannot classify is UNCLASSIFIED — never forced into a class', () => {
    const noLedger = classifyMiss({ row: { gold: GOLD, meta: { read_hits: [] } }, ledgerEntry: null });
    expect(noLedger.klass).toBe(UNCLASSIFIED.NO_LEDGER);

    const emptyLedger = classifyMiss({ row: { gold: GOLD, meta: { read_hits: [] } }, ledgerEntry: { question_id: 'ku-1', candidates_ledger: [] } });
    expect(emptyLedger.klass).toBe(UNCLASSIFIED.NO_LEDGER);

    const emptyGold = classifyMiss({ row: { gold: '', meta: { read_hits: [] } }, ledgerEntry: ledgerEntry([decidedAdd()]) });
    expect(emptyGold.klass).toBe(UNCLASSIFIED.EMPTY_GOLD);

    // a paraphrase the lexicon cannot see reads as never-extracted — the
    // honest failure of a lexical instrument
    const paraphrase = classifyMiss({
      row: { gold: 'principal cellist of the symphony', meta: { read_hits: [] } },
      ledgerEntry: ledgerEntry([decidedAdd({ text: NEW_CAND })]),
    });
    expect(paraphrase.klass).toBe('never-extracted');
  });
});

describe('computeAutopsy — one run, one arm', () => {
  const summary = {
    write_info: {
      [DEFAULT_AUTOPSY_ARM]: {
        timeline: { per_question: [ledgerEntry([decidedAdd()])] },
      },
    },
  };
  const judged = [
    { question_id: 'ku-1', arm: DEFAULT_AUTOPSY_ARM, question_type: 'knowledge-update', label: 'wrong', gold: GOLD },
    { question_id: 'ku-2', arm: 'mycelium-extract', question_type: 'knowledge-update', label: 'wrong', gold: GOLD }, // another arm — ignored
    { question_id: 'ku-3', arm: DEFAULT_AUTOPSY_ARM, question_type: 'knowledge-update', label: 'exact', gold: GOLD }, // not wrong — not a target
    { question_id: 'ku-4', arm: DEFAULT_AUTOPSY_ARM, question_type: 'single-session-assistant', label: 'wrong', gold: GOLD }, // not KU — not a target
    { question_id: 'ku-5', arm: DEFAULT_AUTOPSY_ARM, question_type: 'knowledge-update', label: null, gold: GOLD }, // judge-unparsed — counted, not classified
  ];
  const rows = [
    { question_id: 'ku-1', gold: GOLD, meta: { read_hits: [readHit('r-ku-1-tl-f0')] } },
    { question_id: 'ku-9', gold: 'x', meta: { read_hits: null, retrieval_error: 'fact search failed: down' } },
    { question_id: 'ku-8', gold: 'x', meta: { read_hits: [], write_decisions: { candidates: 1 } } },
  ];

  it('counts exactly the arm\'s wrong knowledge-update rows and classifies each once', () => {
    const a = computeAutopsy({ arm: DEFAULT_AUTOPSY_ARM, summary, judged, rows });
    expect(a.arm).toBe(DEFAULT_AUTOPSY_ARM);
    expect(a.wrong_knowledge_update).toBe(1);
    expect(a.judge_unparsed).toBe(1);
    expect(a.ledger_coverage).toBe(1);
    expect(a.classes['superseded-but-unranked']).toBe(1);
    expect(a.details).toEqual([{ question_id: 'ku-1', klass: 'superseded-but-unranked', note: null }]);
  });

  it('the stamp-coverage block counts ALL the arm\'s rows, not just the wrong ones', () => {
    const a = computeAutopsy({ arm: DEFAULT_AUTOPSY_ARM, summary, judged, rows });
    // an empty array IS a read_hits stamp (a truly empty search); null is the
    // retrieval-failure stamp — both counted, distinctly
    expect(a.stamps).toEqual({ rows: 3, rows_with_read_hits: 2, rows_read_hits_null: 1, rows_with_write_decisions: 1 });
    expect(a.flags).toEqual({ fastpath: 0, fail_open: 0, retrieval_error: 0 });
  });

  it('a run with no targets reports zero without fabricating a class; ledger_coverage is null', () => {
    const a = computeAutopsy({ arm: DEFAULT_AUTOPSY_ARM, summary, judged: judged.slice(2, 4), rows: [] });
    expect(a.wrong_knowledge_update).toBe(0);
    expect(a.ledger_coverage).toBeNull();
    expect(Object.values(a.classes).every((n) => n === 0)).toBe(true);
  });
});

describe('renderAutopsySection — the markdown the receipts embed', () => {
  const autopsy = computeAutopsy({
    summary: { write_info: { [DEFAULT_AUTOPSY_ARM]: { timeline: { per_question: [ledgerEntry([decidedAdd({ source: 'fastpath_below_threshold', shown_ids: ['x'], top_score: 0.2 })])] } } } },
    judged: [{ question_id: 'ku-1', arm: DEFAULT_AUTOPSY_ARM, question_type: 'knowledge-update', label: 'wrong', gold: GOLD }],
    rows: [{ question_id: 'ku-1', gold: GOLD, meta: { read_hits: [], write_decisions: {} } }],
  });

  it('renders the class table, the flags line, the stamps line, and the unchanged-prompt line', () => {
    const md = renderAutopsySection(autopsy);
    expect(md).toContain('## Knowledge-update miss autopsy (mycelium-timeline)');
    expect(md).toContain('| class | n |');
    for (const k of MISS_CLASSES) expect(md).toContain(`| ${k} |`);
    expect(md).toContain('| added-blind | 1 |');
    expect(md).toContain('fastpath adds: 1');
    expect(md).toContain('Stamps: 1/1 rows carry meta.read_hits');
    expect(md).toContain('- ku-1: added-blind (fastpath)');
    expect(md).toContain('The reconcile prompt is UNCHANGED this round');
  });

  it('a null heading renders NO heading (the grid receipt prints its own per-run heading)', () => {
    const md = renderAutopsySection(autopsy, { heading: null });
    expect(md.startsWith('\n')).toBe(true);
    expect(md).not.toContain('## Knowledge-update miss autopsy');
  });

  it('an explicit heading replaces the default; long detail lists are capped', () => {
    expect(renderAutopsySection(autopsy, { heading: '## Custom' }).startsWith('## Custom\n')).toBe(true);
    const many = computeAutopsy({
      summary: { write_info: { [DEFAULT_AUTOPSY_ARM]: { timeline: { per_question: [] } } } },
      judged: Array.from({ length: 25 }, (_, i) => ({
        question_id: `q${i}`, arm: DEFAULT_AUTOPSY_ARM, question_type: 'knowledge-update', label: 'wrong', gold: '',
      })),
      rows: [],
    });
    const md = renderAutopsySection(many, { heading: null });
    expect(md).toContain('unclassified-empty-gold | 25');
    expect(md).toContain('… 5 more');
  });
});

describe('autopsyRun — loads a run dir\'s evidence, loud on missing files', () => {
  const files = {
    'runs/r/summary.json': JSON.stringify({ write_info: { [DEFAULT_AUTOPSY_ARM]: { timeline: { per_question: [ledgerEntry([decidedAdd()])] } } } }),
    'runs/r/judged.jsonl': [
      JSON.stringify({ question_id: 'ku-1', arm: DEFAULT_AUTOPSY_ARM, question_type: 'knowledge-update', label: 'wrong', gold: GOLD }),
      JSON.stringify({ question_id: 'ku-2', arm: DEFAULT_AUTOPSY_ARM, question_type: 'knowledge-update', label: 'exact', gold: GOLD }),
    ].join('\n'),
    'runs/r/mycelium-timeline.rows.jsonl': [
      JSON.stringify({ question_id: 'ku-1', gold: GOLD, meta: { read_hits: [readHit('r-ku-1-tl-f0')] } }),
    ].join('\n'),
  };
  const existsFn = (f) => Boolean(files[f]);
  const readFileFn = (f) => {
    if (!(f in files)) throw new Error(`ENOENT: ${f}`);
    return files[f];
  };

  it('computes the autopsy from summary.json + judged.jsonl + <arm>.rows.jsonl', () => {
    const a = autopsyRun({ dir: 'runs/r', existsFn, readFileFn });
    expect(a.wrong_knowledge_update).toBe(1);
    expect(a.classes['superseded-but-unranked']).toBe(1);
  });

  it('a run missing any of the three files is a LOUD error, not an empty autopsy', () => {
    for (const missing of ['summary.json', 'judged.jsonl', 'mycelium-timeline.rows.jsonl']) {
      const partial = Object.fromEntries(Object.entries(files).filter(([k]) => !k.endsWith(`/${missing}`)));
      const ex = (f) => Boolean(partial[f]);
      const rd = (f) => {
        if (!(f in partial)) throw new Error(`ENOENT: ${f}`);
        return partial[f];
      };
      expect(() => autopsyRun({ dir: 'runs/r', existsFn: ex, readFileFn: rd })).toThrow(new RegExp(`no ${missing.replace('.', '\\.')}`));
    }
  });

  it('a different arm reads that arm\'s rows file', () => {
    const twoArmFiles = {
      ...files,
      'runs/r/judged.jsonl': [
        JSON.stringify({ question_id: 'ku-1', arm: 'mycelium-extract', question_type: 'knowledge-update', label: 'wrong', gold: GOLD }),
      ].join('\n'),
      'runs/r/mycelium-extract.rows.jsonl': JSON.stringify({ question_id: 'ku-1', gold: GOLD, meta: { hits: 3 } }),
    };
    const a = autopsyRun({
      dir: 'runs/r',
      arm: 'mycelium-extract',
      existsFn: (f) => Boolean(twoArmFiles[f]),
      readFileFn: (f) => twoArmFiles[f],
    });
    expect(a.arm).toBe('mycelium-extract');
    // no ledger for the extract arm → the wrong row is unclassified, honestly
    expect(a.classes[UNCLASSIFIED.NO_LEDGER]).toBe(1);
  });
});

// miss_autopsy — why did knowledge-update MISS? (task 205)
//
// The timeline arm's grid miss (knowledge-update 0.467 < 0.60, grid
// 2026-09-09-p1-195034+2026-09-10-p1-001549+2026-09-11-p1-123327) could not be
// diagnosed: banked rows carried NO retrieval provenance (meta.hits was a
// count, not ids/ranks) and NO per-candidate decision record. The stamps fixed
// that (meta.read_hits, meta.write_decisions, and the per-candidate ledger in
// summary.json). This module turns a STAMPED run's wrong knowledge-update rows
// into exactly one class each:
//
//   never-extracted          — no candidate carries the gold value: the
//                              extractor never produced the changing fact
//   added-blind              — the gold candidate was ADDed with no decider-
//                              visible neighbor (the search surfaced nothing,
//                              or its best hit was below the fastpath
//                              threshold and the call was skipped)
//   kept-wrong               — the decision saw neighbors and still KEEPed
//                              the candidate out (the gold says it changed)
//   superseded-but-unranked  — the gold fact IS current in the layer but the
//                              read did not rank it into the budget
//   ranked-but-answered-wrong — the gold fact was in the rendered context and
//                              the answerer still answered wrong
//
// Classification is a fixed cascade (write-side defects before read-side:
// never-extracted → kept-wrong → added-blind → superseded-but-unranked →
// ranked-but-answered-wrong) — exactly one class per row, the earliest owner
// of the failure. Rows without a decision ledger (runs from before the stamps,
// or --reanswer runs) are counted `unclassified-no-ledger`, never forced into
// a fake class — the same rule as a search failure stamping null, not [].
//
// CLI:  node bench/memory/miss_autopsy.mjs --run bench/memory/results/<run> \
//         [--arm mycelium-timeline] [--judged <file>]
// Prints the markdown section the receipts embed.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_AUTOPSY_ARM = 'mycelium-timeline';

// The five classes, in cascade order.
export const MISS_CLASSES = [
  'never-extracted',
  'kept-wrong',
  'added-blind',
  'superseded-but-unranked',
  'ranked-but-answered-wrong',
];
export const UNCLASSIFIED = { NO_LEDGER: 'unclassified-no-ledger', EMPTY_GOLD: 'unclassified-empty-gold' };

// Question_type the autopsy targets — the pre-committed §3 win condition is a
// knowledge-update bar; the other types' misses are not this instrument's brief.
export const AUTOPSY_QUESTION_TYPE = 'knowledge-update';

const STOPWORDS = new Set(
  (
    'a an the i me my we our you your he she it they them his her their its ' +
    'is am are was were be been being do does did have has had will would can ' +
    'could shall should may might must of in on at to for with about as by from ' +
    'and or but not no nor so if then than that this these those there here ' +
    'what which who whom when where why how now also just very own same too ' +
    's currently current new'
  ).split(' ')
);

// Normalize text into content tokens: lowercase, punctuation to spaces,
// possessives folded, stopwords dropped. The gold-match rule is lexical and
// stamped here — a paraphrase the lexicon cannot see reads as never-extracted,
// which is the honest failure of a lexical instrument (and the fixtures pin it).
export function contentTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[''`]s\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function candidateMatchesGold(candidateText, goldNorm, goldTokens) {
  const candNorm = String(candidateText ?? '')
    .toLowerCase()
    .replace(/[''`]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (goldNorm.length >= 4 && candNorm.includes(goldNorm)) return true;
  const candTokens = new Set(candNorm.split(' ').filter(Boolean));
  return goldTokens.every((t) => candTokens.has(t));
}

// The cascade. `row` needs gold + meta (read_hits, retrieval_error);
// `ledgerEntry` is the question's per-question write block from summary.json
// (its candidates_ledger). Returns { klass, best?, note? } — exactly one class.
export function classifyMiss({ row, ledgerEntry }) {
  const goldTokens = contentTokens(row?.gold);
  const goldNorm = goldTokens.join(' ');
  if (goldTokens.length === 0) return { klass: UNCLASSIFIED.EMPTY_GOLD };

  const candidates = ledgerEntry?.candidates_ledger;
  if (!Array.isArray(candidates) || candidates.length === 0) return { klass: UNCLASSIFIED.NO_LEDGER };

  // The gold-matching candidate: the LATEST candidate carrying the full gold
  // value (highest session_index, then highest in-session index) — for a
  // knowledge-update question the gold reflects the latest statement.
  let best = null;
  for (const c of candidates) {
    if (!candidateMatchesGold(c.text, goldNorm, goldTokens)) continue;
    if (
      best === null ||
      c.session_index > best.session_index ||
      (c.session_index === best.session_index && (c.index ?? 0) > (best.index ?? 0))
    ) {
      best = c;
    }
  }
  if (best === null) return { klass: 'never-extracted', best: null };

  // 2. the decision kept the update out
  if (best.decision === 'KEEP') return { klass: 'kept-wrong', best };

  // 3. the update was ADDed blind to whatever it should have superseded
  const blindSource = best.source === 'auto_add_on_no_match' || best.source === 'fastpath_below_threshold';
  if (blindSource || !Array.isArray(best.shown_ids) || best.shown_ids.length === 0) {
    return {
      klass: 'added-blind',
      best,
      note: best.source === 'fastpath_below_threshold' ? 'fastpath' : null,
    };
  }

  // 4/5. the fact IS in the layer — did the read rank it?
  const readHits = row?.meta?.read_hits;
  if (!Array.isArray(readHits)) {
    // null: a retrieval failure was stamped (or an unstamped legacy row) — the
    // read cannot be blamed for a ranking it never did; still, the fact was
    // not in context, which is the superseded-but-unranked outcome, noted.
    return {
      klass: 'superseded-but-unranked',
      best,
      note: row?.meta?.retrieval_error ? 'retrieval_error' : 'no_read_stamp',
    };
  }
  const ranked = new Set(readHits.map((h) => h.source_id));
  if (best.source_id && ranked.has(best.source_id)) return { klass: 'ranked-but-answered-wrong', best };
  return { klass: 'superseded-but-unranked', best };
}

// Compute the autopsy for one arm of one run. `judged` are the judge rows
// ({question_id, arm, question_type, label}), `rows` the arm's answer rows
// ({question_id, gold, meta}), `summary` the run's summary.json (the ledger).
export function computeAutopsy({ arm = DEFAULT_AUTOPSY_ARM, summary, judged, rows }) {
  const ledgerByQuestion = new Map();
  for (const pq of summary?.write_info?.[arm]?.timeline?.per_question ?? []) {
    if (pq && pq.question_id) ledgerByQuestion.set(pq.question_id, pq);
  }
  const rowsByQuestion = new Map((rows ?? []).map((r) => [r.question_id, r]));

  const judgedArm = (judged ?? []).filter((j) => j.arm === arm);
  const targets = judgedArm.filter((j) => j.question_type === AUTOPSY_QUESTION_TYPE && j.label === 'wrong');
  const unparsed = judgedArm.filter((j) => j.question_type === AUTOPSY_QUESTION_TYPE && j.label === null).length;

  const classes = Object.fromEntries([...MISS_CLASSES, UNCLASSIFIED.NO_LEDGER, UNCLASSIFIED.EMPTY_GOLD].map((k) => [k, 0]));
  const details = [];
  let withLedger = 0;
  let fastpath = 0;
  let failOpen = 0;
  let retrievalErrors = 0;
  for (const j of targets) {
    const row = rowsByQuestion.get(j.question_id) ?? null;
    const ledgerEntry = ledgerByQuestion.get(j.question_id) ?? null;
    const verdict = classifyMiss({ row: row ?? { gold: j.gold, meta: null }, ledgerEntry });
    classes[verdict.klass] += 1;
    if (verdict.best) withLedger += 1; // a classified row — the ledger carried its candidate
    if (verdict.note === 'fastpath') fastpath += 1;
    if (verdict.best && verdict.best.ok === false) failOpen += 1;
    if (verdict.note === 'retrieval_error') retrievalErrors += 1;
    details.push({ question_id: j.question_id, klass: verdict.klass, note: verdict.note ?? null });
  }

  // read-stamp coverage across ALL the arm's rows (not just the wrong ones) —
  // the receipt quotes this to show the instrument landed
  const armRows = rows ?? [];
  const withReadHits = armRows.filter((r) => Array.isArray(r.meta?.read_hits)).length;
  const nullReadHits = armRows.filter((r) => r.meta?.read_hits === null).length;
  const withWriteDecisions = armRows.filter((r) => r.meta?.write_decisions != null).length;

  return {
    arm,
    wrong_knowledge_update: targets.length,
    judge_unparsed: unparsed,
    ledger_coverage: targets.length ? withLedger / targets.length : null,
    classes,
    flags: { fastpath, fail_open: failOpen, retrieval_error: retrievalErrors },
    stamps: {
      rows: armRows.length,
      rows_with_read_hits: withReadHits,
      rows_read_hits_null: nullReadHits,
      rows_with_write_decisions: withWriteDecisions,
    },
    details,
  };
}

// The markdown section the receipts embed — beside the scores / 2×2 cell table.
// heading: the section heading line; null renders NO heading (the caller
// already printed one, e.g. the grid receipt's per-run heading).
export function renderAutopsySection(autopsy, { heading } = {}) {
  const L = [];
  if (heading !== null) L.push(heading ?? `## Knowledge-update miss autopsy (${autopsy.arm})`);
  L.push('');
  const cov = autopsy.ledger_coverage;
  L.push(
    `${autopsy.wrong_knowledge_update} wrong ${AUTOPSY_QUESTION_TYPE} row(s)` +
      (autopsy.judge_unparsed ? ` (+${autopsy.judge_unparsed} judge-unparsed, not classified)` : '') +
      (cov === null ? '' : `; ledger classified ${Math.round(cov * 100)}%`)
  );
  L.push('');
  L.push('| class | n |');
  L.push('|---|---|');
  for (const k of MISS_CLASSES) L.push(`| ${k} | ${autopsy.classes[k]} |`);
  const unclassified =
    autopsy.classes[UNCLASSIFIED.NO_LEDGER] + autopsy.classes[UNCLASSIFIED.EMPTY_GOLD];
  if (unclassified > 0) {
    L.push(`| ${UNCLASSIFIED.NO_LEDGER} | ${autopsy.classes[UNCLASSIFIED.NO_LEDGER]} |`);
    L.push(`| ${UNCLASSIFIED.EMPTY_GOLD} | ${autopsy.classes[UNCLASSIFIED.EMPTY_GOLD]} |`);
  }
  L.push('');
  const f = autopsy.flags;
  L.push(
    `Flags across classified rows: fastpath adds: ${f.fastpath} · fail-open decisions: ${f.fail_open} · retrieval-error reads: ${f.retrieval_error}`
  );
  const s = autopsy.stamps;
  if (s.rows > 0) {
    L.push(
      `Stamps: ${s.rows_with_read_hits}/${s.rows} rows carry meta.read_hits (null on retrieval error: ${s.rows_read_hits_null}); ` +
        `${s.rows_with_write_decisions}/${s.rows} carry meta.write_decisions.`
    );
  }
  if (autopsy.details.length) {
    L.push('');
    L.push('Per question:');
    for (const d of autopsy.details.slice(0, 20)) {
      L.push(`- ${d.question_id}: ${d.klass}${d.note ? ` (${d.note})` : ''}`);
    }
    if (autopsy.details.length > 20) L.push(`- … ${autopsy.details.length - 20} more (summary.json carries the run; re-run the CLI for the full list)`);
  }
  L.push('');
  L.push('The reconcile prompt is UNCHANGED this round — quoted verbatim in the regime block above.');
  return L.join('\n');
}

const defaultReadFile = (f) => fs.readFileSync(f, 'utf8');

function parseJsonl(text) {
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Load one run dir's evidence and compute the autopsy. Loud on missing files:
// a run without judged.jsonl or the arm's rows file has nothing to autopsy.
export function autopsyRun({
  dir,
  arm = DEFAULT_AUTOPSY_ARM,
  existsFn = fs.existsSync,
  readFileFn = defaultReadFile,
}) {
  const summaryFile = path.join(dir, 'summary.json');
  const judgedFile = path.join(dir, 'judged.jsonl');
  const rowsFile = path.join(dir, `${arm}.rows.jsonl`);
  for (const [name, file] of [['summary.json', summaryFile], ['judged.jsonl', judgedFile], [`${arm}.rows.jsonl`, rowsFile]]) {
    if (!existsFn(file)) throw new Error(`autopsy: ${dir} has no ${name} — nothing to autopsy (run not finished, or arm not in the run)`);
  }
  const summary = JSON.parse(readFileFn(summaryFile));
  const judged = parseJsonl(readFileFn(judgedFile));
  const rows = parseJsonl(readFileFn(rowsFile));
  return computeAutopsy({ arm, summary, judged, rows });
}

// --- CLI --------------------------------------------------------------------
// node bench/memory/miss_autopsy.mjs --run bench/memory/results/<run> [--arm ...]

async function main() {
  const argv = process.argv.slice(2);
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const runDir = get('run');
  if (!runDir) {
    console.error('usage: node bench/memory/miss_autopsy.mjs --run bench/memory/results/<run> [--arm mycelium-timeline] [--judged <file>]');
    process.exit(2);
  }
  const dir = path.resolve(runDir);
  const arm = get('arm') ?? DEFAULT_AUTOPSY_ARM;
  const autopsy = autopsyRun({ dir, arm });
  console.log(renderAutopsySection(autopsy));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error('autopsy FAILED:', e.message);
    process.exit(1);
  });
}

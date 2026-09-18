// task 229 — the pre-committed judge adoption gate (bench/memory/adoption.mjs).
//
// judge-prompt.4 (task 226) is LIVE for new primary runs, but it only becomes
// the QUOTED judge if its labels pass the gate pre-committed when it shipped:
// on run 2026-09-17-p1-224225's v4 labels, the four pre-committed _abs rows
// read EXACT, the three protected multi-session rows (00ca467f / 078150f1 /
// 1192316e — the rows v3 wrongly moved) STAY WRONG, and hand-vs-judge agreement
// is ≥ 19/20 on the director's 20 hand labels. Any failure → NOT ADOPTED and
// the quoted knowledge-update cell stays judge-prompt.2's 8/15 = 0.533.
//
// The gate is a PURE function over a judged file + a handlabels fixture — no
// fs, no judge calls — decided by the labels, never by preference.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADOPTION_GATE,
  adoptionGate,
  gateAppliesToRun,
} from '../../bench/memory/adoption.mjs';
import { agreement } from '../../bench/memory/judge.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- fixtures ---------------------------------------------------------------
// A hermetic 50-row stand-in for run 224225's timeline arm: the gate's named
// rows carry their pre-committed labels, the 20 hand-labelled ids (h01..h20)
// agree 19/20 (h20 is the one disagreement, mirroring the sim's 0a34ad58).

const ARM = 'mycelium-timeline';

function judgedRow(question_id, label, question_type = 'multi-session') {
  return { question_id, arm: ARM, question_type, label, judge_raw: label.toUpperCase(), judge_had_think: false };
}

function goodJudged() {
  const rows = [];
  // the four pre-committed _abs rows — EXACT
  for (const qid of ADOPTION_GATE.abs_rows_required_exact) rows.push(judgedRow(qid, 'exact', 'knowledge-update'));
  // the unpredicated fifth abstention row — the live leg decides; the gate ignores it
  rows.push(judgedRow('0862e8bf_abs', 'wrong', 'single-session-user'));
  // the three protected rows — STAY WRONG
  for (const qid of ADOPTION_GATE.protected_rows_stay_wrong) rows.push(judgedRow(qid, 'wrong', 'multi-session'));
  // 20 hand-labelled rows: h01..h19 exact (agree), h20 wrong vs hand exact (the one disagreement)
  for (let i = 1; i <= 20; i++) {
    rows.push(judgedRow(`h${String(i).padStart(2, '0')}`, i === 20 ? 'wrong' : 'exact', 'knowledge-update'));
  }
  // filler to a full run's shape (50 rows)
  for (let i = 21; i <= 41; i++) rows.push(judgedRow(`f${String(i).padStart(2, '0')}`, 'wrong', 'multi-session'));
  return rows;
}

function goodHandItems() {
  const items = [];
  for (let i = 1; i <= 19; i++) items.push({ question_id: `h${String(i).padStart(2, '0')}`, arm: ARM, label: 'exact' });
  items.push({ question_id: 'h20', arm: ARM, label: 'exact' }); // the disagreement
  return items;
}

// ---- the constants are the pre-commitment ------------------------------------

describe('adoption gate constants — the pre-commitment, named', () => {
  it('binds to run 2026-09-17-p1-224225 under judge-prompt.4', () => {
    expect(ADOPTION_GATE.of_run_id).toBe('2026-09-17-p1-224225');
    expect(ADOPTION_GATE.judge_prompt_version).toBe('judge-prompt.4');
  });

  it('names the four pre-committed _abs rows (the fifth, 0862e8bf_abs, is deliberately unpredicated)', () => {
    expect(ADOPTION_GATE.abs_rows_required_exact).toEqual([
      '031748ae_abs',
      '09ba9854_abs',
      '0ddfec37_abs',
      '15745da0_abs',
    ]);
    expect(ADOPTION_GATE.abs_rows_required_exact).not.toContain('0862e8bf_abs');
  });

  it('names the three protected rows v3 wrongly moved, and the 19/20 bar', () => {
    expect(ADOPTION_GATE.protected_rows_stay_wrong).toEqual(['00ca467f', '078150f1', '1192316e']);
    expect(ADOPTION_GATE.min_agreement).toBe(19);
    expect(ADOPTION_GATE.handlabel_n).toBe(20);
  });
});

// ---- the pure gate -----------------------------------------------------------

describe('adoptionGate — ADOPTED only when every pre-committed condition holds', () => {
  it('the sim-shaped labels ADOPT: 4/4 abs EXACT, protected rows wrong, 19/20 agreement', () => {
    const g = adoptionGate({ judged: goodJudged(), handItems: goodHandItems() });
    expect(g.evaluable).toBe(true);
    expect(g.verdict).toBe('ADOPTED');
    expect(g.conditions.map((c) => c.ok)).toEqual([true, true, true]);
    expect(g.agreement.agree).toBe(19);
    expect(g.agreement.n).toBe(20);
    // the unpredicated fifth abstention row is reported, never silent
    expect(g.unpredicated_abs_rows).toEqual(['0862e8bf_abs']);
  });

  it('one pre-committed _abs row reading wrong REFUSES, naming the row', () => {
    const judged = goodJudged();
    const row = judged.find((r) => r.question_id === '0ddfec37_abs');
    row.label = 'wrong';
    const g = adoptionGate({ judged, handItems: goodHandItems() });
    expect(g.verdict).toBe('NOT ADOPTED');
    const cond = g.conditions[0];
    expect(cond.ok).toBe(false);
    expect(cond.detail).toContain('0ddfec37_abs');
    expect(cond.detail).toContain('wrong');
  });

  it('a pre-committed _abs row MISSING from the judged file refuses (a gate that tolerates absence cannot fail)', () => {
    const judged = goodJudged().filter((r) => r.question_id !== '031748ae_abs');
    const g = adoptionGate({ judged, handItems: goodHandItems() });
    expect(g.verdict).toBe('NOT ADOPTED');
    expect(g.conditions[0].ok).toBe(false);
    expect(g.conditions[0].detail).toContain('031748ae_abs');
  });

  it('one protected row flipping to exact REFUSES, naming the row (the v3 defect, re-detected)', () => {
    const judged = goodJudged();
    const row = judged.find((r) => r.question_id === '1192316e');
    row.label = 'exact';
    const g = adoptionGate({ judged, handItems: goodHandItems() });
    expect(g.verdict).toBe('NOT ADOPTED');
    const cond = g.conditions[1];
    expect(cond.ok).toBe(false);
    expect(cond.detail).toContain('1192316e');
    expect(cond.detail).toContain('exact');
  });

  it('agreement 18/20 REFUSES, naming the count and the disagreements', () => {
    const handItems = goodHandItems();
    handItems.find((it) => it.question_id === 'h19').label = 'wrong'; // second disagreement
    const g = adoptionGate({ judged: goodJudged(), handItems });
    expect(g.verdict).toBe('NOT ADOPTED');
    expect(g.conditions[2].ok).toBe(false);
    expect(g.conditions[2].detail).toContain('18/20');
    expect(g.conditions[2].detail).toContain('h19');
  });

  it('NO handlabels is fail-closed: NOT ADOPTED, unevaluable, reason stated', () => {
    const g = adoptionGate({ judged: goodJudged(), handItems: null });
    expect(g.evaluable).toBe(false);
    expect(g.verdict).toBe('NOT ADOPTED');
    expect(g.unevaluable_reason).toMatch(/no handlabels/i);
  });

  it('a handlabels file that is not the 20-label set refuses to re-bar itself', () => {
    const g = adoptionGate({ judged: goodJudged(), handItems: goodHandItems().slice(0, 15) });
    expect(g.evaluable).toBe(false);
    expect(g.verdict).toBe('NOT ADOPTED');
    expect(g.unevaluable_reason).toContain('20');
    expect(g.unevaluable_reason).toContain('15');
  });

  it('judged rows missing from the file shrink agreement below n=20 and refuse (partial run)', () => {
    const judged = goodJudged().filter((r) => r.question_id !== 'h07');
    const g = adoptionGate({ judged, handItems: goodHandItems() });
    expect(g.verdict).toBe('NOT ADOPTED');
    expect(g.conditions[2].ok).toBe(false);
    expect(g.conditions[2].detail).toContain('18/19');
    expect(g.conditions[2].detail).toContain('≥19/20');
  });
});

// ---- the binding: which runs the gate decides for -----------------------------

describe('gateAppliesToRun — the gate runs only on the run and pass it was pre-committed on', () => {
  const load = (over = {}) => ({
    rejudge: {
      of_run_id: '2026-09-17-p1-224225',
      judge_prompt_version: 'judge-prompt.4',
      ...over,
    },
  });

  it('applies to the 224225 rejudge under judge-prompt.4', () => {
    expect(gateAppliesToRun(load())).toBe(true);
  });

  it('does not apply to the same run under judge-prompt.2 (the banked v2 receipt renders no gate)', () => {
    expect(gateAppliesToRun(load({ judge_prompt_version: 'judge-prompt.2' }))).toBe(false);
  });

  it('does not apply to a different run rejudged under v4', () => {
    expect(gateAppliesToRun(load({ of_run_id: '2026-09-09-p1-195034' }))).toBe(false);
  });

  it('does not apply to a primary run', () => {
    expect(gateAppliesToRun({ rejudge: null, summary: {} })).toBe(false);
  });
});

// ---- the gate over the REAL banked evidence -----------------------------------

describe('adoptionGate against the tracked evidence', () => {
  const DIR = path.join(REPO_ROOT, 'bench/memory/results/2026-09-17-p1-224225');

  it('the v2 pass FAILS the gate (its _abs rows read wrong; agreement 17/20) — v4 is not v2', () => {
    const judged = fs
      .readFileSync(path.join(DIR, 'judged.rejudge.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const hand = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'bench/memory/handlabels/2026-09-17-p1-224225.json'), 'utf8'));
    const g = adoptionGate({ judged, handItems: hand.items });
    expect(g.evaluable).toBe(true);
    expect(g.verdict).toBe('NOT ADOPTED');
    expect(g.conditions[0].ok).toBe(false); // v2 ruled the abstentions wrong
    expect(g.conditions[1].ok).toBe(true); // v2 never moved the protected rows
    expect(g.conditions[2].ok).toBe(false); // 17/20 < 19/20
    // the KU cell under v2 is the one the brief quotes as staying quoted
    const ku = judged.filter((r) => r.question_type === 'knowledge-update');
    expect(ku.filter((r) => r.label === 'exact')).toHaveLength(8);
    expect(ADOPTION_GATE.v2_quoted_ku).toBe('8/15 = 0.533');
  });
});

// ---- the gate's agreement is THE judge's agreement ----------------------------

describe('adoptionGate uses judge.mjs agreement (one definition of hand-vs-judge)', () => {
  it('the gate agreement object is agreement(judged, handItems)', () => {
    const judged = goodJudged();
    const handItems = goodHandItems();
    const g = adoptionGate({ judged, handItems });
    expect(g.agreement).toEqual(agreement(judged, handItems));
  });
});

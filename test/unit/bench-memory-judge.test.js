import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  parseLabel, tally, agreement, makeJudge, classifyGold, parseYesNo,
  judgePromptFact, judgePromptAbstention, FACT_SYSTEM, ABSTENTION_SYSTEM,
  FACT_RULES, ABSTENTION_RULES, JUDGE_PROMPT_SHA256, JUDGE_PROMPT_VERSION,
} from '../../bench/memory/judge.mjs';
import { stripThink } from '../../bench/memory/answer.mjs';

describe('bench/memory judge label parsing', () => {
  it('parses the label from a clean reply', () => {
    expect(parseLabel('EXACT')).toBe('exact');
    expect(parseLabel('partial')).toBe('partial');
    expect(parseLabel('WRONG')).toBe('wrong');
  });

  it('parses the first label word out of a chatty reply', () => {
    expect(parseLabel('The answer matches. Label: PARTIAL')).toBe('partial');
    expect(parseLabel('WRONG — the assistant invented a city.')).toBe('wrong');
  });

  it('is word-boundary safe: EXACTLY does not parse as EXACT', () => {
    expect(parseLabel('EXACTLY right')).toBe(null);
  });

  it('returns null (counted wrong + flagged) on no label — skeptical prior', () => {
    expect(parseLabel('I cannot decide.')).toBe(null);
    expect(parseLabel('')).toBe(null);
    expect(parseLabel(null)).toBe(null);
  });
});

describe('bench/memory tally', () => {
  it('computes p1_score = (exact + 0.5*partial)/n and reports unparsed as wrong', () => {
    const t = tally(['exact', 'exact', 'partial', 'wrong', null]);
    expect(t.n).toBe(5);
    expect(t.counts).toEqual({ exact: 2, partial: 1, wrong: 2 });
    expect(t.unparsed).toBe(1);
    expect(t.p1_score).toBeCloseTo((2 + 0.5) / 5);
  });

  it('empty label list scores 0, not NaN', () => {
    expect(tally([]).p1_score).toBe(0);
  });
});

describe('bench/memory judge agreement (vs hand-scored set)', () => {
  it('computes agreement over the hand-scored subset only', () => {
    const judged = [
      { question_id: 'a', arm: 'none', label: 'exact' },
      { question_id: 'b', arm: 'none', label: 'partial' },
      { question_id: 'c', arm: 'mycelium', label: 'wrong' },
      { question_id: 'd', arm: 'mycelium', label: 'exact' }, // not hand-scored
    ];
    const hand = [
      { question_id: 'a', arm: 'none', label: 'exact' },
      { question_id: 'b', arm: 'none', label: 'wrong' }, // disagreement
      { question_id: 'c', arm: 'mycelium', label: 'wrong' },
    ];
    const r = agreement(judged, hand);
    expect(r.n).toBe(3);
    expect(r.agree).toBe(2);
    expect(r.rate).toBeCloseTo(2 / 3);
    expect(r.disagree).toEqual([{ question_id: 'b', arm: 'none', hand: 'wrong', judge: 'partial' }]);
  });

  it('arm matters: same question_id on a different arm is a different item', () => {
    const judged = [
      { question_id: 'a', arm: 'none', label: 'exact' },
      { question_id: 'a', arm: 'mycelium', label: 'wrong' },
    ];
    const hand = [{ question_id: 'a', arm: 'mycelium', label: 'wrong' }];
    const r = agreement(judged, hand);
    expect(r.n).toBe(1);
    expect(r.agree).toBe(1);
  });
});

describe('bench/memory judge against a fake model', () => {
  it('makes a judge that returns label + raw', async () => {
    const calls = [];
    const judge = makeJudge({
      chat: async ({ system, user }) => {
        calls.push({ system, user });
        return { text: /YES or NO/.test(user) ? 'NO' : 'EXACT', hadThink: false };
      },
    });
    const r = await judge({ questionId: 'lisbon', question: 'Which city?', gold: 'Lisbon', answer: 'Lisbon' });
    expect(r.label).toBe('exact');
    const labelCall = calls[calls.length - 1];
    expect(labelCall.system).toMatch(/strict, fair grader/);
    expect(labelCall.user).toContain('Gold reference answer: Lisbon');
  });

  it('the prompt instructs one word and defines the three labels', () => {
    const p = judgePromptFact({ question: 'q', gold: 'g', answer: 'a' });
    for (const word of ['EXACT', 'PARTIAL', 'WRONG']) expect(p).toContain(word);
  });
});

describe('bench/memory judge prompt v4 — classify the GOLD first, then judge', () => {
  // the rule spans wrapped lines; normalize whitespace before matching long shapes
  const norm = (s) => s.replace(/\s+/g, ' ');

  // the v2 texts VERBATIM (master's history, commit 28473122, task 168). The
  // v4 fact prompt must be BYTE-IDENTICAL to them: a v4 fact-row label is then
  // literally a v2 label, and the 221 defect (a v3 rule moving non-abstention
  // rows) cannot recur — the abstention sentence does not exist in this prompt.
  const V2_SYSTEM =
    'You are a strict, fair grader for a memory benchmark. You compare an assistant\'s answer ' +
    'to a gold reference answer and output exactly one word. No explanation. ' +
    'An answer that does not state the gold fact is WRONG, never PARTIAL.';
  const v2Prompt = (question, gold, answer) => [
    `Question: ${question}`,
    `Gold reference answer: ${gold}`,
    `Assistant answer: ${answer}`,
    '',
    'Score the assistant answer. Apply these rules in order:',
    '- WRONG: the answer does not state the gold fact. Any refusal or "I don\'t know" /',
    '  "not in my memory" is WRONG; so is a restatement of context or memory without the',
    '  fact itself, an answer to a different question, and an answer asserting a different fact.',
    '- PARTIAL: the answer states part of the gold fact correctly — a name without the date,',
    '  a number off only by rounding, one of two items. If no part of the gold fact appears,',
    '  the label is WRONG, not PARTIAL.',
    '- EXACT: the answer states the gold fact; essentially equivalent wording is fine.',
    '',
    'Respond with exactly one word: EXACT, PARTIAL, or WRONG.',
  ].join('\n');

  it('stamps the rubric version', () => {
    expect(JUDGE_PROMPT_VERSION).toBe('judge-prompt.4');
  });

  // ---- stage A: the GOLD is classified before any judging -------------------
  it('a dataset-marked _abs gold classifies as abstention BY MARKER — the judge chat is never called for it', async () => {
    const chat = async () => { throw new Error('stage A must not call the judge for a marked gold'); };
    const gc = await classifyGold({ questionId: '031748ae_abs', gold: 'The information provided is not enough.', chat });
    expect(gc).toEqual({ gold_class: 'abstention', gold_class_source: 'dataset-marker' });
  });

  it('a fact-shaped id without a marker routes ONE YES/NO call over the GOLD ALONE', async () => {
    const calls = [];
    const gc = await classifyGold({
      questionId: '00ca467f',
      gold: 'The information provided is not enough. You did not mention the bus.',
      chat: async (c) => { calls.push(c); return { text: 'YES', hadThink: false }; },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].user).toContain('The information provided is not enough. You did not mention the bus.');
    expect(norm(calls[0].user)).toMatch(/YES or NO\.?$/);
    expect(calls[0].user).not.toMatch(/Assistant answer/); // the gold ALONE — the answer is not in stage A
    expect(gc).toMatchObject({ gold_class: 'abstention', gold_class_source: 'judge', gold_class_parsed: 'yes' });
  });

  it('a NO reply classifies the gold as fact; an UNPARSABLE reply is skeptical-NO (fact) and reports the parse failure', async () => {
    for (const reply of ['NO', 'The reference answer states a fact. NO', 'maybe', '']) {
      const gc = await classifyGold({ questionId: 'q1', gold: '43', chat: async () => ({ text: reply, hadThink: false }) });
      expect(gc.gold_class).toBe('fact');
      expect(gc.gold_class_source).toBe('judge');
      expect(gc.gold_class_parsed).toBe(reply.includes('NO') ? 'no' : null);
    }
  });

  it('a gold with NO questionId at all (a legacy caller) still classifies — by the YES/NO call, not by marker', async () => {
    const gc = await classifyGold({ gold: 'You did not mention this information.', chat: async () => ({ text: 'YES', hadThink: false }) });
    expect(gc.gold_class_source).toBe('judge');
    expect(gc.gold_class).toBe('abstention');
  });

  it('parseYesNo is word-boundary safe: NOTED is not NO, EYES is not YES', () => {
    expect(parseYesNo('YES')).toBe('yes');
    expect(parseYesNo('The reference says unavailable. NO')).toBe('no');
    expect(parseYesNo('NOTED')).toBe(null);
    expect(parseYesNo('EYES')).toBe(null);
    expect(parseYesNo('I cannot decide.')).toBe(null);
    expect(parseYesNo(null)).toBe(null);
  });

  // ---- stage B: the prompt follows the GOLD's class -------------------------
  it('the fact prompt is the v2 prompt VERBATIM — no abstention wording anywhere in prompt or system', () => {
    const p = judgePromptFact({ question: 'q', gold: 'g', answer: 'a' });
    expect(p).toBe(v2Prompt('q', 'g', 'a'));
    expect(p).not.toMatch(/abstention/i);
    expect(p).not.toMatch(/not available/);
    expect(FACT_SYSTEM).toBe(V2_SYSTEM);
    // every v2 rule survives: non-answers WRONG, PARTIAL needs part of the gold fact, ordering holds
    expect(p).toMatch(/WRONG: the answer does not state the gold fact/);
    expect(p).toMatch(/not in my memory/i);
    expect(p.indexOf('- WRONG:')).toBeLessThan(p.indexOf('- PARTIAL:'));
    expect(p.indexOf('- PARTIAL:')).toBeLessThan(p.indexOf('- EXACT:'));
  });

  it('the abstention prompt is dedicated: decline-without-inventing is EXACT, asserting the unavailable fact is WRONG, and PARTIAL does not exist', () => {
    const p = judgePromptAbstention({ question: 'q', gold: 'g', answer: 'a' });
    expect(norm(p)).toMatch(/declines to assert the missing fact AND does not invent it is EXACT/);
    expect(norm(p)).toMatch(/asserts a fact the gold says is not available is WRONG/);
    expect(p).not.toMatch(/PARTIAL/);
    expect(ABSTENTION_SYSTEM).not.toMatch(/PARTIAL/);
    expect(norm(p)).toMatch(/EXACT or WRONG\.?$/);
  });

  it('both prompt texts carry their sha256 — recomputed here so the stamp cannot drift from the text', () => {
    const want = (text) => createHash('sha256').update(text).digest('hex');
    expect(JUDGE_PROMPT_SHA256.fact).toBe(want(FACT_SYSTEM + '\n' + FACT_RULES));
    expect(JUDGE_PROMPT_SHA256.abstention).toBe(want(ABSTENTION_SYSTEM + '\n' + ABSTENTION_RULES));
    expect(JUDGE_PROMPT_SHA256.fact).not.toBe(JUDGE_PROMPT_SHA256.abstention);
  });

  // ---- makeJudge: stage A then stage B, class stamped on the result ---------
  it('makeJudge routes a MARKED abstention gold straight to the abstention prompt — one chat call, class stamped', async () => {
    const seen = [];
    const judge = makeJudge({ chat: async (c) => { seen.push(c); return { text: 'EXACT', hadThink: false }; } });
    // the 0ddfec37_abs shape: the gold itself says the premise is false
    const r = await judge({
      questionId: '0ddfec37_abs',
      question: 'Do I collect autographed footballs?',
      gold: 'The information provided is not enough. You mentioned collecting autographed baseball but not football.',
      answer: 'I don\'t have any information about autographed footballs in your collection. The only autographed items I have records of are 20 autographed baseballs.',
    });
    expect(seen).toHaveLength(1); // no YES/NO pre-call for a marked gold
    expect(seen[0].user).toContain('declines to assert the missing fact');
    expect(r).toMatchObject({ label: 'exact', gold_class: 'abstention', gold_class_source: 'dataset-marker', prompt_kind: 'abstention' });
  });

  it('makeJudge routes a fact gold to the v2 prompt EVEN when the answer reads like an abstention — the 00ca467f defect cannot recur', async () => {
    const seen = [];
    const judge = makeJudge({ chat: async (c) => { seen.push(c); return { text: /YES or NO/.test(c.user) ? 'NO' : 'WRONG', hadThink: false }; } });
    const args = {
      questionId: '00ca467f',
      question: 'How many doctor\'s appointments did I have in March?',
      gold: 2, // the run's own shape: a bare-number fact gold
      answer: 'I don\'t have any information in my memory about doctor\'s appointments … no record of actual visits in March',
    };
    const r = await judge(args);
    expect(seen).toHaveLength(2); // the YES/NO classify over the gold ALONE, then the label call
    expect(seen[0].user).toContain('2'); // the gold — the answer is not in stage A
    expect(seen[0].user).not.toContain(args.answer);
    expect(seen[1].user).toBe(v2Prompt(args.question, String(args.gold), args.answer));
    expect(seen[1].user).not.toMatch(/abstention/i);
    expect(r).toMatchObject({ label: 'wrong', gold_class: 'fact', gold_class_source: 'judge', gold_class_parsed: 'no', prompt_kind: 'fact' });
  });
});

describe('bench/memory think-block stripping', () => {
  it('strips <think> blocks and reports that it did', () => {
    const r = stripThink('<think>reasoning here</think>Lisbon.');
    expect(r.text).toBe('Lisbon.');
    expect(r.hadThink).toBe(true);
  });

  it('passes clean text through untouched', () => {
    const r = stripThink('Lisbon.');
    expect(r.text).toBe('Lisbon.');
    expect(r.hadThink).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { parseLabel, tally, agreement, makeJudge, judgePrompt, JUDGE_SYSTEM, JUDGE_PROMPT_VERSION } from '../../bench/memory/judge.mjs';
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
    const judge = makeJudge({
      chat: async ({ system, user }) => {
        expect(system).toMatch(/strict, fair grader/);
        expect(user).toContain('Gold reference answer: Lisbon');
        return { text: 'EXACT', hadThink: false };
      },
    });
    const r = await judge({ question: 'Which city?', gold: 'Lisbon', answer: 'Lisbon' });
    expect(r.label).toBe('exact');
  });

  it('the prompt instructs one word and defines the three labels', () => {
    const p = judgePrompt({ question: 'q', gold: 'g', answer: 'a' });
    for (const word of ['EXACT', 'PARTIAL', 'WRONG']) expect(p).toContain(word);
  });
});

describe('bench/memory judge prompt v3 — an abstention gold makes a clean abstention EXACT', () => {
  // the rule spans wrapped lines; normalize whitespace before matching long shapes
  const norm = (s) => s.replace(/\s+/g, ' ');

  it('stamps the rubric version', () => {
    expect(JUDGE_PROMPT_VERSION).toBe('judge-prompt.3');
  });

  it('carries the abstention rule and applies it FIRST — before the WRONG rule', () => {
    const p = judgePrompt({ question: 'q', gold: 'g', answer: 'a' });
    expect(norm(p)).toMatch(
      /ABSTENTION GOLD — apply this rule FIRST: if the gold reference answer itself says the information is not available \/ not enough \/ the premise is wrong/
    );
    expect(p.indexOf('ABSTENTION GOLD')).toBeLessThan(p.indexOf('- WRONG:'));
  });

  it('the abstention rule: declining without inventing is EXACT; asserting the unavailable fact is WRONG', () => {
    const p = norm(judgePrompt({ question: 'q', gold: 'g', answer: 'a' }));
    expect(p).toMatch(/an assistant answer that declines to assert the missing fact AND does not invent it is EXACT/);
    expect(p).toMatch(/an answer that asserts a fact the gold says is not available is WRONG/);
  });

  it('keeps every v2 rule: non-answers WRONG, PARTIAL needs part of the gold fact, EXACT is equivalent wording', () => {
    const p = judgePrompt({ question: 'q', gold: 'g', answer: 'a' });
    expect(p).toMatch(/WRONG: the answer does not state the gold fact/);
    expect(p).toMatch(/not in my memory/i);
    expect(p).toMatch(/restatement of context or memory without the\s+fact/);
    expect(p).toMatch(/different question/);
    expect(p).toMatch(/PARTIAL: the answer states part of the gold fact correctly/);
    expect(p).toMatch(/If no part of the gold fact appears,\n\s*the label is WRONG, not PARTIAL/);
    // v1's lenient phrasing must not survive anywhere in the prompt
    expect(p).not.toMatch(/same topic, but incomplete/);
    expect(p).toMatch(/EXACT: the answer states the gold fact; essentially equivalent wording is fine/);
    // the v2 ordering holds too: WRONG still leads the per-shape rules, so a
    // grader cannot reach PARTIAL without first passing the non-answer test
    expect(p.indexOf('WRONG: the answer does not state')).toBeLessThan(p.indexOf('PARTIAL: the answer states part'));
  });

  it('the system prompt keeps the never-partial rule and gains the abstention carve-out', () => {
    expect(JUDGE_SYSTEM).toMatch(/strict, fair grader/);
    expect(JUDGE_SYSTEM).toMatch(/does not state the gold fact is WRONG, never PARTIAL/);
    expect(JUDGE_SYSTEM).toMatch(/information is not available/);
    expect(JUDGE_SYSTEM).toMatch(/declines without inventing is EXACT/);
  });

  it('makeJudge sends the v3 rubric — abstention rule on top — and still parses the one-word reply', async () => {
    let sawPrompt = null;
    const judge = makeJudge({
      chat: async ({ system, user }) => {
        sawPrompt = user;
        expect(system).toMatch(/never PARTIAL/);
        return { text: 'EXACT', hadThink: false };
      },
    });
    // the 0ddfec37_abs shape: the gold itself says the premise is false
    const r = await judge({
      question: 'Do I collect autographed footballs?',
      gold: 'The information provided is not enough. You mentioned collecting autographed baseball but not football.',
      answer: 'I don\'t have any information about autographed footballs in your collection. The only autographed items I have records of are 20 autographed baseballs.',
    });
    expect(r.label).toBe('exact');
    expect(sawPrompt).toContain('ABSTENTION GOLD');
    expect(sawPrompt.indexOf('ABSTENTION GOLD')).toBeLessThan(sawPrompt.indexOf('- WRONG:'));
    expect(sawPrompt).toContain('Gold reference answer: The information provided is not enough.');
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

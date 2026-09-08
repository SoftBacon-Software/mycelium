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

describe('bench/memory judge prompt v2 — a non-answer is WRONG, never PARTIAL', () => {
  it('stamps the rubric version', () => {
    expect(JUDGE_PROMPT_VERSION).toBe('judge-prompt.2');
  });

  it('the rubric leads with does-not-state-the-gold-fact => WRONG and names every non-answer shape', () => {
    const p = judgePrompt({ question: 'q', gold: 'g', answer: 'a' });
    expect(p).toMatch(/WRONG: the answer does not state the gold fact/);
    expect(p).toMatch(/not in my memory/i);
    expect(p).toMatch(/restatement of context or memory without the\s+fact/);
    expect(p).toMatch(/different question/);
    // the rules are ordered: WRONG first, so a grader cannot reach PARTIAL
    // without first passing the non-answer test
    expect(p.indexOf('WRONG: the answer does not state')).toBeLessThan(p.indexOf('PARTIAL: the answer states part'));
  });

  it('PARTIAL requires part of the gold fact on the table — and says what happens otherwise', () => {
    const p = judgePrompt({ question: 'q', gold: 'g', answer: 'a' });
    expect(p).toMatch(/PARTIAL: the answer states part of the gold fact correctly/);
    expect(p).toMatch(/If no part of the gold fact appears,\n\s*the label is WRONG, not PARTIAL/);
    // v1's lenient phrasing must not survive anywhere in the prompt
    expect(p).not.toMatch(/same topic, but incomplete/);
  });

  it('EXACT keeps the however-phrased contract', () => {
    const p = judgePrompt({ question: 'q', gold: 'g', answer: 'a' });
    expect(p).toMatch(/EXACT: the answer states the gold fact; essentially equivalent wording is fine/);
  });

  it('the system prompt carries the never-partial rule', () => {
    expect(JUDGE_SYSTEM).toMatch(/strict, fair grader/);
    expect(JUDGE_SYSTEM).toMatch(/does not state the gold fact is WRONG, never PARTIAL/);
  });

  it('makeJudge sends the v2 rubric and still parses the one-word reply', async () => {
    let sawPrompt = null;
    const judge = makeJudge({
      chat: async ({ system, user }) => {
        sawPrompt = user;
        expect(system).toMatch(/never PARTIAL/);
        return { text: 'WRONG', hadThink: false };
      },
    });
    const r = await judge({ question: 'How many years?', gold: '43', answer: 'I do not have that in my memory.' });
    expect(r.label).toBe('wrong');
    expect(sawPrompt).toContain('Gold reference answer: 43');
    expect(sawPrompt).toMatch(/does not state the gold fact/);
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

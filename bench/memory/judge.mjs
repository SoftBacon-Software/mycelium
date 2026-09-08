// The judge: a LOCAL model scores each answer exact / partial / wrong against
// the gold answer. Validated against a hand-scored set before its numbers are
// quoted (see README "Judge validation").

export const LABELS = ['exact', 'partial', 'wrong'];

// Version of the label rubric below — stamped into every regime (fresh runs)
// and into every rejudge summary/receipt. Bump when the rubric changes: two
// runs judged under different rubrics are not comparable.
// v1 (implicit, never stamped): PARTIAL was "same topic, but incomplete", and
//   the judge spent it on refusals and restated-context non-answers — all four
//   hand-vs-judge disagreements of run 2026-09-08-p1-185920 ran one way
//   (hand=wrong, judge=partial).
// v2 (2026-09-08, task 168): a non-answer is WRONG by rule. WRONG leads the
//   rubric (does not state the gold fact — refusals, "not in my memory",
//   restated context without the fact, a different question); PARTIAL now
//   REQUIRES part of the gold fact on the table.
export const JUDGE_PROMPT_VERSION = 'judge-prompt.2';

export const JUDGE_SYSTEM =
  'You are a strict, fair grader for a memory benchmark. You compare an assistant\'s answer ' +
  'to a gold reference answer and output exactly one word. No explanation. ' +
  'An answer that does not state the gold fact is WRONG, never PARTIAL.';

export function judgePrompt({ question, gold, answer }) {
  return [
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
}

// First EXACT/PARTIAL/WRONG token anywhere in the reply. Ties are impossible
// (one position can only match one token). No token -> null (skeptical prior:
// an unparsable judge reply is NOT silently treated as a pass — it is counted
// wrong and reported as a parse failure).
export function parseLabel(raw) {
  const text = String(raw ?? '').toUpperCase();
  let best = null;
  for (const token of ['EXACT', 'PARTIAL', 'WRONG']) {
    const at = text.indexOf(token);
    if (at === -1) continue;
    const before = text[at - 1];
    const after = text[at + token.length];
    const wordish = (c) => c === undefined || !/[A-Z]/.test(c);
    if (!wordish(before) || !wordish(after)) continue;
    if (best === null || at < best.at) best = { at, label: token.toLowerCase() };
  }
  return best ? best.label : null;
}

export function makeJudge({ chat }) {
  return async function judge({ question, gold, answer }) {
    const r = await chat({ system: JUDGE_SYSTEM, user: judgePrompt({ question, gold, answer }) });
    const label = parseLabel(r.text);
    return { label, raw: r.text, had_think: !!r.hadThink };
  };
}

// label -> score weight. Primary reporting is the raw counts; p1_score is the
// single number used for arm-vs-arm comparison.
export const SCORE_WEIGHT = { exact: 1, partial: 0.5, wrong: 0 };

export function tally(labels) {
  const counts = { exact: 0, partial: 0, wrong: 0 };
  let unparsed = 0;
  for (const l of labels) {
    if (l === null || l === undefined) { unparsed++; counts.wrong++; continue; }
    counts[l] = (counts[l] || 0) + 1;
  }
  const n = labels.length;
  return {
    n,
    counts,
    unparsed,
    p1_score: n ? (counts.exact + SCORE_WEIGHT.partial * counts.partial) / n : 0,
  };
}

// Judge validation: agreement between the judge's labels and a hand-scored set.
export function agreement(judged, hand) {
  // both: [{question_id, arm, label}] — keyed by question_id+arm
  const handMap = new Map(hand.map((h) => [`${h.question_id}|${h.arm}`, h.label]));
  let n = 0, agree = 0;
  const disagree = [];
  for (const j of judged) {
    const key = `${j.question_id}|${j.arm}`;
    if (!handMap.has(key)) continue;
    n++;
    if (handMap.get(key) === j.label) { agree++; continue; }
    disagree.push({ question_id: j.question_id, arm: j.arm, hand: handMap.get(key), judge: j.label });
  }
  return { n, agree, rate: n ? agree / n : 0, disagree };
}

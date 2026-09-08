// The judge: a LOCAL model scores each answer exact / partial / wrong against
// the gold answer. Validated against a hand-scored set before its numbers are
// quoted (see README "Judge validation").

export const LABELS = ['exact', 'partial', 'wrong'];

export const JUDGE_SYSTEM =
  'You are a strict, fair grader for a memory benchmark. You compare an assistant\'s answer ' +
  'to a gold reference answer and output exactly one word. No explanation.';

export function judgePrompt({ question, gold, answer }) {
  return [
    `Question: ${question}`,
    `Gold reference answer: ${gold}`,
    `Assistant answer: ${answer}`,
    '',
    'Score the assistant answer:',
    '- EXACT: it states the gold fact, essentially equivalent wording is fine.',
    '- PARTIAL: partly right — same topic, but incomplete, vague, or imprecise compared to the gold.',
    '- WRONG: factually incorrect, asserts something different, or does not answer the question.',
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

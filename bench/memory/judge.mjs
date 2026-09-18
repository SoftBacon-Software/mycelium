// The judge: a LOCAL model scores each answer exact / partial / wrong against
// the gold answer. Validated against a hand-scored set before its numbers are
// quoted (see README "Judge validation").

import { createHash } from 'node:crypto';

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
// v3 (2026-09-18, task 221): abstention golds. LongMemEval's _abs variants have
//   golds that THEMSELVES say the information is not available — v2 ruled an
//   honest answer to those WRONG by rule (run 2026-09-17-p1-224225:
//   031748ae_abs, 0ddfec37_abs stated the gold and were labelled wrong). The
//   abstention rule is applied FIRST: a gold whose premise is false makes a
//   clean decline (asserting nothing the gold says is unavailable) EXACT, and
//   an answer that asserts the unavailable fact WRONG. NOT ADOPTED: the rule
//   lived in ONE prompt and detection with it — the judge fired it on the
//   ANSWER's wording, moving three non-abstention rows whose answers merely
//   declined (00ca467f, 078150f1, 1192316e; a ~19B judge at 12 max_tokens does
//   not reliably condition on "if the GOLD says unavailable").
// v4 (2026-09-18, task 226): classify the GOLD first, then judge — never one
//   small call doing both. Stage A stamps each row gold_class
//   (fact | abstention) from the dataset's own marker (question_ids carrying
//   the _abs suffix ARE the abstention variants; observed: every _abs gold in
//   run 2026-09-17-p1-224225 begins "The information provided is not enough" /
//   "You did not mention") or — when no marker exists, a future split — ONE
//   YES/NO call over the GOLD ALONE. Stage B then picks the prompt BY CLASS:
//   fact golds are judged under the v2 prompt VERBATIM (no abstention sentence
//   anywhere, so the rule cannot fire); abstention golds get a dedicated
//   binary prompt (decline-without-inventing EXACT, asserting the unavailable
//   fact WRONG). Both texts' sha256 is stamped into the regime.
export const JUDGE_PROMPT_VERSION = 'judge-prompt.4';

// ---- stage B, fact branch: the v2 prompt, byte-identical to task 168's -----
export const FACT_SYSTEM =
  'You are a strict, fair grader for a memory benchmark. You compare an assistant\'s answer ' +
  'to a gold reference answer and output exactly one word. No explanation. ' +
  'An answer that does not state the gold fact is WRONG, never PARTIAL.';

export const FACT_RULES = [
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

export function judgePromptFact({ question, gold, answer }) {
  return [
    `Question: ${question}`,
    `Gold reference answer: ${gold}`,
    `Assistant answer: ${answer}`,
    '',
    FACT_RULES,
  ].join('\n');
}

// ---- stage B, abstention branch: the dedicated binary prompt ---------------
export const ABSTENTION_SYSTEM =
  'You are a strict, fair grader for a memory benchmark. You compare an assistant\'s answer ' +
  'to a gold reference answer that itself says the information is not available, and you ' +
  'output exactly one word. No explanation.';

export const ABSTENTION_RULES = [
  'The gold reference answer says the information is NOT available (not enough information /',
  'not mentioned / the premise is wrong). Score the assistant answer against THAT:',
  '- an assistant answer that declines to assert the missing fact AND does not invent it is EXACT —',
  '  an honest "I don\'t know" / "I don\'t have that information" / "not in my memory" is EXACT here.',
  '- an answer that asserts a fact the gold says is not available is WRONG, or invents one in its place.',
  '',
  'Respond with exactly one word: EXACT or WRONG.',
].join('\n');

export function judgePromptAbstention({ question, gold, answer }) {
  return [
    `Question: ${question}`,
    `Gold reference answer: ${gold}`,
    `Assistant answer: ${answer}`,
    '',
    ABSTENTION_RULES,
  ].join('\n');
}

// The two prompt texts' sha256 — stamped into the regime (judge block) so a
// reader can verify which text produced the labels. The hashed text is the
// system prompt + the static rule body (the variable Question/Gold/Answer
// header lines are fixed wiring).
export const JUDGE_PROMPT_SHA256 = {
  fact: createHash('sha256').update(FACT_SYSTEM + '\n' + FACT_RULES).digest('hex'),
  abstention: createHash('sha256').update(ABSTENTION_SYSTEM + '\n' + ABSTENTION_RULES).digest('hex'),
};

// ---- stage A: classify the GOLD --------------------------------------------
// Source of truth, in order: (a) the dataset's own marker — LongMemEval
// question_ids carrying the _abs suffix ARE the abstention variants; (b) no
// marker (a future split): ONE judge call over the GOLD ALONE.
export function isMarkedAbstention(questionId) {
  return typeof questionId === 'string' && questionId.endsWith('_abs');
}

export const GOLD_CLASSIFIER_SYSTEM =
  'You are a precise classifier for a memory benchmark. You read a reference answer and ' +
  'answer exactly one word. No explanation.';

export function goldClassifyPrompt({ gold }) {
  return [
    `Reference answer: ${gold}`,
    '',
    'Does this reference answer say the information is unavailable — the information is not',
    'enough / not mentioned / the premise is wrong — rather than stating a fact?',
    'Respond with exactly one word: YES or NO.',
  ].join('\n');
}

// First YES/NO token in the reply, word-boundary safe (NOTED is not NO, EYES is
// not YES). No token -> null — the caller treats that as NO (skeptical: an
// unparsable classify does NOT create an abstention) and reports it.
export function parseYesNo(raw) {
  const text = String(raw ?? '').toUpperCase();
  let best = null;
  for (const token of ['YES', 'NO']) {
    let at = text.indexOf(token);
    while (at !== -1) {
      const before = text[at - 1];
      const after = text[at + token.length];
      const wordish = (c) => c === undefined || !/[A-Z]/.test(c);
      if (wordish(before) && wordish(after)) {
        if (best === null || at < best.at) best = { at, word: token.toLowerCase() };
        break;
      }
      at = text.indexOf(token, at + 1);
    }
  }
  return best ? best.word : null;
}

// Stage A: the gold's class. A marked id decides BY MARKER with no judge call;
// anything else routes ONE call over the gold alone (chat: the label chat at
// judge budget — YES/NO fits far inside it).
export async function classifyGold({ questionId, gold, chat }) {
  if (isMarkedAbstention(questionId)) {
    return { gold_class: 'abstention', gold_class_source: 'dataset-marker' };
  }
  const r = await chat({ system: GOLD_CLASSIFIER_SYSTEM, user: goldClassifyPrompt({ gold }) });
  const parsed = parseYesNo(r.text);
  return {
    gold_class: parsed === 'yes' ? 'abstention' : 'fact',
    gold_class_source: 'judge',
    gold_class_parsed: parsed,
  };
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

export function makeJudge({ chat, classifyChat = null }) {
  return async function judge({ question, gold, answer, questionId }) {
    const gc = await classifyGold({ questionId, gold, chat: classifyChat ?? chat });
    const abstention = gc.gold_class === 'abstention';
    const r = await chat({
      system: abstention ? ABSTENTION_SYSTEM : FACT_SYSTEM,
      user: abstention
        ? judgePromptAbstention({ question, gold, answer })
        : judgePromptFact({ question, gold, answer }),
    });
    const label = parseLabel(r.text);
    return {
      label,
      raw: r.text,
      hadThink: !!r.hadThink,
      gold_class: gc.gold_class,
      gold_class_source: gc.gold_class_source,
      ...(gc.gold_class_parsed !== undefined ? { gold_class_parsed: gc.gold_class_parsed } : {}),
      prompt_kind: abstention ? 'abstention' : 'fact',
    };
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

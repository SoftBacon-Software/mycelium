// adoption — the pre-committed judge-prompt.4 adoption gate (task 226,
// mechanically enforced here for task 229).
//
// judge-prompt.4 is LIVE for new primary runs, but it only becomes the QUOTED
// judge if its labels pass the gate that was pre-committed when it shipped:
// on run 2026-09-17-p1-224225's v4 labels —
//   1. the four pre-committed _abs rows read EXACT,
//   2. the three protected multi-session rows (00ca467f / 078150f1 / 1192316e
//      — the rows judge-prompt.3 wrongly moved) STAY WRONG,
//   3. hand-vs-judge agreement is ≥ 19/20 on the director's 20 hand labels.
// Any failure → NOT ADOPTED, and the quoted knowledge-update cell stays
// judge-prompt.2's 8/15 = 0.533. No downstream artifact may quote a
// judge-prompt.4 number as the arm number.
//
// The gate is a PURE function over a judged row list + a handlabels item list
// — no fs, no judge calls. It is decided by the labels, never by preference,
// and it is fail-closed: without exactly the pre-committed 20 hand labels it
// refuses to call itself evaluable and returns NOT ADOPTED.

import { agreement } from './judge.mjs';

export const ADOPTION_GATE = {
  of_run_id: '2026-09-17-p1-224225',
  judge_prompt_version: 'judge-prompt.4',
  // the four abstention-gold rows pre-committed to read EXACT under v4
  // (0862e8bf_abs is the FIFTH abstention row and is deliberately
  // unpredicated — the live leg decides it; the gate reports it, never gates
  // on it)
  abs_rows_required_exact: ['031748ae_abs', '09ba9854_abs', '0ddfec37_abs', '15745da0_abs'],
  // the rows judge-prompt.3 wrongly moved — v4 must leave them wrong
  protected_rows_stay_wrong: ['00ca467f', '078150f1', '1192316e'],
  min_agreement: 19,
  handlabel_n: 20,
  // what stays quoted if the gate refuses (task 226's pre-committed number)
  v2_quoted_ku: '8/15 = 0.533',
};

// adoptionGate({ judged, handItems }) →
// {
//   evaluable, verdict: 'ADOPTED' | 'NOT ADOPTED',
//   conditions: [{ name, ok, detail }],
//   agreement,                     // judge.mjs agreement(judged, handItems)
//   unpredicated_abs_rows,         // abstention rows the pre-commitment is silent on
//   unevaluable_reason,            // set when evaluable === false
// }
export function adoptionGate({ judged, handItems }) {
  const abstentionIds = judged
    .filter((r) => String(r.question_id ?? '').endsWith('_abs'))
    .map((r) => r.question_id);
  const unpredicated = abstentionIds.filter((qid) => !ADOPTION_GATE.abs_rows_required_exact.includes(qid));

  if (!Array.isArray(handItems) || handItems.length === 0) {
    return {
      evaluable: false,
      verdict: 'NOT ADOPTED',
      conditions: [],
      agreement: null,
      unpredicated_abs_rows: unpredicated,
      unevaluable_reason: `no handlabels for run ${ADOPTION_GATE.of_run_id} — the gate is fail-closed without the director's ${ADOPTION_GATE.handlabel_n} hand labels`,
    };
  }
  if (handItems.length !== ADOPTION_GATE.handlabel_n) {
    return {
      evaluable: false,
      verdict: 'NOT ADOPTED',
      conditions: [],
      agreement: null,
      unpredicated_abs_rows: unpredicated,
      unevaluable_reason: `handlabels carry ${handItems.length} items, the gate was pre-committed on exactly ${ADOPTION_GATE.handlabel_n} — a different sample cannot re-bar itself`,
    };
  }

  const byId = new Map(judged.map((r) => [r.question_id, r]));

  // condition 1 — the four pre-committed _abs rows read EXACT
  const absBad = [];
  for (const qid of ADOPTION_GATE.abs_rows_required_exact) {
    const row = byId.get(qid);
    if (!row) absBad.push(`${qid} missing from the judged file`);
    else if (row.label !== 'exact') absBad.push(`${qid} reads ${row.label}, pre-committed EXACT`);
  }
  const condAbs = {
    name: 'pre-committed _abs rows EXACT',
    ok: absBad.length === 0,
    detail: absBad.length === 0
      ? `${ADOPTION_GATE.abs_rows_required_exact.length}/${ADOPTION_GATE.abs_rows_required_exact.length} pre-committed _abs rows read EXACT (${ADOPTION_GATE.abs_rows_required_exact.join(', ')})`
      : absBad.join('; '),
  };

  // condition 2 — the protected rows STAY WRONG (the v3 defect, re-detected)
  const protBad = [];
  for (const qid of ADOPTION_GATE.protected_rows_stay_wrong) {
    const row = byId.get(qid);
    if (!row) protBad.push(`${qid} missing from the judged file`);
    else if (row.label === 'exact') protBad.push(`${qid} reads exact, pre-committed WRONG`);
    else if (row.label === 'partial') protBad.push(`${qid} reads partial, pre-committed WRONG`);
  }
  const condProtected = {
    name: 'protected rows stay WRONG',
    ok: protBad.length === 0,
    detail: protBad.length === 0
      ? `${ADOPTION_GATE.protected_rows_stay_wrong.join(', ')} all wrong`
      : protBad.join('; '),
  };

  // condition 3 — hand-vs-judge agreement ≥ 19/20 on the pre-committed sample
  const ag = agreement(judged, handItems);
  const disagreeNames = (ag.disagree ?? []).map((d) => d.question_id);
  const condAgreement = {
    name: 'hand-vs-judge agreement',
    ok: ag.agree >= ADOPTION_GATE.min_agreement && ag.n === ADOPTION_GATE.handlabel_n,
    detail: ag.n === ADOPTION_GATE.handlabel_n
      ? `${ag.agree}/${ag.n} (bar ≥${ADOPTION_GATE.min_agreement}/${ADOPTION_GATE.handlabel_n})${disagreeNames.length ? ` — disagrees: ${disagreeNames.join(', ')}` : ''}`
      : `${ag.agree}/${ag.n} (bar ≥${ADOPTION_GATE.min_agreement}/${ADOPTION_GATE.handlabel_n}; the judged file must carry all ${ADOPTION_GATE.handlabel_n} hand-labelled rows)`,
  };

  const conditions = [condAbs, condProtected, condAgreement];
  return {
    evaluable: true,
    verdict: conditions.every((c) => c.ok) ? 'ADOPTED' : 'NOT ADOPTED',
    conditions,
    agreement: ag,
    unpredicated_abs_rows: unpredicated,
    unevaluable_reason: null,
  };
}

// gateAppliesToRun(run) — the gate decides only for the run and judge version
// it was pre-committed on. `run` is a grid.mjs loadRun result; the binding is
// the rejudge marker's of_run_id + the run's EFFECTIVE judge version.
export function gateAppliesToRun(run) {
  const rj = run?.rejudge;
  if (!rj) return false;
  return rj.of_run_id === ADOPTION_GATE.of_run_id && rj.judge_prompt_version === ADOPTION_GATE.judge_prompt_version;
}

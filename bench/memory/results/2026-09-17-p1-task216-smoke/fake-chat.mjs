// task 216 smoke — the 210 scripted chat endpoint PLUS a mid-write death knob.
//
// Script identical to ../2026-09-17-p1-task210-smoke/fake-chat.mjs (extraction /
// reconcile decision / judge / answer, all keyed by prompt markers). The one
// addition: --fail-answer-after N makes every ANSWER-mode call past the Nth
// return 500 — answer.mjs retries transient 500s then THROWS, which kills the
// run mid-write with the fact rows already in the am_facts table. That is the
// failure leg's instrument: the finally-path purge must drain what the dead run
// wrote (route DELETE /auto-memory/facts?namespace=<ns> count 1, rows 0 after).
// A lane never holds a real model seat; every model leg here is scripted and
// stamped as such.
//
//   node fake-chat.mjs --port 3995 --log /tmp/.../fake-chat-requests.ndjson [--fail-answer-after 0]
import fs from 'node:fs';
import http from 'node:http';

const argIdx = process.argv.indexOf('--port');
const port = argIdx !== -1 ? parseInt(process.argv[argIdx + 1], 10) : 3995;
const logIdx = process.argv.indexOf('--log');
const logFile = logIdx !== -1 ? process.argv[logIdx + 1] : null;
const failIdx = process.argv.indexOf('--fail-answer-after');
const failAnswerAfter = failIdx !== -1 ? parseInt(process.argv[failIdx + 1], 10) : null;

let decisionCalls = 0;
let answerCalls = 0;
// ONE fact: session 0 auto-adds f0, every later session SUPERSEDEs the shown
// current fact (f0 closed by f1, f1 by f2, …) — 5 sessions → 5 rows (4
// superseded + 1 current). That chain is the point: the cleanup must drain
// SUPERSEDED rows too, and listFacts (current-only) alone cannot see them.
const FACTS = ['The user has a manager named Alex'];

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let mode = 'answer';
      let content = `The user has a manager named Alex.`;
      let extractedId = null;
      let failing = false;
      try {
        const parsed = JSON.parse(body);
        const system = parsed.messages?.[0]?.content ?? '';
        const user = parsed.messages?.map((m) => m.content ?? '').join('\n') ?? '';
        if (system.includes('SUPERSEDE')) {
          mode = 'decision';
          decisionCalls += 1;
          const block = user.split('Existing facts')[1] ?? user;
          extractedId = null;
          const re = /^\s*(\S+) \| [^|]+ \| [^|]+ \| /gm;
          let m;
          while ((m = re.exec(block))) {
            if (!m[1].includes('(')) { extractedId = m[1]; break; }
          }
          content = `SUPERSEDE ${extractedId}`;
        } else if (system.includes('pull out the discrete, durable facts')) {
          mode = 'extraction';
          content = JSON.stringify({ facts: FACTS });
        } else if (system.includes('output exactly one word')) {
          mode = 'judge';
          content = 'EXACT';
        } else {
          mode = 'answer';
          answerCalls += 1;
          if (failAnswerAfter !== null && answerCalls > failAnswerAfter) {
            failing = true;
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'fake-chat: scripted mid-write death (task 216 failure leg)' } }));
            if (logFile) {
              try { fs.appendFileSync(logFile, JSON.stringify({ mode, failing, answer_call: answerCalls, body_head: body.slice(0, 300) }) + '\n'); } catch { /* logging never breaks serving */ }
            }
            return;
          }
        }
      } catch {
        /* non-JSON body — answer branch */
      }
      if (logFile) {
        try {
          fs.appendFileSync(
            logFile,
            JSON.stringify({ mode, failing, decision_call: mode === 'decision' ? decisionCalls : null, supersede_target: extractedId, body_head: body.slice(0, 300) }) + '\n'
          );
        } catch { /* logging never breaks serving */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        })
      );
    });
  })
  .listen(port, '127.0.0.1', () => console.error(`fake-chat on 127.0.0.1:${port} (fail-answer-after=${failAnswerAfter})`));

// task 210 flag-path smoke — scripted OpenAI-shaped chat endpoint.
//
// WHY SCRIPTED: tonight both real answerers are unavailable to a lane — the
// 3090's one slot is held by the director's live n=50 timeline run (pid 1181)
// and the Mac's oMLX seat 503s every LOAD under the a84-sftmix heavy lock
// (both refusals quoted verbatim in README.md). The MODEL legs are stamped
// scripted everywhere; the ROUTES legs (ADD/SUPERSEDE through
// /auto-memory/facts, namespace scoping, purge, counters, facts_layer stamps)
// are REAL — real server boot of this worktree, real arm code inside the real
// run.mjs CLI.
//
// Script (deterministic, keyed by prompt markers):
//   extraction call (system = arm_mycelium_extract's EXTRACTION_SYSTEM)
//     → the SAME two facts every session, so session 1's candidates collide
//       with session 0's flushed rows and a decision call fires;
//   reconcile decision call (system = RECONCILE_SYSTEM, contains 'SUPERSEDE')
//     → 1st call SUPERSEDEs the first shown id, 2nd ADDs, every later one
//       KEEPs — ≥1 SUPERSEDE + ≥1 ADD through the routes, no id guessing
//       (the id is read out of the prompt's existing-facts block);
//   judge call (JUDGE_SYSTEM, 'output exactly one word') → 'EXACT';
//   anything else → the answer.
// Every request is appended to an ndjson log — the README quotes it.
//
//   node fake-chat.mjs --port 3997 --log /tmp/.../fake-chat-requests.ndjson
import fs from 'node:fs';
import http from 'node:http';

const argIdx = process.argv.indexOf('--port');
const port = argIdx !== -1 ? parseInt(process.argv[argIdx + 1], 10) : 3997;
const logIdx = process.argv.indexOf('--log');
const logFile = logIdx !== -1 ? process.argv[logIdx + 1] : null;

let decisionCalls = 0;
// ONE fact: session 0 auto-adds f0, session 1's duplicate candidate triggers
// the scripted SUPERSEDE (f0 closed, f1 current), sessions 2-4 KEEP. With a
// single current + single superseded row the superseded row fits INSIDE the
// default budget-5 read — its dated supersede line renders in a hit (a
// pre-committed smoke number). Two facts crowded it out in the first pass.
const FACTS = ['The user has a manager named Alex'];

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let mode = 'answer';
      let content = `The user has a manager named Alex.`;
      let extractedId = null;
      try {
        const parsed = JSON.parse(body);
        const system = parsed.messages?.[0]?.content ?? '';
        const user = parsed.messages?.map((m) => m.content ?? '').join('\n') ?? '';
        if (system.includes('SUPERSEDE')) {
          mode = 'decision';
          decisionCalls += 1;
          // STATELESS (v3): SUPERSEDE the first shown current fact. The shown
          // id is whatever the arm displays in the existing-facts block — in
          // routes mode the am_fact index rows surface with their NUMERIC
          // server id (`1 | <date> | current | <text>`), NOT the bench
          // `-tl-f<N>` shape, so the id is parsed as the line's leading token.
          // (v2's `\S+-tl-f\d+` regex matched nothing, every decision
          // fail-opened to ADD, and the supersede route was never exercised.)
          // ADDs come from the auto-add path (shown empty), which is its own
          // pre-committed route evidence.
          const block = user.split('Existing facts')[1] ?? user;
          // data lines are `<id> | <date> | <status> | <text>`; the block's
          // first line is the header `(id | valid_from | status | text):`,
          // which also carries pipes — skip any captured id holding '('
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
        }
      } catch {
        /* non-JSON body — answer branch */
      }
      if (logFile) {
        try {
          fs.appendFileSync(
            logFile,
            JSON.stringify({ mode, decision_call: mode === 'decision' ? decisionCalls : null, supersede_target: extractedId, body_head: body.slice(0, 300) }) + '\n'
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
  .listen(port, '127.0.0.1', () => console.error(`fake-chat on 127.0.0.1:${port}`));

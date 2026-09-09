// arm_letta — Letta OSS (formerly MemGPT) under the benchmark: competitor arm 3.
//
// Letta is Python; the arm talks to a small local sidecar (letta_sidecar.py,
// stdlib http.server on 127.0.0.1) that drives a LETTA SERVER over the official
// `letta-client` SDK. The sidecar is spawned per run, addressed via a ready-line
// handshake, and stopped with a pid + port-freed gate (an exited pid does not
// mean the port is free).
//
// THE STORAGE DIFFERENCE (vs mem0/zep, and why): the current OSS Letta server
// cannot run without a PostgreSQL+pgvector server (evidence in
// letta-requirements.txt), and this harness does not install a database server —
// that is a director decision. So unlike the mem0/qdrant and zep/kuzu arms,
// this arm has NO embedded store: the sidecar fronts an already-running Letta
// server (LETTA_SERVER_URL), and /health FAILS the boot gate when that server
// does not answer. The per-run isolation the other arms get from a fresh store
// dir, this arm gets from a fresh Letta AGENT per run (created lazily on first
// add, deleted at teardown unless --keep).
//
// Fairness rules this arm keeps:
//   - Letta's agent LLM/embedder configs = the SAME answerer endpoint/model the
//     other arms use (qwen3.8:27b on the 3090 box) + the same nomic-embed-text
//     embedder on the platform host. The agent loop itself never runs: write =
//     one archival passage per haystack session (insert_archival_memory's
//     current equivalent, agents.passages.create), answer = archival semantic
//     search at the shared retrieval budget (the agent's archival_memory_search
//     tool's API twin) then the SAME RAG prompt + answerer as arm_mycelium —
//     only the memory system differs.
//   - Scope = one Letta agent per run (all questions' sessions inside it — the
//     fair comparison keeps the scope as coarse as the incumbent arm's).
//   - Cost $0: no Letta cloud; the server under test is self-hosted OSS.
//
// Addresses are NEVER hardcoded: they resolve from env / substrate.conf
// (resolveLettaEnv below), same rule as platform.mjs and the other arms.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSubstrateConf } from '../platform.mjs';
import { RAG_SYSTEM } from './arm_mycelium.mjs';

export const LETTA_SIDECAR_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'letta_sidecar.py');
export const LETTA_VENV_PYTHON = path.join(path.dirname(fileURLToPath(import.meta.url)), '.letta-venv', 'bin', 'python');

// Model ids are harness defaults (stamped into the regime), not addresses.
export const LETTA_DEFAULT_LLM_MODEL = 'qwen3.8:27b'; // the answerer default in run.mjs
export const LETTA_DEFAULT_EMBEDDER_MODEL = 'nomic-embed-text'; // the platform's embedder
export const LETTA_DEFAULT_EMBEDDER_DIMS = 768; // measured on the platform host's ollama

// Retrieval scope: the run namespace, same granularity as the other arms. For
// letta the scope names the run's AGENT (created lazily, deleted at teardown).
export function lettaScope(runId) {
  return `bench-p1-${runId}`;
}

// env wins; then substrate.conf (LETTA_SERVER_URL for the store under test,
// BOX_3090_URL for the LLM, OLLAMA_URL for the embedder, MYCELIUM_URL's host as
// the embedder's last resort); else throw — loud, no hardcoded fallback. There
// is NO default for LETTA_SERVER_URL: pointing the bench at a letta server is a
// benchmark decision, not a substrate fact.
export function resolveLettaEnv({ env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
  let conf = {};
  try {
    conf = parseSubstrateConf(readFile(path.join(home, '.claude', 'hooks', 'substrate.conf'), 'utf8'));
  } catch {
    // no conf file — env is the only source then
  }
  const lettaServerUrl = (env.LETTA_SERVER_URL || conf.LETTA_SERVER_URL || '').replace(/\/+$/, '');
  if (!lettaServerUrl) {
    throw new Error(
      'letta arm: no letta server — set LETTA_SERVER_URL (env or substrate.conf). The OSS letta server ' +
        'requires PostgreSQL+pgvector (see bench/memory/arms/letta-requirements.txt); this harness does not ' +
        'install a database server, so the store under test must already be running. This harness never hardcodes an address.'
    );
  }
  const box3090 = (env.BOX_3090_URL || conf.BOX_3090_URL || '').replace(/\/+$/, '');
  const llmOverride = env.LETTA_LLM_BASE_URL || null;
  if (!llmOverride && !box3090) {
    throw new Error('letta arm: no LLM endpoint — set LETTA_LLM_BASE_URL or BOX_3090_URL (env or substrate.conf). This harness never hardcodes an address.');
  }
  let embedder = env.LETTA_EMBEDDER_BASE_URL || conf.OLLAMA_URL || null;
  if (!embedder) {
    const mycelium = env.MYCELIUM_URL || conf.MYCELIUM_URL;
    if (!mycelium) {
      throw new Error('letta arm: no embedder endpoint — set LETTA_EMBEDDER_BASE_URL or OLLAMA_URL, or make MYCELIUM_URL resolvable (the platform host runs the ollama embedder). This harness never hardcodes an address.');
    }
    const u = new URL(mycelium);
    u.port = '11434';
    embedder = u.toString().replace(/\/+$/, '');
  }
  return {
    lettaServerUrl,
    box3090Url: box3090,
    llmBaseUrl: llmOverride ?? (box3090 ? `${box3090}/v1` : null),
    llmModel: env.LETTA_LLM_MODEL || LETTA_DEFAULT_LLM_MODEL,
    embedderBaseUrl: embedder,
    embedderModel: env.LETTA_EMBEDDER_MODEL || LETTA_DEFAULT_EMBEDDER_MODEL,
    embedderDims: parseInt(env.LETTA_EMBEDDER_DIMS || String(LETTA_DEFAULT_EMBEDDER_DIMS), 10),
  };
}

// The interpreter that runs the sidecar: LETTA_SIDECAR_PYTHON wins, else the
// venv created from letta-requirements.txt, else a loud setup error.
export function resolveSidecarPython({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.LETTA_SIDECAR_PYTHON) return env.LETTA_SIDECAR_PYTHON;
  if (exists(LETTA_VENV_PYTHON)) return LETTA_VENV_PYTHON;
  throw new Error(
    `letta arm: no sidecar python. Create the venv: python3.12 -m venv bench/memory/arms/.letta-venv && ` +
      `bench/memory/arms/.letta-venv/bin/pip install -r bench/memory/arms/letta-requirements.txt ` +
      `(or point LETTA_SIDECAR_PYTHON at an interpreter that has letta-client installed)`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn the sidecar, learn its port from the LETTA_SIDECAR_READY stderr line,
// poll /health until it answers — /health is only ok when the letta server
// under test answered (the store is remote; see the header) — and on stop()
// gate on BOTH the child's exit AND the port actually being freed.
export function createLettaSidecarManager({
  command = null, // [exe, ...args] — injectable for tests; default [python, script]
  python = null,
  script = LETTA_SIDECAR_SCRIPT,
  env = {}, // extra env for the child (the LETTA_* config)
  host = '127.0.0.1',
  startTimeoutMs = 120000,
  healthPollMs = 500,
  // one /add = one embed call server-side (~sub-second on the platform host's
  // ollama at steady state) — but the SAME contended-endpoint stretch applies
  // as on the other arms. 30 min is the loud-failure bound, not an expected
  // cost. No retry: a timed-out add may still have committed a passage —
  // retrying would duplicate it.
  requestTimeoutMs = 1800000,
  stopTimeoutMs = 15000,
  portFreedTimeoutMs = 10000,
  log = () => {},
  spawnFn = spawn,
  fetchImpl = fetch,
  connectFn = null, // test seam for the port-freed poll; default net.createConnection
} = {}) {
  const argv = command ?? [python, script];
  let child = null;
  let port = null;
  let baseUrl = null;

  async function start() {
    if (child) throw new Error('letta sidecar already started');
    child = spawnFn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env, LETTA_SIDECAR_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // own process group: a group-kill sweeping this session's tree (the lab
      // has seen lane-boundary child reaping) must not reach the sidecar
      detached: true,
    });
    // permanent exit log: an early child death must show up in the run log with
    // its code/signal, not as a stop() that mysteriously times out later
    child.on('exit', (code, signal) => {
      log(`sidecar pid ${child.pid} exited (code=${code}, signal=${signal})`);
    });
    // forward everything the sidecar writes (request lines, tracebacks) into
    // the run log — a sidecar crash must be readable from the run's own log,
    // not eaten by the pipe. Independent of the ready-line scanner below.
    let carry = '';
    const forward = (buf) => {
      carry += buf.toString('utf8');
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const l of lines) {
        const t = l.trim();
        if (t) log(`[sidecar] ${t}`);
      }
    };
    child.stderr.on('data', forward);
    child.stdout.on('data', forward);

    const ready = new Promise((resolve, reject) => {
      let tail = '';
      const onLine = (buf) => {
        tail = (tail + buf.toString('utf8')).slice(-4000);
        for (const line of tail.split('\n')) {
          const m = line.match(/LETTA_SIDECAR_READY (\d+)/);
          if (m) return resolve(parseInt(m[1], 10));
        }
      };
      child.stderr.on('data', onLine);
      child.stdout.on('data', onLine);
      child.on('error', (e) => reject(new Error(`letta sidecar spawn failed: ${e.message}`)));
      child.on('exit', (code, signal) =>
        reject(new Error(`letta sidecar exited before becoming ready (code=${code}, signal=${signal})` + (tail ? ` — stderr tail:\n${tail.trim()}` : ''))
        ));
    });
    let portOrErr;
    try {
      portOrErr = await Promise.race([
        ready,
        sleep(startTimeoutMs).then(() => {
          throw new Error(`letta sidecar did not announce LETTA_SIDECAR_READY within ${startTimeoutMs} ms`);
        }),
      ]);
    } catch (e) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw e;
    }
    port = portOrErr;
    baseUrl = `http://${host}:${port}`;
    log(`sidecar pid ${child.pid} on ${baseUrl}`);

    // /health poll: only health.ok counts — for this arm ok means the letta
    // server under test ANSWERED (a down store must fail the boot gate loudly,
    // not surface later as a 500 on the first add).
    const deadline = Date.now() + startTimeoutMs;
    while (true) {
      // a signal-killed child has exitCode === null and only signalCode set —
      // check both or a SIGTERM'd sidecar looks alive forever
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('letta sidecar exited during health poll');
      try {
        const res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const health = await res.json();
          if (health?.ok) return { ...health, baseUrl, port };
        }
      } catch {
        /* not up yet — poll until the deadline */
      }
      if (Date.now() > deadline) {
        // letta-specific: the expected boot failure IS a down letta server —
        // never leave a live sidecar holding its port after a failed boot
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        throw new Error(`letta sidecar /health never answered ok within ${startTimeoutMs} ms — is LETTA_SERVER_URL (${env.LETTA_SERVER_URL ?? 'unset'}) up?`);
      }
      await sleep(healthPollMs);
    }
  }

  async function request(pathname, body) {
    if (!baseUrl) throw new Error('letta sidecar request before start() — start the sidecar first');
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (e) {
      throw new Error(
        `letta sidecar unreachable at ${baseUrl}${pathname} (${e.message}) — the arm fails loudly, never with an empty answer`,
        { cause: e }
      );
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok || !json?.ok) {
      throw new Error(`letta sidecar ${pathname} -> ${res.status}: ${String(json?.error ?? text).slice(0, 300)}`);
    }
    return json;
  }

  function portFreed() {
    return new Promise((resolve) => {
      const attempt = (connect) => {
        const sock = (connect ?? net.createConnection)({ port, host }, () => {
          sock.destroy();
          resolve(false); // something still accepts on the port
        });
        sock.on('error', () => resolve(true)); // ECONNREFUSED = freed
      };
      if (connectFn) attempt(connectFn);
      else attempt(null);
    });
  }

  async function stop() {
    if (!child) return { stopped: false };
    const pid = child.pid;
    const dead = child.exitCode !== null || child.signalCode !== null;
    if (dead) {
      // already exited (crash, or a previous stop): kill() on a dead pid is a
      // silent no-op and an exit listener attached after the event fired never
      // resolves — go straight to the port-freed gate
      log(`sidecar pid ${pid} already exited (code=${child.exitCode}, signal=${child.signalCode}) — skipping signals`);
    } else {
      // register BEFORE the signal: 'exit' can fire the instant the signal
      // lands, and a listener attached after the event never resolves.
      // Resolve with `true`, NOT the event args: a signal-killed child passes
      // (null, 'SIGTERM') and resolve() keeps only the first — a bare resolve
      // makes a clean SIGTERM exit indistinguishable from the race timeout.
      const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
      child.kill('SIGTERM');
      // The sidecar's stop semantics: first SIGTERM closes the listener and
      // drains the in-flight request; a SECOND signal exits immediately. So
      // while waiting for the exit, once the port frees with the child still
      // alive, nudge it — teardown need not wait out the drain, but must not
      // stall 15 s.
      const deadline = Date.now() + stopTimeoutMs;
      let done = false;
      let nudged = false;
      while (!done) {
        const r = await Promise.race([exited.then(() => 'exit'), sleep(250).then(() => 'tick')]);
        if (r === 'exit') { done = true; break; }
        if (Date.now() > deadline) break;
        if (!nudged && (await portFreed())) {
          nudged = true;
          log(`sidecar pid ${pid} listener closed, draining — second SIGTERM to exit now`);
          child.kill('SIGTERM');
        }
      }
      if (!done) {
        log(`sidecar pid ${pid} ignored SIGTERM for ${stopTimeoutMs} ms — SIGKILL`);
        child.kill('SIGKILL');
        done = await Promise.race([exited, sleep(stopTimeoutMs).then(() => false)]) === true;
        if (!done) throw new Error(`letta sidecar pid ${pid} did not exit after SIGKILL`);
      }
    }
    // exit-of-pid ≠ port-freed: poll until nothing accepts on the port
    const freedDeadline = Date.now() + portFreedTimeoutMs;
    while (true) {
      if (await portFreed()) {
        log(`sidecar pid ${pid} stopped; port ${port} freed`);
        child = null;
        return { stopped: true, pid, port, port_freed: true, already_dead: dead };
      }
      if (Date.now() > freedDeadline) {
        throw new Error(`letta sidecar pid ${pid} exited but port ${port} is still accepting connections after ${portFreedTimeoutMs} ms`);
      }
      await sleep(250);
    }
  }

  return {
    get baseUrl() { return baseUrl; },
    get port() { return port; },
    get pid() { return child?.pid ?? null; },
    start,
    request,
    stop,
  };
}

// Run-facing convenience: resolve env, start the sidecar. Unlike the other
// arms there is NO local store to wipe — per-run isolation is the fresh letta
// AGENT, and teardown purges it via /delete_all (purgeLettaScope below).
// `fresh` exists so startLettaSidecar keeps the same call shape as the other
// arms' restart paths; it has nothing local to do for letta — the agent
// identity survives a restart via the state file instead (below), which is
// what `fresh: false` on mem0/zep achieves with their store dirs.
export async function startLettaSidecar({
  runId,
  llmBaseUrl = null, // e.g. an explicit --answer-url — the letta LLM must match the other arms' answerer
  fresh = true, // unused for letta (no local store) — accepted for call-shape parity
  env = process.env,
  home = os.homedir(),
  readFile = fs.readFileSync,
  log = () => {},
  managerOpts = {},
} = {}) {
  const resolved = resolveLettaEnv({ env, home, readFile });
  // where the run's letta agent id persists: keyed by runId, so a restarted
  // sidecar (same runId) REATTACHES to the same agent instead of lazily
  // creating a second one and forking the run's memory. Cleared by teardown's
  // /delete_all.
  const stateFile = path.join(os.tmpdir(), `letta-bench-${runId}`, 'agent.json');
  const manager = createLettaSidecarManager({
    python: resolveSidecarPython({ env }),
    env: {
      LETTA_SERVER_URL: resolved.lettaServerUrl,
      LETTA_LLM_BASE_URL: llmBaseUrl ?? resolved.llmBaseUrl,
      LETTA_LLM_MODEL: resolved.llmModel,
      LETTA_EMBEDDER_BASE_URL: resolved.embedderBaseUrl,
      LETTA_EMBEDDER_MODEL: resolved.embedderModel,
      LETTA_EMBEDDER_DIMS: String(resolved.embedderDims),
      LETTA_STATE_FILE: stateFile,
      LETTA_SIDECAR_PORT: '0',
    },
    log,
    ...managerOpts,
  });
  const health = await manager.start();
  return { manager, health, env: resolved, scope: lettaScope(runId), stateFile, stop: () => manager.stop() };
}

// Teardown: DELETE the run's agent (its archival memory with it) — the
// analogue of removeMem0Store/removeZepStore. `--keep` skips this.
export async function purgeLettaScope(handle) {
  await handle.manager.request('/delete_all', { user_id: handle.scope });
}

// The arm. `sidecar` is a STARTED sidecar client ({request}), normally the
// manager from startLettaSidecar (which run.mjs also uses for the regime stamp).
// run.mjs passes the run's handle as `letta` ({sidecar, lettaVersion,
// lettaClientVersion, restart}); direct args keep working for tests and
// standalone use. If the arm itself was handed an un-started lifecycle it
// owns, set ownsSidecar — dispose() then stops it (runBench calls dispose
// after the arm's rows are in).
export function createArmLetta({
  answerChat,
  runId,
  retrievalBudget,
  sidecar = null,
  lettaVersion = null,
  lettaClientVersion = null,
  ownsSidecar = false,
  letta = null,
  log = () => {},
  resumeDir = null, // results dir — per-question checkpoint of how many sessions are in the store
  restartSidecar = null, // async () => fresh {request} against the SAME letta server (sidecar died mid-run)
  maxRestarts = 5,
}) {
  sidecar = sidecar ?? letta?.sidecar ?? null;
  lettaVersion = lettaVersion ?? letta?.lettaVersion ?? null;
  lettaClientVersion = lettaClientVersion ?? letta?.lettaClientVersion ?? null;
  restartSidecar = restartSidecar ?? letta?.restart ?? null;
  if (typeof answerChat !== 'function') throw new Error('arm_letta requires answerChat');
  // refuse to run on an unstamped budget: an undefined budget used to surface
  // only as a sidecar 400 on the first question — after every session was written
  if (!Number.isInteger(retrievalBudget) || retrievalBudget <= 0) {
    throw new Error(`arm_letta: retrievalBudget must be a positive int (got ${retrievalBudget}) — run.mjs's armContext provides it`);
  }
  if (!sidecar || typeof sidecar.request !== 'function') {
    throw new Error('arm_letta requires a started sidecar — startLettaSidecar() / run.mjs provides it');
  }
  const scope = lettaScope(runId);

  // The sidecar is long-lived (a 50-question write phase is hours), so it can
  // die mid-run to something outside this process. A request that died with
  // ECONNREFUSED provably never reached the sidecar — nothing committed — so
  // restarting the sidecar (same letta server) and replaying it cannot
  // duplicate passages. Any other failure mode (timeout, reset mid-response)
  // could have committed server-side: those fail the run loudly instead.
  let current = sidecar;
  let restarts = 0;
  const connRefused = (e) => {
    for (let c = e; c; c = c.cause) if (c && c.code === 'ECONNREFUSED') return true;
    return false;
  };
  const call = async (pathname, body) => {
    for (;;) {
      try {
        return await current.request(pathname, body);
      } catch (e) {
        if (!connRefused(e) || typeof restartSidecar !== 'function') throw e;
        restarts += 1;
        if (restarts > maxRestarts) {
          log(`sidecar connection refused on ${pathname} — restart budget (${maxRestarts}) exhausted, failing loudly`);
          throw e;
        }
        log(`sidecar connection refused on ${pathname} — restarting sidecar (${restarts}/${maxRestarts}, letta agent preserved), replaying`);
        current = await restartSidecar();
        // loop: replay the same call on the new sidecar
      }
    }
  };

  // session-granularity checkpoint: a session is recorded only after its /add
  // returned 200, so resuming at `sessions_done` never re-adds a committed one
  const cpFile = (qid) => path.join(resumeDir, `letta-sessions-${String(qid).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const readCp = (qid) => {
    try { return JSON.parse(fs.readFileSync(cpFile(qid), 'utf8')).sessions_done ?? 0; } catch { return 0; }
  };
  const writeCp = (qid, sessionsDone) => {
    fs.mkdirSync(resumeDir, { recursive: true });
    fs.writeFileSync(cpFile(qid), JSON.stringify({ question_id: qid, sessions_done: sessionsDone }) + '\n');
  };

  return {
    name: 'letta',
    scope,
    async write(sessionTurns, { questionId } = {}) {
      if (!Array.isArray(sessionTurns)) throw new Error('arm_letta.write expects haystack_sessions (array of sessions)');
      let rows = 0;
      const done = resumeDir ? readCp(questionId) : 0;
      if (done > 0) log(`resuming q=${questionId}: ${done}/${sessionTurns.length} sessions already in the store`);
      for (let idx = done; idx < sessionTurns.length; idx++) {
        const turns = sessionTurns[idx].map((t) => {
          if (typeof t?.role !== 'string' || typeof t?.content !== 'string') {
            throw new Error(`arm_letta.write: session ${idx} turn is not {role, content} strings`);
          }
          return { role: t.role, content: t.content };
        });
        // one POST per session — the sidecar flattens it to ONE archival
        // passage (letta's passages API does not chunk). Log each one's size +
        // duration: over a multi-hour write phase this is the throughput trace
        // that shows whether an add is stalled or slow.
        const t0 = Date.now();
        const kb = (turns.reduce((a, t) => a + t.content.length, 0) / 1024).toFixed(1);
        const r = await call('/add', {
          user_id: scope,
          messages: turns,
          metadata: { question_id: questionId, session_index: idx, bench: 'longmemeval', bench_run_id: runId },
        });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log(`add ${idx + 1}/${sessionTurns.length} (${kb} KB, ${r.count ?? 0} passage(s), agent ${r.agent_id ?? '?'}) in ${secs}s — q=${questionId}`);
        rows += r.count ?? 0;
        if (resumeDir) writeCp(questionId, idx + 1);
      }
      return { docs: sessionTurns.length, rows };
    },
    async answer(question) {
      const s = await call('/search', { query: question, user_id: scope, limit: retrievalBudget });
      const memories = s.results ?? [];
      const context = memories.map((r) => r.memory).filter(Boolean).join('\n\n---\n\n');
      const r = await answerChat({
        system: RAG_SYSTEM,
        user: `Memory context:\n${context || '(no memory found)'}\n\nQuestion: ${question}`,
      });
      return {
        text: r.text,
        meta: {
          hits: memories.length,
          retrieval_mode: 'letta-oss-archival-semantic',
          letta_version: lettaVersion,
          letta_client_version: lettaClientVersion,
          had_think: !!r.hadThink,
        },
      };
    },
    async dispose() {
      if (ownsSidecar && typeof sidecar.stop === 'function') await sidecar.stop();
    },
  };
}

// arm_mempalace — MemPalace OSS under the benchmark: the CONTROL arm (task 263).
//
// MemPalace is Python; the arm talks to a small local sidecar
// (mempalace_sidecar.py, stdlib http.server on 127.0.0.1) that drives
// MemPalace's OWN ingest + search API (`mempalace.mcp_server.tool_add_drawer`
// / `tool_search`) against a per-run local ChromaDB palace. The sidecar never
// touches chromadb directly — ingesting through the raw vector store is the
// flaw the 2026-10-29 analysis found in MemPalace's own benchmark scripts, and
// this arm exists to measure the product as shipped. The sidecar is spawned
// per run, addressed via a ready-line handshake, and stopped with a pid +
// port-freed gate (an exited pid does not mean the port is free).
//
// What "control arm" pins here (the director's config, task 263):
//   - RAW mode: verbatim drawers, no LLM in the write path (the sidecar has no
//     LLM endpoint at all — write and search are product paths that need none).
//   - Embedder = MemPalace's DEFAULT MiniLM (all-MiniLM-L6-v2, 384-dim ONNX),
//     deliberately NOT the incumbent arms' nomic-embed-text/768: as-shipped is
//     the point of a control arm; the regime stamps the difference.
//   - NO LLM rerank, NO AAAK — those surfaces are never invoked (stamped off).
//   - Pinned at the source commit declaring v3.12.0 (unreleased upstream —
//     see setup_mempalace_venv.sh for the pin + tarball sha256).
//
// Fairness rules this arm keeps:
//   - ONE add_drawer per haystack session (the product chunks it at its
//     configured chunk_size — as-shipped chunking, stamped), then the SAME RAG
//     prompt + answerer as arm_mycelium — only the memory system differs.
//   - Retrieval budget = the same top-k the other arms use; the candidate pool
//     the product fetched before ranking is stamped alongside (read_hits).
//   - Scope = one palace (fresh store dir per run) — the same granularity as
//     the mem0 store / zep graph / letta agent.
//   - Cost $0: no MemPalace hub/cloud; telemetry off in the product's own
//     chroma client settings; run time is offline (pre-warmed embedder).

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RAG_SYSTEM } from './arm_mycelium.mjs';
import { recordHits } from '../retrieval_stamp.mjs';

export const MEMPALACE_SIDECAR_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mempalace_sidecar.py');
// The brief pins the venv location: bench/memory/.venvs/mempalace (gitignored;
// built by setup_mempalace_venv.sh from the pinned source commit).
export const MEMPALACE_VENV_PYTHON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.venvs',
  'mempalace',
  'bin',
  'python'
);
// Where setup_mempalace_venv.sh pre-warmed the MiniLM ONNX model: <venv>/embedder-cache
// (NOT <venv>/bin/ — the first smoke had this pointing one dir too deep and
// chromadb's ONNX downloader, which ignores HF_HUB_OFFLINE, silently fetched
// the model at run time. The path must match the setup script exactly.)
export const MEMPALACE_EMBEDDER_CACHE = path.join(path.dirname(path.dirname(MEMPALACE_VENV_PYTHON)), 'embedder-cache');

// The product default's output width (all-MiniLM-L6-v2) — stamped, not dialed.
export const MEMPALACE_DEFAULT_EMBEDDER_MODEL = 'minilm';
export const MEMPALACE_DEFAULT_EMBEDDER_DIMS = 384;

// Retrieval scope: the run namespace, same granularity as the other arms
// (one wing per run — all questions' sessions inside it; the palace itself is
// per-run, so search needs no wing filter to stay scoped, matching how the
// incumbent arms search their whole per-run store).
export function mempalaceScope(runId) {
  return `bench-p1-${runId}`;
}

// No endpoints to resolve — the arm's write/search paths are LLM-free and the
// embedder is an in-process ONNX model from the venv cache. What the spawner
// must set is the per-run STATE DIR. Kept as a function for parity with the
// other arms' resolve*Env and for the test seam.
export function mempalaceStateDir(runId, tmpDir = os.tmpdir()) {
  return path.join(tmpDir, `mempalace-bench-${runId}`);
}

// The interpreter that runs the sidecar: MEMPALACE_SIDECAR_PYTHON wins, else
// the venv built by setup_mempalace_venv.sh, else a loud setup error.
export function resolveSidecarPython({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.MEMPALACE_SIDECAR_PYTHON) return env.MEMPALACE_SIDECAR_PYTHON;
  if (exists(MEMPALACE_VENV_PYTHON)) return MEMPALACE_VENV_PYTHON;
  throw new Error(
    `mempalace arm: no sidecar python. Build the venv: bash bench/memory/arms/setup_mempalace_venv.sh ` +
      `(creates bench/memory/.venvs/mempalace from the pinned source commit) ` +
      `(or point MEMPALACE_SIDECAR_PYTHON at an interpreter that has mempalace installed)`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn the sidecar, learn its port from the MEMPALACE_SIDECAR_READY stderr
// line, poll /health until it answers, and on stop() gate on BOTH the child's
// exit AND the port actually being freed. Same lifecycle as the mem0/zep/letta
// managers (task 169/180/181) — one shape, four arms.
export function createMempalaceSidecarManager({
  command = null, // [exe, ...args] — injectable for tests; default [python, script]
  python = null,
  script = MEMPALACE_SIDECAR_SCRIPT,
  env = {}, // extra env for the child (the MEMPALACE_* config)
  host = '127.0.0.1',
  startTimeoutMs = 120000,
  healthPollMs = 500,
  // one /add = one verbatim drawer write + local embeds (no LLM, no network) —
  // sub-second at steady state, but the same contended-box stretches apply as
  // on the other arms. 30 min is the loud-failure bound, not an expected cost.
  // No retry: a timed-out add may still have committed drawers — retrying
  // would duplicate them (the product dedupes identical content, but the arm
  // must not rely on that).
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
    if (child) throw new Error('mempalace sidecar already started');
    child = spawnFn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env, MEMPALACE_SIDECAR_PORT: '0' },
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
          const m = line.match(/MEMPALACE_SIDECAR_READY (\d+)/);
          if (m) return resolve(parseInt(m[1], 10));
        }
      };
      child.stderr.on('data', onLine);
      child.stdout.on('data', onLine);
      child.on('error', (e) => reject(new Error(`mempalace sidecar spawn failed: ${e.message}`)));
      child.on('exit', (code, signal) =>
        reject(new Error(`mempalace sidecar exited before becoming ready (code=${code}, signal=${signal})` + (tail ? ` — stderr tail:\n${tail.trim()}` : ''))
        ));
    });
    let portOrErr;
    try {
      portOrErr = await Promise.race([
        ready,
        sleep(startTimeoutMs).then(() => {
          throw new Error(`mempalace sidecar did not announce MEMPALACE_SIDECAR_READY within ${startTimeoutMs} ms`);
        }),
      ]);
    } catch (e) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw e;
    }
    port = portOrErr;
    baseUrl = `http://${host}:${port}`;
    log(`sidecar pid ${child.pid} on ${baseUrl}`);

    // /health poll: only health.ok counts — the store is LOCAL, so ok means
    // the sidecar's own dirs are usable (the counterpart of mem0/qdrant, not
    // letta's remote-server probe).
    const deadline = Date.now() + startTimeoutMs;
    while (true) {
      // a signal-killed child has exitCode === null and only signalCode set —
      // check both or a SIGTERM'd sidecar looks alive forever
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('mempalace sidecar exited during health poll');
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
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        throw new Error(`mempalace sidecar /health never answered ok within ${startTimeoutMs} ms (palace dir: ${env.MEMPALACE_PALACE_PATH ?? 'unset'})`);
      }
      await sleep(healthPollMs);
    }
  }

  async function request(pathname, body) {
    if (!baseUrl) throw new Error('mempalace sidecar request before start() — start the sidecar first');
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
        `mempalace sidecar unreachable at ${baseUrl}${pathname} (${e.message}) — the arm fails loudly, never with an empty answer`,
        { cause: e }
      );
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok || !json?.ok) {
      throw new Error(`mempalace sidecar ${pathname} -> ${res.status}: ${String(json?.error ?? text).slice(0, 300)}`);
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
        if (!done) throw new Error(`mempalace sidecar pid ${pid} did not exit after SIGKILL`);
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
        throw new Error(`mempalace sidecar pid ${pid} exited but port ${port} is still accepting connections after ${portFreedTimeoutMs} ms`);
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

// Run-facing convenience: resolve paths, start the sidecar. `fresh` wipes the
// per-run palace for a new run; a mid-run restart passes fresh: false so the
// store survives (the same contract as startMem0Sidecar/startZepSidecar).
export async function startMempalaceSidecar({
  runId,
  fresh = true, // false = reuse the existing palace dir (restart after a sidecar death)
  env = process.env,
  tmpDir = os.tmpdir(),
  log = () => {},
  managerOpts = {},
} = {}) {
  const stateDir = mempalaceStateDir(runId, tmpDir);
  const palacePath = path.join(stateDir, 'palace');
  const configDir = path.join(stateDir, 'config');
  if (fresh) fs.rmSync(stateDir, { recursive: true, force: true }); // fresh store per run: no leakage across runs
  fs.mkdirSync(palacePath, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const manager = createMempalaceSidecarManager({
    python: resolveSidecarPython({ env }),
    env: {
      MEMPALACE_CONFIG_DIR: configDir,
      MEMPALACE_PALACE_PATH: palacePath,
      MEMPALACE_EMBEDDING_MODEL: env.MEMPALACE_EMBEDDING_MODEL || MEMPALACE_DEFAULT_EMBEDDER_MODEL,
      MEMPALACE_EMBEDDER_CACHE: MEMPALACE_EMBEDDER_CACHE,
      // run time is offline: the embedder model was pre-warmed into the venv
      // by setup_mempalace_venv.sh — this arm's only network was that install.
      HF_HUB_OFFLINE: '1',
      MEMPALACE_SIDECAR_PORT: '0',
    },
    log,
    ...managerOpts,
  });
  const health = await manager.start();
  return {
    manager,
    health,
    storePath: stateDir,
    palacePath,
    scope: mempalaceScope(runId),
    stop: () => manager.stop(),
  };
}

export function removeMempalaceStore(storePath) {
  fs.rmSync(storePath, { recursive: true, force: true });
}

// The arm. `sidecar` is a STARTED sidecar client ({request}), normally the
// manager from startMempalaceSidecar (which run.mjs also uses for the regime
// stamp). run.mjs passes the run's handle as `mempalace` ({sidecar,
// mempalaceVersion, restart}); direct args keep working for tests and
// standalone use. If the arm itself was handed an un-started lifecycle it
// owns, set ownsSidecar — dispose() then stops it (runBench calls dispose
// after the arm's rows are in).
export function createArmMempalace({
  answerChat,
  runId,
  retrievalBudget,
  sidecar = null,
  mempalaceVersion = null,
  ownsSidecar = false,
  mempalace = null,
  log = () => {},
  resumeDir = null, // results dir — per-question checkpoint of how many sessions are in the store
  restartSidecar = null, // async () => fresh {request} against the SAME palace (sidecar died mid-run)
  maxRestarts = 5,
  recordHits: stampHits = recordHits,
}) {
  sidecar = sidecar ?? mempalace?.sidecar ?? null;
  mempalaceVersion = mempalaceVersion ?? mempalace?.mempalaceVersion ?? null;
  restartSidecar = restartSidecar ?? mempalace?.restart ?? null;
  if (typeof answerChat !== 'function') throw new Error('arm_mempalace requires answerChat');
  // refuse to run on an unstamped budget: an undefined budget used to surface
  // only as a sidecar 400 on the first question — after every session was written
  if (!Number.isInteger(retrievalBudget) || retrievalBudget <= 0) {
    throw new Error(`arm_mempalace: retrievalBudget must be a positive int (got ${retrievalBudget}) — run.mjs's armContext provides it`);
  }
  if (!sidecar || typeof sidecar.request !== 'function') {
    throw new Error('arm_mempalace requires a started sidecar — startMempalaceSidecar() / run.mjs provides it');
  }
  const scope = mempalaceScope(runId);

  // The sidecar is long-lived (a 50-question write phase is hours), so it can
  // die mid-run to something outside this process. A request that died with
  // ECONNREFUSED provably never reached the sidecar — nothing committed — so
  // restarting the sidecar (same palace dir on disk) and replaying it cannot
  // duplicate drawers. Any other failure mode (timeout, reset mid-response)
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
        log(`sidecar connection refused on ${pathname} — restarting sidecar (${restarts}/${maxRestarts}, palace preserved), replaying`);
        current = await restartSidecar();
        // loop: replay the same call on the new sidecar
      }
    }
  };

  // The sidecar client's own contract is to THROW on an error envelope (the
  // manager does). A client that returns one anyway must not slide through as
  // an empty write or an empty answer — a failed search is never a fake empty.
  const assertOk = (envelope, what) => {
    if (envelope && envelope.ok === false) {
      throw new Error(`mempalace sidecar ${what} failed: ${String(envelope.error ?? 'unknown').slice(0, 300)}`);
    }
    return envelope;
  };

  // session-granularity checkpoint: a session is recorded only after its /add
  // returned 200, so resuming at `sessions_done` never re-adds a committed one
  const cpFile = (qid) => path.join(resumeDir, `mempalace-sessions-${String(qid).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const readCp = (qid) => {
    try { return JSON.parse(fs.readFileSync(cpFile(qid), 'utf8')).sessions_done ?? 0; } catch { return 0; }
  };
  const writeCp = (qid, sessionsDone) => {
    fs.mkdirSync(resumeDir, { recursive: true });
    fs.writeFileSync(cpFile(qid), JSON.stringify({ question_id: qid, sessions_done: sessionsDone }) + '\n');
  };

  return {
    name: 'mempalace',
    scope,
    async write(sessionTurns, { questionId } = {}) {
      if (!Array.isArray(sessionTurns)) throw new Error('arm_mempalace.write expects haystack_sessions (array of sessions)');
      let rows = 0;
      const done = resumeDir ? readCp(questionId) : 0;
      if (done > 0) log(`resuming q=${questionId}: ${done}/${sessionTurns.length} sessions already in the store`);
      for (let idx = done; idx < sessionTurns.length; idx++) {
        const turns = sessionTurns[idx].map((t) => {
          if (typeof t?.role !== 'string' || typeof t?.content !== 'string') {
            throw new Error(`arm_mempalace.write: session ${idx} turn is not {role, content} strings`);
          }
          return { role: t.role, content: t.content };
        });
        // one POST per session — the sidecar files ONE verbatim drawer (the
        // product chunks it at its configured chunk_size and returns the chunk
        // count). Log each one's size + duration: over a multi-hour write phase
        // this is the throughput trace that shows whether an add is stalled.
        const t0 = Date.now();
        const kb = (turns.reduce((a, t) => a + t.content.length, 0) / 1024).toFixed(1);
        const r = assertOk(
          await call('/add', {
            user_id: scope,
            messages: turns,
            metadata: { question_id: questionId, session_index: idx, bench: 'longmemeval', bench_run_id: runId },
          }),
          '/add'
        );
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log(`add ${idx + 1}/${sessionTurns.length} (${kb} KB, ${r.count ?? 0} drawer chunk(s), ${r.drawer_id ?? '?'}) in ${secs}s — q=${questionId}`);
        rows += r.count ?? 0;
        if (resumeDir) writeCp(questionId, idx + 1);
      }
      return { docs: sessionTurns.length, rows };
    },
    async answer(question) {
      const s = assertOk(await call('/search', { query: question, user_id: scope, limit: retrievalBudget }), '/search');
      const memories = s.results ?? [];
      const context = memories.map((r) => r.memory).filter(Boolean).join('\n\n---\n\n');
      const r = await answerChat({
        system: RAG_SYSTEM,
        user: `Memory context:\n${context || '(no memory found)'}\n\nQuestion: ${question}`,
      });
      const meta = stampHits(
        {
          hits: memories.length,
          // the product's as-shipped default retrieval: tool_search's vector
          // candidate strategy + its own hybrid re-rank of the over-fetched
          // pool (bm25/keyword boosts) — no LLM rerank
          retrieval_mode: 'mempalace-oss-tool-search-vector',
          candidates_fetched: s.candidates_fetched ?? null,
          mempalace_version: mempalaceVersion,
          had_think: !!r.hadThink,
        },
        // each drawer was filed with source_file `bench/<qid>/session_<n>.txt`
        // (the sidecar's /add); the sidecar parses the session index back out
        // of each hit's source_path — a hit shape without it stamps null,
        // honestly. Task 324: each drawer was also filed with
        // room=question_id (the sidecar's /add), and /search hits carry the
        // room back — forwarded as the question-scoped gold credit's stamp
        // (task 304); a hit shape without it stamps null (n/a, never a credit)
        memories.map((m) => ({
          source_id: m.id,
          score: m.score,
          session_index: m.session_index ?? null,
          question_id: m.room ?? null,
        })),
        retrievalBudget
      );
      return { text: r.text, meta };
    },
    async dispose() {
      if (ownsSidecar && typeof sidecar.stop === 'function') await sidecar.stop();
    },
  };
}

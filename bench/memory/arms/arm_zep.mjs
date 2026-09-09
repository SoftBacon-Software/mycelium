// arm_zep — Zep's OSS graph memory (graphiti-core) under the benchmark: the
// second competitor arm. Same shape as arm_mem0: Graphiti is Python; the arm
// talks to a small local sidecar (zep_sidecar.py, stdlib http.server on
// 127.0.0.1) that wraps a Graphiti client against its embedded Kuzu graph
// store. The sidecar is spawned per run, addressed via a ready-line handshake,
// and stopped with a pid + port-freed gate (an exited pid does not mean the
// port is free).
//
// Fairness rules this arm keeps (mirroring the mem0 arm):
//   - Graphiti's extraction LLM = the SAME answerer endpoint/model the other
//     arms use (qwen3.8:27b on the 3090 box) via OpenAIGenericClient —
//     the arm answers over retrieved facts with the same RAG prompt as
//     arm_mycelium and arm_mem0, so only the memory system differs.
//   - Its embedder = nomic-embed-text on the platform host's ollama — the SAME
//     embedder model the mycelium and mem0 arms embed with (768 dims,
//     measured). graphiti-core has no ollama embedder class; ollama's
//     OpenAI-compatible /v1/embeddings endpoint makes that irrelevant, so the
//     OpenAIEmbedder is pointed at the ollama /v1 base.
//   - Graph store = KuzuDriver — Graphiti's ONLY embedded store (file-backed,
//     dockerless; no DB server installed). graphiti-core marks the kuzu backend
//     deprecated (upstream kuzu unmaintained): stamped into the regime, and the
//     honest cost of running Zep OSS locally without a graph server.
//   - Search = graphiti.search()'s out-of-the-box config, EDGE_HYBRID_SEARCH_RRF
//     (bm25 + cosine, RRF) — no LLM reranker (see zep_sidecar.py for why).
//   - Cost $0: no hosted Zep platform, no API keys, telemetry force-disabled.
//
// Addresses are NEVER hardcoded: they resolve from env / substrate.conf
// (resolveZepEnv below), same rule as platform.mjs and arm_mem0.mjs.

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSubstrateConf } from '../platform.mjs';
import { RAG_SYSTEM } from './arm_mycelium.mjs';

export const ZEP_SIDECAR_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'zep_sidecar.py');
export const ZEP_VENV_PYTHON = path.join(path.dirname(fileURLToPath(import.meta.url)), '.zep-venv', 'bin', 'python');

// Model ids are harness defaults (stamped into the regime), not addresses.
export const ZEP_DEFAULT_LLM_MODEL = 'qwen3.8:27b'; // the answerer default in run.mjs
export const ZEP_DEFAULT_EMBEDDER_MODEL = 'nomic-embed-text'; // the platform's embedder
export const ZEP_DEFAULT_EMBEDDER_DIMS = 768; // measured on the platform host's ollama

// Retrieval scope: the run namespace, same granularity as the mycelium and
// mem0 arms (one scope per run, all questions' sessions inside it — the fair
// comparison keeps the scope as coarse as the incumbent arm's).
export function zepScope(runId) {
  return `bench-p1-${runId}`;
}

function ollamaOpenAiBase(url) {
  // Graphiti's OpenAIEmbedder appends /embeddings to the base, so the base must
  // be ollama's OpenAI-compatible /v1 (mem0 uses the NATIVE /api/embed on the
  // bare base — same ollama, one path segment apart).
  const s = url.replace(/\/+$/, '');
  return s.endsWith('/v1') ? s : `${s}/v1`;
}

// env wins; then substrate.conf (BOX_3090_URL for the LLM, OLLAMA_URL for the
// embedder, MYCELIUM_URL's host as the embedder's last resort — the platform
// host runs the ollama embedder the other arms use); else throw — loud, no
// hardcoded fallback.
export function resolveZepEnv({ env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
  let conf = {};
  try {
    conf = parseSubstrateConf(readFile(path.join(home, '.claude', 'hooks', 'substrate.conf'), 'utf8'));
  } catch {
    // no conf file — env is the only source then
  }
  const box3090 = (env.BOX_3090_URL || conf.BOX_3090_URL || '').replace(/\/+$/, '');
  const llmOverride = env.ZEP_LLM_BASE_URL || null;
  if (!llmOverride && !box3090) {
    throw new Error('zep arm: no LLM endpoint — set ZEP_LLM_BASE_URL or BOX_3090_URL (env or substrate.conf). This harness never hardcodes an address.');
  }
  let embedder = env.ZEP_EMBEDDER_BASE_URL || conf.OLLAMA_URL || null;
  if (!embedder) {
    const mycelium = env.MYCELIUM_URL || conf.MYCELIUM_URL;
    if (!mycelium) {
      throw new Error('zep arm: no embedder endpoint — set ZEP_EMBEDDER_BASE_URL or OLLAMA_URL, or make MYCELIUM_URL resolvable (the platform host runs the ollama embedder). This harness never hardcodes an address.');
    }
    const u = new URL(mycelium);
    u.port = '11434';
    embedder = u.toString().replace(/\/+$/, '');
  }
  return {
    box3090Url: box3090,
    llmBaseUrl: llmOverride ?? (box3090 ? `${box3090}/v1` : null),
    llmModel: env.ZEP_LLM_MODEL || ZEP_DEFAULT_LLM_MODEL,
    embedderBaseUrl: ollamaOpenAiBase(embedder),
    embedderModel: env.ZEP_EMBEDDER_MODEL || ZEP_DEFAULT_EMBEDDER_MODEL,
    embedderDims: parseInt(env.ZEP_EMBEDDER_DIMS || String(ZEP_DEFAULT_EMBEDDER_DIMS), 10),
  };
}

// The interpreter that runs the sidecar: ZEP_SIDECAR_PYTHON wins, else the
// venv created from zep-requirements.txt, else a loud setup error.
export function resolveSidecarPython({ env = process.env, exists = fs.existsSync } = {}) {
  if (env.ZEP_SIDECAR_PYTHON) return env.ZEP_SIDECAR_PYTHON;
  if (exists(ZEP_VENV_PYTHON)) return ZEP_VENV_PYTHON;
  throw new Error(
    `zep arm: no sidecar python. Create the venv: python3.12 -m venv bench/memory/arms/.zep-venv && ` +
      `bench/memory/arms/.zep-venv/bin/pip install -r bench/memory/arms/zep-requirements.txt ` +
      `(or point ZEP_SIDECAR_PYTHON at an interpreter that has graphiti-core[kuzu] installed)`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Spawn the sidecar, learn its port from the ZEP_SIDECAR_READY stderr line,
// poll /health until it answers, and on stop() gate on BOTH the child's exit
// AND the port actually being freed. Same lifecycle as the mem0 sidecar
// manager — the two-stage stop protocol (SIGTERM closes the listener, drains
// the in-flight add; a second SIGTERM exits now) is the sidecar's own.
export function createZepSidecarManager({
  command = null, // [exe, ...args] — injectable for tests; default [python, script]
  python = null,
  script = ZEP_SIDECAR_SCRIPT,
  env = {}, // extra env for the child (the ZEP_* config)
  host = '127.0.0.1',
  startTimeoutMs = 120000,
  healthPollMs = 500,
  // one add = one full LLM extraction episode + graph writes — ~30 s at steady
  // state on the 3090 (graphiti extracts entities + edges per session), but a
  // contended endpoint can stretch one add far past 10 min. 30 min is the
  // loud-failure bound, not an expected cost. No retry: a timed-out add may
  // still have committed episodes server-side — retrying would duplicate them.
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
    if (child) throw new Error('zep sidecar already started');
    child = spawnFn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env, ZEP_SIDECAR_PORT: '0' },
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
          const m = line.match(/ZEP_SIDECAR_READY (\d+)/);
          if (m) return resolve(parseInt(m[1], 10));
        }
      };
      child.stderr.on('data', onLine);
      child.stdout.on('data', onLine);
      child.on('error', (e) => reject(new Error(`zep sidecar spawn failed: ${e.message}`)));
      child.on('exit', (code, signal) =>
        reject(new Error(`zep sidecar exited before becoming ready (code=${code}, signal=${signal})` + (tail ? ` — stderr tail:\n${tail.trim()}` : ''))
        ));
    });
    let portOrErr;
    try {
      portOrErr = await Promise.race([
        ready,
        sleep(startTimeoutMs).then(() => {
          throw new Error(`zep sidecar did not announce ZEP_SIDECAR_READY within ${startTimeoutMs} ms`);
        }),
      ]);
    } catch (e) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      throw e;
    }
    port = portOrErr;
    baseUrl = `http://${host}:${port}`;
    log(`sidecar pid ${child.pid} on ${baseUrl}`);

    // /health poll: the sidecar binds before it can serve model traffic; the
    // health route works as soon as the process is up (Graphiti init is lazy).
    const deadline = Date.now() + startTimeoutMs;
    while (true) {
      // a signal-killed child has exitCode === null and only signalCode set —
      // check both or a SIGTERM'd sidecar looks alive forever
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('zep sidecar exited during health poll');
      try {
        const res = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const health = await res.json();
          if (health?.ok) return { ...health, baseUrl, port };
        }
      } catch {
        /* not up yet — poll until the deadline */
      }
      if (Date.now() > deadline) throw new Error(`zep sidecar /health never answered within ${startTimeoutMs} ms`);
      await sleep(healthPollMs);
    }
  }

  async function request(pathname, body) {
    if (!baseUrl) throw new Error('zep sidecar request before start() — start the sidecar first');
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
        `zep sidecar unreachable at ${baseUrl}${pathname} (${e.message}) — the arm fails loudly, never with an empty answer`,
        { cause: e }
      );
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
    if (!res.ok || !json?.ok) {
      throw new Error(`zep sidecar ${pathname} -> ${res.status}: ${String(json?.error ?? text).slice(0, 300)}`);
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
      // alive, nudge it — teardown need not wait out the drain (the store is
      // about to be purged or already preserved), but must not stall 15 s.
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
        if (!done) throw new Error(`zep sidecar pid ${pid} did not exit after SIGKILL`);
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
        throw new Error(`zep sidecar pid ${pid} exited but port ${port} is still accepting connections after ${portFreedTimeoutMs} ms`);
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

// Run-facing convenience: resolve env, build a FRESH per-run store, start the
// sidecar. Returns a handle run.mjs carries until its finally-block. A
// mid-run restart passes fresh:false — same store (the kuzu DB file), episodes
// preserved.
export async function startZepSidecar({
  runId,
  llmBaseUrl = null, // e.g. an explicit --answer-url — the zep LLM must match the other arms' answerer
  fresh = true, // false = reuse the existing store dir (restart after a sidecar death)
  env = process.env,
  home = os.homedir(),
  readFile = fs.readFileSync,
  tmpDir = os.tmpdir(),
  log = () => {},
  managerOpts = {},
} = {}) {
  const resolved = resolveZepEnv({ env, home, readFile });
  const storePath = path.join(tmpDir, `zep-bench-${runId}`);
  if (fresh) fs.rmSync(storePath, { recursive: true, force: true }); // fresh store per run: no leakage across runs
  const manager = createZepSidecarManager({
    python: resolveSidecarPython({ env }),
    env: {
      ZEP_LLM_BASE_URL: llmBaseUrl ?? resolved.llmBaseUrl,
      ZEP_LLM_MODEL: resolved.llmModel,
      ZEP_EMBEDDER_BASE_URL: resolved.embedderBaseUrl,
      ZEP_EMBEDDER_MODEL: resolved.embedderModel,
      ZEP_EMBEDDER_DIMS: String(resolved.embedderDims),
      ZEP_STORE_PATH: storePath,
      ZEP_SIDECAR_PORT: '0',
    },
    log,
    ...managerOpts,
  });
  const health = await manager.start();
  return { manager, health, env: resolved, storePath, scope: zepScope(runId), stop: () => manager.stop() };
}

export function removeZepStore(storePath) {
  fs.rmSync(storePath, { recursive: true, force: true });
}

// The arm. `sidecar` is a STARTED sidecar client ({request}), normally the
// manager from startZepSidecar (which run.mjs also uses for the regime stamp).
// run.mjs passes the run's handle as `zep` ({sidecar, zepVersion, restart});
// direct sidecar/zepVersion args keep working for tests and standalone use.
// If the arm itself was handed an un-started lifecycle it owns, set
// ownsSidecar — dispose() then stops it (runBench calls dispose after the arm's
// rows are in).
export function createArmZep({
  answerChat,
  runId,
  retrievalBudget,
  sidecar = null,
  zepVersion = null,
  ownsSidecar = false,
  zep = null,
  log = () => {},
  resumeDir = null, // results dir — per-question checkpoint of how many sessions are in the store
  restartSidecar = null, // async () => fresh {request} against the SAME store (sidecar died mid-run)
  maxRestarts = 5,
}) {
  sidecar = sidecar ?? zep?.sidecar ?? null;
  zepVersion = zepVersion ?? zep?.zepVersion ?? null;
  restartSidecar = restartSidecar ?? zep?.restart ?? null;
  if (typeof answerChat !== 'function') throw new Error('arm_zep requires answerChat');
  // refuse to run on an unstamped budget: an undefined budget used to surface
  // only as a sidecar 400 on the first question — after every session was written
  if (!Number.isInteger(retrievalBudget) || retrievalBudget <= 0) {
    throw new Error(`arm_zep: retrievalBudget must be a positive int (got ${retrievalBudget}) — run.mjs's armContext provides it`);
  }
  if (!sidecar || typeof sidecar.request !== 'function') {
    throw new Error('arm_zep requires a started sidecar — startZepSidecar() / run.mjs provides it');
  }
  const scope = zepScope(runId);

  // The sidecar is long-lived (a 50-item write phase is hours of LLM
  // extractions), so it can die mid-run to something outside this process. A
  // request that died with ECONNREFUSED provably never reached a listener —
  // nothing committed — so restarting the sidecar (same store) and replaying it
  // cannot duplicate episodes. Any other failure mode (timeout, reset
  // mid-response) could have committed server-side: those fail the run loudly.
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
        log(`sidecar connection refused on ${pathname} — restarting sidecar (${restarts}/${maxRestarts}, store preserved), replaying`);
        current = await restartSidecar();
        // loop: replay the same call on the new sidecar
      }
    }
  };

  // session-granularity checkpoint: a session is recorded only after its /add
  // returned 200, so resuming at `sessions_done` never re-adds a committed one
  const cpFile = (qid) => path.join(resumeDir, `zep-sessions-${String(qid).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const readCp = (qid) => {
    try { return JSON.parse(fs.readFileSync(cpFile(qid), 'utf8')).sessions_done ?? 0; } catch { return 0; }
  };
  const writeCp = (qid, sessionsDone) => {
    fs.mkdirSync(resumeDir, { recursive: true });
    fs.writeFileSync(cpFile(qid), JSON.stringify({ question_id: qid, sessions_done: sessionsDone }) + '\n');
  };

  return {
    name: 'zep',
    scope,
    async write(sessionTurns, { questionId } = {}) {
      if (!Array.isArray(sessionTurns)) throw new Error('arm_zep.write expects haystack_sessions (array of sessions)');
      let rows = 0;
      const done = resumeDir ? readCp(questionId) : 0;
      if (done > 0) log(`resuming q=${questionId}: ${done}/${sessionTurns.length} sessions already in the store`);
      for (let idx = done; idx < sessionTurns.length; idx++) {
        const turns = sessionTurns[idx].map((t) => {
          if (typeof t?.role !== 'string' || typeof t?.content !== 'string') {
            throw new Error(`arm_zep.write: session ${idx} turn is not {role, content} strings`);
          }
          return { role: t.role, content: t.content };
        });
        // one POST per session — Graphiti's add_episode runs its own entity/edge
        // extraction over the whole session. Log each one's size + duration +
        // extracted-fact count: over a multi-hour write phase this is the
        // throughput trace that shows whether an add is stalled or slow.
        const t0 = Date.now();
        const kb = (turns.reduce((a, t) => a + t.content.length, 0) / 1024).toFixed(1);
        const r = await call('/add', {
          user_id: scope,
          messages: turns,
          metadata: { question_id: questionId, session_index: idx, bench: 'longmemeval', bench_run_id: runId },
        });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log(`add ${idx + 1}/${sessionTurns.length} (${kb} KB, ${r.count ?? 0} facts) in ${secs}s — q=${questionId}`);
        rows += r.count ?? 0;
        if (resumeDir) writeCp(questionId, idx + 1);
      }
      return { docs: sessionTurns.length, rows };
    },
    async answer(question) {
      const s = await call('/search', { query: question, user_id: scope, limit: retrievalBudget });
      const facts = s.results ?? [];
      const context = facts.map((r) => r.memory).filter(Boolean).join('\n\n---\n\n');
      const r = await answerChat({
        system: RAG_SYSTEM,
        user: `Memory context:\n${context || '(no memory found)'}\n\nQuestion: ${question}`,
      });
      return {
        text: r.text,
        meta: {
          hits: facts.length,
          retrieval_mode: 'zep-oss-kuzu-hybrid-rrf',
          zep_version: zepVersion,
          had_think: !!r.hadThink,
        },
      };
    },
    async dispose() {
      if (ownsSidecar && typeof sidecar.stop === 'function') await sidecar.stop();
    },
  };
}

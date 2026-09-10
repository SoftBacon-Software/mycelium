#!/usr/bin/env node
// Memory benchmark P1 — CLI.
//
//   node bench/memory/run.mjs --split longmemeval --arms none,mycelium --n 50 --receipt
//
// Branch-only tool: reads the platform, writes namespaced bench rows, deletes
// them again. Pushes nothing, deploys nothing, switches no seat.

import fs from 'node:fs';
import path from 'node:path';

import { loadSplit, selectItems, BENCH_DIR } from './split.mjs';
import { resolvePlatformEnv, resolveAdminKey, createPlatform } from './platform.mjs';
import { makeOpenAIChat } from './answer.mjs';
import { makeJudge, agreement, JUDGE_PROMPT_VERSION } from './judge.mjs';
import { rejudgeRun } from './rejudge.mjs';
import { ARM_FACTORIES, resolveArms } from './arms/index.mjs';
import { startMem0Sidecar, removeMem0Store } from './arms/arm_mem0.mjs';
import { mem0RawScope } from './arms/arm_mem0_raw.mjs';
import { myceliumExtractNamespace, EXTRACTION_SYSTEM } from './arms/arm_mycelium_extract.mjs';
import { myceliumTimelineNamespace, RECONCILE_SYSTEM } from './arms/arm_mycelium_timeline.mjs';
import { createFactsStore, FACTS_FILE } from './facts_store.mjs';
import { createHash } from 'node:crypto';
import { startZepSidecar, removeZepStore } from './arms/arm_zep.mjs';
import { startLettaSidecar, purgeLettaScope } from './arms/arm_letta.mjs';
import { extractionThinkingByArm, assertNoExtractionThinkingMix } from './ingestion.mjs';
import { buildRegime, gitState } from './regime.mjs';
import { runBench } from './core.mjs';
import { renderReceipt, writeReceipt } from './receipt.mjs';
import { composeGrid } from './grid.mjs';
import { purgeNamespaces } from './cleanup.mjs';
import { waitForEmbeddings } from './embedding_wait.mjs';
import { acquireSlotLock, probeTotalSlots, DEFAULT_LOCK_DIR } from './slot_lock.mjs';

const REPO_ROOT = path.resolve(BENCH_DIR, '..', '..');
const RESULTS_DIR = path.join(BENCH_DIR, 'results');
const HARNESS_VERSION = 'p1-skeleton.1';


function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'receipt' || key === 'keep' || key === 'rejudge' || key === 'no-slot-lock') { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function utcStamp(d) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---------------- from-results + --rejudge: re-judge the saved answers ------
  // Re-runs ONLY the judge over the run's saved answers (<arm>.rows.jsonl):
  // no answerer calls, no platform calls. Writes judged.rejudge.jsonl +
  // summary.rejudge.json beside the originals (originals never touched) and,
  // with --receipt, a `<runId>-rejudge` receipt whose regime block records the
  // judge prompt version and which run was re-judged.
  if (args['from-results'] && args.rejudge) {
    const dir = path.resolve(args['from-results']);
    const judgeUrl = args['judge-url'] ?? 'http://localhost:8780/v1';
    const judgeModel = args['judge-model'] ?? 'Laguna-XS-2.1-mlx-oq4e-agentic-ours';
    const judgeChat = makeOpenAIChat({ url: judgeUrl, model: judgeModel, maxTokens: 12 });
    const judgeFn = makeJudge({ chat: judgeChat });

    let fd = null;
    try {
      const result = await rejudgeRun({
        dir,
        judgeFn,
        judge: { model: judgeModel, url_host: new URL(judgeUrl).host },
        judgePromptVersion: JUDGE_PROMPT_VERSION,
        generatedAtUtc: utcStamp(new Date()),
        onJudged: (row) => {
          if (fd === null) fd = fs.openSync(path.join(dir, 'judged.rejudge.jsonl'), 'w');
          fs.writeSync(fd, JSON.stringify(row) + '\n');
        },
        log: (m) => console.error(`[rejudge] ${m}`),
      });
      const summaryFile = path.join(dir, 'summary.rejudge.json');
      fs.writeFileSync(summaryFile, JSON.stringify(result.summary, null, 2));

      let judgeAgreement = null;
      let handlabelsMeta = null;
      if (args.handlabels) {
        const hl = JSON.parse(fs.readFileSync(args.handlabels, 'utf8'));
        judgeAgreement = agreement(result.judged, hl.items);
        handlabelsMeta = { hand_scorer: hl.hand_scorer, path: args.handlabels, n: hl.items.length };
      }

      let receiptFile = null;
      if (args.receipt) {
        const dirRel = path.relative(REPO_ROOT, dir);
        const md = renderReceipt({
          runId: result.summary.run_id,
          summary: result.summary,
          agreement: judgeAgreement,
          handlabels: handlabelsMeta,
          commands: [
            `node bench/memory/run.mjs --from-results ${dirRel.startsWith('..') ? dir : dirRel} --rejudge` +
              `${args.handlabels ? ` --handlabels ${args.handlabels}` : ''} --receipt`,
          ],
          rejudge: { ofRunId: result.summary.rejudged_from, judgePromptVersion: JUDGE_PROMPT_VERSION },
          generatedAt: utcStamp(new Date()),
        });
        receiptFile = writeReceipt(result.summary.run_id, md);
        console.error(`[run] receipt: ${receiptFile}`);
      }

      console.log(JSON.stringify({
        rejudged_from: result.summary.rejudged_from,
        judge_prompt_version: JUDGE_PROMPT_VERSION,
        judged_file: path.relative(REPO_ROOT, result.judgedFilePath),
        summary_file: path.relative(REPO_ROOT, summaryFile),
        agreement: judgeAgreement
          ? { n: judgeAgreement.n, agree: judgeAgreement.agree, rate: judgeAgreement.rate }
          : null,
        receipt: receiptFile ? path.relative(REPO_ROOT, receiptFile) : null,
      }, null, 2));
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    return;
  }

  // ---------------- from-results mode: regenerate receipt from evidence -------
  if (args['from-results']) {
    const dir = path.resolve(args['from-results']);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    const judged = fs.existsSync(path.join(dir, 'judged.jsonl')) ? readJsonl(path.join(dir, 'judged.jsonl')) : null;
    const runId = summary.run_id;
    let judgeAgreement = null;
    let handlabelsMeta = null;
    if (args.handlabels) {
      const hl = JSON.parse(fs.readFileSync(args.handlabels, 'utf8'));
      judgeAgreement = agreement(judged ?? [], hl.items);
      handlabelsMeta = { hand_scorer: hl.hand_scorer, path: args.handlabels, n: hl.items.length };
    }
    const md = renderReceipt({
      runId,
      summary,
      agreement: judgeAgreement,
      handlabels: handlabelsMeta,
      cleanup: summary.cleanup ?? null,
      writeInfo: summary.write_info ?? null,
      commands: summary.commands ?? [],
      generatedAt: utcStamp(new Date()),
    });
    const file = writeReceipt(runId, md);
    console.log(JSON.stringify({ receipt: file, judgeAgreement }, null, 2));
    return;
  }

  // ---------------- grid-from-results: compose the 2×2 from SEPARATE runs -----
  // The {Mycelium, Mem0} × {raw, extract} grid rarely lands in ONE run — the
  // 3090 window serves two 32k slots, so the mem0 pair and the mycelium pair
  // run side by side. This composes the grid receipt from two or more FINISHED
  // run dirs (task 183): grid.mjs refuses loudly unless the runs are
  // comparable (same dataset/judge/answerer/budget/n/question ids), and on a
  // match writes ONE receipt whose 2×2 is renderIngestionGrid over the union
  // of the runs' arms. Without --receipt this is a dry-run: the check runs,
  // nothing is written.
  if (args['grid-from-results']) {
    const dirs = String(args['grid-from-results'])
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out = composeGrid({ dirs, generatedAt: utcStamp(new Date()), write: Boolean(args.receipt) });
    console.log(
      JSON.stringify(
        {
          runs: out.runIds,
          grid_rendered: out.gridRendered,
          ...(args.receipt
            ? { receipt: path.relative(REPO_ROOT, out.file) }
            : { wrote: false, why: 'dry run — pass --receipt to write' }),
        },
        null,
        2
      )
    );
    return;
  }

  // ---------------- fresh run --------------------------------------------------
  const splitName = args.split ?? 'longmemeval';
  const arms = resolveArms(String(args.arms ?? 'none,mycelium').split(',').map((s) => s.trim()).filter(Boolean));
  const n = parseInt(args.n ?? '50', 10);
  const budget = parseInt(args.budget ?? '5', 10);
  // --max-sessions N: cap the haystack sessions WRITTEN per question (the smoke
  // lever — a full question is ~30 sessions of competitor-arm LLM extraction;
  // a smoke takes the first few). Must be stamped into the regime: a capped
  // write is a different regime, and quoting it as a full run is a lie.
  const maxSessions = args['max-sessions'] != null ? parseInt(args['max-sessions'], 10) : null;
  if (maxSessions !== null && (!Number.isInteger(maxSessions) || maxSessions <= 0)) {
    throw new Error(`--max-sessions must be a positive int (got ${args['max-sessions']})`);
  }
  // task 182 ingestion controls: `mycelium-extract` needs the platform like
  // `mycelium` does; `mem0-raw` shares the mem0 sidecar (in its own -raw scope).
  // The §3 timeline arm is a platform arm too (episodic + reconciled layers).
  const wantsPlatform = arms.includes('mycelium') || arms.includes('mycelium-extract') || arms.includes('mycelium-timeline');
  const wantsMem0Sidecar = arms.includes('mem0') || arms.includes('mem0-raw');

  const split = await loadSplit(splitName);
  const items = selectItems(split.items, n);
  if (items.length < n) throw new Error(`split ${splitName} has only ${split.items.length} items; requested n=${n}`);

  const runId = `${utcStamp(new Date()).slice(0, 10)}-p1-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;

  // Platform (required when a mycelium-family arm is in play; address never hardcoded)
  let platformEnv = null;
  try { platformEnv = resolvePlatformEnv(); } catch { /* no substrate — only fine if no mycelium arm */ }
  let platform = null;
  let platformFacts = { url_host: null, version: null, embedding_provider: null, embedding_model: null, chunk_size: null };
  let statsBefore = null;
  if (wantsPlatform) {
    if (!platformEnv) throw new Error('mycelium arm requested but no platform address resolved (MYCELIUM_URL / substrate.conf)');
    const adminKey = await resolveAdminKey({ keychainService: platformEnv.keychainService });
    if (!adminKey) throw new Error('No admin key: set MYCELIUM_ADMIN_KEY or install the keychain service named in substrate.conf');
    // 180 s per call, 8 retries (backoff capped at 30 s): run B4 (2026-09-09)
    // died at answer 20/50 of the extract arm — five 30 s search timeouts in a
    // row while the Jetson's embedder was still chewing the 13,869 fact rows the
    // arm had just indexed (the query embedding queues behind the bulk backlog).
    // A slow store is a wait; the slot lock already keeps the box exclusive.
    platform = createPlatform({
      baseUrl: platformEnv.baseUrl,
      headers: { 'X-Admin-Key': adminKey, 'X-Acting-As': 'm5Max' },
      timeoutMs: parseInt(args['platform-timeout-ms'] ?? '180000', 10),
      maxRetries: parseInt(args['platform-retries'] ?? '8', 10),
    });
    const health = await platform.health();
    const cfg = await platform.config();
    statsBefore = await platform.stats();
    platformFacts = {
      url_host: new URL(platformEnv.baseUrl).host,
      transport: platform.engine,
      version: health.version ?? null,
      embedding_provider: cfg.embedding_provider ?? null,
      embedding_model: cfg.embedding_model ?? null,
      chunk_size: cfg.chunk_size ?? null,
    };
  }

  // mem0 competitor arm (and its task-182 raw control, which shares this
  // sidecar in a suffixed scope): the sidecar starts BEFORE the regime is
  // built (the stamp carries the sidecar's /health facts) and is stopped + its
  // local store purged in the finally below — success or failure.
  let mem0Handle = null;
  if (wantsMem0Sidecar) {
    mem0Handle = await startMem0Sidecar({
      runId,
      llmBaseUrl: args['answer-url'] ?? null, // an explicit answer endpoint applies to mem0's LLM too
      log: (m) => console.error(`[mem0] ${m}`),
    });
    console.error(`[run] mem0 sidecar: v${mem0Handle.health.mem0_version}, store ${mem0Handle.storePath}`);
    // Mid-run sidecar death: the arm only calls this when a request died with
    // ECONNREFUSED (nothing committed — a replay cannot duplicate memories).
    // Same runId → same store dir, NOT wiped; the handle is swapped so the
    // finally-block stops the NEW sidecar.
    mem0Handle.restart = async () => {
      try {
        await mem0Handle.stop();
      } catch (e) {
        console.error(`[run] mem0 old sidecar stop problem (continuing with restart): ${e.message}`);
      }
      const again = await startMem0Sidecar({
        runId,
        llmBaseUrl: args['answer-url'] ?? null,
        fresh: false,
        log: (m) => console.error(`[mem0] ${m}`),
      });
      mem0Handle.manager = again.manager;
      mem0Handle.health = again.health;
      mem0Handle.storePath = again.storePath;
      mem0Handle.stop = () => again.manager.stop();
      console.error(`[run] mem0 sidecar RESTARTED: pid ${again.manager.pid}, store preserved (${again.storePath})`);
      return { request: (p, b) => again.manager.request(p, b), health: again.health };
    };
  }

  // zep competitor arm (task 180): same lifecycle as the mem0 sidecar above —
  // started BEFORE the regime is built (the stamp carries its /health facts),
  // restarted mid-run only on ECONNREFUSED, stopped + its kuzu store purged in
  // the finally below — success or failure.
  let zepHandle = null;
  if (arms.includes('zep')) {
    zepHandle = await startZepSidecar({
      runId,
      llmBaseUrl: args['answer-url'] ?? null, // an explicit answer endpoint applies to zep's extraction LLM too
      log: (m) => console.error(`[zep] ${m}`),
    });
    console.error(`[run] zep sidecar: graphiti v${zepHandle.health.graphiti_version}, kuzu v${zepHandle.health.kuzu_version}, store ${zepHandle.storePath}`);
    // Mid-run sidecar death: the arm only calls this when a request died with
    // ECONNREFUSED (nothing committed — a replay cannot duplicate episodes).
    // Same runId → same store dir, NOT wiped; the handle is swapped so the
    // finally-block stops the NEW sidecar.
    zepHandle.restart = async () => {
      try {
        await zepHandle.stop();
      } catch (e) {
        console.error(`[run] zep old sidecar stop problem (continuing with restart): ${e.message}`);
      }
      const again = await startZepSidecar({
        runId,
        llmBaseUrl: args['answer-url'] ?? null,
        fresh: false,
        log: (m) => console.error(`[zep] ${m}`),
      });
      zepHandle.manager = again.manager;
      zepHandle.health = again.health;
      zepHandle.storePath = again.storePath;
      zepHandle.stop = () => again.manager.stop();
      console.error(`[run] zep sidecar RESTARTED: pid ${again.manager.pid}, store preserved (${again.storePath})`);
      return { request: (p, b) => again.manager.request(p, b), health: again.health };
    };
  }

  // letta competitor arm (task 181): sidecar lifecycle as above, with ONE
  // letta-specific fact — the store is an EXTERNAL letta server (OSS letta
  // 0.16.8 requires PostgreSQL+pgvector; installing a DB server is a director
  // decision, not ours), so /health ok:false fails the BOOT gate, per-run
  // isolation is a fresh letta AGENT (reattached across restarts via the
  // sidecar's LETTA_STATE_FILE), and teardown DELETES the agent.
  let lettaHandle = null;
  if (arms.includes('letta')) {
    lettaHandle = await startLettaSidecar({
      runId,
      llmBaseUrl: args['answer-url'] ?? null, // an explicit answer endpoint applies to letta's agent LLM too
      log: (m) => console.error(`[letta] ${m}`),
    });
    console.error(
      `[run] letta sidecar: server v${lettaHandle.health.letta_version} (client v${lettaHandle.health.letta_client_version}), ` +
        `store ${lettaHandle.health.server.url_host} — version match: ${lettaHandle.health.letta_version_matches}`
    );
    // Mid-run sidecar death: the arm only calls this when a request died with
    // ECONNREFUSED (nothing committed — a replay cannot duplicate passages).
    // The letta AGENT (the store) survives on the server; the restarted
    // sidecar reattaches to it via the state file keyed by runId.
    lettaHandle.restart = async () => {
      try {
        await lettaHandle.stop();
      } catch (e) {
        console.error(`[run] letta old sidecar stop problem (continuing with restart): ${e.message}`);
      }
      const again = await startLettaSidecar({
        runId,
        llmBaseUrl: args['answer-url'] ?? null,
        fresh: false,
        log: (m) => console.error(`[letta] ${m}`),
      });
      lettaHandle.manager = again.manager;
      lettaHandle.health = again.health;
      lettaHandle.stateFile = again.stateFile;
      lettaHandle.stop = () => again.manager.stop();
      console.error(`[run] letta sidecar RESTARTED: pid ${again.manager.pid}, agent reattached from ${again.stateFile}`);
      return { request: (p, b) => again.manager.request(p, b), health: again.health };
    };
  }

  // task 182, addendum 6: every EXTRACTION arm in one run must share one
  // stamped extraction-thinking mode. mycelium-extract is hardcoded off; the
  // mem0 sidecar stamps what it was started with (MEM0_NO_THINK, default on
  // since this task). Raw arms do no LLM extraction and are exempt.
  assertNoExtractionThinkingMix(arms, extractionThinkingByArm(arms, { mem0Health: mem0Handle?.health ?? null }));

  // Models (local; $0)
  const boxUrl =
    platformEnv?.box3090Url || mem0Handle?.env.box3090Url || zepHandle?.env.box3090Url || lettaHandle?.env.box3090Url || null;
  const answerUrl = args['answer-url'] ?? (boxUrl ? `${boxUrl}/v1` : null);
  const answerModel = args['answer-model'] ?? 'qwen3.8:27b';
  if (!answerUrl) throw new Error('No answer endpoint: pass --answer-url or set BOX_3090_URL (substrate.conf)');

  // The 3090 slot lock (2026-09-09): one run = one served slot at a time; a
  // run refuses to start when every slot is held by a live run (a call queued
  // behind another client's generation is how three Mem0 smokes died). The
  // slot count is what the box serves NOW (/props total_slots; 1 when the box
  // does not say). Released in the finally; a dead holder is swept by the next
  // caller. --no-slot-lock is the deliberate escape hatch, stamped below.
  let slotLock = null;
  let slotLockFacts = { enabled: false, why: '--no-slot-lock passed' };
  if (!args['no-slot-lock']) {
    const propsBase = boxUrl ?? answerUrl.replace(/\/v1\/?$/, '');
    const served = await probeTotalSlots(propsBase);
    const totalSlots = served ?? 1;
    slotLock = acquireSlotLock({ totalSlots, label: `${runId} ${arms.join(',')}` });
    slotLockFacts = { enabled: true, dir: DEFAULT_LOCK_DIR, total_slots: totalSlots, served_slots: served, holders_before: slotLock.holders_before };
    console.error(`[run] 3090 slot lock: held ${slotLock.holders_before + 1}/${totalSlots} (${slotLock.file})`);
  }
  const judgeUrl = args['judge-url'] ?? 'http://localhost:8780/v1';
  const judgeModel = args['judge-model'] ?? 'Laguna-XS-2.1-mlx-oq4e-agentic-ours';
  // mycelium-extract's extractor = the SAME answerer model, temperature 0,
  // THINKING OFF (chat_template_kwargs — honoured by llama.cpp; with thinking
  // on each extraction burned ~300 reasoning tokens on the one 3090 slot —
  // measured 16 h/write-phase at n=50 before this). max_tokens matches the
  // answerer's default: the extractor returns a short JSON fact list.
  // mycelium-timeline uses the SAME thinking-off endpoint twice: extraction
  // (identical to the extract arm) and the ONE reconcile decision call per
  // candidate — both short replies, both stamped.
  const EXTRACT_MAX_TOKENS = parseInt(args['extract-max-tokens'] ?? '4096', 10);
  const wantsThinkingOffChat = arms.includes('mycelium-extract') || arms.includes('mycelium-timeline');
  const extractionChat = wantsThinkingOffChat
    ? makeOpenAIChat({
        url: answerUrl,
        model: answerModel,
        maxTokens: EXTRACT_MAX_TOKENS,
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
      })
    : null;
  const reconcileChat = arms.includes('mycelium-timeline')
    ? makeOpenAIChat({
        url: answerUrl,
        model: answerModel,
        maxTokens: EXTRACT_MAX_TOKENS,
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
      })
    : null;

  // 4096: thinking models (qwen3.8 on llama.cpp) spend max_tokens on
  // reasoning_content before the answer — 256 left nothing for the answer, and
  // at 1024 one hard question (4,450 reasoning chars, finish_reason=length)
  // still came back empty and tripped the loud guard mid-run. 4096 gives ~4×
  // the worst observed reasoning budget. The value is stamped into the regime.
  const ANSWER_MAX_TOKENS = parseInt(args['answer-max-tokens'] ?? '4096', 10);
  const answerChat = makeOpenAIChat({ url: answerUrl, model: answerModel, maxTokens: ANSWER_MAX_TOKENS });
  const judgeChat = makeOpenAIChat({ url: judgeUrl, model: judgeModel, maxTokens: 12 });
  const judgeFn = makeJudge({ chat: judgeChat });

  const git = await gitState(REPO_ROOT);
  const regime = buildRegime({
    dateUtc: utcStamp(new Date()),
    git,
    harnessVersion: HARNESS_VERSION,
    dataset: {
      name: split.spec.name,
      file: split.spec.file,
      sha256: split.sha256,
      licence: split.spec.licence,
      url: split.spec.url,
      count: split.count,
      citation: split.spec.citation,
    },
    answerer: { model: answerModel, url_host: new URL(answerUrl).host, temperature: 0, max_tokens: ANSWER_MAX_TOKENS },
    judge: { model: judgeModel, url_host: new URL(judgeUrl).host, judge_prompt_version: JUDGE_PROMPT_VERSION },
    retrieval: {
      budget,
      chunking: 'one memory row per haystack session (server-side chunk-aware split for oversized rows)',
      source_type: 'bench_longmemeval',
      namespace: `bench-p1-${runId}`,
      server_mode: 'hybrid (server-side; per-query observed mode recorded in rows)',
    },
    platform: platformFacts,
    mem0: mem0Handle
      ? {
          ...mem0Handle.health,
          retrieval_budget: budget,
          scope: mem0Handle.scope,
          sidecar: 'bench/memory/arms/mem0_sidecar.py (spawned per run, 127.0.0.1 only, telemetry off)',
        }
      : null,
    // task 182 ingestion controls — stamped only when the arm is in the run
    mem0_raw: arms.includes('mem0-raw')
      ? {
          ...mem0Handle.health,
          ingestion: 'raw',
          infer: false,
          mem0_add_infer:
            'Memory.add(messages, infer=False) — mem0ai 2.0.20 mem0/memory/main.py:770 (param default True); ' +
            'the raw path at :880 stores each NON-SYSTEM message verbatim, one memory per turn, no LLM call',
          scope: mem0RawScope(runId),
          retrieval_budget: budget,
          extraction_thinking: 'n/a (raw ingestion — no LLM in the write path)',
          sidecar: 'bench/memory/arms/mem0_sidecar.py (same sidecar as the mem0 arm; per-request infer:false)',
        }
      : null,
    mycelium_extract: arms.includes('mycelium-extract')
      ? {
          ingestion: 'extract',
          extraction_model: answerModel,
          extraction_url_host: new URL(answerUrl).host,
          extraction_temperature: 0,
          extraction_max_tokens: EXTRACT_MAX_TOKENS,
          extraction_thinking: 'off',
          extraction_request: 'chat_template_kwargs {"enable_thinking": false} (llama.cpp honours it)',
          extraction_prompt:
            'bench/memory/arms/arm_mycelium_extract.mjs EXTRACTION_SYSTEM — mirrors the STRUCTURE of mem0ai 2.0.20 ' +
            'mem0/configs/prompts.py:15 FACT_RETRIEVAL_PROMPT (role → fact categories → few-shot Input/Output pairs → ' +
            'JSON {"facts": [...]} contract); wording paraphrased, vendor text not copied',
          facts_row_shape: 'one_row_per_fact',
          facts_row_shape_why:
            'arm mem0 (the extract-policy competitor) stores one memory per extracted fact — per-fact rows are what ' +
            'extraction-ingestion produces upstream of retrieval; one row per session would change retrieved-context ' +
            'size and re-confound the comparison',
          namespace: myceliumExtractNamespace(`bench-p1-${runId}`),
          retrieval_budget: budget,
        }
      : null,
    mycelium_timeline: arms.includes('mycelium-timeline')
      ? {
          ingestion: 'timeline',
          extraction_model: answerModel,
          extraction_url_host: new URL(answerUrl).host,
          extraction_temperature: 0,
          extraction_max_tokens: EXTRACT_MAX_TOKENS,
          extraction_thinking: 'off',
          extraction_request: 'chat_template_kwargs {"enable_thinking": false} (llama.cpp honours it)',
          extraction_prompt:
            'bench/memory/arms/arm_mycelium_extract.mjs EXTRACTION_SYSTEM — the SAME extractor call as the extract arm',
          decision_model: answerModel,
          decision_url_host: new URL(answerUrl).host,
          decision_temperature: 0,
          decision_max_tokens: EXTRACT_MAX_TOKENS,
          decision_thinking: 'off',
          decision_shape: 'ONE decision call per candidate fact, only when the reconcile search surfaced >=1 current same-question fact',
          reconcile_prompt: RECONCILE_SYSTEM,
          reconcile_policy: {
            top_k: 3,
            search_overfetch: 25,
            scope: 'CURRENT same-question facts only (metadata.question_id match, valid_to null) — the server has no metadata filter, so the search overfetches and the arm filters client-side',
            auto_add_on_no_match: true,
            fail_open_on_malformed_decision: 'ADD, counted in decision_failures (never a silent drop)',
            supersede: 'the old fact KEEPS its row: valid_to = this session date, superseded_by + superseded_by_text pointers; never deleted',
            in_session_window: 'facts decided earlier in the SAME session are shown to later candidates before the bulk flush lands',
          },
          layers: {
            episodic: {
              namespace: `bench-p1-${runId}`,
              row_shape: 'arm_mycelium\'s verbatim session row (same source_id shape, same `role: content` rendering) + metadata.layer=episode + metadata.session_date (dataset haystack_dates, verbatim)',
            },
            reconciled: {
              namespace: myceliumTimelineNamespace(`bench-p1-${runId}`),
              row_shape:
                'one row per surviving fact; metadata carries episode (the episodic row\'s source_id), session_date, valid_from, valid_to (null while current), supersedes / superseded_by / superseded_by_text',
            },
          },
          store_not_am_facts_why:
            'the am_facts bi-temporal routes ARE deployed (checked live 2026-09-10: GET /auto-memory/facts answers) but do not fit the bench row model ' +
            'without a deploy or shared-state damage: am_facts has no semantic-search route (reconcile + read need /memory/search hybrid at the stamped budget), ' +
            'no namespace/run scoping (bench rows would land in the lab\'s LIVE fact store beside its ~1.8k real facts), and no bulk cleanup path (the bench ' +
            'contract is purge-everything-after). So the layer is modeled as memory rows in a suffixed namespace with the bi-temporal fields in metadata — ' +
            'the lane\'s pre-authorized fallback.',
          read: {
            budget,
            merge: 'both layers searched at the budget; merged CURRENT facts first (server rank order), then episodes, then superseded facts; capped at the budget',
            hit_rendering:
              'each hit carries its date: `[fact | <valid_from>]` / `[session | <session_date>]`; a superseded fact appends the line ' +
              '"superseded on <valid_to> by: <new fact>"',
            rag_prompt: 'arm_mycelium RAG_SYSTEM, unchanged',
          },
          retrieval_budget: budget,
        }
      : null,
    zep: zepHandle
      ? {
          ...zepHandle.health,
          retrieval_budget: budget,
          scope: zepHandle.scope,
          sidecar: 'bench/memory/arms/zep_sidecar.py (spawned per run, 127.0.0.1 only, telemetry off)',
        }
      : null,
    letta: lettaHandle
      ? {
          ...lettaHandle.health,
          retrieval_budget: budget,
          scope: lettaHandle.scope,
          sidecar: 'bench/memory/arms/letta_sidecar.py (spawned per run, 127.0.0.1 only, telemetry off)',
        }
      : null,
    write: maxSessions ? { max_sessions_per_question: maxSessions } : null,
    n: items.length,
    notes: [
      arms.includes('mem0-raw')
        ? `arms this run: ${arms.join(', ')}; mem0-raw = the RAW-ingestion control for the Mem0 column (task 182): Memory.add(infer=False) stores each non-system turn verbatim, no extraction LLM; same sidecar/embedder/answerer/budget as arm mem0, scope suffixed -raw`
        : null,
      arms.includes('mycelium-extract')
        ? `arms this run: ${arms.join(', ')}; mycelium-extract = the EXTRACTION control for the Mycelium column (task 182): the answerer model (${answerModel}, temperature 0, THINKING OFF via chat_template_kwargs) extracts a fact list per session, facts indexed ONE ROW PER FACT, namespace suffixed -extract; retrieval + answer identical to arm mycelium`
        : null,
      arms.includes('mycelium-timeline')
        ? `arms this run: ${arms.join(', ')}; mycelium-timeline = the §3 TIMELINE arm (BRIEF-lab-alive-memory-program): episodic layer (arm_mycelium's verbatim session rows + the dataset's session dates) + reconciled layer (same extractor as mycelium-extract, then per candidate ONE reconcile search + ONE ADD/SUPERSEDE/KEEP decision call, ${answerModel} temp 0 thinking off; a superseded fact keeps its row with valid_to + superseded_by pointers); read = both layers at the same budget, current facts first, every hit rendered with its date and supersede lines`
        : null,
      arms.includes('mem0')
        ? `arms this run: ${arms.join(', ')}; mem0 = OSS mem0ai via its default local qdrant store, its LLM and embedder matched to the incumbent arms' answerer/embedder`
        : null,
      arms.includes('zep')
        ? `arms this run: ${arms.join(', ')}; zep = OSS graphiti-core (Zep's graph memory) on its embedded kuzu store (deprecated upstream — stamped in regime.zep), its extraction LLM and embedder matched to the incumbent arms' answerer/embedder, search = the library's default EDGE_HYBRID_SEARCH_RRF (no LLM reranker)`
        : null,
      arms.includes('letta')
        ? `arms this run: ${arms.join(', ')}; letta = OSS letta server (formerly MemGPT) archival memory via the official letta-client SDK, one archival passage per haystack session, its agent LLM and embedder matched to the incumbent arms' answerer/embedder; the server EXTERNAL (PostgreSQL+pgvector is its storage requirement — no embedded store exists in 0.16.8, see letta-requirements.txt)`
        : null,
      arms.length === 2 && arms.includes('none') && arms.includes('mycelium')
        ? 'two arms only: none (no memory) and mycelium (platform memory API); competitor arms are task 165+'
        : null,
      ...(maxSessions ? [`SMOKE: write phase capped at ${maxSessions} sessions per question (regime.write) — NOT a full-run number`] : []),
      'judge is a local model; validated against a hand-scored set — see receipt judge-validation section',
      slotLockFacts.enabled
        ? `3090 slot lock held: ${slotLockFacts.holders_before + 1}/${slotLockFacts.total_slots} served slots (served_slots ${slotLockFacts.served_slots ?? 'unknown → 1'}); a run never shares a slot with another client`
        : '3090 slot lock DISABLED (--no-slot-lock): another client may have shared the answerer/extractor slot during this run',
    ].filter(Boolean),
  });

  // every namespace this run indexes — the failure path purges them too
  const runNamespaces = platform
    ? [
        regime.retrieval.namespace,
        ...(arms.includes('mycelium-extract') ? [myceliumExtractNamespace(regime.retrieval.namespace)] : []),
        ...(arms.includes('mycelium-timeline') ? [myceliumTimelineNamespace(regime.retrieval.namespace)] : []),
      ]
    : [];
  let platformCleanupDone = !platform || Boolean(args.keep);
  try {
    const namespace = regime.retrieval.namespace;
    const outDir = path.join(RESULTS_DIR, runId);
    fs.mkdirSync(outDir, { recursive: true });

    // the extract arm's facts, persisted as extracted; --reuse-facts <dir> re-indexes
    // a prior run's sessions without a model call (same extraction regime only —
    // the store refuses otherwise). Four B-runs died after their extraction on
    // 2026-09-09 and paid the two hours again each time.
    const factsExtraction = arms.includes('mycelium-extract') || arms.includes('mycelium-timeline')
      ? {
          model: answerModel,
          url_host: new URL(answerUrl).host,
          max_tokens: EXTRACT_MAX_TOKENS,
          thinking: 'off',
          prompt_sha256: createHash('sha256').update(EXTRACTION_SYSTEM).digest('hex'),
        }
      : null;
    const factsStore = factsExtraction
      ? createFactsStore({ file: path.join(outDir, FACTS_FILE), extraction: factsExtraction, reuseFrom: args['reuse-facts'] ?? null })
      : null;
    if (factsStore?.reusing) console.error(`[run] extraction facts: reusing from ${factsStore.stats.reuse_file} (run ${factsStore.stats.reuse_source_run_id ?? '?'})`);
    if (factsExtraction) {
      const stamp = regime.mycelium_extract ?? regime.mycelium_timeline;
      stamp.facts_file = path.relative(REPO_ROOT, factsStore.file);
      stamp.facts_reused_from = factsStore.reusing ? { file: factsStore.stats.reuse_file, run_id: factsStore.stats.reuse_source_run_id } : null;
      stamp.facts_extraction_regime = factsExtraction;
    }

    // incremental evidence: rows land on disk as they are produced
    const rowFiles = {};
    for (const a of arms) rowFiles[a] = fs.openSync(path.join(outDir, `${a}.rows.jsonl`), 'w');
    const judgedFile = fs.openSync(path.join(outDir, 'judged.jsonl'), 'w');

    const writeInfoByArm = {};
    const result = await runBench({
      items,
      runId,
      regime,
      armFactories: arms.map((name) => ({
        name,
        // per-arm view: the shared ctx gets the arm's OWN log label (task 182
        // runs several arms in one process — a hardcoded prefix mislabels
        // which arm's write/extract lines these are)
        factory: (ctx) => ARM_FACTORIES[name]({ ...ctx, log: (m) => console.error(`[${name}] ${m}`), ...(name === 'mycelium-extract' || name === 'mycelium-timeline' ? { factsStore } : {}) }),
      })),
      armContext: {
        answerChat,
        extractionChat, // mycelium-extract/mycelium-timeline REFUSE to run without it (thinking-off extractor)
        reconcileChat, // mycelium-timeline's ONE decision call per candidate (thinking off)
        platform,
        runId,
        namespace,
        sourceType: regime.retrieval.source_type,
        budget,
        // arms destructure `retrievalBudget` — before 2026-09-09 only `budget`
        // was carried here, so the mycelium arm searched with the SERVER's
        // default limit (10, measured) while the regime stamped 5. The banked
        // 2026-09-08 rows all show meta.hits=10. Carrying both names keeps the
        // stamped budget and the exercised budget the same thing.
        retrievalBudget: budget,
        resumeDir: outDir,
        // one competitor sidecar per run is the P1 shape; if a run ever carries
        // MORE, each arm also gets a bound restart on its own ctx object
        // (`zep.restart`, `letta.restart`) and the top-level slot routes by
        // registration order (mem0 first).
        restartSidecar: mem0Handle
          ? () => mem0Handle.restart()
          : zepHandle
            ? () => zepHandle.restart()
            : lettaHandle
              ? () => lettaHandle.restart()
              : null,
        mem0: mem0Handle
          ? { sidecar: mem0Handle.manager, mem0Version: mem0Handle.health.mem0_version, restart: () => mem0Handle.restart() }
          : null,
        zep: zepHandle
          ? { sidecar: zepHandle.manager, zepVersion: zepHandle.health.graphiti_version, restart: () => zepHandle.restart() }
          : null,
        letta: lettaHandle
          ? {
              sidecar: lettaHandle.manager,
              lettaVersion: lettaHandle.health.letta_version,
              lettaClientVersion: lettaHandle.health.letta_client_version,
              restart: () => lettaHandle.restart(),
            }
          : null,
      },
      judgeFn,
      maxSessions,
      afterWrite: async ({ arm, writeInfo }) => {
        writeInfoByArm[arm] = writeInfo;
        // both mycelium-family arms index platform rows — the extract arm's
        // per-fact rows need the embedder too, or its answers run keyword-fallback
        if ((arm === 'mycelium' || arm === 'mycelium-extract' || arm === 'mycelium-timeline') && platform) {
          const expected = writeInfo.rows;
          // the Jetson's ollama embedder is sequential (~0.3-0.5s/row): scale the
          // wait with the write size instead of failing into keyword-fallback
          const timeoutMs = Math.max(8 * 60 * 1000, expected * 500);
          console.error(`[run] ${arm}: wrote ${writeInfo.docs} docs / ${expected} rows; waiting for embedding coverage (cap ${Math.round(timeoutMs / 60000)} min)...`);
          const wait = await waitForEmbeddings(platform, { beforeStats: statsBefore, timeoutMs, log: (m) => console.error(`[run] ${m}`) });
          console.error(`[run] embedding wait: ${JSON.stringify(wait)}`);
          writeInfoByArm[arm].embed_wait = wait;
        }
      },
      onRow: (row) => fs.writeSync(rowFiles[row.arm], JSON.stringify(row) + '\n'),
      onJudged: (row) => fs.writeSync(judgedFile, JSON.stringify(row) + '\n'),
    });
    for (const a of arms) fs.closeSync(rowFiles[a]);
    fs.closeSync(judgedFile);

    // cleanup: remove this run's rows from the platform (unless --keep).
    // purgeRunRows paginates: /memory/list caps at 100 rows server-side, so a
    // single list-then-delete sweep would leave everything past row 100 indexed.
    let cleanup = null;
    if (platform) {
      const sourceType = regime.retrieval.source_type;
      if (args.keep) {
        cleanup = { deleted: 0, kept: true, namespace };
      } else {
        // every namespace the run indexed: the extract control arm writes to a
        // suffixed namespace of its own — leaving it behind would leak rows
        // into the next run's substring-scoped lists
        cleanup = await purgeNamespaces(platform, { sourceType, namespaces: runNamespaces, log: (m) => console.error(`[run] ${m}`) });
        platformCleanupDone = true;
      }
    }

    const summary = {
      ...result.summary,
      write_info: writeInfoByArm,
      cleanup,
      ...(mem0Handle ? { mem0_store: { path: mem0Handle.storePath, local_only: true, purged: !args.keep } } : {}),
      ...(zepHandle ? { zep_store: { path: zepHandle.storePath, local_only: true, purged: !args.keep } } : {}),
      // letta keeps no local store — the run's agent on the EXTERNAL letta
      // server is the store; teardown deletes it (recorded as kept under --keep)
      ...(lettaHandle ? { letta_agent: { external: true, server: lettaHandle.health.server.url_host, deleted: !args.keep } } : {}),
      ...(maxSessions ? { max_sessions_per_question: maxSessions } : {}),
      commands: [
        `node bench/memory/run.mjs --split ${splitName} --arms ${arms.join(',')} --n ${n}${maxSessions ? ` --max-sessions ${maxSessions}` : ''} --receipt${args.keep ? ' --keep' : ''}`,
        ...(args.handlabels ? [`node bench/memory/run.mjs --from-results bench/memory/results/${runId} --handlabels ${args.handlabels} --receipt`] : []),
      ],
    };
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

    // handlabels supplied on a fresh run (unusual) or deferred to --from-results
    let judgeAgreement = null;
    let handlabelsMeta = null;
    if (args.handlabels) {
      const hl = JSON.parse(fs.readFileSync(args.handlabels, 'utf8'));
      judgeAgreement = agreement(result.judged ?? [], hl.items);
      handlabelsMeta = { hand_scorer: hl.hand_scorer, path: args.handlabels, n: hl.items.length };
    }

    if (args.receipt) {
      const md = renderReceipt({
        runId,
        summary,
        agreement: judgeAgreement,
        handlabels: handlabelsMeta,
        cleanup,
        writeInfo: writeInfoByArm,
        commands: summary.commands,
        generatedAt: utcStamp(new Date()),
      });
      const file = writeReceipt(runId, md);
      console.error(`[run] receipt: ${file}`);
    }

    console.log(JSON.stringify({ run_id: runId, out_dir: path.relative(REPO_ROOT, outDir), arms: summary.arms }, null, 2));
  } finally {
    if (slotLock) slotLock.release();
    // a run that died before its own cleanup still purges what it wrote —
    // thousands of orphan bench rows would otherwise sit in the embedder's
    // queue and in every later substring-scoped list
    if (!platformCleanupDone && platform) {
      try {
        const c = await purgeNamespaces(platform, { sourceType: regime.retrieval.source_type, namespaces: runNamespaces, log: (m) => console.error(`[run] cleanup after failure — ${m}`) });
        platformCleanupDone = true;
        console.error(`[run] cleanup after failure: ${c.deleted} rows deleted, ${c.rows_remaining_after} remaining`);
      } catch (e) {
        console.error(`[run] cleanup after failure FAILED (orphan rows remain in ${runNamespaces.join(', ')}): ${e.message}`);
      }
    }
    // the sidecars must not outlive the run, whatever the run did — and exit of
    // their pids is not enough, the ports have to be free before we call it stopped
    if (mem0Handle) {
      try {
        await mem0Handle.stop();
        if (!args.keep) {
          removeMem0Store(mem0Handle.storePath);
          console.error(`[run] mem0 store purged: ${mem0Handle.storePath}`);
        } else {
          console.error(`[run] mem0 store KEPT (--keep): ${mem0Handle.storePath}`);
        }
      } catch (e) {
        console.error(`[run] mem0 sidecar teardown problem: ${e.message}`);
      }
    }
    if (zepHandle) {
      try {
        await zepHandle.stop();
        if (!args.keep) {
          removeZepStore(zepHandle.storePath);
          console.error(`[run] zep store purged: ${zepHandle.storePath}`);
        } else {
          console.error(`[run] zep store KEPT (--keep): ${zepHandle.storePath}`);
        }
      } catch (e) {
        console.error(`[run] zep sidecar teardown problem: ${e.message}`);
      }
    }
    if (lettaHandle) {
      // purge BEFORE stopping the sidecar: the agent lives on the remote letta
      // server and is reachable only through the sidecar. A purge failure is
      // logged loudly (an orphaned bench agent remains on the server) but must
      // not stop the sidecar teardown.
      try {
        if (!args.keep) {
          await purgeLettaScope(lettaHandle);
          console.error(`[run] letta agent deleted (scope ${lettaHandle.scope})`);
        } else {
          console.error(`[run] letta agent KEPT (--keep): scope ${lettaHandle.scope} on ${lettaHandle.health.server.url_host}`);
        }
      } catch (e) {
        console.error(`[run] letta agent purge problem (an orphaned agent may remain on the server): ${e.message}`);
      }
      try {
        await lettaHandle.stop();
      } catch (e) {
        console.error(`[run] letta sidecar teardown problem: ${e.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error('[run] FAILED:', e.message);
  process.exit(1);
});

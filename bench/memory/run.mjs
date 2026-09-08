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
import { makeJudge, agreement } from './judge.mjs';
import { ARM_FACTORIES, resolveArms } from './arms/index.mjs';
import { buildRegime, gitState } from './regime.mjs';
import { runBench } from './core.mjs';
import { renderReceipt, writeReceipt } from './receipt.mjs';

const REPO_ROOT = path.resolve(BENCH_DIR, '..', '..');
const RESULTS_DIR = path.join(BENCH_DIR, 'results');
const HARNESS_VERSION = 'p1-skeleton.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'receipt' || key === 'keep') { out[key] = true; continue; }
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

async function waitForEmbeddings(platform, { beforeStats, timeoutMs = 8 * 60 * 1000, pollMs = 15000 }) {
  const t0 = Date.now();
  let last = beforeStats;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(pollMs);
    const s = await platform.stats();
    last = s;
    if (s.embedding_coverage >= 99.9) {
      return { waited_ms: Date.now() - t0, coverage_after: s.embedding_coverage, settled: true };
    }
  }
  return {
    waited_ms: Date.now() - t0,
    coverage_after: last.embedding_coverage,
    settled: false,
    note: 'embedding coverage did not return to ~100% before the wait timeout — searches may have run keyword-fallback; per-query modes are recorded in the rows',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

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

  // ---------------- fresh run --------------------------------------------------
  const splitName = args.split ?? 'longmemeval';
  const arms = resolveArms(String(args.arms ?? 'none,mycelium').split(',').map((s) => s.trim()).filter(Boolean));
  const n = parseInt(args.n ?? '50', 10);
  const budget = parseInt(args.budget ?? '5', 10);

  const split = await loadSplit(splitName);
  const items = selectItems(split.items, n);
  if (items.length < n) throw new Error(`split ${splitName} has only ${split.items.length} items; requested n=${n}`);

  const runId = `${utcStamp(new Date()).slice(0, 10)}-p1-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;

  // Platform (required when the mycelium arm is in play; address never hardcoded)
  let platformEnv = null;
  try { platformEnv = resolvePlatformEnv(); } catch { /* no substrate — only fine if no mycelium arm */ }
  let platform = null;
  let platformFacts = { url_host: null, version: null, embedding_provider: null, embedding_model: null, chunk_size: null };
  let statsBefore = null;
  if (arms.includes('mycelium')) {
    if (!platformEnv) throw new Error('mycelium arm requested but no platform address resolved (MYCELIUM_URL / substrate.conf)');
    const adminKey = await resolveAdminKey({ keychainService: platformEnv.keychainService });
    if (!adminKey) throw new Error('No admin key: set MYCELIUM_ADMIN_KEY or install the keychain service named in substrate.conf');
    platform = createPlatform({ baseUrl: platformEnv.baseUrl, headers: { 'X-Admin-Key': adminKey, 'X-Acting-As': 'm5Max' } });
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

  // Models (local; $0)
  const answerUrl = args['answer-url'] ?? (platformEnv?.box3090Url ? `${platformEnv.box3090Url}/v1` : null);
  const answerModel = args['answer-model'] ?? 'qwen3.8:27b';
  if (!answerUrl) throw new Error('No answer endpoint: pass --answer-url or set BOX_3090_URL (substrate.conf)');
  const judgeUrl = args['judge-url'] ?? 'http://localhost:8780/v1';
  const judgeModel = args['judge-model'] ?? 'Laguna-XS-2.1-mlx-oq4e-agentic-ours';

  // 1024: thinking models (qwen3.8 on llama.cpp) spend max_tokens on
  // reasoning_content before the answer; 256 left nothing for the answer.
  const ANSWER_MAX_TOKENS = 1024;
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
    judge: { model: judgeModel, url_host: new URL(judgeUrl).host },
    retrieval: {
      budget,
      chunking: 'one memory row per haystack session (server-side chunk-aware split for oversized rows)',
      source_type: 'bench_longmemeval',
      namespace: `bench-p1-${runId}`,
      server_mode: 'hybrid (server-side; per-query observed mode recorded in rows)',
    },
    platform: platformFacts,
    n: items.length,
    notes: [
      'two arms only: none (no memory) and mycelium (platform memory API); competitor arms are task 165+',
      'judge is a local model; validated against a hand-scored set — see receipt judge-validation section',
    ],
  });

  const namespace = regime.retrieval.namespace;
  const outDir = path.join(RESULTS_DIR, runId);
  fs.mkdirSync(outDir, { recursive: true });

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
      factory: (ctx) => ARM_FACTORIES[name](ctx),
    })),
    armContext: {
      answerChat,
      platform,
      runId,
      namespace,
      sourceType: regime.retrieval.source_type,
      budget,
    },
    judgeFn,
    afterWrite: async ({ arm, writeInfo }) => {
      writeInfoByArm[arm] = writeInfo;
      if (arm === 'mycelium' && platform) {
        const expected = writeInfo.rows;
        // the Jetson's ollama embedder is sequential (~0.3-0.5s/row): scale the
        // wait with the write size instead of failing into keyword-fallback
        const timeoutMs = Math.max(8 * 60 * 1000, expected * 500);
        console.error(`[run] ${arm}: wrote ${writeInfo.docs} docs / ${expected} rows; waiting for embedding coverage (cap ${Math.round(timeoutMs / 60000)} min)...`);
        const wait = await waitForEmbeddings(platform, { beforeStats: statsBefore, timeoutMs });
        console.error(`[run] embedding wait: ${JSON.stringify(wait)}`);
        writeInfoByArm[arm].embed_wait = wait;
      }
    },
    onRow: (row) => fs.writeSync(rowFiles[row.arm], JSON.stringify(row) + '\n'),
    onJudged: (row) => fs.writeSync(judgedFile, JSON.stringify(row) + '\n'),
  });
  for (const a of arms) fs.closeSync(rowFiles[a]);
  fs.closeSync(judgedFile);

  // cleanup: remove this run's rows from the platform (unless --keep)
  let cleanup = null;
  if (platform) {
    const sourceType = regime.retrieval.source_type;
    if (args.keep) {
      cleanup = { deleted: 0, kept: true, namespace };
    } else {
      const listed = await platform.listByType(sourceType, { namespace, limit: 10000 });
      const ids = [...new Set((listed.results ?? []).map((r) => r.source_id))];
      let deleted = 0;
      const failed = [];
      for (const id of ids) {
        try { await platform.deleteIndex(sourceType, id); deleted++; } catch (e) { failed.push({ id, error: e.message.slice(0, 120) }); }
      }
      const after = await platform.listByType(sourceType, { namespace, limit: 10000 });
      cleanup = {
        namespace,
        source_type: sourceType,
        rows_found: ids.length,
        deleted,
        failed_deletes: failed,
        rows_remaining_after: (after.results ?? []).length,
        kept: false,
      };
      console.error(`[run] cleanup: ${deleted}/${ids.length} deleted, ${cleanup.rows_remaining_after} remaining`);
    }
  }

  const summary = {
    ...result.summary,
    write_info: writeInfoByArm,
    cleanup,
    commands: [
      `node bench/memory/run.mjs --split ${splitName} --arms ${arms.join(',')} --n ${n} --receipt${args.keep ? ' --keep' : ''}`,
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
}

main().catch((e) => {
  console.error('[run] FAILED:', e.message);
  process.exit(1);
});

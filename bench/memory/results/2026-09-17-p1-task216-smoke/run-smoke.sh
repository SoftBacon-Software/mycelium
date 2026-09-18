#!/bin/bash
# task 216 flag-path CLEANUP smoke — the driver.
#
# Boots per leg (all loopback, all throwaway, fresh scratch DATA_DIR each so
# route_usage counters are per-leg truths):
#   fake embedder :3996  (ollama shape, constant 2-dim vector)
#   fake chat      :3995 (scripted extraction/decision/judge/answer — fake-chat.mjs;
#                         leg 3 adds --fail-answer-after 0 = a scripted MID-WRITE DEATH)
#   THIS worktree's mycelium server :3994 (scratch DATA_DIR — the routes under test
#                         are the worktree's own code)
# then runs the timeline arm through the real run.mjs CLI three times:
#   leg 1: default path  (facts_layer = memory-rows) → cleanup must fire the facts
#          route ZERO times, summary.cleanup carries NO facts_cleanup key
#   leg 2: MYCELIUM_TIMELINE_FACTS=am_facts → cleanup receipt: facts_deleted ==
#          rows written (adds+supersedes from rows.jsonl), verify reads BOTH 0,
#          regime.facts_routes.facts_cleanup stamped measured
#   leg 3: flag path + scripted mid-write death → nonzero exit, the finally-path
#          purge still drains rows AND index ("cleanup after failure" in stderr,
#          am_facts row count 0 after, facts DELETE route count 1)
#
# Run dirs resolve by MTIME (the CLI stamps run ids in UTC — 21:0x CDT lands on
# 2026-09-18-*), never by a date-prefix guess; each leg's checks hit the dir the
# leg itself created, and the API corroboration runs BEFORE the leg's server is
# stopped.
#
# Model legs are SCRIPTED (a lane never holds a model seat; --no-slot-lock —
# the 3090 is never touched). Everything else is the real harness: real server,
# real arm, real routes, real cleanup inside the real run.mjs CLI.
set -u
WT=/private/tmp/myc-amfacts-purge
SMOKE="$WT/bench/memory/results/2026-09-17-p1-task216-smoke"
SCRATCH=/tmp/myc-amfacts-smoke-216
PORT=3994; CHAT_PORT=3995; EMBED_PORT=3996
KEY=smoke-local-admin
BASE="http://127.0.0.1:$PORT"

rm -rf "$SCRATCH"
cd "$WT" || exit 1

boot() { # boot <leg> [extra fake-chat args]
  local leg="$1"
  mkdir -p "$SCRATCH/$leg/data"
  node "$SMOKE/fake-embedder.mjs" --port "$EMBED_PORT" > "$SCRATCH/$leg/embedder.log" 2>&1 & EPID=$!
  node "$SMOKE/fake-chat.mjs" --port "$CHAT_PORT" --log "$SCRATCH/$leg/fake-chat-requests.ndjson" ${2:-} > "$SCRATCH/$leg/chat.log" 2>&1 & CPID=$!
  DATA_DIR="$SCRATCH/$leg/data" PORT="$PORT" ADMIN_KEY="$KEY" JWT_SECRET=smoke-jwt-secret \
    node server/index.js > "$SCRATCH/$leg/server.log" 2>&1 & SPID=$!
  for i in $(seq 1 120); do curl -sf "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -sS --max-time 5 -X PUT "$BASE/api/mycelium/memory/config" -H "X-Admin-Key: $KEY" -H 'Content-Type: application/json' \
    -d "{\"embedding_provider\":\"ollama\",\"embedding_model\":\"fake-embed\",\"embedding_url\":\"http://127.0.0.1:$EMBED_PORT\",\"embedding_dimensions\":2}" \
    > "$SCRATCH/$leg/memory-config.json" 2>&1
}

killall_fakes() {
  kill $SPID $EPID $CPID 2>/dev/null
  wait $SPID $EPID $CPID 2>/dev/null
}
trap killall_fakes EXIT

RUNFLAGS="--split longmemeval --arms mycelium-timeline --n 1 --max-sessions 5 --receipt --budget 5 \
 --answer-url http://127.0.0.1:$CHAT_PORT/v1 --answer-model scripted-smoke \
 --judge-url http://127.0.0.1:$CHAT_PORT/v1 --judge-model scripted-smoke \
 --no-slot-lock"

newest_run_dir() { ls -td "$WT"/bench/memory/results/*/ 2>/dev/null | head -1; }

fact_counters() { # fact_counters <runDir> — adds+supersedes from the answer rows
  node -e "
const fs=require('fs');
const rows=fs.readFileSync('$1/mycelium-timeline.rows.jsonl','utf8').trim().split('\n').map(JSON.parse);
const w=rows.map(r=>r.meta?.write_decisions).filter(Boolean);
const sums=w.reduce((a,d)=>({adds:a.adds+(d.adds??0),supersedes:a.supersedes+(d.supersedes??0),keeps:a.keeps+(d.keeps??0),calls:a.calls+(d.decision_calls??0)}),{adds:0,supersedes:0,keeps:0,calls:0});
console.log(JSON.stringify({rows:rows.length,...sums,written:sums.adds+sums.supersedes}));
" 2>/dev/null || echo '{}'
}

route_facts_deletes_total() { # every DELETE facts counter, verbatim
  sqlite3 "$SCRATCH/$1/data/mycelium.db" "SELECT printf('%s=%s', method||' '||route_pattern, count) FROM route_usage WHERE method='DELETE' AND route_pattern LIKE '%facts%';" 2>/dev/null
}

echo "=== LEG 1: default path (memory-rows) — the facts route must stay untouched ==="
boot leg1
env -u MYCELIUM_TIMELINE_FACTS MYCELIUM_URL="$BASE" MYCELIUM_ADMIN_KEY="$KEY" \
  node bench/memory/run.mjs $RUNFLAGS > "$SCRATCH/leg1/run.out" 2>&1
echo "LEG1_EXIT=$?"
LEG1_DIR=$(newest_run_dir); LEG1_DIR="${LEG1_DIR%/}"; echo "LEG1_DIR=$LEG1_DIR"
BASE_NS_L1=$(node -e "console.log(require('$LEG1_DIR/summary.json').regime?.retrieval?.namespace ?? '')" 2>/dev/null)
echo "LEG1_BASE_NS=$BASE_NS_L1"
# API corroboration while the server is still up: NO facts call may have touched it
curl -sS --max-time 5 "$BASE/api/mycelium/auto-memory/facts?namespace=$BASE_NS_L1-amfacts&limit=100" -H "X-Admin-Key: $KEY" -H 'X-Acting-As: m5Max' > "$SCRATCH/leg1/facts-in-amfacts-ns.json"
node -e "
const s=require('$LEG1_DIR/summary.json');
const c=s.cleanup??{};
console.log('LEG1_cleanup_has_facts_cleanup:', 'facts_cleanup' in c);
console.log('LEG1_cleanup:', JSON.stringify({deleted:c.deleted, kept:c.kept, namespace:c.namespace, rows_remaining_after:c.rows_remaining_after}));
console.log('LEG1_regime_facts_routes_present:', Boolean(s.regime?.mycelium_timeline?.facts_routes));
console.log('LEG1_facts_layer:', s.regime?.mycelium_timeline?.facts_layer);
const f=require('$SCRATCH/leg1/facts-in-amfacts-ns.json');
const items=Array.isArray(f)?f:(f.items??f.facts??[]);
console.log('LEG1_api_facts_list_len (never-written ns):', items.length);
" 2>&1
echo "LEG1_DELETE_route_counters: [$(route_facts_deletes_total leg1 | tr '\n' ' ')]"
echo "LEG1_cleanup_stderr_lines:"; grep -a "\[run\] cleanup" "$SCRATCH/leg1/run.out" | sed 's/^/  /'
killall_fakes

echo "=== LEG 2: THE FLAG PATH (am_facts) — purge rows, then index, verify both zero ==="
boot leg2
env MYCELIUM_TIMELINE_FACTS=am_facts MYCELIUM_URL="$BASE" MYCELIUM_ADMIN_KEY="$KEY" \
  node bench/memory/run.mjs $RUNFLAGS > "$SCRATCH/leg2/run.out" 2>&1
echo "LEG2_EXIT=$?"
LEG2_DIR=$(newest_run_dir); LEG2_DIR="${LEG2_DIR%/}"; echo "LEG2_DIR=$LEG2_DIR"
BASE_NS_L2=$(node -e "console.log(require('$LEG2_DIR/summary.json').regime?.retrieval?.namespace ?? '')" 2>/dev/null)
echo "LEG2_BASE_NS=$BASE_NS_L2"
echo "LEG2_written: $(fact_counters "$LEG2_DIR")"
# API corroboration while the server is still up: BOTH verify reads, replayed
curl -sS --max-time 5 "$BASE/api/mycelium/auto-memory/facts?namespace=$BASE_NS_L2-amfacts&limit=100" -H "X-Admin-Key: $KEY" -H 'X-Acting-As: m5Max' > "$SCRATCH/leg2/facts-after-purge.json"
curl -sS --max-time 10 "$BASE/api/mycelium/memory/search" -H "X-Admin-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"query\":\"manager named Alex\",\"namespace\":\"$BASE_NS_L2-amfacts\",\"source_types\":[\"am_fact\"],\"limit\":10}" > "$SCRATCH/leg2/search-after-purge.json"
node -e "
const s=require('$LEG2_DIR/summary.json');
const c=s.cleanup??{};
console.log('LEG2_cleanup_facts_cleanup:', JSON.stringify(c.facts_cleanup??null));
console.log('LEG2_regime_stamp:', JSON.stringify(s.regime?.mycelium_timeline?.facts_routes?.facts_cleanup??null));
const f=require('$SCRATCH/leg2/facts-after-purge.json');
const items=Array.isArray(f)?f:(f.items??f.facts??[]);
const sr=require('$SCRATCH/leg2/search-after-purge.json');
console.log('LEG2_api_verify: facts_list_len', items.length, '| search_hits', (sr.results??[]).length, '| search_mode', sr.mode);
" 2>&1
echo "LEG2_DELETE_route_counters: [$(route_facts_deletes_total leg2 | tr '\n' ' ')]"
echo "LEG2_amfacts_row_count_after: $(sqlite3 "$SCRATCH/leg2/data/mycelium.db" "SELECT COUNT(*) FROM am_facts WHERE namespace='$BASE_NS_L2-amfacts';")"
echo "LEG2_superseded_row_count_after: $(sqlite3 "$SCRATCH/leg2/data/mycelium.db" "SELECT COUNT(*) FROM am_facts WHERE namespace='$BASE_NS_L2-amfacts' AND superseded_by IS NOT NULL;")"
echo "LEG2_cleanup_stderr_lines:"; grep -a "\[run\] cleanup" "$SCRATCH/leg2/run.out" | sed 's/^/  /'
killall_fakes

echo "=== LEG 3: failure path — scripted mid-write death, the finally purge must still drain ==="
boot leg3 "--fail-answer-after 0"
env MYCELIUM_TIMELINE_FACTS=am_facts MYCELIUM_URL="$BASE" MYCELIUM_ADMIN_KEY="$KEY" \
  node bench/memory/run.mjs $RUNFLAGS > "$SCRATCH/leg3/run.out" 2>&1
echo "LEG3_EXIT=$?"
LEG3_DIR=$(newest_run_dir); LEG3_DIR="${LEG3_DIR%/}"; echo "LEG3_DIR=$LEG3_DIR"
node -e "
try { require('$LEG3_DIR/summary.json'); console.log('LEG3_summary_present: true (unexpected for a mid-write death)'); }
catch { console.log('LEG3_summary_present: false — the run died before summary.json'); }
" 2>&1
LEG3_AMF_NS=$(grep -ao 'bench-p1-[0-9TDP-]*-p1-[0-9]*-amfacts' "$SCRATCH/leg3/run.out" | head -1)
echo "LEG3_AMF_NS=$LEG3_AMF_NS"
echo "LEG3_cleanup_after_failure_lines:"; grep -a "cleanup after failure" "$SCRATCH/leg3/run.out" | sed 's/^/  /'
echo "LEG3_DELETE_route_counters: [$(route_facts_deletes_total leg3 | tr '\n' ' ')]"
echo "LEG3_amfacts_row_count_after: $(sqlite3 "$SCRATCH/leg3/data/mycelium.db" "SELECT COUNT(*) FROM am_facts WHERE namespace='$LEG3_AMF_NS';")"
echo "LEG3_amfact_index_rows_after: $(sqlite3 "$SCRATCH/leg3/data/mycelium.db" "SELECT COUNT(*) FROM sm_embeddings WHERE source_type='am_fact' AND namespace='$LEG3_AMF_NS';" 2>/dev/null)"
killall_fakes

echo "SMOKE_DRIVER_DONE"

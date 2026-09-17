#!/bin/bash
# task 210 flag-path arm-level smoke — the driver.
#
# Boots (all loopback, all throwaway):
#   fake embedder :3998   (ollama shape, constant 2-dim vector)
#   fake chat      :3997  (scripted extraction/decision/judge/answer — see fake-chat.mjs)
#   THIS worktree's mycelium server :3999 (scratch DATA_DIR — the routes under
#                          test are the worktree's own code, commit in README)
# then runs the timeline arm TWICE through the real run.mjs CLI:
#   run 1: default path            (regime facts_layer = memory-rows)
#   run 2: MYCELIUM_TIMELINE_FACTS=am_facts (the flag path — the deliverable)
# and finally dumps route_usage counters, isolation reads, and the per-id
# fact-row sweep (smoke scale only — task 211 is the bulk purge).
#
# Model legs are SCRIPTED (both real answerers lane-blocked tonight — README).
# Everything else is the real harness: real server, real arm, real routes.
set -u
WT=/private/tmp/myc-tl-merge
SMOKE="$WT/bench/memory/results/2026-09-17-p1-task210-smoke"
SCRATCH=/tmp/myc-tl-smoke-210
PORT=3999; EMBED_PORT=3998; CHAT_PORT=3997
KEY=smoke-local-admin
BASE="http://127.0.0.1:$PORT"

rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/data"
cd "$WT" || exit 1

node "$SMOKE/fake-embedder.mjs" --port "$EMBED_PORT" > "$SCRATCH/embedder.log" 2>&1 & EPID=$!
node "$SMOKE/fake-chat.mjs" --port "$CHAT_PORT" --log "$SCRATCH/fake-chat-requests.ndjson" > "$SCRATCH/chat.log" 2>&1 & CPID=$!
DATA_DIR="$SCRATCH/data" PORT="$PORT" ADMIN_KEY="$KEY" JWT_SECRET=smoke-jwt-secret \
  node server/index.js > "$SCRATCH/server.log" 2>&1 & SPID=$!
trap 'kill $SPID $EPID $CPID 2>/dev/null' EXIT

for i in $(seq 1 120); do curl -sf "$BASE/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sS --max-time 5 "$BASE/health" > "$SCRATCH/health.json" 2>&1
echo "SERVER_HEALTH: $(head -c 200 "$SCRATCH/health.json")"

# NOTE: the plugin API mounts at /api/mycelium/<routePrefix> — the bare
# /memory/config 404s (the first driver pass proved it: default config, dead
# embedder, coverage 0, both runs burned the full 8-min embed wait on
# keyword-only search). PUT + VERIFY through the real mount.
curl -sS --max-time 5 -X PUT "$BASE/api/mycelium/memory/config" -H "X-Admin-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"embedding_provider\":\"ollama\",\"embedding_model\":\"fake-embed\",\"embedding_url\":\"http://127.0.0.1:$EMBED_PORT\",\"embedding_dimensions\":2}" \
  > "$SCRATCH/memory-config.json" 2>&1
curl -sS --max-time 5 "$BASE/api/mycelium/memory/config" -H "X-Admin-Key: $KEY" > "$SCRATCH/memory-config-verify.json" 2>&1
echo "EMBED_CONFIG: $(head -c 160 "$SCRATCH/memory-config-verify.json")"

RUNFLAGS="--split longmemeval --arms mycelium-timeline --n 1 --max-sessions 5 --receipt --budget 5 \
 --answer-url http://127.0.0.1:$CHAT_PORT/v1 --answer-model scripted-smoke \
 --judge-url http://127.0.0.1:$CHAT_PORT/v1 --judge-model scripted-smoke \
 --no-slot-lock"

echo "=== RUN 1: default path (memory-rows) ==="
env -u MYCELIUM_TIMELINE_FACTS MYCELIUM_URL="$BASE" MYCELIUM_ADMIN_KEY="$KEY" \
  node bench/memory/run.mjs $RUNFLAGS > "$SCRATCH/run-default.out" 2>&1
echo "RUN1_EXIT=$?"
tail -3 "$SCRATCH/run-default.out"

echo "=== RUN 2: THE FLAG PATH (am_facts) ==="
env MYCELIUM_TIMELINE_FACTS=am_facts MYCELIUM_URL="$BASE" MYCELIUM_ADMIN_KEY="$KEY" \
  node bench/memory/run.mjs $RUNFLAGS > "$SCRATCH/run-flagpath.out" 2>&1
echo "RUN2_EXIT=$?"
tail -3 "$SCRATCH/run-flagpath.out"

echo "=== route_usage counters (both runs) ==="
sqlite3 "$SCRATCH/data/mycelium.db" \
  "SELECT printf('%-5s %-38s %d', method, route_pattern, count) FROM route_usage ORDER BY route_pattern, method;" \
  | tee "$SMOKE/route-usage-counters.txt"

echo "=== isolation + sweep (the flag run's namespace) ==="
RUN2_NS=$(grep -o '"namespace": *"[^"]*-amfacts"' "$SCRATCH/data/../run-flagpath.out" 2>/dev/null | head -1)
# the run's namespace comes from its summary; find the newest results dir's summary.json
FLAGRUN_DIR=$(ls -td "$WT"/bench/memory/results/2026-09-17-p1-* 2>/dev/null | head -1)
echo "FLAGRUN_DIR: $FLAGRUN_DIR"
echo "FLAGRUN_RECEIPT_STAMP: $(grep -m1 '"facts_layer"' "$WT/bench/memory/receipts/$(basename "$FLAGRUN_DIR").md" 2>/dev/null)"
echo "FLAGRUN_ROW_STAMP: $(node -e "const fs=require('fs'); const r=fs.readFileSync('$FLAGRUN_DIR/mycelium-timeline.rows.jsonl','utf8').trim().split('\n').map(JSON.parse); console.log(JSON.stringify({rows: r.length, facts_layer: r[0].meta.facts_layer, supersedes: r[0].meta.write_decisions?.supersedes, adds: r[0].meta.write_decisions?.adds}))" 2>/dev/null)"
# derive the -amfacts namespace from the arm shape: <base>-amfacts
BASE_NS=$(node -e "const s=require('$FLAGRUN_DIR/summary.json'); console.log(s.regime?.retrieval?.namespace ?? '')" 2>/dev/null)
echo "BASE_NS=$BASE_NS"
# X-Acting-As matters: /auto-memory/facts scopes by the CALLER's identity
# (agent_id) — the run created its rows as m5Max, so the reads below must
# present the same identity or the list is empty (first pass proved it).
curl -sS --max-time 5 "$BASE/api/mycelium/auto-memory/facts?namespace=$BASE_NS-amfacts&limit=100" -H "X-Admin-Key: $KEY" -H 'X-Acting-As: m5Max' > "$SCRATCH/facts-in-run-ns.json"
curl -sS --max-time 5 "$BASE/api/mycelium/auto-memory/facts?namespace=other-run-never-used-amfacts&limit=100" -H "X-Admin-Key: $KEY" -H 'X-Acting-As: m5Max' > "$SCRATCH/facts-other-ns.json"
node -e "
const a=require('$SCRATCH/facts-in-run-ns.json'), b=require('$SCRATCH/facts-other-ns.json');
const A=Array.isArray(a)?a:(a.items??a.facts??[]); const B=Array.isArray(b)?b:(b.items??b.facts??[]);
console.log('FACT_ROWS_CURRENT run-ns:', A.length, '| other-ns:', B.length);
"
# Per-id fact-ROW sweep (smoke scale only — task 211 is the bulk purge).
# Ids come from the scratch DB: the run's cleanup already drained the am_fact
# INDEX, and the /facts list view is current-only by design
# (listFacts: superseded_by IS NULL), so a list-driven sweep can neither see
# nor (FK) delete a supersede chain. Deletes run DESC — a row referenced by
# another row's superseded_by fails the FK constraint. The chain points
# FORWARD (each row's superseded_by names its replacement), so deletes must
# run ASC — oldest first — each delete freeing its successor. DESC deletes
# only the oldest row and 500s on the rest (previous pass proved it).
sqlite3 "$SCRATCH/data/mycelium.db" "SELECT id FROM am_facts WHERE namespace='$BASE_NS-amfacts' ORDER BY id ASC;" > "$SCRATCH/sweep-ids.txt"
node -e "
const fs=require('fs');
const ids=fs.readFileSync('$SCRATCH/sweep-ids.txt','utf8').trim().split('\n').filter(Boolean);
(async()=>{ let del=0, fail=[];
  for(const id of ids){
    const r=await fetch('$BASE/api/mycelium/auto-memory/facts/'+id+'?namespace=$BASE_NS-amfacts',{method:'DELETE',headers:{'X-Admin-Key':'$KEY','X-Acting-As':'m5Max'}});
    if(r.ok) del++; else fail.push({id, status:r.status});
  }
  const leftDb=fs.existsSync('$SCRATCH/data/mycelium.db') ? require('child_process').execSync(\"sqlite3 '$SCRATCH/data/mycelium.db' \\\"SELECT COUNT(*) FROM am_facts WHERE namespace='$BASE_NS-amfacts';\\\"\").toString().trim() : '0';
  fs.writeFileSync('$SCRATCH/fact-row-sweep.json', JSON.stringify({ids_found: ids.length, deleted: del, failed: fail, rows_remaining_after: Number(leftDb)}));
  console.log('SWEEP: found', ids.length, 'deleted', del, 'remaining', leftDb);
})();
"
echo "=== index-row purge verification (should be 0 hits in run namespaces) ==="
curl -sS --max-time 10 "$BASE/api/mycelium/memory/search" -H "X-Admin-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"query\":\"manager\",\"namespace\":\"$BASE_NS-amfacts\",\"source_types\":[\"am_fact\"],\"limit\":10}" | head -c 300; echo

kill $SPID $EPID $CPID 2>/dev/null
wait $SPID $EPID $CPID 2>/dev/null
echo "SMOKE_DRIVER_DONE"

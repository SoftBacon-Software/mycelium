#!/bin/bash
# task 210 flag-path smoke — the SUPERSEDE-RENDERING leg.
#
# The canonical run (run-smoke.sh, the brief's literal command, default
# budget 5) could not show a supersede line inside a hit: with 5 sessions the
# episodic layer fills every slot after the one current fact, and
# interleaveLayers gives superseded facts only what neither LIVE layer can
# use (arm_mycelium_timeline.mjs:164) — the tail needs budget >= 7 to appear
# (1 current + 5 episodes + 1 superseded). This leg runs the SAME flag path
# at --budget 8 purely to evidence the pre-committed "a supersede renders the
# dated line inside a hit". Budget is a comparability key: this run is NOT a
# grid number, and its receipt stamps the larger budget.
set -u
WT=/private/tmp/myc-tl-merge
SMOKE="$WT/bench/memory/results/2026-09-17-p1-task210-smoke"
SCRATCH=/tmp/myc-tl-smoke-210-b8
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
curl -sS --max-time 5 -X PUT "$BASE/api/mycelium/memory/config" -H "X-Admin-Key: $KEY" -H 'Content-Type: application/json' \
  -d "{\"embedding_provider\":\"ollama\",\"embedding_model\":\"fake-embed\",\"embedding_url\":\"http://127.0.0.1:$EMBED_PORT\",\"embedding_dimensions\":2}" > /dev/null
echo "CONFIGURED: $(curl -sS --max-time 5 "$BASE/api/mycelium/memory/config" -H "X-Admin-Key: $KEY" | head -c 120)"

env MYCELIUM_TIMELINE_FACTS=am_facts MYCELIUM_URL="$BASE" MYCELIUM_ADMIN_KEY="$KEY" \
  node bench/memory/run.mjs --split longmemeval --arms mycelium-timeline --n 1 --max-sessions 5 --receipt --budget 8 \
   --answer-url http://127.0.0.1:$CHAT_PORT/v1 --answer-model scripted-smoke \
   --judge-url http://127.0.0.1:$CHAT_PORT/v1 --judge-model scripted-smoke \
   --no-slot-lock > "$SCRATCH/run-flagpath-b8.out" 2>&1
echo "RUN_EXIT=$?"

FLAGRUN_DIR=$(ls -td "$WT"/bench/memory/results/2026-09-17-p1-* 2>/dev/null | head -1)
echo "RUN_DIR: $FLAGRUN_DIR"
node -e "
const fs=require('fs');
const rows=fs.readFileSync('$FLAGRUN_DIR/mycelium-timeline.rows.jsonl','utf8').trim().split('\n').map(JSON.parse);
const r=rows[0];
console.log('facts_layer:', r.meta.facts_layer, '| budget:', r.meta.budget, '| mode:', r.meta.retrieval_mode);
console.log('decisions:', JSON.stringify(r.meta.write_decisions));
const withLine=r.meta.read_hits.filter(h=>h.rendered_supersede_line);
console.log('read_hits:', r.meta.read_hits.length, '| hits carrying a supersede line:', withLine.length);
for(const h of withLine) console.log('  HIT rank', h.rank, h.layer, String(h.source_id).slice(-8), '→', JSON.stringify(h.rendered_supersede_line.slice(0,120)));
const s=JSON.parse(fs.readFileSync('$FLAGRUN_DIR/summary.json','utf8'));
console.log('cleanup:', JSON.stringify(s.cleanup.per_namespace.map(p=>({ns:p.namespace.slice(-9),t:p.source_type,d:p.deleted,left:p.rows_remaining_after}))));
"

BASE_NS=$(node -e "const s=require('$FLAGRUN_DIR/summary.json'); console.log(s.regime?.retrieval?.namespace ?? '')" 2>/dev/null)
sqlite3 "$SCRATCH/data/mycelium.db" "SELECT id FROM am_facts WHERE namespace='$BASE_NS-amfacts' ORDER BY id ASC;" > "$SCRATCH/sweep-ids.txt"
node -e "
const fs=require('fs');
const ids=fs.readFileSync('$SCRATCH/sweep-ids.txt','utf8').trim().split('\n').filter(Boolean);
(async()=>{ let del=0, fail=[];
  for(const id of ids){
    const r=await fetch('$BASE/api/mycelium/auto-memory/facts/'+id+'?namespace=$BASE_NS-amfacts',{method:'DELETE',headers:{'X-Admin-Key':'$KEY','X-Acting-As':'m5Max'}});
    if(r.ok) del++; else fail.push({id, status:r.status});
  }
  const leftDb=require('child_process').execSync(\"sqlite3 '$SCRATCH/data/mycelium.db' \\\"SELECT COUNT(*) FROM am_facts WHERE namespace='$BASE_NS-amfacts';\\\"\").toString().trim();
  fs.writeFileSync('$SCRATCH/fact-row-sweep.json', JSON.stringify({ids_found: ids.length, deleted: del, failed: fail, rows_remaining_after: Number(leftDb)}));
  console.log('SWEEP: found', ids.length, 'deleted', del, 'remaining', leftDb);
})();
"
echo "=== counters (this leg) ==="
sqlite3 "$SCRATCH/data/mycelium.db" \
  "SELECT printf('%-5s %-38s %d', method, route_pattern, count) FROM route_usage ORDER BY route_pattern, method;"
kill $SPID $EPID $CPID 2>/dev/null
wait $SPID $EPID $CPID 2>/dev/null
echo "B8_LEG_DONE"

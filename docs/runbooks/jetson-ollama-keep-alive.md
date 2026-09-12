# jetson01 ollama keep-alive (finite, not forever)

**Why.** The substrate host's ollama unit ran `OLLAMA_KEEP_ALIVE=-1`, so any
model it loaded stayed resident until the unit restarted. On 2026-09-11 that
meant the auto-memory extraction model (`nemotron-mini:latest`, 2,696 MB) sat
pinned for 1.5 days with no requests in the last 90 minutes, on a 7,619 MB
board that also runs the platform node (~1.4 GB under load) and the
semantic-memory embedder (308 MB): 948 MB available, 1,965 MB in swap, and
three platform event-loop wedges in 3.5 h (20:30, 20:50, 21:50 CDT). Unloading
it by hand took the box to 4,386 MB available / 555 MB swap.

**Two layers, both wanted.** The auto-memory plugin now sends an explicit
finite `keep_alive` on every extraction call (`AUTO_MEMORY_LLM_KEEP_ALIVE`,
default `10m` — see `server/plugins/auto-memory/README.md`), so the
extraction model evicts itself no matter what the unit default is. This
runbook is the second layer: a finite unit default so *no* model — a manual
load, a future caller — can pin the box.

**The edit (a drop-in, so it survives ollama package upgrades; run on the
box):**

```bash
sudo systemctl edit ollama.service
```

In the editor that opens, add:

```ini
[Service]
Environment=OLLAMA_KEEP_ALIVE=30m
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama.service
```

`30m` is finite on purpose: the embedder is hit constantly and its window
keeps refreshing, so it stays warm in practice — and a cold reload is only
~2 s if it ever does expire.

**Verify:**

```bash
# 1. the drop-in is live
systemctl show ollama.service -p Environment
#    → Environment=OLLAMA_KEEP_ALIVE=30m (and nothing pinned at -1)

# 2. models now carry an expiry instead of living forever
curl -s localhost:11434/api/ps
#    → each loaded model shows an "expires_at" ~30m out

# 3. the extraction model actually evicts: trigger one extraction, then
#    re-check within 10 m — nemotron-mini should drop off /api/ps
curl -s localhost:11434/api/ps

# 4. the platform is healthy and the embedder stayed warm
curl -s localhost:3002/health
```

**Rollback:** `sudo systemctl revert ollama.service && sudo systemctl
daemon-reload && sudo systemctl restart ollama.service` — back to the
vendored unit (which is the `-1` that caused the incident; don't stop there
unless a real reason exists).

Lanes never touch a live surface: this edit is executed by the director
alongside `scripts/deploy-jetson.sh`, not by the lane that authored it.

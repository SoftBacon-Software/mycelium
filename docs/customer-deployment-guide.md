# Customer Deployment Guide — Mycelium Instances

A new customer gets their **own Railway project** — fully isolated SQLite DB, credentials, and domain. This doc covers the deployment process, pitfalls, and the ongoing plan for customer onboarding.

## Architecture Decision

Each customer = one Railway project. No shared state. No shared DB.

- Customer's data never touches our Railway account long-term
- We test deployments in our account first, then hand off via Railway project transfer or customer creates their own Railway account

## Update Delivery Model — Release Branch Auto-Deploy

All customer instances deploy from the `stable` branch. Development happens on `master`.

### How It Works

1. **`master`** — active development, internal only
2. **`stable`** — customer-facing, Railway auto-deploys from this branch
3. We merge `master → stable` when ready to release using `scripts/release.sh`
4. Railway detects the push to `stable` and auto-deploys all connected instances

### Releasing Updates

```bash
./scripts/release.sh              # Auto-tag from date (v2026.03.04)
./scripts/release.sh v1.2.0       # Explicit tag
./scripts/release.sh --dry-run    # Preview without changing anything
```

### Rollback

**Option A** — Revert the merge:
```bash
git checkout stable && git revert HEAD && git push origin stable
```

**Option B** — Railway dashboard → Deployments → Redeploy previous build

### Breaking Migrations

Never bundle schema changes + feature code in the same release:

1. Merge migration-only commit to `stable` first
2. Wait for all instances to run migration (monitor Railway logs)
3. Then merge the feature code to `stable`

## Quick Start for a New Customer Instance

### 1. Create Railway Project

```bash
# In the mycelium dir, create a new project
cd D:/mycelium
railway init  # creates new project in their Railway account
              # OR use our account for testing, then transfer
```

Or via Railway dashboard: New Project → Empty Project → name it `<customer>-mycelium`.

### 2. Generate Credentials

```bash
# JWT secret (32 bytes hex)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Admin key (24 bytes hex)
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 3. Set Environment Variables

**CRITICAL: Use `MSYS_NO_PATHCONV=1` on Windows to prevent path mangling**

```bash
MSYS_NO_PATHCONV=1 railway variable set JWT_SECRET="<generated-above>" --service <service-name>
MSYS_NO_PATHCONV=1 railway variable set ADMIN_KEY="<generated-above>" --service <service-name>
MSYS_NO_PATHCONV=1 railway variable set NODE_ENV="production" --service <service-name>
```

**DO NOT set `DATA_DIR` unless a Railway volume is attached.**
- Without a volume: omit DATA_DIR entirely — defaults to `server/data/` inside container (writable)
- With a volume mounted at `/data`: set `DATA_DIR=/data`

Setting `DATA_DIR=/data` without a volume = **immediate crash on startup** (EACCES — node:20-slim runs as non-root user `node`, can't create `/data`)

### 4. Deploy

Customer instances should track the `stable` branch for automatic updates.

**Via Railway GitHub integration (preferred):**
1. In Railway dashboard: service → Settings → Source
2. Connect to the `SoftBacon-Software/mycelium` repo
3. Set deploy branch to `stable`
4. Railway auto-deploys on every push to `stable`

**Manual deploy (one-off):**
```bash
cd /path/to/mycelium
git checkout stable
MSYS_NO_PATHCONV=1 railway up --service <service-name> --detach
```

Watch build logs via Railway dashboard or `railway service logs --service <service-name>`.

### 5. Verify Health

```bash
curl https://<customer>-mycelium-production.up.railway.app/health
# Expected: {"status":"ok","uptime_seconds":X,"db_ok":true,...}
```

### 6. Create Customer Admin Account

```bash
# POST to create their first dashboard user
curl -X POST https://<customer>-mycelium-production.up.railway.app/api/mycelium/admin/studio-users \
  -H "X-Admin-Key: <their-admin-key>" \
  -H "Content-Type: application/json" \
  -d '{"username":"<their-username>","password":"<temp-password>","display_name":"<their-name>","role":"admin"}'
```

### 7. Custom Domain (optional)

To set up `<customer>.mycelium.fyi`:
1. Add CNAME in Cloudflare DNS: `<customer>.mycelium.fyi` → `<customer>-mycelium-production.up.railway.app`
2. In Railway dashboard: service → Settings → Domains → Add Custom Domain → `<customer>.mycelium.fyi`
3. Railway auto-provisions SSL

## Pitfalls Learned

| Problem | Cause | Fix |
|---------|-------|-----|
| Health check fails, zero runtime logs | `DATA_DIR=/data` set but no Railway volume attached. `node:20-slim` runs as non-root, can't create `/data`. | Remove `DATA_DIR` unless volume is attached. |
| Build fails (duplicate imports) | Merge conflicts left duplicate TS imports. | Run `npm run build` locally before deploying. |
| `DATA_DIR` path mangling on Windows | MSYS converts `/data` to `C:/Program Files/Git/data`. | Always prefix Railway variable commands with `MSYS_NO_PATHCONV=1`. |
| "Multiple services found" on `railway up` | Local Railway config has `service: null`. | Always specify `--service <name>`. |
| "Application not found" 404 from domain | No successful deployment yet — no healthy instance to serve. Normal until first healthy deploy. | Just wait for first healthy deploy. |
| Railway deploy fails (source not found) | GitHub outage. Railway pulls from GitHub. | Check https://www.githubstatus.com, wait for resolution. |

## Long-Term: Customer Owns Their Railway Account

Preferred path for production customers:
1. Customer creates Railway account
2. They fork or download the Mycelium source
3. We send them the deploy guide + MCP config
4. They own their infra, we own the code (licensing applies)

For beta customers (like Kurtis): we can transfer the Railway project to his account once onboarding is complete.

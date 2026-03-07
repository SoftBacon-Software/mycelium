# Fly.io Migration Design — Mycelium

**Date**: 2026-03-06
**Status**: Planned (not yet started)
**Motivation**: Railway CLI deploys are unreliable. Fly.io has native SQLite volume support, stable CLI, and good pricing.

## Current State (Railway)

- **Service**: patient-rebirth on Railway
- **Container**: Node.js 20, Dockerfile build
- **Storage**: Railway volume at `/data` (SQLite DB + uploads)
- **Domain**: mycelium.fyi (DNS → Railway)
- **Env vars**: JWT_SECRET, ADMIN_KEY, DATA_DIR=/data, PORT (set by Railway)
- **WebSocket**: /voice endpoint for voice chat

## Migration Steps

### 1. Install Fly CLI + Create App
```bash
# Install flyctl (Windows)
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"

# Auth
fly auth login

# Create app
fly apps create mycelium-fyi --org personal
```

### 2. Create fly.toml
```toml
app = "mycelium-fyi"
primary_region = "dfw"  # Dallas (closest to user)

[build]
  dockerfile = "Dockerfile"

[env]
  DATA_DIR = "/data"
  NODE_ENV = "production"

[http_service]
  internal_port = 3002
  force_https = true
  auto_stop_machines = false  # Always on (agents need it 24/7)
  auto_start_machines = true
  min_machines_running = 1

[mounts]
  source = "mycelium_data"
  destination = "/data"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

### 3. Create Volume
```bash
fly volumes create mycelium_data --region dfw --size 1  # 1GB
```

### 4. Set Secrets
```bash
fly secrets set JWT_SECRET="..." ADMIN_KEY="KPeO7ZspKsAQotZsrvnZ2vYk"
```

### 5. Migrate Database
```bash
# Download from Railway
railway run cat /data/mycelium.db > mycelium.db

# Upload to Fly volume
fly ssh console -C "mkdir -p /data"
fly ssh sftp shell
put mycelium.db /data/mycelium.db
```

### 6. Deploy
```bash
fly deploy
```

### 7. Point DNS
Update mycelium.fyi DNS:
- Remove Railway CNAME
- Add Fly.io CNAME: `mycelium-fyi.fly.dev`
- Or use Fly's dedicated IPv4: `fly ips allocate-v4`

### 8. Verify
- Check https://mycelium.fyi/api/mycelium/health
- Verify dashboard loads at /studio/
- Test WebSocket voice chat
- Confirm all agents can connect

## Dockerfile Changes

The existing Dockerfile should work as-is. Only change: remove `USER node` if Fly's runner needs root for volume mounts (test first).

## Cost Estimate

- shared-cpu-1x, 512MB: ~$3.19/mo
- 1GB volume: ~$0.15/mo
- Dedicated IPv4 (optional): $2/mo
- **Total: ~$5-6/mo** (similar to Railway)

## Rollback Plan

Keep Railway service alive but stopped. If Fly has issues, re-point DNS back to Railway and restart the service.

## Key Differences from Railway

| Feature | Railway | Fly.io |
|---------|---------|--------|
| Deploy | `railway up` (uploads code) | `fly deploy` (builds remotely from Dockerfile) |
| Volumes | Attached per service | Attached per machine, region-specific |
| WebSockets | Works | Works (via Fly Proxy) |
| Scaling | Auto ($$) | Manual machines, predictable cost |
| Logs | `railway logs` | `fly logs` |
| SSH | Not available | `fly ssh console` |
| DB access | Via `railway connect` plugin | Via `fly ssh` directly |

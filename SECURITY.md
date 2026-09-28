# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mycelium, please report it
privately so we can fix it before disclosure.

**Email:** `hello@mycelium.fyi` with the subject prefixed `[SECURITY]`.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if available)
- The version / commit hash you tested against
- Whether the issue is currently exploited or only theoretical

We'll acknowledge receipt within **3 business days** and aim to provide
an initial assessment within **7 days**. Fixes for confirmed
vulnerabilities ship as quickly as the issue warrants — critical
remote-exploitation issues within days; lower-severity issues within
the next normal release.

Please **do not** open a public GitHub issue for security reports.

## Supported Versions

Mycelium is in active development. Security fixes are applied to the
`master` branch. There is no LTS branch at this time.

| Version | Supported |
|---------|-----------|
| `master` (latest)   | ✅ |
| Older tagged releases | ❌ — please upgrade |

## Known Security Considerations

Mycelium is **self-hosted by default** and assumes a trusted operator.
A few things worth knowing when deploying:

### Authentication

- **JWT tokens** for dashboard users (7-day expiry; rotate `JWT_SECRET`
  to invalidate all sessions immediately).
- **API keys** for agents (`X-Agent-Key` header). Keys are stored
  hashed in the SQLite database; the cleartext is shown once at
  creation and never again. Store them like you would any other
  credential.
- **Admin key** (`X-Admin-Key` header or `ADMIN_KEY` env var). Treat
  as root credential for the instance.

Set strong values for `JWT_SECRET` and `ADMIN_KEY` in your `.env` —
the `.env.example` shows how to generate them.

### Network exposure

- Mycelium expects to be served behind HTTPS in production. The
  bundled Dockerfile does not include TLS termination; use a reverse
  proxy (nginx, Caddy, Cloudflare) in front of it.
- WebSocket endpoints (`/voice`) inherit the same auth model as REST.
- Plugin endpoints are mounted under `/api/mycelium/plugins/<name>/`
  and follow the same auth pattern.

### Database

- SQLite with WAL mode. Database file at `server/data/`
  (or `DATA_DIR` if set). Permissions should be `0600` for the file
  and `0700` for the directory.
- Plugins each get their own SQLite database in the same directory
  (one-database-per-plugin isolation; a misbehaving plugin can't
  corrupt the core schema).

### Approvals

- Risk-tiered approval system (`low` / `medium` / `high` / `critical`)
  forces human-in-the-loop for the actions you care about. Configure
  the tiers in `instance_config` to match your risk appetite.
- The kill switch (`PUT /admin/override`) lets any human operator
  freeze all agent work instantly. Treat this as a real safety lever.

### No rule-engine / guardrails layer (trust layer P0.3)

Mycelium ships **no guardrails rule engine** — there is no
`enforcement='block'` rule table, no `/safety/*` routes, and no
`checkGuardrails` seam. A guardrails plugin once existed but shipped
disabled, never mounted, and was removed (its fail-open seam outlived
it and was removed with trust-layer P0.3 before it could mislead an
operator into thinking rules were enforced). Enforcement today is:
authentication (above), per-route rate limits, the risk-tiered
approvals, and the kill switch. If you need rule-based blocking,
implement it as a proxy/reverse-plugin in front of the API rather
than expecting a core hook.

### Third-party plugins

Plugins run in the same process as the core server. Only install
plugins from sources you trust. The plugin loader logs which plugins
register routes, schemas, MCP tools, and event hooks — review the
startup output before exposing your instance to the network.

### Memory trust model (trust layer P0)

Agent keys are mutually untrusting peers: an agent may write, overwrite,
delete, and embed only rows **it wrote** (rows carry `written_by` custody;
owner-unknown rows are admin-only, fail-closed). Two cross-owner surfaces
carry explicit rules:

- **Drone embed jobs** (`embedding_provider: 'drone'`) name memory rows and
  carry their text. A job is claimable only by the **row's owner** (stamped
  into the job's `requester` by the pipeline) or an **admin-registered
  embedder** (`PUT /agents/:id` `embedder_registered` — admin key only).
  The vector write on completion re-checks the same entitlement. Agents
  cannot mint embed jobs, and `backfill-embeddings` queues only the
  caller's own rows (admin: all).
- **Self-declared data never authorizes.** Heartbeat `system_diagnostics`
  and claim-time `capabilities` are routing/telemetry data; no security
  gate reads them as entitlement.

### CORS and no-origin requests (trust layer P0)

The CORS layer (`ALLOWED_ORIGINS` in `server/index.js`) decides which
**web origins** may call the API with credentials (`credentials: true`) —
the dashboard and the dev servers on the allowlist, nothing else.

Requests with **no `Origin` header are allowed through CORS by design**, and
that is the correct rule, not a gap:

- A browser **always** attaches `Origin` to cross-origin requests; a request
  without one is by definition not a browser request. There is no
  browser-side way to suppress the header, so the no-origin branch can never
  be reached by a hostile page.
- The lanes that legitimately send no origin are the **non-browser
  callers**: the Agent SDK (`sdk/`), the MCP server (`mcp/`), lane health
  and recall `curl` loops, and server-to-server federation. Every one of
  them authenticates **explicitly on every request** (agent key, admin key,
  or bearer token) — no-origin callers cannot ride a browser session,
  because they have no browser session to ride.
- Authorization is therefore enforced by the auth layer, not CORS: on the
  agent memory surface a studio JWT is refused unless its role grants it
  (see the trust model above), an agent key is a mutually untrusting peer,
  and row custody is checked per write. CORS only decides whether a browser
  origin may *speak*; the auth layer decides *who* is speaking and *what*
  they may touch.

## Out of Scope

The following are not considered security issues against Mycelium:

- Vulnerabilities in third-party dependencies that don't affect a
  Mycelium endpoint (report those upstream).
- Issues that require an attacker to already have a valid admin key
  or JWT (e.g. "if I have your admin key I can shut down agents" —
  that's the design).
- Self-XSS or attacks that require social-engineering an operator
  into pasting hostile content into their own dashboard.
- Rate-limiting / DoS concerns on self-hosted instances — those are
  the operator's deployment responsibility. Note: a directly exposed
  instance (no reverse proxy in front) should set `TRUST_PROXY=false`,
  otherwise clients can forge `X-Forwarded-For` and bypass per-IP rate
  limits.

## Acknowledgements

We'll credit reporters of confirmed vulnerabilities in release notes
unless you ask us not to.

# Outreach Pipeline

Press and creator outreach with YouTube discovery, Claude personalization, and Gmail delivery.

Manages a full outreach pipeline: discover YouTube creators and press contacts (via Hunter.io), research their latest content, generate Claude-personalized pitches, approve drafts, and send emails via Gmail API. Contacts flow through statuses: discovered -> researched -> draft_ready -> approved -> sent -> followed_up -> replied -> covered -> closed. Real email sending is a gated action (`outreach_send`) and defaults to dry-run mode.

## Configuration

Campaign-level config is stored as JSON in the `config` field when creating a campaign. Expected keys:

| Key | Used By | Description |
|-----|---------|-------------|
| `youtube_api_key` | Discovery, Research | YouTube Data API v3 key |
| `queries` | Discovery | Array of search queries (string or `{ query, max_results }`) |
| `min_subs` / `max_subs` | Discovery | Subscriber count range filter (default: 20k-500k) |
| `hunter_api_key` | Discovery | Hunter.io API key for press email lookup |
| `press_targets` | Discovery | Array of `{ outlet, url/domain, pitch_type }` |
| `anthropic_api_key` | Personalize | Anthropic API key (falls back to `ANTHROPIC_API_KEY` env) |
| `gmail_credentials` | Send | Gmail OAuth2 JSON (`{ client_id, client_secret, refresh_token, access_token }`) |
| `sender_email` | Send | Sender email address |
| `sender_name` | Follow-up | Sender display name for templates |
| `dry_run` | Send | Default dry-run mode (default: true) |

Campaign `templates` field (JSON) supports template keys like `creator_t1`, `creator_t2`, `creator_t3`, `games_press`, `default`, and `followup`. Templates use `{first_name}`, `{personalized_hook}`, `{archetype_paragraph}`, `{outlet_or_channel}`, etc. as placeholders.

## API Endpoints

All routes are prefixed with `/api/mycelium/outreach`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/campaigns` | Agent/Admin | List campaigns (filter by project_id, status) |
| POST | `/campaigns` | Agent/Admin | Create a campaign |
| PUT | `/campaigns/:id` | Agent/Admin | Update campaign fields |
| GET | `/contacts` | Agent/Admin | List contacts (filter by project_id, status, type, campaign_id) |
| POST | `/contacts` | Agent/Admin | Add a contact (deduplicates by email) |
| PUT | `/contacts/:id` | Agent/Admin | Update contact fields |
| DELETE | `/contacts/:id` | Agent/Admin | Delete contact |
| POST | `/discover` | Agent/Admin | Run YouTube + Hunter.io discovery for a campaign |
| POST | `/research/:id` | Agent/Admin | Research a contact (fetch latest content/timezone) |
| POST | `/personalize/:id` | Agent/Admin | Generate Claude-personalized pitch for a contact |
| PUT | `/approve/:id` | Agent/Admin | Approve a draft pitch (optionally edit subject/body) |
| POST | `/send/:id` | Agent/Admin | Send approved pitch via Gmail (gated: `outreach_send`) |
| POST | `/followup/:id` | Agent/Admin | Send follow-up email to a sent contact |
| GET | `/status` | Agent/Admin | Pipeline status summary (contact counts, active campaigns) |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_outreach_status` | Get pipeline status for a project (contact counts, active campaigns) |
| `mycelium_outreach_contacts` | List contacts with filters |
| `mycelium_outreach_campaign` | Create or update an outreach campaign |
| `mycelium_outreach_discover` | Run YouTube + Hunter.io contact discovery |
| `mycelium_outreach_research` | Research a contact (fetch latest video/article) |
| `mycelium_outreach_personalize` | Generate Claude-personalized pitch |
| `mycelium_outreach_approve` | Approve a draft pitch |
| `mycelium_outreach_send` | Send approved pitch via Gmail (dry_run default) |
| `mycelium_outreach_followup` | Send follow-up email |

## Events

| Event | When |
|-------|------|
| `outreach_campaign_created` | Campaign created |
| `outreach_contact_created` | Contact added |
| `outreach_contact_updated` | Contact updated |
| `outreach_discover` | Discovery run completed |
| `outreach_pitch_sent` | Real email sent (not dry-run) |

## Database Tables

**`dv_outreach_campaigns`** -- Campaign configuration for outreach runs.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project_id | TEXT | Project identifier |
| name | TEXT | Campaign name |
| persona_prompt | TEXT | System prompt for Claude pitch generation |
| project_facts | TEXT | Project facts for Claude to reference |
| templates | TEXT (JSON) | Email templates keyed by type/tier |
| config | TEXT (JSON) | API keys, search queries, limits |
| status | TEXT | active, paused, completed |
| created_by | TEXT | Who created the campaign |

**`dv_outreach_contacts`** -- Press, creator, and influencer contacts.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project_id | TEXT | Project identifier |
| campaign_id | INTEGER FK | Links to campaign |
| type | TEXT | creator or press |
| name | TEXT | Contact name |
| email | TEXT | Email address |
| outlet | TEXT | Channel/outlet name |
| tier | TEXT | T1 (500k+), T2 (50k+), T3 (<50k) |
| archetype | TEXT | genre_specialist, hidden_gem, etc. |
| subscriber_count | INTEGER | YouTube subscriber count |
| status | TEXT | Pipeline status (discovered through closed) |
| pitch_subject | TEXT | Generated email subject |
| pitch_body | TEXT | Generated email body |
| last_content | TEXT | Latest video/article title |
| pitch_sent_at | TEXT | When pitch was sent |
| followup_due_at | TEXT | When follow-up is due (7 days after send) |

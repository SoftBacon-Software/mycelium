# Social Posting

Social media posting with character-voiced caption generation, scheduling, and publishing.

Manages social media posts across TikTok, Twitter, Instagram, and YouTube Shorts. Generates in-character caption prompts (configurable persona via `caption_persona` plugin config), queues posts with per-platform scheduling windows, and publishes via drone jobs using Buffer API or Instagram Graph API. Publishing is a gated action requiring approval.

## Configuration

No plugin-level config fields. Account credentials are stored per-account via the `/accounts` endpoints:

- **credentials** (JSON): Platform API credentials. For Instagram: `{ access_token, ig_user_id }`. For TikTok/Twitter: `{ token, profile_ids }` (Buffer API).
- **config** (JSON): Optional per-account config.

## API Endpoints

All routes are prefixed with `/api/mycelium/social`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/accounts` | Admin | Register a social media account |
| GET | `/accounts` | Admin | List accounts (credentials redacted) |
| PUT | `/accounts/:id` | Admin | Update account |
| DELETE | `/accounts/:id` | Admin | Delete account |
| POST | `/captions/generate` | Agent/Admin | Build a character-voiced caption prompt for a highlight clip |
| POST | `/posts` | Agent/Admin | Create a post (draft or scheduled) |
| GET | `/posts` | Agent/Admin | List posts (filter by project, platform, status, video_session_id) |
| GET | `/posts/:id` | Agent/Admin | Get post details (includes drone job status if linked) |
| PUT | `/posts/:id` | Agent/Admin | Update post fields |
| DELETE | `/posts/:id` | Agent/Admin | Delete post |
| GET | `/schedule` | Agent/Admin | Get scheduled posts queue |
| POST | `/posts/:id/schedule` | Agent/Admin | Schedule a draft post (auto-selects time window if omitted) |
| POST | `/posts/:id/publish` | Agent/Admin | Submit publishing drone job (gated: `social_publish`) |
| GET | `/stats` | Agent/Admin | Post counts by platform and status |
| GET | `/history` | Agent/Admin | Recent post history (default: last 7 days) |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_social_generate_caption` | Generate a character-voiced caption prompt for a gameplay highlight clip |
| `mycelium_social_create_post` | Create a social media post (draft or scheduled) |
| `mycelium_social_list_posts` | List posts with optional filters |
| `mycelium_social_schedule_post` | Schedule a draft post (auto-selects time window if no `scheduled_at`) |
| `mycelium_social_publish_post` | Publish a post via drone job (gated: `social_publish`) |
| `mycelium_social_stats` | Get posting stats by platform/status |
| `mycelium_social_history` | Get recent post history |

## Events

| Event | When |
|-------|------|
| `social_post_created` | Post created |
| `social_post_scheduled` | Post scheduled |
| `social_post_publishing` | Publishing drone job submitted |

## Database Tables

**`dv_social_accounts`** -- Registered social media accounts with platform credentials.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project_id | TEXT | Project identifier |
| platform | TEXT | tiktok, instagram, twitter, youtube_shorts |
| account_name | TEXT | Display name |
| credentials | TEXT (JSON) | API credentials (encrypted at rest) |
| config | TEXT (JSON) | Account-specific config |
| enabled | INTEGER | 1 = active |

**`dv_social_posts`** -- Post queue with scheduling and publishing state.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project_id | TEXT | Project identifier |
| account_id | INTEGER FK | Links to dv_social_accounts |
| platform | TEXT | Target platform |
| clip_id | TEXT | Video pipeline clip ID (tracking) |
| video_session_id | INTEGER | Video pipeline session ID |
| event_type | TEXT | Highlight event type |
| tier | TEXT | S/A/B/C quality tier |
| caption | TEXT | Post caption text |
| media_url | TEXT | URL of video/image |
| status | TEXT | draft, scheduled, publishing, published, failed |
| scheduled_at | TEXT | ISO timestamp for scheduled publish |
| drone_job_id | INTEGER | Linked publishing drone job |
| created_by | TEXT | Agent/user who created the post |

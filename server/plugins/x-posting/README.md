# X/Twitter Posting

Post directly to X/Twitter via API v2.

Create tweet drafts, organize them into threads, and publish to X using OAuth 1.0a. Supports auto-creation of tweets from approved build-in-public (BIP) drafts. Publishing is a gated action (`x_publish`) requiring approval.

## Configuration

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `api_key` | secret | Yes | Twitter/X API key (consumer key) |
| `api_secret` | secret | Yes | Twitter/X API secret (consumer secret) |
| `access_token` | secret | Yes | OAuth 1.0a access token |
| `access_token_secret` | secret | Yes | OAuth 1.0a access token secret |
| `auto_post_bip` | boolean | No | Auto-create tweet drafts from approved BIP drafts (default: false) |
| `default_project` | string | No | Project ID for tracking posts (default: `mycelium`) |

## API Endpoints

All routes are under `/api/mycelium/x`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/posts` | agent/admin | Create a tweet draft. Body: `text` (max 280 chars), `project_id`, `source`, `source_id`, `thread_id`, `thread_position` |
| GET | `/posts` | agent/admin | List posts. Filter: `?status=`, `?project_id=`, `?thread_id=`, `?source=`, `?limit=` |
| GET | `/posts/:id` | agent/admin | Get a single post |
| PUT | `/posts/:id` | agent/admin | Edit a draft. Body: `text` (only drafts can be edited) |
| DELETE | `/posts/:id` | admin | Delete a post |
| POST | `/posts/:id/publish` | agent/admin | Publish a draft to X. **Gated action: `x_publish`**. Threads auto-chain replies. |
| POST | `/thread` | agent/admin | Create a thread. Body: `tweets` (array of strings), `project_id`, `source`, `source_id` |
| POST | `/thread/:threadId/publish` | agent/admin | Publish an entire thread sequentially. **Gated action: `x_publish`**. |
| GET | `/stats` | agent/admin | Post counts grouped by status. Filter: `?project_id=` |

## Post Statuses

`draft` -> `publishing` -> `published` or `failed`

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_x_post` | Create a tweet draft (max 280 chars) |
| `mycelium_x_publish` | Publish a tweet draft to X. Gated: `x_publish` |
| `mycelium_x_thread` | Create a tweet thread (array of tweets) |
| `mycelium_x_publish_thread` | Publish an entire thread to X. Gated: `x_publish` |
| `mycelium_x_list` | List posts with optional filters (status, project_id, source) |
| `mycelium_x_stats` | Get posting stats by status |

## Events

**Listens to:**
- `bip_draft_approved` -- When a BIP draft is approved and `auto_post_bip` is enabled, auto-creates a tweet draft and notifies operators via inbox

**Emits:**
- `x_tweet_published` -- When a single tweet is published (includes `post_id`, `tweet_id`, `tweet_url`)
- `x_thread_published` -- When a thread is fully published (includes `thread_id`, tweet details)
- `x_post_created` -- When a tweet draft is auto-created from a BIP draft

## Database Tables

**`dv_x_posts`** -- Tweet drafts and published posts (project_id, tweet_text, tweet_id, tweet_url, thread_id, thread_position, source, source_id, status, error, posted_by, posted_at).

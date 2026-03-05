# Build in Public

Auto-generates social media draft posts from agent milestones and routes them to operator inbox for approval before publishing.

Watches for task completions, bug fixes, plan step completions, and drone job completions. When triggered, it creates a draft post with templated content and sends it to all operator inboxes for review. Approved drafts can be handed off to the `social-posting` plugin for publishing.

## Configuration

No config schema fields. The plugin reads `instance_url` from `dv_instance_config` to include in draft content.

## Gated Actions

- `bip_post_publish` -- approval gate required when approving drafts for publishing.

## API Endpoints

All routes are prefixed with `/bip`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/bip/drafts` | Agent/Admin | List drafts. Filter by `?status=` and `?trigger_event=`. Supports `limit` and `offset`. |
| GET | `/bip/drafts/:id` | Agent/Admin | Get a single draft by ID. |
| PUT | `/bip/drafts/:id` | Agent/Admin | Edit draft `title`, `content`, or `platforms`. |
| POST | `/bip/drafts/:id/approve` | Admin | Approve a pending draft. Checks `bip_post_publish` gate. Marks linked inbox items as actioned. |
| POST | `/bip/drafts/:id/reject` | Admin | Reject a pending draft. Accepts optional `note` in body. |
| DELETE | `/bip/drafts/:id` | Admin | Delete a draft. |
| GET | `/bip/stats` | Agent/Admin | Draft counts grouped by status. |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_bip_list` | List drafts. Filter by `status` (pending/approved/rejected/published/skipped), `trigger_event`, and `limit`. |
| `mycelium_bip_draft` | Manually create a draft post. Requires `title` and `content`. Optional `platforms` (twitter/instagram/tiktok) and `trigger_event`. |
| `mycelium_bip_approve` | Approve a draft by `draft_id`. Optional `approval_id` for pre-obtained gate approval. |

## Events

**Listens to:**
- `task_completed` -- creates draft from completed task
- `plan_step_completed` -- creates draft from completed plan step
- `bug_fixed` -- creates draft from fixed bug
- `drone_job_completed` -- creates draft from completed drone job

**Emits:**
- `bip_draft_created` -- when a new draft is auto-generated
- `bip_draft_approved` -- when an admin approves a draft
- `bip_draft_rejected` -- when an admin rejects a draft

## Database Tables

### `dv_bip_drafts`

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment ID |
| trigger_event | TEXT | Event type that triggered the draft |
| trigger_data | TEXT (JSON) | Original event payload |
| title | TEXT | Draft headline |
| content | TEXT | Draft post content |
| platforms | TEXT (JSON) | Target platforms array (default: `["twitter"]`) |
| status | TEXT | `pending`, `approved`, `rejected`, `published`, `skipped` |
| approval_id | INTEGER | Linked approval entry |
| inbox_item_id | TEXT (JSON) | Array of linked operator inbox IDs |
| rejection_note | TEXT | Reason for rejection |
| posted_at | TEXT | When the post was published |
| post_ids | TEXT (JSON) | Platform-to-post-ID mapping |
| created_at | TEXT | Creation timestamp |
| updated_at | TEXT | Last update timestamp |

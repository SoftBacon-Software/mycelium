# Video Pipeline

Gameplay capture to highlight detection to assembly to platform export.

Processes raw gameplay footage through a multi-stage pipeline: detect highlights from event logs (optionally with Claude Vision), assemble clips with narration and overlays, then export platform-specific formats (TikTok 9:16, Twitter 16:9, YouTube Shorts, Instagram). Each stage submits a drone job for compute-heavy FFmpeg work. Sessions track drone job IDs for each stage and auto-count clips.

## Configuration

No plugin-level config. Session-level config is passed via the `config` field on session creation. Drone jobs use the `wsac-agent` repo for worker scripts. Detection optionally uses Claude Vision (requires GPU drone).

## API Endpoints

All routes are prefixed with `/api/mycelium/video`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/sessions` | Agent/Admin | Create a video processing session |
| GET | `/sessions` | Agent/Admin | List sessions (filter by project_id, status) |
| GET | `/sessions/:id` | Agent/Admin | Get session details with clips and stats |
| PUT | `/sessions/:id` | Agent/Admin | Update session fields |
| DELETE | `/sessions/:id` | Admin | Delete session and its clips |
| GET | `/sessions/:id/clips` | Agent/Admin | List clips for a session (filter by tier, status) |
| POST | `/sessions/:id/clips` | Agent/Admin | Bulk add clips (from detection results) |
| PUT | `/clips/:id` | Agent/Admin | Update a clip |
| POST | `/sessions/:id/detect` | Agent/Admin | Submit highlight detection drone job |
| POST | `/sessions/:id/assemble` | Agent/Admin | Submit clip assembly drone job |
| POST | `/sessions/:id/export` | Agent/Admin | Submit platform export drone job |
| POST | `/sessions/:id/captions` | Agent/Admin | Get clip list for caption generation |
| GET | `/sessions/:id/status` | Agent/Admin | Get session status with drone job progress |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_video_create_session` | Create a new video processing session |
| `mycelium_video_list_sessions` | List sessions with optional filters |
| `mycelium_video_get_session` | Get full session details with clips and stats |
| `mycelium_video_detect` | Submit highlight detection drone job (optional Claude Vision) |
| `mycelium_video_assemble` | Submit assembly drone job (cuts clips, mixes narration, adds overlays) |
| `mycelium_video_export` | Submit export drone job (re-encodes for target platforms) |
| `mycelium_video_session_status` | Get session status including all drone job progress |
| `mycelium_video_add_clips` | Bulk add detected clips to a session |

## Events

| Event | When |
|-------|------|
| `video_session_created` | Session created |
| `video_detect_started` | Detection drone job submitted |
| `video_assemble_started` | Assembly drone job submitted |
| `video_export_started` | Export drone job submitted |

## Database Tables

**`dv_video_sessions`** -- Video processing sessions tracking footage through the pipeline.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project_id | TEXT | Project identifier |
| title | TEXT | Session title |
| footage_url | TEXT | URL/path to raw footage |
| event_log_url | TEXT | URL/path to Godot JSONL event log |
| status | TEXT | pending, detecting, assembling, exporting, completed, failed |
| detect_job_id | INTEGER | Detection drone job ID |
| assemble_job_id | INTEGER | Assembly drone job ID |
| export_job_id | INTEGER | Export drone job ID |
| clip_count | INTEGER | Number of detected clips |
| config | TEXT (JSON) | Session-level config |
| result_data | TEXT (JSON) | Pipeline output data |
| created_by | TEXT | Who created the session |

**`dv_video_clips`** -- Individual highlight clips within a session.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| session_id | INTEGER FK | Parent session |
| clip_id | TEXT | Unique clip identifier |
| tier | TEXT | S/A/B/C quality tier |
| event_type | TEXT | Highlight event type |
| start_sec | REAL | Start timestamp in footage |
| end_sec | REAL | End timestamp in footage |
| duration_sec | REAL | Clip duration (computed) |
| status | TEXT | detected, assembled, exported |
| platforms | TEXT (JSON) | Target platform list |
| caption_data | TEXT (JSON) | Generated caption data |
| metadata | TEXT (JSON) | Event metadata |
| result_url | TEXT | URL to assembled clip file |

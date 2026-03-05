# Steam Assets

Steam store page generation -- BBCode copy, curated screenshots, and segmented trailers.

Generates Steam store page assets for a game project. Store copy generation runs in-process (returns a structured prompt for Claude API to produce BBCode). Screenshot extraction and trailer building submit drone jobs that require GPU workers. Assets are tracked through pending -> processing -> complete/failed statuses.

## Configuration

Game facts must be provided per-request via `game_facts` body parameter, or stored in plugin config under the `game_facts` key (JSON). No built-in defaults. Drone jobs use a configurable worker repo for scripts.

## API Endpoints

All routes are prefixed with `/api/mycelium/steam`.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/assets` | Agent/Admin | List assets (filter by project_id, asset_type, status) |
| GET | `/assets/:id` | Agent/Admin | Get asset details (includes drone job status) |
| DELETE | `/assets/:id` | Admin | Delete asset |
| POST | `/store-copy` | Agent/Admin | Generate Steam BBCode store copy prompt |
| POST | `/screenshots` | Agent/Admin | Submit screenshot extraction drone job |
| POST | `/trailer` | Agent/Admin | Submit trailer build drone job |

## MCP Tools

| Tool | Description |
|------|-------------|
| `mycelium_steam_list_assets` | List Steam asset jobs (store copy, screenshots, trailers) |
| `mycelium_steam_get_asset` | Get asset details including drone job status |
| `mycelium_steam_store_copy` | Generate a BBCode store copy prompt for Claude API |
| `mycelium_steam_screenshots` | Submit drone job to extract curated screenshots from footage |
| `mycelium_steam_trailer` | Submit drone job to build a segmented trailer with narration |

## Events

| Event | When |
|-------|------|
| `steam_store_copy_requested` | Store copy generation requested |
| `steam_screenshots_started` | Screenshot extraction drone job submitted |
| `steam_trailer_started` | Trailer build drone job submitted |

## Database Tables

**`dv_steam_assets`** -- Steam asset generation tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| project_id | TEXT | Project identifier |
| asset_type | TEXT | store_copy, screenshots, trailer |
| title | TEXT | Asset description |
| status | TEXT | pending, processing, complete, failed |
| drone_job_id | INTEGER | Linked drone job (screenshots/trailer) |
| config | TEXT (JSON) | Input parameters (game_facts, footage_url, etc.) |
| result_data | TEXT (JSON) | Output data from generation |
| result_url | TEXT | URL to generated asset file |
| created_by | TEXT | Who requested the asset |

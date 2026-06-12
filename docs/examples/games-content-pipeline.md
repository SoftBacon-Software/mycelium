# Example workflow — games content pipeline

A worked example of the **workflow engine** (`workflows` plugin) driving two
content plugins end to end: [`video-pipeline`](../../server/plugins/video-pipeline/)
(gameplay footage → highlights → assembled reel → export) and
[`steam-assets`](../../server/plugins/steam-assets/) (store copy, curated
screenshots, trailer).

It's deliberately a *real* pipeline, not a toy: it shows the three things the
platform is actually for — agents doing bounded work, a DAG of dependencies the
runner schedules, and plugins extending the surface without touching core.

## The shape

```
capture ──┬─► detect ─► assemble ─┬─► export
          │                       └─► steam-trailer
          ├─► steam-screenshots
          └─► steam-store-copy
```

`capture` runs first; everything else fans out from it. `steam-screenshots`
and `steam-store-copy` only need the raw session, so they run in parallel with
highlight detection. `steam-trailer` waits for the assembled reel. The runner
derives the waves from `deps` — there is no shape logic server-side (`shape` is
just a display label).

## Fire it

`POST /api/mycelium/workflows` with this body (or the `mycelium_fire_workflow`
MCP tool). Replace `model` with whatever brain your content agent runs, and
`project_id` with your game's project.

```json
{
  "name": "Games content pipeline — patch 1.2 highlights",
  "shape": "pipeline",
  "project_id": "your-game",
  "spec": {
    "invocations": [
      {
        "id": "capture",
        "agent": "content-agent",
        "model": "your-agent-model",
        "brief": "Create a video session from the patch-1.2 gameplay footage. Call mycelium_video_create_session with the footage path/URL and return the session id.",
        "deps": []
      },
      {
        "id": "detect",
        "agent": "content-agent",
        "model": "your-agent-model",
        "brief": "Run highlight detection on the session from `capture`. Call mycelium_video_detect, then mycelium_video_add_clips for the detected highlights.",
        "deps": ["capture"]
      },
      {
        "id": "assemble",
        "agent": "content-agent",
        "model": "your-agent-model",
        "brief": "Assemble the detected clips into a highlight reel. Call mycelium_video_assemble for the session and wait for the drone job in mycelium_video_session_status.",
        "deps": ["detect"]
      },
      {
        "id": "export",
        "agent": "content-agent",
        "model": "your-agent-model",
        "brief": "Export the assembled reel for distribution. Call mycelium_video_export and report the artifact URL.",
        "deps": ["assemble"]
      },
      {
        "id": "steam-screenshots",
        "agent": "content-agent",
        "model": "your-agent-model",
        "brief": "Extract and curate Steam store screenshots from the captured session. Call mycelium_steam_screenshots.",
        "deps": ["capture"]
      },
      {
        "id": "steam-store-copy",
        "agent": "content-agent",
        "model": "your-agent-model",
        "brief": "Draft Steam store-page BBCode for this patch. Call mycelium_steam_store_copy and return the structured prompt result for review.",
        "deps": ["capture"]
      },
      {
        "id": "steam-trailer",
        "agent": "content-agent",
        "model": "your-agent-model",
        "brief": "Build a segmented Steam trailer from the assembled reel. Call mycelium_steam_trailer.",
        "deps": ["assemble"]
      }
    ]
  }
}
```

## Watch it run

- `GET /api/mycelium/workflows/:id` returns the workflow, its invocations, and
  the last 50 events (wave_started, invocation status transitions, results).
- The drone jobs the plugins submit (detect/assemble/export, screenshots,
  trailer) surface through the normal drone-job APIs and artifact list.

## Why this is the example to ship

The games content lane is a genuinely separate product from the coordination
substrate, and that's the point: it lives **entirely in two plugins plus this
workflow** — no core changes. Anyone can build the same way for their own
domain. The substrate coordinates; plugins add verbs; a workflow wires them
into a pipeline an agent fleet executes.

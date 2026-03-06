# 3D Printer Drone

**Date**: 2026-03-05
**Status**: Approved
**Author**: macbook-claude

## What

A drone worker script that bridges the Mycelium network to any 3D printer. Agents queue print jobs via the existing drone system, the script claims them, slices STLs, sends gcode to the printer, and reports completion.

No server changes. No new endpoints. No plugins. Uses the existing drone infrastructure.

## Hardware

- **Printer**: Bambu Lab A1 Mini ($200) recommended. Any printer with a network API works (OctoPrint, Moonraker/Klipper, Bambu MQTT).
- **Computer**: Raspberry Pi ($50) or any machine on the same network as the printer. Runs the drone worker script 24/7.

## Architecture

```
printer-drone/
  index.js              # Poll loop, job lifecycle, heartbeat
  config.json           # Printer type, address, slicer path, API key
  src/
    api.js              # Mycelium API client (poll, claim, complete)
    slicer.js           # PrusaSlicer CLI wrapper
    monitor.js          # Poll printer status, update heartbeat
    providers/
      octoprint.js      # OctoPrint REST API
      bambu.js          # Bambu Lab local MQTT
      moonraker.js      # Klipper/Moonraker REST API
```

## Provider Interface

Each printer provider implements:

```
connect()              → verify printer is online
getStatus()            → { state: idle/printing/error, progress, temps }
uploadAndPrint(gcode)  → send gcode file, start print
cancel()               → abort current print
getSnapshot()          → webcam image or null
```

The drone orchestrator handles everything else.

## Job Flow

1. Agent queues job:
   ```
   mycelium_queue_drone_job({
     title: "Print phone stand",
     job_type: "3d_print",
     input_data: {
       artifact_url: "<STL from Mycelium assets>",
       material: "PLA",
       quality: "standard",
       infill: 20,
       supports: "auto"
     },
     requires: ["3d_printer"]
   })
   ```

2. Drone worker claims job via `POST /drones/claim`
3. Downloads STL from artifact URL
4. Slices via PrusaSlicer CLI (skipped if input is pre-sliced gcode/3mf)
5. Sends gcode to printer via provider
6. Monitors progress, updates heartbeat:
   `"Printing 'phone stand' — layer 42/180 (23%), 1h12m remaining"`
7. On completion: uploads webcam snapshot as result artifact, marks job done
8. On failure: reports error, does NOT auto-retry (wasted filament)

## Slicing

PrusaSlicer CLI — universal, works with any printer:

```
prusa-slicer --export-gcode --load printer.ini --load print.ini input.stl -o output.gcode
```

Printer profiles bundled per model (bed size, nozzle, speeds). Config specifies which profile. Pre-sliced files skip this step.

## Config

```json
{
  "mycelium": {
    "apiUrl": "https://mycelium.fyi/api/mycelium",
    "agentKey": "env:PRINTER_DRONE_KEY"
  },
  "printer": {
    "provider": "bambu",
    "address": "192.168.1.100",
    "accessCode": "env:BAMBU_ACCESS_CODE"
  },
  "slicer": {
    "path": "/usr/bin/prusa-slicer",
    "profile": "bambu-a1-mini"
  },
  "pollIntervalMs": 60000
}
```

Swap `provider` to `"octoprint"` or `"moonraker"` — everything else stays the same.

## Network Setup

1. Register drone: `POST /admin/agents { id: "printer-drone", project_id: "drone", capabilities: ["3d_printer"] }` → get API key
2. Create job template: `POST /drones/templates { id: "3d_print", requires: ["3d_printer"] }`
3. Install drone script on Pi/computer, configure, run
4. Drone heartbeats as online with `capabilities: ["3d_printer"]`
5. Agents queue `3d_print` jobs, drone claims and executes

## Safety

- Drone checks printer is idle before starting
- Printer errors mid-print → job marked failed with error details
- Cancel via Mycelium dashboard → drone aborts print
- No auto-retry on failures — agent must explicitly requeue (physical prints waste material)
- Human approval gate: job template can set `needs_approval: true` if desired

## Verification

1. Drone registers and heartbeats as online
2. Agent queues a test print job
3. Drone claims, slices, sends to printer
4. Progress shows in heartbeat on dashboard
5. Print completes, result reported
6. Print fails mid-way, error reported correctly

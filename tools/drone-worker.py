#!/usr/bin/env python3
"""
Mycelium Drone Worker
=====================
Runs on a GPU/CPU machine, polls Mycelium for jobs, executes them, reports results.

Setup:
  pip install requests

Usage:
  python drone-worker.py --key YOUR_AGENT_API_KEY
  python drone-worker.py --key YOUR_AGENT_API_KEY --server https://mycelium.fyi
  python drone-worker.py --key YOUR_AGENT_API_KEY --capabilities gpu,cpu --poll-interval 10

The drone will:
  1. Boot and announce itself online
  2. Poll for jobs matching its capabilities
  3. Execute job commands in a subprocess
  4. Report results (stdout/stderr) back to Mycelium
  5. Send heartbeats to stay visible on the dashboard
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import traceback

try:
    import requests
except ImportError:
    print("ERROR: 'requests' package required. Install with: pip install requests")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_SERVER = "https://mycelium.fyi"
DEFAULT_CAPABILITIES = ["cpu", "gpu"]
DEFAULT_POLL_INTERVAL = 15  # seconds
DEFAULT_HEARTBEAT_INTERVAL = 120  # seconds
MAX_RESULT_SIZE = 50_000  # truncate stdout/stderr beyond this


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

class MyceliumAPI:
    def __init__(self, server, agent_key):
        self.base = server.rstrip("/") + "/api/mycelium"
        self.headers = {
            "X-Agent-Key": agent_key,
            "Content-Type": "application/json",
        }

    def get(self, path):
        r = requests.get(self.base + path, headers=self.headers, timeout=30)
        r.raise_for_status()
        return r.json()

    def post(self, path, data=None):
        r = requests.post(self.base + path, headers=self.headers, json=data or {}, timeout=30)
        r.raise_for_status()
        return r.json()

    def put(self, path, data=None):
        r = requests.put(self.base + path, headers=self.headers, json=data or {}, timeout=30)
        r.raise_for_status()
        return r.json()

    def heartbeat(self, working_on=""):
        return self.post("/agents/heartbeat", {"working_on": working_on})

    def claim_job(self, capabilities):
        return self.post("/drones/claim", {"capabilities": capabilities})

    def update_job(self, job_id, fields):
        return self.put(f"/drones/jobs/{job_id}", fields)

    def boot(self, agent_id):
        return self.get(f"/boot/{agent_id}")


# ---------------------------------------------------------------------------
# Job execution
# ---------------------------------------------------------------------------

def execute_job(job, work_dir=None):
    """Run job command in subprocess, return (success, stdout, stderr)."""
    command = job.get("command", "")
    if not command:
        return False, "", "No command specified in job"

    input_data = job.get("input_data", "{}")
    if isinstance(input_data, str):
        try:
            input_data = json.loads(input_data)
        except json.JSONDecodeError:
            input_data = {}

    # Set input data as environment variable for the subprocess
    env = os.environ.copy()
    env["MYCELIUM_JOB_ID"] = str(job["id"])
    env["MYCELIUM_JOB_INPUT"] = json.dumps(input_data)
    env["MYCELIUM_JOB_TITLE"] = job.get("title", "")

    print(f"  Executing: {command}")
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=3600,  # 1 hour max per job
            cwd=work_dir,
            env=env,
        )
        stdout = result.stdout[:MAX_RESULT_SIZE] if result.stdout else ""
        stderr = result.stderr[:MAX_RESULT_SIZE] if result.stderr else ""
        success = result.returncode == 0
        if not success:
            stderr = f"Exit code {result.returncode}\n{stderr}"
        return success, stdout, stderr
    except subprocess.TimeoutExpired:
        return False, "", "Job timed out after 3600 seconds"
    except Exception as e:
        return False, "", str(e)


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run_drone(api, agent_id, capabilities, poll_interval, heartbeat_interval, work_dir):
    """Main polling loop."""
    last_heartbeat = 0
    consecutive_errors = 0

    print(f"Drone worker started")
    print(f"  Agent: {agent_id}")
    print(f"  Server: {api.base}")
    print(f"  Capabilities: {capabilities}")
    print(f"  Poll interval: {poll_interval}s")
    print(f"  Work dir: {work_dir or '(current)'}")
    print()

    # Initial boot
    try:
        boot = api.boot(agent_id)
        print(f"Boot successful. {len(boot.get('tasks', []))} tasks, {len(boot.get('new_messages', []))} messages.")
        if boot.get("pending_directives"):
            print(f"  WARNING: {len(boot['pending_directives'])} pending directive(s) — check dashboard!")
    except Exception as e:
        print(f"Boot failed (will retry): {e}")

    # Go online
    try:
        api.heartbeat("Drone online, polling for jobs")
        last_heartbeat = time.time()
        print("Status: online")
    except Exception as e:
        print(f"Heartbeat failed: {e}")

    print("\nPolling for jobs... (Ctrl+C to stop)\n")

    while True:
        try:
            # Heartbeat
            now = time.time()
            if now - last_heartbeat >= heartbeat_interval:
                api.heartbeat("Idle, polling for jobs")
                last_heartbeat = now

            # Poll for job
            result = api.claim_job(capabilities)
            job = result.get("job")

            if job:
                consecutive_errors = 0
                job_id = job["id"]
                title = job.get("title", "unknown")
                print(f"[Job #{job_id}] Claimed: {title}")
                api.heartbeat(f"Running job #{job_id}: {title}")

                # Execute
                success, stdout, stderr = execute_job(job, work_dir)

                if success:
                    print(f"[Job #{job_id}] Completed successfully")
                    api.update_job(job_id, {
                        "status": "completed",
                        "result_data": json.dumps({
                            "stdout": stdout[-10000:],  # last 10k chars
                            "exit_code": 0,
                        }),
                    })
                else:
                    print(f"[Job #{job_id}] Failed: {stderr[:200]}")
                    api.update_job(job_id, {
                        "status": "failed",
                        "error": stderr[:5000],
                        "result_data": json.dumps({
                            "stdout": stdout[-5000:],
                            "stderr": stderr[-5000:],
                        }),
                    })

                api.heartbeat("Idle, polling for jobs")
                last_heartbeat = time.time()
            else:
                # No job available
                consecutive_errors = 0
                time.sleep(poll_interval)

        except KeyboardInterrupt:
            print("\nShutting down...")
            try:
                api.heartbeat("")
            except Exception:
                pass
            break
        except requests.exceptions.ConnectionError:
            consecutive_errors += 1
            wait = min(poll_interval * consecutive_errors, 300)
            print(f"Connection error (attempt {consecutive_errors}), retrying in {wait}s...")
            time.sleep(wait)
        except Exception as e:
            consecutive_errors += 1
            wait = min(poll_interval * consecutive_errors, 300)
            print(f"Error: {e}")
            if consecutive_errors <= 3:
                traceback.print_exc()
            time.sleep(wait)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Mycelium Drone Worker")
    parser.add_argument("--key", required=True, help="Agent API key (X-Agent-Key)")
    parser.add_argument("--agent-id", default="unakron-gpu", help="Agent ID (default: unakron-gpu)")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Mycelium server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--capabilities", default=",".join(DEFAULT_CAPABILITIES),
                        help=f"Comma-separated capabilities (default: {','.join(DEFAULT_CAPABILITIES)})")
    parser.add_argument("--poll-interval", type=int, default=DEFAULT_POLL_INTERVAL,
                        help=f"Seconds between polls (default: {DEFAULT_POLL_INTERVAL})")
    parser.add_argument("--heartbeat-interval", type=int, default=DEFAULT_HEARTBEAT_INTERVAL,
                        help=f"Seconds between heartbeats (default: {DEFAULT_HEARTBEAT_INTERVAL})")
    parser.add_argument("--work-dir", default=None, help="Working directory for job execution")
    args = parser.parse_args()

    capabilities = [c.strip() for c in args.capabilities.split(",") if c.strip()]
    api = MyceliumAPI(args.server, args.key)

    # Verify connection
    print("Mycelium Drone Worker v1.0")
    print("=" * 40)
    try:
        api.get(f"/agents")
        print("Connected to Mycelium.")
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 401:
            print("ERROR: Invalid agent key. Check your --key value.")
            sys.exit(1)
        raise
    except requests.exceptions.ConnectionError:
        print(f"ERROR: Cannot connect to {args.server}")
        sys.exit(1)

    run_drone(api, args.agent_id, capabilities, args.poll_interval, args.heartbeat_interval, args.work_dir)


if __name__ == "__main__":
    main()

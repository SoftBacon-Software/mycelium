#!/usr/bin/env python3
"""
Mycelium Drone Worker v2.0
==========================
Smart, self-diagnosing compute worker. Polls Mycelium for jobs, executes them,
reports structured results with rich error diagnostics.

Setup (one command):
  pip install requests

Usage:
  python drone-worker.py --key YOUR_API_KEY
  python drone-worker.py --key YOUR_API_KEY --capabilities gpu,cpu
  python drone-worker.py --check   # Validate environment without starting

The worker will:
  1. Diagnose the system (Python, CUDA, GPU, disk, OS)
  2. Report diagnostics to Mycelium dashboard
  3. Poll for jobs, execute them, report structured results
  4. On failure: categorize error, suggest fix, include system context
"""

import argparse
import json
import os
import platform
import shlex
import shutil
import signal
import subprocess
import sys
import time
import traceback
from pathlib import Path

try:
    import requests
except ImportError:
    print("=" * 60)
    print("SETUP REQUIRED: Install the requests package")
    print()
    print("  pip install requests")
    print()
    print("Then re-run this script.")
    print("=" * 60)
    sys.exit(1)

VERSION = "2.0.0"
DEFAULT_SERVER = "https://mycelium.fyi"
DEFAULT_CAPABILITIES = ["cpu"]
DEFAULT_POLL_INTERVAL = 15
DEFAULT_HEARTBEAT_INTERVAL = 120
MAX_OUTPUT_SIZE = 50_000
WORKSPACE_ROOT = Path.home() / ".mycelium" / "workspaces"
ARTIFACT_CACHE = Path.home() / ".mycelium" / "artifacts"


# ---------------------------------------------------------------------------
# System diagnostics
# ---------------------------------------------------------------------------

def get_system_info():
    """Collect everything about this machine for dashboard visibility."""
    info = {
        "worker_version": VERSION,
        "os": platform.system(),
        "os_version": platform.version(),
        "os_release": platform.release(),
        "machine": platform.machine(),
        "python_version": platform.python_version(),
        "python_path": sys.executable,
        "hostname": platform.node(),
    }

    # Disk space
    try:
        usage = shutil.disk_usage(Path.home())
        info["disk_free_gb"] = round(usage.free / (1024**3), 1)
        info["disk_total_gb"] = round(usage.total / (1024**3), 1)
    except Exception:
        pass

    # CUDA / GPU detection
    info["cuda_available"] = False
    info["gpu_name"] = None
    info["gpu_vram_gb"] = None
    try:
        import torch
        info["torch_version"] = torch.__version__
        info["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            info["cuda_version"] = torch.version.cuda
            info["gpu_name"] = torch.cuda.get_device_name(0)
            vram = torch.cuda.get_device_properties(0).total_mem
            info["gpu_vram_gb"] = round(vram / (1024**3), 1)
            info["gpu_count"] = torch.cuda.device_count()
    except ImportError:
        info["torch_version"] = None
    except Exception as e:
        info["torch_error"] = str(e)

    # nvidia-smi fallback for GPU info
    if not info.get("gpu_name"):
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10
            )
            if r.returncode == 0 and r.stdout.strip():
                parts = r.stdout.strip().split(",")
                info["gpu_name"] = parts[0].strip()
                if len(parts) > 1:
                    info["gpu_vram_gb"] = round(int(parts[1].strip()) / 1024, 1)
        except Exception:
            pass

    # Check for common tools
    for tool in ["git", "curl", "pip"]:
        try:
            r = subprocess.run(
                [tool, "--version"], capture_output=True, text=True, timeout=10
            )
            info[f"has_{tool}"] = r.returncode == 0
            if r.returncode == 0:
                info[f"{tool}_version"] = r.stdout.strip().split("\n")[0][:100]
        except Exception:
            info[f"has_{tool}"] = False

    return info


def print_diagnostics(info):
    """Print a formatted diagnostics report to console."""
    print("=" * 60)
    print(f"  Mycelium Drone Worker v{VERSION}")
    print("=" * 60)
    print()
    print(f"  OS:       {info['os']} {info.get('os_release', '')} ({info['machine']})")
    print(f"  Python:   {info['python_version']} ({info['python_path']})")
    print(f"  Hostname: {info.get('hostname', 'unknown')}")
    print(f"  Disk:     {info.get('disk_free_gb', '?')} GB free / {info.get('disk_total_gb', '?')} GB total")
    print()

    # GPU / CUDA
    if info.get("cuda_available"):
        print(f"  GPU:      {info.get('gpu_name', 'unknown')}")
        print(f"  VRAM:     {info.get('gpu_vram_gb', '?')} GB")
        print(f"  CUDA:     {info.get('cuda_version', 'unknown')}")
        print(f"  PyTorch:  {info.get('torch_version', 'not installed')}")
    elif info.get("gpu_name"):
        print(f"  GPU:      {info.get('gpu_name', 'unknown')} (detected via nvidia-smi)")
        print(f"  VRAM:     {info.get('gpu_vram_gb', '?')} GB")
        torch_v = info.get("torch_version")
        if torch_v:
            print(f"  PyTorch:  {torch_v} (WARNING: CUDA not available!)")
        else:
            print(f"  PyTorch:  NOT INSTALLED")
    else:
        print("  GPU:      None detected")
        print("  CUDA:     Not available")

    print()
    # Tools
    for tool in ["git", "curl", "pip"]:
        status = "OK" if info.get(f"has_{tool}") else "MISSING"
        version = info.get(f"{tool}_version", "")
        print(f"  {tool:8s}: {status}  {version}")
    print()

    # Warnings
    warnings = get_warnings(info)
    if warnings:
        print("  WARNINGS:")
        for w in warnings:
            print(f"    ! {w}")
        print()


def get_warnings(info):
    """Return list of actionable warnings."""
    warnings = []
    pv = info.get("python_version", "")
    major_minor = tuple(int(x) for x in pv.split(".")[:2]) if pv else (0, 0)

    if major_minor >= (3, 13):
        warnings.append(
            f"Python {pv} is too new for PyTorch. Install Python 3.11 or 3.12. "
            "Download: https://www.python.org/downloads/"
        )
    elif major_minor < (3, 8):
        warnings.append(f"Python {pv} is too old. Install Python 3.11+.")

    if not info.get("torch_version") and info.get("gpu_name"):
        warnings.append(
            "PyTorch not installed but GPU detected. Install with CUDA support:\n"
            "         pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124"
        )

    if info.get("torch_version") and not info.get("cuda_available") and info.get("gpu_name"):
        warnings.append(
            "PyTorch installed but CUDA not available. You may have CPU-only torch.\n"
            "         Reinstall: pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124"
        )

    if info.get("disk_free_gb") and info["disk_free_gb"] < 10:
        warnings.append(f"Low disk space: {info['disk_free_gb']} GB free. Need 10+ GB for AI workloads.")

    if not info.get("has_git"):
        warnings.append("git not installed. Some jobs may need it. Install: https://git-scm.com/downloads")

    return warnings


# ---------------------------------------------------------------------------
# API client
# ---------------------------------------------------------------------------

class MyceliumAPI:
    def __init__(self, server, agent_key):
        self.base = server.rstrip("/") + "/api/mycelium"
        self.headers = {
            "X-Agent-Key": agent_key,
            "Content-Type": "application/json",
        }
        self.agent_key = agent_key

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

    def heartbeat(self, working_on="", state_snapshot=None):
        data = {"working_on": working_on}
        if state_snapshot:
            data["state_snapshot"] = state_snapshot
        return self.post("/agents/heartbeat", data)

    def claim_job(self, capabilities):
        return self.post("/drones/claim", {"capabilities": capabilities})

    def update_job(self, job_id, fields):
        return self.put(f"/drones/jobs/{job_id}", fields)

    def download_artifact(self, name, dest_path):
        """Download artifact using requests (not curl). Handles redirects properly."""
        url = self.base + f"/drones/artifacts/{name}"
        r = requests.get(url, timeout=300, stream=True)
        r.raise_for_status()
        dest_path = Path(dest_path)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        with open(dest_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
                total += len(chunk)
        return total

    def get_artifact_info(self):
        """List available artifacts with sizes."""
        try:
            return self.get("/drones/artifacts")
        except Exception:
            return []

    def upload_file(self, name, file_path):
        """Upload a file as a drone artifact."""
        url = self.base + "/drones/artifacts"
        headers = {"X-Agent-Key": self.agent_key}
        with open(file_path, "rb") as f:
            r = requests.post(
                url, headers=headers,
                files={"file": (name, f)},
                data={"name": name},
                timeout=600
            )
        r.raise_for_status()
        return r.json()


# ---------------------------------------------------------------------------
# Workspace and artifact management
# ---------------------------------------------------------------------------

def ensure_workspace(workspace_name):
    """Create workspace directory, return path."""
    ws = WORKSPACE_ROOT / workspace_name
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def download_artifacts(api, artifact_names, workspace):
    """Download artifacts to workspace. Returns (successes, failures)."""
    successes = []
    failures = []

    for name in artifact_names:
        # Skip if it's a dict (old format) — extract name
        if isinstance(name, dict):
            name = name.get("name", str(name))

        dest = workspace / name
        cache = ARTIFACT_CACHE / name

        # Check server for current size
        try:
            artifacts = api.get_artifact_info()
            server_info = None
            if isinstance(artifacts, list):
                server_info = next((a for a in artifacts if a.get("name") == name), None)
            elif isinstance(artifacts, dict) and "artifacts" in artifacts:
                server_info = next((a for a in artifacts["artifacts"] if a.get("name") == name), None)
        except Exception:
            server_info = None

        # Check cache
        if cache.exists():
            cache_size = cache.stat().st_size
            server_size = server_info.get("size", 0) if server_info else 0
            if server_size and abs(cache_size - server_size) < 100:
                # Cache is fresh — copy to workspace
                if not dest.exists() or dest.stat().st_size != cache_size:
                    shutil.copy2(cache, dest)
                successes.append(name)
                print(f"    [cached] {name} ({cache_size // 1024} KB)")
                continue

        # Download fresh
        try:
            print(f"    [download] {name}...", end="", flush=True)
            size = api.download_artifact(name, cache)
            shutil.copy2(cache, dest)
            print(f" {size // 1024} KB")
            successes.append(name)
        except requests.exceptions.HTTPError as e:
            msg = f"HTTP {e.response.status_code}" if e.response else str(e)
            print(f" FAILED ({msg})")
            failures.append({"name": name, "error": msg})
        except Exception as e:
            print(f" FAILED ({e})")
            failures.append({"name": name, "error": str(e)})

    return successes, failures


# ---------------------------------------------------------------------------
# Error categorization
# ---------------------------------------------------------------------------

def categorize_error(stderr, exit_code, job, system_info):
    """Analyze error output and return structured error report."""
    stderr_lower = stderr.lower() if stderr else ""

    error = {
        "error_type": "runtime_error",
        "message": "",
        "suggestion": "",
        "exit_code": exit_code,
        "python_version": system_info.get("python_version"),
        "os": system_info.get("os"),
        "cuda_available": system_info.get("cuda_available"),
    }

    # Python version too new for torch
    if "no matching distribution found for torch" in stderr_lower:
        error["error_type"] = "env_python_version"
        error["message"] = f"PyTorch is not available for Python {system_info.get('python_version')}."
        error["suggestion"] = (
            "Install Python 3.11 or 3.12 (PyTorch doesn't support 3.13+ yet). "
            "Download: https://www.python.org/downloads/release/python-3119/"
        )
        return error

    if "no module named 'torch'" in stderr_lower or "modulenotfounderror: no module named 'torch'" in stderr_lower:
        error["error_type"] = "env_missing_torch"
        error["message"] = "PyTorch is not installed."
        error["suggestion"] = (
            "Install with CUDA support: "
            "pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124"
        )
        return error

    if "no module named" in stderr_lower:
        # Extract module name
        for line in stderr.split("\n"):
            if "no module named" in line.lower():
                error["error_type"] = "env_missing_module"
                error["message"] = line.strip()
                module = line.split("'")[-2] if "'" in line else "unknown"
                error["suggestion"] = f"pip install {module}"
                return error

    if "cuda" in stderr_lower and ("not available" in stderr_lower or "no cuda" in stderr_lower):
        error["error_type"] = "env_no_cuda"
        error["message"] = "CUDA is not available on this machine."
        error["suggestion"] = (
            "1. Check nvidia-smi works. "
            "2. Reinstall PyTorch with CUDA: pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124"
        )
        return error

    if "is not recognized" in stderr_lower or "command not found" in stderr_lower:
        # Extract the command
        for line in stderr.split("\n"):
            if "is not recognized" in line.lower() or "command not found" in line.lower():
                error["error_type"] = "env_missing_command"
                error["message"] = line.strip()
                error["suggestion"] = "The command is not in PATH. Check the job command is correct."
                return error

    if "no such file or directory" in stderr_lower or "cannot find the path" in stderr_lower:
        error["error_type"] = "path_not_found"
        error["message"] = "A file or directory referenced by the job doesn't exist."
        for line in stderr.split("\n"):
            if "no such file" in line.lower() or "cannot find" in line.lower():
                error["message"] = line.strip()
                break
        error["suggestion"] = (
            "The job command references a path that doesn't exist on this machine. "
            "Check that artifacts are downloaded and paths are relative, not absolute."
        )
        return error

    if "errno 28" in stderr_lower or "no space left" in stderr_lower:
        error["error_type"] = "env_disk_full"
        error["message"] = "Disk is full."
        error["suggestion"] = f"Free up disk space. Currently: {system_info.get('disk_free_gb', '?')} GB free."
        return error

    if "timed out" in stderr_lower or "timeout" in stderr_lower:
        error["error_type"] = "timeout"
        error["message"] = "Job timed out."
        error["suggestion"] = "The job took too long (1 hour max). Check for infinite loops or very large workloads."
        return error

    if "permission denied" in stderr_lower or "access is denied" in stderr_lower:
        error["error_type"] = "permission_error"
        error["message"] = "Permission denied."
        for line in stderr.split("\n"):
            if "permission" in line.lower() or "access" in line.lower():
                error["message"] = line.strip()
                break
        error["suggestion"] = "Check file permissions. Run the worker as a user with access to the workspace."
        return error

    if "out of memory" in stderr_lower or "cuda out of memory" in stderr_lower:
        error["error_type"] = "gpu_oom"
        error["message"] = "GPU ran out of memory."
        error["suggestion"] = (
            f"GPU VRAM: {system_info.get('gpu_vram_gb', '?')} GB. "
            "Try reducing batch size or image resolution."
        )
        return error

    # Signal-killed process (Linux: negative exit code or 128+N)
    signal_names = {
        9: "SIGKILL (likely OOM-killed by OS)",
        11: "SIGSEGV (segmentation fault — likely GPU OOM or driver crash)",
        6: "SIGABRT (aborted)",
        15: "SIGTERM (terminated)",
        2: "SIGINT (interrupted)",
    }
    signal_num = None
    if exit_code is not None and exit_code < 0:
        signal_num = abs(exit_code)
    elif exit_code is not None and exit_code > 128 and exit_code <= 159:
        signal_num = exit_code - 128
    elif exit_code is not None and exit_code > 200 and exit_code < 256:
        # Python sys.exit(-N) wraps to 256-N
        signal_num = 256 - exit_code

    if signal_num and signal_num in signal_names:
        error["error_type"] = "signal_killed"
        error["message"] = f"Process killed by signal {signal_num}: {signal_names[signal_num]}"
        if signal_num in (9, 11):
            error["suggestion"] = (
                f"GPU VRAM: {system_info.get('gpu_vram_gb', '?')} GB. "
                "The process was killed, likely due to GPU/system memory exhaustion. "
                "Try reducing batch size, image resolution, or closing other GPU processes."
            )
        else:
            error["suggestion"] = f"Process received signal {signal_num}. Check system logs for details."
        return error

    # Generic runtime error — include first meaningful stderr line
    meaningful_lines = [
        l.strip() for l in stderr.split("\n")
        if l.strip()
        and not l.strip().startswith("%")       # curl progress
        and not l.strip().startswith("Total")
        and not l.strip().startswith("[notice]") # pip notice
        and "% Total" not in l
        and "Dload  Upload" not in l
    ]
    if meaningful_lines:
        error["message"] = meaningful_lines[-1][:500]
    else:
        error["message"] = f"Job failed with exit code {exit_code}"

    error["suggestion"] = "Check the full stderr output below for details."
    return error


# ---------------------------------------------------------------------------
# Job execution
# ---------------------------------------------------------------------------

def update_job_with_retry(api, job_id, fields, retries=3):
    """Update job status with retries. Critical for ensuring failed jobs are marked failed."""
    for attempt in range(retries):
        try:
            api.update_job(job_id, fields)
            return True
        except Exception as e:
            status = fields.get("status", "unknown")
            print(f"  WARNING: Failed to update job #{job_id} to '{status}' (attempt {attempt + 1}/{retries}): {e}")
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
    print(f"  ERROR: Could not update job #{job_id} after {retries} attempts. Job may be stuck in 'running'.")
    return False


def execute_job(api, job, system_info, work_dir=None):
    """Execute a job with full workspace setup and error handling.
    Returns (success, result_data_dict)."""

    job_id = job["id"]
    command = job.get("command", "")
    title = job.get("title", "")

    # Parse input_data
    input_data = job.get("input_data", "{}")
    if isinstance(input_data, str):
        try:
            input_data = json.loads(input_data)
        except json.JSONDecodeError:
            input_data = {}

    # Determine workspace
    workspace_name = input_data.get("workspace_dir", f"job_{job_id}")
    workspace = ensure_workspace(workspace_name)
    exec_dir = work_dir or str(workspace)

    print(f"  Workspace: {workspace}")

    # Download artifacts if specified
    artifacts = input_data.get("artifacts", [])
    if artifacts:
        print(f"  Downloading {len(artifacts)} artifact(s)...")
        successes, failures = download_artifacts(api, artifacts, workspace)
        if failures:
            return False, {
                "error_type": "download_failed",
                "message": f"Failed to download {len(failures)} artifact(s): {', '.join(f['name'] for f in failures)}",
                "suggestion": "Check that these artifacts exist on the server (GET /drones/artifacts). Re-upload if needed.",
                "failures": failures,
                "successes": successes,
            }

    # Run setup if specified (one-time per workspace)
    setup_cmd = input_data.get("setup")
    setup_marker = Path.home() / ".mycelium" / ".setup_done" / workspace_name
    if setup_cmd and not setup_marker.exists():
        print(f"  Running setup: {setup_cmd[:100]}...")
        try:
            r = subprocess.run(
                setup_cmd, shell=True, capture_output=True, text=True,
                timeout=1800, cwd=str(workspace),
                env={**os.environ, "MYCELIUM_JOB_ID": str(job_id)}
            )
            if r.returncode != 0:
                stderr = r.stderr[:MAX_OUTPUT_SIZE] if r.stderr else ""
                error = categorize_error(stderr, r.returncode, job, system_info)
                error["phase"] = "setup"
                error["setup_command"] = setup_cmd
                return False, error
            # Mark setup done
            setup_marker.parent.mkdir(parents=True, exist_ok=True)
            setup_marker.touch()
            print(f"  Setup complete.")
        except subprocess.TimeoutExpired:
            return False, {
                "error_type": "setup_timeout",
                "message": "Setup command timed out after 30 minutes.",
                "suggestion": "The setup command is taking too long. Check network connectivity and simplify.",
                "setup_command": setup_cmd,
            }
        except Exception as e:
            return False, {
                "error_type": "setup_error",
                "message": str(e),
                "setup_command": setup_cmd,
            }

    # Execute the main command
    if not command:
        return False, {
            "error_type": "no_command",
            "message": "No command specified in job.",
            "suggestion": "The job was created without a command field.",
        }

    # Set up environment for the subprocess
    env = os.environ.copy()
    env["MYCELIUM_JOB_ID"] = str(job_id)
    env["MYCELIUM_JOB_INPUT"] = json.dumps(input_data)
    env["MYCELIUM_JOB_TITLE"] = title
    env["MYCELIUM_KEY"] = api.agent_key
    env["MYCELIUM_SERVER"] = api.base.replace("/api/mycelium", "")

    print(f"  Executing: {command[:150]}")
    # Run the command as an argv list with shell=False so job data interpolated
    # into the command string cannot be interpreted by a shell (C-2 defense in
    # depth, complementing the server-side metachar reject). shlex.split honors
    # quoting; posix=False keeps Windows backslash paths intact.
    argv = shlex.split(command, posix=(os.name != "nt"))
    try:
        result = subprocess.run(
            argv, shell=False, capture_output=True, text=True,
            timeout=3600, cwd=exec_dir, env=env,
        )
        stdout = result.stdout[:MAX_OUTPUT_SIZE] if result.stdout else ""
        stderr = result.stderr[:MAX_OUTPUT_SIZE] if result.stderr else ""

        if result.returncode == 0:
            # False-success guard: check stderr for crash indicators
            # Wrapper scripts may swallow errors and exit 0
            crash_indicators = [
                "segmentation fault", "sigsegv", "sigkill",
                "killed", "fatal error", "panic:",
                "generation failed", "traceback (most recent call last)",
            ]
            stderr_check = stderr.lower()
            false_success = any(ind in stderr_check for ind in crash_indicators)
            if false_success:
                error = categorize_error(stderr, -1, job, system_info)
                error["stdout"] = stdout[-5000:]
                error["stderr"] = stderr[-5000:]
                error["false_success"] = True
                error["message"] = "Process exited 0 but stderr indicates failure: " + error.get("message", "")
                return False, error
            return True, {
                "stdout": stdout[-10000:],
                "exit_code": 0,
            }
        else:
            error = categorize_error(stderr, result.returncode, job, system_info)
            error["stdout"] = stdout[-5000:]
            error["stderr"] = stderr[-5000:]
            return False, error

    except subprocess.TimeoutExpired:
        return False, {
            "error_type": "timeout",
            "message": "Job timed out after 3600 seconds (1 hour).",
            "suggestion": "The job is taking too long. Check for infinite loops or reduce workload size.",
        }
    except Exception as e:
        return False, {
            "error_type": "execution_error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run_drone(api, agent_id, capabilities, poll_interval, heartbeat_interval, work_dir, system_info):
    """Main polling loop."""
    last_heartbeat = 0
    consecutive_errors = 0
    jobs_completed = 0
    jobs_failed = 0

    # Initial boot
    try:
        boot = api.get(f"/boot/{agent_id}")
        tasks = boot.get("tasks", [])
        msgs = boot.get("new_messages", [])
        print(f"Boot: {len(tasks)} tasks, {len(msgs)} messages")
        if boot.get("pending_directives"):
            print(f"  WARNING: {len(boot['pending_directives'])} pending directive(s) — check dashboard!")
    except Exception as e:
        print(f"Boot failed (non-fatal): {e}")

    # Go online with full diagnostics
    try:
        api.heartbeat(
            "Drone online, polling for jobs",
            state_snapshot={
                "system_info": system_info,
                "warnings": get_warnings(system_info),
                "capabilities": capabilities,
                "worker_version": VERSION,
            }
        )
        last_heartbeat = time.time()
        print("Status: ONLINE")
    except Exception as e:
        print(f"Heartbeat failed: {e}")

    print(f"\nPolling for jobs every {poll_interval}s... (Ctrl+C to stop)\n")

    while True:
        try:
            # Periodic heartbeat
            now = time.time()
            if now - last_heartbeat >= heartbeat_interval:
                status_msg = "Idle, polling for jobs"
                if jobs_completed or jobs_failed:
                    status_msg += f" (completed: {jobs_completed}, failed: {jobs_failed})"
                api.heartbeat(status_msg)
                last_heartbeat = now

            # Poll for job
            result = api.claim_job(capabilities)
            job = result.get("job")

            if job:
                consecutive_errors = 0
                job_id = job["id"]
                title = job.get("title", "unknown")
                print(f"\n{'='*60}")
                print(f"[Job #{job_id}] {title}")
                print(f"{'='*60}")

                api.heartbeat(f"Running job #{job_id}: {title}")
                last_heartbeat = time.time()

                success, result_data = execute_job(api, job, system_info, work_dir)

                if success:
                    jobs_completed += 1
                    print(f"[Job #{job_id}] COMPLETED")
                    update_job_with_retry(api, job_id, {
                        "status": "completed",
                        "result_data": json.dumps(result_data),
                    })
                else:
                    jobs_failed += 1
                    error_type = result_data.get("error_type", "unknown")
                    message = result_data.get("message", "Unknown error")
                    suggestion = result_data.get("suggestion", "")

                    print(f"[Job #{job_id}] FAILED")
                    print(f"  Type:       {error_type}")
                    print(f"  Error:      {message[:200]}")
                    if suggestion:
                        print(f"  Fix:        {suggestion[:200]}")

                    update_job_with_retry(api, job_id, {
                        "status": "failed",
                        "error": f"[{error_type}] {message}",
                        "result_data": json.dumps(result_data),
                    })

                api.heartbeat("Idle, polling for jobs")
                last_heartbeat = time.time()
                print()
            else:
                consecutive_errors = 0
                time.sleep(poll_interval)

        except KeyboardInterrupt:
            print("\nShutting down...")
            try:
                api.heartbeat("Offline")
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
    parser = argparse.ArgumentParser(
        description="Mycelium Drone Worker v" + VERSION,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python drone-worker.py --key YOUR_API_KEY
  python drone-worker.py --key YOUR_API_KEY --capabilities gpu,cpu
  python drone-worker.py --check  (validate environment without starting)
        """
    )
    parser.add_argument("--key", help="Agent API key (X-Agent-Key)")
    parser.add_argument("--agent-id", default="", help="Agent ID (auto-detected if not set)")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Mycelium server (default: {DEFAULT_SERVER})")
    parser.add_argument("--capabilities", default=",".join(DEFAULT_CAPABILITIES),
                        help=f"Comma-separated capabilities (default: {','.join(DEFAULT_CAPABILITIES)})")
    parser.add_argument("--poll-interval", type=int, default=DEFAULT_POLL_INTERVAL,
                        help=f"Seconds between polls (default: {DEFAULT_POLL_INTERVAL})")
    parser.add_argument("--heartbeat-interval", type=int, default=DEFAULT_HEARTBEAT_INTERVAL,
                        help=f"Seconds between heartbeats (default: {DEFAULT_HEARTBEAT_INTERVAL})")
    parser.add_argument("--work-dir", default=None, help="Override working directory for job execution")
    parser.add_argument("--check", action="store_true", help="Check environment and exit (no API key needed)")
    args = parser.parse_args()

    # Collect system info
    system_info = get_system_info()
    print_diagnostics(system_info)

    # Check-only mode
    if args.check:
        warnings = get_warnings(system_info)
        if warnings:
            print("ISSUES FOUND. Fix the warnings above before running jobs.")
            sys.exit(1)
        else:
            print("Environment looks good! Ready to run drone jobs.")
            sys.exit(0)

    # Require key for actual operation
    if not args.key:
        print("ERROR: --key is required. Get your API key from the Mycelium admin.")
        print("Usage: python drone-worker.py --key YOUR_API_KEY")
        sys.exit(1)

    capabilities = [c.strip() for c in args.capabilities.split(",") if c.strip()]
    api = MyceliumAPI(args.server, args.key)

    # Ensure directories exist
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    ARTIFACT_CACHE.mkdir(parents=True, exist_ok=True)

    # Verify connection + detect agent ID
    agent_id = args.agent_id
    try:
        # Try to list agents to verify auth
        agents = api.get("/agents")
        print(f"Connected to Mycelium at {args.server}")

        # If no agent ID specified, try to detect from the key
        if not agent_id:
            # The key belongs to an agent — try boot with common drone IDs
            for try_id in ["unakron-gpu", "unakron-gpu-2"]:
                try:
                    api.get(f"/boot/{try_id}")
                    agent_id = try_id
                    print(f"Auto-detected agent: {agent_id}")
                    break
                except Exception:
                    continue
            if not agent_id:
                print("ERROR: Could not detect agent ID. Use --agent-id YOUR_DRONE_ID")
                sys.exit(1)
    except requests.exceptions.HTTPError as e:
        if hasattr(e, 'response') and e.response is not None and e.response.status_code == 401:
            print("ERROR: Invalid API key. Check your --key value.")
            print("Get your key from the Mycelium admin (it's shown once at registration).")
            sys.exit(1)
        raise
    except requests.exceptions.ConnectionError:
        print(f"ERROR: Cannot connect to {args.server}")
        print("Check your internet connection and the server URL.")
        sys.exit(1)

    print(f"  Agent:        {agent_id}")
    print(f"  Capabilities: {capabilities}")
    print(f"  Poll:         every {args.poll_interval}s")
    print(f"  Workspaces:   {WORKSPACE_ROOT}")
    print()

    run_drone(api, agent_id, capabilities, args.poll_interval, args.heartbeat_interval,
              args.work_dir, system_info)


if __name__ == "__main__":
    main()

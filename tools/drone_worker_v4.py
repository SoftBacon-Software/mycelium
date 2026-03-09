#!/usr/bin/env python3
"""
Mycelium Drone Worker v4.0
==========================
Security-hardened compute worker. Polls Mycelium for jobs and executes them
with operator oversight: approval gate, command whitelist, verbose logging,
and no auto-updates.

Targets Ubuntu 22.04 LTS. Use python3 explicitly.

Setup:
  pip3 install requests

Usage:
  python3 drone_worker_v4.py --key YOUR_API_KEY
  python3 drone_worker_v4.py --key YOUR_API_KEY --verbose
  python3 drone_worker_v4.py --key YOUR_API_KEY --no-approval   # headless (warn)
  python3 drone_worker_v4.py --key YOUR_API_KEY --whitelist python3,pip3,git
  python3 drone_worker_v4.py --check   # validate environment, no key needed

Security features (v4):
  1. Approval gate  — operator must type 'y' before any job runs
  2. Verbose mode   — every subprocess call is logged before execution
  3. Whitelist      — only explicitly allowed commands may run
  4. No auto-update — self-modifying commands require manual confirmation
"""

import argparse
import json
import os
import platform
import re
import shutil
import sys
import time
import traceback
from pathlib import Path

try:
    import requests
except ImportError:
    print("=" * 60)
    print("SETUP REQUIRED")
    print()
    print("  pip3 install requests")
    print()
    print("Then re-run this script.")
    print("=" * 60)
    sys.exit(1)

VERSION = "4.0.1"
DEFAULT_SERVER = "https://mycelium.fyi"
DEFAULT_CAPABILITIES = ["cpu", "gpu"]
DEFAULT_POLL_INTERVAL = 15
DEFAULT_HEARTBEAT_INTERVAL = 120
MAX_OUTPUT_SIZE = 50_000
WORKSPACE_ROOT = Path.home() / ".mycelium" / "workspaces"
ARTIFACT_CACHE = Path.home() / ".mycelium" / "artifacts"
WHITELIST_FILE = Path.home() / ".mycelium" / "whitelist.txt"

# Default allowed commands — operator can extend via --whitelist or whitelist.txt
DEFAULT_ALLOWED_COMMANDS = {
    "python3", "python",
    "pip3", "pip",
    "git",
    "bash", "sh",
    "curl", "wget",
    "unzip", "tar",
    "cp", "mv", "mkdir", "rm",
    "nvidia-smi",
}

# Self-script name — used to detect self-modifying commands
SELF_SCRIPT = Path(__file__).resolve()


# ---------------------------------------------------------------------------
# Security: whitelist enforcement
# ---------------------------------------------------------------------------

def load_whitelist_file():
    """Load extra allowed commands from ~/.mycelium/whitelist.txt."""
    if not WHITELIST_FILE.exists():
        return set()
    commands = set()
    with open(WHITELIST_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                commands.add(line)
    return commands


def extract_commands(shell_cmd):
    """
    Extract base command names from a shell string.
    Splits on shell operators (;, &&, ||, |) and handles env var prefixes.
    Returns list of bare command names (no path, no args).
    """
    # Split on shell control operators (not inside quotes — best-effort)
    parts = re.split(r'[;|]+|&&|\|\|', shell_cmd)
    names = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        tokens = part.split()
        if not tokens:
            continue
        # Skip env var assignments like KEY=val at the start
        i = 0
        while i < len(tokens) and re.match(r'^\w+=', tokens[i]):
            i += 1
        if i >= len(tokens):
            continue
        cmd = tokens[i]
        # Get base name (strip path like /usr/bin/python3 → python3)
        base = os.path.basename(cmd)
        # Skip false positives: URL path components, Python expressions, quoted fragments.
        # These arise when ; or | inside a quoted -c "..." string causes a false split.
        if (
            '://' in cmd          # URL argument (e.g. https://host/path/file.py)
            or '(' in base        # Python function call fragment
            or base.startswith("'")  # Leading quote = inside a shell string
            or base.startswith('"')  # Same for double quotes
            or re.search(r"[',]$", base)  # Trailing quote/comma = mid-expression
        ):
            continue
        names.append(base)
    return names


def check_whitelist(command, allowed):
    """
    Validate all commands in a shell string against the allowed set.
    Returns list of blocked command names (empty = all allowed).
    """
    found = extract_commands(command)
    return [c for c in found if c not in allowed]


# ---------------------------------------------------------------------------
# Security: self-update detection
# ---------------------------------------------------------------------------

def is_self_modifying(command):
    """
    Return True if the command appears to modify this worker script.
    Catches patterns like:  > drone_worker_v4.py,  tee drone_worker_v4.py,
    cp newfile drone_worker_v4.py,  pip install mycelium-worker.
    """
    script_name = SELF_SCRIPT.name
    stem = SELF_SCRIPT.stem  # drone_worker_v4
    cmd_lower = command.lower()

    # Redirect-write to script file
    if re.search(rf'>\s*{re.escape(script_name)}', command):
        return True
    # tee / cp / mv targeting script
    if re.search(rf'\b(tee|cp|mv)\b.*\b{re.escape(script_name)}\b', command):
        return True
    # pip install of a package that sounds like us
    if re.search(r'\bpip3?\b.*install.*\bmycelium.*(worker|drone)', cmd_lower):
        return True
    # curl/wget piped to python (script injection)
    if re.search(r'(curl|wget).*\|\s*(python3?|bash|sh)', cmd_lower):
        return True

    return False


# ---------------------------------------------------------------------------
# Security: approval gate
# ---------------------------------------------------------------------------

def prompt_approval(job_id, title, command, verbose=False):
    """
    Print job details and prompt operator for y/n approval.
    Returns True if approved. On non-TTY stdin, always returns False
    unless --no-approval is set (handled at caller level).
    """
    print()
    print("┌" + "─" * 58 + "┐")
    print("│  APPROVAL REQUIRED — Drone Worker v4                  │")
    print("├" + "─" * 58 + "┤")
    print(f"│  Job #{job_id}: {title[:50]:<50}│")
    print("├" + "─" * 58 + "┤")
    # Wrap command display
    cmd_display = command if len(command) <= 54 else command[:51] + "..."
    print(f"│  Command: {cmd_display:<48}│")
    if len(command) > 54:
        # Show next line
        rest = command[51:]
        rest_display = rest[:54] if len(rest) <= 54 else rest[:51] + "..."
        print(f"│           {rest_display:<48}│")
    print("└" + "─" * 58 + "┘")
    print()

    if not sys.stdin.isatty():
        print("  WARNING: stdin is not a TTY — cannot prompt. Rejecting job.")
        print("  Use --no-approval to run headless (insecure).")
        return False

    try:
        answer = input("  Approve this job? [y/N] ").strip().lower()
        approved = answer == "y"
        if approved:
            print("  Approved.")
        else:
            print("  Rejected.")
        print()
        return approved
    except (EOFError, KeyboardInterrupt):
        print("\n  Interrupted — rejecting job.")
        return False


# ---------------------------------------------------------------------------
# Verbose subprocess runner
# ---------------------------------------------------------------------------

class Runner:
    """Subprocess wrapper that logs calls in verbose mode."""

    def __init__(self, verbose=False):
        self.verbose = verbose

    def run(self, cmd, shell=False, capture_output=True, text=True,
            timeout=None, cwd=None, env=None, check=False):
        if self.verbose:
            cmd_str = cmd if isinstance(cmd, str) else " ".join(str(c) for c in cmd)
            print(f"  [RUN]  {cmd_str[:200]}")
            if cwd:
                print(f"  [CWD]  {cwd}")

        import subprocess
        return subprocess.run(
            cmd,
            shell=shell,
            capture_output=capture_output,
            text=text,
            timeout=timeout,
            cwd=cwd,
            env=env,
            check=check,
        )

    def run_streaming(self, cmd, shell=True, cwd=None, env=None, timeout=None):
        """Run command with real-time output streaming (verbose mode)."""
        import subprocess
        cmd_str = cmd if isinstance(cmd, str) else " ".join(str(c) for c in cmd)
        if self.verbose:
            print(f"  [RUN]  {cmd_str[:200]}")
            if cwd:
                print(f"  [CWD]  {cwd}")

        stdout_lines = []
        stderr_lines = []

        proc = subprocess.Popen(
            cmd,
            shell=shell,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=cwd,
            env=env,
        )

        import threading

        def drain(stream, buf, prefix):
            for line in stream:
                line = line.rstrip("\n")
                buf.append(line)
                if self.verbose:
                    print(f"  {prefix} {line}")

        t_out = threading.Thread(target=drain, args=(proc.stdout, stdout_lines, "[OUT]"))
        t_err = threading.Thread(target=drain, args=(proc.stderr, stderr_lines, "[ERR]"))
        t_out.start()
        t_err.start()

        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            t_out.join(timeout=5)
            t_err.join(timeout=5)
            raise

        t_out.join()
        t_err.join()

        stdout = "\n".join(stdout_lines)
        stderr = "\n".join(stderr_lines)

        # Build a result-like object
        class Result:
            pass
        r = Result()
        r.returncode = proc.returncode
        r.stdout = stdout
        r.stderr = stderr
        return r


# ---------------------------------------------------------------------------
# System diagnostics (unchanged from v2, still useful)
# ---------------------------------------------------------------------------

def get_system_info():
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
    try:
        usage = shutil.disk_usage(Path.home())
        info["disk_free_gb"] = round(usage.free / (1024 ** 3), 1)
        info["disk_total_gb"] = round(usage.total / (1024 ** 3), 1)
    except Exception:
        pass

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
            info["gpu_vram_gb"] = round(vram / (1024 ** 3), 1)
            info["gpu_count"] = torch.cuda.device_count()
    except ImportError:
        info["torch_version"] = None
    except Exception as e:
        info["torch_error"] = str(e)

    if not info.get("gpu_name"):
        try:
            r = __import__("subprocess").run(
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

    for tool in ["git", "curl", "pip3"]:
        try:
            r = __import__("subprocess").run(
                [tool, "--version"], capture_output=True, text=True, timeout=10
            )
            info[f"has_{tool}"] = r.returncode == 0
            if r.returncode == 0:
                info[f"{tool}_version"] = r.stdout.strip().split("\n")[0][:100]
        except Exception:
            info[f"has_{tool}"] = False

    # Ubuntu 22.04 specific: check python3 is available
    try:
        r = __import__("subprocess").run(
            ["python3", "--version"], capture_output=True, text=True, timeout=10
        )
        info["has_python3"] = r.returncode == 0
        if r.returncode == 0:
            info["python3_version"] = r.stdout.strip() or r.stderr.strip()
    except Exception:
        info["has_python3"] = False

    return info


def get_warnings(info):
    warnings = []
    pv = info.get("python_version", "")
    major_minor = tuple(int(x) for x in pv.split(".")[:2]) if pv else (0, 0)

    if major_minor >= (3, 13):
        warnings.append(
            f"Python {pv} is too new for PyTorch. Install Python 3.11 or 3.12."
        )
    elif major_minor < (3, 8):
        warnings.append(f"Python {pv} is too old. Install Python 3.11+.")

    if not info.get("torch_version") and info.get("gpu_name"):
        warnings.append(
            "PyTorch not installed but GPU detected. Install with CUDA:\n"
            "         pip3 install torch torchvision torchaudio "
            "--index-url https://download.pytorch.org/whl/cu124"
        )
    if info.get("torch_version") and not info.get("cuda_available") and info.get("gpu_name"):
        warnings.append(
            "PyTorch installed but CUDA unavailable (CPU-only torch?).\n"
            "         Reinstall: pip3 install torch torchvision torchaudio "
            "--index-url https://download.pytorch.org/whl/cu124"
        )
    if info.get("disk_free_gb") and info["disk_free_gb"] < 10:
        warnings.append(f"Low disk space: {info['disk_free_gb']} GB free. Need 10+ GB.")
    if not info.get("has_python3"):
        warnings.append("python3 not found. Install python3 (Ubuntu: sudo apt install python3).")

    return warnings


def print_diagnostics(info, allowed_commands):
    print("=" * 60)
    print(f"  Mycelium Drone Worker v{VERSION}  [SECURITY HARDENED]")
    print("=" * 60)
    print()
    print(f"  OS:        {info['os']} {info.get('os_release', '')} ({info['machine']})")
    print(f"  Python:    {info['python_version']} ({info['python_path']})")
    print(f"  Hostname:  {info.get('hostname', 'unknown')}")
    print(f"  Disk:      {info.get('disk_free_gb', '?')} GB free / {info.get('disk_total_gb', '?')} GB total")
    print()

    if info.get("cuda_available"):
        print(f"  GPU:       {info.get('gpu_name', 'unknown')}")
        print(f"  VRAM:      {info.get('gpu_vram_gb', '?')} GB")
        print(f"  CUDA:      {info.get('cuda_version', 'unknown')}")
        print(f"  PyTorch:   {info.get('torch_version', 'not installed')}")
    elif info.get("gpu_name"):
        print(f"  GPU:       {info.get('gpu_name')} (nvidia-smi)")
        print(f"  VRAM:      {info.get('gpu_vram_gb', '?')} GB")
        torch_v = info.get("torch_version")
        print(f"  PyTorch:   {torch_v if torch_v else 'NOT INSTALLED'}")
    else:
        print("  GPU:       None detected")
    print()

    print(f"  Whitelist: {', '.join(sorted(allowed_commands))}")
    print()

    warnings = get_warnings(info)
    if warnings:
        print("  WARNINGS:")
        for w in warnings:
            print(f"    ! {w}")
        print()


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
        try:
            return self.get("/drones/artifacts")
        except Exception:
            return []

    def upload_file(self, name, file_path):
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
    ws = WORKSPACE_ROOT / workspace_name
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def download_artifacts(api, artifact_names, workspace, runner):
    successes = []
    failures = []

    for name in artifact_names:
        if isinstance(name, dict):
            name = name.get("name", str(name))

        dest = workspace / name
        cache = ARTIFACT_CACHE / name

        # Check server size
        try:
            artifacts = api.get_artifact_info()
            server_info = None
            if isinstance(artifacts, list):
                server_info = next((a for a in artifacts if a.get("name") == name), None)
            elif isinstance(artifacts, dict) and "artifacts" in artifacts:
                server_info = next((a for a in artifacts["artifacts"] if a.get("name") == name), None)
        except Exception:
            server_info = None

        if cache.exists():
            cache_size = cache.stat().st_size
            server_size = server_info.get("size", 0) if server_info else 0
            if server_size and abs(cache_size - server_size) < 100:
                if not dest.exists() or dest.stat().st_size != cache_size:
                    shutil.copy2(cache, dest)
                successes.append(name)
                if runner.verbose:
                    print(f"    [cached] {name} ({cache_size // 1024} KB)")
                else:
                    print(f"    [cached] {name}")
                continue

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
# Error categorization (carried forward from v2)
# ---------------------------------------------------------------------------

def categorize_error(stderr, exit_code, system_info):
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

    checks = [
        ("no matching distribution found for torch", "env_python_version",
         "PyTorch is not available for this Python version.",
         "Install Python 3.11 or 3.12."),
        ("no module named 'torch'", "env_missing_torch",
         "PyTorch is not installed.",
         "pip3 install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124"),
        ("cuda" and "not available", "env_no_cuda",
         "CUDA is not available.",
         "Check nvidia-smi, then reinstall PyTorch with CUDA."),
        ("command not found", "env_missing_command",
         "A command was not found in PATH.",
         "Check the job command is whitelisted and installed on this machine."),
        ("no such file or directory", "path_not_found",
         "A referenced file or directory does not exist.",
         "Check artifact names and relative paths."),
        ("no space left", "env_disk_full",
         "Disk is full.",
         f"Free up disk space. Current free: {system_info.get('disk_free_gb', '?')} GB."),
        ("out of memory", "gpu_oom",
         "GPU ran out of memory.",
         f"VRAM: {system_info.get('gpu_vram_gb', '?')} GB. Reduce batch size or resolution."),
    ]

    for pattern, etype, msg, suggestion in checks:
        if isinstance(pattern, str) and pattern in stderr_lower:
            error["error_type"] = etype
            error["message"] = msg
            error["suggestion"] = suggestion
            return error

    if "no module named" in stderr_lower:
        for line in stderr.split("\n"):
            if "no module named" in line.lower():
                error["error_type"] = "env_missing_module"
                error["message"] = line.strip()
                module = line.split("'")[-2] if "'" in line else "unknown"
                error["suggestion"] = f"pip3 install {module}"
                return error

    # Signal-killed
    signal_names = {
        9: "SIGKILL (OOM-killed by OS)",
        11: "SIGSEGV (segfault — likely GPU OOM or driver crash)",
        6: "SIGABRT",
        15: "SIGTERM",
    }
    signal_num = None
    if exit_code is not None:
        if exit_code < 0:
            signal_num = abs(exit_code)
        elif 128 < exit_code <= 159:
            signal_num = exit_code - 128
    if signal_num and signal_num in signal_names:
        error["error_type"] = "signal_killed"
        error["message"] = f"Process killed: signal {signal_num} — {signal_names[signal_num]}"
        if signal_num in (9, 11):
            error["suggestion"] = (
                f"VRAM: {system_info.get('gpu_vram_gb', '?')} GB. "
                "Likely GPU/RAM exhaustion. Reduce batch size."
            )
        return error

    # Generic
    meaningful = [
        l.strip() for l in stderr.split("\n")
        if l.strip() and not l.strip().startswith("%") and "% Total" not in l
    ]
    error["message"] = meaningful[-1][:500] if meaningful else f"Exit code {exit_code}"
    error["suggestion"] = "Check full stderr output for details."
    return error


# ---------------------------------------------------------------------------
# Job execution (security-aware)
# ---------------------------------------------------------------------------

def update_job_with_retry(api, job_id, fields, retries=3):
    for attempt in range(retries):
        try:
            api.update_job(job_id, fields)
            return True
        except Exception as e:
            print(f"  WARNING: Failed to update job #{job_id} (attempt {attempt+1}/{retries}): {e}")
            if attempt < retries - 1:
                time.sleep(5 * (attempt + 1))
    print(f"  ERROR: Could not update job #{job_id} after {retries} attempts.")
    return False


def execute_job(api, job, system_info, runner, allowed_commands,
                require_approval, work_dir=None):
    """
    Execute a drone job with full security checks.
    Security order: whitelist check → self-update check → approval gate → run.
    Returns (success, result_data_dict).
    """
    import subprocess

    job_id = job["id"]
    command = job.get("command", "")
    title = job.get("title", "")

    input_data = job.get("input_data", "{}")
    if isinstance(input_data, str):
        try:
            input_data = json.loads(input_data)
        except json.JSONDecodeError:
            input_data = {}

    workspace_name = input_data.get("workspace_dir", f"job_{job_id}")
    workspace = ensure_workspace(workspace_name)
    exec_dir = work_dir or str(workspace)

    print(f"  Workspace: {workspace}")

    # ── Security check 1: whitelist ──────────────────────────────────────
    if command:
        blocked = check_whitelist(command, allowed_commands)
        if blocked:
            msg = f"Blocked commands not in whitelist: {', '.join(blocked)}"
            print(f"  SECURITY: {msg}")
            print(f"  Allowed: {', '.join(sorted(allowed_commands))}")
            print(f"  Add to whitelist with: --whitelist {','.join(sorted(allowed_commands | set(blocked)))}")
            return False, {
                "error_type": "security_whitelist",
                "message": msg,
                "suggestion": f"Add these commands to the whitelist: {', '.join(blocked)}",
                "blocked_commands": blocked,
            }
        if runner.verbose:
            cmds_found = extract_commands(command)
            print(f"  [WHITELIST] Commands: {cmds_found} — all allowed")

    # ── Security check 2: self-update detection ───────────────────────────
    if command and is_self_modifying(command):
        print()
        print("  !! SELF-MODIFYING COMMAND DETECTED !!")
        print(f"  Command: {command[:200]}")
        print()
        print("  This command appears to modify the drone worker script.")
        print("  Auto-update is disabled in v4. To update manually:")
        print("    1. Stop the worker (Ctrl+C)")
        print("    2. Download the new version from Mycelium")
        print("    3. Restart the worker")
        print()

        if not sys.stdin.isatty():
            return False, {
                "error_type": "security_self_update",
                "message": "Self-modifying command rejected (auto-update disabled).",
                "suggestion": "Update the worker manually. Stop, download, restart.",
            }

        try:
            answer = input("  Override and allow anyway? [y/N] ").strip().lower()
            if answer != "y":
                return False, {
                    "error_type": "security_self_update",
                    "message": "Self-modifying command rejected by operator.",
                    "suggestion": "Update the worker manually.",
                }
            print("  Self-update override approved by operator.")
        except (EOFError, KeyboardInterrupt):
            return False, {
                "error_type": "security_self_update",
                "message": "Self-modifying command rejected (interrupted).",
            }

    # ── Security check 3: approval gate ──────────────────────────────────
    if require_approval and command:
        approved = prompt_approval(job_id, title, command, verbose=runner.verbose)
        if not approved:
            return False, {
                "error_type": "operator_rejected",
                "message": "Job rejected by operator at approval gate.",
                "suggestion": "Operator declined to run this job. Check the command.",
            }

    # ── Download artifacts ─────────────────────────────────────────────────
    artifacts = input_data.get("artifacts", [])
    if artifacts:
        print(f"  Downloading {len(artifacts)} artifact(s)...")
        successes, failures = download_artifacts(api, artifacts, workspace, runner)
        if failures:
            return False, {
                "error_type": "download_failed",
                "message": f"Failed to download {len(failures)} artifact(s): "
                           f"{', '.join(f['name'] for f in failures)}",
                "suggestion": "Check artifacts exist on the server (GET /drones/artifacts).",
                "failures": failures,
            }

    # ── Run setup command ──────────────────────────────────────────────────
    setup_cmd = input_data.get("setup")
    setup_marker = Path.home() / ".mycelium" / ".setup_done" / workspace_name
    if setup_cmd and not setup_marker.exists():
        # Whitelist check setup command too
        if allowed_commands:
            blocked = check_whitelist(setup_cmd, allowed_commands)
            if blocked:
                return False, {
                    "error_type": "security_whitelist",
                    "message": f"Setup command blocked — not in whitelist: {', '.join(blocked)}",
                    "blocked_commands": blocked,
                }

        print(f"  Running setup: {setup_cmd[:100]}...")
        try:
            r = runner.run_streaming(
                setup_cmd, shell=True, cwd=str(workspace),
                env={**os.environ, "MYCELIUM_JOB_ID": str(job_id)},
                timeout=1800,
            )
            if r.returncode != 0:
                stderr = r.stderr[:MAX_OUTPUT_SIZE] if r.stderr else ""
                error = categorize_error(stderr, r.returncode, system_info)
                error["phase"] = "setup"
                error["stdout"] = r.stdout[-5000:]
                error["stderr"] = stderr[-5000:]
                return False, error
            setup_marker.parent.mkdir(parents=True, exist_ok=True)
            setup_marker.touch()
            print("  Setup complete.")
        except subprocess.TimeoutExpired:
            return False, {
                "error_type": "setup_timeout",
                "message": "Setup timed out after 30 minutes.",
                "suggestion": "Simplify setup command or check network.",
            }
        except Exception as e:
            return False, {"error_type": "setup_error", "message": str(e)}

    # ── Execute main command ───────────────────────────────────────────────
    if not command:
        return False, {
            "error_type": "no_command",
            "message": "No command specified in job.",
        }

    env = os.environ.copy()
    env["MYCELIUM_JOB_ID"] = str(job_id)
    env["MYCELIUM_JOB_INPUT"] = json.dumps(input_data)
    env["MYCELIUM_JOB_TITLE"] = title
    env["MYCELIUM_KEY"] = api.agent_key
    env["MYCELIUM_SERVER"] = api.base.replace("/api/mycelium", "")

    print(f"  Executing: {command[:150]}")
    try:
        r = runner.run_streaming(
            command, shell=True, cwd=exec_dir, env=env, timeout=7200
        )
        stdout = r.stdout[:MAX_OUTPUT_SIZE] if r.stdout else ""
        stderr = r.stderr[:MAX_OUTPUT_SIZE] if r.stderr else ""

        if r.returncode == 0:
            # False-success guard
            crash_indicators = [
                "segmentation fault", "sigsegv", "sigkill", "killed",
                "fatal error", "panic:", "generation failed",
                "traceback (most recent call last)",
            ]
            if any(ind in stderr.lower() for ind in crash_indicators):
                error = categorize_error(stderr, -1, system_info)
                error["stdout"] = stdout[-5000:]
                error["stderr"] = stderr[-5000:]
                error["false_success"] = True
                return False, error
            return True, {"stdout": stdout[-10000:], "exit_code": 0}
        else:
            error = categorize_error(stderr, r.returncode, system_info)
            error["stdout"] = stdout[-5000:]
            error["stderr"] = stderr[-5000:]
            return False, error

    except __import__("subprocess").TimeoutExpired:
        return False, {
            "error_type": "timeout",
            "message": "Job timed out after 7200 seconds (2 hours).",
        }
    except Exception as e:
        return False, {
            "error_type": "execution_error",
            "message": str(e),
            "traceback": traceback.format_exc(),
        }


# ---------------------------------------------------------------------------
# Main polling loop
# ---------------------------------------------------------------------------

def run_drone(api, agent_id, capabilities, poll_interval, heartbeat_interval,
              work_dir, system_info, runner, allowed_commands, require_approval):
    last_heartbeat = 0
    jobs_completed = 0
    jobs_failed = 0
    jobs_skipped = 0
    consecutive_errors = 0

    try:
        boot = api.get(f"/boot/{agent_id}")
        tasks = boot.get("tasks", [])
        msgs = boot.get("new_messages", [])
        print(f"Boot: {len(tasks)} tasks, {len(msgs)} messages")
    except Exception as e:
        print(f"Boot failed (non-fatal): {e}")

    try:
        api.heartbeat(
            "Drone v4 online, polling for jobs",
            state_snapshot={
                "system_info": system_info,
                "warnings": get_warnings(system_info),
                "capabilities": capabilities,
                "worker_version": VERSION,
                "security": {
                    "approval_gate": require_approval,
                    "whitelist": sorted(allowed_commands),
                    "verbose": runner.verbose,
                },
            }
        )
        last_heartbeat = time.time()
        print("Status: ONLINE")
    except Exception as e:
        print(f"Heartbeat failed: {e}")

    mode_flags = []
    if runner.verbose:
        mode_flags.append("VERBOSE")
    if require_approval:
        mode_flags.append("APPROVAL-GATE")
    else:
        mode_flags.append("NO-APPROVAL (headless)")
    print(f"Mode: {', '.join(mode_flags)}")
    print(f"\nPolling every {poll_interval}s... (Ctrl+C to stop)\n")

    while True:
        try:
            now = time.time()
            if now - last_heartbeat >= heartbeat_interval:
                status = "Idle, polling for jobs"
                if jobs_completed or jobs_failed:
                    status += f" (done={jobs_completed}, failed={jobs_failed}, skipped={jobs_skipped})"
                api.heartbeat(status)
                last_heartbeat = now

            result = api.claim_job(capabilities)
            job = result.get("job")

            if job:
                consecutive_errors = 0
                job_id = job["id"]
                title = job.get("title", "unknown")
                print(f"\n{'=' * 60}")
                print(f"[Job #{job_id}] {title}")
                print(f"{'=' * 60}")

                api.heartbeat(f"Running job #{job_id}: {title}")
                last_heartbeat = time.time()

                success, result_data = execute_job(
                    api, job, system_info, runner, allowed_commands,
                    require_approval, work_dir
                )

                error_type = result_data.get("error_type", "")

                if success:
                    jobs_completed += 1
                    print(f"[Job #{job_id}] COMPLETED")
                    update_job_with_retry(api, job_id, {
                        "status": "completed",
                        "result_data": json.dumps(result_data),
                    })
                elif error_type == "operator_rejected":
                    jobs_skipped += 1
                    print(f"[Job #{job_id}] SKIPPED (operator rejected)")
                    update_job_with_retry(api, job_id, {
                        "status": "failed",
                        "error": "Operator rejected at approval gate.",
                        "result_data": json.dumps(result_data),
                    })
                else:
                    jobs_failed += 1
                    message = result_data.get("message", "Unknown error")
                    suggestion = result_data.get("suggestion", "")
                    print(f"[Job #{job_id}] FAILED")
                    print(f"  Type:    {error_type}")
                    print(f"  Error:   {message[:200]}")
                    if suggestion:
                        print(f"  Fix:     {suggestion[:200]}")
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
        description=f"Mycelium Drone Worker v{VERSION} — Security Hardened",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Interactive (approval gate on, default whitelist)
  python3 drone_worker_v4.py --key YOUR_KEY

  # Verbose — logs every command before running
  python3 drone_worker_v4.py --key YOUR_KEY --verbose

  # Headless (no approval gate, e.g. systemd service)
  python3 drone_worker_v4.py --key YOUR_KEY --no-approval

  # Custom whitelist
  python3 drone_worker_v4.py --key YOUR_KEY --whitelist python3,pip3,git

  # Environment check (no key needed)
  python3 drone_worker_v4.py --check
        """
    )
    parser.add_argument("--key", help="Agent API key (X-Agent-Key)")
    parser.add_argument("--agent-id", default="", help="Agent ID (auto-detected if omitted)")
    parser.add_argument("--server", default=DEFAULT_SERVER,
                        help=f"Mycelium server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--capabilities", default=",".join(DEFAULT_CAPABILITIES),
                        help=f"Comma-separated capabilities (default: {','.join(DEFAULT_CAPABILITIES)})")
    parser.add_argument("--poll-interval", type=int, default=DEFAULT_POLL_INTERVAL,
                        help=f"Seconds between polls (default: {DEFAULT_POLL_INTERVAL})")
    parser.add_argument("--heartbeat-interval", type=int, default=DEFAULT_HEARTBEAT_INTERVAL,
                        help=f"Seconds between heartbeats (default: {DEFAULT_HEARTBEAT_INTERVAL})")
    parser.add_argument("--work-dir", default=None,
                        help="Override working directory for job execution")

    # v4 security flags
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Log every subprocess call before executing")
    parser.add_argument("--no-approval", action="store_true",
                        help="Disable approval gate (headless/service mode — use with caution)")
    parser.add_argument("--whitelist", default=None,
                        help="Comma-separated allowed commands (default: python3,pip3,git,...). "
                             "Also reads ~/.mycelium/whitelist.txt")

    parser.add_argument("--check", action="store_true",
                        help="Check environment and exit (no key required)")

    args = parser.parse_args()

    # Build allowed commands set
    allowed_commands = set(DEFAULT_ALLOWED_COMMANDS)
    allowed_commands |= load_whitelist_file()
    if args.whitelist:
        allowed_commands |= {c.strip() for c in args.whitelist.split(",") if c.strip()}

    runner = Runner(verbose=args.verbose)
    system_info = get_system_info()
    print_diagnostics(system_info, allowed_commands)

    if args.check:
        warnings = get_warnings(system_info)
        if warnings:
            print("ISSUES FOUND. Fix warnings above before running jobs.")
            sys.exit(1)
        print("Environment looks good! Ready to run drone jobs.")
        sys.exit(0)

    if not args.key:
        print("ERROR: --key is required.")
        print("Usage: python3 drone_worker_v4.py --key YOUR_API_KEY")
        sys.exit(1)

    require_approval = not args.no_approval
    if not require_approval:
        print()
        print("  !! WARNING: Approval gate DISABLED (--no-approval) !!")
        print("  Jobs will execute without operator confirmation.")
        print("  Only use this mode when running as a supervised service.")
        print()

    capabilities = [c.strip() for c in args.capabilities.split(",") if c.strip()]
    api = MyceliumAPI(args.server, args.key)

    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    ARTIFACT_CACHE.mkdir(parents=True, exist_ok=True)

    # Connect and detect agent ID
    agent_id = args.agent_id
    try:
        api.get("/agents")
        print(f"Connected to Mycelium at {args.server}")

        if not agent_id:
            for try_id in ["unakron-gpu", "unakron-gpu-2"]:
                try:
                    api.get(f"/boot/{try_id}")
                    agent_id = try_id
                    print(f"Auto-detected agent: {agent_id}")
                    break
                except Exception:
                    continue
            if not agent_id:
                print("ERROR: Could not auto-detect agent ID. Use --agent-id YOUR_DRONE_ID")
                sys.exit(1)
    except requests.exceptions.HTTPError as e:
        if hasattr(e, "response") and e.response is not None and e.response.status_code == 401:
            print("ERROR: Invalid API key.")
            sys.exit(1)
        raise
    except requests.exceptions.ConnectionError:
        print(f"ERROR: Cannot connect to {args.server}")
        sys.exit(1)

    print(f"  Agent:        {agent_id}")
    print(f"  Capabilities: {capabilities}")
    print(f"  Poll:         every {args.poll_interval}s")
    print(f"  Workspaces:   {WORKSPACE_ROOT}")
    print()

    run_drone(
        api, agent_id, capabilities,
        args.poll_interval, args.heartbeat_interval,
        args.work_dir, system_info,
        runner, allowed_commands, require_approval,
    )


if __name__ == "__main__":
    # Bug #134/#132: Auto-restart on crash with backoff
    max_restarts = 10
    restart_count = 0
    base_delay = 10  # seconds

    while restart_count < max_restarts:
        try:
            main()
            break  # Clean exit (e.g. KeyboardInterrupt handled inside)
        except KeyboardInterrupt:
            print("\nShutting down.")
            break
        except SystemExit:
            break
        except Exception as e:
            restart_count += 1
            delay = min(base_delay * restart_count, 300)
            print(f"\n{'!' * 60}")
            print(f"CRASH #{restart_count}/{max_restarts}: {e}")
            traceback.print_exc()
            print(f"Restarting in {delay}s...")
            print(f"{'!' * 60}\n")
            time.sleep(delay)

    if restart_count >= max_restarts:
        print(f"Max restarts ({max_restarts}) reached. Exiting. Run again manually.")

#!/usr/bin/env python3
"""
Mycelium Local Admin Agent v2.0
================================
Lightweight admin coordinator that runs locally with a local LLM via ollama.
Monitors the Mycelium network, detects idle agents, assigns work, triages bugs,
and routes messages — all without needing Claude API credits.

Optimized for Apple Silicon (Mac Mini / Mac Studio) with unified memory.
Also works on NVIDIA GPU rigs.

Setup:
  1. Install ollama: https://ollama.com (or: brew install ollama)
  2. python local-admin-agent.py --recommend   # See best model for your hardware
  3. ollama pull <recommended-model>
  4. pip install requests psutil
  5. python local-admin-agent.py --admin-key YOUR_KEY

Usage:
  python local-admin-agent.py --admin-key KPeO7ZspKsAQotZsrvnZ2vYk
  python local-admin-agent.py --admin-key KEY --model qwen2.5:72b --interval 120
  python local-admin-agent.py --check       # Validate setup without starting loop
  python local-admin-agent.py --once        # Run one cycle and exit (for testing)
  python local-admin-agent.py --recommend   # Recommend best model for this hardware
  python local-admin-agent.py --status      # Quick network status (no LLM needed)

Hardware recommendations:
  Mac Mini M4 Pro 24GB  → qwen2.5-coder:32b  (~20 tok/s, good for routine admin)
  Mac Mini M4 Pro 48GB  → qwen2.5:72b        (~12 tok/s, full coordination)
  Mac Studio M4 Max 64GB→ qwen2.5:72b-q6_K   (~18 tok/s, higher quality)
  NVIDIA RTX 3090 24GB  → qwen2.5-coder:32b  (~25 tok/s)
  2x RTX 3090 48GB      → qwen2.5:72b        (~15 tok/s)

The agent will:
  1. Poll Mycelium API every --interval seconds (default: 60)
  2. Build a compact network snapshot (agents, tasks, bugs, messages, drone jobs)
  3. Ask the local LLM to analyze and recommend actions
  4. Execute approved actions via Mycelium API (create tasks, send messages, etc.)
  5. Log all decisions to local-admin.log
  6. Skip LLM call entirely when network is healthy (saves compute)
"""

import argparse
import json
import logging
import os
import platform
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("Setup required: pip install requests")
    sys.exit(1)

VERSION = "2.0.0"
DEFAULT_SERVER = "https://mycelium.fyi"
DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_INTERVAL = 60
LOG_FILE = Path(__file__).parent / "local-admin.log"

# Model recommendations by available memory (GB)
MODEL_TIERS = [
    (64, "qwen2.5:72b",         "Full coordination — best quality"),
    (48, "qwen2.5:72b",         "Full coordination"),
    (24, "qwen2.5-coder:32b",   "Routine admin — good for most tasks"),
    (16, "qwen2.5-coder:14b",   "Light admin — basic monitoring"),
    (8,  "qwen2.5-coder:7b",    "Minimal — status checks only"),
]

# ---------- logging ----------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("admin-agent")

# ---------- Hardware detection ----------

def detect_hardware() -> dict:
    """Detect system hardware for model recommendations."""
    info = {
        "platform": platform.system(),
        "arch": platform.machine(),
        "is_apple_silicon": False,
        "is_nvidia": False,
        "total_ram_gb": 0,
        "gpu_name": "",
        "gpu_vram_gb": 0,
        "recommended_model": "qwen2.5-coder:7b",
        "recommendation_reason": "",
    }

    # Total system RAM
    try:
        import psutil
        info["total_ram_gb"] = round(psutil.virtual_memory().total / (1024**3))
    except ImportError:
        # Fallback without psutil
        if info["platform"] == "Darwin":
            try:
                out = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True).strip()
                info["total_ram_gb"] = round(int(out) / (1024**3))
            except Exception:
                pass
        elif info["platform"] == "Linux":
            try:
                with open("/proc/meminfo") as f:
                    for line in f:
                        if line.startswith("MemTotal:"):
                            kb = int(line.split()[1])
                            info["total_ram_gb"] = round(kb / (1024**2))
                            break
            except Exception:
                pass

    # Apple Silicon detection
    if info["platform"] == "Darwin" and info["arch"] == "arm64":
        info["is_apple_silicon"] = True
        # On Apple Silicon, unified memory = all RAM available for model
        available_gb = info["total_ram_gb"]
        # Leave ~4GB for OS and ollama overhead
        model_budget = available_gb - 4

        try:
            chip = subprocess.check_output(
                ["sysctl", "-n", "machdep.cpu.brand_string"], text=True
            ).strip()
            info["gpu_name"] = chip
        except Exception:
            info["gpu_name"] = "Apple Silicon (unknown)"

        info["gpu_vram_gb"] = available_gb  # unified memory

        for min_gb, model, reason in MODEL_TIERS:
            if model_budget >= min_gb:
                info["recommended_model"] = model
                info["recommendation_reason"] = f"{reason} ({model_budget}GB available for model)"
                break

    # NVIDIA detection
    elif not info["is_apple_silicon"]:
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=name,memory.total",
                 "--format=csv,noheader,nounits"],
                text=True, stderr=subprocess.DEVNULL
            ).strip()
            if out:
                lines = out.strip().split("\n")
                total_vram = 0
                names = []
                for line in lines:
                    parts = line.split(", ")
                    if len(parts) == 2:
                        names.append(parts[0].strip())
                        total_vram += int(parts[1].strip())
                info["is_nvidia"] = True
                info["gpu_name"] = " + ".join(names)
                info["gpu_vram_gb"] = round(total_vram / 1024)
                model_budget = info["gpu_vram_gb"] - 2  # overhead

                for min_gb, model, reason in MODEL_TIERS:
                    if model_budget >= min_gb:
                        info["recommended_model"] = model
                        info["recommendation_reason"] = f"{reason} ({info['gpu_vram_gb']}GB VRAM)"
                        break
        except FileNotFoundError:
            pass

    # CPU-only fallback
    if not info["is_apple_silicon"] and not info["is_nvidia"]:
        info["recommendation_reason"] = "No GPU detected — CPU inference will be slow"
        info["recommended_model"] = "qwen2.5-coder:7b"

    return info


def print_hardware_report(hw: dict):
    """Print a hardware report with model recommendation."""
    print(f"Mycelium Local Admin Agent v{VERSION}")
    print(f"{'='*50}")
    print(f"\nSystem: {hw['platform']} {hw['arch']}")
    print(f"RAM:    {hw['total_ram_gb']}GB")

    if hw["is_apple_silicon"]:
        print(f"Chip:   {hw['gpu_name']}")
        print(f"Memory: {hw['gpu_vram_gb']}GB unified (shared CPU/GPU)")
        print(f"\n  Apple Silicon detected — ollama uses Metal acceleration.")
        print(f"  Entire unified memory pool is available for the model.")
    elif hw["is_nvidia"]:
        print(f"GPU:    {hw['gpu_name']}")
        print(f"VRAM:   {hw['gpu_vram_gb']}GB")
    else:
        print(f"GPU:    None detected (CPU-only)")

    print(f"\n{'='*50}")
    print(f"Recommended model: {hw['recommended_model']}")
    print(f"Reason: {hw['recommendation_reason']}")
    print(f"\nTo install:")
    print(f"  ollama pull {hw['recommended_model']}")
    print(f"\nTo run:")
    print(f"  python {Path(__file__).name} --admin-key YOUR_KEY --model {hw['recommended_model']}")

    # Show all tiers
    print(f"\n{'='*50}")
    print(f"All model tiers:")
    for min_gb, model, reason in MODEL_TIERS:
        marker = " <-- recommended" if model == hw["recommended_model"] else ""
        print(f"  {min_gb:3d}GB+ → {model:25s} {reason}{marker}")


# ---------- API helpers ----------

class MyceliumAPI:
    """Thin wrapper around the Mycelium REST API."""

    def __init__(self, server: str, admin_key: str):
        self.base = f"{server}/api/mycelium"
        self.headers = {
            "X-Admin-Key": admin_key,
            "Content-Type": "application/json",
        }

    def get(self, path: str, params=None):
        r = requests.get(f"{self.base}{path}", headers=self.headers, params=params, timeout=15)
        r.raise_for_status()
        return r.json()

    def post(self, path: str, data: dict):
        r = requests.post(f"{self.base}{path}", headers=self.headers, json=data, timeout=15)
        r.raise_for_status()
        return r.json()

    def put(self, path: str, data: dict):
        r = requests.put(f"{self.base}{path}", headers=self.headers, json=data, timeout=15)
        r.raise_for_status()
        return r.json()

    def overview(self):
        return self.get("/admin/overview")

    def send_message(self, from_agent: str, to_agent: str, content: str):
        return self.post("/messages", {
            "from_agent": from_agent,
            "to_agent": to_agent,
            "content": content,
        })

    def create_task(self, title: str, description: str, project_id: str,
                    assignee: str = None, priority: str = "normal"):
        data = {
            "title": title,
            "description": description,
            "project_id": project_id,
            "priority": priority,
            "needs_approval": 0,
        }
        if assignee:
            data["assignee"] = assignee
        return self.post("/tasks", data)

    def update_task(self, task_id: int, updates: dict):
        return self.put(f"/tasks/{task_id}", updates)

    def list_drone_jobs(self, status: str = None):
        params = {}
        if status:
            params["status"] = status
        return self.get("/drones/jobs", params=params)

    def claim_bug(self, bug_id: int, assignee: str):
        return self.put(f"/bugs/{bug_id}", {"status": "in_progress", "assignee": assignee})


class OllamaLLM:
    """Ollama chat client optimized for Apple Silicon and NVIDIA."""

    def __init__(self, model: str, base_url: str = DEFAULT_OLLAMA_URL,
                 ctx_size: int = 4096, num_predict: int = 1024):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.url = f"{self.base_url}/api/chat"
        self.ctx_size = ctx_size
        self.num_predict = num_predict

    def check(self) -> bool:
        """Verify ollama is running and model is available."""
        try:
            r = requests.get(f"{self.base_url}/api/tags", timeout=5)
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            for m in models:
                if m == self.model or m.startswith(self.model.split(":")[0]):
                    return True
            log.warning(f"Model '{self.model}' not found. Available: {models}")
            return False
        except Exception as e:
            log.error(f"Cannot reach ollama at {self.base_url}: {e}")
            return False

    def get_model_info(self) -> dict:
        """Get loaded model metadata (size, quantization, etc.)."""
        try:
            r = requests.post(f"{self.base_url}/api/show", json={"name": self.model}, timeout=10)
            r.raise_for_status()
            return r.json()
        except Exception:
            return {}

    def chat(self, system_prompt: str, user_message: str) -> str:
        """Send a chat message and return the response text."""
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "stream": False,
            "options": {
                "temperature": 0.2,       # Low temp for consistent admin decisions
                "num_predict": self.num_predict,
                "num_ctx": self.ctx_size,  # Compact context — admin snapshots are small
                "repeat_penalty": 1.1,
            },
        }
        try:
            t0 = time.time()
            r = requests.post(self.url, json=payload, timeout=180)
            r.raise_for_status()
            data = r.json()
            elapsed = time.time() - t0

            content = data["message"]["content"]

            # Log performance metrics
            eval_count = data.get("eval_count", 0)
            eval_duration = data.get("eval_duration", 0)
            if eval_count and eval_duration:
                tps = eval_count / (eval_duration / 1e9)
                log.debug(f"LLM: {eval_count} tokens in {elapsed:.1f}s ({tps:.1f} tok/s)")

            return content
        except requests.Timeout:
            log.error(f"LLM request timed out after 180s")
            return ""
        except Exception as e:
            log.error(f"LLM request failed: {e}")
            return ""


# ---------- Network snapshot ----------

def build_snapshot(api: MyceliumAPI) -> dict:
    """Build a compact network snapshot for the LLM.

    Designed to fit comfortably in a 4K context window.
    Only includes actionable information.
    """
    try:
        overview = api.overview()
    except Exception as e:
        log.error(f"Failed to fetch overview: {e}")
        return None

    agents = overview.get("agents", [])
    tasks = overview.get("tasks", [])
    messages = overview.get("messages", [])
    bugs = overview.get("bugs", [])
    plans = overview.get("plans", [])

    # Summarize agents (compact)
    agent_summary = []
    for a in agents:
        agent_summary.append({
            "id": a["id"],
            "status": a.get("status", "unknown"),
            "working_on": (a.get("working_on", "") or "")[:100],
            "project": a.get("project_id", ""),
        })

    # Open tasks only
    open_tasks = []
    if isinstance(tasks, list):
        for t in tasks:
            if t.get("status") not in ("completed", "cancelled", "done"):
                open_tasks.append({
                    "id": t["id"],
                    "title": t["title"][:60],
                    "status": t["status"],
                    "assignee": t.get("assignee") or "none",
                    "priority": t.get("priority", "normal"),
                })

    # Open bugs only
    open_bugs = []
    if isinstance(bugs, list):
        for b in bugs:
            if b.get("status") in ("open", "in_progress"):
                open_bugs.append({
                    "id": b["id"],
                    "title": b["title"][:60],
                    "severity": b.get("severity", "normal"),
                    "assignee": b.get("assignee") or "none",
                })

    # Last 3 messages (compact)
    recent_msgs = []
    if isinstance(messages, list):
        for m in messages[:3]:
            recent_msgs.append({
                "from": m.get("from_agent", "?"),
                "to": m.get("to_agent") or "all",
                "msg": (m.get("content", "") or "")[:80],
            })

    # Drone jobs — pending or stuck
    drone_status = {"pending": 0, "running": 0, "stuck": []}
    try:
        jobs = api.list_drone_jobs()
        if isinstance(jobs, list):
            for j in jobs:
                s = j.get("status", "")
                if s == "pending":
                    drone_status["pending"] += 1
                elif s in ("claimed", "running"):
                    drone_status["running"] += 1
                    # Check if running too long (>2 hours)
                    created = j.get("claimed_at") or j.get("created_at", "")
                    if created:
                        try:
                            ct = datetime.fromisoformat(created.replace("Z", "+00:00"))
                            age_hours = (datetime.now(timezone.utc) - ct).total_seconds() / 3600
                            if age_hours > 2:
                                drone_status["stuck"].append({
                                    "id": j["id"],
                                    "title": (j.get("title") or "")[:40],
                                    "hours": round(age_hours, 1),
                                })
                        except Exception:
                            pass
    except Exception:
        pass

    # Idle agents
    idle_agents = []
    for a in agent_summary:
        if a["status"] == "online":
            wo = (a.get("working_on") or "").lower()
            if not wo or "idle" in wo or "checking for" in wo or "waiting" in wo:
                idle_agents.append(a["id"])

    # Active plans with pending steps
    plan_summary = []
    if isinstance(plans, list):
        for p in plans:
            if p.get("status") == "active":
                steps = p.get("steps", [])
                pending = [s for s in steps if s.get("status") not in ("completed", "done")]
                if pending:
                    plan_summary.append({
                        "id": p["id"],
                        "title": p["title"][:40],
                        "pending": len(pending),
                        "total": len(steps),
                    })

    return {
        "ts": datetime.now(timezone.utc).strftime("%H:%M:%S"),
        "agents": agent_summary,
        "idle": idle_agents,
        "tasks": open_tasks,
        "bugs": open_bugs,
        "msgs": recent_msgs,
        "drone": drone_status,
        "plans": plan_summary,
        "counts": {
            "online": len([a for a in agent_summary if a["status"] == "online"]),
            "total": len(agents),
            "idle": len(idle_agents),
            "open_tasks": len(open_tasks),
            "unassigned": len([t for t in open_tasks if t["assignee"] == "none"]),
            "open_bugs": len(open_bugs),
            "drone_pending": drone_status["pending"],
            "drone_stuck": len(drone_status["stuck"]),
        },
    }


# ---------- LLM analysis ----------

SYSTEM_PROMPT = """\
You are Mycelium Admin — a coordinator for a distributed dev platform. Analyze the snapshot and output actions.

RULES:
- If everyone is busy and no issues exist, output only: NETWORK_OK
- Otherwise output a JSON array of actions. Nothing else — no markdown, no explanation.
- Don't over-manage. Only act when clearly needed.
- Prefer nudges over new tasks. Only create tasks when an agent is idle with nothing queued.

ACTIONS:
{"action":"msg","to":"AGENT","content":"TEXT"}
{"action":"task","title":"T","desc":"D","project":"P","assignee":"AGENT","priority":"high|normal|low"}
{"action":"log","msg":"observation"}
{"action":"claim_bug","bug_id":N,"assignee":"AGENT"}

AGENTS:
- greatness-claude: Admin. Project: mycelium.
- macbook-claude: Builder. Mycelium platform/dashboard/API.
- hijack-claude: Builder. King City game.
- unakron-gpu: Drone. GPU art generation.

PROJECTS: mycelium, willing-sacrifice, king-city

GUIDELINES:
- Idle agent + open unassigned tasks = assign the task
- Idle agent + no tasks = send status check message
- Open bug with no assignee = assign to relevant agent
- Stuck drone job (>2h) = log warning
- All busy, no bugs, no unassigned = NETWORK_OK"""

def analyze_snapshot(llm: OllamaLLM, snapshot: dict) -> list:
    """Ask the LLM to analyze the snapshot and return recommended actions."""
    # Compact JSON — saves tokens
    user_msg = json.dumps(snapshot, separators=(",", ":"))
    response = llm.chat(SYSTEM_PROMPT, user_msg)

    if not response:
        log.warning("Empty LLM response")
        return []

    response = response.strip()

    if "NETWORK_OK" in response:
        log.info("LLM: NETWORK_OK")
        return []

    # Parse JSON actions from response
    try:
        start = response.find("[")
        end = response.rfind("]") + 1
        if start >= 0 and end > start:
            actions = json.loads(response[start:end])
            if isinstance(actions, list):
                return actions
    except json.JSONDecodeError:
        log.warning(f"Could not parse LLM response: {response[:200]}")

    return []


# ---------- Action executor ----------

def execute_actions(api: MyceliumAPI, actions: list, dry_run: bool = False):
    """Execute the recommended actions via the Mycelium API."""
    for action in actions:
        act = action.get("action", "")
        try:
            if act in ("send_message", "msg"):
                to = action.get("to", "")
                content = action.get("content", "")
                if not to or not content:
                    continue
                if dry_run:
                    log.info(f"[DRY] msg -> {to}: {content[:80]}")
                else:
                    result = api.send_message("__system__", to, f"[local-admin] {content}")
                    log.info(f"msg -> {to}: {content[:80]} (#{result.get('id', '?')})")

            elif act in ("create_task", "task"):
                title = action.get("title", "")
                desc = action.get("desc", action.get("description", ""))
                project = action.get("project", action.get("project_id", "mycelium"))
                assignee = action.get("assignee")
                priority = action.get("priority", "normal")
                if not title:
                    continue
                if dry_run:
                    log.info(f"[DRY] task: {title[:50]} -> {assignee or 'unassigned'}")
                else:
                    result = api.create_task(title, desc, project, assignee, priority)
                    log.info(f"task #{result.get('id', '?')}: {title[:50]}")

            elif act == "claim_bug":
                bug_id = action.get("bug_id")
                assignee = action.get("assignee", "")
                if not bug_id or not assignee:
                    continue
                if dry_run:
                    log.info(f"[DRY] claim bug #{bug_id} -> {assignee}")
                else:
                    api.claim_bug(bug_id, assignee)
                    log.info(f"claimed bug #{bug_id} -> {assignee}")

            elif act == "log":
                msg = action.get("msg", action.get("message", ""))
                log.info(f"[LLM] {msg}")

            else:
                log.warning(f"Unknown action: {act}")

        except Exception as e:
            log.error(f"Action {act} failed: {e}")


# ---------- Quick status (no LLM) ----------

def print_status(api: MyceliumAPI):
    """Print a quick network status without needing the LLM."""
    snapshot = build_snapshot(api)
    if not snapshot:
        print("Failed to connect to Mycelium API")
        return

    c = snapshot["counts"]
    print(f"Mycelium Network Status @ {snapshot['ts']} UTC")
    print(f"{'='*50}")
    print(f"Agents: {c['online']}/{c['total']} online, {c['idle']} idle")
    print()

    for a in snapshot["agents"]:
        icon = "+" if a["status"] == "online" else "-"
        wo = a.get("working_on") or "idle"
        print(f"  {icon} {a['id']:20s} {wo[:60]}")

    if snapshot["tasks"]:
        print(f"\nOpen tasks ({c['open_tasks']}, {c['unassigned']} unassigned):")
        for t in snapshot["tasks"]:
            print(f"  #{t['id']:3d} [{t['priority']:6s}] {t['assignee']:18s} {t['title']}")

    if snapshot["bugs"]:
        print(f"\nOpen bugs ({c['open_bugs']}):")
        for b in snapshot["bugs"]:
            print(f"  #{b['id']:3d} [{b['severity']:6s}] {b['assignee']:18s} {b['title']}")

    drone = snapshot["drone"]
    if drone["pending"] or drone["running"] or drone["stuck"]:
        print(f"\nDrone: {drone['running']} running, {drone['pending']} pending")
        if drone["stuck"]:
            for s in drone["stuck"]:
                print(f"  WARNING: Job #{s['id']} stuck for {s['hours']}h: {s['title']}")

    if snapshot["plans"]:
        print(f"\nActive plans:")
        for p in snapshot["plans"]:
            print(f"  Plan #{p['id']}: {p['title']} ({p['pending']}/{p['total']} pending)")

    if not snapshot["tasks"] and not snapshot["bugs"] and not snapshot["idle"]:
        print(f"\nNetwork healthy. All agents busy, no issues.")


# ---------- Main loop ----------

def needs_llm(snapshot: dict) -> bool:
    """Determine if the LLM needs to be consulted.
    Skip inference when the network is clearly healthy.
    """
    c = snapshot["counts"]
    # LLM needed if: idle agents, unassigned tasks, open bugs, or stuck drones
    return (c["idle"] > 0
            or c["unassigned"] > 0
            or c["open_bugs"] > 0
            or c["drone_stuck"] > 0)


def run_cycle(api: MyceliumAPI, llm: OllamaLLM, dry_run: bool = False) -> bool:
    """Run one admin cycle. Returns True if healthy."""
    log.info("--- cycle ---")

    snapshot = build_snapshot(api)
    if not snapshot:
        log.error("Failed to build snapshot")
        return False

    c = snapshot["counts"]
    log.info(
        f"{c['online']}/{c['total']} online, "
        f"{c['idle']} idle, "
        f"{c['open_tasks']} tasks, "
        f"{c['open_bugs']} bugs, "
        f"drone: {c['drone_pending']}p/{snapshot['drone']['running']}r"
    )

    # Skip LLM when network is healthy — saves compute
    if not needs_llm(snapshot):
        log.info("healthy — skipping LLM")
        return True

    log.info("issues detected — consulting LLM")
    actions = analyze_snapshot(llm, snapshot)

    if actions:
        log.info(f"LLM: {len(actions)} action(s)")
        execute_actions(api, actions, dry_run=dry_run)
    else:
        log.info("LLM: no actions")

    return True


def check_setup(ollama_url: str, model: str, server: str, admin_key: str):
    """Validate all dependencies are working."""
    hw = detect_hardware()
    print(f"Mycelium Local Admin Agent v{VERSION}")
    print(f"{'='*50}")

    # Hardware info
    print(f"\n1. Hardware:")
    if hw["is_apple_silicon"]:
        print(f"   {hw['gpu_name']}")
        print(f"   {hw['total_ram_gb']}GB unified memory")
        print(f"   Metal acceleration: YES")
    elif hw["is_nvidia"]:
        print(f"   {hw['gpu_name']}")
        print(f"   {hw['gpu_vram_gb']}GB VRAM, {hw['total_ram_gb']}GB RAM")
        print(f"   CUDA acceleration: YES")
    else:
        print(f"   {hw['total_ram_gb']}GB RAM, no GPU detected")
        print(f"   WARNING: CPU-only inference will be slow")

    if model != hw["recommended_model"]:
        print(f"   Tip: recommended model for this hardware: {hw['recommended_model']}")

    # Check ollama
    print(f"\n2. Ollama at {ollama_url}...")
    llm = OllamaLLM(model, ollama_url)
    if llm.check():
        print(f"   OK: '{model}' available")
        info = llm.get_model_info()
        if info.get("details"):
            d = info["details"]
            params = d.get("parameter_size", "?")
            quant = d.get("quantization_level", "?")
            print(f"   Parameters: {params}, Quantization: {quant}")
    else:
        print(f"   FAIL: '{model}' not found")
        print(f"   Fix: ollama pull {model}")
        return False

    # Check Mycelium
    print(f"\n3. Mycelium API at {server}...")
    api = MyceliumAPI(server, admin_key)
    try:
        overview = api.overview()
        agents = overview.get("agents", [])
        online = len([a for a in agents if a.get("status") == "online"])
        print(f"   OK: {online}/{len(agents)} agents online")
    except Exception as e:
        print(f"   FAIL: {e}")
        return False

    # LLM inference test
    print(f"\n4. LLM inference test...")
    t0 = time.time()
    response = llm.chat("Reply with exactly: OK", "Test")
    elapsed = time.time() - t0
    if response:
        print(f"   OK: responded in {elapsed:.1f}s: {response.strip()[:40]}")
    else:
        print(f"   FAIL: no response")
        return False

    print(f"\n{'='*50}")
    print("All checks passed. Ready to run.")
    print(f"\nStart with: python {Path(__file__).name} --admin-key KEY --model {model}")
    print(f"Start dry:  python {Path(__file__).name} --admin-key KEY --model {model} --dry-run")
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Mycelium Local Admin Agent — coordinate your AI network with a local LLM",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--admin-key", default=os.environ.get("MYCELIUM_ADMIN_KEY", ""),
                        help="Mycelium admin API key (or MYCELIUM_ADMIN_KEY env)")
    parser.add_argument("--server", default=os.environ.get("MYCELIUM_SERVER", DEFAULT_SERVER),
                        help=f"Mycelium server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--model", default=os.environ.get("OLLAMA_MODEL", ""),
                        help="Ollama model (auto-detected if omitted)")
    parser.add_argument("--ollama-url", default=os.environ.get("OLLAMA_URL", DEFAULT_OLLAMA_URL),
                        help=f"Ollama API URL (default: {DEFAULT_OLLAMA_URL})")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL,
                        help=f"Poll interval in seconds (default: {DEFAULT_INTERVAL})")
    parser.add_argument("--ctx-size", type=int, default=4096,
                        help="LLM context window size (default: 4096)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Analyze but don't execute actions")
    parser.add_argument("--check", action="store_true",
                        help="Validate setup and exit")
    parser.add_argument("--once", action="store_true",
                        help="Run one cycle and exit")
    parser.add_argument("--recommend", action="store_true",
                        help="Recommend best model for this hardware")
    parser.add_argument("--status", action="store_true",
                        help="Quick network status (no LLM needed)")
    args = parser.parse_args()

    # --recommend doesn't need admin key
    if args.recommend:
        hw = detect_hardware()
        print_hardware_report(hw)
        return

    if not args.admin_key:
        print("Error: --admin-key required (or set MYCELIUM_ADMIN_KEY env var)")
        sys.exit(1)

    # --status doesn't need LLM
    if args.status:
        api = MyceliumAPI(args.server, args.admin_key)
        print_status(api)
        return

    # Auto-detect model if not specified
    if not args.model:
        hw = detect_hardware()
        args.model = hw["recommended_model"]
        log.info(f"Auto-selected model: {args.model} ({hw['recommendation_reason']})")

    if args.check:
        ok = check_setup(args.ollama_url, args.model, args.server, args.admin_key)
        sys.exit(0 if ok else 1)

    api = MyceliumAPI(args.server, args.admin_key)
    llm = OllamaLLM(args.model, args.ollama_url, ctx_size=args.ctx_size)

    if not llm.check():
        log.error(f"Model '{args.model}' not available. Run: ollama pull {args.model}")
        sys.exit(1)

    mode = "DRY RUN" if args.dry_run else "LIVE"
    log.info(f"Mycelium Local Admin Agent v{VERSION} ({mode})")
    log.info(f"Server: {args.server} | Model: {args.model} | Interval: {args.interval}s")

    if args.once:
        run_cycle(api, llm, dry_run=args.dry_run)
        return

    try:
        while True:
            try:
                run_cycle(api, llm, dry_run=args.dry_run)
            except Exception as e:
                log.error(f"Cycle failed: {e}\n{traceback.format_exc()}")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log.info("Shutting down.")


if __name__ == "__main__":
    main()

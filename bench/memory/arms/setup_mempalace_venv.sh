#!/usr/bin/env bash
# setup_mempalace_venv.sh — one-time setup for the mempalace CONTROL arm
# (memory benchmark P1, task 263).
#
# MemPalace is Python; the arms are JavaScript. The sidecar
# (mempalace_sidecar.py) drives MemPalace's OWN ingest + search API
# (`mempalace.mcp_server.tool_add_drawer` / `tool_search`) against a per-run
# local ChromaDB palace — never raw chromadb (that is exactly the flaw the
# 2026-10-29 analysis found in MemPalace's own benchmark scripts).
#
# THE PIN — why a commit and not a PyPI version:
#   The brief pins v3.12.0. PyPI tops out at 3.11.0 and GitHub has no v3.12.0
#   TAG: 3.12.0 is the VERSION DECLARED by the `develop` branch's
#   pyproject.toml at the time of writing (verified 2026-10-29, pushed
#   2026-10-28) — unreleased upstream. Per the brief ("the hash of the wheel
#   or commit") this arm therefore pins the COMMIT:
#
#     commit : 84582fb055a6429261f9c779da86c0561ec80adc  (MemPalace/mempalace develop tip)
#     version: 3.12.0 (pyproject.toml [project] version at that commit)
#     tarball: https://codeload.github.com/MemPalace/mempalace/tar.gz/<commit>
#     sha256 : fabe6c765c16fb43b300ddb9f17de44c9f2f3dc6a19e885514fe1659504d762d
#
#   The tarball hash is verified before install; the installed version is
#   asserted (3.12.0) after. The sidecar stamps the version the INSTALLED
#   package reports into the regime and flags a mismatch.
#
# CONFIG (all director-pinned, task 263):
#   raw mode      — verbatim drawers via tool_add_drawer; no LLM in the write path
#   embedder      — MemPalace's default MiniLM (all-MiniLM-L6-v2, 384-dim ONNX
#                   via chromadb). NOTE: this differs from the incumbent arms'
#                   nomic-embed-text (768-dim) DELIBERATELY — a control arm runs
#                   the system AS SHIPPED; the difference is stamped in the regime.
#   no LLM rerank — tool_search's default path is rerank-free and the sidecar
#                   never calls MemPalace's LLM-refine surface.
#   no AAAK       — the compression feature is never invoked.
#
# NETWORK: this script is the ONLY network this arm ever needs — the pinned
# tarball, its PyPI dependencies, and the one-time MiniLM ONNX model download,
# all landed into the venv dir so RUN time is offline (HF_HUB_OFFLINE=1).
#
# Usage:
#   bash bench/memory/arms/setup_mempalace_venv.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VENV_DIR="$REPO_ROOT/bench/memory/.venvs/mempalace"
PY="${MEMPALACE_VENV_PYTHON_BASE:-python3.12}"

MEMPALACE_COMMIT="84582fb055a6429261f9c779da86c0561ec80adc"
MEMPALACE_VERSION="3.12.0"
MEMPALACE_TARBALL_SHA256="fabe6c765c16fb43b300ddb9f17de44c9f2f3dc6a19e885514fe1659504d762d"
TARBALL_URL="https://codeload.github.com/MemPalace/mempalace/tar.gz/${MEMPALACE_COMMIT}"

echo "[setup-mempalace] venv: $VENV_DIR (python: $PY)"
[ -d "$VENV_DIR" ] || "$PY" -m venv "$VENV_DIR"

TMPDIR_MP="$(mktemp -d /tmp/mempalace-pin.XXXXXX)"
trap 'rm -rf "$TMPDIR_MP"' EXIT
TARBALL="$TMPDIR_MP/mempalace-${MEMPALACE_COMMIT:0:8}.tar.gz"
echo "[setup-mempalace] downloading pinned source: $TARBALL_URL"
curl -sL --max-time 300 "$TARBALL_URL" -o "$TARBALL"
echo "[setup-mempalace] verifying tarball sha256 ..."
echo "$MEMPALACE_TARBALL_SHA256  $TARBALL" | shasum -a 256 -c -

echo "[setup-mempalace] pip install (pinned source; deps from PyPI) ..."
"$VENV_DIR/bin/pip" --quiet install "$TARBALL"

echo "[setup-mempalace] asserting installed version == $MEMPALACE_VERSION ..."
"$VENV_DIR/bin/python" - "$MEMPALACE_VERSION" <<'PYEOF'
import sys
from importlib.metadata import version
v = version("mempalace")
if v != sys.argv[1]:
    sys.exit(f"[setup-mempalace] FATAL: installed mempalace {v} != pinned {sys.argv[1]}")
print(f"[setup-mempalace] installed mempalace {v} OK")
PYEOF

echo "[setup-mempalace] pre-warming the MiniLM ONNX embedder into the venv (run time goes offline) ..."
VENV_DIR="$VENV_DIR" "$VENV_DIR/bin/python" - <<'PYEOF'
import os, pathlib
# The cache must live INSIDE the venv so it is gitignored and travels with it;
# the sidecar sets the same override at run time (single source: the venv path).
venv = pathlib.Path(os.environ["VENV_DIR"])
cache = venv / "embedder-cache"
cache.mkdir(parents=True, exist_ok=True)
os.environ["CHROMA_CACHE_PATH"] = ""  # ensure not inherited
os.environ["MEMPALACE_EMBEDDING_MODEL"] = "minilm"
os.environ["HF_HUB_OFFLINE"] = "0"  # the pre-warm IS the one allowed download
from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2
# Redirect the model cache into the venv (chromadb's class resolves its
# download path at class-definition time — override before instantiating).
import chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 as onnxmod
dl = getattr(onnxmod, "DOWNLOAD_PATH", None)
if dl is None:
    dl = getattr(ONNXMiniLM_L6_V2, "DOWNLOAD_PATH", None)
if dl is not None:
    target = str(cache / "onnx_models" / "all-MiniLM-L6-v2")
    if hasattr(onnxmod, "DOWNLOAD_PATH"):
        onnxmod.DOWNLOAD_PATH = target
    if hasattr(ONNXMiniLM_L6_V2, "DOWNLOAD_PATH"):
        ONNXMiniLM_L6_V2.DOWNLOAD_PATH = target
ef = ONNXMiniLM_L6_V2()
vec = ef(["embedder warm-up probe"])
assert vec and len(vec[0]) == 384, f"unexpected MiniLM dims: {len(vec[0])}"
print(f"[setup-mempalace] MiniLM warm OK: 384 dims, cache at {cache}")
PYEOF

echo "[setup-mempalace] DONE — venv at $VENV_DIR"

#!/usr/bin/env python3
"""
Mycelium File Drone — WebSocket-based file server
===================================================
Connects to Mycelium via WebSocket and serves local filesystem
to authenticated users on the network. Like a network drive relay.

Setup:
  pip install websockets

Usage:
  python file_drone.py
  python file_drone.py --config path/to/config.json
  python file_drone.py --root "E:\\"
"""

import asyncio
import base64
import fnmatch
import io
import json
import mimetypes
import os
import platform
import shutil
import sys
import tempfile
import time
import traceback
import zipfile
from pathlib import Path

try:
    import websockets
except ImportError:
    print("Setup required: pip install websockets")
    sys.exit(1)

VERSION = "1.0.0"
BLOCKED_EXTENSIONS = {".exe", ".bat", ".cmd", ".ps1", ".dll", ".com", ".scr", ".pif", ".vbs", ".wsh", ".wsf"}
CHUNK_SIZE = 256 * 1024  # 256KB chunks for file streaming
MAX_SEARCH_RESULTS = 500
MAX_LIST_ENTRIES = 1000


def load_config(config_path=None):
    path = config_path or os.path.join(os.path.dirname(__file__), "file_drone_config.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def safe_resolve(root, rel_path):
    """Resolve a path safely within root. Returns None if traversal detected."""
    root = os.path.realpath(root)
    if not rel_path or rel_path == "/":
        return root
    # Normalize: strip leading slash, convert forward slashes
    clean = rel_path.lstrip("/").replace("/", os.sep)
    target = os.path.realpath(os.path.join(root, clean))
    # Must be within root
    if not target.startswith(root):
        return None
    return target


def get_mime(path):
    mime, _ = mimetypes.guess_type(path)
    return mime or "application/octet-stream"


def get_disk_info(root):
    try:
        usage = shutil.disk_usage(root)
        return {
            "free_gb": round(usage.free / (1024 ** 3), 1),
            "total_gb": round(usage.total / (1024 ** 3), 1),
            "used_gb": round(usage.used / (1024 ** 3), 1),
        }
    except Exception:
        return {}


def format_entry(path, name):
    """Build a directory entry dict."""
    try:
        stat = os.stat(path)
        is_dir = os.path.isdir(path)
        entry = {
            "name": name,
            "type": "directory" if is_dir else "file",
            "size": 0 if is_dir else stat.st_size,
            "modified": int(stat.st_mtime),
        }
        if not is_dir:
            entry["ext"] = os.path.splitext(name)[1].lower()
        return entry
    except (PermissionError, OSError):
        return {"name": name, "type": "unknown", "size": 0, "modified": 0, "error": "access denied"}


def handle_file_list(root, params):
    """List directory contents."""
    rel_path = params.get("path", "/")
    resolved = safe_resolve(root, rel_path)
    if resolved is None:
        return {"error": "Path traversal blocked"}
    if not os.path.exists(resolved):
        return {"error": f"Path not found: {rel_path}"}
    if not os.path.isdir(resolved):
        return {"error": f"Not a directory: {rel_path}"}

    try:
        raw = os.listdir(resolved)
    except PermissionError:
        return {"error": "Permission denied"}

    entries = []
    for name in sorted(raw, key=lambda n: (not os.path.isdir(os.path.join(resolved, n)), n.lower())):
        full = os.path.join(resolved, name)
        entries.append(format_entry(full, name))
        if len(entries) >= MAX_LIST_ENTRIES:
            break

    return {"entries": entries, "total": len(raw), "path": rel_path}


def handle_file_info(root, params):
    """Get info about a single file/directory."""
    rel_path = params.get("path", "/")
    resolved = safe_resolve(root, rel_path)
    if resolved is None:
        return {"error": "Path traversal blocked"}
    if not os.path.exists(resolved):
        return {"error": f"Path not found: {rel_path}"}

    name = os.path.basename(resolved) or os.path.basename(root)
    entry = format_entry(resolved, name)
    entry["path"] = rel_path
    if entry["type"] == "file":
        entry["mime"] = get_mime(resolved)
    return entry


def handle_file_search(root, params):
    """Search for files matching a pattern."""
    query = params.get("query", "*")
    search_path = params.get("path", "/")
    resolved = safe_resolve(root, search_path)
    if resolved is None:
        return {"error": "Path traversal blocked"}
    if not os.path.exists(resolved):
        return {"error": f"Path not found: {search_path}"}

    results = []
    try:
        for dirpath, dirnames, filenames in os.walk(resolved):
            # Skip hidden and system dirs
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("$RECYCLE.BIN", "System Volume Information")]
            for filename in filenames:
                if fnmatch.fnmatch(filename.lower(), query.lower()):
                    full = os.path.join(dirpath, filename)
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                    entry = format_entry(full, filename)
                    entry["path"] = "/" + rel
                    results.append(entry)
                    if len(results) >= MAX_SEARCH_RESULTS:
                        return {"results": results, "truncated": True, "query": query}
    except PermissionError:
        pass

    return {"results": results, "query": query}


async def handle_file_download(ws, request_id, root, params):
    """Stream a file back through the WebSocket as binary chunks."""
    rel_path = params.get("path", "")
    resolved = safe_resolve(root, rel_path)
    if resolved is None:
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": "Path traversal blocked"}}))
        return
    if not os.path.exists(resolved):
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": f"Not found: {rel_path}"}}))
        return
    if not os.path.isfile(resolved):
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": f"Not a file: {rel_path}"}}))
        return

    ext = os.path.splitext(resolved)[1].lower()
    if ext in BLOCKED_EXTENSIONS:
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": f"Blocked extension: {ext}"}}))
        return

    file_size = os.path.getsize(resolved)
    filename = os.path.basename(resolved)
    mime = get_mime(resolved)

    # Send file_start metadata
    await ws.send(json.dumps({
        "id": request_id,
        "type": "file_start",
        "data": {"name": filename, "size": file_size, "mime": mime}
    }))

    # Stream file as base64 chunks (WS text frames for simplicity)
    bytes_sent = 0
    try:
        with open(resolved, "rb") as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                await ws.send(json.dumps({
                    "id": request_id,
                    "type": "file_chunk",
                    "data": base64.b64encode(chunk).decode("ascii")
                }))
                bytes_sent += len(chunk)
    except Exception as e:
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": str(e)}}))
        return

    # Send file_end
    await ws.send(json.dumps({
        "id": request_id,
        "type": "file_end",
        "data": {"bytes_sent": bytes_sent}
    }))


MAX_FOLDER_ZIP_SIZE = 500 * 1024 * 1024  # 500MB max for folder zips


async def handle_folder_download(ws, request_id, root, params):
    """Zip a directory and stream it back through the WebSocket."""
    rel_path = params.get("path", "")
    resolved = safe_resolve(root, rel_path)
    if resolved is None:
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": "Path traversal blocked"}}))
        return
    if not os.path.exists(resolved):
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": f"Not found: {rel_path}"}}))
        return
    if not os.path.isdir(resolved):
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": f"Not a directory: {rel_path}"}}))
        return

    folder_name = os.path.basename(resolved) or "root"
    zip_name = folder_name + ".zip"

    # Build zip in a temp file (streaming to avoid holding entire zip in memory)
    try:
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        total_size = 0
        file_count = 0
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, dirnames, filenames in os.walk(resolved):
                # Skip hidden/system dirs
                dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("$RECYCLE.BIN", "System Volume Information")]
                for filename in filenames:
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in BLOCKED_EXTENSIONS:
                        continue
                    full = os.path.join(dirpath, filename)
                    try:
                        fsize = os.path.getsize(full)
                    except OSError:
                        continue
                    total_size += fsize
                    if total_size > MAX_FOLDER_ZIP_SIZE:
                        tmp.close()
                        os.unlink(tmp.name)
                        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": f"Folder too large (>{MAX_FOLDER_ZIP_SIZE // 1024 // 1024}MB). Try a subfolder."}}))
                        return
                    arcname = os.path.relpath(full, resolved).replace(os.sep, "/")
                    try:
                        zf.write(full, arcname)
                        file_count += 1
                    except (PermissionError, OSError):
                        continue
        tmp.close()
        zip_size = os.path.getsize(tmp.name)

        # Send file_start
        await ws.send(json.dumps({
            "id": request_id,
            "type": "file_start",
            "data": {"name": zip_name, "size": zip_size, "mime": "application/zip", "file_count": file_count}
        }))

        # Stream zip file
        bytes_sent = 0
        with open(tmp.name, "rb") as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                await ws.send(json.dumps({
                    "id": request_id,
                    "type": "file_chunk",
                    "data": base64.b64encode(chunk).decode("ascii")
                }))
                bytes_sent += len(chunk)

        await ws.send(json.dumps({
            "id": request_id,
            "type": "file_end",
            "data": {"bytes_sent": bytes_sent}
        }))

    except Exception as e:
        await ws.send(json.dumps({"id": request_id, "type": "error", "data": {"error": str(e)}}))
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


async def connect_and_serve(config):
    """Main WebSocket connection loop with auto-reconnect."""
    api_url = config.get("api_url", "https://mycelium.fyi")
    api_key = config.get("api_key", "")
    drone_id = config.get("drone_id", "greatness-file-drone")
    root_dir = config.get("root_dir", "E:\\")
    poll_interval = config.get("poll_interval", 2)

    if not os.path.isdir(root_dir):
        print(f"ERROR: Root directory does not exist: {root_dir}")
        sys.exit(1)

    disk = get_disk_info(root_dir)
    print(f"{'=' * 50}")
    print(f"  Mycelium File Drone v{VERSION}")
    print(f"{'=' * 50}")
    print(f"  Drone:  {drone_id}")
    print(f"  Root:   {root_dir}")
    print(f"  Disk:   {disk.get('free_gb', '?')} GB free / {disk.get('total_gb', '?')} GB total")
    print(f"  Server: {api_url}")
    print()

    # Convert HTTP URL to WebSocket URL
    ws_url = api_url.replace("https://", "wss://").replace("http://", "ws://")
    ws_url = ws_url.rstrip("/") + "/ws/file-drone"
    ws_url += f"?key={api_key}&drone_id={drone_id}"

    reconnect_delay = 2
    max_delay = 60

    while True:
        try:
            print(f"Connecting to {ws_url.split('?')[0]}...")
            async with websockets.connect(ws_url, ping_interval=None, ping_timeout=None, max_size=50 * 1024 * 1024) as ws:
                print("Connected! Serving files...")
                reconnect_delay = 2  # Reset on successful connection

                # Send initial status
                await ws.send(json.dumps({
                    "type": "status",
                    "data": {
                        "drone_id": drone_id,
                        "root_dir": root_dir,
                        "disk": disk,
                        "os": platform.system(),
                        "version": VERSION,
                    }
                }))

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        req_id = msg.get("id", "")
                        req_type = msg.get("type", "")
                        params = msg.get("params", {})

                        if req_type == "ping":
                            await ws.send(json.dumps({"id": req_id, "type": "pong"}))
                            continue

                        if req_type == "file_list":
                            result = handle_file_list(root_dir, params)
                            await ws.send(json.dumps({"id": req_id, "type": "result", "data": result}))

                        elif req_type == "file_info":
                            result = handle_file_info(root_dir, params)
                            await ws.send(json.dumps({"id": req_id, "type": "result", "data": result}))

                        elif req_type == "file_search":
                            result = handle_file_search(root_dir, params)
                            await ws.send(json.dumps({"id": req_id, "type": "result", "data": result}))

                        elif req_type == "file_download":
                            await handle_file_download(ws, req_id, root_dir, params)

                        elif req_type == "folder_download":
                            await handle_folder_download(ws, req_id, root_dir, params)

                        else:
                            await ws.send(json.dumps({"id": req_id, "type": "error", "data": {"error": f"Unknown type: {req_type}"}}))

                    except json.JSONDecodeError:
                        print(f"  Bad JSON from server: {raw[:100]}")
                    except Exception as e:
                        print(f"  Error handling request: {e}")
                        traceback.print_exc()
                        try:
                            await ws.send(json.dumps({"id": req_id, "type": "error", "data": {"error": str(e)}}))
                        except Exception:
                            pass

        except websockets.exceptions.ConnectionClosed as e:
            print(f"Connection closed: {e}. Reconnecting in {reconnect_delay}s...")
        except ConnectionRefusedError:
            print(f"Connection refused. Reconnecting in {reconnect_delay}s...")
        except Exception as e:
            print(f"Error: {e}. Reconnecting in {reconnect_delay}s...")

        await asyncio.sleep(reconnect_delay)
        reconnect_delay = min(reconnect_delay * 1.5, max_delay)


def main():
    import argparse
    parser = argparse.ArgumentParser(description=f"Mycelium File Drone v{VERSION}")
    parser.add_argument("--config", default=None, help="Path to config JSON")
    parser.add_argument("--root", default=None, help="Override root directory")
    parser.add_argument("--server", default=None, help="Override server URL")
    parser.add_argument("--key", default=None, help="Override API key")
    args = parser.parse_args()

    config = load_config(args.config)
    if args.root:
        config["root_dir"] = args.root
    if args.server:
        config["api_url"] = args.server
    if args.key:
        config["api_key"] = args.key

    if not config.get("api_key"):
        print("ERROR: No API key. Set in config or use --key")
        sys.exit(1)

    try:
        asyncio.run(connect_and_serve(config))
    except KeyboardInterrupt:
        print("\nShutting down.")


if __name__ == "__main__":
    main()

# Squad lessons

Living document. Appended to during/after sessions. Loaded into every
agent brief alongside CONTRACT.md.

Format: short title, then `symptom:` and `fix:` lines. Newer at the top.

---

## Fixed squad_tools/__init__.py to implement correct agent tool exposure

**Symptom:** The __init__.py file had incorrect tool exposure mappings:
- SCOUT_SCHEMAS was 4 base tools instead of 8 research tools
- FORGE_SCHEMAS was a Lucy-clone instead of Ada's mycelium spec
- FORGE_ALLOWED included run_shell/parse_check which Ada said NO
- SCOUT_ALLOWED and scout dispatch routing were missing entirely

**Fix:** Completely rewrote the __init__.py file to:
- Import research and mycelium modules
- Register all 12 tools (8 research + 4 mycelium) in _REGISTRY
- Set SCOUT_SCHEMAS to exactly 8 research schema constants
- Set SCOUT_ALLOWED to exactly 8 research tool names
- Set FORGE_SCHEMAS to correct schema list with mycelium schemas
- Set FORGE_ALLOWED to exactly 7 tools (without run_shell/parse_check)
- Add scout branch to dispatch() function

**Date:** 2026-05-27.

---

## Fixed path-traversal vulnerability in file-drone safe_resolve

**Symptom:** The safe_resolve function used a naive prefix check (target.startswith(root)) which allowed directory traversal attacks. For example, with root=/srv/share, ../share-secret/x would pass the check even though it escapes the root directory.

**Fix:** Implemented secure path resolution using os.path.commonpath() to properly verify that resolved paths stay within the specified root directory. The function now:
- Normalizes both target and root paths to absolute paths
- Uses os.path.commonpath() to verify the target path shares the same root
- Returns None for any path that would escape the root directory
- Correctly handles both absolute and relative paths

**Date:** 2026-05-30.

---

## Fixed ESM module fs import in voice.js

**Symptom:** The voice.js file was using destructured imports from 'fs' but needed to use the proper ESM import syntax to avoid errors in ESM modules.

**Fix:** Changed the fs import from `import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'fs'` to `import fs from 'node:fs'` to ensure proper ESM module compatibility.

**Date:** 2026-05-30.
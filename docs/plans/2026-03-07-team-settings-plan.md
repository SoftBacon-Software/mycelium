# Team Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Team Settings page that lets customer admins configure their team's coding standards, deployment workflow, brand guidelines, agent guardrails, and team rules through a clean UI — with automatic sync to node profiles so agents inherit the team DNA on boot.

**Architecture:** New `dv_team_settings` table (section/key/value) for human-facing config. Server-side `syncTeamSettingsToProfile()` pushes relevant settings into the `customer-agent` node profile. React page with 5 tabbed sections. Each tab is a form that reads/writes via REST endpoints.

**Tech Stack:** Express routes (ES5 `var` style, match existing codebase), SQLite via better-sqlite3, React + TypeScript + Tailwind (Vite), Lucide icons, sonner toasts.

**Design doc:** `docs/plans/2026-03-07-team-settings-design.md`

---

### Task 1: Schema + DB Functions

**Files:**
- Modify: `server/schema.sql` (append table)
- Modify: `server/db.js` (add CRUD + sync functions)

**Step 1: Add table to schema.sql**

Append after the last CREATE TABLE (before indexes):

```sql
-- Team settings (customer-facing configuration that syncs to node profiles)
CREATE TABLE IF NOT EXISTS dv_team_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL DEFAULT '',
  UNIQUE(section, key)
);
CREATE INDEX IF NOT EXISTS idx_team_settings_section ON dv_team_settings(section);
```

**Step 2: Add DB functions to db.js**

Add after the node profile functions (after `seedPlatformProfiles`). Follow existing patterns: `var` declarations, `db.prepare()`, explicit function exports.

```javascript
// =============== TEAM SETTINGS ===============

export function listTeamSettings(section) {
  if (section) {
    return db.prepare('SELECT * FROM dv_team_settings WHERE section = ? ORDER BY key').all(section);
  }
  return db.prepare('SELECT * FROM dv_team_settings ORDER BY section, key').all();
}

export function getTeamSetting(section, key) {
  return db.prepare('SELECT * FROM dv_team_settings WHERE section = ? AND key = ?').get(section, key);
}

export function upsertTeamSetting(section, key, value, updatedBy) {
  var now = new Date().toISOString();
  var valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  db.prepare(
    "INSERT INTO dv_team_settings (section, key, value, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(section, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"
  ).run(section, key, valueStr, now, updatedBy || '');
  syncTeamSettingsToProfile();
  return getTeamSetting(section, key);
}

export function deleteTeamSetting(section, key) {
  var result = db.prepare('DELETE FROM dv_team_settings WHERE section = ? AND key = ?').run(section, key);
  syncTeamSettingsToProfile();
  return result;
}

export function getAllTeamSettingsGrouped() {
  var rows = listTeamSettings();
  var grouped = {};
  for (var row of rows) {
    if (!grouped[row.section]) grouped[row.section] = {};
    try {
      grouped[row.section][row.key] = JSON.parse(row.value);
    } catch (e) {
      grouped[row.section][row.key] = row.value;
    }
  }
  return grouped;
}

export function syncTeamSettingsToProfile() {
  var settings = getAllTeamSettingsGrouped();
  var profileId = 'customer-agent';
  var existing = getNodeProfile(profileId);

  var updates = {};

  // Guardrails → direct profile mapping
  var guardrails = settings.guardrails || {};
  if (guardrails.tool_whitelist) updates.tool_whitelist = guardrails.tool_whitelist;
  if (guardrails.repo_list) updates.repo_list = guardrails.repo_list;
  if (guardrails.md_checkpoints) updates.md_checkpoints = guardrails.md_checkpoints;
  if (guardrails.md_blocklist) updates.md_blocklist = guardrails.md_blocklist;

  // Build rules from multiple sections
  var rules = {};
  if (existing) {
    try { rules = typeof existing.rules === 'object' ? existing.rules : JSON.parse(existing.rules || '{}'); } catch (e) { rules = {}; }
  }

  // Coding standards → rule
  var coding = settings.coding_standards || {};
  if (Object.keys(coding).length > 0) {
    var parts = [];
    if (coding.languages && coding.languages.length) parts.push('Languages: ' + coding.languages.join(', '));
    if (coding.linter) parts.push('Linter: ' + coding.linter);
    if (coding.formatter) parts.push('Formatter: ' + coding.formatter);
    if (coding.test_framework) parts.push('Tests: ' + coding.test_framework);
    if (coding.style_notes) parts.push(coding.style_notes);
    rules.coding_standards = { severity: 'high', description: parts.join('. ') };

    // Also add language names to md_checkpoints
    if (coding.languages && coding.languages.length) {
      var checkpoints = updates.md_checkpoints || (existing && existing.md_checkpoints) || [];
      for (var lang of coding.languages) {
        if (checkpoints.indexOf(lang) === -1) checkpoints.push(lang);
      }
      updates.md_checkpoints = checkpoints;
    }
  }

  // Deploy workflow → rule
  var deploy = settings.deploy_workflow || {};
  if (Object.keys(deploy).length > 0) {
    var deployParts = [];
    if (deploy.stages && deploy.stages.length) deployParts.push('Stages: ' + deploy.stages.join(' → '));
    if (deploy.deploy_method) deployParts.push('Method: ' + deploy.deploy_method);
    if (deploy.pr_requirements) deployParts.push('PR: ' + JSON.stringify(deploy.pr_requirements));
    rules.deploy_workflow = { severity: 'high', description: deployParts.join('. ') };
  }

  // Team rules → rule
  var teamRules = settings.team_rules || {};
  if (Object.keys(teamRules).length > 0) {
    var trParts = [];
    if (teamRules.communication_style) trParts.push('Style: ' + teamRules.communication_style);
    if (teamRules.timezone) trParts.push('TZ: ' + teamRules.timezone);
    if (teamRules.working_hours) trParts.push('Hours: ' + teamRules.working_hours);
    rules.team_rules = { severity: 'medium', description: trParts.join('. ') };
  }

  // Custom guardrail rules
  if (guardrails.custom_rules && Array.isArray(guardrails.custom_rules)) {
    for (var cr of guardrails.custom_rules) {
      if (cr.key && cr.description) {
        rules[cr.key] = { severity: cr.severity || 'medium', description: cr.description };
      }
    }
  }

  updates.rules = rules;

  if (existing) {
    updateNodeProfile(profileId, updates);
  } else {
    createNodeProfile(profileId, Object.assign({ node_type: 'agent', layer: 'customer' }, updates));
  }
}
```

**Step 3: Add table creation to db init**

In `db.js`, find where `schema.sql` is executed (the `initDB` function). The schema.sql `CREATE TABLE IF NOT EXISTS` handles idempotent creation, so no code change needed — just adding the SQL to schema.sql is sufficient since it runs the whole file on init.

**Step 4: Commit**

```bash
git add server/schema.sql server/db.js
git commit -m "feat: team settings DB layer — CRUD + profile sync"
```

---

### Task 2: API Routes

**Files:**
- Modify: `server/routes/mycelium.js` (add 5 endpoints)

**Step 1: Add routes**

Add after the `/profiles` section (around line 5121). Import the new functions at the top of the file alongside existing db imports.

Add to the existing destructured import from `../db.js`:
```javascript
listTeamSettings, getTeamSetting, upsertTeamSetting, deleteTeamSetting,
getAllTeamSettingsGrouped, syncTeamSettingsToProfile,
```

Routes:

```javascript
// ======== TEAM SETTINGS ========

// GET /team-settings — all settings grouped by section
router.get('/team-settings', function (req, res) {
  if (!checkAdmin(req, res)) return;
  res.json(getAllTeamSettingsGrouped());
});

// GET /team-settings/:section — one section
router.get('/team-settings/:section', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var rows = listTeamSettings(req.params.section);
  var result = {};
  for (var row of rows) {
    try { result[row.key] = JSON.parse(row.value); } catch (e) { result[row.key] = row.value; }
  }
  res.json(result);
});

// PUT /team-settings/:section/:key — upsert a setting
router.put('/team-settings/:section/:key', function (req, res) {
  if (!checkAdmin(req, res)) return;
  var section = req.params.section;
  var key = req.params.key;
  var value = req.body.value;
  if (value === undefined) return res.status(400).json({ error: 'value is required' });
  var validSections = ['coding_standards', 'deploy_workflow', 'brand', 'guardrails', 'team_rules'];
  if (validSections.indexOf(section) === -1) {
    return res.status(400).json({ error: 'Invalid section. Must be one of: ' + validSections.join(', ') });
  }
  var who = getAdminDisplayName(req);
  var result = upsertTeamSetting(section, key, value, who);
  res.json({ ok: true, setting: result });
});

// DELETE /team-settings/:section/:key — remove a setting
router.delete('/team-settings/:section/:key', function (req, res) {
  if (!checkAdmin(req, res)) return;
  deleteTeamSetting(req.params.section, req.params.key);
  res.json({ ok: true });
});

// POST /team-settings/sync — force re-sync to profiles
router.post('/team-settings/sync', function (req, res) {
  if (!checkAdmin(req, res)) return;
  syncTeamSettingsToProfile();
  res.json({ ok: true, message: 'Profile sync complete' });
});
```

**Step 2: Commit**

```bash
git add server/routes/mycelium.js
git commit -m "feat: team settings API — CRUD + sync endpoints"
```

---

### Task 3: React Types + API Functions

**Files:**
- Modify: `studio-react/src/api/types.ts` (add TeamSetting interface)
- Modify: `studio-react/src/api/endpoints.ts` (add fetch/update functions)

**Step 1: Add types to types.ts**

Append after `CalibrationData` interface:

```typescript
// ── Team Settings ──

export interface TeamSetting {
  id: number;
  section: string;
  key: string;
  value: string;
  updated_at: string;
  updated_by: string;
}

export type TeamSettingsGrouped = Record<string, Record<string, unknown>>;
```

**Step 2: Add API functions to endpoints.ts**

Add import for `TeamSettingsGrouped` in the type imports, then add:

```typescript
// ── Team Settings ──

export function fetchTeamSettings(): Promise<TeamSettingsGrouped> {
  return apiGet<TeamSettingsGrouped>('/team-settings')
}

export function fetchTeamSettingsSection(section: string): Promise<Record<string, unknown>> {
  return apiGet<Record<string, unknown>>(`/team-settings/${section}`)
}

export function updateTeamSetting(section: string, key: string, value: unknown): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/team-settings/${encodeURIComponent(section)}/${encodeURIComponent(key)}`, { value })
}

export function deleteTeamSetting(section: string, key: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/team-settings/${encodeURIComponent(section)}/${encodeURIComponent(key)}`)
}

export function syncTeamSettings(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/team-settings/sync', {})
}
```

**Step 3: Commit**

```bash
git add studio-react/src/api/types.ts studio-react/src/api/endpoints.ts
git commit -m "feat: team settings React types + API functions"
```

---

### Task 4: TeamSettingsPage — Shell + Tabs

**Files:**
- Create: `studio-react/src/pages/TeamSettingsPage.tsx`

**Step 1: Build the page shell with 5 tabs**

Create the page with tab navigation and section components. Each section loads its own data and has a save button. Pattern: match existing pages (DeploymentsPage, BugsPage) — useState/useEffect/useCallback, Tailwind classes, Badge component, toast for feedback.

```tsx
import { useState, useEffect, useCallback } from 'react'
import { fetchTeamSettings, updateTeamSetting, deleteTeamSetting, syncTeamSettings } from '../api/endpoints'
import type { TeamSettingsGrouped } from '../api/types'
import { toast } from 'sonner'

/* ── Tab definitions ── */

const TABS = [
  { id: 'coding_standards', label: 'Coding Standards' },
  { id: 'deploy_workflow', label: 'Deploy Workflow' },
  { id: 'brand', label: 'Brand & Design' },
  { id: 'guardrails', label: 'Agent Guardrails' },
  { id: 'team_rules', label: 'Team Rules' },
] as const

type TabId = typeof TABS[number]['id']

/* ── Shared field components ── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs uppercase tracking-wider text-text-muted font-medium">{label}</label>
      {children}
    </div>
  )
}

function TextInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
    />
  )
}

function TextArea({ value, onChange, placeholder, rows }: {
  value: string; onChange: (v: string) => void; placeholder?: string; rows?: number
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows || 3}
      className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
    />
  )
}

function TagInput({ tags, onChange, placeholder }: {
  tags: string[]; onChange: (tags: string[]) => void; placeholder?: string
}) {
  const [input, setInput] = useState('')

  const addTag = () => {
    const trimmed = input.trim()
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed])
      setInput('')
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-accent/15 text-accent text-xs font-medium"
          >
            {tag}
            <button onClick={() => onChange(tags.filter((t) => t !== tag))} className="text-accent/60 hover:text-accent">
              &times;
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
          placeholder={placeholder}
          className="flex-1 bg-surface-raised border border-border rounded-sm px-3 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
        <button onClick={addTag} className="px-3 py-1.5 rounded-sm text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors">
          Add
        </button>
      </div>
    </div>
  )
}

function KeyValueEditor({ pairs, onChange }: {
  pairs: Record<string, string>; onChange: (pairs: Record<string, string>) => void
}) {
  const entries = Object.entries(pairs)

  const updateKey = (oldKey: string, newKey: string) => {
    const updated: Record<string, string> = {}
    for (const [k, v] of entries) {
      updated[k === oldKey ? newKey : k] = v
    }
    onChange(updated)
  }

  const updateValue = (key: string, value: string) => {
    onChange({ ...pairs, [key]: value })
  }

  const addPair = () => {
    onChange({ ...pairs, '': '' })
  }

  const removePair = (key: string) => {
    const { [key]: _, ...rest } = pairs
    onChange(rest)
  }

  return (
    <div className="space-y-2">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex gap-2 items-center">
          <input
            value={k}
            onChange={(e) => updateKey(k, e.target.value)}
            placeholder="Key"
            className="w-1/3 bg-surface-raised border border-border rounded-sm px-2 py-1.5 text-xs text-text font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          <input
            value={v}
            onChange={(e) => updateValue(k, e.target.value)}
            placeholder="Value"
            className="flex-1 bg-surface-raised border border-border rounded-sm px-2 py-1.5 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
          <button onClick={() => removePair(k)} className="text-red/60 hover:text-red text-xs px-1">&times;</button>
        </div>
      ))}
      <button onClick={addPair} className="text-xs text-accent hover:text-accent-light transition-colors">
        + Add entry
      </button>
    </div>
  )
}

/* ── Section: Coding Standards ── */

function CodingStandardsSection({ data, onSave }: {
  data: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void>
}) {
  const [languages, setLanguages] = useState<string[]>((data.languages as string[]) || [])
  const [linter, setLinter] = useState((data.linter as string) || '')
  const [formatter, setFormatter] = useState((data.formatter as string) || '')
  const [testFramework, setTestFramework] = useState((data.test_framework as string) || '')
  const [styleNotes, setStyleNotes] = useState((data.style_notes as string) || '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave('languages', languages)
      await onSave('linter', linter)
      await onSave('formatter', formatter)
      await onSave('test_framework', testFramework)
      await onSave('style_notes', styleNotes)
      toast.success('Coding standards saved')
    } catch { toast.error('Failed to save') }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      <Field label="Languages">
        <TagInput tags={languages} onChange={setLanguages} placeholder="e.g. TypeScript" />
      </Field>
      <Field label="Linter">
        <TextInput value={linter} onChange={setLinter} placeholder="e.g. ESLint" />
      </Field>
      <Field label="Formatter">
        <TextInput value={formatter} onChange={setFormatter} placeholder="e.g. Prettier" />
      </Field>
      <Field label="Test Framework">
        <TextInput value={testFramework} onChange={setTestFramework} placeholder="e.g. Jest, pytest" />
      </Field>
      <Field label="Style Notes">
        <TextArea value={styleNotes} onChange={setStyleNotes} placeholder="e.g. Use functional components, no classes..." rows={4} />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  )
}

/* ── Section: Deploy Workflow ── */

function DeployWorkflowSection({ data, onSave }: {
  data: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void>
}) {
  const [stages, setStages] = useState<string[]>((data.stages as string[]) || [])
  const [deployMethod, setDeployMethod] = useState((data.deploy_method as string) || '')
  const [prRequirements, setPrRequirements] = useState<Record<string, boolean>>(
    (data.pr_requirements as Record<string, boolean>) || { require_reviews: false, require_ci: false }
  )
  const [environments, setEnvironments] = useState<Record<string, string>>(
    (data.environments as Record<string, string>) || {}
  )
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave('stages', stages)
      await onSave('deploy_method', deployMethod)
      await onSave('pr_requirements', prRequirements)
      await onSave('environments', environments)
      toast.success('Deploy workflow saved')
    } catch { toast.error('Failed to save') }
    finally { setSaving(false) }
  }

  const togglePr = (key: string) => {
    setPrRequirements((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="space-y-5">
      <Field label="Deploy Stages (in order)">
        <TagInput tags={stages} onChange={setStages} placeholder="e.g. staging" />
        {stages.length > 1 && (
          <p className="text-xs text-text-muted mt-1">{stages.join(' → ')}</p>
        )}
      </Field>
      <Field label="Deploy Method">
        <select
          value={deployMethod}
          onChange={(e) => setDeployMethod(e.target.value)}
          className="bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
        >
          <option value="">Select...</option>
          <option value="railway">Railway</option>
          <option value="vercel">Vercel</option>
          <option value="fly">Fly.io</option>
          <option value="docker">Docker</option>
          <option value="manual">Manual</option>
          <option value="other">Other</option>
        </select>
      </Field>
      <Field label="PR Requirements">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-text-dim cursor-pointer">
            <input type="checkbox" checked={prRequirements.require_reviews || false} onChange={() => togglePr('require_reviews')}
              className="rounded border-border bg-surface-raised text-accent focus:ring-accent/40" />
            Require code reviews
          </label>
          <label className="flex items-center gap-2 text-sm text-text-dim cursor-pointer">
            <input type="checkbox" checked={prRequirements.require_ci || false} onChange={() => togglePr('require_ci')}
              className="rounded border-border bg-surface-raised text-accent focus:ring-accent/40" />
            Require passing CI
          </label>
        </div>
      </Field>
      <Field label="Environments">
        <KeyValueEditor pairs={environments} onChange={setEnvironments} />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  )
}

/* ── Section: Brand & Design ── */

function BrandSection({ data, onSave }: {
  data: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void>
}) {
  const [voice, setVoice] = useState((data.voice as string) || '')
  const [designSystem, setDesignSystem] = useState((data.design_system as string) || '')
  const [colors, setColors] = useState<Record<string, string>>(
    (data.colors as Record<string, string>) || {}
  )
  const [typography, setTypography] = useState((data.typography as string) || '')
  const [assets, setAssets] = useState((data.assets as string) || '')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave('voice', voice)
      await onSave('design_system', designSystem)
      await onSave('colors', colors)
      await onSave('typography', typography)
      await onSave('assets', assets)
      toast.success('Brand settings saved')
    } catch { toast.error('Failed to save') }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      <Field label="Brand Voice">
        <TextArea value={voice} onChange={setVoice} placeholder="e.g. Professional but approachable. Use active voice..." rows={3} />
      </Field>
      <Field label="Design System">
        <TextInput value={designSystem} onChange={setDesignSystem} placeholder="URL or description of your design system" />
      </Field>
      <Field label="Color Scheme">
        <KeyValueEditor pairs={colors} onChange={setColors} />
      </Field>
      <Field label="Typography">
        <TextInput value={typography} onChange={setTypography} placeholder="e.g. Inter, JetBrains Mono" />
      </Field>
      <Field label="Asset References">
        <TextArea value={assets} onChange={setAssets} placeholder="URLs or descriptions of brand assets..." rows={2} />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  )
}

/* ── Section: Agent Guardrails ── */

function GuardrailsSection({ data, onSave }: {
  data: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void>
}) {
  const [toolWhitelist, setToolWhitelist] = useState<string[]>((data.tool_whitelist as string[]) || [])
  const [repoList, setRepoList] = useState<string[]>((data.repo_list as string[]) || [])
  const [mdCheckpoints, setMdCheckpoints] = useState<string[]>((data.md_checkpoints as string[]) || [])
  const [mdBlocklist, setMdBlocklist] = useState<string[]>((data.md_blocklist as string[]) || [])
  const [customRules, setCustomRules] = useState<Array<{ key: string; severity: string; description: string }>>(
    (data.custom_rules as Array<{ key: string; severity: string; description: string }>) || []
  )
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave('tool_whitelist', toolWhitelist)
      await onSave('repo_list', repoList)
      await onSave('md_checkpoints', mdCheckpoints)
      await onSave('md_blocklist', mdBlocklist)
      await onSave('custom_rules', customRules)
      toast.success('Guardrails saved')
    } catch { toast.error('Failed to save') }
    finally { setSaving(false) }
  }

  const addRule = () => {
    setCustomRules([...customRules, { key: '', severity: 'medium', description: '' }])
  }

  const updateRule = (index: number, field: string, value: string) => {
    const updated = [...customRules]
    updated[index] = { ...updated[index], [field]: value }
    setCustomRules(updated)
  }

  const removeRule = (index: number) => {
    setCustomRules(customRules.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-5">
      <Field label="Allowed MCP Tools">
        <TagInput tags={toolWhitelist} onChange={setToolWhitelist} placeholder="e.g. Bash, Read, Write" />
      </Field>
      <Field label="Allowed Repos">
        <TagInput tags={repoList} onChange={setRepoList} placeholder="e.g. org/repo-name" />
      </Field>
      <Field label="Required CLAUDE.md Anchors">
        <TagInput tags={mdCheckpoints} onChange={setMdCheckpoints} placeholder="e.g. mycelium_boot" />
        <p className="text-xs text-text-muted mt-1">Agents must have these terms in their CLAUDE.md. Drift detection flags missing anchors.</p>
      </Field>
      <Field label="Blocked Terms">
        <TagInput tags={mdBlocklist} onChange={setMdBlocklist} placeholder="Terms agents must NOT use" />
      </Field>
      <Field label="Custom Rules">
        <div className="space-y-3">
          {customRules.map((rule, i) => (
            <div key={i} className="flex gap-2 items-start bg-surface-raised rounded-sm p-3 border border-border/30">
              <div className="flex-1 space-y-2">
                <input
                  value={rule.key}
                  onChange={(e) => updateRule(i, 'key', e.target.value)}
                  placeholder="Rule name"
                  className="w-full bg-surface border border-border rounded-sm px-2 py-1 text-xs text-text font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
                <input
                  value={rule.description}
                  onChange={(e) => updateRule(i, 'description', e.target.value)}
                  placeholder="Description"
                  className="w-full bg-surface border border-border rounded-sm px-2 py-1.5 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
                />
              </div>
              <select
                value={rule.severity}
                onChange={(e) => updateRule(i, 'severity', e.target.value)}
                className="bg-surface border border-border rounded-sm px-2 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
              <button onClick={() => removeRule(i)} className="text-red/60 hover:text-red text-xs px-1 mt-1">&times;</button>
            </div>
          ))}
          <button onClick={addRule} className="text-xs text-accent hover:text-accent-light transition-colors">
            + Add rule
          </button>
        </div>
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  )
}

/* ── Section: Team Rules ── */

function TeamRulesSection({ data, onSave }: {
  data: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void>
}) {
  const [commStyle, setCommStyle] = useState((data.communication_style as string) || '')
  const [timezone, setTimezone] = useState((data.timezone as string) || '')
  const [workingHours, setWorkingHours] = useState((data.working_hours as string) || '')
  const [approvalReqs, setApprovalReqs] = useState<string[]>((data.approval_requirements as string[]) || [])
  const [custom, setCustom] = useState<Record<string, string>>(
    (data.custom as Record<string, string>) || {}
  )
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave('communication_style', commStyle)
      await onSave('timezone', timezone)
      await onSave('working_hours', workingHours)
      await onSave('approval_requirements', approvalReqs)
      await onSave('custom', custom)
      toast.success('Team rules saved')
    } catch { toast.error('Failed to save') }
    finally { setSaving(false) }
  }

  return (
    <div className="space-y-5">
      <Field label="Communication Style">
        <select
          value={commStyle}
          onChange={(e) => setCommStyle(e.target.value)}
          className="bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
        >
          <option value="">Select...</option>
          <option value="formal">Formal</option>
          <option value="casual">Casual</option>
          <option value="technical">Technical</option>
        </select>
      </Field>
      <Field label="Timezone">
        <TextInput value={timezone} onChange={setTimezone} placeholder="e.g. America/Los_Angeles" />
      </Field>
      <Field label="Working Hours">
        <TextInput value={workingHours} onChange={setWorkingHours} placeholder="e.g. 9am-5pm PST" />
      </Field>
      <Field label="Actions Requiring Approval">
        <TagInput tags={approvalReqs} onChange={setApprovalReqs} placeholder="e.g. deploy, git_push" />
      </Field>
      <Field label="Custom Rules">
        <KeyValueEditor pairs={custom} onChange={setCustom} />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
    </div>
  )
}

/* ── Save button ── */

function SaveButton({ saving, onClick }: { saving: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between pt-3 border-t border-border/30">
      <p className="text-xs text-text-muted">Changes sync to agent profiles on save.</p>
      <button
        onClick={onClick}
        disabled={saving}
        className="px-5 py-2 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}

/* ── Main Page ── */

export default function TeamSettingsPage() {
  const [settings, setSettings] = useState<TeamSettingsGrouped>({})
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabId>('coding_standards')
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchTeamSettings()
      setSettings(data)
    } catch (err) {
      console.error('Failed to load team settings:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = useCallback(async (key: string, value: unknown) => {
    await updateTeamSetting(activeTab, key, value)
  }, [activeTab])

  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      await syncTeamSettings()
      toast.success('Profile sync complete')
    } catch { toast.error('Sync failed') }
    finally { setSyncing(false) }
  }, [])

  const sectionData = settings[activeTab] || {}

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Team Settings</h1>
          <p className="text-sm text-text-muted mt-0.5">Configure your team's DNA — standards, workflow, brand, and guardrails</p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="px-3 py-1.5 rounded-sm text-xs font-medium text-text-muted hover:text-accent bg-surface-raised hover:ring-1 ring-border transition-colors disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Force Sync to Profiles'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/50 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? 'text-accent border-accent'
                : 'text-text-muted hover:text-text-dim border-transparent'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="bg-surface rounded-lg p-6">
        {loading ? (
          <div className="text-center text-text-muted py-12 text-sm animate-pulse">Loading settings...</div>
        ) : (
          <>
            {activeTab === 'coding_standards' && <CodingStandardsSection data={sectionData} onSave={handleSave} />}
            {activeTab === 'deploy_workflow' && <DeployWorkflowSection data={sectionData} onSave={handleSave} />}
            {activeTab === 'brand' && <BrandSection data={sectionData} onSave={handleSave} />}
            {activeTab === 'guardrails' && <GuardrailsSection data={sectionData} onSave={handleSave} />}
            {activeTab === 'team_rules' && <TeamRulesSection data={sectionData} onSave={handleSave} />}
          </>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add studio-react/src/pages/TeamSettingsPage.tsx
git commit -m "feat: TeamSettingsPage — 5-tab settings UI"
```

---

### Task 5: Wire Into App + Navigation

**Files:**
- Modify: `studio-react/src/App.tsx` (lazy import + route)
- Modify: `studio-react/src/layouts/SideNav.tsx` (nav item + icon import)

**Step 1: Add lazy import to App.tsx**

After the existing lazy imports (around line 33):

```typescript
const TeamSettingsPage = lazy(() => import('./pages/TeamSettingsPage'))
```

Add route inside the `<Route element={<AppLayout />}>` block, after the deployments route:

```tsx
<Route path="team-settings" element={<TeamSettingsPage />} />
```

**Step 2: Add nav item to SideNav.tsx**

Import `Settings2` from lucide-react (add to the existing import list on line 12).

Add to the `manage` section items array (after Operators, before Deployments):

```typescript
{ to: '/team-settings', label: 'Team Settings', icon: Settings2, adminOnly: true },
```

**Step 3: Build**

```bash
cd D:/mycelium/studio-react && npm run build
```

Expected: Clean build, no errors.

**Step 4: Commit**

```bash
git add studio-react/src/App.tsx studio-react/src/layouts/SideNav.tsx studio-react/
git commit -m "feat: wire TeamSettingsPage into app routing and navigation"
```

---

### Task 6: Deploy + Verify

**Step 1: Deploy to Railway**

```bash
cd D:/mycelium && railway up
```

**Step 2: Verify API**

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" \
  "https://mycelium.fyi/api/mycelium/team-settings" | python -m json.tool
```

Expected: `{}` (empty object, no settings yet)

```bash
curl -s -X PUT -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" \
  -H "Content-Type: application/json" \
  -d '{"value": ["TypeScript", "Python"]}' \
  "https://mycelium.fyi/api/mycelium/team-settings/coding_standards/languages" | python -m json.tool
```

Expected: `{ "ok": true, "setting": { ... } }`

**Step 3: Verify UI**

Navigate to `https://mycelium.fyi/studio/team-settings`. Should see the 5-tab page. Enter some coding standards, save, verify toast shows success. Check that the customer-agent profile was updated:

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" \
  "https://mycelium.fyi/api/mycelium/profiles/customer-agent" | python -m json.tool
```

Expected: Profile has `md_checkpoints` including the language names.

**Step 4: Verify agent boot**

Check that an agent's calibration includes the new rules:

```bash
curl -s -H "X-Admin-Key: KPeO7ZspKsAQotZsrvnZ2vYk" \
  "https://mycelium.fyi/api/mycelium/profiles/resolve/dev-claude" | python -m json.tool
```

Expected: Resolved profile includes coding_standards rule from team settings.

**Step 5: Notify agents**

Broadcast message to all agents about the new Team Settings feature so they know to check their calibration.

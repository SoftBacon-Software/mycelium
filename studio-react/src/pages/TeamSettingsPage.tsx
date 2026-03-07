import { useState, useEffect, useCallback } from 'react'
import { fetchTeamSettings, updateTeamSetting, syncTeamSettings } from '../api/endpoints'
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs uppercase tracking-wider text-text-muted font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-text-muted mt-1">{hint}</p>}
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
    const newKey = 'key_' + (entries.length + 1)
    onChange({ ...pairs, [newKey]: '' })
  }

  const removePair = (key: string) => {
    const copy = { ...pairs }
    delete copy[key]
    onChange(copy)
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

/* ── Save button ── */

function SaveButton({ saving, onClick }: { saving: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between pt-4 border-t border-border/30">
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
      <Field label="Languages" hint="Languages your team uses. Added to agent calibration checkpoints.">
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
      <Field label="Style Notes" hint="Freeform coding conventions your agents should follow.">
        <TextArea value={styleNotes} onChange={setStyleNotes} placeholder="e.g. Use functional components, no classes, prefer composition over inheritance..." rows={4} />
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
      <Field label="Deploy Stages" hint={stages.length > 1 ? stages.join(' \u2192 ') : 'Add stages in deployment order.'}>
        <TagInput tags={stages} onChange={setStages} placeholder="e.g. staging" />
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
      <Field label="Environments" hint="Key-value pairs for each environment (e.g. staging_url, prod_url).">
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
      <Field label="Brand Voice" hint="Describe your brand's tone. Agents use this when writing copy or communicating.">
        <TextArea value={voice} onChange={setVoice} placeholder="e.g. Professional but approachable. Use active voice. No jargon." rows={3} />
      </Field>
      <Field label="Design System">
        <TextInput value={designSystem} onChange={setDesignSystem} placeholder="URL or description of your design system" />
      </Field>
      <Field label="Color Scheme" hint="Define your brand colors (e.g. primary, secondary, accent, background).">
        <KeyValueEditor pairs={colors} onChange={setColors} />
      </Field>
      <Field label="Typography">
        <TextInput value={typography} onChange={setTypography} placeholder="e.g. Inter, JetBrains Mono" />
      </Field>
      <Field label="Asset References">
        <TextArea value={assets} onChange={setAssets} placeholder="URLs or descriptions of logos, icons, brand assets..." rows={2} />
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
      <Field label="Allowed MCP Tools" hint="If set, agents can only use these tools. Leave empty for no restrictions.">
        <TagInput tags={toolWhitelist} onChange={setToolWhitelist} placeholder="e.g. Bash, Read, Write" />
      </Field>
      <Field label="Allowed Repos" hint="GitHub repos agents are permitted to access.">
        <TagInput tags={repoList} onChange={setRepoList} placeholder="e.g. org/repo-name" />
      </Field>
      <Field label="Required CLAUDE.md Anchors" hint="Terms agents must have in their CLAUDE.md. Drift detection flags missing anchors.">
        <TagInput tags={mdCheckpoints} onChange={setMdCheckpoints} placeholder="e.g. mycelium_boot" />
      </Field>
      <Field label="Blocked Terms" hint="Terms agents must NOT have in their CLAUDE.md. Critical drift if found.">
        <TagInput tags={mdBlocklist} onChange={setMdBlocklist} placeholder="e.g. deprecated_function" />
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
                  placeholder="Description — what should agents do or not do?"
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
      <Field label="Actions Requiring Approval" hint="Gated actions that need human sign-off (deploy, git_push, money_action, etc.).">
        <TagInput tags={approvalReqs} onChange={setApprovalReqs} placeholder="e.g. deploy" />
      </Field>
      <Field label="Custom Rules" hint="Additional team-specific key-value configuration.">
        <KeyValueEditor pairs={custom} onChange={setCustom} />
      </Field>
      <SaveButton saving={saving} onClick={handleSave} />
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

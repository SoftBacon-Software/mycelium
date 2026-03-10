import { useCallback, useEffect, useState } from 'react'
import { fetchAgentIdentity, updateAgentIdentity } from '../../api/endpoints'
import type { AgentIdentity, IdentityPill } from '../../api/types'
import PillCloud from './PillCloud'
import Badge from './Badge'
import Spinner from './Spinner'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const agentColors: Record<string, string> = {
  hijack: 'bg-purple/20 text-purple',
  greatness: 'bg-green/20 text-green',
  macbook: 'bg-blue/20 text-blue',
  admin: 'bg-accent/20 text-accent',
  unakron: 'bg-red/20 text-red',
  dev: 'bg-red/20 text-red',
  local: 'bg-accent/20 text-accent',
}

function getAgentColor(id: string): string {
  const key = id.replace(/-claude$|-gpu$|-3090$/, '')
  return agentColors[key] || 'bg-accent/20 text-accent'
}

function getAgentInitials(name: string): string {
  const parts = name.split(/[-_ ]+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

// ─── Preset suggestions ─────────────────────────────────────────────────────

const CAPABILITY_PRESETS = [
  'code', 'coordination', 'admin', 'art_generation', 'gpu_compute',
  'testing', 'review', 'deploy', 'research', 'documentation', 'design',
]

const RESPONSIBILITY_PRESETS = [
  'Code review', 'Bug triage', 'Sprint planning', 'Art pipeline',
  'Testing', 'Documentation', 'CI/CD', 'Security audits',
  'Performance monitoring', 'Dependency updates',
]

const GUARDRAIL_PRESETS = [
  'No direct pushes to main', 'Require approval for deploys',
  'No external API calls without approval', 'Follow code style guide',
  'Write tests for all new code', 'No deleting production data',
]

// ─── Component ───────────────────────────────────────────────────────────────

interface AgentIdentityCardProps {
  agentId: string
}

export default function AgentIdentityCard({ agentId }: AgentIdentityCardProps) {
  const [identity, setIdentity] = useState<AgentIdentity | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null) // which field is saving
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAgentIdentity(agentId)
      setIdentity(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load identity')
    }
    setLoading(false)
  }, [agentId])

  useEffect(() => { load() }, [load])

  // ─── Update handlers ────────────────────────────────────────────────────────

  const handleAddCapability = useCallback(async (value: string) => {
    if (!identity) return
    const newCaps = [...identity.capabilities, value]
    setSaving('capabilities')
    try {
      await updateAgentIdentity(agentId, { capabilities: newCaps })
      setIdentity({ ...identity, capabilities: newCaps })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    }
    setSaving(null)
  }, [identity, agentId])

  const handleRemoveCapability = useCallback(async (value: string) => {
    if (!identity) return
    const newCaps = identity.capabilities.filter(c => c !== value)
    setSaving('capabilities')
    try {
      await updateAgentIdentity(agentId, { capabilities: newCaps })
      setIdentity({ ...identity, capabilities: newCaps })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    }
    setSaving(null)
  }, [identity, agentId])

  const handleAddResponsibility = useCallback(async (value: string) => {
    if (!identity) return
    const customOnly = identity.responsibilities.filter(r => !r.locked).map(r => r.value)
    const newCustom = [...customOnly, value]
    setSaving('responsibilities')
    try {
      await updateAgentIdentity(agentId, { responsibilities: newCustom })
      const newPills: IdentityPill[] = [
        ...identity.responsibilities.filter(r => r.locked),
        ...newCustom.map(v => ({ value: v, source: 'custom', locked: false })),
      ]
      setIdentity({ ...identity, responsibilities: newPills })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    }
    setSaving(null)
  }, [identity, agentId])

  const handleRemoveResponsibility = useCallback(async (value: string) => {
    if (!identity) return
    const customOnly = identity.responsibilities.filter(r => !r.locked && r.value !== value).map(r => r.value)
    setSaving('responsibilities')
    try {
      await updateAgentIdentity(agentId, { responsibilities: customOnly })
      setIdentity({
        ...identity,
        responsibilities: identity.responsibilities.filter(r => r.locked || r.value !== value),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    }
    setSaving(null)
  }, [identity, agentId])

  const handleAddGuardrail = useCallback(async (value: string) => {
    if (!identity) return
    const customOnly = identity.guardrails.filter(g => !g.locked).map(g => g.value)
    const newCustom = [...customOnly, value]
    setSaving('guardrails')
    try {
      await updateAgentIdentity(agentId, { guardrails: newCustom })
      const newPills: IdentityPill[] = [
        ...identity.guardrails.filter(g => g.locked),
        ...newCustom.map(v => ({ value: v, source: 'custom', locked: false })),
      ]
      setIdentity({ ...identity, guardrails: newPills })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    }
    setSaving(null)
  }, [identity, agentId])

  const handleRemoveGuardrail = useCallback(async (value: string) => {
    if (!identity) return
    const customOnly = identity.guardrails.filter(g => !g.locked && g.value !== value).map(g => g.value)
    setSaving('guardrails')
    try {
      await updateAgentIdentity(agentId, { guardrails: customOnly })
      setIdentity({
        ...identity,
        guardrails: identity.guardrails.filter(g => g.locked || g.value !== value),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    }
    setSaving(null)
  }, [identity, agentId])

  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading) return <Spinner />
  if (error && !identity) {
    return (
      <div className="p-4 bg-surface rounded-lg border border-border">
        <p className="text-sm text-red">{error}</p>
        <button onClick={load} className="text-xs text-accent mt-2 hover:underline">Retry</button>
      </div>
    )
  }
  if (!identity) return null

  const { agent, profile_stats: stats, calibration } = identity

  // Convert capabilities to Pill format
  const capPills = identity.capabilities.map(c => ({
    value: c, source: 'custom', locked: false,
  }))

  // Convert projects/teams to Pill format
  const projectPills = identity.projects.map(p => ({
    value: p.name || p.id, source: 'custom', locked: true,
  }))
  const teamPills = identity.teams.map(t => ({
    value: `${t.name || t.id} (${t.role})`, source: 'custom', locked: true,
  }))

  return (
    <div className="flex flex-col gap-4">
      {/* Error banner */}
      {error && (
        <div className="px-3 py-2 bg-red/10 border border-red/20 rounded-lg text-xs text-red flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red/60 hover:text-red">dismiss</button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-3 p-4 bg-surface rounded-lg border border-border">
        <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-sm font-bold ${getAgentColor(agent.id)}`}>
          {getAgentInitials(agent.name || agent.id)}
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-text truncate">{agent.name || agent.id}</h2>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant={agent.status === 'online' ? 'green' : 'muted'}>
              {agent.status}
            </Badge>
            <Badge variant={agent.agent_type === 'drone' ? 'red' : 'blue'}>
              {agent.agent_type}
            </Badge>
            {agent.role && agent.role !== 'agent' && (
              <Badge variant="purple">{agent.role}</Badge>
            )}
            {agent.llm_model && (
              <span className="text-xs text-text-dim">{agent.llm_model}</span>
            )}
            {agent.runtime && (
              <span className="text-xs text-text-muted">{agent.runtime}</span>
            )}
          </div>
        </div>
        {saving && (
          <span className="text-[10px] text-accent animate-pulse shrink-0">
            Saving {saving}...
          </span>
        )}
      </div>

      {/* Profile stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatMini label="Sessions" value={String(stats.session_count)} />
          <StatMini label="Tasks Done" value={String(stats.total_tasks_completed)} />
          <StatMini label="Bugs Fixed" value={String(stats.total_bugs_fixed)} />
          <StatMini label="PRs Created" value={String(stats.total_prs_created)} />
        </div>
      )}

      {/* Pill cloud sections */}
      <div className="p-4 bg-surface rounded-lg border border-border flex flex-col gap-5">
        <PillCloud
          category="projects"
          pills={projectPills}
        />

        <PillCloud
          category="teams"
          pills={teamPills}
        />

        <PillCloud
          category="capabilities"
          pills={capPills}
          editable
          forbiddenValues={identity.forbidden_capabilities}
          presets={CAPABILITY_PRESETS}
          onAdd={handleAddCapability}
          onRemove={handleRemoveCapability}
        />

        <PillCloud
          category="responsibilities"
          pills={identity.responsibilities}
          editable
          presets={RESPONSIBILITY_PRESETS}
          onAdd={handleAddResponsibility}
          onRemove={handleRemoveResponsibility}
        />

        <PillCloud
          category="guardrails"
          pills={identity.guardrails}
          editable
          presets={GUARDRAIL_PRESETS}
          onAdd={handleAddGuardrail}
          onRemove={handleRemoveGuardrail}
        />
      </div>

      {/* Calibration chain */}
      {calibration.layers_applied.length > 0 && (
        <div className="p-4 bg-surface rounded-lg border border-border">
          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
            Calibration Chain
          </h4>
          <div className="flex items-center gap-2 flex-wrap">
            {calibration.layers_applied.map((layer, i) => (
              <div key={layer.id} className="flex items-center gap-2">
                {i > 0 && <span className="text-text-muted/40">&rarr;</span>}
                <span className={`text-xs px-2 py-0.5 rounded font-mono ${
                  layer.layer === 'platform' ? 'bg-accent/10 text-accent' :
                  layer.layer === 'customer' ? 'bg-blue/10 text-blue' :
                  'bg-green/10 text-green'
                }`}>
                  {layer.layer}: {layer.id}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Mini stat ───────────────────────────────────────────────────────────────

function StatMini({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2.5 bg-surface rounded-lg border border-border">
      <div className="text-[10px] text-text-muted uppercase tracking-wider">{label}</div>
      <div className="text-base font-semibold text-text mt-0.5">{value}</div>
    </div>
  )
}

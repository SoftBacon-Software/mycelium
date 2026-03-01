import { useDashboardStore } from '../stores/dashboardStore'
import { updateConfig } from '../api/endpoints'
import ConfigPanel from '../components/operators/ConfigPanel'
import KillSwitch from '../components/operators/KillSwitch'
import type { Operator } from '../api/types'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function OperatorCard({ operator }: { operator: Operator }) {
  return (
    <div className="bg-surface-raised rounded-lg p-4 flex flex-col gap-3 border border-border/50 hover:border-border transition-colors">
      {/* Header: name + role */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-text truncate">{operator.display_name}</h3>
        <span className="shrink-0 text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full font-medium">
          {operator.role}
        </span>
      </div>

      {/* ID */}
      <p className="text-text-muted font-mono text-sm leading-none">{operator.id}</p>

      {/* Responsibilities */}
      {operator.responsibilities && (
        <p className="text-text-dim text-sm leading-relaxed">{operator.responsibilities}</p>
      )}

      {/* Email */}
      {operator.email && (
        <p className="text-text-muted text-sm">{operator.email}</p>
      )}

      {/* Linked agents */}
      {operator.linked_agents.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {operator.linked_agents.map((agentId, i) => (
            <span
              key={agentId}
              className={`text-xs px-2 py-0.5 rounded-full bg-surface font-mono ${
                i % 2 === 0 ? 'text-green' : 'text-blue'
              }`}
            >
              {agentId}
            </span>
          ))}
        </div>
      )}

      {/* Created date */}
      <p className="text-text-muted text-xs mt-auto pt-1">
        Joined {formatDate(operator.created_at)}
      </p>
    </div>
  )
}

function TeamMembersSection({ operators }: { operators: Operator[] }) {
  if (operators.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-text-muted text-sm">No team members registered yet.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {operators.map((op) => (
        <OperatorCard key={op.id} operator={op} />
      ))}
    </div>
  )
}

export default function OperatorsPage() {
  const operators = useDashboardStore((s) => s.operators)
  const instanceConfig = useDashboardStore((s) => s.instanceConfig)
  const loading = useDashboardStore((s) => s.loading)
  const error = useDashboardStore((s) => s.error)
  const refresh = useDashboardStore((s) => s.refresh)

  async function handleConfigSave(key: string, value: string) {
    await updateConfig(key, value)
    await refresh()
  }

  // Loading state
  if (loading && operators.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-3" />
          <p className="text-text-dim text-sm">Loading operators...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error && operators.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-red text-sm mb-3">Failed to load operator data</p>
        <p className="text-text-muted text-xs mb-4">{error}</p>
        <button
          onClick={refresh}
          className="px-4 py-2 rounded text-sm bg-surface-raised text-text-dim hover:text-text transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Section 1: Team Members */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-text">Team Members</h2>
            <p className="text-text-muted text-sm mt-0.5">
              {operators.length} operator{operators.length !== 1 ? 's' : ''} registered
            </p>
          </div>
        </div>
        <TeamMembersSection operators={operators} />
      </section>

      {/* Section 2: Instance Config */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-text">Instance Configuration</h2>
          <p className="text-text-muted text-sm mt-0.5">
            Click any value to edit inline. Changes are saved on blur or Enter.
          </p>
        </div>
        <ConfigPanel configs={instanceConfig} onSave={handleConfigSave} />
      </section>

      {/* Section 3: Kill Switch */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-text">Emergency Controls</h2>
          <p className="text-text-muted text-sm mt-0.5">
            System-wide operational overrides.
          </p>
        </div>
        <KillSwitch />
      </section>
    </div>
  )
}

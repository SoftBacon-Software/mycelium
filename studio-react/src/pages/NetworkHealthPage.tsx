import { useEffect, useMemo } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import Badge from '../components/shared/Badge'
import StatusDot from '../components/shared/StatusDot'
import type { Agent, Plan, DroneJob, Event, Bug, ConfigEntry } from '../api/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTimestamp(dateStr: string): number {
  if (dateStr.includes('T')) return new Date(dateStr).getTime()
  return new Date(dateStr.replace(' ', 'T') + 'Z').getTime()
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const ts = parseTimestamp(dateStr)
  if (isNaN(ts)) return '-'
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function getAgentInitials(name: string): string {
  const parts = name.split(/[-_ ]+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function parseCaps(caps: string[] | unknown): string[] {
  if (Array.isArray(caps)) return caps
  try { return JSON.parse(caps as string) } catch { return [] }
}

// ─── Event badge color mapping ────────────────────────────────────────────────

const eventBadgeVariant: Record<string, 'accent' | 'blue' | 'green' | 'muted' | 'purple' | 'red'> = {
  task_created: 'accent',
  task_updated: 'blue',
  task_completed: 'green',
  task_unblocked: 'green',
  task_approved: 'green',
  message_sent: 'green',
  message_received: 'green',
  agent_boot: 'purple',
  agent_heartbeat: 'muted',
  agent_registered: 'purple',
  agent_removed: 'red',
  heartbeat: 'muted',
  agent_online: 'purple',
  agent_offline: 'purple',
  agent_status: 'purple',
  bug_created: 'red',
  bug_updated: 'red',
  bug_filed: 'red',
  bug_resolved: 'green',
  plan_created: 'purple',
  plan_updated: 'purple',
  plan_completed: 'green',
  plan_step_completed: 'green',
  drone_job_created: 'blue',
  drone_job_claimed: 'blue',
  drone_job_done: 'green',
  drone_job_failed: 'red',
  approval_created: 'accent',
  approval_resolved: 'green',
  context_updated: 'muted',
  config_changed: 'muted',
  admin_frozen: 'red',
  admin_unfrozen: 'green',
}

function getEventBadgeVariant(type: string): 'accent' | 'blue' | 'green' | 'muted' | 'purple' | 'red' {
  if (eventBadgeVariant[type]) return eventBadgeVariant[type]
  if (type.startsWith('task')) return 'accent'
  if (type.startsWith('message')) return 'green'
  if (type.startsWith('agent')) return 'purple'
  if (type.startsWith('bug')) return 'red'
  if (type.startsWith('plan')) return 'purple'
  if (type.startsWith('drone')) return 'blue'
  return 'muted'
}

// ─── Network health computation ───────────────────────────────────────────────

type HealthLevel = 'green' | 'amber' | 'red'

function computeNetworkHealth(
  agents: Agent[],
  _drones: Agent[],
  bugs: Bug[],
  instanceConfig: ConfigEntry[],
): { level: HealthLevel; label: string } {
  const isFrozen = instanceConfig.some(
    (c) => c.key === 'admin_status' && c.value === 'frozen',
  )
  if (isFrozen) return { level: 'red', label: 'Frozen' }

  const allWorkers = [...agents, ..._drones]
  const onlineWorkers = allWorkers.filter((a) => a.status === 'online').length
  const totalWorkers = allWorkers.length
  const criticalBugs = bugs.filter(
    (b) => b.severity === 'critical' && b.status !== 'fixed' && b.status !== 'closed',
  ).length
  const workerRatio = totalWorkers > 0 ? onlineWorkers / totalWorkers : 0

  if (workerRatio > 0.5 && criticalBugs === 0) {
    return { level: 'green', label: 'Healthy' }
  }
  return { level: 'amber', label: 'Degraded' }
}

const healthColors: Record<HealthLevel, { bg: string; text: string; dot: string }> = {
  green: { bg: 'bg-green/10', text: 'text-green', dot: 'bg-green' },
  amber: { bg: 'bg-accent/10', text: 'text-accent', dot: 'bg-accent' },
  red: { bg: 'bg-red/10', text: 'text-red', dot: 'bg-red' },
}

// ─── Agent avatar colors ──────────────────────────────────────────────────────

const agentAvatarColors: Record<string, string> = {
  hijack: 'bg-purple/20 text-purple',
  greatness: 'bg-green/20 text-green',
}

function getAvatarColor(agentId: string): string {
  const key = agentId.replace(/-claude$/, '')
  return agentAvatarColors[key] || 'bg-accent/20 text-accent'
}

// ─── Role badge variant ───────────────────────────────────────────────────────

function getRoleBadgeVariant(agentType: string): 'purple' | 'blue' | 'accent' | 'muted' {
  if (agentType === 'admin') return 'purple'
  if (agentType === 'drone') return 'blue'
  if (agentType === 'agent') return 'accent'
  return 'muted'
}

// ─── Plan step status colors ──────────────────────────────────────────────────

const stepStatusColors: Record<string, string> = {
  done: 'bg-green',
  completed: 'bg-green',
  in_progress: 'bg-accent',
  pending: 'bg-surface-raised',
  blocked: 'bg-red',
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function NetworkStatusBar({
  agents,
  drones,
  plans,
  bugs,
  instanceConfig,
}: {
  agents: Agent[]
  drones: Agent[]
  plans: Plan[]
  bugs: Bug[]
  instanceConfig: ConfigEntry[]
}) {
  const onlineAgents = agents.filter((a) => a.status === 'online').length
  const onlineDrones = drones.filter((d) => d.status === 'online').length
  const activePlans = plans.filter(
    (p) => p.status === 'active' || p.status === 'in_progress',
  ).length
  const openBugs = bugs.filter(
    (b) => b.status !== 'fixed' && b.status !== 'closed',
  ).length
  const health = computeNetworkHealth(agents, drones, bugs, instanceConfig)
  const hc = healthColors[health.level]

  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        {/* Health indicator */}
        <div className={`flex items-center gap-2.5 px-3 py-1.5 rounded-full ${hc.bg}`}>
          <span className={`w-2.5 h-2.5 rounded-full ${hc.dot} animate-pulse`} />
          <span className={`text-sm font-semibold ${hc.text}`}>{health.label}</span>
        </div>

        <div className="h-6 w-px bg-border hidden sm:block" />

        {/* Stats */}
        <StatPill
          label="Agents"
          value={`${onlineAgents}/${agents.length}`}
          accent={onlineAgents > 0}
        />
        <StatPill
          label="Drones"
          value={`${onlineDrones}/${drones.length}`}
          accent={onlineDrones > 0}
        />
        <StatPill
          label="Active Plans"
          value={activePlans}
          accent={activePlans > 0}
        />
        <StatPill
          label="Open Bugs"
          value={openBugs}
          danger={openBugs > 0}
        />
      </div>
    </div>
  )
}

function StatPill({
  label,
  value,
  accent = false,
  danger = false,
}: {
  label: string
  value: string | number
  accent?: boolean
  danger?: boolean
}) {
  const valueColor = danger
    ? 'text-red'
    : accent
      ? 'text-accent'
      : 'text-text-dim'

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${valueColor}`}>
        {value}
      </span>
    </div>
  )
}

function AgentsGrid({ agents }: { agents: Agent[] }) {
  if (agents.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">No agents registered</p>
      </div>
    )
  }

  // Sort: online first, then by name
  const sorted = [...agents].sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1
    if (a.status !== 'online' && b.status === 'online') return 1
    return (a.name || a.id).localeCompare(b.name || b.id)
  })

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {sorted.map((agent) => (
        <AgentCard key={agent.id} agent={agent} />
      ))}
    </div>
  )
}

function AgentCard({ agent }: { agent: Agent }) {
  const caps = parseCaps(agent.capabilities)

  return (
    <div className="bg-surface rounded-lg border border-border p-4 transition-all hover:ring-1 ring-border">
      {/* Header row */}
      <div className="flex items-center gap-3 mb-2">
        <div
          className={`w-10 h-10 rounded-lg ${getAvatarColor(agent.id)} flex items-center justify-center text-xs font-bold shrink-0`}
        >
          {getAgentInitials(agent.name || agent.id)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-text truncate">
              {agent.name || agent.id}
            </span>
            <StatusDot status={agent.status} />
            <Badge variant={getRoleBadgeVariant(agent.agent_type)}>
              {agent.agent_type || 'agent'}
            </Badge>
          </div>
          <p className="text-xs text-text-muted font-mono truncate mt-0.5">
            {agent.project_id || 'no project'}
          </p>
        </div>
      </div>

      {/* LLM info */}
      {(agent.llm_backend || agent.llm_model) && (
        <div className="flex items-center gap-1.5 mb-2 ml-[52px]">
          {agent.llm_backend && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-raised text-text-muted">
              {agent.llm_backend}
            </span>
          )}
          {agent.llm_model && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-raised text-text-dim">
              {agent.llm_model}
            </span>
          )}
        </div>
      )}

      {/* Working on */}
      {agent.working_on && (
        <p className="text-sm text-text-dim italic truncate mb-2 ml-[52px]">
          {agent.working_on}
        </p>
      )}

      {/* Footer: heartbeat + caps */}
      <div className="flex items-center justify-between ml-[52px]">
        <div className="flex flex-wrap gap-1 min-w-0">
          {caps.slice(0, 3).map((cap) => (
            <Badge key={cap} variant="muted">{cap}</Badge>
          ))}
          {caps.length > 3 && (
            <Badge variant="muted">+{caps.length - 3}</Badge>
          )}
        </div>
        <span className="text-xs text-text-muted font-mono shrink-0 ml-2 tabular-nums">
          {timeAgo(agent.last_heartbeat)}
        </span>
      </div>
    </div>
  )
}

function DronesGrid({
  drones,
  droneJobs,
}: {
  drones: Agent[]
  droneJobs: DroneJob[]
}) {
  if (drones.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">No drones registered</p>
      </div>
    )
  }

  // Sort: online first
  const sorted = [...drones].sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1
    if (a.status !== 'online' && b.status === 'online') return 1
    return (a.name || a.id).localeCompare(b.name || b.id)
  })

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {sorted.map((drone) => (
        <DroneCard key={drone.id} drone={drone} droneJobs={droneJobs} />
      ))}
    </div>
  )
}

function DroneCard({
  drone,
  droneJobs,
}: {
  drone: Agent
  droneJobs: DroneJob[]
}) {
  const caps = parseCaps(drone.capabilities)
  const currentJob = droneJobs.find(
    (j) => j.status === 'claimed' && j.drone_id === drone.id,
  )
  const completedCount = droneJobs.filter(
    (j) => j.status === 'done' && j.drone_id === drone.id,
  ).length

  return (
    <div className="bg-surface rounded-lg border border-border p-4 transition-all hover:ring-1 ring-border">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={drone.status} />
          <span className="text-sm font-semibold text-text truncate">
            {drone.name || drone.id}
          </span>
          <span className="text-xs text-text-muted font-mono">{drone.status}</span>
        </div>
        <span className="text-xs text-text-muted font-mono tabular-nums shrink-0">
          {timeAgo(drone.last_heartbeat)}
        </span>
      </div>

      {/* Capabilities */}
      {caps.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {caps.map((cap) => (
            <Badge key={cap} variant="blue">{cap}</Badge>
          ))}
        </div>
      )}

      {/* Current job */}
      {currentJob ? (
        <div className="bg-accent/5 border border-accent/10 rounded p-2.5 mb-2">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
            <span className="text-xs font-medium text-accent">Active Job</span>
            <span className="text-xs text-text-muted font-mono">#{currentJob.id}</span>
          </div>
          <p className="text-sm text-text-dim truncate mt-1 ml-3.5">
            {currentJob.title}
          </p>
        </div>
      ) : (
        <p className="text-xs text-text-muted mb-2 italic">No active job</p>
      )}

      {/* Completed count */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>Jobs completed</span>
        <span className="font-mono tabular-nums text-text-dim">{completedCount}</span>
      </div>
    </div>
  )
}

function ActivePlansProgress({ plans }: { plans: Plan[] }) {
  const activePlans = plans.filter(
    (p) => p.status === 'active' || p.status === 'in_progress',
  )

  if (activePlans.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">No active plans</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {activePlans.map((plan) => (
        <PlanProgressCard key={plan.id} plan={plan} />
      ))}
    </div>
  )
}

function PlanProgressCard({ plan }: { plan: Plan }) {
  const steps = plan.steps ?? []
  const total = plan.progress?.total ?? steps.length
  const completed = plan.progress?.completed ?? steps.filter(
    (s) => s.status === 'done' || s.status === 'completed',
  ).length
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0

  // Find current in-progress step
  const currentStep = steps.find((s) => s.status === 'in_progress')

  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      {/* Title + progress */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-text truncate">{plan.title}</h3>
          {plan.project_id && (
            <span className="text-xs text-text-muted font-mono">{plan.project_id}</span>
          )}
        </div>
        <span className="text-xs text-text-muted font-mono tabular-nums shrink-0">
          {completed}/{total} ({percent}%)
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-surface-raised rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-green rounded-full transition-all duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Step dots */}
      {steps.length > 0 && steps.length <= 20 && (
        <div className="flex items-center gap-1 mb-3 flex-wrap">
          {steps.map((step) => {
            const isActive = step.status === 'in_progress'
            const color = stepStatusColors[step.status] || 'bg-surface-raised'
            return (
              <div
                key={step.id}
                title={`${step.step_number}. ${step.title} (${step.status})${step.assignee ? ` — ${step.assignee}` : ''}`}
                className={`w-3 h-3 rounded-sm ${color} ${isActive ? 'ring-2 ring-accent/50' : ''} transition-all`}
              />
            )
          })}
        </div>
      )}

      {/* Current step callout */}
      {currentStep && (
        <div className="bg-accent/5 border border-accent/10 rounded p-2.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
            <span className="text-accent font-medium">Step {currentStep.step_number}</span>
            <span className="text-text-dim truncate">{currentStep.title}</span>
            {currentStep.assignee && (
              <Badge variant="accent" className="ml-auto shrink-0">
                {currentStep.assignee}
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* Step list with assignees (compact) */}
      {steps.length > 0 && (
        <div className="mt-3 space-y-1 max-h-40 overflow-y-auto">
          {steps.map((step) => {
            const isDone = step.status === 'done' || step.status === 'completed'
            const isActive = step.status === 'in_progress'
            return (
              <div
                key={step.id}
                className={`flex items-center gap-2 py-1 px-2 rounded text-xs ${
                  isActive ? 'bg-accent/5' : ''
                }`}
              >
                <span
                  className={`w-4 text-right tabular-nums shrink-0 ${
                    isDone ? 'text-green' : isActive ? 'text-accent' : 'text-text-muted'
                  }`}
                >
                  {isDone ? '\u2713' : step.step_number}
                </span>
                <span
                  className={`truncate flex-1 ${
                    isDone
                      ? 'text-text-muted line-through'
                      : isActive
                        ? 'text-text font-medium'
                        : 'text-text-dim'
                  }`}
                >
                  {step.title}
                </span>
                {step.assignee && (
                  <span className="text-[10px] font-mono text-text-muted shrink-0">
                    {step.assignee}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RecentActivityFeed({ events }: { events: Event[] }) {
  const recent = events.slice(0, 20)

  if (recent.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">No recent activity</p>
      </div>
    )
  }

  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className="space-y-0.5 max-h-[400px] overflow-y-auto pr-1">
        {recent.map((event) => (
          <div
            key={event.id}
            className="flex items-start gap-3 py-1.5 px-2 rounded hover:bg-surface-raised/50 transition-colors group"
          >
            <span className="text-[11px] text-text-muted font-mono w-12 shrink-0 pt-0.5 tabular-nums">
              {formatTimestamp(event.created_at)}
            </span>
            <Badge variant={getEventBadgeVariant(event.type)} className="shrink-0 mt-0.5">
              {event.type.replace(/_/g, ' ')}
            </Badge>
            <span className="text-sm text-text-dim leading-snug flex-1 min-w-0 group-hover:text-text transition-colors">
              {event.agent && (
                <span className="font-mono text-xs text-accent mr-1.5">{event.agent}</span>
              )}
              <span className="truncate">{event.summary}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NetworkHealthPage() {
  const {
    agents,
    drones,
    droneJobs,
    plans,
    bugs,
    events,
    instanceConfig,
    loading,
    refresh,
  } = useDashboardStore()

  useEffect(() => {
    refresh()
  }, [refresh])

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      refresh()
    }, 30_000)
    return () => clearInterval(interval)
  }, [refresh])

  // Filter agents: non-drone agents only for the agents grid
  const nonDroneAgents = useMemo(
    () => agents.filter((a) => a.agent_type !== 'drone'),
    [agents],
  )

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Network Health</h1>
          <p className="text-sm text-text-muted mt-0.5">Mission control overview</p>
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="text-xs text-text-muted hover:text-accent transition-colors px-3 py-1.5 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* 1. Network Status Bar */}
      <NetworkStatusBar
        agents={nonDroneAgents}
        drones={drones}
        plans={plans}
        bugs={bugs}
        instanceConfig={instanceConfig}
      />

      {/* 2. Agents Grid */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Agents
          <span className="text-text-muted font-normal">
            ({nonDroneAgents.filter((a) => a.status === 'online').length}/{nonDroneAgents.length} online)
          </span>
        </h2>
        <AgentsGrid agents={nonDroneAgents} />
      </section>

      {/* 3. Drones Grid */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Drones
          <span className="text-text-muted font-normal">
            ({drones.filter((d) => d.status === 'online').length}/{drones.length} online)
          </span>
        </h2>
        <DronesGrid drones={drones} droneJobs={droneJobs} />
      </section>

      {/* 4. Active Plans Progress */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Active Plans
          <span className="text-text-muted font-normal">
            ({plans.filter((p) => p.status === 'active' || p.status === 'in_progress').length})
          </span>
        </h2>
        <ActivePlansProgress plans={plans} />
      </section>

      {/* 5. Recent Activity Feed */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3">Recent Activity</h2>
        <RecentActivityFeed events={events} />
      </section>
    </div>
  )
}

import { useEffect, useMemo, useState, useRef } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useLiveStore } from '../stores/liveStore'
import Badge from '../components/shared/Badge'
import StatusDot from '../components/shared/StatusDot'
import { timeAgo, formatTime } from '../utils/time'
import { getSenderDisplay } from '../utils/sender'
import type { Agent, Plan, DroneJob, Event, Bug, ConfigEntry } from '../api/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  task_dependency: 'blue',
  task_comment: 'blue',
  message_sent: 'green',
  message_received: 'green',
  agent_boot: 'purple',
  agent_heartbeat: 'muted',
  agent_registered: 'purple',
  agent_removed: 'red',
  agent_key_regenerated: 'purple',
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
  plan_step_added: 'blue',
  drone_job_created: 'blue',
  drone_job_claimed: 'blue',
  drone_job_done: 'green',
  drone_job_failed: 'red',
  approval_created: 'accent',
  approval_requested: 'accent',
  approval_resolved: 'green',
  approval_executed: 'green',
  approval_vote: 'blue',
  approval_denied: 'red',
  approval_approved: 'green',
  channel_created: 'blue',
  channel_message: 'green',
  channel_deleted: 'red',
  artifact_uploaded: 'accent',
  assets_linked_to_job: 'blue',
  assets_status_updated: 'green',
  context_updated: 'muted',
  context_key_updated: 'muted',
  config_changed: 'muted',
  admin_frozen: 'red',
  admin_unfrozen: 'green',
  sleep_mode_on: 'purple',
  sleep_mode_off: 'green',
  autonomous_mode_on: 'purple',
  autonomous_mode_off: 'green',
  operator_availability: 'blue',
  request_resolved: 'green',
  work_request: 'accent',
  operator_created: 'blue',
  operator_updated: 'blue',
  concept_created: 'purple',
  concept_updated: 'purple',
  project_created: 'blue',
  file_uploaded: 'accent',
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

  if (criticalBugs > 0) return { level: 'red', label: 'Critical' }
  if (workerRatio === 0) return { level: 'red', label: 'No Workers' }
  if (workerRatio > 0.5) return { level: 'green', label: 'Healthy' }
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
  macbook: 'bg-blue/20 text-blue',
  admin: 'bg-accent/20 text-accent',
  unakron: 'bg-accent/20 text-accent',
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

// ─── Sparkline SVG ────────────────────────────────────────────────────────────

function Sparkline({
  data,
  width = 320,
  height = 48,
  color = '#22c55e',
  fillColor,
}: {
  data: number[]
  width?: number
  height?: number
  color?: string
  fillColor?: string
}) {
  if (data.length < 2) {
    return (
      <svg width={width} height={height} className="shrink-0">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke={color} strokeWidth={1} opacity={0.3} />
      </svg>
    )
  }

  const max = Math.max(...data, 1)
  const padding = 2
  const usableH = height - padding * 2
  const stepX = width / (data.length - 1)

  const points = data.map((v, i) => {
    const x = i * stepX
    const y = padding + usableH - (v / max) * usableH
    return `${x},${y}`
  })

  const linePath = `M${points.join(' L')}`
  const fillPath = `${linePath} L${width},${height} L0,${height} Z`

  return (
    <svg width={width} height={height} className="shrink-0">
      {fillColor && <path d={fillPath} fill={fillColor} />}
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {/* Latest value dot */}
      {data.length > 0 && (() => {
        const lastX = (data.length - 1) * stepX
        const lastY = padding + usableH - (data[data.length - 1] / max) * usableH
        return <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
      })()}
    </svg>
  )
}

// ─── Event Rate Pulse ─────────────────────────────────────────────────────────

const BUCKET_SECONDS = 60 // 1-minute buckets
const BUCKET_COUNT = 30   // 30 minutes of history

function useEventRate() {
  const liveEvents = useLiveStore((s) => s.events)
  const connected = useLiveStore((s) => s.connected)
  const [buckets, setBuckets] = useState<number[]>(() => new Array(BUCKET_COUNT).fill(0))
  const bucketsRef = useRef(buckets)
  bucketsRef.current = buckets
  const lastTickRef = useRef(Math.floor(Date.now() / 1000 / BUCKET_SECONDS))
  const eventCountRef = useRef(0)

  // Count events as they arrive from SSE
  const prevLenRef = useRef(liveEvents.length)
  useEffect(() => {
    const newCount = liveEvents.length - prevLenRef.current
    if (newCount > 0) {
      eventCountRef.current += newCount
    } else if (liveEvents.length < prevLenRef.current) {
      // Reset (store was cleared)
      eventCountRef.current = 0
    }
    prevLenRef.current = liveEvents.length
  }, [liveEvents.length])

  // Tick every BUCKET_SECONDS to push a new bucket
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Math.floor(Date.now() / 1000 / BUCKET_SECONDS)
      if (now > lastTickRef.current) {
        lastTickRef.current = now
        setBuckets((prev) => {
          const next = [...prev.slice(1), eventCountRef.current]
          eventCountRef.current = 0
          return next
        })
      }
    }, 5000) // Check every 5 seconds
    return () => clearInterval(interval)
  }, [])

  const currentRate = eventCountRef.current
  const avgRate = buckets.length > 0
    ? Math.round(buckets.reduce((a, b) => a + b, 0) / buckets.filter((b) => b > 0).length || 0)
    : 0
  const peakRate = Math.max(...buckets, currentRate)

  return { buckets, currentRate, avgRate, peakRate, connected }
}

function EventRatePulse() {
  const { buckets, currentRate, avgRate, peakRate, connected } = useEventRate()

  // Color based on rate: green = normal, amber = busy, red = flooding
  const rateColor = currentRate > 20 ? '#ef4444' : currentRate > 10 ? '#f59e0b' : '#22c55e'
  const fillColor = currentRate > 20 ? 'rgba(239,68,68,0.08)' : currentRate > 10 ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)'

  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-dim">Event Pulse</h3>
          {connected ? (
            <span className="flex items-center gap-1.5 text-[10px] text-green font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
              LIVE
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[10px] text-text-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
              OFFLINE
            </span>
          )}
        </div>
        <span className="text-xs text-text-muted">30m window, 1m buckets</span>
      </div>

      {/* Sparkline */}
      <div className="flex items-end gap-4">
        <Sparkline
          data={[...buckets, currentRate]}
          width={400}
          height={56}
          color={rateColor}
          fillColor={fillColor}
        />
        <div className="flex flex-col items-end gap-1 shrink-0">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold tabular-nums" style={{ color: rateColor }}>
              {currentRate}
            </span>
            <span className="text-xs text-text-muted">/min</span>
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-6 mt-3 pt-3 border-t border-border">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Avg</span>
          <span className="text-sm font-semibold tabular-nums text-text-dim">{avgRate}/min</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Peak</span>
          <span className="text-sm font-semibold tabular-nums text-text-dim">{peakRate}/min</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">SSE Buffer</span>
          <span className="text-sm font-semibold tabular-nums text-text-dim">
            {useLiveStore.getState().events.length}/100
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Agent Activity Timeline ──────────────────────────────────────────────────

function AgentActivityTimeline({ agents }: { agents: Agent[] }) {
  const liveEvents = useLiveStore((s) => s.events)
  const recentHeartbeats = useLiveStore((s) => s.recentHeartbeats)

  // Group recent events by agent (last 5 minutes)
  const agentActivity = useMemo(() => {
    const cutoff = Date.now() - 5 * 60 * 1000
    const activity = new Map<string, { count: number; lastEvent: string; lastTime: number }>()

    for (const event of liveEvents) {
      if (!event.agent) continue
      const t = event.created_at ? new Date(event.created_at).getTime() : Date.now()
      if (t < cutoff) continue

      const prev = activity.get(event.agent)
      if (!prev) {
        activity.set(event.agent, { count: 1, lastEvent: event.type, lastTime: t })
      } else {
        prev.count++
        if (t > prev.lastTime) {
          prev.lastEvent = event.type
          prev.lastTime = t
        }
      }
    }
    return activity
  }, [liveEvents])

  const onlineAgents = agents.filter((a) => a.status === 'online')
  if (onlineAgents.length === 0) return null

  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold text-text-dim mb-3">Agent Activity (5m)</h3>
      <div className="space-y-2">
        {onlineAgents.map((agent) => {
          const activity = agentActivity.get(agent.id)
          const hbTime = recentHeartbeats[agent.id]
          const isRecent = hbTime && Date.now() - hbTime < 10_000

          return (
            <div key={agent.id} className="flex items-center gap-3">
              <div className="flex items-center gap-2 w-36 shrink-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${isRecent ? 'bg-green animate-pulse' : 'bg-text-muted/30'}`} />
                <span className="text-sm text-text truncate font-medium">
                  {agent.name || agent.id}
                </span>
              </div>
              {/* Mini bar showing event count */}
              <div className="flex-1 h-4 bg-surface-raised rounded overflow-hidden">
                {activity && activity.count > 0 && (
                  <div
                    className="h-full bg-accent/30 rounded transition-all duration-500"
                    style={{ width: `${Math.min(100, (activity.count / 20) * 100)}%` }}
                  />
                )}
              </div>
              <span className="text-xs text-text-muted tabular-nums w-16 text-right shrink-0">
                {activity ? `${activity.count} events` : 'idle'}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
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
                title={`${step.step_number}. ${step.title} (${step.status})${step.assignee ? ` — ${getSenderDisplay(step.assignee)}` : ''}`}
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
                {getSenderDisplay(currentStep.assignee)}
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
                    {getSenderDisplay(step.assignee)}
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
              {formatTime(event.created_at)}
            </span>
            <Badge variant={getEventBadgeVariant(event.type)} className="shrink-0 mt-0.5">
              {event.type.replace(/_/g, ' ')}
            </Badge>
            <span className="text-sm text-text-dim leading-snug flex-1 min-w-0 group-hover:text-text transition-colors">
              {event.agent && (
                <span className="font-mono text-xs text-accent mr-1.5">{getSenderDisplay(event.agent)}</span>
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

  const liveEvents = useLiveStore((s) => s.events)

  useEffect(() => {
    refresh()
  }, [refresh])

  // SSE-driven auto-refresh: refresh store data when significant events arrive
  const lastRefreshRef = useRef(0)
  useEffect(() => {
    if (liveEvents.length === 0) return
    const latest = liveEvents[0]
    // Skip heartbeats for refresh triggers
    if (latest.type === 'agent_heartbeat') return
    const now = Date.now()
    // Throttle: at most once per 10 seconds
    if (now - lastRefreshRef.current > 10_000) {
      lastRefreshRef.current = now
      refresh()
    }
  }, [liveEvents, refresh])

  // Fallback poll every 60 seconds (reduced from 30s since SSE handles live)
  useEffect(() => {
    const interval = setInterval(() => refresh(), 60_000)
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

      {/* 2. Event Pulse + Agent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <EventRatePulse />
        </div>
        <div>
          <AgentActivityTimeline agents={[...nonDroneAgents, ...drones]} />
        </div>
      </div>

      {/* 3. Agents Grid */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Agents
          <span className="text-text-muted font-normal">
            ({nonDroneAgents.filter((a) => a.status === 'online').length}/{nonDroneAgents.length} online)
          </span>
        </h2>
        <AgentsGrid agents={nonDroneAgents} />
      </section>

      {/* 4. Drones Grid */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Drones
          <span className="text-text-muted font-normal">
            ({drones.filter((d) => d.status === 'online').length}/{drones.length} online)
          </span>
        </h2>
        <DronesGrid drones={drones} droneJobs={droneJobs} />
      </section>

      {/* 5. Active Plans Progress */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Active Plans
          <span className="text-text-muted font-normal">
            ({plans.filter((p) => p.status === 'active' || p.status === 'in_progress').length})
          </span>
        </h2>
        <ActivePlansProgress plans={plans} />
      </section>

      {/* 6. Recent Activity Feed */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3">Recent Activity</h2>
        <RecentActivityFeed events={events} />
      </section>
    </div>
  )
}

import React, { useEffect, useMemo, useState, useRef, Component } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useLiveStore } from '../stores/liveStore'
import { fetchProfiles, fetchCalibration } from '../api/endpoints'
import Badge from '../components/shared/Badge'
import StatusDot from '../components/shared/StatusDot'
import Spinner from '../components/shared/Spinner'
import { timeAgo, formatTime } from '../utils/time'
import { getSenderDisplay } from '../utils/sender'
import type { Agent, Plan, DroneJob, Event, Bug, ConfigEntry, NodeProfile, CalibrationData, DriftItem } from '../api/types'

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
  // Tasks
  task_created: 'accent',
  task_updated: 'blue',
  task_completed: 'green',
  task_unblocked: 'green',
  task_approved: 'green',
  task_comment: 'muted',
  task_dependency: 'muted',
  // Messages
  message_sent: 'green',
  message_received: 'green',
  request_created: 'accent',
  request_acknowledged: 'blue',
  request_resolved: 'green',
  // Agents
  agent_boot: 'purple',
  agent_heartbeat: 'muted',
  agent_registered: 'purple',
  agent_removed: 'red',
  agent_key_regenerated: 'purple',
  heartbeat: 'muted',
  agent_online: 'purple',
  agent_offline: 'purple',
  agent_status: 'purple',
  // Bugs
  bug_created: 'red',
  bug_updated: 'red',
  bug_filed: 'red',
  bug_resolved: 'green',
  bug_deleted: 'red',
  // Plans
  plan_created: 'purple',
  plan_updated: 'purple',
  plan_completed: 'green',
  plan_deleted: 'red',
  plan_step_added: 'purple',
  plan_step_updated: 'blue',
  plan_step_completed: 'green',
  // Drones
  drone_job_created: 'blue',
  drone_job_claimed: 'blue',
  drone_job_done: 'green',
  drone_job_failed: 'red',
  drone_job_cancelled: 'red',
  drone_job_retry: 'blue',
  drone_job_exhausted: 'red',
  drone_job_requeue: 'blue',
  drone_jobs_cleanup: 'muted',
  // Approvals
  approval_requested: 'accent',
  approval_created: 'accent',
  approval_approved: 'green',
  approval_denied: 'red',
  approval_resolved: 'green',
  approval_executed: 'green',
  approval_vote: 'blue',
  // Assets
  asset_registered: 'blue',
  asset_uploaded: 'blue',
  asset_delivered: 'green',
  asset_deleted: 'red',
  assets_linked_to_job: 'blue',
  assets_status_updated: 'muted',
  // Concepts
  concept_created: 'purple',
  concept_updated: 'purple',
  concept_deleted: 'red',
  concept_linked: 'purple',
  // Channels
  channel_created: 'accent',
  channel_deleted: 'red',
  channel_message: 'green',
  // Context & config
  context_updated: 'muted',
  context_key_updated: 'muted',
  config_changed: 'muted',
  // Admin
  admin_frozen: 'red',
  admin_unfrozen: 'green',
  sleep_mode_on: 'blue',
  sleep_mode_off: 'green',
  autonomous_mode_on: 'purple',
  autonomous_mode_off: 'green',
  operator_availability: 'muted',
  operator_created: 'purple',
  operator_updated: 'muted',
  operator_deleted: 'red',
  // Work
  auto_dispatch: 'accent',
  work_claimed: 'accent',
  work_request: 'accent',
  // Plugins
  plugin_enabled: 'green',
  plugin_disabled: 'muted',
  // Other
  studio_user_created: 'purple',
  savepoint_notes: 'muted',
  file_uploaded: 'blue',
  artifact_uploaded: 'blue',
  feedback_submitted: 'green',
  org_created: 'purple',
  project_created: 'purple',
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
  const isFrozen = (instanceConfig || []).some(
    (c) => c.key === 'admin_status' && c.value === 'frozen',
  )
  if (isFrozen) return { level: 'red', label: 'Frozen' }

  const allWorkers = [...(agents || []), ...(_drones || [])]
  const onlineWorkers = allWorkers.filter((a) => a.status === 'online' || a.status === 'idle').length
  const totalWorkers = allWorkers.length
  const criticalBugs = (bugs || []).filter(
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

// ─── Agent avatar colors (auto-generated from ID hash) ───────────────────────

const AVATAR_PALETTES = [
  'bg-purple/20 text-purple',
  'bg-green/20 text-green',
  'bg-blue/20 text-blue',
  'bg-accent/20 text-accent',
  'bg-red/20 text-red',
  'bg-pink-500/20 text-pink-500',
  'bg-teal-500/20 text-teal-500',
  'bg-amber-500/20 text-amber-500',
]

function getAvatarColor(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0
  }
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length]
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
    ? (() => { const active = buckets.filter((b) => b > 0).length; return active > 0 ? Math.round(buckets.reduce((a, b) => a + b, 0) / active) : 0 })()
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

  const STALE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  const isStale = (a: Agent) =>
    a.status !== 'online' && a.status !== 'idle' &&
    a.last_heartbeat && Date.now() - new Date(a.last_heartbeat).getTime() > STALE_MS

  // Sort: online first, then idle, then offline, stale last
  const statusRank = (a: Agent) => {
    if (a.status === 'online') return 0
    if (a.status === 'idle') return 1
    if (isStale(a)) return 3
    return 2
  }
  const sorted = [...agents].sort((a, b) => {
    const r = statusRank(a) - statusRank(b)
    if (r !== 0) return r
    return (a.name || a.id).localeCompare(b.name || b.id)
  })

  const active = sorted.filter((a) => !isStale(a))
  const stale = sorted.filter(isStale)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {active.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
      {stale.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
            Stale ({stale.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 opacity-50">
            {stale.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        </div>
      )}
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
      <div className="flex items-center gap-1.5 mb-2 ml-[52px]">
        {agent.llm_backend && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-raised text-text-muted">
            {agent.llm_backend}
          </span>
        )}
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-raised text-text-dim">
          {agent.llm_model
            ? agent.llm_model
                .replace('claude-opus-4-6', 'opus-4.6')
                .replace('claude-sonnet-4-6', 'sonnet-4.6')
                .replace('claude-haiku-4-5-20251001', 'haiku-4.5')
                .replace('claude-', '')
            : '—'}
        </span>
      </div>

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

// ─── Calibration Status Colors ────────────────────────────────────────────────

const calibrationColors: Record<string, { bg: string; text: string; dot: string }> = {
  aligned: { bg: 'bg-green/10', text: 'text-green', dot: 'bg-green' },
  drifted: { bg: 'bg-accent/10', text: 'text-accent', dot: 'bg-accent' },
  critical: { bg: 'bg-red/10', text: 'text-red', dot: 'bg-red' },
  unknown: { bg: 'bg-blue/10', text: 'text-blue', dot: 'bg-blue' },
}

// ─── Calibration Summary Cards ────────────────────────────────────────────────

function CalibrationSummary({
  calibrations,
  totalAgents,
}: {
  calibrations: Map<string, CalibrationData>
  totalAgents: number
}) {
  const counts = useMemo(() => {
    let aligned = 0
    let drifted = 0
    let critical = 0
    for (const [, cal] of calibrations) {
      if (cal.status === 'aligned') aligned++
      else if (cal.status === 'drifted') drifted++
      else if (cal.status === 'critical') critical++
    }
    const unknown = totalAgents - aligned - drifted - critical
    return { aligned, drifted, critical, unknown }
  }, [calibrations, totalAgents])

  const cards = [
    { label: 'Total', value: totalAgents, color: 'text-text-dim', bg: 'bg-surface-raised' },
    { label: 'Aligned', value: counts.aligned, color: 'text-green', bg: 'bg-green/10' },
    { label: 'Drifted', value: counts.drifted, color: 'text-accent', bg: 'bg-accent/10' },
    { label: 'Critical', value: counts.critical, color: 'text-red', bg: 'bg-red/10' },
  ]

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((card) => (
        <div key={card.label} className={`${card.bg} rounded-lg p-4 text-center`}>
          <div className={`text-2xl font-bold tabular-nums ${card.color}`}>
            {card.value}
          </div>
          <div className="text-xs text-text-muted mt-1">{card.label}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Agent Calibration Table ──────────────────────────────────────────────────

function CalibrationTable({
  agents,
  calibrations,
}: {
  agents: Agent[]
  calibrations: Map<string, CalibrationData>
}) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)

  // Sort: critical first, then drifted, then aligned, then unknown
  const statusRank = (id: string) => {
    const cal = calibrations.get(id)
    if (!cal) return 3
    if (cal.status === 'critical') return 0
    if (cal.status === 'drifted') return 1
    return 2
  }
  const sorted = [...agents].sort((a, b) => statusRank(a.id) - statusRank(b.id))

  if (agents.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">No agents to calibrate</p>
      </div>
    )
  }

  return (
    <div className="bg-surface rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <div className="grid grid-cols-[1fr_80px_90px_80px_100px] gap-2 px-4 py-2 border-b border-border text-[10px] uppercase tracking-wider font-semibold text-text-muted">
        <span>Agent</span>
        <span>Type</span>
        <span>Status</span>
        <span>Drift</span>
        <span>Last Boot</span>
      </div>

      {/* Rows */}
      {sorted.map((agent) => {
        const cal = calibrations.get(agent.id)
        const status = cal?.status || 'unknown'
        const colors = calibrationColors[status] || calibrationColors.unknown
        const driftCount = cal?.drift?.length || 0
        const isExpanded = expandedAgent === agent.id

        return (
          <div key={agent.id}>
            <div
              className="grid grid-cols-[1fr_80px_90px_80px_100px] gap-2 px-4 py-2.5 hover:bg-surface-raised/50 transition-colors cursor-pointer border-b border-border/50"
              onClick={() => setExpandedAgent(isExpanded ? null : agent.id)}
            >
              {/* Agent name */}
              <div className="flex items-center gap-2 min-w-0">
                <StatusDot status={agent.status} />
                <span className="text-sm font-medium text-text truncate">
                  {agent.name || agent.id}
                </span>
              </div>

              {/* Type */}
              <div>
                <Badge variant={getRoleBadgeVariant(agent.agent_type)}>
                  {agent.agent_type || 'agent'}
                </Badge>
              </div>

              {/* Calibration Status */}
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${colors.dot} shrink-0`} />
                <span className={`text-xs font-semibold ${colors.text}`}>
                  {status}
                </span>
              </div>

              {/* Drift count */}
              <span className={`text-xs tabular-nums ${driftCount > 0 ? 'text-accent font-semibold' : 'text-text-muted'}`}>
                {driftCount}
              </span>

              {/* Last boot */}
              <span className="text-xs text-text-muted font-mono tabular-nums">
                {timeAgo(agent.last_heartbeat)}
              </span>
            </div>

            {/* Expanded drift details */}
            {isExpanded && cal && cal.drift && cal.drift.length > 0 && (
              <div className="px-6 py-3 bg-bg border-b border-border/50">
                <div className="space-y-2">
                  {cal.drift.map((d, idx) => (
                    <DriftItemRow key={idx} item={d} />
                  ))}
                </div>
              </div>
            )}
            {isExpanded && (!cal || !cal.drift || cal.drift.length === 0) && (
              <div className="px-6 py-3 bg-bg border-b border-border/50">
                <p className="text-xs text-text-muted italic">
                  {cal ? 'No drift detected -- agent is fully aligned' : 'No calibration data available. Agent needs to send md_report in heartbeat.'}
                </p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function DriftItemRow({ item }: { item: DriftItem }) {
  const suggestion = useMemo(() => {
    if (item.rule === 'md_checkpoint_missing') {
      const anchor = item.detail.replace('Expected anchor not found in CLAUDE.md: ', '')
      return `Add "${anchor}" to the agent's CLAUDE.md file`
    }
    if (item.rule === 'md_blocklist_found') {
      const term = item.detail.replace('Blocked term found in CLAUDE.md: ', '')
      return `Remove "${term}" from the agent's CLAUDE.md file`
    }
    if (item.rule === 'md_report_missing') {
      return 'Agent should include md_report in heartbeat state_snapshot'
    }
    return null
  }, [item])

  return (
    <div className="flex items-start gap-3 py-1">
      <Badge variant={item.level === 'critical' ? 'red' : item.level === 'warning' ? 'accent' : 'blue'} className="shrink-0 mt-0.5">
        {item.level}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-text-dim">{item.detail}</p>
        {suggestion && (
          <p className="text-[10px] text-text-muted mt-0.5 italic">Fix: {suggestion}</p>
        )}
      </div>
    </div>
  )
}

// ─── Profile List ─────────────────────────────────────────────────────────────

function ProfileList({ profiles }: { profiles: NodeProfile[] }) {
  const [expanded, setExpanded] = useState(false)

  const byLayer = useMemo(() => {
    const groups: Record<string, NodeProfile[]> = { platform: [], customer: [], agent: [] }
    for (const p of profiles) {
      const layer = p.layer || 'agent'
      if (!groups[layer]) groups[layer] = []
      groups[layer].push(p)
    }
    return groups
  }, [profiles])

  const layerLabels: Record<string, { label: string; desc: string; color: string }> = {
    platform: { label: 'Platform', desc: 'Read-only base rules', color: 'text-purple' },
    customer: { label: 'Customer', desc: 'Instance-level overrides', color: 'text-accent' },
    agent: { label: 'Agent', desc: 'Per-agent overrides', color: 'text-green' },
  }

  if (profiles.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-6 text-center">
        <p className="text-sm text-text-muted">No profiles configured</p>
      </div>
    )
  }

  return (
    <div className="bg-surface rounded-lg border border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-dim">Profile Chain</h3>
          <span className="text-xs text-text-muted">({profiles.length} profiles)</span>
        </div>
        <span className={`text-text-muted text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {['platform', 'customer', 'agent'].map((layer) => {
            const items = byLayer[layer] || []
            if (items.length === 0) return null
            const info = layerLabels[layer]

            return (
              <div key={layer} className="border-b border-border/50 last:border-b-0">
                <div className="px-4 py-2 bg-bg">
                  <span className={`text-xs font-semibold uppercase tracking-wider ${info.color}`}>
                    {info.label}
                  </span>
                  <span className="text-[10px] text-text-muted ml-2">{info.desc}</span>
                </div>
                {items.map((profile) => (
                  <ProfileRow key={profile.id} profile={profile} />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ProfileRow({ profile }: { profile: NodeProfile }) {
  const [showDetail, setShowDetail] = useState(false)
  const ruleCount = Object.keys(profile.rules || {}).length
  const checkpointCount = (profile.md_checkpoints || []).length
  const blocklistCount = (profile.md_blocklist || []).length

  return (
    <div>
      <div
        className="px-6 py-2 flex items-center justify-between hover:bg-surface-raised/30 cursor-pointer transition-colors"
        onClick={() => setShowDetail(!showDetail)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-mono text-text-dim truncate">{profile.id}</span>
          <span className="text-[10px] text-text-muted px-1.5 py-0.5 rounded bg-surface-raised">
            {profile.node_type}
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-text-muted shrink-0">
          {ruleCount > 0 && <span>{ruleCount} rules</span>}
          {checkpointCount > 0 && <span>{checkpointCount} checkpoints</span>}
          {blocklistCount > 0 && <span className="text-red">{blocklistCount} blocked</span>}
        </div>
      </div>

      {showDetail && (
        <div className="px-8 py-3 bg-bg border-t border-border/30 space-y-2">
          {ruleCount > 0 && (
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Rules</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {Object.entries(profile.rules || {}).map(([key, val]) => {
                  const severity = typeof val === 'object' && val !== null && 'severity' in val
                    ? (val as { severity: string }).severity
                    : typeof val === 'string' ? val : 'info'
                  const variant = severity === 'critical' ? 'red' : severity === 'warning' ? 'accent' : 'muted'
                  return (
                    <Badge key={key} variant={variant}>{key}</Badge>
                  )
                })}
              </div>
            </div>
          )}
          {checkpointCount > 0 && (
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Checkpoints</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {(profile.md_checkpoints || []).map((cp) => (
                  <Badge key={cp} variant="green">{cp}</Badge>
                ))}
              </div>
            </div>
          )}
          {blocklistCount > 0 && (
            <div>
              <span className="text-[10px] text-text-muted uppercase tracking-wider font-semibold">Blocklist</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {(profile.md_blocklist || []).map((bl) => (
                  <Badge key={bl} variant="red">{bl}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── CLAUDE.md Drift Matrix ──────────────────────────────────────────────────

function DriftMatrix({
  agents,
  calibrations,
}: {
  agents: Agent[]
  calibrations: Map<string, CalibrationData>
}) {
  const [expanded, setExpanded] = useState(false)

  // Collect all unique checkpoints across all calibrations
  const allCheckpoints = useMemo(() => {
    const set = new Set<string>()
    for (const [, cal] of calibrations) {
      for (const cp of cal.md_checkpoints || []) {
        set.add(cp)
      }
    }
    return Array.from(set).sort()
  }, [calibrations])

  if (allCheckpoints.length === 0 || agents.length === 0) {
    return (
      <div className="bg-surface rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-text-dim">CLAUDE.md Checkpoint Matrix</h3>
        <p className="text-xs text-text-muted mt-2 italic">
          No checkpoint data available. Agents need md_checkpoints in profiles and md_report in heartbeats.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-surface rounded-lg border border-border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-raised/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-text-dim">CLAUDE.md Checkpoint Matrix</h3>
          <span className="text-xs text-text-muted">
            ({agents.length} agents x {allCheckpoints.length} checkpoints)
          </span>
        </div>
        <span className={`text-text-muted text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}>
          ▶
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2 text-text-muted font-semibold sticky left-0 bg-surface z-10">
                  Agent
                </th>
                {allCheckpoints.map((cp) => (
                  <th key={cp} className="px-3 py-2 text-center text-text-muted font-mono whitespace-nowrap">
                    {cp}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => {
                const cal = calibrations.get(agent.id)
                // Get present checkpoints from drift items (if a checkpoint is missing, it's in drift)
                const missingCheckpoints = new Set<string>()
                if (cal && Array.isArray(cal.drift)) {
                  for (const d of cal.drift) {
                    if (d.rule === 'md_checkpoint_missing') {
                      const anchor = d.detail.replace('Expected anchor not found in CLAUDE.md: ', '')
                      missingCheckpoints.add(anchor)
                    }
                  }
                }

                return (
                  <tr key={agent.id} className="border-b border-border/30 hover:bg-surface-raised/30">
                    <td className="px-4 py-2 text-text-dim font-medium sticky left-0 bg-surface whitespace-nowrap">
                      {getSenderDisplay(agent.id)}
                    </td>
                    {allCheckpoints.map((cp) => {
                      if (!cal) {
                        return (
                          <td key={cp} className="px-3 py-2 text-center text-text-muted">
                            --
                          </td>
                        )
                      }
                      // If this checkpoint is in the agent's required list
                      const isRequired = (cal.md_checkpoints || []).includes(cp)
                      if (!isRequired) {
                        return (
                          <td key={cp} className="px-3 py-2 text-center text-text-muted">
                            --
                          </td>
                        )
                      }
                      const isMissing = missingCheckpoints.has(cp)
                      return (
                        <td
                          key={cp}
                          className={`px-3 py-2 text-center ${
                            isMissing
                              ? 'bg-red/10 text-red font-bold'
                              : 'bg-green/10 text-green font-bold'
                          }`}
                        >
                          {isMissing ? '\u2717' : '\u2713'}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Error Boundary ──────────────────────────────────────────────────────────

class HealthErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-8 bg-surface rounded-lg border border-red/30 space-y-4">
          <h2 className="text-lg font-semibold text-red">Health Page Crash</h2>
          <pre className="text-xs text-text-muted bg-bg p-4 rounded overflow-auto max-h-64 whitespace-pre-wrap">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="text-xs px-3 py-1.5 rounded bg-surface-raised text-text-muted hover:text-accent"
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function NetworkHealthPageInner() {
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

  // ─── Calibration state ─────────────────────────────────────────────────────
  const [profiles, setProfiles] = useState<NodeProfile[]>([])
  const [calibrations, setCalibrations] = useState<Map<string, CalibrationData>>(new Map())
  const [calibrationLoading, setCalibrationLoading] = useState(false)

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

  // Fallback poll every 15 seconds (SSE handles live events, this closes the stale-data gap)
  useEffect(() => {
    const interval = setInterval(() => refresh(), 15_000)
    return () => clearInterval(interval)
  }, [refresh])

  // Filter agents: detect drones by name pattern or agent_type, move them to drones list
  const isDrone = (a: Agent) =>
    a.agent_type === 'drone' || /drone/i.test(a.id) || /drone/i.test(a.name || '')

  const nonDroneAgents = useMemo(
    () => agents.filter((a) => !isDrone(a)),
    [agents],
  )

  // Merge server drones + any misclassified drones from the agents list
  const allDrones = useMemo(() => {
    const droneFromAgents = agents.filter(isDrone)
    const droneIds = new Set(drones.map((d) => d.id))
    const merged = [...drones]
    for (const d of droneFromAgents) {
      if (!droneIds.has(d.id)) merged.push(d)
    }
    return merged
  }, [agents, drones])

  // ─── Fetch profiles + calibration data ───────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function loadCalibrationData() {
      setCalibrationLoading(true)
      try {
        // Fetch profiles
        const profileData = await fetchProfiles().catch(() => [] as NodeProfile[])
        if (!cancelled) setProfiles(profileData)

        // Fetch calibration for each non-drone agent
        const calMap = new Map<string, CalibrationData>()
        const agentIds = nonDroneAgents.map((a) => a.id)
        const results = await Promise.allSettled(
          agentIds.map((id) => fetchCalibration(id).then((cal) => ({ id, cal }))),
        )
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value.cal) {
            calMap.set(result.value.id, result.value.cal)
          }
        }
        if (!cancelled) setCalibrations(calMap)
      } catch {
        // Silently fail — calibration is supplementary data
      } finally {
        if (!cancelled) setCalibrationLoading(false)
      }
    }

    if (nonDroneAgents.length > 0) {
      loadCalibrationData()
    }

    return () => { cancelled = true }
  }, [nonDroneAgents])

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
          {loading ? <Spinner size="sm" className="inline-block" /> : 'Refresh'}
        </button>
      </div>

      {/* 1. Network Status Bar */}
      <NetworkStatusBar
        agents={nonDroneAgents}
        drones={allDrones}
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
          <AgentActivityTimeline agents={[...nonDroneAgents, ...allDrones]} />
        </div>
      </div>

      {/* 3. Calibration Summary */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Calibration Status
          {calibrationLoading && <Spinner size="sm" className="inline-block" />}
        </h2>
        <CalibrationSummary calibrations={calibrations} totalAgents={nonDroneAgents.length} />
      </section>

      {/* 5. Agent Calibration Table */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Agent Calibration
          <span className="text-text-muted font-normal">
            (click row to expand drift details)
          </span>
        </h2>
        <CalibrationTable agents={nonDroneAgents} calibrations={calibrations} />
      </section>

      {/* 6. Profile Chain */}
      <section>
        <ProfileList profiles={profiles} />
      </section>

      {/* 7. CLAUDE.md Checkpoint Matrix */}
      <section>
        <DriftMatrix agents={nonDroneAgents} calibrations={calibrations} />
      </section>

      {/* 8. Agents Grid */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Agents
          <span className="text-text-muted font-normal">
            ({nonDroneAgents.filter((a) => a.status === 'online').length}/{nonDroneAgents.length} online)
          </span>
        </h2>
        <AgentsGrid agents={nonDroneAgents} />
      </section>

      {/* 9. Drones Grid */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Drones
          <span className="text-text-muted font-normal">
            ({allDrones.filter((d) => d.status === 'online').length}/{allDrones.length} online)
          </span>
        </h2>
        <DronesGrid drones={allDrones} droneJobs={droneJobs} />
      </section>

      {/* 10. Active Plans Progress */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3 flex items-center gap-2">
          Active Plans
          <span className="text-text-muted font-normal">
            ({plans.filter((p) => p.status === 'active' || p.status === 'in_progress').length})
          </span>
        </h2>
        <ActivePlansProgress plans={plans} />
      </section>

      {/* 11. Recent Activity Feed */}
      <section>
        <h2 className="text-sm font-semibold text-text-dim mb-3">Recent Activity</h2>
        <RecentActivityFeed events={events} />
      </section>
    </div>
  )
}

export default function NetworkHealthPage() {
  return (
    <HealthErrorBoundary>
      <NetworkHealthPageInner />
    </HealthErrorBoundary>
  )
}

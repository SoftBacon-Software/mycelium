import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { fetchEvents } from '../api/endpoints'
import Badge from '../components/shared/Badge'
import Spinner from '../components/shared/Spinner'
import { timeAgo } from '../utils/time'
import type { Agent, Event } from '../api/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

function getAgentInitials(name: string): string {
  const parts = name.split(/[-_ ]+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

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

function parseCaps(caps: string[] | unknown): string[] {
  if (Array.isArray(caps)) return caps
  try { return JSON.parse(caps as string) } catch { return [] }
}

function minutesSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60000
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface AgentSession {
  start: string
  end: string | null
  duration: number // minutes
  events: Event[]
}

interface AgentHealth {
  agent: Agent
  isStale: boolean
  minutesSinceHeartbeat: number
  recentEvents: Event[]
  sessions: AgentSession[]
  eventCounts: Record<string, number>
  totalSessions: number
  avgSessionMinutes: number
  uptimePercent: number
}

// ─── Event processing ───────────────────────────────────────────────────────

function computeSessions(events: Event[]): AgentSession[] {
  // Sort chronologically
  const sorted = [...events].sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )

  const sessions: AgentSession[] = []
  let current: AgentSession | null = null

  for (const e of sorted) {
    if (e.type === 'agent_boot' || e.type === 'agent_online') {
      if (current && !current.end) {
        // Close previous session
        current.end = e.created_at
        current.duration = (new Date(current.end).getTime() - new Date(current.start).getTime()) / 60000
      }
      current = { start: e.created_at, end: null, duration: 0, events: [e] }
      sessions.push(current)
    } else if (e.type === 'agent_offline') {
      if (current && !current.end) {
        current.end = e.created_at
        current.duration = (new Date(current.end).getTime() - new Date(current.start).getTime()) / 60000
        current.events.push(e)
      }
      current = null
    } else if (current) {
      current.events.push(e)
    }
  }

  // Close any open session with "now"
  if (current && !current.end) {
    current.duration = (Date.now() - new Date(current.start).getTime()) / 60000
  }

  return sessions
}

function buildActivityHeatmap(events: Event[]): number[] {
  // 24-hour heatmap (hourly buckets)
  const hours = new Array(24).fill(0)
  for (const e of events) {
    const h = new Date(e.created_at).getHours()
    hours[h]++
  }
  return hours
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function AgentHealthPage() {
  const { agents, drones, loading: storeLoading, refresh } = useDashboardStore()
  const [agentEvents, setAgentEvents] = useState<Record<string, Event[]>>({})
  const [eventsLoading, setEventsLoading] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [staleThreshold, setStaleThreshold] = useState(5) // minutes

  const allAgents = useMemo(() => [...agents, ...drones], [agents, drones])

  // Fetch events for all agents
  const loadEvents = useCallback(async () => {
    setEventsLoading(true)
    try {
      // Fetch last 3 days of agent events
      const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
      const events = await fetchEvents({ since, limit: 500 })

      // Group by agent
      const byAgent: Record<string, Event[]> = {}
      for (const e of events) {
        if (!e.agent) continue
        if (!byAgent[e.agent]) byAgent[e.agent] = []
        byAgent[e.agent].push(e)
      }
      setAgentEvents(byAgent)
    } catch (err) {
      console.error('Failed to load events:', err)
    }
    setEventsLoading(false)
  }, [])

  useEffect(() => {
    refresh()
    loadEvents()
  }, [refresh, loadEvents])

  // Compute health for each agent
  const healthData = useMemo<AgentHealth[]>(() => {
    return allAgents.map((agent) => {
      const events = agentEvents[agent.id] || []
      const minutesSinceHb = agent.last_heartbeat ? minutesSince(agent.last_heartbeat) : Infinity
      const sessions = computeSessions(events.filter(e =>
        ['agent_boot', 'agent_online', 'agent_offline', 'agent_heartbeat', 'agent_status'].includes(e.type)
      ))

      // Count events by type
      const eventCounts: Record<string, number> = {}
      for (const e of events) {
        eventCounts[e.type] = (eventCounts[e.type] || 0) + 1
      }

      // Avg session duration
      const completedSessions = sessions.filter(s => s.end)
      const avgSessionMinutes = completedSessions.length > 0
        ? completedSessions.reduce((sum, s) => sum + s.duration, 0) / completedSessions.length
        : 0

      // Uptime (last 24h)
      const onlineMinutes = sessions
        .filter(s => {
          const start = new Date(s.start).getTime()
          return start > Date.now() - 24 * 60 * 60 * 1000
        })
        .reduce((sum, s) => sum + Math.min(s.duration, 24 * 60), 0)
      const uptimePercent = Math.min(100, (onlineMinutes / (24 * 60)) * 100)

      return {
        agent,
        isStale: agent.status === 'online' && minutesSinceHb > staleThreshold,
        minutesSinceHeartbeat: minutesSinceHb,
        recentEvents: events.slice(0, 20),
        sessions,
        eventCounts,
        totalSessions: sessions.length,
        avgSessionMinutes,
        uptimePercent,
      }
    }).sort((a, b) => {
      // Online first, then by last heartbeat
      if (a.agent.status === 'online' && b.agent.status !== 'online') return -1
      if (a.agent.status !== 'online' && b.agent.status === 'online') return 1
      return a.minutesSinceHeartbeat - b.minutesSinceHeartbeat
    })
  }, [allAgents, agentEvents, staleThreshold])

  const staleCount = healthData.filter(h => h.isStale).length
  const onlineCount = healthData.filter(h => h.agent.status === 'online').length

  const selected = selectedAgent ? healthData.find(h => h.agent.id === selectedAgent) : null

  return (
    <div className="flex flex-col gap-4">
      {/* Summary bar */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-green" />
            <span className="text-sm text-text">{onlineCount} online</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-text-muted" />
            <span className="text-sm text-text-dim">{allAgents.length - onlineCount} offline</span>
          </div>
          {staleCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-red animate-pulse" />
              <span className="text-sm text-red">{staleCount} stale</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            Stale after
            <select
              value={staleThreshold}
              onChange={(e) => setStaleThreshold(Number(e.target.value))}
              className="bg-surface-raised border border-border rounded px-2 py-1 text-xs text-text"
            >
              <option value={2}>2 min</option>
              <option value={5}>5 min</option>
              <option value={10}>10 min</option>
              <option value={30}>30 min</option>
            </select>
          </label>
          <button
            onClick={() => { refresh(); loadEvents() }}
            disabled={storeLoading || eventsLoading}
            className="text-xs text-text-muted hover:text-accent transition-colors"
          >
            {storeLoading || eventsLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {storeLoading && !allAgents.length ? (
        <Spinner />
      ) : (
        <div className="flex gap-4 flex-col lg:flex-row">
          {/* Agent list */}
          <div className="flex flex-col gap-2 lg:w-96 shrink-0">
            {healthData.map((h) => (
              <AgentCard
                key={h.agent.id}
                health={h}
                isSelected={selectedAgent === h.agent.id}
                onClick={() => setSelectedAgent(
                  selectedAgent === h.agent.id ? null : h.agent.id
                )}
              />
            ))}
          </div>

          {/* Detail panel */}
          {selected && (
            <div className="flex-1 min-w-0">
              <AgentDetail health={selected} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Agent Card ─────────────────────────────────────────────────────────────

function AgentCard({ health, isSelected, onClick }: {
  health: AgentHealth
  isSelected: boolean
  onClick: () => void
}) {
  const { agent, isStale, uptimePercent } = health
  const caps = parseCaps(agent.capabilities)

  return (
    <button
      onClick={onClick}
      className={[
        'flex items-center gap-3 p-3 rounded-lg text-left transition-all duration-150 w-full',
        isSelected
          ? 'bg-accent/10 border border-accent/30'
          : 'bg-surface hover:bg-surface-raised border border-transparent',
      ].join(' ')}
    >
      {/* Avatar */}
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${getAgentColor(agent.id)}`}>
        {getAgentInitials(agent.name || agent.id)}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text truncate">{agent.name || agent.id}</span>
          {/* Status dot */}
          <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
            isStale ? 'bg-red animate-pulse' :
            agent.status === 'online' ? 'bg-green' :
            'bg-text-muted'
          }`} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {agent.working_on && (
            <span className="text-xs text-accent truncate max-w-[160px]">{agent.working_on}</span>
          )}
          {!agent.working_on && agent.status === 'online' && (
            <span className="text-xs text-text-muted">idle</span>
          )}
          {agent.status !== 'online' && (
            <span className="text-xs text-text-muted">
              {agent.last_heartbeat ? timeAgo(agent.last_heartbeat) : 'never'}
            </span>
          )}
        </div>
      </div>

      {/* Quick stats */}
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-[10px] text-text-muted font-mono">
          {uptimePercent.toFixed(0)}% 24h
        </span>
        <div className="flex items-center gap-1">
          {caps.slice(0, 3).map((c) => (
            <span key={c} className="text-[9px] px-1 py-0.5 rounded bg-surface-raised text-text-muted">{c}</span>
          ))}
        </div>
      </div>
    </button>
  )
}

// ─── Agent Detail ───────────────────────────────────────────────────────────

function AgentDetail({ health }: { health: AgentHealth }) {
  const { agent, minutesSinceHeartbeat, sessions, recentEvents, eventCounts, uptimePercent, avgSessionMinutes, totalSessions, isStale } = health

  const activityHeatmap = useMemo(() => buildActivityHeatmap(recentEvents), [recentEvents])
  const maxActivity = Math.max(...activityHeatmap, 1)

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3 p-4 bg-surface rounded-lg border border-border">
        <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-sm font-bold ${getAgentColor(agent.id)}`}>
          {getAgentInitials(agent.name || agent.id)}
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-text">{agent.name || agent.id}</h2>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <Badge variant={agent.status === 'online' ? 'green' : 'muted'}>
              {isStale ? 'STALE' : agent.status}
            </Badge>
            {agent.llm_model && (
              <span className="text-xs text-text-dim">{agent.llm_model}</span>
            )}
            {agent.agent_type && (
              <span className="text-xs text-text-muted">{agent.agent_type}</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-text-muted">Last heartbeat</div>
          <div className={`text-sm font-mono ${isStale ? 'text-red' : 'text-text-dim'}`}>
            {minutesSinceHeartbeat === Infinity ? 'never' : minutesSinceHeartbeat < 1 ? '<1m ago' : Math.round(minutesSinceHeartbeat) + 'm ago'}
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Uptime (24h)" value={`${uptimePercent.toFixed(1)}%`} />
        <StatCard label="Sessions (3d)" value={String(totalSessions)} />
        <StatCard label="Avg Session" value={avgSessionMinutes > 0 ? `${Math.round(avgSessionMinutes)}m` : '-'} />
        <StatCard label="Events (3d)" value={String(recentEvents.length)} />
      </div>

      {/* Activity heatmap */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Activity by Hour (3d)</h3>
        <div className="flex items-end gap-[3px] h-16">
          {activityHeatmap.map((count, hour) => (
            <div key={hour} className="flex-1 flex flex-col items-center gap-1">
              <div
                className="w-full rounded-sm transition-all"
                style={{
                  height: `${Math.max(2, (count / maxActivity) * 56)}px`,
                  backgroundColor: count === 0
                    ? 'var(--color-surface-raised)'
                    : `rgba(122, 158, 126, ${0.3 + (count / maxActivity) * 0.7})`,
                }}
                title={`${hour}:00 — ${count} events`}
              />
              {hour % 6 === 0 && (
                <span className="text-[8px] text-text-muted">{hour}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Session history */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Recent Sessions
        </h3>
        {sessions.length === 0 ? (
          <p className="text-xs text-text-muted">No sessions recorded in last 3 days</p>
        ) : (
          <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
            {[...sessions].reverse().slice(0, 15).map((session, i) => (
              <div key={i} className="flex items-center gap-3 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${session.end ? 'bg-text-muted' : 'bg-green'}`} />
                <span className="text-text-dim font-mono w-36 shrink-0">
                  {new Date(session.start).toLocaleString('en-US', {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit', hour12: false,
                  })}
                </span>
                <span className="text-text-muted">
                  {session.end
                    ? `${Math.round(session.duration)}m`
                    : 'active'
                  }
                </span>
                <span className="text-text-muted/50">
                  {session.events.length} events
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Event breakdown */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Event Breakdown (3d)
        </h3>
        <div className="flex flex-wrap gap-2">
          {Object.entries(eventCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => (
              <span key={type} className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-surface-raised text-xs">
                <span className="text-text-dim">{type.replace(/_/g, ' ')}</span>
                <span className="text-text-muted font-mono">{count}</span>
              </span>
            ))}
        </div>
      </div>

      {/* Recent event timeline */}
      <div className="p-4 bg-surface rounded-lg border border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
          Recent Events
        </h3>
        <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {recentEvents.slice(0, 30).map((e) => (
            <div key={e.id} className="flex items-center gap-2 text-xs">
              <span className="text-text-muted font-mono w-14 shrink-0 text-right">
                {timeAgo(e.created_at)}
              </span>
              <span className="w-1 h-1 rounded-full bg-text-muted/40 shrink-0" />
              <span className="text-text-dim">{e.type.replace(/_/g, ' ')}</span>
              {e.summary && (
                <span className="text-text-muted truncate">{e.summary}</span>
              )}
            </div>
          ))}
          {recentEvents.length === 0 && (
            <p className="text-xs text-text-muted">No events in last 3 days</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Stat Card ──────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-surface rounded-lg border border-border">
      <div className="text-[10px] text-text-muted uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold text-text mt-1">{value}</div>
    </div>
  )
}

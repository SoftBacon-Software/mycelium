import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useDashboardStore } from '../stores/dashboardStore'
import SummaryCard from '../components/dashboard/SummaryCard'
import Badge from '../components/shared/Badge'
import StatusDot from '../components/shared/StatusDot'

// -- Event type color mapping --
const eventBadgeVariant: Record<string, 'accent' | 'blue' | 'green' | 'muted' | 'purple' | 'red'> = {
  task_created: 'accent',
  task_updated: 'blue',
  task_completed: 'green',
  message_sent: 'green',
  message_received: 'green',
  heartbeat: 'muted',
  agent_online: 'purple',
  agent_offline: 'purple',
  agent_status: 'purple',
  bug_filed: 'red',
  bug_updated: 'red',
  bug_resolved: 'green',
  plan_created: 'purple',
  plan_updated: 'purple',
  plan_completed: 'green',
  asset_requested: 'accent',
  asset_completed: 'green',
  approval_created: 'accent',
  approval_resolved: 'green',
}

// -- Agent avatar color mapping --
const agentAvatarColors: Record<string, string> = {
  hijack: 'bg-purple/20 text-purple',
  greatness: 'bg-green/20 text-green',
}

function getAgentInitials(name: string): string {
  const parts = name.split(/[-_ ]+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatTimeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function getEventBadgeVariant(type: string): 'accent' | 'blue' | 'green' | 'muted' | 'purple' | 'red' {
  if (eventBadgeVariant[type]) return eventBadgeVariant[type]
  // Fallback: match prefix
  if (type.startsWith('task')) return 'accent'
  if (type.startsWith('message')) return 'green'
  if (type.startsWith('agent')) return 'purple'
  if (type.startsWith('bug')) return 'red'
  if (type.startsWith('plan')) return 'purple'
  if (type.startsWith('asset')) return 'accent'
  return 'muted'
}

// -- Quick link data --
const quickLinks = [
  { to: '/tasks', label: 'Tasks', desc: 'Kanban board', color: 'text-accent' },
  { to: '/messages', label: 'Messages', desc: 'Agent comms', color: 'text-blue' },
  { to: '/plans', label: 'Plans', desc: 'Execution plans', color: 'text-purple' },
  { to: '/bugs', label: 'Bugs', desc: 'Bug tracker', color: 'text-red' },
  { to: '/assets', label: 'Assets', desc: 'Art pipeline', color: 'text-accent' },
  { to: '/approvals', label: 'Approvals', desc: 'Review queue', color: 'text-green' },
]

export default function DashboardPage() {
  const {
    agents,
    events,
    tasks,
    messages,
    bugs,
    bugCounts,
    plans,
    assets,
    loading,
    refresh,
  } = useDashboardStore()

  useEffect(() => {
    refresh()
  }, [refresh])

  const onlineAgents = agents.filter((a) => a.status === 'online').length
  const totalTasks = tasks.open.length + tasks.in_progress.length
  const activePlans = plans.filter((p) => p.status === 'active' || p.status === 'in_progress').length
  const recentEvents = events.slice(0, 20)

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
          <p className="text-sm text-text-muted mt-0.5">Mycelium Dioverse overview</p>
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

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryCard
          title="Agents"
          value={`${onlineAgents}/${agents.length}`}
          subtitle={`${onlineAgents} online`}
          color="green"
          icon="agents"
        />
        <SummaryCard
          title="Tasks"
          value={totalTasks}
          subtitle={`${tasks.open.length} open, ${tasks.in_progress.length} active`}
          color="accent"
          icon="tasks"
        />
        <SummaryCard
          title="Messages"
          value={messages.length}
          subtitle="total messages"
          color="blue"
          icon="messages"
        />
        <SummaryCard
          title="Bugs"
          value={bugCounts.open}
          subtitle={`${bugs.length} total`}
          color="red"
          icon="bugs"
        />
        <SummaryCard
          title="Plans"
          value={activePlans}
          subtitle={`${plans.length} total`}
          color="purple"
          icon="plans"
        />
        <SummaryCard
          title="Assets"
          value={assets.length}
          subtitle="total assets"
          color="accent"
          icon="assets"
        />
      </div>

      {/* Middle row: Activity + Agents */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Recent Activity */}
        <div className="lg:col-span-3 bg-surface rounded-lg p-4">
          <h2 className="text-sm font-semibold text-text-dim mb-3">Recent Activity</h2>
          <div className="space-y-1 max-h-[480px] overflow-y-auto pr-1">
            {recentEvents.length === 0 && !loading && (
              <p className="text-sm text-text-muted py-4 text-center">No recent events</p>
            )}
            {loading && recentEvents.length === 0 && (
              <p className="text-sm text-text-muted py-4 text-center animate-pulse">Loading events...</p>
            )}
            {recentEvents.map((event) => (
              <div
                key={event.id}
                className="flex items-start gap-3 py-2 px-2 rounded hover:bg-surface-raised/50 transition-colors group"
              >
                <span className="text-xs text-text-muted font-mono w-14 shrink-0 pt-0.5 tabular-nums">
                  {formatTimestamp(event.created_at)}
                </span>
                <Badge variant={getEventBadgeVariant(event.type)} className="shrink-0 mt-0.5">
                  {event.type.replace(/_/g, ' ')}
                </Badge>
                <span className="text-sm text-text-dim leading-snug flex-1 min-w-0 truncate group-hover:text-text transition-colors">
                  {event.description}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Agents panel */}
        <div className="lg:col-span-2 bg-surface rounded-lg p-4">
          <h2 className="text-sm font-semibold text-text-dim mb-3">Agents</h2>
          <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
            {agents.length === 0 && !loading && (
              <p className="text-sm text-text-muted py-4 text-center">No agents found</p>
            )}
            {agents.map((agent) => {
              const agentKey = agent.id.replace(/-claude$/, '')
              const avatarColor = agentAvatarColors[agentKey] || 'bg-accent/20 text-accent'
              const caps: string[] = Array.isArray(agent.capabilities)
                ? agent.capabilities
                : (() => { try { return JSON.parse(agent.capabilities as unknown as string) } catch { return [] } })()

              return (
                <div key={agent.id} className="bg-surface-raised rounded p-3 transition-all hover:ring-1 ring-border">
                  <div className="flex items-center gap-3 mb-1.5">
                    <div className={`w-9 h-9 rounded-lg ${avatarColor} flex items-center justify-center text-xs font-bold shrink-0`}>
                      {getAgentInitials(agent.name || agent.id)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text truncate">
                          {agent.name || agent.id}
                        </span>
                        <StatusDot status={agent.status as 'online' | 'offline' | 'busy'} />
                      </div>
                      <p className="text-xs text-text-muted font-mono truncate">
                        {agent.id} / {agent.game}
                      </p>
                    </div>
                  </div>

                  {agent.working_on && (
                    <p className="text-sm text-text-dim italic truncate mb-1.5 pl-12">
                      {agent.working_on}
                    </p>
                  )}

                  <div className="flex items-center justify-between pl-12">
                    <div className="flex flex-wrap gap-1">
                      {caps.slice(0, 4).map((cap: string) => (
                        <Badge key={cap} variant="muted">{cap}</Badge>
                      ))}
                      {caps.length > 4 && (
                        <Badge variant="muted">+{caps.length - 4}</Badge>
                      )}
                    </div>
                    <span className="text-xs text-text-muted font-mono shrink-0 ml-2">
                      {formatTimeAgo(agent.last_heartbeat)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Quick links */}
      <div>
        <h2 className="text-sm font-semibold text-text-dim mb-3">Quick Links</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
          {quickLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="bg-surface-raised rounded p-3 hover:ring-1 ring-border transition-all group text-center"
            >
              <p className={`text-sm font-medium ${link.color} group-hover:brightness-110`}>
                {link.label}
              </p>
              <p className="text-xs text-text-muted mt-0.5">{link.desc}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useDashboardStore } from '../stores/dashboardStore'
import { formatTime as formatTimestamp, timeAgo as formatTimeAgo } from '../utils/time'
import SummaryCard from '../components/dashboard/SummaryCard'
import ActionRequired from '../components/dashboard/ActionRequired'
import Badge from '../components/shared/Badge'
import StatusDot from '../components/shared/StatusDot'

// -- Event type color mapping --
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
  asset_requested: 'accent',
  asset_completed: 'green',
  asset_delivered: 'green',
  asset_registered: 'accent',
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
  drone_job_created: 'blue',
  drone_job_claimed: 'blue',
  drone_job_done: 'green',
  drone_job_failed: 'red',
  artifact_uploaded: 'accent',
  assets_linked_to_job: 'blue',
  assets_status_updated: 'green',
  context_updated: 'muted',
  context_key_updated: 'muted',
  config_changed: 'muted',
  admin_frozen: 'red',
  admin_unfrozen: 'green',
  request_resolved: 'green',
  work_request: 'accent',
  operator_created: 'blue',
  operator_updated: 'blue',
  concept_created: 'purple',
  concept_updated: 'purple',
  project_created: 'blue',
  file_uploaded: 'accent',
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
  { to: '/drones', label: 'Drones', desc: 'GPU compute', color: 'text-blue' },
  { to: '/approvals', label: 'Approvals', desc: 'Review queue', color: 'text-green' },
  { to: '/concepts', label: 'Concepts', desc: 'Shared concepts', color: 'text-purple' },
  { to: '/context', label: 'Context', desc: 'Key-value store', color: 'text-text-dim' },
  { to: '/webhooks', label: 'Webhooks', desc: 'Delivery log', color: 'text-blue' },
  { to: '/ops', label: 'Admin Ops', desc: 'Action items', color: 'text-red' },
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
    droneJobs,
    concepts,
    contextKeys,
    loading,
    refresh,
  } = useDashboardStore()

  useEffect(() => {
    refresh()
  }, [refresh])

  const onlineAgents = agents.filter((a) => a.status === 'online').length
  const totalTasks = tasks.open.length + tasks.in_progress.length
  const activePlans = plans.filter((p) => p.status === 'active' || p.status === 'in_progress').length
  const activeDroneJobs = droneJobs.filter((j) => j.status === 'pending' || j.status === 'claimed').length
  const characterCount = concepts.filter((c) => c.type === 'character').length
  const contextNamespaces = new Set(contextKeys.map((k) => k.namespace)).size
  const recentEvents = events.slice(0, 20)

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
          <p className="text-sm text-text-muted mt-0.5">Mycelium overview</p>
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
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9 gap-3">
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
        <SummaryCard
          title="Drones"
          value={activeDroneJobs}
          subtitle={`${droneJobs.length} total jobs`}
          color="blue"
          icon="drones"
        />
        <SummaryCard
          title="Concepts"
          value={concepts.length}
          subtitle={`${characterCount} characters`}
          color="purple"
          icon="concepts"
        />
        <SummaryCard
          title="Context"
          value={contextKeys.length}
          subtitle={`${contextNamespaces} namespaces`}
          color="muted"
          icon="context"
        />
      </div>

      {/* Action Required */}
      <ActionRequired />

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
                        {agent.id} / {agent.project_id}
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
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
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

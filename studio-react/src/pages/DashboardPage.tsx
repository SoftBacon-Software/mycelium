import { useEffect, useMemo, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useDashboardStore } from '../stores/dashboardStore'
import { useLiveStore } from '../stores/liveStore'
import { formatTime as formatTimestamp, timeAgo as formatTimeAgo } from '../utils/time'
import { getSenderDisplay } from '../utils/sender'
import SummaryCard from '../components/dashboard/SummaryCard'
import ActionRequired from '../components/dashboard/ActionRequired'
import Badge from '../components/shared/Badge'
import StatusDot from '../components/shared/StatusDot'
import { useVoiceStore } from '../stores/voiceStore'
import { getSleepStatus, setSleepMode } from '../api/endpoints'

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

// -- Agent avatar color mapping --
const agentAvatarColors: Record<string, string> = {
  hijack: 'bg-purple/20 text-purple',
  greatness: 'bg-green/20 text-green',
  macbook: 'bg-blue/20 text-blue',
  admin: 'bg-accent/20 text-accent',
  unakron: 'bg-accent/20 text-accent',
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
  { to: '/health', label: 'Network Health', desc: 'Mission control', color: 'text-green' },
  { to: '/feedback', label: 'Feedback', desc: 'Agent ratings', color: 'text-accent' },
]

// -- Onboarding Checklist --

function OnboardingChecklist({
  checks,
}: {
  checks: { label: string; done: boolean; to: string }[]
}) {
  const completed = checks.filter((c) => c.done).length
  const total = checks.length
  const allDone = completed === total

  if (allDone) return null

  return (
    <div className="bg-surface rounded-lg border border-accent/20 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-accent">Getting Started</h2>
        <span className="text-xs text-text-muted tabular-nums">
          {completed}/{total} complete
        </span>
      </div>
      <div className="h-1.5 bg-surface-raised rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-accent rounded-full transition-all duration-500"
          style={{ width: `${(completed / total) * 100}%` }}
        />
      </div>
      <div className="space-y-1.5">
        {checks.map((check) => (
          <Link
            key={check.label}
            to={check.to}
            className={`flex items-center gap-2.5 py-1.5 px-2 rounded transition-colors ${
              check.done
                ? 'text-text-muted'
                : 'text-text hover:bg-surface-raised'
            }`}
          >
            <span
              className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                check.done
                  ? 'bg-green/20 border-green/40 text-green'
                  : 'border-border'
              }`}
            >
              {check.done && (
                <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2.5 6l2.5 2.5 4.5-5" />
                </svg>
              )}
            </span>
            <span className={`text-sm ${check.done ? 'line-through' : 'font-medium'}`}>
              {check.label}
            </span>
          </Link>
        ))}
      </div>
      <Link
        to="/onboarding"
        className="block mt-3 text-center text-xs text-accent hover:text-accent-light transition-colors"
      >
        Open setup wizard
      </Link>
    </div>
  )
}

// -- Sleep Mode types --
interface SleepStatus {
  sleep_mode: { active: boolean; directive?: string; priorities?: string[]; approval_policy?: string; started_at?: string; started_by?: string };
  autonomous: boolean;
  available_operators: number;
  log: { tasks_completed?: any[]; steps_completed?: any[]; approvals_queued?: any[]; dispatches?: any[]; errors?: any[] } | null;
}

function SleepModePanel({
  status,
  onActivate,
  onDeactivate,
}: {
  status: SleepStatus | null;
  onActivate: (directive: string, approvalPolicy: string) => void;
  onDeactivate: () => void;
}) {
  const [directive, setDirective] = useState('')
  const [approvalPolicy, setApprovalPolicy] = useState('queue_high')
  const [showForm, setShowForm] = useState(false)

  const isActive = status?.sleep_mode?.active ?? false
  const log = status?.log

  if (isActive) {
    return (
      <div className="bg-purple/10 border border-purple/30 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-lg">&#x1F319;</span>
            <span className="text-sm font-semibold text-purple">Sleep Mode Active</span>
            {status?.autonomous && <Badge variant="purple">Autonomous</Badge>}
          </div>
          <button
            onClick={onDeactivate}
            className="text-xs px-3 py-1.5 rounded bg-green/20 text-green hover:bg-green/30 transition-colors font-medium"
          >
            Wake Up
          </button>
        </div>
        {status?.sleep_mode?.directive && (
          <p className="text-xs text-text-dim mb-2">
            <span className="text-text-muted">Directive:</span> {status.sleep_mode.directive}
          </p>
        )}
        <div className="text-xs text-text-muted">
          Started by {status?.sleep_mode?.started_by ?? 'unknown'} at {status?.sleep_mode?.started_at ? formatTimestamp(status.sleep_mode.started_at) : '?'}
          {' | '}{status?.available_operators ?? 0} operator(s) available
        </div>

        {/* Overnight summary */}
        {log && (
          <div className="mt-3 pt-3 border-t border-purple/20 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-surface rounded p-2 text-center">
              <div className="text-text font-bold tabular-nums">{log.tasks_completed?.length ?? 0}</div>
              <div className="text-text-muted">Tasks done</div>
            </div>
            <div className="bg-surface rounded p-2 text-center">
              <div className="text-text font-bold tabular-nums">{log.steps_completed?.length ?? 0}</div>
              <div className="text-text-muted">Steps done</div>
            </div>
            <div className="bg-surface rounded p-2 text-center">
              <div className="text-text font-bold tabular-nums">{log.dispatches?.length ?? 0}</div>
              <div className="text-text-muted">Dispatches</div>
            </div>
            <div className="bg-surface rounded p-2 text-center">
              <div className="text-text font-bold tabular-nums">{log.approvals_queued?.length ?? 0}</div>
              <div className="text-text-muted">Queued approvals</div>
            </div>
          </div>
        )}
      </div>
    )
  }

  if (!showForm) {
    return (
      <button
        onClick={() => setShowForm(true)}
        className="flex items-center gap-2 text-xs text-text-muted hover:text-purple transition-colors px-3 py-1.5 rounded bg-surface-raised hover:ring-1 ring-purple/30"
        title="Enter sleep mode"
      >
        <span>&#x1F319;</span> Sleep Mode
      </button>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">&#x1F319;</span>
          <span className="text-sm font-semibold text-text">Sleep Mode Setup</span>
        </div>
        <button onClick={() => setShowForm(false)} className="text-xs text-text-muted hover:text-text">Cancel</button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-text-muted block mb-1">Night Directive</label>
          <textarea
            value={directive}
            onChange={e => setDirective(e.target.value)}
            placeholder="e.g. Focus on Plan #21 WS Steam Polish. No deploys. No external comms."
            rows={2}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-purple/40 resize-none"
          />
        </div>
        <div>
          <label className="text-xs text-text-muted block mb-1">Approval Policy</label>
          <div className="flex gap-2">
            {[
              { value: 'queue_high', label: 'Queue high-risk', desc: 'Recommended' },
              { value: 'block_all', label: 'Block all', desc: 'Conservative' },
              { value: 'auto_all', label: 'Auto-approve all', desc: 'Risky' },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => setApprovalPolicy(opt.value)}
                className={`flex-1 px-2 py-2 rounded text-xs text-center transition-colors border ${
                  approvalPolicy === opt.value
                    ? 'border-purple/50 bg-purple/10 text-purple'
                    : 'border-border bg-surface-raised text-text-muted hover:text-text'
                }`}
              >
                <div className="font-medium">{opt.label}</div>
                <div className="text-[10px] mt-0.5 opacity-70">{opt.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => { onActivate(directive, approvalPolicy); setShowForm(false); setDirective(''); }}
          className="w-full px-4 py-2 rounded bg-purple text-bg text-sm font-medium hover:bg-purple/80 transition-colors"
        >
          Go to Sleep
        </button>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const {
    agents,
    events,
    tasks,
    messages,
    pendingRequests,
    bugs,
    bugCounts,
    plans,
    assets,
    droneJobs,
    concepts,
    contextKeys,
    projects,
    loading,
    refresh,
  } = useDashboardStore()

  const navigate = useNavigate()
  const [sleepStatus, setSleepStatus] = useState<SleepStatus | null>(null)

  const loadSleepStatus = useCallback(async () => {
    try {
      const data = await getSleepStatus()
      setSleepStatus(data)
    } catch { /* not critical */ }
  }, [])

  useEffect(() => {
    refresh()
    loadSleepStatus()
  }, [refresh, loadSleepStatus])

  // First-boot detection: if no projects and no agents, redirect to onboarding
  useEffect(() => {
    if (loading) return
    if (projects.length === 0 && agents.length === 0) {
      navigate('/onboarding', { replace: true })
    }
  }, [loading, projects.length, agents.length, navigate])

  const onboardingChecks = useMemo(() => [
    { label: 'Create a project', done: projects.length > 0, to: '/onboarding' },
    { label: 'Register an agent', done: agents.length > 0, to: '/onboarding' },
    { label: 'Create your first plan', done: plans.length > 0, to: '/plans' },
    { label: 'Send a message', done: messages.length > 0, to: '/messages' },
  ], [projects.length, agents.length, plans.length, messages.length])

  const onlineAgents = agents.filter((a) => a.status === 'online').length
  const totalTasks = tasks.open.length + tasks.in_progress.length
  const activePlans = plans.filter((p) => p.status === 'active' || p.status === 'in_progress').length
  const activeDroneJobs = droneJobs.filter((j) => j.status === 'pending' || j.status === 'claimed').length
  const characterCount = concepts.filter((c) => c.type === 'character').length
  const contextNamespaces = new Set(contextKeys.map((k) => k.namespace)).size
  const liveEvents = useLiveStore((s) => s.events)
  const recentHeartbeats = useLiveStore((s) => s.recentHeartbeats)
  const recentEvents = useMemo(() => {
    // Merge live events (newest first) with polled events, dedup by id, cap at 30
    const seen = new Set<number>()
    const merged: typeof events = []
    for (const e of liveEvents) {
      if (!seen.has(e.id)) { seen.add(e.id); merged.push(e as typeof events[0]); }
    }
    for (const e of events) {
      if (!seen.has(e.id)) { seen.add(e.id); merged.push(e); }
    }
    return merged.slice(0, 30)
  }, [events, liveEvents])
  const { isConnected: voiceConnected, channelName, peers, join: joinVoice, leave: leaveVoice } = useVoiceStore()

  const handleSleepActivate = useCallback(async (directive: string, approvalPolicy: string) => {
    try {
      await setSleepMode({ action: 'on', directive, approval_policy: approvalPolicy as any })
      loadSleepStatus()
    } catch (err) {
      console.error('Failed to activate sleep mode:', err)
      toast.error('Failed to activate sleep mode')
    }
  }, [loadSleepStatus])

  const handleSleepDeactivate = useCallback(async () => {
    try {
      await setSleepMode({ action: 'off' })
      loadSleepStatus()
    } catch (err) {
      console.error('Failed to deactivate sleep mode:', err)
      toast.error('Failed to deactivate sleep mode')
    }
  }, [loadSleepStatus])

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Dashboard</h1>
          <p className="text-sm text-text-muted mt-0.5">Mycelium overview</p>
        </div>
        <div className="flex items-center gap-2">
          {!sleepStatus?.sleep_mode?.active && (
            <SleepModePanel status={sleepStatus} onActivate={handleSleepActivate} onDeactivate={handleSleepDeactivate} />
          )}
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors px-3 py-1.5 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Sleep Mode Banner (when active) */}
      {sleepStatus?.sleep_mode?.active && (
        <SleepModePanel status={sleepStatus} onActivate={handleSleepActivate} onDeactivate={handleSleepDeactivate} />
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-9 gap-3">
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
          value={pendingRequests.length}
          subtitle={pendingRequests.length === 1 ? '1 pending request' : pendingRequests.length > 0 ? `${pendingRequests.length} pending · ${messages.length} total` : `${messages.length} total`}
          color={pendingRequests.length > 0 ? 'accent' : 'blue'}
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

      {/* Voice Chat */}
      <div className="bg-surface rounded-lg p-3 flex items-center gap-3">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${voiceConnected ? 'bg-green animate-pulse' : 'bg-text-muted/30'}`} />
        <span className="text-sm font-medium text-text">Voice Chat</span>
        {voiceConnected ? (
          <>
            <span className="text-xs text-accent font-mono">#{channelName}</span>
            <span className="text-xs text-text-muted">{peers.length} peer{peers.length !== 1 ? 's' : ''}</span>
            <div className="flex-1" />
            <Link to="/channels" className="text-xs text-accent hover:underline">Open</Link>
            <button onClick={leaveVoice} className="text-xs px-2 py-0.5 rounded bg-red/20 text-red hover:bg-red/30 transition-colors">Leave</button>
          </>
        ) : (
          <>
            <span className="text-xs text-text-muted">Not connected</span>
            <div className="flex-1" />
            <button onClick={() => joinVoice()} className="text-xs px-2 py-0.5 rounded bg-green/20 text-green hover:bg-green/30 transition-colors">Join</button>
          </>
        )}
      </div>

      {/* Onboarding checklist (hidden when all done) */}
      <OnboardingChecklist checks={onboardingChecks} />

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
                    <span className="font-mono text-xs text-accent mr-1.5">{getSenderDisplay(event.agent)}</span>
                  )}
                  <span className="break-words">{event.summary}</span>
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

              const justHeartbeated = (Date.now() - (recentHeartbeats[agent.id] || 0)) < 10000

              return (
                <div key={agent.id} className={`bg-surface-raised rounded p-3 transition-all hover:ring-1 ring-border ${justHeartbeated ? 'ring-1 ring-green/40' : ''}`}>
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
                    <span className={`text-xs font-mono shrink-0 ml-2 ${justHeartbeated ? 'text-green' : 'text-text-muted'}`}>
                      {justHeartbeated ? 'just now' : formatTimeAgo(agent.last_heartbeat)}
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

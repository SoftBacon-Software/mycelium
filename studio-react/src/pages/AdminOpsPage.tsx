import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { fetchAdminOps, resolveRequest, cancelDroneJob, createDroneJob } from '../api/endpoints'
import { timeAgo } from '../utils/time'
import { getSenderDisplay } from '../utils/sender'
import type { AdminOps } from '../api/types'
import Badge from '../components/shared/Badge'

function truncate(str: string, len = 80): string {
  return str.length > len ? str.slice(0, len) + '...' : str
}

export default function AdminOpsPage() {
  const [ops, setOps] = useState<AdminOps | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setOps(await fetchAdminOps())
    } catch (err) {
      console.error('Failed to fetch admin ops:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleResolveRequest = useCallback(async (id: string) => {
    setActionLoading(`req-${id}`)
    try {
      await resolveRequest(id, 'resolved')
      await load()
    } catch (err) { console.error('Resolve failed:', err) }
    finally { setActionLoading(null) }
  }, [load])

  const handleRetryJob = useCallback(async (job: AdminOps['failed_drone_jobs'][0]) => {
    setActionLoading(`job-${job.id}`)
    try {
      await createDroneJob({
        title: job.title,
        command: job.command,
        requires: job.requires,
        priority: job.priority,
        input_data: job.input_data,
      })
      await load()
    } catch (err) { console.error('Retry failed:', err) }
    finally { setActionLoading(null) }
  }, [load])

  const handleCancelJob = useCallback(async (id: number) => {
    setActionLoading(`job-${id}`)
    try {
      await cancelDroneJob(id)
      await load()
    } catch (err) { console.error('Cancel failed:', err) }
    finally { setActionLoading(null) }
  }, [load])

  const totalCount = ops
    ? ops.pending_requests.length + ops.unassigned_tasks.length + ops.unassigned_bugs.length +
      ops.failed_drone_jobs.length + ops.pending_approvals.length + ops.stale_requests.length + ops.open_prs.length
    : 0

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-semibold text-text">Admin Ops</h1>
            <p className="text-sm text-text-muted mt-0.5">Actionable items requiring attention</p>
          </div>
          {totalCount > 0 && (
            <Badge variant="red">{totalCount}</Badge>
          )}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-text-muted hover:text-accent transition-colors px-3 py-1.5 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {loading && !ops && (
        <div className="text-center text-text-muted py-12 text-sm animate-pulse">Loading ops...</div>
      )}

      {ops && totalCount === 0 && (
        <div className="bg-surface rounded-lg p-8 text-center">
          <p className="text-green font-medium">All clear</p>
          <p className="text-sm text-text-muted mt-1">No actionable items right now.</p>
        </div>
      )}

      {ops && totalCount > 0 && (
        <div className="flex-1 overflow-y-auto space-y-4">
          {/* Pending Requests */}
          {ops.pending_requests.length > 0 && (
            <Section title="Pending Requests" count={ops.pending_requests.length} linkTo="/messages" variant="accent">
              {ops.pending_requests.map((msg) => (
                <div key={msg.id} className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 text-sm">
                  <span className="text-text-muted font-mono text-xs shrink-0">#{msg.id}</span>
                  <span className="text-accent font-mono text-xs shrink-0">{getSenderDisplay(msg.from_agent)}</span>
                  <span className="text-text-muted text-xs shrink-0">-&gt;</span>
                  <span className="text-accent font-mono text-xs shrink-0">{getSenderDisplay(msg.to_agent)}</span>
                  <span className="text-text-dim truncate flex-1 min-w-0">{truncate(msg.content)}</span>
                  <button
                    onClick={() => handleResolveRequest(msg.id)}
                    disabled={actionLoading === `req-${msg.id}`}
                    className="px-2 py-0.5 rounded text-xs font-medium bg-green/10 text-green hover:bg-green/20 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {actionLoading === `req-${msg.id}` ? '...' : 'Resolve'}
                  </button>
                  <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(msg.created_at)}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Unassigned Tasks */}
          {ops.unassigned_tasks.length > 0 && (
            <Section title="Unassigned Tasks" count={ops.unassigned_tasks.length} linkTo="/tasks" variant="accent">
              {ops.unassigned_tasks.map((task) => (
                <div key={task.id} className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 text-sm">
                  <span className="text-text-muted font-mono text-xs shrink-0">#{task.id}</span>
                  <Badge variant={task.priority === 'high' || task.priority === 'urgent' ? 'red' : 'muted'}>{task.priority}</Badge>
                  <span className="text-text-dim truncate flex-1 min-w-0">{task.title}</span>
                  <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(task.created_at)}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Unassigned Bugs */}
          {ops.unassigned_bugs.length > 0 && (
            <Section title="Unassigned Bugs" count={ops.unassigned_bugs.length} linkTo="/bugs" variant="red">
              {ops.unassigned_bugs.map((bug) => (
                <div key={bug.id} className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 text-sm">
                  <span className="text-text-muted font-mono text-xs shrink-0">#{bug.id}</span>
                  <Badge variant={bug.severity === 'high' || bug.severity === 'critical' ? 'red' : 'muted'}>{bug.severity}</Badge>
                  <span className="text-text-dim truncate flex-1 min-w-0">{bug.title}</span>
                  <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(bug.created_at)}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Failed Drone Jobs */}
          {ops.failed_drone_jobs.length > 0 && (
            <Section title="Failed Drone Jobs" count={ops.failed_drone_jobs.length} linkTo="/drones" variant="red">
              {ops.failed_drone_jobs.map((job) => (
                <div key={job.id} className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 text-sm">
                  <span className="text-text-muted font-mono text-xs shrink-0">#{job.id}</span>
                  <span className="text-text-dim truncate flex-1 min-w-0">
                    {job.title || job.command}
                    {job.error && <span className="text-red/70 ml-1">— {truncate(job.error, 40)}</span>}
                  </span>
                  <button
                    onClick={() => handleRetryJob(job)}
                    disabled={actionLoading === `job-${job.id}`}
                    className="px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {actionLoading === `job-${job.id}` ? '...' : 'Retry'}
                  </button>
                  <button
                    onClick={() => handleCancelJob(job.id)}
                    disabled={actionLoading === `job-${job.id}`}
                    className="px-2 py-0.5 rounded text-xs font-medium bg-red/10 text-red hover:bg-red/20 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {actionLoading === `job-${job.id}` ? '...' : 'Cancel'}
                  </button>
                  <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(job.created_at)}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Pending Approvals */}
          {ops.pending_approvals.length > 0 && (
            <Section title="Pending Approvals" count={ops.pending_approvals.length} linkTo="/approvals" variant="accent">
              {ops.pending_approvals.map((approval) => (
                <div key={approval.id} className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 text-sm">
                  <span className="text-text-muted font-mono text-xs shrink-0">#{approval.id}</span>
                  <Badge variant="accent">{approval.risk_tier}</Badge>
                  <span className="text-text-dim truncate flex-1 min-w-0">
                    {approval.title || approval.action_type} by {getSenderDisplay(approval.requested_by)}
                  </span>
                  <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(approval.created_at)}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Stale Requests */}
          {ops.stale_requests.length > 0 && (
            <Section title="Stale Requests" count={ops.stale_requests.length} linkTo="/messages" variant="muted">
              {ops.stale_requests.map((msg) => (
                <div key={msg.id} className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 text-sm">
                  <span className="text-text-muted font-mono text-xs shrink-0">#{msg.id}</span>
                  <span className="text-accent font-mono text-xs shrink-0">{getSenderDisplay(msg.from_agent)}</span>
                  <span className="text-text-muted text-xs shrink-0">-&gt;</span>
                  <span className="text-accent font-mono text-xs shrink-0">{getSenderDisplay(msg.to_agent)}</span>
                  <span className="text-text-dim truncate flex-1 min-w-0">{truncate(msg.content)}</span>
                  <button
                    onClick={() => handleResolveRequest(msg.id)}
                    disabled={actionLoading === `req-${msg.id}`}
                    className="px-2 py-0.5 rounded text-xs font-medium bg-text-muted/10 text-text-muted hover:bg-text-muted/20 transition-colors disabled:opacity-50 shrink-0"
                  >
                    {actionLoading === `req-${msg.id}` ? '...' : 'Resolve'}
                  </button>
                  <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(msg.created_at)}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Open PRs */}
          {ops.open_prs.length > 0 && (
            <Section title="Open PRs" count={ops.open_prs.length} variant="blue">
              {ops.open_prs.map((pr) => (
                <div key={pr.number} className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 text-sm">
                  <span className="text-text-muted font-mono text-xs shrink-0">#{pr.number}</span>
                  <span className="text-text-dim truncate flex-1 min-w-0">{pr.title}</span>
                  <span className="text-accent font-mono text-xs shrink-0">{pr.author}</span>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 py-0.5 rounded text-xs font-medium bg-blue/10 text-blue hover:bg-blue/20 transition-colors shrink-0"
                  >
                    View
                  </a>
                  <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(pr.created_at)}</span>
                </div>
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, count, linkTo, variant, children }: {
  title: string
  count: number
  linkTo?: string
  variant: 'accent' | 'red' | 'blue' | 'muted'
  children: React.ReactNode
}) {
  return (
    <div className="bg-surface rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-dim">{title}</span>
          <Badge variant={variant}>{count}</Badge>
        </div>
        {linkTo && (
          <Link to={linkTo} className="text-xs text-text-muted hover:text-accent transition-colors">
            View all &rarr;
          </Link>
        )}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

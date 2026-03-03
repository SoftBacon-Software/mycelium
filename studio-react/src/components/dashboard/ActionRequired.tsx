import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useDashboardStore } from '../../stores/dashboardStore'
import { createDroneJob } from '../../api/endpoints'
import Badge from '../shared/Badge'
import { timeAgo } from '../../utils/time'
import type { Message, DroneJob, Bug, Approval } from '../../api/types'

function truncate(str: string, len = 60): string {
  return str.length > len ? str.slice(0, len) + '…' : str
}

const MAX_ITEMS = 3

function RequestRow({ msg }: { msg: Message }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm">
      <span className="text-text-muted font-mono text-xs shrink-0">#{msg.id}</span>
      <span className="text-text-dim truncate">
        <span className="text-accent font-mono text-xs">{msg.from_agent}</span>
        <span className="text-text-muted mx-1">→</span>
        <span className="text-accent font-mono text-xs">{msg.to_agent}</span>
      </span>
      <span className="text-text-dim truncate flex-1 min-w-0">{truncate(msg.content)}</span>
      <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(msg.created_at)}</span>
    </div>
  )
}

function FailedJobRow({ job, onRetry, retrying }: { job: DroneJob; onRetry: () => void; retrying: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm">
      <span className="text-text-muted font-mono text-xs shrink-0">#{job.id}</span>
      <span className="text-text-dim truncate flex-1 min-w-0">
        {job.title || job.command}
        {job.error && <span className="text-red/70 ml-1">— {truncate(job.error, 40)}</span>}
      </span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="text-xs px-2 py-0.5 rounded bg-red/10 text-red hover:bg-red/20 transition-colors disabled:opacity-50 shrink-0"
      >
        {retrying ? '...' : 'Retry'}
      </button>
      <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(job.created_at)}</span>
    </div>
  )
}

function BugRow({ bug }: { bug: Bug }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm">
      <span className="text-text-muted font-mono text-xs shrink-0">#{bug.id}</span>
      <Badge variant={bug.severity === 'high' || bug.severity === 'critical' ? 'red' : 'muted'}>
        {bug.severity}
      </Badge>
      <span className="text-text-dim truncate flex-1 min-w-0">{truncate(bug.title)}</span>
      <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(bug.created_at)}</span>
    </div>
  )
}

function ApprovalRow({ approval }: { approval: Approval }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm">
      <span className="text-text-muted font-mono text-xs shrink-0">#{approval.id}</span>
      <Badge variant="accent">{approval.risk_tier}</Badge>
      <span className="text-text-dim truncate flex-1 min-w-0">
        {approval.entity_type} by {approval.created_by}
      </span>
      <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(approval.created_at)}</span>
    </div>
  )
}

interface CategoryProps {
  title: string
  count: number
  linkTo: string
  children: React.ReactNode
}

function Category({ title, count, linkTo, children }: CategoryProps) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-dim">{title}</span>
          <Badge variant="red">{count}</Badge>
        </div>
        <Link to={linkTo} className="text-xs text-text-muted hover:text-accent transition-colors">
          View all →
        </Link>
      </div>
      {children}
    </div>
  )
}

export default function ActionRequired() {
  const { pendingRequests, droneJobs, bugs, pendingApprovals, refresh } = useDashboardStore()
  const [retryingId, setRetryingId] = useState<number | null>(null)

  const failedJobs = droneJobs.filter((j) => j.status === 'failed')
  const unassignedBugs = bugs.filter((b) => b.status === 'open' && !b.assignee)
  const pendingApprovalItems = pendingApprovals.filter((a) => a.status === 'pending')

  const totalCount = pendingRequests.length + failedJobs.length + unassignedBugs.length + pendingApprovalItems.length

  const handleRetry = useCallback(async (job: DroneJob) => {
    setRetryingId(job.id)
    try {
      await createDroneJob({
        title: job.title,
        command: job.command,
        requires: job.requires,
        priority: job.priority,
        input_data: job.input_data,
      })
      await refresh()
    } catch (err) {
      console.error('Retry failed:', err)
      toast.error('Retry failed — check drone logs')
    } finally {
      setRetryingId(null)
    }
  }, [refresh])

  if (totalCount === 0) return null

  return (
    <div className="bg-surface rounded-lg p-4 ring-1 ring-red/20">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-text">Action Required</h2>
        <Badge variant="red">{totalCount}</Badge>
      </div>

      <div className="space-y-4">
        {pendingRequests.length > 0 && (
          <Category title="Pending Requests" count={pendingRequests.length} linkTo="/messages">
            {pendingRequests.slice(0, MAX_ITEMS).map((msg) => (
              <RequestRow key={msg.id} msg={msg} />
            ))}
            {pendingRequests.length > MAX_ITEMS && (
              <p className="text-xs text-text-muted px-2 py-1">
                +{pendingRequests.length - MAX_ITEMS} more
              </p>
            )}
          </Category>
        )}

        {failedJobs.length > 0 && (
          <Category title="Failed Jobs" count={failedJobs.length} linkTo="/drones">
            {failedJobs.slice(0, MAX_ITEMS).map((job) => (
              <FailedJobRow
                key={job.id}
                job={job}
                onRetry={() => handleRetry(job)}
                retrying={retryingId === job.id}
              />
            ))}
            {failedJobs.length > MAX_ITEMS && (
              <p className="text-xs text-text-muted px-2 py-1">
                +{failedJobs.length - MAX_ITEMS} more
              </p>
            )}
          </Category>
        )}

        {unassignedBugs.length > 0 && (
          <Category title="Unassigned Bugs" count={unassignedBugs.length} linkTo="/bugs">
            {unassignedBugs.slice(0, MAX_ITEMS).map((bug) => (
              <BugRow key={bug.id} bug={bug} />
            ))}
            {unassignedBugs.length > MAX_ITEMS && (
              <p className="text-xs text-text-muted px-2 py-1">
                +{unassignedBugs.length - MAX_ITEMS} more
              </p>
            )}
          </Category>
        )}

        {pendingApprovalItems.length > 0 && (
          <Category title="Pending Approvals" count={pendingApprovalItems.length} linkTo="/approvals">
            {pendingApprovalItems.slice(0, MAX_ITEMS).map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} />
            ))}
            {pendingApprovalItems.length > MAX_ITEMS && (
              <p className="text-xs text-text-muted px-2 py-1">
                +{pendingApprovalItems.length - MAX_ITEMS} more
              </p>
            )}
          </Category>
        )}
      </div>
    </div>
  )
}

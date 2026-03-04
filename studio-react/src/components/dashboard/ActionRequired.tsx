import { useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useDashboardStore } from '../../stores/dashboardStore'
import { dismissDroneJob, resolveRequest, castVote } from '../../api/endpoints'
import { useAuthStore } from '../../stores/authStore'
import Badge from '../shared/Badge'
import { timeAgo } from '../../utils/time'
import type { Message, DroneJob, Bug, Approval } from '../../api/types'

function truncate(str: string, len = 60): string {
  return str.length > len ? str.slice(0, len) + '…' : str
}

const MAX_ITEMS = 3

function RequestRow({ msg, onResolve, resolving }: { msg: Message; onResolve: () => void; resolving: boolean }) {
  const navigate = useNavigate()
  return (
    <div
      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm cursor-pointer"
      onClick={() => navigate('/messages')}
    >
      <span className="text-text-muted font-mono text-xs shrink-0">#{msg.id}</span>
      <span className="text-text-dim truncate">
        <span className="text-accent font-mono text-xs">{msg.from_agent}</span>
        <span className="text-text-muted mx-1">→</span>
        <span className="text-accent font-mono text-xs">{msg.to_agent}</span>
      </span>
      <span className="text-text-dim truncate flex-1 min-w-0">{truncate(msg.content)}</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onResolve() }}
        disabled={resolving}
        className="text-xs px-2 py-0.5 rounded bg-green/10 text-green hover:bg-green/20 transition-colors disabled:opacity-50 shrink-0"
      >
        {resolving ? '...' : 'Resolve'}
      </button>
      <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(msg.created_at)}</span>
    </div>
  )
}

function FailedJobRow({ job, onDismiss, dismissing }: { job: DroneJob; onDismiss: () => void; dismissing: boolean }) {
  const navigate = useNavigate()
  return (
    <div
      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm cursor-pointer"
      onClick={() => navigate('/drones')}
    >
      <span className="text-text-muted font-mono text-xs shrink-0">#{job.id}</span>
      <span className="text-text-dim truncate flex-1 min-w-0">
        {job.title || job.command}
        {job.error && <span className="text-red/70 ml-1">— {truncate(job.error, 40)}</span>}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss() }}
        disabled={dismissing}
        className="text-xs px-2 py-0.5 rounded bg-text-muted/10 text-text-muted hover:bg-text-muted/20 transition-colors disabled:opacity-50 shrink-0"
      >
        {dismissing ? '...' : 'Dismiss'}
      </button>
      <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(job.created_at)}</span>
    </div>
  )
}

function BugRow({ bug }: { bug: Bug }) {
  const navigate = useNavigate()
  return (
    <div
      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm cursor-pointer"
      onClick={() => navigate('/bugs')}
    >
      <span className="text-text-muted font-mono text-xs shrink-0">#{bug.id}</span>
      <Badge variant={bug.severity === 'high' || bug.severity === 'critical' ? 'red' : 'muted'}>
        {bug.severity}
      </Badge>
      <span className="text-text-dim truncate flex-1 min-w-0">{truncate(bug.title)}</span>
      <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(bug.created_at)}</span>
    </div>
  )
}

function ApprovalRow({ approval, onVote, voting }: { approval: Approval; onVote: (decision: string) => void; voting: boolean }) {
  const navigate = useNavigate()
  return (
    <div
      className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50 text-sm cursor-pointer"
      onClick={() => navigate('/approvals')}
    >
      <span className="text-text-muted font-mono text-xs shrink-0">#{approval.id}</span>
      <Badge variant="accent">{approval.risk_tier}</Badge>
      <span className="text-text-dim truncate flex-1 min-w-0">
        {approval.entity_type} by {approval.created_by}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onVote('approve') }}
        disabled={voting}
        className="text-xs px-2 py-0.5 rounded bg-green/10 text-green hover:bg-green/20 transition-colors disabled:opacity-50 shrink-0"
      >
        {voting ? '...' : 'Approve'}
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onVote('deny') }}
        disabled={voting}
        className="text-xs px-2 py-0.5 rounded bg-red/10 text-red hover:bg-red/20 transition-colors disabled:opacity-50 shrink-0"
      >
        Deny
      </button>
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
  const user = useAuthStore((s) => s.user)
  const [dismissingId, setDismissingId] = useState<number | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [votingId, setVotingId] = useState<string | null>(null)

  const failedJobs = droneJobs.filter((j) => j.status === 'failed')
  const unassignedBugs = bugs.filter((b) => b.status === 'open' && !b.assignee)
  const pendingApprovalItems = pendingApprovals.filter((a) => a.status === 'pending')

  const totalCount = pendingRequests.length + failedJobs.length + unassignedBugs.length + pendingApprovalItems.length

  const handleDismiss = useCallback(async (job: DroneJob) => {
    setDismissingId(job.id)
    try {
      await dismissDroneJob(job.id)
      await refresh()
      toast.success('Job dismissed')
    } catch (err) {
      console.error('Dismiss failed:', err)
      toast.error('Failed to dismiss job')
    } finally {
      setDismissingId(null)
    }
  }, [refresh])

  const handleResolve = useCallback(async (id: string) => {
    setResolvingId(id)
    try {
      await resolveRequest(id, 'Resolved from dashboard')
      await refresh()
      toast.success('Request resolved')
    } catch (err) {
      console.error('Resolve failed:', err)
      toast.error('Failed to resolve request')
    } finally {
      setResolvingId(null)
    }
  }, [refresh])

  const handleVote = useCallback(async (approvalId: string, decision: string) => {
    setVotingId(approvalId)
    try {
      const voterId = user?.username || 'studio'
      await castVote(approvalId, decision, null, voterId, 'operator')
      await refresh()
      toast.success(decision === 'approve' ? 'Approved' : 'Denied')
    } catch (err) {
      console.error('Vote failed:', err)
      toast.error('Failed to cast vote')
    } finally {
      setVotingId(null)
    }
  }, [refresh, user])

  if (totalCount === 0) {
    return (
      <div className="bg-surface rounded-lg p-4 ring-1 ring-green/20">
        <div className="flex items-center gap-2">
          <span className="text-green text-base">✓</span>
          <h2 className="text-sm font-semibold text-text">All Clear</h2>
          <span className="text-text-muted text-xs">No pending actions</span>
        </div>
      </div>
    )
  }

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
              <RequestRow
                key={msg.id}
                msg={msg}
                onResolve={() => handleResolve(msg.id)}
                resolving={resolvingId === msg.id}
              />
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
                onDismiss={() => handleDismiss(job)}
                dismissing={dismissingId === job.id}
              />
            ))}
            {failedJobs.length > MAX_ITEMS && (
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-xs text-text-muted">+{failedJobs.length - MAX_ITEMS} more</span>
                <button
                  type="button"
                  onClick={async () => {
                    for (const job of failedJobs) await dismissDroneJob(job.id)
                    await refresh()
                    toast.success(`Dismissed ${failedJobs.length} failed jobs`)
                  }}
                  className="text-xs px-2 py-0.5 rounded bg-text-muted/10 text-text-muted hover:bg-text-muted/20 transition-colors"
                >
                  Dismiss all
                </button>
              </div>
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
              <ApprovalRow
                key={approval.id}
                approval={approval}
                onVote={(decision) => handleVote(approval.id, decision)}
                voting={votingId === approval.id}
              />
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

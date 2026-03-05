import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { useDashboardStore } from '../../stores/dashboardStore'
import { dismissDroneJob, resolveRequest, castVote } from '../../api/endpoints'
import { useAuthStore } from '../../stores/authStore'
import Badge from '../shared/Badge'
import { timeAgo } from '../../utils/time'
import type { Message, DroneJob, Bug, Approval } from '../../api/types'

function truncate(str: string, len = 80): string {
  return str.length > len ? str.slice(0, len) + '\u2026' : str
}

/* ── Category Section with unfurl ── */

function Section({
  title,
  count,
  linkTo,
  badge,
  defaultOpen = false,
  children,
}: {
  title: string
  count: number
  linkTo: string
  badge: 'red' | 'accent' | 'blue' | 'purple'
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const navigate = useNavigate()

  return (
    <div className={`rounded-lg border transition-colors ${open ? 'border-border/40 bg-surface/50' : 'border-border/20'}`}>
      {/* Section header — always clickable */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer active:bg-surface-raised/50 transition-colors"
      >
        {/* Chevron */}
        <svg
          viewBox="0 0 12 12"
          className={`w-3 h-3 text-text-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" strokeWidth="2"
        >
          <path d="M4 2l4 4-4 4" />
        </svg>

        <span className="text-sm font-medium text-text flex-1">{title}</span>
        <Badge variant={badge}>{count}</Badge>
        <span
          onClick={(e) => { e.stopPropagation(); navigate(linkTo) }}
          className="text-xs text-text-muted cursor-pointer active:text-accent transition-colors ml-1"
        >
          View all &rarr;
        </span>
      </button>

      {/* Unfurled content */}
      {open && (
        <div className="px-2 pb-2">
          {children}
        </div>
      )}
    </div>
  )
}

/* ── Individual row components ── */

function RequestCard({ msg, onResolve, resolving }: { msg: Message; onResolve: () => void; resolving: boolean }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg bg-surface-raised mx-2 mb-1.5 overflow-hidden">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer active:bg-surface transition-colors"
      >
        <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-mono text-accent">{msg.from_agent}</span>
            <span className="text-text-muted text-xs">&rarr;</span>
            <span className="text-xs font-mono text-accent">{msg.to_agent}</span>
            <span className="text-xs text-text-muted ml-auto shrink-0">{timeAgo(msg.created_at)}</span>
          </div>
          <p className="text-sm text-text-dim truncate">{truncate(msg.content)}</p>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-0 border-t border-border/20 mx-2">
          <p className="text-sm text-text-dim whitespace-pre-wrap py-3 leading-relaxed">{msg.content}</p>
          <div className="flex items-center gap-2">
            <button
              onClick={onResolve}
              disabled={resolving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green/15 text-green text-sm font-medium transition-colors active:bg-green/25 disabled:opacity-50"
            >
              {resolving ? 'Resolving\u2026' : 'Resolve'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ApprovalCard({ approval, onVote, voting }: { approval: Approval; onVote: (d: string) => void; voting: boolean }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg bg-surface-raised mx-2 mb-1.5 overflow-hidden">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer active:bg-surface transition-colors"
      >
        <div className="w-2 h-2 rounded-full bg-red shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <Badge variant="accent">{approval.risk_tier}</Badge>
            <span className="text-sm font-medium text-text truncate">
              {approval.title || approval.action_type}
            </span>
            <span className="text-xs text-text-muted ml-auto shrink-0">{timeAgo(approval.created_at)}</span>
          </div>
          <p className="text-xs text-text-muted">Requested by {approval.requested_by}</p>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-0 border-t border-border/20 mx-2">
          <div className="py-3">
            <div className="flex items-center gap-2 text-xs text-text-muted mb-2">
              <span>Action: {approval.action_type}</span>
              <span>&middot;</span>
              <span>Risk: {approval.risk_tier}</span>
              {approval.required_approvals && (
                <>
                  <span>&middot;</span>
                  <span>Needs {approval.required_approvals} approval(s)</span>
                </>
              )}
            </div>
            {approval.payload && (
              <div className="bg-surface rounded-lg p-3 mb-3 border border-border/20">
                <p className="text-xs text-text-dim font-mono whitespace-pre-wrap break-all">
                  {typeof approval.payload === 'string' ? approval.payload : JSON.stringify(approval.payload, null, 2)}
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onVote('approve')}
              disabled={voting}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-green/15 text-green text-sm font-semibold transition-colors active:bg-green/25 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => onVote('deny')}
              disabled={voting}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-red/15 text-red text-sm font-semibold transition-colors active:bg-red/25 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function FailedJobCard({ job, onDismiss, dismissing }: { job: DroneJob; onDismiss: () => void; dismissing: boolean }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-lg bg-surface-raised mx-2 mb-1.5 overflow-hidden">
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer active:bg-surface transition-colors"
      >
        <div className="w-2 h-2 rounded-full bg-red shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-text-muted">#{job.id}</span>
            <span className="text-sm text-text-dim truncate flex-1">{job.title || job.command}</span>
            <span className="text-xs text-text-muted shrink-0">{timeAgo(job.created_at)}</span>
          </div>
          {job.error && <p className="text-xs text-red/80 truncate mt-0.5">{truncate(job.error, 60)}</p>}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-0 border-t border-border/20 mx-2">
          {job.error && (
            <div className="bg-red/5 border border-red/20 rounded-lg p-3 my-3">
              <p className="text-xs text-red font-mono whitespace-pre-wrap break-all">{job.error}</p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={onDismiss}
              disabled={dismissing}
              className="px-4 py-2 rounded-lg bg-surface text-text-muted text-sm font-medium transition-colors active:bg-surface-raised disabled:opacity-50"
            >
              {dismissing ? 'Dismissing\u2026' : 'Dismiss'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function BugCard({ bug }: { bug: Bug }) {
  const navigate = useNavigate()

  return (
    <div
      onClick={() => navigate('/bugs')}
      className="rounded-lg bg-surface-raised mx-2 mb-1.5 flex items-center gap-3 px-4 py-3 cursor-pointer active:bg-surface transition-colors"
    >
      <div className="w-2 h-2 rounded-full bg-red/60 shrink-0" />
      <span className="text-xs font-mono text-text-muted">#{bug.id}</span>
      <Badge variant={bug.severity === 'high' || bug.severity === 'critical' ? 'red' : 'muted'}>
        {bug.severity}
      </Badge>
      <span className="text-sm text-text-dim truncate flex-1">{truncate(bug.title)}</span>
      <span className="text-xs text-text-muted shrink-0">{timeAgo(bug.created_at)}</span>
    </div>
  )
}

/* ── Main Component ── */

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
    } catch {
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
    } catch {
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
    } catch {
      toast.error('Failed to cast vote')
    } finally {
      setVotingId(null)
    }
  }, [refresh, user])

  if (totalCount === 0) {
    return (
      <div className="bg-surface rounded-lg p-4 ring-1 ring-green/20">
        <div className="flex items-center gap-2">
          <span className="text-green text-base">&check;</span>
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

      <div className="space-y-2">
        {pendingApprovalItems.length > 0 && (
          <Section title="Pending Approvals" count={pendingApprovalItems.length} linkTo="/approvals" badge="red" defaultOpen>
            {pendingApprovalItems.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onVote={(decision) => handleVote(approval.id, decision)}
                voting={votingId === approval.id}
              />
            ))}
          </Section>
        )}

        {pendingRequests.length > 0 && (
          <Section title="Pending Requests" count={pendingRequests.length} linkTo="/messages" badge="accent" defaultOpen>
            {pendingRequests.map((msg) => (
              <RequestCard
                key={msg.id}
                msg={msg}
                onResolve={() => handleResolve(msg.id)}
                resolving={resolvingId === msg.id}
              />
            ))}
          </Section>
        )}

        {failedJobs.length > 0 && (
          <Section title="Failed Jobs" count={failedJobs.length} linkTo="/drones" badge="red">
            {failedJobs.map((job) => (
              <FailedJobCard
                key={job.id}
                job={job}
                onDismiss={() => handleDismiss(job)}
                dismissing={dismissingId === job.id}
              />
            ))}
          </Section>
        )}

        {unassignedBugs.length > 0 && (
          <Section title="Unassigned Bugs" count={unassignedBugs.length} linkTo="/bugs" badge="red">
            {unassignedBugs.map((bug) => (
              <BugCard key={bug.id} bug={bug} />
            ))}
          </Section>
        )}
      </div>
    </div>
  )
}

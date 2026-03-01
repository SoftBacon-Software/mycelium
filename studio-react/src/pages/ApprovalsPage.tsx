import { useState, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useAuthStore } from '../stores/authStore'
import { castVote, resolveApproval, updateTask } from '../api/endpoints'
import type { Approval, Task } from '../api/types'
import RiskBadge from '../components/approvals/RiskBadge'
import QuorumBar from '../components/approvals/QuorumBar'
import VotingUI from '../components/approvals/VotingUI'

function safeVotes(raw: unknown): Array<{ id: string; voter_id: string; vote: string; reason?: string }> {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p } catch { /* ignore */ }
  }
  return []
}

type FilterTab = 'pending' | 'approved' | 'rejected' | 'all'

const TABS: { key: FilterTab; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
]

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function entityTypeBadge(type: string): string {
  const map: Record<string, string> = {
    task: 'bg-blue/10 text-blue',
    deploy: 'bg-purple/10 text-purple',
    config: 'bg-accent/10 text-accent',
    asset: 'bg-pink/10 text-pink',
  }
  return map[type.toLowerCase()] ?? 'bg-surface text-text-dim'
}

const priorityColors: Record<string, string> = {
  critical: 'bg-red/15 text-red',
  high: 'bg-red/10 text-red',
  medium: 'bg-accent/10 text-accent',
  low: 'bg-green/10 text-green',
}

export default function ApprovalsPage() {
  const pendingApprovals = useDashboardStore((s) => s.pendingApprovals)
  const approvalQueue = useDashboardStore((s) => s.approvalQueue)
  const refresh = useDashboardStore((s) => s.refresh)
  const user = useAuthStore((s) => s.user)

  const [filter, setFilter] = useState<FilterTab>('pending')
  const [taskApproving, setTaskApproving] = useState<string | null>(null)
  const [taskError, setTaskError] = useState<string | null>(null)

  // Build a combined list of all approvals across states.
  // The store only provides pendingApprovals directly; for resolved ones
  // we filter from the same array (API may return all statuses).
  const filteredApprovals = useMemo(() => {
    if (filter === 'all') return pendingApprovals
    return pendingApprovals.filter((a) => a.status === filter)
  }, [pendingApprovals, filter])

  const pendingCount = useMemo(
    () => pendingApprovals.filter((a) => a.status === 'pending').length,
    [pendingApprovals],
  )

  const tasksNeedingApproval = useMemo(
    () => approvalQueue.filter((t) => t.needs_approval && !t.approved_by),
    [approvalQueue],
  )

  const handleVote = useCallback(
    async (approval: Approval, vote: string, reason: string) => {
      if (!user) return
      await castVote(approval.id, vote, reason || null as any, user.username, 'operator')

      // Check if this vote meets quorum and auto-resolve
      const existingVotes = safeVotes(approval.votes)
      const currentVotes = existingVotes.length + 1
      if (currentVotes >= approval.quorum_required) {
        // Count approve/reject to determine decision
        const approveCount =
          existingVotes.filter((v) => v.vote === 'approve').length +
          (vote === 'approve' ? 1 : 0)
        const decision = approveCount > currentVotes / 2 ? 'approved' : 'rejected'
        await resolveApproval(approval.id, decision, user.username)
      }

      await refresh()
    },
    [user, refresh],
  )

  const handleTaskApprove = useCallback(
    async (task: Task) => {
      if (!user) return
      setTaskError(null)
      setTaskApproving(task.id)

      try {
        await updateTask(task.id, {
          approved_by: user.username,
          approved_at: new Date().toISOString(),
        })
        await refresh()
      } catch (err) {
        setTaskError(err instanceof Error ? err.message : 'Failed to approve task')
      } finally {
        setTaskApproving(null)
      }
    },
    [user, refresh],
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text">Approvals</h2>
          {pendingCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
              {pendingCount}
            </span>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 bg-surface rounded-sm p-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-colors ${
              filter === tab.key
                ? 'bg-surface-raised text-text'
                : 'text-text-muted hover:text-text-dim'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Approval cards */}
      <section>
        {filteredApprovals.length === 0 ? (
          <div className="bg-surface rounded-lg p-8 text-center">
            <p className="text-text-muted text-sm">
              {filter === 'pending'
                ? 'No pending approvals'
                : `No ${filter} approvals found`}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                onVote={(vote, reason) => handleVote(approval, vote, reason)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Task approval queue */}
      <section>
        <h3 className="text-lg font-semibold text-text mb-3 flex items-center gap-2">
          Tasks Needing Approval
          {tasksNeedingApproval.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-red/15 text-red text-xs font-bold tabular-nums">
              {tasksNeedingApproval.length}
            </span>
          )}
        </h3>

        {taskError && (
          <div className="mb-3 px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
            {taskError}
          </div>
        )}

        {tasksNeedingApproval.length === 0 ? (
          <div className="bg-surface rounded-lg p-6 text-center">
            <p className="text-text-muted text-sm">No tasks awaiting approval</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tasksNeedingApproval.map((task) => (
              <div
                key={task.id}
                className="bg-surface-raised rounded-lg p-4 flex items-center justify-between gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-text truncate">
                      {task.title}
                    </span>
                    <span
                      className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${
                        priorityColors[task.priority?.toLowerCase()] ?? 'bg-surface text-text-muted'
                      }`}
                    >
                      {task.priority}
                    </span>
                  </div>
                  {task.assignee && (
                    <p className="text-xs text-text-muted">
                      Assigned to <span className="text-text-dim">{task.assignee}</span>
                    </p>
                  )}
                </div>

                <button
                  onClick={() => handleTaskApprove(task)}
                  disabled={taskApproving === task.id}
                  className="shrink-0 px-4 py-1.5 rounded-sm bg-green/15 text-green text-sm font-medium hover:bg-green/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {taskApproving === task.id ? 'Approving...' : 'Approve'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Approval Card (local component)                                     */
/* ------------------------------------------------------------------ */

interface ApprovalCardProps {
  approval: Approval
  onVote: (vote: string, reason: string) => Promise<void>
}

function ApprovalCard({ approval, onVote }: ApprovalCardProps) {
  const voteCount = safeVotes(approval.votes).length

  return (
    <div className="bg-surface-raised rounded-lg p-4 space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          {/* Entity type */}
          <span
            className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium uppercase tracking-wider ${entityTypeBadge(
              approval.entity_type,
            )}`}
          >
            {approval.entity_type}
          </span>

          {/* Entity ID */}
          <span className="font-mono text-sm text-text-dim truncate" title={approval.entity_id}>
            {approval.entity_id}
          </span>
        </div>

        {/* Risk tier */}
        <RiskBadge tier={approval.risk_tier} />
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 text-xs text-text-muted">
        <span>
          by <span className="text-text-dim">{approval.created_by}</span>
        </span>
        <span>&middot;</span>
        <span>{formatDate(approval.created_at)}</span>
        {approval.status !== 'pending' && (
          <>
            <span>&middot;</span>
            <span
              className={`font-medium ${
                approval.status === 'approved' ? 'text-green' : 'text-red'
              }`}
            >
              {approval.status}
            </span>
          </>
        )}
      </div>

      {/* Quorum bar */}
      <QuorumBar current={voteCount} required={approval.quorum_required} />

      {/* Voting UI (votes list + buttons) */}
      <VotingUI approval={approval} onVote={onVote} />
    </div>
  )
}

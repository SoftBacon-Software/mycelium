import { useState } from 'react'
import type { Approval } from '../../api/types'
import { useAuthStore } from '../../stores/authStore'

interface VotingUIProps {
  approval: Approval
  onVote: (vote: string, reason: string) => Promise<void>
}

export default function VotingUI({ approval, onVote }: VotingUIProps) {
  const user = useAuthStore((s) => s.user)
  const [activeAction, setActiveAction] = useState<'approve' | 'reject' | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const userAlreadyVoted =
    user && approval.votes?.some((v) => v.voter_id === user.username)

  async function handleSubmit() {
    if (!activeAction) return
    setSubmitting(true)
    setError(null)

    try {
      await onVote(activeAction, reason.trim())
      setActiveAction(null)
      setReason('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Vote failed')
    } finally {
      setSubmitting(false)
    }
  }

  function handleCancel() {
    setActiveAction(null)
    setReason('')
    setError(null)
  }

  return (
    <div className="space-y-3">
      {/* Existing votes */}
      {approval.votes && approval.votes.length > 0 && (
        <div className="space-y-1.5">
          {approval.votes.map((vote) => (
            <div
              key={vote.id}
              className="flex items-start gap-2 text-sm"
            >
              <span
                className={`shrink-0 font-mono text-xs px-1.5 py-0.5 rounded ${
                  vote.vote === 'approve'
                    ? 'bg-green/10 text-green'
                    : 'bg-red/10 text-red'
                }`}
              >
                {vote.vote === 'approve' ? 'YES' : 'NO'}
              </span>
              <span className="text-text-dim font-medium">{vote.voter_id}</span>
              {vote.reason && (
                <span className="text-text-muted italic">&mdash; {vote.reason}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Voting controls */}
      {approval.status === 'pending' && !userAlreadyVoted && (
        <>
          {/* Error display */}
          {error && (
            <div className="px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
              {error}
            </div>
          )}

          {activeAction === null ? (
            /* Vote buttons */
            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveAction('approve')}
                className="px-4 py-1.5 rounded-sm bg-green/15 text-green text-sm font-medium hover:bg-green/25 transition-colors"
              >
                Approve
              </button>
              <button
                onClick={() => setActiveAction('reject')}
                className="px-4 py-1.5 rounded-sm bg-red/15 text-red text-sm font-medium hover:bg-red/25 transition-colors"
              >
                Reject
              </button>
            </div>
          ) : (
            /* Reason input + confirm */
            <div className="bg-surface rounded-sm p-3 space-y-2 border border-border">
              <p className="text-xs text-text-dim font-medium uppercase tracking-wider">
                {activeAction === 'approve' ? 'Approve' : 'Reject'} &mdash; reason
                <span className="text-text-muted font-normal normal-case tracking-normal ml-1">(optional)</span>
              </p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Add a reason..."
                rows={2}
                className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-text text-sm placeholder:text-text-muted focus:outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20 resize-none transition-colors"
                disabled={submitting}
                autoFocus
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className={`px-4 py-1.5 rounded-sm text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    activeAction === 'approve'
                      ? 'bg-green text-bg hover:bg-green/90'
                      : 'bg-red text-bg hover:bg-red/90'
                  }`}
                >
                  {submitting
                    ? 'Submitting...'
                    : activeAction === 'approve'
                      ? 'Confirm Approve'
                      : 'Confirm Reject'}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={submitting}
                  className="px-3 py-1.5 rounded-sm text-sm text-text-muted hover:text-text hover:bg-surface-raised/50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Already voted notice */}
      {userAlreadyVoted && (
        <p className="text-xs text-text-muted italic">You have already voted on this approval.</p>
      )}
    </div>
  )
}

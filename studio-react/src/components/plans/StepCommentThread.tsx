import { useState, useEffect, useCallback } from 'react'
import { fetchPlanStepComments, addPlanStepComment } from '../../api/endpoints'
import { useAuthStore } from '../../stores/authStore'
import { getSenderDisplay } from '../../utils/sender'
import { timeAgo } from '../../utils/time'
import type { PlanStepComment } from '../../api/types'

interface StepCommentThreadProps {
  planId: string
  stepId: string
}

export default function StepCommentThread({ planId, stepId }: StepCommentThreadProps) {
  const user = useAuthStore((s) => s.user)
  const [comments, setComments] = useState<PlanStepComment[]>([])
  const [loading, setLoading] = useState(true)
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await fetchPlanStepComments(planId, stepId)
      setComments(data)
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [planId, stepId])

  useEffect(() => {
    load()
  }, [load])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim() || submitting) return
    setSubmitting(true)
    try {
      await addPlanStepComment(planId, stepId, content.trim())
      setContent('')
      await load()
    } catch {
      // silent
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-2 pt-2 border-t border-border/50">
      <p className="text-xs text-text-muted font-medium mb-2">
        Comments {comments.length > 0 && `(${comments.length})`}
      </p>

      {loading && comments.length === 0 && (
        <p className="text-xs text-text-muted">Loading...</p>
      )}

      {comments.length > 0 && (
        <div className="space-y-2 mb-2">
          {comments.map((c) => (
            <div key={c.id} className="text-xs">
              <div className="flex items-center gap-1.5">
                <span className="w-5 h-5 rounded-full bg-accent/20 text-accent text-[10px] font-bold flex items-center justify-center shrink-0">
                  {(c.author || '?')[0].toUpperCase()}
                </span>
                <span className="text-text-dim font-medium">{getSenderDisplay(c.author)}</span>
                <span className="text-text-muted">&middot;</span>
                <span className="text-text-muted">{timeAgo(c.created_at)}</span>
              </div>
              <p className="text-text-dim ml-6.5 pl-[26px] whitespace-pre-wrap">{c.content}</p>
            </div>
          ))}
        </div>
      )}

      {/* Compose */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={user ? `Comment as ${user.display_name}...` : 'Add a comment...'}
          className="flex-1 bg-surface border border-border/50 rounded-sm px-2 py-1 text-xs text-text placeholder:text-text-muted focus:outline-none focus:border-accent/50"
        />
        <button
          type="submit"
          disabled={!content.trim() || submitting}
          className="px-3 py-1 rounded-sm bg-accent/15 text-accent text-xs font-medium hover:bg-accent/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? '...' : 'Send'}
        </button>
      </form>
    </div>
  )
}

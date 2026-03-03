import { useState, useEffect, useMemo, useCallback } from 'react'
import { toast } from 'sonner'
import {
  fetchFeedback,
  fetchFeedbackSummary,
  submitFeedback,
  deleteFeedbackItem,
} from '../api/endpoints'
import type { Feedback, FeedbackSummary } from '../api/types'
import { useDashboardStore } from '../stores/dashboardStore'
import { formatDateTime } from '../utils/time'
import SummaryCard from '../components/dashboard/SummaryCard'

// ─── Star Rating ─────────────────────────────────────────────────────────────

function StarRating({
  value,
  onChange,
  readonly = false,
  size = 'md',
}: {
  value: number
  onChange?: (v: number) => void
  readonly?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  const [hover, setHover] = useState(0)
  const sz = size === 'sm' ? 'text-sm' : size === 'lg' ? 'text-2xl' : 'text-lg'
  return (
    <span className={`inline-flex gap-0.5 ${sz}`}>
      {[1, 2, 3, 4, 5].map((s) => {
        const filled = s <= (hover || value)
        return (
          <span
            key={s}
            className={`transition-colors ${filled ? 'text-accent' : 'text-text-muted/40'} ${!readonly ? 'cursor-pointer hover:scale-110 transition-transform' : ''}`}
            onClick={() => !readonly && onChange?.(s)}
            onMouseEnter={() => !readonly && setHover(s)}
            onMouseLeave={() => !readonly && setHover(0)}
          >
            ★
          </span>
        )
      })}
    </span>
  )
}

// ─── Rating Badge ─────────────────────────────────────────────────────────────

function ratingColor(r: number) {
  if (r >= 5) return 'text-green'
  if (r >= 4) return 'text-accent'
  if (r >= 3) return 'text-text-dim'
  if (r >= 2) return 'text-red/70'
  return 'text-red'
}

// ─── Submit Feedback Modal ────────────────────────────────────────────────────

interface SubmitModalProps {
  agents: string[]
  onClose: () => void
  onSubmitted: () => void
}

const ENTITY_TYPES = ['general', 'task', 'plan_step', 'bug']

function SubmitFeedbackModal({ agents, onClose, onSubmitted }: SubmitModalProps) {
  const [entityType, setEntityType] = useState('general')
  const [entityId, setEntityId] = useState('')
  const [subject, setSubject] = useState('')
  const [rating, setRating] = useState(3)
  const [comment, setComment] = useState('')
  const [agentId, setAgentId] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (rating < 1 || rating > 5) {
      toast.error('Rating must be 1–5')
      return
    }
    setSaving(true)
    try {
      await submitFeedback({
        entity_type: entityType,
        entity_id: entityId.trim() || undefined,
        subject: subject.trim() || undefined,
        rating,
        comment: comment.trim() || undefined,
        agent_id: agentId || undefined,
      })
      toast.success('Feedback submitted')
      onSubmitted()
      onClose()
    } catch (err) {
      toast.error('Failed to submit feedback')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div className="flex items-center justify-between p-5 border-b border-border">
            <h2 className="text-lg font-semibold text-text">Submit Feedback</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-text-muted hover:text-text transition-colors p-1 -m-1 text-lg font-mono"
            >
              &times;
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* Rating */}
            <div>
              <label className="text-text-muted text-xs uppercase tracking-wider block mb-2">
                Rating *
              </label>
              <div className="flex items-center gap-3">
                <StarRating value={rating} onChange={setRating} size="lg" />
                <span className="text-text-dim text-sm font-mono">{rating}/5</span>
              </div>
            </div>

            {/* Subject */}
            <div>
              <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                Subject
              </label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief description of what you're rating..."
                className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Comment */}
            <div>
              <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                Comment
              </label>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="What worked well? What could improve?"
                rows={3}
                className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              />
            </div>

            <div className="flex items-center gap-4">
              {/* Entity type */}
              <div className="flex-1">
                <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                  Type
                </label>
                <select
                  value={entityType}
                  onChange={(e) => setEntityType(e.target.value)}
                  className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {ENTITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </div>

              {/* Entity ID */}
              {entityType !== 'general' && (
                <div className="flex-1">
                  <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                    ID
                  </label>
                  <input
                    type="text"
                    value={entityId}
                    onChange={(e) => setEntityId(e.target.value)}
                    placeholder={`${entityType} id...`}
                    className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              )}
            </div>

            {/* Agent */}
            <div>
              <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                Agent
              </label>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">— unspecified —</option>
                {agents.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 p-5 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-sm text-sm text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Submitting...' : 'Submit Feedback'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Feedback Card ────────────────────────────────────────────────────────────

function FeedbackCard({
  item,
  onDelete,
  isConfirming,
  onConfirmDelete,
}: {
  item: Feedback
  onDelete: (id: string) => void
  isConfirming: boolean
  onConfirmDelete: (id: string | null) => void
}) {
  return (
    <div className="bg-surface rounded-lg p-4 border border-border hover:border-border/80 transition-colors">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StarRating value={item.rating} readonly size="sm" />
            <span className={`text-xs font-mono font-bold ${ratingColor(item.rating)}`}>
              {item.rating}/5
            </span>
            {item.entity_type && item.entity_type !== 'general' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-raised text-text-muted font-mono uppercase tracking-wider">
                {item.entity_type.replace('_', ' ')}
                {item.entity_id ? ` #${item.entity_id}` : ''}
              </span>
            )}
            {item.agent_id && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent font-mono">
                {item.agent_id}
              </span>
            )}
          </div>
          {item.subject && (
            <p className="text-sm font-medium text-text mt-1.5 leading-snug">{item.subject}</p>
          )}
        </div>
        {isConfirming ? (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onDelete(item.id)}
              className="text-red text-xs font-medium px-1.5 py-0.5 rounded hover:bg-red/10 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => onConfirmDelete(null)}
              className="text-text-muted text-xs px-1.5 py-0.5 rounded hover:bg-surface-raised transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => onConfirmDelete(item.id)}
            className="text-text-muted hover:text-red transition-colors text-xs shrink-0 opacity-50 hover:opacity-100 px-1 py-0.5"
            title="Delete feedback"
          >
            ✕
          </button>
        )}
      </div>

      {item.comment && (
        <p className="text-sm text-text-dim leading-relaxed whitespace-pre-wrap mb-2">
          {item.comment}
        </p>
      )}

      <div className="flex items-center gap-3 text-xs text-text-muted">
        <span>by {item.submitted_by}</span>
        <span className="text-border/60">·</span>
        <span>{formatDateTime(item.created_at)}</span>
      </div>
    </div>
  )
}

// ─── Rating Distribution Bar ──────────────────────────────────────────────────

function RatingDistBar({ dist }: { dist: { rating: number; count: number }[] }) {
  const total = dist.reduce((s, d) => s + d.count, 0)
  const max = Math.max(...dist.map((d) => d.count), 1)
  // Ensure all 5 ratings shown
  const full = [1, 2, 3, 4, 5].map((r) => ({
    rating: r,
    count: dist.find((d) => d.rating === r)?.count ?? 0,
  })).reverse()

  return (
    <div className="space-y-2">
      {full.map((d) => (
        <div key={d.rating} className="flex items-center gap-3">
          <div className="flex items-center gap-1 w-16 shrink-0 justify-end">
            <StarRating value={d.rating} readonly size="sm" />
          </div>
          <div className="flex-1 bg-surface-raised rounded-full h-3 overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: max > 0 ? `${(d.count / max) * 100}%` : '0%' }}
            />
          </div>
          <span className="text-xs text-text-muted font-mono tabular-nums w-8 text-right">
            {d.count}
          </span>
          <span className="text-xs text-text-muted w-8 text-right">
            {total > 0 ? `${Math.round((d.count / total) * 100)}%` : '0%'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Agent Leaderboard ────────────────────────────────────────────────────────

function AgentLeaderboard({ byAgent }: { byAgent: { agent_id: string; count: number; avg_rating: number }[] }) {
  if (byAgent.length === 0) {
    return <p className="text-sm text-text-muted text-center py-8">No agent feedback yet</p>
  }
  return (
    <div className="space-y-2">
      {byAgent.map((a, idx) => (
        <div key={a.agent_id} className="flex items-center gap-3">
          <span className="text-xs text-text-muted font-mono w-4 text-right shrink-0">
            {idx + 1}.
          </span>
          <span className="text-xs text-text-dim font-mono truncate flex-1" title={a.agent_id}>
            {a.agent_id}
          </span>
          <StarRating value={Math.round(a.avg_rating)} readonly size="sm" />
          <span className={`text-xs font-mono font-semibold ${ratingColor(a.avg_rating)} w-8 text-right`}>
            {a.avg_rating.toFixed(1)}
          </span>
          <span className="text-xs text-text-muted w-10 text-right tabular-nums">
            {a.count}×
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type EntityTypeFilter = 'all' | 'general' | 'task' | 'plan_step' | 'bug'
type RatingFilter = 'all' | '5' | '4' | '3' | '2' | '1'

export default function FeedbackPage() {
  const agents = useDashboardStore((s) => s.agents)
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents])

  const [items, setItems] = useState<Feedback[]>([])
  const [summary, setSummary] = useState<FeedbackSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [showSubmit, setShowSubmit] = useState(false)

  // Filters
  const [entityTypeFilter, setEntityTypeFilter] = useState<EntityTypeFilter>('all')
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [feedbackRes, summaryRes] = await Promise.all([
        fetchFeedback({ limit: 100 }),
        fetchFeedbackSummary(),
      ])
      setItems(feedbackRes)
      setSummary(summaryRes)
    } catch (err) {
      toast.error('Failed to load feedback')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Filtered items
  const filtered = useMemo(() => {
    let result = items
    if (entityTypeFilter !== 'all') {
      result = result.filter((i) => i.entity_type === entityTypeFilter)
    }
    if (ratingFilter !== 'all') {
      result = result.filter((i) => i.rating === parseInt(ratingFilter))
    }
    if (agentFilter !== 'all') {
      result = result.filter((i) => i.agent_id === agentFilter)
    }
    return result
  }, [items, entityTypeFilter, ratingFilter, agentFilter])

  // Unique agents in current data
  const feedbackAgents = useMemo(() => {
    const set = new Set(items.map((i) => i.agent_id).filter(Boolean))
    return Array.from(set).sort()
  }, [items])

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  async function handleDelete(id: string) {
    try {
      await deleteFeedbackItem(id)
      toast.success('Feedback deleted')
      setConfirmDeleteId(null)
      load()
    } catch (err) {
      toast.error('Failed to delete')
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Feedback</h1>
          <p className="text-sm text-text-muted mt-0.5">Rate agent work quality and track improvement over time</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors px-3 py-1.5 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={() => setShowSubmit(true)}
            className="bg-accent text-bg rounded px-4 py-1.5 text-sm font-medium hover:bg-accent-light transition-colors"
          >
            + Submit Feedback
          </button>
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard
            title="Total Feedback"
            value={summary.total}
            color="accent"
          />
          <SummaryCard
            title="Avg Rating"
            value={summary.total > 0 ? summary.avg_rating.toFixed(2) : '—'}
            subtitle="out of 5"
            color={summary.avg_rating >= 4 ? 'green' : summary.avg_rating >= 3 ? 'accent' : 'red'}
          />
          <SummaryCard
            title="Agents Rated"
            value={summary.by_agent.length}
            color="muted"
          />
          <SummaryCard
            title="Recent (7 days)"
            value={summary.recent.length}
            color="muted"
          />
        </div>
      )}

      {/* Charts row */}
      {summary && summary.total > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-surface rounded-lg p-4">
            <h2 className="text-sm font-semibold text-text-dim mb-4">Rating Distribution</h2>
            <RatingDistBar dist={summary.rating_dist} />
          </div>
          <div className="bg-surface rounded-lg p-4">
            <h2 className="text-sm font-semibold text-text-dim mb-4">Agent Ratings</h2>
            <AgentLeaderboard byAgent={summary.by_agent} />
          </div>
        </div>
      )}

      {/* Filters + Feed */}
      <div className="bg-surface rounded-lg border border-border overflow-hidden">
        {/* Filter bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-wrap">
          <span className="text-xs text-text-muted font-medium">Filter:</span>

          {/* Entity type */}
          <div className="flex rounded-sm overflow-hidden border border-border">
            {(['all', 'general', 'task', 'plan_step', 'bug'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setEntityTypeFilter(t)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  entityTypeFilter === t
                    ? 'bg-surface-raised text-text'
                    : 'text-text-muted hover:text-text-dim'
                }`}
              >
                {t === 'all' ? 'All' : t.replace('_', ' ')}
              </button>
            ))}
          </div>

          {/* Rating */}
          <select
            value={ratingFilter}
            onChange={(e) => setRatingFilter(e.target.value as RatingFilter)}
            className="bg-surface-raised border border-border rounded-sm px-2.5 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">Any Rating</option>
            {[5, 4, 3, 2, 1].map((r) => (
              <option key={r} value={String(r)}>
                {'★'.repeat(r)} ({r} star{r !== 1 ? 's' : ''})
              </option>
            ))}
          </select>

          {/* Agent */}
          {feedbackAgents.length > 0 && (
            <select
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-2.5 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All Agents</option>
              {feedbackAgents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}

          <span className="ml-auto text-xs text-text-muted tabular-nums">
            {loading && items.length === 0 ? '...' : `${filtered.length} item${filtered.length !== 1 ? 's' : ''}`}
          </span>
        </div>

        {/* Feed */}
        <div className="p-4">
          {loading ? (
            <div className="text-center py-12 text-text-muted text-sm">Loading...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-text-muted text-sm">No feedback yet.</p>
              <p className="text-text-muted/60 text-xs mt-1">
                Submit the first piece of feedback to start tracking agent quality.
              </p>
              <button
                onClick={() => setShowSubmit(true)}
                className="mt-4 bg-accent text-bg rounded px-4 py-1.5 text-sm font-medium hover:bg-accent-light transition-colors"
              >
                Submit Feedback
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filtered.map((item) => (
                <FeedbackCard key={item.id} item={item} onDelete={handleDelete} isConfirming={confirmDeleteId === item.id} onConfirmDelete={setConfirmDeleteId} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Submit modal */}
      {showSubmit && (
        <SubmitFeedbackModal
          agents={agentIds}
          onClose={() => setShowSubmit(false)}
          onSubmitted={load}
        />
      )}
    </div>
  )
}

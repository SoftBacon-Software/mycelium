import type { Plan } from '../../api/types'
import Badge from '../shared/Badge'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const statusVariant: Record<string, 'green' | 'blue' | 'accent' | 'muted' | 'default'> = {
  active: 'green',
  completed: 'blue',
  draft: 'accent',
  cancelled: 'muted',
}

const priorityVariant: Record<string, 'red' | 'accent' | 'green' | 'muted' | 'default'> = {
  critical: 'red',
  high: 'red',
  medium: 'accent',
  low: 'green',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Component ───────────────────────────────────────────────────────────────

interface PlanCardProps {
  plan: Plan
  onClick: () => void
  isSelected?: boolean
}

export default function PlanCard({ plan, onClick, isSelected = false }: PlanCardProps) {
  const steps = plan.steps ?? []
  const completedSteps = steps.filter(
    (s) => s.status === 'done' || s.status === 'completed',
  ).length
  const totalSteps = steps.length
  const progressPct = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0

  return (
    <div
      onClick={onClick}
      className={`bg-surface-raised rounded-lg p-4 cursor-pointer transition-all hover:ring-1 ring-border ${
        isSelected ? 'ring-1 ring-accent/40' : ''
      }`}
    >
      {/* Title row */}
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <h3 className="font-semibold text-text text-sm leading-snug line-clamp-1">
          {plan.title}
        </h3>
        <Badge variant={priorityVariant[plan.priority?.toLowerCase()] ?? 'default'}>
          {plan.priority || 'normal'}
        </Badge>
      </div>

      {/* Description */}
      {plan.description && (
        <p className="text-text-dim text-sm line-clamp-2 mb-3 leading-relaxed">
          {plan.description}
        </p>
      )}

      {/* Progress bar */}
      {totalSteps > 0 && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs text-text-muted mb-1">
            <span>Progress</span>
            <span className="tabular-nums">
              {completedSteps}/{totalSteps} steps
            </span>
          </div>
          <div className="h-1.5 bg-surface rounded-full overflow-hidden">
            <div
              className="h-full bg-green rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant={statusVariant[plan.status?.toLowerCase()] ?? 'default'}>
            {plan.status}
          </Badge>
          {plan.owner && (
            <span className="text-text-muted text-xs truncate">{plan.owner}</span>
          )}
          {plan.project_id && (
            <>
              <span className="text-text-muted text-xs">&middot;</span>
              <span className="text-text-muted text-xs truncate">{plan.project_id}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted shrink-0">
          <span>{formatDate(plan.created_at)}</span>
          {plan.updated_at !== plan.created_at && (
            <>
              <span>&middot;</span>
              <span>upd {formatDate(plan.updated_at)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

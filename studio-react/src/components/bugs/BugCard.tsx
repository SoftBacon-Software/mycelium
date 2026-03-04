import type { Bug } from '../../api/types'
import Badge from '../shared/Badge'
import { timeAgo } from '../../utils/time'
import { getSenderDisplay } from '../../utils/sender'

interface BugCardProps {
  bug: Bug
  onClick: () => void
}

const severityBarColor: Record<string, string> = {
  critical: 'bg-red shadow-[0_0_8px_rgba(196,91,62,0.5)]',
  high: 'bg-red',
  normal: 'bg-accent',
  low: 'bg-text-muted',
}

const severityBadgeVariant: Record<string, 'red' | 'accent' | 'muted'> = {
  critical: 'red',
  high: 'red',
  normal: 'accent',
  low: 'muted',
}

const statusBadgeVariant: Record<string, 'red' | 'blue' | 'green' | 'muted' | 'default'> = {
  open: 'red',
  in_progress: 'blue',
  resolved: 'green',
  closed: 'muted',
}

const categoryBadgeVariant: Record<string, 'purple' | 'pink' | 'accent' | 'blue' | 'red' | 'default'> = {
  bug: 'purple',
  feature: 'accent',
  ui: 'pink',
  crash: 'red',
  api: 'blue',
  infrastructure: 'accent',
  other: 'default',
}


export default function BugCard({ bug, onClick }: BugCardProps) {
  const barColor = severityBarColor[bug.severity] ?? severityBarColor.normal

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-surface-raised rounded-lg p-4 mb-3 cursor-pointer flex gap-3 transition-all hover:ring-1 ring-border hover:bg-surface-raised/80 group"
    >
      {/* Severity indicator bar */}
      <div className={`w-1 shrink-0 rounded-full self-stretch ${barColor}`} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Title */}
        <p className="text-sm font-semibold text-text leading-snug group-hover:text-accent transition-colors">
          <span className="text-text-muted font-mono">#{bug.id}:</span> {bug.title}
        </p>

        {/* Description */}
        {bug.description && (
          <p className="text-text-dim text-sm mt-1 line-clamp-2 leading-relaxed">
            {bug.description}
          </p>
        )}

        {/* Badges */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <Badge variant={severityBadgeVariant[bug.severity] ?? 'muted'}>
            {bug.severity}
          </Badge>
          <Badge variant={categoryBadgeVariant[bug.category] ?? 'default'}>
            {bug.category}
          </Badge>
          <Badge variant={statusBadgeVariant[bug.status] ?? 'default'}>
            {bug.status.replace('_', ' ')}
          </Badge>
          {bug.project_id && (
            <Badge variant="muted">{bug.project_id}</Badge>
          )}
        </div>

        {/* Meta row */}
        <div className="flex items-center justify-between mt-2.5 text-xs text-text-muted">
          <div className="flex items-center gap-3 truncate">
            <span>
              Filed by <span className="text-text-dim">{getSenderDisplay(bug.filed_by)}</span>
            </span>
            {bug.assignee && (
              <span>
                Assigned to <span className="text-text-dim">{getSenderDisplay(bug.assignee)}</span>
              </span>
            )}
          </div>
          <span className="shrink-0 font-mono">
            {timeAgo(bug.updated_at || bug.created_at)}
          </span>
        </div>
      </div>
    </button>
  )
}

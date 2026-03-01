import type { Task } from '../../api/types'
import Badge from '../shared/Badge'

interface TaskCardProps {
  task: Task
  onClick: () => void
}

const priorityBorder: Record<string, string> = {
  urgent: 'border-l-red',
  high: 'border-l-accent',
  normal: 'border-l-border',
  low: 'border-l-text-muted',
}

const priorityBadgeVariant: Record<string, 'red' | 'accent' | 'muted'> = {
  urgent: 'red',
  high: 'accent',
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const seconds = Math.floor((now - then) / 1000)

  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

export default function TaskCard({ task, onClick }: TaskCardProps) {
  const borderClass = priorityBorder[task.priority] || priorityBorder.normal
  const badgeVariant = priorityBadgeVariant[task.priority]
  const needsApprovalBadge = task.needs_approval && !task.approved_by

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left bg-surface-raised rounded p-3 mb-2 cursor-pointer border-l-[3px] ${borderClass} transition-all hover:ring-1 ring-border hover:bg-surface-raised/80 group`}
    >
      <p className="text-sm font-medium text-text leading-snug group-hover:text-accent transition-colors">
        {task.title}
      </p>

      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {badgeVariant && (
          <Badge variant={badgeVariant}>{task.priority}</Badge>
        )}
        {needsApprovalBadge && (
          <Badge variant="red">approval</Badge>
        )}
        {task.game && (
          <Badge variant="muted">{task.game}</Badge>
        )}
        {task.tags?.slice(0, 2).map((tag) => (
          <Badge key={tag} variant="blue">{tag}</Badge>
        ))}
      </div>

      <div className="flex items-center justify-between mt-2.5 text-xs text-text-muted">
        <span className="truncate max-w-[60%]">
          {task.assignee || 'unassigned'}
        </span>
        <span className="shrink-0 font-mono">
          {timeAgo(task.updated_at || task.created_at)}
        </span>
      </div>
    </button>
  )
}

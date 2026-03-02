import type { Concept } from '../../api/types'
import Badge from '../shared/Badge'

interface ConceptCardProps {
  concept: Concept
  onClick: () => void
}

const typeBarColor: Record<string, string> = {
  character: 'bg-purple',
  style: 'bg-accent',
  ruleset: 'bg-blue',
  library: 'bg-green',
  brand: 'bg-red',
  custom: 'bg-text-muted',
}

const typeBadgeVariant: Record<string, 'purple' | 'accent' | 'blue' | 'green' | 'red' | 'muted'> = {
  character: 'purple',
  style: 'accent',
  ruleset: 'blue',
  library: 'green',
  brand: 'red',
  custom: 'muted',
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

export default function ConceptCard({ concept, onClick }: ConceptCardProps) {
  const barColor = typeBarColor[concept.type] ?? typeBarColor.custom

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-surface-raised rounded-lg p-4 mb-3 cursor-pointer flex gap-3 transition-all hover:ring-1 ring-border hover:bg-surface-raised/80 group"
    >
      {/* Type indicator bar */}
      <div className={`w-1 shrink-0 rounded-full self-stretch ${barColor}`} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Name */}
        <p className="text-sm font-semibold text-text leading-snug group-hover:text-accent transition-colors">
          <span className="text-text-muted font-mono">#{concept.id}:</span> {concept.name}
        </p>

        {/* Description */}
        {concept.description && (
          <p className="text-text-dim text-sm mt-1 line-clamp-2 leading-relaxed">
            {concept.description}
          </p>
        )}

        {/* Badges */}
        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          <Badge variant={typeBadgeVariant[concept.type] ?? 'muted'}>
            {concept.type}
          </Badge>
          {concept.projects?.map((p) => (
            <Badge key={p} variant="default">{p}</Badge>
          ))}
        </div>

        {/* Meta row */}
        <div className="flex items-center justify-end mt-2.5 text-xs text-text-muted">
          <span className="shrink-0 font-mono">
            {timeAgo(concept.updated_at || concept.created_at)}
          </span>
        </div>
      </div>
    </button>
  )
}

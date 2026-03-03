import type { Concept } from '../../api/types'
import Badge from '../shared/Badge'
import { timeAgo } from '../../utils/time'

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


export default function ConceptCard({ concept, onClick }: ConceptCardProps) {
  const barColor = typeBarColor[concept.type] ?? typeBarColor.custom

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-surface-raised rounded-lg p-4 cursor-pointer flex gap-3 transition-all hover:ring-1 ring-border hover:bg-surface-raised/80 group"
    >
      {/* Type indicator bar */}
      <div className={`w-1 shrink-0 rounded-full self-stretch ${barColor}`} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Name */}
        <p className="text-sm font-semibold text-text leading-snug group-hover:text-accent transition-colors">
          {concept.name}
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
        <div className="flex items-center justify-between mt-2.5 text-xs text-text-muted">
          <span className="font-mono opacity-60">#{concept.id}</span>
          <span className="shrink-0 font-mono">
            {timeAgo(concept.updated_at || concept.created_at)}
          </span>
        </div>
      </div>
    </button>
  )
}

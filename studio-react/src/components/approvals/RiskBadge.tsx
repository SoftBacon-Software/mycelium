interface RiskBadgeProps {
  tier: string
}

const tierStyles: Record<string, string> = {
  low: 'bg-green/10 text-green',
  medium: 'bg-accent/10 text-accent',
  high: 'bg-red/10 text-red',
  critical: 'bg-red/20 text-red font-bold border border-red/30',
}

export default function RiskBadge({ tier }: RiskBadgeProps) {
  const normalized = tier.toLowerCase()
  const style = tierStyles[normalized] ?? 'bg-surface text-text-muted'

  return (
    <span
      className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium ${style}`}
    >
      {normalized === 'critical' && (
        <span className="mr-1" aria-hidden="true">!</span>
      )}
      {tier}
    </span>
  )
}

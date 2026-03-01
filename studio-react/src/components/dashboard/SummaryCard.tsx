interface SummaryCardProps {
  title: string
  value: number | string
  subtitle?: string
  color?: 'accent' | 'green' | 'red' | 'blue' | 'purple' | 'muted'
  icon?: string
}

const colorClasses: Record<string, { text: string; glow: string; ring: string }> = {
  accent: { text: 'text-accent', glow: 'bg-glow-accent', ring: 'ring-accent/20' },
  green: { text: 'text-green', glow: 'bg-glow-green', ring: 'ring-green/20' },
  red: { text: 'text-red', glow: 'bg-glow-red', ring: 'ring-red/20' },
  blue: { text: 'text-blue', glow: 'bg-blue/10', ring: 'ring-blue/20' },
  purple: { text: 'text-purple', glow: 'bg-purple/10', ring: 'ring-purple/20' },
  muted: { text: 'text-text-dim', glow: 'bg-surface', ring: 'ring-border' },
}

const iconMap: Record<string, string> = {
  agents: '\u{1F916}',
  tasks: '\u{1F4CB}',
  messages: '\u{1F4AC}',
  bugs: '\u{1F41B}',
  plans: '\u{1F4D0}',
  assets: '\u{1F3A8}',
}

export default function SummaryCard({ title, value, subtitle, color = 'accent', icon }: SummaryCardProps) {
  const c = colorClasses[color] || colorClasses.accent

  return (
    <div
      className={`bg-surface-raised rounded-lg p-4 flex items-center gap-4 ring-1 ${c.ring} transition-all hover:scale-[1.02] hover:ring-2`}
    >
      <div className={`w-11 h-11 rounded-lg ${c.glow} flex items-center justify-center text-lg shrink-0`}>
        {icon ? iconMap[icon] || icon : title.charAt(0)}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-text-muted uppercase tracking-wider font-medium">{title}</p>
        <p className={`text-2xl font-bold ${c.text} tabular-nums leading-tight`}>{value}</p>
        {subtitle && (
          <p className="text-xs text-text-muted mt-0.5 truncate">{subtitle}</p>
        )}
      </div>
    </div>
  )
}

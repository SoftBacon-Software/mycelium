interface QuorumBarProps {
  current: number
  required: number
}

export default function QuorumBar({ current, required }: QuorumBarProps) {
  const met = current >= required
  const pct = required > 0 ? Math.min((current / required) * 100, 100) : 0

  let fillColor = 'bg-red'
  if (met) fillColor = 'bg-green'
  else if (current > 0) fillColor = 'bg-accent'

  return (
    <div className="w-full">
      {/* Bar */}
      <div className="h-2 rounded-full bg-surface overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${fillColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Label */}
      <div className="flex items-center gap-1.5 mt-1">
        {met ? (
          <>
            <svg
              className="w-3.5 h-3.5 text-green shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-xs text-green font-medium">Quorum met</span>
          </>
        ) : (
          <span className="text-xs text-text-muted">
            {current}/{required} votes
          </span>
        )}
      </div>
    </div>
  )
}

import { useState, useMemo } from 'react'
import { useDashboardStore } from '../../stores/dashboardStore'

export default function DirectiveBanner() {
  const messages = useDashboardStore((s) => s.messages)
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const activeDirectives = useMemo(
    () =>
      messages
        .filter((m) => m.msg_type === 'directive' && m.status !== 'resolved')
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [messages],
  )

  if (dismissed || activeDirectives.length === 0) return null

  const latest = activeDirectives[0]
  const extraCount = activeDirectives.length - 1
  const contentText = latest.content
  const truncated = contentText.length > 200
  const displayContent = expanded ? contentText : contentText.slice(0, 200) + (truncated ? '...' : '')

  return (
    <div className="w-full bg-red/10 border border-red/20 rounded-lg px-4 py-3 mb-4">
      <div className="flex items-start gap-3">
        {/* Warning icon */}
        <span className="text-red text-lg leading-none shrink-0 mt-0.5" aria-hidden="true">
          !
        </span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-red font-bold text-sm uppercase tracking-wider">
              Directive
            </span>
            {extraCount > 0 && (
              <span className="text-text-muted text-xs">(+{extraCount} more)</span>
            )}
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className="text-left w-full"
          >
            <p className="text-text text-sm leading-relaxed">{displayContent}</p>
          </button>

          <p className="text-text-muted text-xs mt-1.5">
            From <span className="text-text-dim">{latest.from_agent}</span>
            {latest.to_agent && (
              <>
                {' '}&rarr; <span className="text-text-dim">{latest.to_agent}</span>
              </>
            )}
          </p>
        </div>

        {/* Dismiss button */}
        <button
          onClick={() => setDismissed(true)}
          className="text-text-muted hover:text-text transition-colors shrink-0 p-1 -m-1"
          title="Dismiss banner"
          aria-label="Dismiss directive banner"
        >
          <span className="text-sm font-mono leading-none">&times;</span>
        </button>
      </div>
    </div>
  )
}

import { useState, useRef, useEffect, useCallback } from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Pill {
  value: string
  source: string  // 'custom' | 'platform' | 'team:<name>' | 'ruleset:<name>'
  locked: boolean
}

export type PillCategory = 'capabilities' | 'responsibilities' | 'guardrails' | 'projects' | 'teams'

interface PillCloudProps {
  category: PillCategory
  pills: Pill[]
  editable?: boolean
  forbiddenValues?: string[]
  presets?: string[]
  onAdd?: (value: string) => void
  onRemove?: (value: string) => void
}

// ─── Colors ──────────────────────────────────────────────────────────────────

const categoryColors: Record<PillCategory, { bg: string; text: string; border: string }> = {
  capabilities:     { bg: 'bg-green/15',  text: 'text-green',  border: 'border-green/20' },
  responsibilities: { bg: 'bg-blue/15',   text: 'text-blue',   border: 'border-blue/20' },
  guardrails:       { bg: 'bg-red/15',    text: 'text-red',    border: 'border-red/20' },
  projects:         { bg: 'bg-accent/15', text: 'text-accent', border: 'border-accent/20' },
  teams:            { bg: 'bg-purple/15', text: 'text-purple', border: 'border-purple/20' },
}

const categoryLabels: Record<PillCategory, string> = {
  capabilities: 'Capabilities',
  responsibilities: 'Responsibilities',
  guardrails: 'Guardrails',
  projects: 'Projects',
  teams: 'Teams',
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PillCloud({
  category,
  pills,
  editable = false,
  forbiddenValues = [],
  presets = [],
  onAdd,
  onRemove,
}: PillCloudProps) {
  const [isAdding, setIsAdding] = useState(false)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const colors = categoryColors[category]
  const existingValues = pills.map(p => p.value.toLowerCase())

  // Filter presets: not already added, not forbidden, matches filter text
  const filteredPresets = presets.filter(p => {
    const lower = p.toLowerCase()
    if (existingValues.includes(lower)) return false
    if (forbiddenValues.includes(p)) return false
    if (filter && !lower.includes(filter.toLowerCase())) return false
    return true
  })

  // Forbidden presets to show greyed out
  const forbiddenPresets = presets.filter(p =>
    forbiddenValues.includes(p) && !existingValues.includes(p.toLowerCase())
  ).filter(p => !filter || p.toLowerCase().includes(filter.toLowerCase()))

  const showCustomOption = filter.trim() &&
    !existingValues.includes(filter.trim().toLowerCase()) &&
    !forbiddenValues.includes(filter.trim()) &&
    !filteredPresets.some(p => p.toLowerCase() === filter.trim().toLowerCase())

  // Close dropdown on outside click
  useEffect(() => {
    if (!isAdding) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsAdding(false)
        setFilter('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isAdding])

  // Focus input when opening
  useEffect(() => {
    if (isAdding && inputRef.current) inputRef.current.focus()
  }, [isAdding])

  const handleAdd = useCallback((value: string) => {
    if (onAdd) onAdd(value)
    setFilter('')
    setIsAdding(false)
  }, [onAdd])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && filter.trim()) {
      e.preventDefault()
      if (filteredPresets.length > 0) {
        handleAdd(filteredPresets[0])
      } else if (showCustomOption) {
        handleAdd(filter.trim())
      }
    }
    if (e.key === 'Escape') {
      setIsAdding(false)
      setFilter('')
    }
  }, [filter, filteredPresets, showCustomOption, handleAdd])

  function formatSource(source: string): string {
    if (source === 'custom') return 'Custom'
    if (source === 'platform') return 'Platform'
    if (source.startsWith('team:')) return 'Team: ' + source.slice(5)
    if (source.startsWith('ruleset:')) return 'Ruleset: ' + source.slice(8)
    return source
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
          {categoryLabels[category]}
        </h4>
        <span className="text-[10px] text-text-muted font-mono">{pills.length}</span>
      </div>

      <div className="flex flex-wrap gap-1.5 min-h-[28px]">
        {pills.map((pill) => (
          <span
            key={pill.value}
            title={pill.locked ? `From: ${formatSource(pill.source)}` : 'Custom (removable)'}
            className={[
              'inline-flex items-center gap-1 rounded-full font-mono text-xs px-2.5 py-0.5 border transition-colors',
              pill.locked
                ? `${colors.bg} ${colors.text} ${colors.border} opacity-80`
                : `${colors.bg} ${colors.text} ${colors.border}`,
            ].join(' ')}
          >
            {pill.locked && (
              <svg className="w-2.5 h-2.5 opacity-50 shrink-0" viewBox="0 0 16 16" fill="currentColor">
                <path d="M11 7V5a3 3 0 0 0-6 0v2H4v6h8V7h-1zm-4-2a1 1 0 1 1 2 0v2H7V5z" />
              </svg>
            )}
            <span className="truncate max-w-[200px]">{pill.value}</span>
            {!pill.locked && editable && onRemove && (
              <button
                onClick={() => onRemove(pill.value)}
                className="ml-0.5 hover:opacity-100 opacity-50 transition-opacity"
              >
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z" />
                </svg>
              </button>
            )}
          </span>
        ))}

        {pills.length === 0 && !editable && (
          <span className="text-xs text-text-muted italic">None</span>
        )}

        {/* Add button */}
        {editable && !isAdding && (
          <button
            onClick={() => setIsAdding(true)}
            className={`inline-flex items-center gap-1 rounded-full text-xs px-2.5 py-0.5 border border-dashed ${colors.border} ${colors.text} opacity-50 hover:opacity-100 transition-opacity`}
          >
            <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z" />
            </svg>
            Add
          </button>
        )}

        {/* Inline combobox */}
        {editable && isAdding && (
          <div ref={dropdownRef} className="relative">
            <input
              ref={inputRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type to filter..."
              className={`text-xs px-2.5 py-0.5 rounded-full border ${colors.border} bg-surface text-text focus:outline-none focus:ring-1 focus:ring-accent/30 w-40`}
            />
            {(filteredPresets.length > 0 || forbiddenPresets.length > 0 || showCustomOption) && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-surface-raised border border-border rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto">
                {filteredPresets.map(p => (
                  <button
                    key={p}
                    onClick={() => handleAdd(p)}
                    className="w-full text-left text-xs px-3 py-1.5 hover:bg-surface text-text-dim transition-colors"
                  >
                    {p}
                  </button>
                ))}
                {forbiddenPresets.map(p => (
                  <div
                    key={p}
                    className="w-full text-left text-xs px-3 py-1.5 text-text-muted line-through cursor-not-allowed"
                    title={`Forbidden for this agent type`}
                  >
                    {p}
                  </div>
                ))}
                {showCustomOption && (
                  <button
                    onClick={() => handleAdd(filter.trim())}
                    className="w-full text-left text-xs px-3 py-1.5 hover:bg-surface text-accent transition-colors border-t border-border"
                  >
                    + Add "{filter.trim()}"
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

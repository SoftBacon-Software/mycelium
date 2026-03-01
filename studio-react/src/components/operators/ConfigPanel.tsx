import { useState, useRef, useEffect, useCallback } from 'react'
import type { ConfigEntry } from '../../api/types'

interface ConfigPanelProps {
  configs: ConfigEntry[]
  onSave: (key: string, value: string) => Promise<void>
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

interface EditableCellProps {
  value: string
  onSave: (newValue: string) => Promise<void>
}

function EditableCell({ value, onSave }: EditableCellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  useEffect(() => {
    setDraft(value)
  }, [value])

  const commitSave = useCallback(async () => {
    const trimmed = draft.trim()
    if (trimmed === value) {
      setEditing(false)
      return
    }
    setSaving(true)
    try {
      await onSave(trimmed)
      setFlash(true)
      setTimeout(() => setFlash(false), 800)
    } catch {
      setDraft(value)
    } finally {
      setSaving(false)
      setEditing(false)
    }
  }, [draft, value, onSave])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitSave()
    } else if (e.key === 'Escape') {
      setDraft(value)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitSave}
        onKeyDown={handleKeyDown}
        disabled={saving}
        className="w-full bg-bg border border-accent/30 rounded-sm px-2 py-1 text-text font-mono text-sm focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/20 transition-colors disabled:opacity-50"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`text-left w-full px-2 py-1 rounded-sm font-mono text-sm cursor-pointer transition-all duration-300 hover:bg-surface-raised/60 ${
        flash
          ? 'bg-green/10 text-green'
          : 'text-text'
      }`}
      title="Click to edit"
    >
      {saving ? 'Saving...' : (value || '\u00A0')}
    </button>
  )
}

export default function ConfigPanel({ configs, onSave }: ConfigPanelProps) {
  if (configs.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-6 text-center">
        <p className="text-text-muted text-sm">No configuration entries found.</p>
      </div>
    )
  }

  return (
    <div className="bg-surface rounded-lg overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
              Key
            </th>
            <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
              Value
            </th>
            <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-text-muted">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {configs.map((entry) => (
            <tr
              key={entry.key}
              className="border-b border-border/50 last:border-b-0 hover:bg-surface-raised/30 transition-colors"
            >
              <td className="px-4 py-3">
                <span className="font-mono text-accent text-sm">{entry.key}</span>
              </td>
              <td className="px-4 py-3">
                <EditableCell
                  value={formatValue(entry.value)}
                  onSave={(newValue) => onSave(entry.key, newValue)}
                />
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-text-muted text-xs">{entry.updated_by}</span>
                  <span className="text-text-muted text-xs">{formatDate(entry.updated_at)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

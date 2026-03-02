import { useEffect, useState, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useAuthStore } from '../stores/authStore'
import { fileBug, updateBug } from '../api/endpoints'
import type { Bug } from '../api/types'
import BugCard from '../components/bugs/BugCard'
import ModalOverlay from '../components/modals/ModalOverlay'
import Badge from '../components/shared/Badge'

type StatusFilter = 'open' | 'in_progress' | 'resolved' | 'closed' | 'all'

const STATUS_TABS: { key: StatusFilter; label: string; color: string }[] = [
  { key: 'open', label: 'Open', color: 'text-red' },
  { key: 'in_progress', label: 'In Progress', color: 'text-blue' },
  { key: 'resolved', label: 'Resolved', color: 'text-green' },
  { key: 'closed', label: 'Closed', color: 'text-text-muted' },
  { key: 'all', label: 'All', color: 'text-text-dim' },
]

const SEVERITY_OPTIONS = ['all', 'critical', 'high', 'normal', 'low']
const PROJECT_OPTIONS_FILTER = ['all', 'willing-sacrifice', 'king-city', 'mycelium']

// ─── File Bug Modal ──────────────────────────────────────────────────────────

const PROJECT_OPTIONS = ['willing-sacrifice', 'king-city', 'mycelium']
const SEVERITY_CHOICES = ['normal', 'high', 'critical', 'low']
const CATEGORY_OPTIONS = ['other', 'gameplay', 'ui', 'crash', 'api', 'infrastructure', 'balance']

interface FileBugModalProps {
  isOpen: boolean
  onClose: () => void
}

function FileBugModal({ isOpen, onClose }: FileBugModalProps) {
  const refresh = useDashboardStore((s) => s.refresh)
  const user = useAuthStore((s) => s.user)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('king-city')
  const [severity, setSeverity] = useState('normal')
  const [category, setCategory] = useState('other')
  const [assignee, setAssignee] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetForm() {
    setTitle('')
    setDescription('')
    setProjectId('king-city')
    setSeverity('normal')
    setCategory('other')
    setAssignee('')
    setError(null)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return

    setSubmitting(true)
    setError(null)

    try {
      await fileBug({
        title: title.trim(),
        description: description.trim(),
        project_id: projectId,
        severity,
        category,
        assignee: assignee.trim() || null,
        filed_by: user?.username || 'operator',
        status: 'open',
      })
      await refresh()
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to file bug')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={handleClose} title="File Bug">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
            {error}
          </div>
        )}

        {/* Title */}
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Title *
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Bug title..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
            autoFocus
            required
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="Steps to reproduce, expected vs actual behavior..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
          />
        </div>

        {/* Project / Severity */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              Project
            </label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {PROJECT_OPTIONS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              Severity
            </label>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {SEVERITY_CHOICES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Category / Assignee */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              Assignee
            </label>
            <input
              type="text"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="agent-id (optional)"
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 rounded-sm text-sm text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="px-4 py-1.5 rounded-sm text-sm font-medium bg-red/80 text-text hover:bg-red/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Filing...' : 'File Bug'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// ─── Bug Detail Panel ────────────────────────────────────────────────────────

const statusFlow = ['open', 'in_progress', 'resolved', 'closed'] as const

const statusColors: Record<string, string> = {
  open: 'bg-surface hover:bg-red/20 text-text-dim hover:text-red',
  in_progress: 'bg-surface hover:bg-blue/20 text-text-dim hover:text-blue',
  resolved: 'bg-surface hover:bg-green/20 text-text-dim hover:text-green',
  closed: 'bg-surface hover:bg-text-muted/20 text-text-dim hover:text-text-muted',
}

const statusActiveColors: Record<string, string> = {
  open: 'bg-red/20 text-red ring-1 ring-red/40',
  in_progress: 'bg-blue/20 text-blue ring-1 ring-blue/40',
  resolved: 'bg-green/20 text-green ring-1 ring-green/40',
  closed: 'bg-text-muted/20 text-text-muted ring-1 ring-text-muted/40',
}

const statusLabels: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
}

const severityBadgeVariant: Record<string, 'red' | 'accent' | 'muted'> = {
  critical: 'red',
  high: 'red',
  normal: 'accent',
  low: 'muted',
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

interface BugDetailProps {
  bug: Bug
  onClose: () => void
}

function BugDetail({ bug, onClose }: BugDetailProps) {
  const refresh = useDashboardStore((s) => s.refresh)
  const [updating, setUpdating] = useState(false)
  const [notes, setNotes] = useState(bug.notes || '')
  const [editSeverity, setEditSeverity] = useState(bug.severity)
  const [editAssignee, setEditAssignee] = useState(bug.assignee || '')
  const [savingFields, setSavingFields] = useState(false)

  // Sync local state when bug prop changes
  useEffect(() => {
    setNotes(bug.notes || '')
    setEditSeverity(bug.severity)
    setEditAssignee(bug.assignee || '')
  }, [bug.id, bug.notes, bug.severity, bug.assignee])

  const handleStatusChange = useCallback(
    async (newStatus: string) => {
      if (newStatus === bug.status || updating) return
      setUpdating(true)
      try {
        await updateBug(bug.id, { status: newStatus })
        await refresh()
      } catch (err) {
        console.error('Failed to update bug status:', err)
      } finally {
        setUpdating(false)
      }
    },
    [bug.id, bug.status, updating, refresh],
  )

  const handleSaveFields = useCallback(async () => {
    setSavingFields(true)
    try {
      await updateBug(bug.id, {
        notes: notes.trim() || null,
        severity: editSeverity,
        assignee: editAssignee.trim() || null,
      })
      await refresh()
    } catch (err) {
      console.error('Failed to update bug:', err)
    } finally {
      setSavingFields(false)
    }
  }, [bug.id, notes, editSeverity, editAssignee, refresh])

  const hasFieldChanges =
    notes !== (bug.notes || '') ||
    editSeverity !== bug.severity ||
    editAssignee !== (bug.assignee || '')

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-bg/60 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-surface border-l border-border z-50 flex flex-col animate-in slide-in-from-right">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
          <div className="min-w-0 flex-1 mr-3">
            <p className="text-xs text-text-muted font-mono mb-1">#{bug.id}</p>
            <h2 className="text-lg font-semibold text-text leading-snug">{bug.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors p-1 -mt-1 -mr-1 shrink-0"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Description */}
          {bug.description && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">
                Description
              </h3>
              <p className="text-sm text-text-dim leading-relaxed whitespace-pre-wrap">
                {bug.description}
              </p>
            </div>
          )}

          {/* Status buttons */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">
              Status
            </h3>
            <div className="flex gap-2 flex-wrap">
              {statusFlow.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleStatusChange(s)}
                  disabled={updating}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-all ${
                    bug.status === s ? statusActiveColors[s] : statusColors[s]
                  } ${updating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  {statusLabels[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Editable metadata */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">
              Details
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Severity">
                <select
                  value={editSeverity}
                  onChange={(e) => setEditSeverity(e.target.value)}
                  className="bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-accent/40 w-full"
                >
                  {SEVERITY_CHOICES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </MetaField>
              <MetaField label="Category">
                <Badge variant="default">{bug.category}</Badge>
              </MetaField>
              <MetaField label="Assignee">
                <input
                  type="text"
                  value={editAssignee}
                  onChange={(e) => setEditAssignee(e.target.value)}
                  placeholder="unassigned"
                  className="bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 w-full"
                />
              </MetaField>
              <MetaField label="Filed by">
                <span className="text-sm text-text">{bug.filed_by}</span>
              </MetaField>
              <MetaField label="Project">
                <span className="text-sm text-text font-mono">{bug.project_id}</span>
              </MetaField>
              <MetaField label="Severity badge">
                <Badge variant={severityBadgeVariant[editSeverity] ?? 'muted'}>
                  {editSeverity}
                </Badge>
              </MetaField>
            </div>
          </div>

          {/* Timestamps */}
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span>Created {formatDate(bug.created_at)}</span>
            {bug.updated_at !== bug.created_at && (
              <span>Updated {formatDate(bug.updated_at)}</span>
            )}
          </div>

          {/* Notes */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">
              Notes
            </h3>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Add notes about this bug..."
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
            />
          </div>

          {/* Save button (only shown when there are changes) */}
          {hasFieldChanges && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSaveFields}
                disabled={savingFields}
                className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingFields ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-text-muted mb-0.5">{label}</p>
      {children}
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function BugsPage() {
  const { bugs, bugCounts, loading, refresh } = useDashboardStore()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open')
  const [severityFilter, setSeverityFilter] = useState('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [selectedBug, setSelectedBug] = useState<Bug | null>(null)
  const [showFileBug, setShowFileBug] = useState(false)

  useEffect(() => {
    refresh()
  }, [refresh])

  // Filter logic
  const filtered = useMemo(() => {
    let result = bugs
    if (statusFilter !== 'all') {
      result = result.filter((b) => b.status === statusFilter)
    }
    if (severityFilter !== 'all') {
      result = result.filter((b) => b.severity === severityFilter)
    }
    if (projectFilter !== 'all') {
      result = result.filter((b) => b.project_id === projectFilter)
    }
    return result.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
  }, [bugs, statusFilter, severityFilter, projectFilter])

  // Keep selected bug in sync with store data
  useEffect(() => {
    if (!selectedBug) return
    const found = bugs.find((b) => b.id === selectedBug.id)
    if (found) setSelectedBug(found)
  }, [bugs, selectedBug])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-text">Bugs</h1>
          {bugCounts.open > 0 && (
            <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-red/15 text-red text-xs font-bold tabular-nums">
              {bugCounts.open}
            </span>
          )}
          {bugCounts.in_progress > 0 && (
            <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-blue/15 text-blue text-xs font-bold tabular-nums">
              {bugCounts.in_progress}
            </span>
          )}
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Severity filter */}
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="bg-surface-raised border border-border rounded-sm px-2.5 py-1.5 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer min-w-[100px]"
          >
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 'all' ? 'All Severity' : s}
              </option>
            ))}
          </select>

          {/* Project filter */}
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-surface-raised border border-border rounded-sm px-2.5 py-1.5 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer min-w-[100px]"
          >
            {PROJECT_OPTIONS_FILTER.map((g) => (
              <option key={g} value={g}>
                {g === 'all' ? 'All Projects' : g}
              </option>
            ))}
          </select>

          {/* File Bug button */}
          <button
            type="button"
            onClick={() => setShowFileBug(true)}
            className="bg-red/80 text-text px-4 py-1.5 rounded text-sm font-medium hover:bg-red/90 transition-colors"
          >
            File Bug
          </button>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex rounded-sm overflow-hidden border border-border w-fit">
        {STATUS_TABS.map((tab) => {
          const count =
            tab.key === 'all'
              ? bugs.length
              : bugs.filter((b) => b.status === tab.key).length

          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatusFilter(tab.key)}
              className={`px-4 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                statusFilter === tab.key
                  ? 'bg-surface-raised text-text'
                  : 'text-text-muted hover:text-text-dim'
              }`}
            >
              {tab.label}
              <span className="font-mono text-text-muted tabular-nums">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Bug list */}
      {filtered.length === 0 ? (
        <div className="bg-surface rounded-lg p-12 text-center">
          <p className="text-text-muted text-sm">
            No bugs match the current filters.
          </p>
        </div>
      ) : (
        <div>
          {filtered.map((bug) => (
            <BugCard
              key={bug.id}
              bug={bug}
              onClick={() => setSelectedBug(bug)}
            />
          ))}
        </div>
      )}

      {/* Bug detail panel */}
      {selectedBug && (
        <BugDetail
          bug={selectedBug}
          onClose={() => setSelectedBug(null)}
        />
      )}

      {/* File Bug modal */}
      <FileBugModal
        isOpen={showFileBug}
        onClose={() => setShowFileBug(false)}
      />
    </div>
  )
}

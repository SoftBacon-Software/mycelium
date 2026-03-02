import { useEffect, useState, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { createConcept, updateConcept, deleteConcept, linkConceptToProject, unlinkConceptFromProject } from '../api/endpoints'
import type { Concept } from '../api/types'
import ConceptCard from '../components/concepts/ConceptCard'
import ModalOverlay from '../components/modals/ModalOverlay'
type TypeFilter = 'all' | 'character' | 'style' | 'ruleset' | 'library' | 'brand' | 'custom'

const TYPE_TABS: { key: TypeFilter; label: string; color: string }[] = [
  { key: 'all', label: 'All', color: 'text-text-dim' },
  { key: 'character', label: 'Character', color: 'text-purple' },
  { key: 'style', label: 'Style', color: 'text-accent' },
  { key: 'ruleset', label: 'Ruleset', color: 'text-blue' },
  { key: 'library', label: 'Library', color: 'text-green' },
  { key: 'brand', label: 'Brand', color: 'text-red' },
  { key: 'custom', label: 'Custom', color: 'text-text-muted' },
]

const TYPE_OPTIONS = ['character', 'style', 'ruleset', 'library', 'brand', 'custom']

// -- Create Concept Modal --

interface CreateConceptModalProps {
  isOpen: boolean
  onClose: () => void
}

function CreateConceptModal({ isOpen, onClose }: CreateConceptModalProps) {
  const refresh = useDashboardStore((s) => s.refresh)

  const [name, setName] = useState('')
  const [type, setType] = useState('character')
  const [description, setDescription] = useState('')
  const [dataStr, setDataStr] = useState('{}')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetForm() {
    setName('')
    setType('character')
    setDescription('')
    setDataStr('{}')
    setError(null)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return

    let parsedData: unknown
    try {
      parsedData = JSON.parse(dataStr)
    } catch {
      setError('Invalid JSON in data field')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await createConcept({
        name: name.trim(),
        type,
        description: description.trim(),
        data: parsedData,
      })
      await refresh()
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create concept')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={handleClose} title="Create Concept">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
            {error}
          </div>
        )}

        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Concept name..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
            autoFocus
            required
          />
        </div>

        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Type
          </label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
          >
            {TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What this concept represents..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
          />
        </div>

        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Data (JSON)
          </label>
          <textarea
            value={dataStr}
            onChange={(e) => setDataStr(e.target.value)}
            rows={4}
            placeholder="{}"
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none font-mono text-xs"
          />
        </div>

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
            disabled={submitting || !name.trim()}
            className="px-4 py-1.5 rounded-sm text-sm font-medium bg-purple/80 text-text hover:bg-purple/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Creating...' : 'Create Concept'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// -- Concept Detail Panel --

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

interface ConceptDetailProps {
  concept: Concept
  onClose: () => void
}

function ConceptDetail({ concept, onClose }: ConceptDetailProps) {
  const refresh = useDashboardStore((s) => s.refresh)
  const projects = useDashboardStore((s) => s.projects)

  const [editName, setEditName] = useState(concept.name)
  const [editType, setEditType] = useState(concept.type)
  const [editDescription, setEditDescription] = useState(concept.description)
  const [editingData, setEditingData] = useState(false)
  const [dataStr, setDataStr] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [linkProject, setLinkProject] = useState('')

  useEffect(() => {
    setEditName(concept.name)
    setEditType(concept.type)
    setEditDescription(concept.description)
    setEditingData(false)
    setConfirmDelete(false)
  }, [concept.id, concept.name, concept.type, concept.description])

  const prettyData = useMemo(() => {
    try {
      return JSON.stringify(concept.data, null, 2)
    } catch {
      return String(concept.data)
    }
  }, [concept.data])

  const hasChanges =
    editName !== concept.name ||
    editType !== concept.type ||
    editDescription !== concept.description

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const updates: Partial<Concept> = {}
      if (editName !== concept.name) updates.name = editName
      if (editType !== concept.type) updates.type = editType
      if (editDescription !== concept.description) updates.description = editDescription
      await updateConcept(concept.id, updates)
      await refresh()
    } catch (err) {
      console.error('Failed to update concept:', err)
    } finally {
      setSaving(false)
    }
  }, [concept.id, concept.name, concept.type, concept.description, editName, editType, editDescription, refresh])

  const handleSaveData = useCallback(async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(dataStr)
    } catch {
      return
    }
    setSaving(true)
    try {
      await updateConcept(concept.id, { data: parsed })
      await refresh()
      setEditingData(false)
    } catch (err) {
      console.error('Failed to update concept data:', err)
    } finally {
      setSaving(false)
    }
  }, [concept.id, dataStr, refresh])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteConcept(concept.id)
      await refresh()
      onClose()
    } catch (err) {
      console.error('Failed to delete concept:', err)
    } finally {
      setDeleting(false)
    }
  }, [concept.id, refresh, onClose])

  const handleLink = useCallback(async () => {
    if (!linkProject) return
    try {
      await linkConceptToProject(concept.id, linkProject)
      await refresh()
      setLinkProject('')
    } catch (err) {
      console.error('Failed to link project:', err)
    }
  }, [concept.id, linkProject, refresh])

  const handleUnlink = useCallback(async (projectId: string) => {
    try {
      await unlinkConceptFromProject(concept.id, projectId)
      await refresh()
    } catch (err) {
      console.error('Failed to unlink project:', err)
    }
  }, [concept.id, refresh])

  const availableProjects = useMemo(() => {
    const linked = new Set(concept.projects || [])
    return projects.filter((p) => !linked.has(p.id))
  }, [projects, concept.projects])

  return (
    <>
      <div
        className="fixed inset-0 bg-bg/60 z-40"
        onClick={onClose}
        aria-hidden
      />

      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-surface border-l border-border z-50 flex flex-col animate-in slide-in-from-right">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
          <div className="min-w-0 flex-1 mr-3">
            <p className="text-xs text-text-muted font-mono mb-1">#{concept.id}</p>
            <h2 className="text-lg font-semibold text-text leading-snug">{concept.name}</h2>
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
          {/* Editable name */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Name</h3>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
            />
          </div>

          {/* Type */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Type</h3>
            <select
              value={editType}
              onChange={(e) => setEditType(e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-accent/40 w-full"
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {/* Description */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Description</h3>
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              rows={3}
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
            />
          </div>

          {/* Linked projects */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Linked Projects</h3>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {(concept.projects || []).length === 0 && (
                <span className="text-xs text-text-muted">No linked projects</span>
              )}
              {(concept.projects || []).map((p) => (
                <span key={p} className="inline-flex items-center gap-1 bg-surface-raised rounded-full px-2.5 py-0.5 text-xs text-text-dim">
                  {p}
                  <button
                    type="button"
                    onClick={() => handleUnlink(p)}
                    className="text-text-muted hover:text-red transition-colors ml-0.5"
                    title="Unlink"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
            {availableProjects.length > 0 && (
              <div className="flex gap-2">
                <select
                  value={linkProject}
                  onChange={(e) => setLinkProject(e.target.value)}
                  className="bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-accent/40 flex-1"
                >
                  <option value="">Select project...</option>
                  {availableProjects.map((p) => (
                    <option key={p.id} value={p.id}>{p.title || p.id}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleLink}
                  disabled={!linkProject}
                  className="px-3 py-1 rounded-sm text-xs font-medium bg-accent/80 text-bg hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Link
                </button>
              </div>
            )}
          </div>

          {/* Data viewer/editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium">Data</h3>
              <button
                type="button"
                onClick={() => {
                  if (!editingData) setDataStr(prettyData)
                  setEditingData(!editingData)
                }}
                className="text-xs text-accent hover:text-accent-light transition-colors"
              >
                {editingData ? 'Cancel' : 'Edit'}
              </button>
            </div>
            {editingData ? (
              <div className="space-y-2">
                <textarea
                  value={dataStr}
                  onChange={(e) => setDataStr(e.target.value)}
                  rows={8}
                  className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleSaveData}
                    disabled={saving}
                    className="px-3 py-1 rounded-sm text-xs font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : 'Save Data'}
                  </button>
                </div>
              </div>
            ) : (
              <pre className="bg-surface-raised rounded-sm p-3 text-xs text-text-dim font-mono overflow-x-auto max-h-48 whitespace-pre-wrap">
                {prettyData}
              </pre>
            )}
          </div>

          {/* Timestamps */}
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span>Created {formatDate(concept.created_at)}</span>
            {concept.updated_at !== concept.created_at && (
              <span>Updated {formatDate(concept.updated_at)}</span>
            )}
          </div>

          {/* Save changes */}
          {hasChanges && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}

          {/* Delete */}
          <div className="pt-2 border-t border-border">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red">Delete this concept permanently?</span>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-3 py-1 rounded-sm text-xs font-medium bg-red/80 text-text hover:bg-red/90 transition-colors disabled:opacity-50"
                >
                  {deleting ? 'Deleting...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1 rounded-sm text-xs text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-xs text-text-muted hover:text-red transition-colors"
              >
                Delete concept
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// -- Main Page --

export default function ConceptsPage() {
  const { concepts, loading, refresh } = useDashboardStore()
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [selectedConcept, setSelectedConcept] = useState<Concept | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    let result = concepts
    if (typeFilter !== 'all') {
      result = result.filter((c) => c.type === typeFilter)
    }
    return result.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
  }, [concepts, typeFilter])

  // Keep selected concept in sync with store data
  useEffect(() => {
    if (!selectedConcept) return
    const found = concepts.find((c) => c.id === selectedConcept.id)
    if (found) setSelectedConcept(found)
  }, [concepts, selectedConcept])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-text">Concepts</h1>
          <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-purple/15 text-purple text-xs font-bold tabular-nums">
            {concepts.length}
          </span>
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="bg-purple/80 text-text px-4 py-1.5 rounded text-sm font-medium hover:bg-purple/90 transition-colors"
        >
          Create Concept
        </button>
      </div>

      {/* Type filter tabs */}
      <div className="flex rounded-sm overflow-hidden border border-border w-fit">
        {TYPE_TABS.map((tab) => {
          const count =
            tab.key === 'all'
              ? concepts.length
              : concepts.filter((c) => c.type === tab.key).length

          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setTypeFilter(tab.key)}
              className={`px-4 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                typeFilter === tab.key
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

      {/* Concept list */}
      {filtered.length === 0 ? (
        <div className="bg-surface rounded-lg p-12 text-center">
          <p className="text-text-muted text-sm">
            No concepts match the current filter.
          </p>
        </div>
      ) : (
        <div>
          {filtered.map((concept) => (
            <ConceptCard
              key={concept.id}
              concept={concept}
              onClick={() => setSelectedConcept(concept)}
            />
          ))}
        </div>
      )}

      {/* Concept detail panel */}
      {selectedConcept && (
        <ConceptDetail
          concept={selectedConcept}
          onClose={() => setSelectedConcept(null)}
        />
      )}

      {/* Create concept modal */}
      <CreateConceptModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
      />
    </div>
  )
}

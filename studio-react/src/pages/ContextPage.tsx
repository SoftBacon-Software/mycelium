import { useEffect, useState, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { updateContextKey, deleteContextKey, bulkDeleteContextKeys } from '../api/endpoints'
import { getSenderDisplay } from '../utils/sender'

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return val
    }
  }
  return JSON.stringify(val, null, 2)
}

function truncateValue(val: unknown, max = 80): string {
  const str = typeof val === 'string' ? val : JSON.stringify(val)
  if (!str) return 'null'
  return str.length > max ? str.slice(0, max) + '...' : str
}

function dataSize(val: unknown): string {
  const str = typeof val === 'string' ? val : JSON.stringify(val)
  const bytes = new TextEncoder().encode(str || '').length
  if (bytes < 1024) return bytes + 'B'
  return (bytes / 1024).toFixed(1) + 'KB'
}

// -- Key Row --

interface KeyRowProps {
  id: number
  namespace: string
  keyName: string
  data: unknown
  category: string
  updatedBy: string
  updatedAt: string
  selected: boolean
  onToggleSelect: (id: number) => void
  onRefresh: () => void
}

function KeyRow({ id, namespace, keyName, data, category, updatedBy, updatedAt, selected, onToggleSelect, onRefresh }: KeyRowProps) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const handleEdit = () => {
    setEditValue(formatValue(data))
    setEditing(true)
    setExpanded(true)
  }

  const handleCancel = () => {
    setEditing(false)
  }

  const handleSave = useCallback(async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(editValue)
    } catch {
      parsed = editValue
    }
    setSaving(true)
    try {
      await updateContextKey(namespace, keyName, parsed)
      await onRefresh()
      setEditing(false)
    } catch (err) {
      console.error('Failed to update context key:', err)
    } finally {
      setSaving(false)
    }
  }, [namespace, keyName, editValue, onRefresh])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteContextKey(namespace, keyName)
      await onRefresh()
    } catch (err) {
      console.error('Failed to delete context key:', err)
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }, [namespace, keyName, onRefresh])

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Summary row */}
      <div
        className={`flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised/50 transition-colors cursor-pointer ${selected ? 'bg-accent/5' : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(id)}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 accent-accent"
        />
        <span className="text-xs text-text-muted w-4 shrink-0">{expanded ? '\u25BC' : '\u25B6'}</span>
        <span className="text-sm text-accent font-mono font-medium shrink-0">{keyName}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${category === 'ephemeral' ? 'bg-blue/10 text-blue' : 'bg-accent/10 text-accent'}`}>
          {category}
        </span>
        <span className="text-xs text-text-muted flex-1 min-w-0 truncate font-mono">
          {truncateValue(data)}
        </span>
        <span className="text-[10px] text-text-dim shrink-0 font-mono">{dataSize(data)}</span>
        <span className="text-xs text-text-muted shrink-0">{getSenderDisplay(updatedBy)}</span>
        <span className="text-xs text-text-muted shrink-0 font-mono">{formatDate(updatedAt)}</span>
        <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={handleEdit}
            className="px-2 py-0.5 rounded text-xs text-text-muted hover:text-accent transition-colors"
          >
            Edit
          </button>
          {confirmDelete ? (
            <div className="flex gap-1">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="px-2 py-0.5 rounded text-xs bg-red/80 text-text hover:bg-red/90 transition-colors disabled:opacity-50"
              >
                {deleting ? '...' : 'Yes'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-0.5 rounded text-xs text-text-muted hover:text-text transition-colors"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="px-2 py-0.5 rounded text-xs text-text-muted hover:text-red transition-colors"
            >
              Del
            </button>
          )}
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-3 pl-14">
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                rows={6}
                className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-xs text-text font-mono focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="px-3 py-1 rounded-sm text-xs text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-3 py-1 rounded-sm text-xs font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <pre className="bg-surface-raised rounded-sm p-3 text-xs text-text-dim font-mono overflow-x-auto max-h-48 whitespace-pre-wrap">
              {formatValue(data)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// -- Add Key Form --

interface AddKeyFormProps {
  onRefresh: () => void
  onClose: () => void
}

function AddKeyForm({ onRefresh, onClose }: AddKeyFormProps) {
  const [namespace, setNamespace] = useState('')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('{}')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!namespace.trim() || !key.trim()) return

    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      parsed = value
    }

    setSaving(true)
    setError(null)
    try {
      await updateContextKey(namespace.trim(), key.trim(), parsed)
      await onRefresh()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add key')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-surface rounded-lg p-4 border border-border">
      <h3 className="text-sm font-semibold text-text mb-3">Add Context Key</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <div className="px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1">
              Namespace *
            </label>
            <input
              type="text"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="e.g. config"
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
              required
            />
          </div>
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1">
              Key *
            </label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="e.g. theme"
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
              required
            />
          </div>
        </div>
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1">
            Value (JSON)
          </label>
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-xs text-text font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-sm text-sm text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !namespace.trim() || !key.trim()}
            className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Adding...' : 'Add Key'}
          </button>
        </div>
      </form>
    </div>
  )
}

// -- Main Page --

export default function ContextPage() {
  const { contextKeys, loading, refresh } = useDashboardStore()
  const [showAdd, setShowAdd] = useState(false)
  const [collapsedNs, setCollapsedNs] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [nsFilter, setNsFilter] = useState<string>('all')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  useEffect(() => {
    refresh()
  }, [refresh])

  // Available namespaces for filter dropdown
  const namespaces = useMemo(() => {
    const ns = new Set<string>()
    for (const entry of contextKeys) ns.add(entry.namespace)
    return [...ns].sort()
  }, [contextKeys])

  // Available updaters
  const updaters = useMemo(() => {
    const u = new Set<string>()
    for (const entry of contextKeys) if (entry.updated_by) u.add(entry.updated_by)
    return [...u].sort()
  }, [contextKeys])

  // Filter keys
  const filtered = useMemo(() => {
    return contextKeys.filter((entry) => {
      if (nsFilter !== 'all' && entry.namespace !== nsFilter) return false
      if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false
      if (search) {
        const q = search.toLowerCase()
        const keyMatch = entry.key.toLowerCase().includes(q)
        const nsMatch = entry.namespace.toLowerCase().includes(q)
        const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)
        const dataMatch = dataStr.toLowerCase().includes(q)
        if (!keyMatch && !nsMatch && !dataMatch) return false
      }
      return true
    })
  }, [contextKeys, search, categoryFilter, nsFilter])

  // Group filtered by namespace
  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>()
    for (const entry of filtered) {
      const ns = entry.namespace
      if (!map.has(ns)) map.set(ns, [])
      map.get(ns)!.push(entry)
    }
    return map
  }, [filtered])

  const toggleNamespace = (ns: string) => {
    setCollapsedNs((prev) => {
      const next = new Set(prev)
      if (next.has(ns)) next.delete(ns)
      else next.add(ns)
      return next
    })
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllInNamespace = (ns: string) => {
    const nsKeys = filtered.filter((e) => e.namespace === ns)
    const nsIds = nsKeys.map((e) => (e as any).id as number)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      const allSelected = nsIds.every((id) => next.has(id))
      if (allSelected) {
        nsIds.forEach((id) => next.delete(id))
      } else {
        nsIds.forEach((id) => next.add(id))
      }
      return next
    })
  }

  const selectAll = () => {
    const allIds = filtered.map((e) => (e as any).id as number)
    setSelectedIds((prev) => {
      if (prev.size === allIds.length) return new Set()
      return new Set(allIds)
    })
  }

  const handleBulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return
    setBulkDeleting(true)
    try {
      await bulkDeleteContextKeys([...selectedIds])
      setSelectedIds(new Set())
      setConfirmBulkDelete(false)
      await refresh()
    } catch (err) {
      console.error('Bulk delete failed:', err)
    } finally {
      setBulkDeleting(false)
    }
  }, [selectedIds, refresh])

  const clearFilters = () => {
    setSearch('')
    setCategoryFilter('all')
    setNsFilter('all')
  }

  const hasActiveFilters = search || categoryFilter !== 'all' || nsFilter !== 'all'

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-text">Context Keys</h1>
          <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-accent/15 text-accent text-xs font-bold tabular-nums">
            {filtered.length}
          </span>
          {hasActiveFilters && (
            <span className="text-xs text-text-dim">
              of {contextKeys.length} total
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

        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              {confirmBulkDelete ? (
                <div className="flex items-center gap-2 bg-red/10 border border-red/20 rounded px-3 py-1.5">
                  <span className="text-xs text-red">Delete {selectedIds.size} key{selectedIds.size !== 1 ? 's' : ''}?</span>
                  <button
                    type="button"
                    onClick={handleBulkDelete}
                    disabled={bulkDeleting}
                    className="px-2 py-0.5 rounded text-xs bg-red text-text font-medium hover:bg-red/90 transition-colors disabled:opacity-50"
                  >
                    {bulkDeleting ? 'Deleting...' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(false)}
                    className="px-2 py-0.5 rounded text-xs text-text-muted hover:text-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmBulkDelete(true)}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-red/80 text-text hover:bg-red/90 transition-colors"
                >
                  Delete {selectedIds.size} Selected
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-text-muted hover:text-text transition-colors"
              >
                Clear
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="bg-accent/80 text-bg px-4 py-1.5 rounded text-sm font-medium hover:bg-accent/90 transition-colors"
          >
            Add Key
          </button>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search keys, namespaces, values..."
          className="flex-1 min-w-[200px] bg-surface border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 font-mono"
        />
        <select
          value={nsFilter}
          onChange={(e) => setNsFilter(e.target.value)}
          className="bg-surface border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
        >
          <option value="all">All Namespaces</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="bg-surface border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
        >
          <option value="all">All Categories</option>
          <option value="durable">Durable</option>
          <option value="ephemeral">Ephemeral</option>
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="text-xs text-text-muted hover:text-accent transition-colors"
          >
            Clear filters
          </button>
        )}
        <button
          type="button"
          onClick={selectAll}
          className="text-xs text-text-muted hover:text-accent transition-colors ml-auto"
        >
          {selectedIds.size === filtered.length && filtered.length > 0 ? 'Deselect All' : 'Select All'}
        </button>
      </div>

      {/* Add key form */}
      {showAdd && (
        <AddKeyForm onRefresh={refresh} onClose={() => setShowAdd(false)} />
      )}

      {/* Namespace groups */}
      {filtered.length === 0 && !loading ? (
        <div className="bg-surface rounded-lg p-12 text-center">
          <p className="text-text-muted text-sm">
            {hasActiveFilters ? 'No keys match your filters.' : 'No context keys found.'}
          </p>
          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-2 text-xs text-accent hover:text-accent-light transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {[...grouped.entries()].map(([ns, keys]) => {
            const isCollapsed = collapsedNs.has(ns)
            const nsIds = keys.map((e) => (e as any).id as number)
            const allNsSelected = nsIds.length > 0 && nsIds.every((id) => selectedIds.has(id))
            return (
              <div key={ns} className="bg-surface rounded-lg overflow-hidden">
                {/* Namespace header */}
                <div className="flex items-center gap-2 px-4 py-3 hover:bg-surface-raised/30 transition-colors">
                  <input
                    type="checkbox"
                    checked={allNsSelected}
                    onChange={() => selectAllInNamespace(ns)}
                    className="shrink-0 accent-accent"
                  />
                  <button
                    type="button"
                    onClick={() => toggleNamespace(ns)}
                    className="flex-1 flex items-center gap-2 text-left"
                  >
                    <span className="text-xs text-text-muted w-4 shrink-0">
                      {isCollapsed ? '\u25B6' : '\u25BC'}
                    </span>
                    <span className="text-sm font-semibold text-accent font-mono">{ns}</span>
                    <span className="text-xs text-text-muted font-mono">
                      {keys.length} key{keys.length !== 1 ? 's' : ''}
                    </span>
                  </button>
                </div>

                {/* Keys */}
                {!isCollapsed && (
                  <div>
                    {keys.map((entry) => (
                      <KeyRow
                        key={`${entry.namespace}:${entry.key}`}
                        id={entry.id}
                        namespace={entry.namespace}
                        keyName={entry.key}
                        data={entry.data}
                        category={entry.category || 'durable'}
                        updatedBy={entry.updated_by}
                        updatedAt={entry.updated_at}
                        selected={selectedIds.has(entry.id)}
                        onToggleSelect={toggleSelect}
                        onRefresh={refresh}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
